# RISKS AND BLOCKERS — Location Migration

**Last Updated:** 2026-05-26

---

## Pre-Implementation Blockers (Must Resolve Before Phase 1)

| # | Blocker                                   | Owner      | Resolution                                          |
|---|-------------------------------------------|------------|-----------------------------------------------------|
| B1 | Google Maps API key not provisioned      | DevOps/PM  | Create GCP project → enable Places API (New) → restrict by IP |
| B2 | `GOOGLE_MAPS_API_KEY` not in backend `.env` | Dev     | Add once B1 is complete                             |
| B3 | Mobile team not notified                  | PM/Lead    | Notify before Phase 3 starts — API contract change  |
| B4 | Redis running on target environment       | DevOps     | Confirm `REDIS_URL` is active in staging/prod       |

---

## High Priority Risks

### R1 — `auth/onboarding.controller.js` Tight Coupling
**Risk:** `completeOnboarding()` still queries `SELECT id, name FROM locations WHERE id = $1` using the old `location_id` INT. If Phase 3 schema change runs before this controller is updated, new users will send `placeId` (string) but controller will try to cast it to INT → runtime error.

**Mitigation:** Phase 3 must update this controller **atomically** with the Zod schema change.  
**Status:** 🔲 Pending  

---

### R2 — Existing Schema Type Bug (`location_id` as STRING vs INT)
**Risk:** `onboarding.schema.js` (modules/onboarding) validates `location_id` as `z.string()`, but the DB column is INT and `auth/onboarding.schema.js` uses `z.coerce.number()`. This is a pre-existing inconsistency.

**Mitigation:** Fixed as part of Phase 3 Zod schema rewrite.  
**Status:** 🔲 Pending  

---

### R3 — Missing UAE/Singapore Data in `locations` Table
**Risk (FOUND IN INVESTIGATION):** The `seedLocations.js` script has `countryCode !== "IN" continue` — it only seeds India. UAE and Singapore data was NEVER imported despite being in `countryMap`. This means the current system **cannot serve AE or SG locations at all**.

**Implication:** Users selecting UAE or Singapore locations in the legacy system would get 0 results. This strengthens the case for migration.  
**Mitigation:** Migration resolves this — no need to re-seed.  
**Status:** 🟡 Known, resolved by migration  

---

### R4 — Mobile Client Breaking Change
**Risk:** iOS/Android clients may call `PATCH /api/onboarding/location` with the old contract (`location_id` + `location`). After Phase 3 changes the contract, these clients will receive 400 validation errors.

**Mitigation:** 
- Version the endpoint (add `/v2/`) OR use a transitional dual-accept controller.
- Notify mobile team before Phase 3 deployment.
- Deploy backend with dual-accept, deploy mobile update, then retire legacy path.  
**Status:** 🔲 Pending mobile coordination  

---

### R5 — Google Places API Quota Exhaustion
**Risk:** If the API key is shared with other services or a bug causes per-keystroke billing (missing session token), quota could be exhausted, breaking onboarding completely.

**Mitigation:**
- Separate API key for Places proxy.
- Set quota alerts in Google Cloud Console (daily budget cap).
- Redis cache reduces call volume by 60–80% for popular cities.
- Fallback: If Google API returns error, return `{ fallback: true }` and allow user to skip location.  
**Status:** 🔲 Pre-implementation setup needed  

---

### R6 — Places API Network Failure During Onboarding
**Risk:** If Google Places API is unavailable, the location step fails → user cannot complete onboarding.

**Mitigation:**
- Return `503` with `fallback: true` flag.
- Frontend shows "Location service temporarily unavailable. You can set your location later in your profile."
- Allow user to skip with `location = null`.  
**Status:** 🔲 Implement in Phase 2 (frontend fallback UI)  

---

## Medium Priority Risks

### R7 — `LocationAutocomplete` Used in Profile Forms
**Risk:** `AddExperienceForm` and `AddEducationForm` import `LocationAutocomplete`. If the component's internal contract changes (new `onSelect` shape), these forms may silently break.

**Mitigation:** 
- Add `mode` prop to `LocationAutocomplete`: `"legacy" | "places"`.
- In legacy mode, component calls old `searchLocations` → old `/api/locations`.
- In places mode, component calls new `searchPlaces` → new `/api/places/autocomplete`.
- Default `mode="places"` in onboarding, `mode="legacy"` in forms.  
**Status:** 🔲 Phase 2 implementation  

---

### R8 — `onSelect` Callback Contract Change in `LocationAutocomplete`
**Risk:** Currently `onSelect: (location: any) => void`. After migration, it should be typed as `(loc: LocationSuggestion | null) => void`. Any consumer passing incompatible data to `onSelect` will fail silently.

**Mitigation:** Type the callback strictly. Fix profile form consumers to handle the new shape only after they're migrated.  
**Status:** 🔲 Phase 2  

---

### R9 — Singapore City/State Parsing Edge Case
**Risk:** Singapore has no administrative state/region. Google Places will return a country of "Singapore" with no state component. The backend's address component parser must handle `state = null` gracefully.

**Mitigation:** Parser explicitly handles missing `administrative_area_level_1` component → sets `state = null`.  
**Status:** 🔲 Phase 1 (proxy parser must handle)  

---

### R10 — UAE Emirate Naming Inconsistency
**Risk:** Google Places may return address components for UAE as `administrative_area_level_1: "Dubai"` or `"Emirate of Dubai"`. Formatting must normalize this.

**Mitigation:** Strip "Emirate of " prefix in backend parser.  
**Status:** 🔲 Phase 1 (proxy parser must handle)  

---

## Low Priority Risks

### R11 — Stale Cache for Renamed Places
**Risk:** Redis caches autocomplete results for 60 seconds. Place details cached for 24 hours. If Google updates a place name, old cache is served.

**Impact:** Very low — place names change rarely.  
**Mitigation:** 24h TTL for details is acceptable. Monitor for complaints.  

---

### R12 — `location_place_id` Uniqueness Not Enforced
**Risk:** Multiple users could select the same `placeId`. No uniqueness constraint needed (users share cities) — but if we accidentally add a UNIQUE constraint, it would break multiple users in same city.

**Mitigation:** Do NOT add `UNIQUE` constraint to `location_place_id`.  
**Status:** ✅ Schema script does not include UNIQUE  

---

## Pre-Existing Bugs (Not New — Found in Investigation)

| Bug | Location | Severity | Fix |
|-----|----------|----------|-----|
| `location_id` type: `z.string()` in onboarding vs INT in DB | `onboarding.schema.js` | Medium | Fix in Phase 3 |
| `locations` table seeds only India (no UAE/SG) | `seedLocations.js` | High (functional gap) | Resolved by migration |
| No FK constraint on `users.location_id` | `schema.sql` | Low | No action needed |
| `abortControllerRef` in `LocationAutocomplete` unused | `LocationAutocomplete.tsx` | Low | Fix in Phase 2 |

---

## Regression-Sensitive Areas

These areas must be regression-tested after each phase:

1. **Onboarding step 2 completion** → location saved correctly
2. **Profile card rendering** → `u.location` still renders for all users
3. **`auth/completeOnboarding`** → finishing onboarding flow end-to-end
4. **Experience form** → location still searchable via legacy endpoint
5. **Education form** → same as experience
6. **Social/share queries** → user's location still appears in cards
7. **Profile edit** → `location` field update via profile editor still works
