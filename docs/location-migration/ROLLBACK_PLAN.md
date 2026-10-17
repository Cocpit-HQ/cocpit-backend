# ROLLBACK PLAN — Location Migration

**Last Updated:** 2026-05-26  
**Principle:** Every phase must be independently rollable. No single phase should require rollback of a prior phase.

---

## Rollback by Phase

### Phase 1 Rollback — Backend Places Proxy

**What was added:**
- New route: `GET /api/places/autocomplete`
- New route: `GET /api/places/details`
- New module: `src/modules/places/` directory

**Rollback action:**
```js
// In app.js — comment out the new routes
// app.use('/api/places', placesRoutes);
```

Or remove the route registration entirely. No DB changes in Phase 1 → zero data risk.  
Frontend still calls old `/api/locations` if Phase 2 hasn't deployed.

**Redis cleanup (optional):**
```bash
redis-cli KEYS "places:*" | xargs redis-cli DEL
```

---

### Phase 2 Rollback — Frontend Migration

**What was changed:**
- `location.ts` — `searchLocations` now calls `/api/places/autocomplete`
- `LocationAutocomplete.tsx` — accepts new suggestion shape
- `onboarding.store.ts` — new state fields
- `TellUsAboutYouStep.tsx` — sends new payload

**Rollback action:**
- Revert git commit for the frontend changes.
- Backend Phase 1 proxy can remain in place (harmless if frontend stops calling it).
- Frontend falls back to calling old `/api/locations`.

**Git strategy:** Each phase should be a separate PR/commit. Revert is `git revert <phase2-commit>`.

---

### Phase 3 Rollback — Backend Schema + Controller

**What was changed:**
- `users` table — 7 new columns added
- `onboarding.controller.js` — `updateLocation()` rewritten
- `onboarding.schema.js` — Zod schema rewritten
- `auth/onboarding.controller.js` — `completeOnboarding()` updated

**Rollback action:**

**Step 1 — Restore old controller logic** (revert git commit)  
**Step 2 — Run DB rollback script:**
```sql
BEGIN;
ALTER TABLE users
  DROP COLUMN IF EXISTS location_country,
  DROP COLUMN IF EXISTS location_state,
  DROP COLUMN IF EXISTS location_city,
  DROP COLUMN IF EXISTS location_formatted,
  DROP COLUMN IF EXISTS location_lat,
  DROP COLUMN IF EXISTS location_lng,
  DROP COLUMN IF EXISTS location_place_id;
DROP INDEX IF EXISTS idx_users_location_country;
DROP INDEX IF EXISTS idx_users_location_city;
COMMIT;
```

**Data impact:** Only new users (who onboarded after Phase 3 deployed) will have location data in new columns. Rollback loses their new-format location but preserves `location` TEXT (which was still written in dual-write mode).

---

### Phase 4 Rollback — Observability

**What was added:**
- Logging middleware/hooks in places controller
- Possibly a `location_events` table or log stream

**Rollback action:** Comment out logging calls. No user-facing impact.

---

## Full Migration Rollback (Nuclear Option)

If ALL phases must be rolled back after Phase 3:

1. `git revert` Phase 3, 2, and 1 commits
2. Run DB column DROP script (Phase 3 rollback SQL above)
3. Re-enable `GET /api/locations` route (it was never disabled)
4. Re-enable old controller logic

**Result:** System returns to exact pre-migration state. Old users unaffected. New users who onboarded under new system will have `location = null` in legacy format (they can re-set in profile).

---

## Dual-Write Safeguard

The controller is written to perform **dual-write** during Phases 3–6:

```sql
-- During transition (Phases 3-6), BOTH old AND new columns are written:
UPDATE users SET
  location          = formattedAddress,    ← Legacy column (still populated)
  location_id       = NULL,                ← Explicitly null for new users
  location_formatted = formattedAddress,   ← New column
  location_country   = country,            ← New column
  ...
WHERE user_id = $8;
```

This means **rollback to legacy state is always safe** because `users.location` (TEXT) is always current.

---

## Mobile Client Rollback Strategy

For Phase 3 (API contract change):

**Before Phase 3 deploys:**
- Backend temporarily accepts BOTH old and new payloads:
```js
// Transitional controller logic
const isLegacyPayload = body.location_id !== undefined;
const isNewPayload = body.placeId !== undefined;

if (isLegacyPayload) {
  // Handle legacy: resolve from locations table
} else if (isNewPayload) {
  // Handle new: structured location object
} else {
  return res.status(400).json({ ... });
}
```

- This dual-accept mode runs until mobile clients are confirmed updated.
- After mobile update confirmed: remove legacy path acceptance.

---

## Rollback Decision Criteria

| Trigger                                         | Rollback Scope        |
|--------------------------------------------------|----------------------|
| Google Places API down for > 1 hour             | Phase 1 only          |
| Onboarding completion rate drops > 10%          | Phase 2 rollback      |
| Database migration causes performance regression | Phase 3 DB only       |
| Mobile clients sending 400 errors               | Phase 3 dual-accept   |
| API quota exceeded unexpectedly                 | Phase 1 (disable proxy)|

---

## Rollback Contacts & Ownership

| Phase | Owner       | Decision Authority   |
|-------|-------------|----------------------|
| 1     | Backend Dev | On-call engineer     |
| 2     | Frontend Dev| On-call engineer     |
| 3     | Backend Dev | Lead + DevOps        |
| Mobile| Mobile Dev  | Lead                 |
