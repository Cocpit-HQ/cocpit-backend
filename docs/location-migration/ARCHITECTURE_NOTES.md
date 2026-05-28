# ARCHITECTURE NOTES — Location Migration

**Last Updated:** 2026-05-26  
**Author:** Antigravity (AI Engineering Assistant)

---

## System Architecture Decision: Backend Proxy

### Architecture Diagram

```
User (Browser/Mobile)
       │
       │ [type "Mum..."]
       ▼
LocationAutocomplete.tsx
       │
       │ GET /api/places/autocomplete?q=Mum&sessionToken=<uuid>
       ▼
COCPIT Backend (Express)
  ├── Rate limiting (existing middleware)
  ├── Auth middleware (requireAuth)  
  ├── Redis cache check (60s TTL)
  ├── [CACHE MISS] → Google Places Autocomplete (New) API
  │       params: input, includedRegionCodes: [IN, AE, SG]
  │       sessionToken, field mask
  ▼
  Response: structured suggestions
       │
       ▼
User selects suggestion
       │
       │ GET /api/places/details?placeId=ChIJ...&sessionToken=<same-uuid>
       ▼
COCPIT Backend
  ├── Calls Google Places Details (New) API
  │   (same sessionToken → single billing session)
  │   fieldMask: addressComponents,location,displayName
  ├── Parses: country, state, city, formattedAddress, lat, lng, placeId
  ├── Validates country ∈ {India, United Arab Emirates, Singapore}
  ▼
  Response: structured location object
       │
       ▼
Frontend PATCH /api/onboarding/location
  { country, state, city, formattedAddress, latitude, longitude, placeId }
       │
       ▼
COCPIT Backend updateLocation()
  → UPDATE users SET location_formatted=..., location_country=..., etc.
```

---

## API Selection: Google Places Autocomplete (New) vs Legacy

### Decision: Use **Places API (New)** (Autocomplete (New))

| Criterion                  | Legacy Autocomplete          | Autocomplete (New)                    | Decision |
|----------------------------|------------------------------|---------------------------------------|----------|
| Active development         | No (deprecated path)         | Yes — Google's current standard       | ✅ New   |
| Session token support      | Yes                          | Yes (enhanced)                        | Tie      |
| Field masking              | Limited                      | Full field mask support               | ✅ New   |
| Country restriction        | `components=country:in`      | `includedRegionCodes: ["IN","AE","SG"]`| ✅ New   |
| Pricing (with session)     | Essentials SKU               | Grouped billing, often cheaper        | ✅ New   |
| Node.js ecosystem          | via REST                     | via REST + `@googlemaps/google-maps-services-js` | ✅ New |
| Free quota (2025)          | 10,000 req/mo free           | Included in session-grouped billing   | ✅ New   |
| Response format            | Legacy JSON                  | Modern JSON (addressComponents etc.)  | ✅ New   |

**Conclusion:** Use Places Autocomplete (New) REST endpoint. No frontend SDK needed.

---

## Pricing Analysis

### Onboarding Flow Billing Model

A typical onboarding session:
1. User types 3–8 characters → 3–8 autocomplete requests (same session token)
2. User selects a city → 1 Place Details request (terminates session)
3. **Billing unit = 1 Session** (not 8 individual requests)

### Cost Estimates (2025 Pricing)

| Scenario | Requests | Session Tokens | Billed Unit | Cost (approx.) |
|----------|----------|----------------|-------------|----------------|
| Completed session | 6 autocomplete + 1 details | 1 session | 1 session × Place Details rate | ~$0.002–0.017 |
| Abandoned session | 6 autocomplete, no details | — | 6 individual autocomplete | ~$0.001–0.01 |
| Free monthly quota (Essentials) | — | — | ~10,000 requests | $0 |

### User Volume Projections

| New Users/Month | Avg Autocomplete Requests | Sessions | Estimated Monthly Cost |
|-----------------|--------------------------|----------|------------------------|
| 100 (early)     | 6/user                   | 100      | ≈ $0 (within free tier)|
| 1,000           | 6/user                   | 1,000    | ≈ $1–5                 |
| 10,000          | 6/user                   | 10,000   | ≈ $10–50               |
| 100,000         | 6/user                   | 100,000  | ≈ $100–500             |

**Cost is negligible at current scale. Session tokens are critical for cost control at scale.**

---

## Redis Caching Strategy

### Decision: Introduce Redis Cache in Phase 1 (with proxy)

**Rationale:** Already have Redis (`REDIS_URL=redis://127.0.0.1:6379` in `.env`). Adding cache to the proxy at the same time as building the proxy adds minimal complexity and prevents over-billing during testing.

### Cache Architecture

```
Autocomplete Cache:
  Key:   places:ac:{SHA256(query+countries)}
  Value: JSON array of suggestions
  TTL:   60 seconds
  Scope: Per unique query string (normalized, trimmed, lowercase)

Place Details Cache:
  Key:   places:detail:{placeId}
  Value: JSON structured location
  TTL:   24 hours (place data is stable)
  Scope: Per placeId

Cache Bypass:
  - X-No-Cache: true header (for admin/debug use only)
```

### Cache Hit/Miss Tracking

```js
// Add to proxy controller
const cacheKey = `places:ac:${hash(query + countries)}`;
const cached = await redis.get(cacheKey);
if (cached) {
  metrics.increment('places.cache.hit');
  return res.json(JSON.parse(cached));
}
metrics.increment('places.cache.miss');
// ... call Google API
await redis.setex(cacheKey, 60, JSON.stringify(results));
```

---

## Country Restriction Architecture

### Two-Layer Validation (Defense in Depth)

**Layer 1 — Query-Time Restriction (frontend → backend proxy)**
```
GET /api/places/autocomplete?q=Mum&sessionToken=uuid
Backend sends to Google: includedRegionCodes: ["IN", "AE", "SG"]
```

**Layer 2 — Server-Side Validation on Submit**
```js
// In updateLocation controller
const ALLOWED_COUNTRIES = {
  "India": "IN",
  "United Arab Emirates": "AE", 
  "Singapore": "SG"
};

if (!ALLOWED_COUNTRIES[body.country]) {
  return res.status(400).json({
    success: false,
    message: "Location must be in India, UAE, or Singapore",
    code: "INVALID_LOCATION_COUNTRY"
  });
}
```

**Why two layers?** The proxy restricts autocomplete results, but a malicious client could forge the final `PATCH /api/onboarding/location` payload with any country. Server validation is mandatory.

---

## Backward Compatibility Architecture

### Dual-Mode Operation

During the migration window (Phases 1–6):

```
Legacy route (PRESERVED):
  GET /api/locations?search=   → queries locations table (GeoNames)
  Used by: AddExperienceForm, AddEducationForm

New route (Phase 1 addition):
  GET /api/places/autocomplete → proxies Google Places API
  Used by: onboarding LocationAutocomplete (after Phase 2)
  GET /api/places/details      → proxies Google Place Details API
```

The `LocationAutocomplete` component will receive a new optional prop:
```tsx
mode?: "legacy" | "places"  // defaults to "places" in onboarding context
```

This ensures the component stays reusable across onboarding (new) and profile forms (legacy) without forking the component.

---

## Session Token Flow (Frontend ↔ Backend)

```typescript
// Frontend: Generate once per search session
const sessionToken = useRef<string>(crypto.randomUUID());

// On new search started (input cleared / focused fresh):
sessionToken.current = crypto.randomUUID();

// Every autocomplete request:
GET /api/places/autocomplete?q=Mum&sessionToken={sessionToken.current}

// On place selected:
GET /api/places/details?placeId={place_id}&sessionToken={sessionToken.current}

// After successful selection → reset for next search:
sessionToken.current = crypto.randomUUID();
```

**Critical:** Same UUID for all autocomplete + the final details call = 1 billed session.
