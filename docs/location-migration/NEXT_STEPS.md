# NEXT STEPS — Location Migration

**Last Updated:** 2026-05-26  
**Immediate State:** Planning Complete. Awaiting implementation authorization.

---

## Immediate Next Steps (Pre-Implementation)

### Step 1 — Provision Google Maps API Key (BLOCKING)
```
1. Go to: https://console.cloud.google.com/
2. Create or select project
3. Enable APIs:
   - Places API (New)
   - (Optional) Maps JavaScript API — NOT needed for backend proxy
4. Create a new API key (separate from the Google OAuth key)
5. Restrict key:
   - Application restrictions: IP addresses (your server IPs)
   - API restrictions: Places API (New) only
6. Add to backend .env:
   GOOGLE_MAPS_API_KEY=<your-key>
7. Add to .env.example:
   GOOGLE_MAPS_API_KEY=  # Google Places API (New) key — backend only
```

### Step 2 — Confirm Redis is Available
```bash
redis-cli ping   # should return PONG
```
Check `REDIS_URL=redis://127.0.0.1:6379` in `.env` is accessible from the backend process.

### Step 3 — Begin Phase 1 Implementation
Start with the backend proxy module:
```
New file: cocpit-backend/src/modules/places/places.routes.js
New file: cocpit-backend/src/modules/places/places.controller.js
New file: cocpit-backend/src/modules/places/places.schema.js
Edit:     cocpit-backend/src/app.js  (register /api/places route)
Edit:     cocpit-backend/.env        (add GOOGLE_MAPS_API_KEY)
```

---

## Files to Create/Edit — Ordered by Phase

### Phase 1 (Backend Proxy)
```
CREATE: src/modules/places/places.routes.js
CREATE: src/modules/places/places.controller.js
CREATE: src/modules/places/places.schema.js
EDIT:   src/app.js                          (register /api/places)
EDIT:   .env                                (GOOGLE_MAPS_API_KEY)
EDIT:   .env.example                        (document new var)
```

### Phase 2 (Frontend)
```
EDIT: src/services/api/location.ts          (new searchPlaces, getPlaceDetails)
EDIT: src/components/ui/LocationAutocomplete.tsx   (mode prop, session tokens)
EDIT: src/store/onboarding.store.ts         (new location fields)
EDIT: src/services/api/onboarding.ts        (new payload interface)
EDIT: src/components/onboarding/TellUsAboutYouStep.tsx  (new handleContinue)
```

### Phase 3 (Backend Controller + Schema)
```
RUN:  SQL migration (see DATABASE_CHANGES.md)
EDIT: src/modules/onboarding/onboarding.schema.js   (rewrite updateLocationSchema)
EDIT: src/modules/onboarding/onboarding.controller.js (rewrite updateLocation)
EDIT: src/modules/auth/onboarding.controller.js      (dual-accept + new columns)
EDIT: src/modules/auth/onboarding.schema.js          (update completeOnboardingSchema)
```

### Phase 4 (Observability)
```
EDIT: src/modules/places/places.controller.js   (add structured logging)
```

---

## Decisions Requiring Future Confirmation

| Decision | Due | Notes |
|----------|-----|-------|
| Mobile client update timeline | Before Phase 3 | Must coordinate with mobile team |
| Experience/Education form migration scope | Phase 7 | Not in current scope |
| PostGIS geo-search feature | Future | Not in this migration |
| User location update from Profile edit | Future | Profile edit currently accepts free-text `location` — may need its own migration |
| `user_locations` normalized table | Phase 7+ | Deferred per decisions doc |

---

## Quick Reference — Key Files and Their Roles

| File | Current Role | Phase Migration |
|------|-------------|-----------------|
| `src/modules/location/location.routes.js` | Serves `/api/locations` for all forms | PRESERVE until Phase 7 |
| `src/modules/onboarding/onboarding.controller.js` | `updateLocation()` | REWRITE in Phase 3 |
| `src/modules/auth/onboarding.controller.js` | `completeOnboarding()` | UPDATE in Phase 3 |
| `src/services/api/location.ts` | `searchLocations()` | EXTEND in Phase 2 |
| `src/components/ui/LocationAutocomplete.tsx` | Autocomplete UI | UPDATE in Phase 2 |
| `src/store/onboarding.store.ts` | Location state | EXTEND in Phase 2 |
| `src/components/onboarding/TellUsAboutYouStep.tsx` | Location step | UPDATE in Phase 2 |
| `schema.sql` (locations table) | Static GeoNames data | PRESERVE until Phase 7 |
| `src/scripts/seedLocations.js` | One-time seeder | PRESERVE (mark deprecated) |
