# TASK PROGRESS — Location Migration

**Last Updated:** 2026-05-26  
**Format:** `[ ]` = pending | `[/]` = in progress | `[x]` = complete | `[~]` = deferred

---

## Phase 0 — Investigation & Planning

- [x] Map existing frontend onboarding flow
- [x] Map existing backend location APIs (`/api/locations`, `/api/onboarding/location`)
- [x] Audit `onboarding.controller.js` (both modules/onboarding and auth)
- [x] Audit `onboarding.schema.js` (both files — found type mismatch bug)
- [x] Audit `schema.sql` — `locations` table structure
- [x] Audit `users` table columns: `location TEXT`, `location_id INT`
- [x] Map all consumers of `LocationAutocomplete` component
- [x] Map all backend modules reading `u.location`
- [x] Investigate `seedLocations.js` — found India-only seeding bug (AE/SG missing)
- [x] Compare Google Places API (New) vs Legacy Autocomplete — selected New
- [x] Research session token strategy and billing model
- [x] Analyze pricing: completed sessions vs abandoned sessions
- [x] Design Redis caching architecture (TTLs, key format, hit/miss tracking)
- [x] Design backend proxy architecture
- [x] Design country restriction: dual-layer (proxy + server-side validation)
- [x] Confirm `mode="legacy"|"places"` prop strategy for `LocationAutocomplete`
- [x] Design dual-write strategy for backward compatibility
- [x] Design rollback strategy per phase
- [x] Write `CURRENT_STATUS.md`
- [x] Write `ARCHITECTURE_NOTES.md`
- [x] Write `DATABASE_CHANGES.md`
- [x] Write `API_CONTRACTS.md`
- [x] Write `RISKS_AND_BLOCKERS.md`
- [x] Write `ROLLBACK_PLAN.md`
- [x] Write `TASK_PROGRESS.md` (this file)
- [x] Write `NEXT_STEPS.md`
- [x] Write `IMPLEMENTATION_PLAN.md`

---

## Phase 1 — Backend Places Proxy + Redis Cache

### Prerequisites
- [ ] Google Maps API key provisioned
- [ ] `GOOGLE_MAPS_API_KEY` in backend `.env`
- [ ] Confirm Redis is running on target environments

### Backend Tasks
- [x] Create `src/modules/places/` directory
- [x] Create `places.routes.js`
- [x] Create `places.controller.js`
  - [x] `getAutocomplete()` function
  - [x] `getPlaceDetails()` function
  - [x] Redis cache integration (autocomplete: 60s, details: 24h)
  - [x] Cache hit/miss header (`X-Cache: HIT|MISS`)
  - [x] Address component parser (`parseAddressComponents()`)
  - [x] Singapore `state=null` edge case handling
  - [x] UAE "Emirate of " prefix normalization
  - [x] Error handling: Google API 4xx/5xx → clean error responses
  - [x] Fallback `503` with `fallback: true` flag
- [x] Create `places.schema.js` (Zod validation for autocomplete/details params)
- [x] Register routes in `app.js` (`/api/places`)
- [x] Add rate limit: 30 req/min per user on `/api/places` routes
- [x] Add observability hooks (logging — see Phase 4)
- [x] Write env variable documentation update

### Backend Testing (Phase 1)
- [ ] Test `GET /api/places/autocomplete?q=Mumbai&sessionToken=xxx`
- [ ] Test `GET /api/places/autocomplete?q=Dubai&sessionToken=xxx`
- [ ] Test `GET /api/places/autocomplete?q=Singapore&sessionToken=xxx`
- [ ] Test `GET /api/places/details?placeId=xxx&sessionToken=xxx`
- [ ] Verify Singapore `state: null` in response
- [ ] Verify UAE returns country: "United Arab Emirates"
- [ ] Test Redis cache: second identical request returns `X-Cache: HIT`
- [ ] Test country restriction: query "London" returns 0 results (restricted to IN/AE/SG)
- [ ] Test session token passing to Google API
- [ ] Test error response when Google API is down (mock 503)

---

## Phase 2 — Frontend Onboarding Migration

### Prerequisites
- [ ] Phase 1 backend proxy deployed and tested

### Frontend Tasks
- [x] Extend `LocationSuggestion` interface (add `placeId`, `displayName`, `description`)
- [x] Add `StructuredLocation` interface to `location.ts`
- [x] Add `searchPlaces(query, sessionToken)` function to `location.ts`
- [x] Add `getPlaceDetails(placeId, sessionToken)` function to `location.ts`
- [x] Update `LocationAutocomplete.tsx`
  - [x] Add `mode?: "legacy" | "places"` prop (default: `"places"`)
  - [x] Add `sessionToken` generation (`useRef<string>` with `crypto.randomUUID()`)
  - [x] Wire `abortControllerRef` for request cancellation (existing unused ref)
  - [x] On selection: call `getPlaceDetails()` before calling `onSelect`
  - [x] Show loading state during Place Details call
  - [x] Handle `fallback: true` response — show skip option
  - [x] On new search started: generate fresh session token
- [x] Update `onboarding.store.ts`
  - [x] Add new fields: `locationPlaceId`, `locationFormatted`, `locationCountry`, `locationState`, `locationCity`, `locationLat`, `locationLng`
  - [x] Update `setLocation()` signature to accept `StructuredLocation | null`
  - [x] Keep all old fields during transition (`locationId`, `locationName`) or alias them
  - [x] Update `resetOnboardingStore()` to include new fields
- [x] Update `UpdateOnboardingLocationPayload` in `onboarding.ts`
- [x] Update `TellUsAboutYouStep.tsx`
  - [x] `handleContinue()` — send new structured payload to `updateOnboardingLocation`
  - [x] Update validation: require `locationPlaceId` not `locationId`
  - [x] Handle API failure gracefully (show skip option)
- [x] Update `.env.local` documentation (note: no key needed here — proxy handles it)

### Frontend Testing (Phase 2)
- [ ] Onboarding step 2 loads `LocationAutocomplete` in places mode
- [ ] Typing "Mum" shows Mumbai suggestions
- [ ] Typing "Dub" shows Dubai suggestions
- [ ] Typing "Sin" shows Singapore suggestions
- [ ] Typing "London" shows no results (country restricted)
- [ ] Selecting a city calls `getPlaceDetails` and populates store
- [ ] Store has `locationCountry: "India"` etc. after selection
- [ ] Clicking Continue triggers `PATCH /api/onboarding/location` with correct payload
- [ ] Clearing selection resets store to null
- [ ] Google API failure → skip option appears → user can continue without location
- [ ] Onboarding store reset works after completion

---

## Phase 3 — Backend Schema + Controller Migration

### Prerequisites
- [ ] Phase 2 frontend deployed and tested
- [ ] Mobile team notified (at minimum 1 sprint advance notice)
- [ ] DB migration script reviewed by team lead

### Database Tasks
- [x] Run migration SQL (additive columns on `users`)
- [x] Verify columns added with `\d users`
- [x] Verify indexes created
- [x] Verify no existing data changed

### Backend Tasks
- [x] Rewrite `updateLocationSchema` in `onboarding.schema.js`
  - [x] Accept: `country`, `state`, `city`, `formattedAddress`, `placeId`
  - [x] Validate: `country` ∈ {"India", "United Arab Emirates", "Singapore"}
  - [x] Validate: `state` nullable
  - [x] Validate: `latitude`, `longitude` nullable numbers
- [x] Rewrite `updateLocation()` in `modules/onboarding/onboarding.controller.js`
  - [x] Remove old `location_id` / `locations` table dependency
  - [x] Server-side country validation (R2 defense)
  - [x] Dual-write: `location` (TEXT) AND new columns
  - [x] `location_id = NULL` for new users
- [x] Update `auth/onboarding.controller.js` `completeOnboarding()`
  - [x] Add dual-accept mode: handle both legacy `location_id` AND new `location` object
  - [x] Remove `SELECT id, name FROM locations WHERE id = $1` query (or keep in legacy path)
  - [x] Write new columns when new payload detected
- [x] Update `auth/onboarding.schema.js`
  - [x] `location_id` becomes optional (retained for mobile backward compat)
  - [x] Add optional `location` object schema
- [x] Add `@googlemaps/google-maps-services-js` or `axios` dependency (if not already present)

### Backend Testing (Phase 3)
- [ ] `PATCH /api/onboarding/location` with new payload → 200 OK
- [ ] `PATCH /api/onboarding/location` with invalid country ("UK") → 400
- [ ] `PATCH /api/onboarding/location` without `placeId` → 400
- [ ] `PATCH /api/onboarding/location` with Singapore (state: null) → 200 OK
- [ ] Check DB: new columns populated correctly after request
- [ ] Check DB: `users.location` (TEXT) still populated (dual-write working)
- [ ] `POST /api/auth/onboarding` with legacy `location_id` → still works (mobile compat)
- [ ] `POST /api/auth/onboarding` with new `location` object → works
- [ ] Profile read API (`GET /api/profile/:id`) still returns `location` field

---

## Phase 4 — Observability & Monitoring

- [x] Add structured logging in `places.controller.js`:
  - [x] Log: `{ event: "autocomplete_request", query_length, country_count, cache: "HIT"|"MISS", latency_ms, result_count }`
  - [x] Log: `{ event: "place_details_request", place_id, country, cache: "HIT"|"MISS", latency_ms }`
  - [x] Log: `{ event: "google_api_error", status_code, message, endpoint }`
  - [x] Log: `{ event: "location_saved", user_id_hash, country, has_coordinates }`
- [x] Track top searched queries (Redis sorted set):
  ```
  ZINCRBY places:topsearches 1 "mumbai"
  ```
- [ ] Implement cache hit rate reporting (daily cron or admin endpoint)
- [ ] Add Google Cloud Console quota alert (80% of monthly limit)
- [ ] Add latency alert: if Places API p95 > 2s, trigger notification
- [ ] Document analytics endpoints if added

---

## Phase 5 — Mobile Synchronization

- [ ] Confirm mobile team updated iOS client to send new `PATCH /api/onboarding/location` format
- [ ] Confirm mobile team updated Android client
- [ ] Run e2e test from mobile build
- [ ] After confirmation: remove legacy `location_id` dual-accept from `auth/onboarding.controller.js`

---

## Phase 6 — Validation & Stabilization

- [ ] Monitor for 7 days: 
  - [ ] Zero increase in onboarding abandonment rate at Step 2
  - [ ] Location save success rate > 95%
  - [ ] No spike in Google API errors
  - [ ] Redis cache hit rate > 50%
- [ ] Verify profile cards show location for new users
- [ ] Verify experience/education forms still working on legacy route
- [ ] Sign off from Lead + QA

---

## Phase 7 — Cleanup (Deferred)

- [x] Remove `GET /api/locations` route (DEFERRED — experience/education forms pending)
- [x] Remove legacy `location_id` from `auth/onboarding.controller.js`
- [x] Migrate `AddExperienceForm` to places mode
- [x] Migrate `AddEducationForm` to places mode
- [x] Drop `locations` table (only after all forms migrated)
- [x] Update `schema.sql` to remove locations table
- [x] Mark `seedLocations.js` as fully deprecated
- [x] Drop `users.location_id` column (only after full cleanup)
