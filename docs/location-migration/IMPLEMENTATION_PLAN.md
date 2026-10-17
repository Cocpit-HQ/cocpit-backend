# IMPLEMENTATION PLAN — Location System Migration to Google Places API

**Version:** 1.0 (Final, Pre-Implementation)  
**Last Updated:** 2026-05-26  
**Status:** APPROVED FOR IMPLEMENTATION (awaiting API key provisioning)  
**Architecture:** Hybrid Compatibility Mode — Backend Proxy via Google Places API (New)

---

## 1. Overview

COCPIT's current location system uses a static GeoNames-seeded PostgreSQL `locations` table. This is being replaced with a Google Places Autocomplete (New) proxy on the backend, restricted to India (IN), UAE (AE), and Singapore (SG). The migration is **incremental**: onboarding location is migrated first; experience/education forms are deferred. The legacy system remains live throughout.

**Core Decisions:**
- Backend proxy only — no Google SDK on frontend
- Additive DB columns on `users` table — no new table
- Coordinates are optional — onboarding not blocked if Places Details fails
- Redis caching introduced in Phase 1 alongside the proxy
- `locations` table and `/api/locations` route preserved until Phase 7

---

## 2. PR/Task Breakdown

### PR 1 — `feat: google-places-proxy-backend` (Phase 1)
**Scope:** New backend module only. Zero breaking changes.

**Files:**
- `src/modules/places/places.routes.js` [NEW]
- `src/modules/places/places.controller.js` [NEW]
- `src/modules/places/places.schema.js` [NEW]
- `src/app.js` [EDIT — add /api/places route]
- `.env` [EDIT — add GOOGLE_MAPS_API_KEY]
- `.env.example` [EDIT — document new var]

**Test criteria:**
- `GET /api/places/autocomplete?q=Mumbai` returns suggestions
- `GET /api/places/details?placeId=ChIJ...` returns structured location
- Redis caching confirmed (X-Cache header)
- Country restriction confirmed (non-IN/AE/SG returns empty)
- Singapore `state: null` handled

---

### PR 2 — `feat: onboarding-location-frontend-migration` (Phase 2)
**Scope:** Frontend onboarding only. Legacy `/api/locations` still available.

**Files:**
- `src/services/api/location.ts` [EDIT]
- `src/components/ui/LocationAutocomplete.tsx` [EDIT]
- `src/store/onboarding.store.ts` [EDIT]
- `src/services/api/onboarding.ts` [EDIT]
- `src/components/onboarding/TellUsAboutYouStep.tsx` [EDIT]

**Test criteria:**
- Location step works end-to-end in onboarding
- Store has structured location after selection
- `PATCH /api/onboarding/location` payload is new format
- Legacy forms (experience/education) unaffected
- Graceful degradation if proxy returns error

---

### PR 3 — `feat: onboarding-location-backend-schema-migration` (Phase 3)
**Scope:** DB migration + controller rewrite. **Mobile coordination required.**

**Files:**
- DB migration SQL script [RUN]
- `src/modules/onboarding/onboarding.schema.js` [EDIT]
- `src/modules/onboarding/onboarding.controller.js` [EDIT]
- `src/modules/auth/onboarding.controller.js` [EDIT]
- `src/modules/auth/onboarding.schema.js` [EDIT]

**Test criteria:**
- New payload accepted and stored
- Legacy payload still accepted (`auth/onboarding` dual-accept)
- New DB columns populated correctly
- `users.location` TEXT still written (dual-write)
- Country validation rejects non-IN/AE/SG

---

### PR 4 — `feat: places-observability` (Phase 4)
**Scope:** Structured logging and metrics. Non-breaking.

---

### PR 5 — `chore: cleanup-legacy-location` (Phase 7, Deferred)
**Scope:** Remove `/api/locations`, drop `locations` table, migrate forms.

---

## 3. Phase-by-Phase Execution Plan

---

### PHASE 1 — Backend Places Proxy

**Goal:** Create a secure, cached, country-restricted proxy to Google Places API.

**New file: `src/modules/places/places.routes.js`**
```js
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const { createRateLimit } = require("../../core/middlewares/rateLimit.middleware");
const placesController = require("./places.controller");
const { autocompleteSchema, detailsSchema } = require("./places.schema");

const placesLimiter = createRateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 30,
  message: "Too many location requests. Please slow down.",
});

router.get(
  "/autocomplete",
  requireAuth,
  placesLimiter,
  validate(autocompleteSchema),
  placesController.getAutocomplete
);

router.get(
  "/details",
  requireAuth,
  placesLimiter,
  validate(detailsSchema),
  placesController.getPlaceDetails
);

module.exports = router;
```

**New file: `src/modules/places/places.schema.js`**
```js
const { z } = require("zod");

const autocompleteSchema = z.object({
  query: z.object({
    q: z.string().min(2, "Query must be at least 2 characters").max(200),
    sessionToken: z.string().uuid("sessionToken must be a valid UUID"),
  }),
});

const detailsSchema = z.object({
  query: z.object({
    placeId: z.string().min(1, "placeId is required"),
    sessionToken: z.string().uuid("sessionToken must be a valid UUID"),
  }),
});

module.exports = { autocompleteSchema, detailsSchema };
```

**New file: `src/modules/places/places.controller.js`**
```js
const axios = require("axios");
const crypto = require("crypto");
const redis = require("../../core/db/redis"); // existing Redis client

const GOOGLE_PLACES_BASE = "https://places.googleapis.com/v1";
const ALLOWED_COUNTRIES = ["India", "United Arab Emirates", "Singapore"];
const INCLUDED_REGION_CODES = ["IN", "AE", "SG"];
const CACHE_TTL_AUTOCOMPLETE = 60;    // seconds
const CACHE_TTL_DETAILS = 86400;      // 24 hours

// ─── Address Component Parser ─────────────────────────────────────────────────

function parseAddressComponents(components = []) {
  let country = null, state = null, city = null;
  
  for (const comp of components) {
    const types = comp.types || [];
    const name = comp.longText || comp.shortText || "";
    
    if (types.includes("country")) {
      country = name;
    } else if (types.includes("administrative_area_level_1")) {
      // Normalize UAE emirate names: "Emirate of Dubai" → "Dubai"
      state = name.replace(/^Emirate of /i, "").trim();
    } else if (
      types.includes("locality") ||
      types.includes("postal_town") ||
      types.includes("administrative_area_level_2")
    ) {
      if (!city) city = name; // prefer locality, fallback to others
    }
  }

  return { country, state, city };
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

exports.getAutocomplete = async (req, res) => {
  const { q, sessionToken } = req.query;
  const cacheKey = `places:ac:${crypto.createHash("sha256").update(q.toLowerCase().trim()).digest("hex")}`;

  try {
    // Check Redis cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res
        .set("X-Cache", "HIT")
        .set("X-Cache-TTL", CACHE_TTL_AUTOCOMPLETE)
        .json({ success: true, data: JSON.parse(cached) });
    }

    // Call Google Places Autocomplete (New)
    const response = await axios.post(
      `${GOOGLE_PLACES_BASE}/places:autocomplete`,
      {
        input: q,
        sessionToken,
        includedRegionCodes: INCLUDED_REGION_CODES,
        includedPrimaryTypes: ["locality", "administrative_area_level_1"],
        languageCode: "en",
      },
      {
        headers: {
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.types",
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );

    const suggestions = (response.data.suggestions || []).map((s) => ({
      placeId: s.placePrediction.placeId,
      displayName: s.placePrediction.text?.text?.split(",")[0] || "",
      description: s.placePrediction.text?.text || "",
      types: s.placePrediction.types || [],
    }));

    // Cache results
    await redis.setex(cacheKey, CACHE_TTL_AUTOCOMPLETE, JSON.stringify(suggestions));

    return res
      .set("X-Cache", "MISS")
      .json({ success: true, data: suggestions });

  } catch (err) {
    console.error("[Places Autocomplete Error]", err?.response?.data || err.message);
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return res.status(503).json({
        success: false,
        message: "Location service temporarily unavailable",
        fallback: true,
      });
    }
    return res.status(502).json({
      success: false,
      message: "Location service error",
      fallback: true,
    });
  }
};

// ─── Place Details ─────────────────────────────────────────────────────────────

exports.getPlaceDetails = async (req, res) => {
  const { placeId, sessionToken } = req.query;
  const cacheKey = `places:detail:${placeId}`;

  try {
    // Check Redis cache (details are stable — 24h TTL)
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res
        .set("X-Cache", "HIT")
        .json({ success: true, data: JSON.parse(cached) });
    }

    // Call Google Places Details (New)
    const response = await axios.get(
      `${GOOGLE_PLACES_BASE}/places/${placeId}`,
      {
        headers: {
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "id,displayName,addressComponents,location",
          "X-Goog-SessionToken": sessionToken,
        },
        timeout: 5000,
      }
    );

    const place = response.data;
    const { country, state, city } = parseAddressComponents(
      place.addressComponents || []
    );

    // Server-side country validation
    if (!ALLOWED_COUNTRIES.includes(country)) {
      return res.status(400).json({
        success: false,
        message: "Location must be in India, UAE, or Singapore",
        code: "INVALID_LOCATION_COUNTRY",
      });
    }

    const result = {
      placeId,
      country,
      state: state || null,
      city: city || place.displayName?.text || null,
      formattedAddress: [city, state, country].filter(Boolean).join(", "),
      latitude: place.location?.latitude || null,
      longitude: place.location?.longitude || null,
    };

    // Cache structured result
    await redis.setex(cacheKey, CACHE_TTL_DETAILS, JSON.stringify(result));

    return res
      .set("X-Cache", "MISS")
      .json({ success: true, data: result });

  } catch (err) {
    console.error("[Places Details Error]", err?.response?.data || err.message);
    
    if (err?.response?.status === 404) {
      return res.status(404).json({ success: false, message: "Place not found" });
    }
    return res.status(503).json({
      success: false,
      message: "Location service temporarily unavailable",
      fallback: true,
    });
  }
};
```

**Edit `src/app.js`:**
```js
const placesRoutes = require("./modules/places/places.routes");
// ... (after existing route registrations)
app.use("/api/places", placesRoutes);
```

---

### PHASE 2 — Frontend Onboarding Migration

**Key Changes Summary:**

**`location.ts` — Add new functions, preserve `searchLocations`:**
```typescript
// Preserve existing (for legacy forms):
export const searchLocations = async (search: string): Promise<LocationSuggestion[]> => { ... }

// Add new for onboarding:
export interface PlacesSuggestion {
  placeId: string;
  displayName: string;
  description: string;
  types?: string[];
}

export interface StructuredLocation {
  placeId: string;
  country: string;
  state: string | null;
  city: string;
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
}

export const searchPlaces = async (q: string, sessionToken: string): Promise<PlacesSuggestion[]> => {
  if (!q || q.length < 2) return [];
  const response = await api.get("/places/autocomplete", { params: { q, sessionToken } });
  return response.data.data || [];
};

export const getPlaceDetails = async (placeId: string, sessionToken: string): Promise<StructuredLocation | null> => {
  try {
    const response = await api.get("/places/details", { params: { placeId, sessionToken } });
    return response.data.data || null;
  } catch {
    return null; // coordinates optional — fail gracefully
  }
};
```

**`LocationAutocomplete.tsx` — Key changes:**
```typescript
interface LocationAutocompleteProps {
  onSelect: (location: StructuredLocation | null) => void;
  value: string | null;         // display text for controlled input
  mode?: "legacy" | "places";  // default: "places"
}
```

Session token lifecycle:
```typescript
const sessionToken = useRef<string>(crypto.randomUUID());

// On every new search session (input cleared):
const resetSession = () => { sessionToken.current = crypto.randomUUID(); };

// On selection:
const handleSelect = async (suggestion: PlacesSuggestion) => {
  setLoading(true);
  const details = await getPlaceDetails(suggestion.placeId, sessionToken.current);
  resetSession(); // Start fresh session after selection
  onSelect(details);
  setQuery(details?.formattedAddress ?? suggestion.description);
  setOpen(false);
  setLoading(false);
};
```

**`onboarding.store.ts` — New state:**
```typescript
// Location Data (structured — Phase 2+)
locationPlaceId: string | null;
locationFormatted: string | null;
locationCountry: string | null;
locationState: string | null;
locationCity: string | null;
locationLat: number | null;
locationLng: number | null;

// Legacy fields retained for transition
locationId: string | null;    // deprecated — null for new users
locationName: string | null;  // deprecated — use locationFormatted

setLocation: (loc: StructuredLocation | null) => void;
```

**`TellUsAboutYouStep.tsx` — Updated `handleContinue`:**
```typescript
const handleContinue = async () => {
  if (!selectedLocation) {
    setError("Please select a location to continue");
    return;
  }
  setLoading(true);
  try {
    await updateOnboardingLocation({
      country: selectedLocation.country,
      state: selectedLocation.state,
      city: selectedLocation.city,
      formattedAddress: selectedLocation.formattedAddress,
      latitude: selectedLocation.latitude,
      longitude: selectedLocation.longitude,
      placeId: selectedLocation.placeId,
    });
    onNext();
  } catch (err) {
    setError("Failed to save location. Please try again.");
  } finally {
    setLoading(false);
  }
};
```

---

### PHASE 3 — Backend Schema + Controller

**DB Migration — Run first:**
```sql
-- See DATABASE_CHANGES.md for full script
BEGIN;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location_country TEXT,
  ADD COLUMN IF NOT EXISTS location_state TEXT,
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_formatted TEXT,
  ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_place_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_location_country ON users(location_country) WHERE location_country IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_location_city ON users(LOWER(location_city)) WHERE location_city IS NOT NULL;
COMMIT;
```

**`onboarding.schema.js` — New `updateLocationSchema`:**
```js
const updateLocationSchema = z.object({
  body: z.object({
    country: z.string().min(1).refine(
      v => ["India", "United Arab Emirates", "Singapore"].includes(v),
      { message: "Location must be in India, UAE, or Singapore" }
    ),
    state: z.string().nullable().optional(),
    city: z.string().min(1, "City is required"),
    formattedAddress: z.string().min(1, "Formatted address is required"),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    placeId: z.string().min(1, "Place ID is required"),
  }),
});
```

**`modules/onboarding/onboarding.controller.js` — Rewrite `updateLocation`:**
```js
exports.updateLocation = async (req, res) => {
  const userId = req.user.sub;
  const { country, state, city, formattedAddress, latitude, longitude, placeId } = req.body;

  const ALLOWED_COUNTRIES = ["India", "United Arab Emirates", "Singapore"];
  if (!ALLOWED_COUNTRIES.includes(country)) {
    return res.status(400).json({
      success: false, message: "Location must be in India, UAE, or Singapore",
      code: "INVALID_LOCATION_COUNTRY"
    });
  }

  await pool.query(
    `UPDATE users
     SET location           = $1,
         location_id        = NULL,
         location_formatted = $1,
         location_country   = $2,
         location_state     = $3,
         location_city      = $4,
         location_lat       = $5,
         location_lng       = $6,
         location_place_id  = $7,
         onboarding_step    = GREATEST(onboarding_step, 3),
         updated_at         = NOW()
     WHERE user_id = $8`,
    [formattedAddress, country, state || null, city,
     latitude || null, longitude || null, placeId, userId]
  );

  return res.json({
    success: true,
    message: "Location updated",
    data: { location_formatted: formattedAddress, location_country: country, location_city: city }
  });
};
```

**`auth/onboarding.controller.js` — Dual-accept `completeOnboarding`:**
```js
// Detect payload type
const isLegacyPayload = req.body.location_id !== undefined;
const newLocationPayload = req.body.location; // new: nested object

if (isLegacyPayload && finalLocationId) {
  // Legacy: lookup from locations table
  const locationResult = await pool.query("SELECT id, name FROM locations WHERE id = $1", [finalLocationId]);
  if (locationResult.rowCount > 0) locationName = locationResult.rows[0].name;
}

if (newLocationPayload && newLocationPayload.placeId) {
  // New format: use structured data directly
  locationName = newLocationPayload.formattedAddress;
  // Write new columns too:
  newLocationFields = {
    location_formatted: newLocationPayload.formattedAddress,
    location_country: newLocationPayload.country,
    location_state: newLocationPayload.state || null,
    location_city: newLocationPayload.city,
    location_lat: newLocationPayload.latitude || null,
    location_lng: newLocationPayload.longitude || null,
    location_place_id: newLocationPayload.placeId,
  };
}
```

---

### PHASE 4 — Observability

**Structured log events in `places.controller.js`:**

```js
// Autocomplete request
console.log(JSON.stringify({
  event: "places_autocomplete",
  query_length: q.length,
  cache: cached ? "HIT" : "MISS",
  latency_ms: Date.now() - startTime,
  result_count: suggestions.length,
  user_id_hash: crypto.createHash("sha256").update(req.user.sub).digest("hex").slice(0, 8),
}));

// Location saved (in updateLocation controller)
console.log(JSON.stringify({
  event: "location_saved",
  country: country,
  has_coordinates: !!(latitude && longitude),
  user_id_hash: crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8),
}));
```

**Top searches Redis tracking:**
```js
// After successful autocomplete:
await redis.zincrby("places:topsearches", 1, q.toLowerCase().trim());
// Trim to top 1000:
await redis.zremrangebyrank("places:topsearches", 0, -1001);
```

**Cache hit rate endpoint (admin):**
```js
// GET /api/admin/places/stats (admin-only)
// Returns: { cache_hits, cache_misses, hit_rate, top_searches }
```

**Google Cloud Console Setup:**
- Budget alert: 80% of monthly quota
- Alert channel: email/Slack webhook
- Metrics to monitor:
  - `places.googleapis.com/v1/places:autocomplete` → request count
  - `places.googleapis.com/v1/places/{name}` → request count (details)
  - Error rate (4xx, 5xx from Google)
  - Latency percentiles (p50, p95, p99)

---

## 4. Testing Checklist

### Backend Unit Tests (Phase 1)
- [ ] `getAutocomplete` — returns suggestions for "Mumbai"
- [ ] `getAutocomplete` — returns empty for "London" (restricted)
- [ ] `getAutocomplete` — returns `X-Cache: HIT` on second identical call
- [ ] `getAutocomplete` — returns `{ fallback: true }` when Google API times out
- [ ] `getPlaceDetails` — returns structured location for Mumbai placeId
- [ ] `getPlaceDetails` — `state: null` for Singapore placeId
- [ ] `getPlaceDetails` — rejects place in France with 400
- [ ] `parseAddressComponents` — normalizes "Emirate of Dubai" → "Dubai"
- [ ] Rate limit: 31st request in 1 minute → 429

### Frontend Integration Tests (Phase 2)
- [ ] LocationAutocomplete in "places" mode calls `/api/places/autocomplete`
- [ ] LocationAutocomplete in "legacy" mode calls `/api/locations`
- [ ] Session token consistent across autocomplete requests in same session
- [ ] Session token resets after selection
- [ ] `onSelect` called with `StructuredLocation` object, not legacy `LocationSuggestion`
- [ ] `TellUsAboutYouStep` calls `updateOnboardingLocation` with new payload
- [ ] Graceful UI when Google API returns `fallback: true`

### End-to-End Tests (Phase 3)
- [ ] Complete onboarding flow: select Mumbai → save → DB has `location_country: "India"`
- [ ] Complete onboarding flow: select Dubai → DB has `location_country: "United Arab Emirates"`
- [ ] Complete onboarding flow: select Singapore → DB has `location_state: null`
- [ ] Profile card reads `users.location` correctly (legacy column still populated)
- [ ] Experience form location search still works (old `/api/locations`)
- [ ] Education form location search still works (old `/api/locations`)
- [ ] Mobile legacy payload (`location_id` INT) still accepted by `auth/onboarding`

### Regression Checks (All Phases)
- [ ] Profile read API (`GET /api/profile/:accountName`) returns `location` field
- [ ] Social user cards display location
- [ ] Share preview includes location
- [ ] `GET /api/locations?search=` still returns results
- [ ] Job search location filter still works
- [ ] Onboarding step counter (`onboarding_step`) advances correctly

---

## 5. Backward Compatibility Handling

| Consumer | Current Behavior | After Migration | Safe? |
|----------|-----------------|-----------------|-------|
| Profile read APIs | Returns `u.location TEXT` | Same — `location` TEXT still written | ✅ Yes |
| Social queries | Returns `u.location TEXT` | Same | ✅ Yes |
| Share previews | Returns `u.location TEXT` | Same | ✅ Yes |
| Experience form location | Calls `/api/locations` | Unchanged | ✅ Yes |
| Education form location | Calls `/api/locations` | Unchanged | ✅ Yes |
| Mobile `auth/onboarding` | Sends `location_id` INT | Dual-accept until mobile update | ✅ With dual-accept |
| Legacy `location_id` DB column | Populated for old users | NULL for new users | ✅ No constraint |

---

## 6. Mobile Synchronization

**Timeline:**
1. Phase 1 + 2 deploy → mobile unaffected (they call different endpoint)
2. Phase 3 deploys with **dual-accept** → mobile still works with old payload
3. Mobile team updates iOS + Android apps to send new `location` object
4. After mobile release stabilizes (1-2 week soak) → remove legacy path from `auth/onboarding`

**Mobile Notification Checklist:**
- [ ] Share this document with mobile team lead
- [ ] Agree on mobile release timeline before Phase 3 deployment
- [ ] Mobile team tests against staging with both old and new payload
- [ ] Mobile team confirms test pass before legacy path is removed

**API Contract for Mobile (Phase 3 Dual-Accept):**
```
The mobile client MUST eventually send:
PATCH /api/auth/onboarding:
{
  "account_name": "...",
  "full_name": "...",
  "finish": true,
  "location": {
    "country": "India",
    "state": "Maharashtra",
    "city": "Mumbai",
    "formattedAddress": "Mumbai, Maharashtra, India",
    "placeId": "ChIJ...",
    "latitude": 19.0760,      ← optional
    "longitude": 72.8777      ← optional
  }
}
```

---

## 7. Caching Architecture

### Redis Key Schema
```
places:ac:{sha256(q)}          → autocomplete results      TTL: 60s
places:detail:{placeId}        → place details object       TTL: 86400s (24h)
places:topsearches             → sorted set, top queries    No TTL (managed manually)
```

### Cache Invalidation
- Autocomplete: no manual invalidation needed (60s TTL naturally expires)
- Details: no invalidation needed (places rarely change)
- Emergency: `redis-cli KEYS "places:*" | xargs redis-cli DEL`

### Cache Performance Expectations
- Popular cities (Mumbai, Dubai, Singapore): ~90% hit rate after warmup
- Unique/rare queries: ~20% hit rate
- Overall expected hit rate: ~60% after 1 week of normal use
- Reduction in Google API calls: ~60%

---

## 8. Google Places Session Token Strategy

### Lifecycle
1. Frontend generates `UUID v4` when user **focuses** the location input
2. Same token sent with every keystroke (autocomplete request)
3. Same token sent with the final Place Details call
4. After selection: frontend generates a NEW UUID for the next session
5. If user abandons search (clears input without selecting): token naturally expires

### Implementation Rule
- Session token is **per search session** (not per component mount)
- Generate in `useRef` so it doesn't cause re-renders
- `crypto.randomUUID()` is available in modern browsers without import

### Billing Impact
```
WITH session tokens:
  6 autocomplete calls + 1 details call = 1 billed session ≈ $0.002

WITHOUT session tokens:
  6 autocomplete calls + 1 details call = 7 billed requests ≈ $0.01

Session tokens save ~80% on billing for completed sessions.
```

---

## 9. Estimated API Cost Projections

### Assumptions
- 300ms debounce (already implemented)
- Average 5 keystrokes per search session
- 70% sessions result in place selection (30% abandoned)
- Redis cache: ~60% hit rate reduces Google API calls

### Monthly Cost Estimates

| MAU (Onboarding) | Google API Calls/Month | Estimated Monthly Cost |
|------------------|------------------------|------------------------|
| 100              | ~200                   | **$0 (free tier)**     |
| 500              | ~1,000                 | **$0 (free tier)**     |
| 2,000            | ~4,000                 | **$0-$2**              |
| 10,000           | ~20,000                | **$10-$20**            |
| 50,000           | ~100,000               | **$50-$100**           |

> Note: Assumes session-token billing, Places API (New) pricing. Free tier (Essentials): 10,000 requests/month.

**Cost Control Measures Already In Plan:**
1. Session tokens (reduces 7x per-keystroke billing to 1x per session)
2. Redis cache (reduces API calls by ~60%)
3. 300ms debounce (reduces keystrokes captured)
4. 2-char minimum query length (avoids single-char calls)
5. Budget alert in Google Cloud Console

---

## 10. Deployment Order

```
1. Deploy Phase 1 (backend proxy) to STAGING
   → Test manually
   → Deploy to PRODUCTION

2. Deploy Phase 2 (frontend onboarding) to STAGING
   → Full e2e test of onboarding flow
   → Deploy to PRODUCTION

3. (Notify mobile team)

4. Run DB migration script on STAGING
   → Verify schema
   → Deploy Phase 3 (backend controllers) to STAGING
   → Full regression test
   → Run DB migration script on PRODUCTION
   → Deploy Phase 3 to PRODUCTION

5. Deploy Phase 4 (observability) — can be bundled with Phase 3

6. Monitor for 7 days

7. Mobile team deploys updated app

8. After mobile soak: remove legacy dual-accept path

9. Phase 7 cleanup (deferred — separate sprint)
```

---

## 11. Appendix — Affected Files Summary

### Backend Files

| File | Action | Phase |
|------|--------|-------|
| `src/modules/places/places.routes.js` | CREATE | 1 |
| `src/modules/places/places.controller.js` | CREATE | 1 |
| `src/modules/places/places.schema.js` | CREATE | 1 |
| `src/app.js` | EDIT — add `/api/places` | 1 |
| `.env` | EDIT — `GOOGLE_MAPS_API_KEY` | 1 |
| `src/modules/onboarding/onboarding.schema.js` | REWRITE `updateLocationSchema` | 3 |
| `src/modules/onboarding/onboarding.controller.js` | REWRITE `updateLocation` | 3 |
| `src/modules/auth/onboarding.controller.js` | UPDATE `completeOnboarding` | 3 |
| `src/modules/auth/onboarding.schema.js` | UPDATE `completeOnboardingSchema` | 3 |

### Frontend Files

| File | Action | Phase |
|------|--------|-------|
| `src/services/api/location.ts` | ADD `searchPlaces`, `getPlaceDetails`, interfaces | 2 |
| `src/components/ui/LocationAutocomplete.tsx` | ADD `mode` prop, session tokens, details call | 2 |
| `src/store/onboarding.store.ts` | ADD new location fields | 2 |
| `src/services/api/onboarding.ts` | UPDATE `UpdateOnboardingLocationPayload` | 2 |
| `src/components/onboarding/TellUsAboutYouStep.tsx` | UPDATE `handleContinue` payload | 2 |

### Preserved (Do NOT Touch Until Phase 7)

| File | Reason Preserved |
|------|-----------------|
| `src/modules/location/location.routes.js` | Experience/Education forms depend on it |
| `schema.sql` — `locations` table | Legacy onboarding and form support |
| `src/scripts/seedLocations.js` | Historical reference |
| `src/components/profile/AddExperienceForm.tsx` | Phase 7 scope |
| `src/components/profile/AddEducationForm.tsx` | Phase 7 scope |
