# CURRENT STATUS — Location Migration
**Last Updated:** 2026-05-26  
**Migration Phase:** PRE-IMPLEMENTATION (Planning Complete)  
**Status:** ✅ Architecture finalized — awaiting implementation sign-off

---

## Migration At a Glance

| Dimension              | Value                                                     |
|------------------------|-----------------------------------------------------------|
| **Migration Type**     | Hybrid Compatibility Mode → Full Replacement (phased)     |
| **Target API**         | Google Places Autocomplete (New) — backend proxy          |
| **Country Scope**      | IN (India), AE (UAE), SG (Singapore)                      |
| **DB Strategy**        | Additive columns on `users` table (no new table, Phase 1) |
| **Overall Complexity** | Medium                                                    |
| **Overall Risk**       | Low–Medium                                                |
| **Onboarding Impact**  | Step 2 (`TellUsAboutYouStep`) only — targeted             |

---

## Phase Status

| Phase | Name                              | Status        | ETA     |
|-------|-----------------------------------|---------------|---------|
| 0     | Planning & Documentation          | ✅ Complete   | Done    |
| 1     | Backend Places Proxy Route        | ✅ Complete   | —       |
| 2     | Frontend Onboarding Migration     | ✅ Complete   | —       |
| 3     | Backend Schema + Controller       | ✅ Complete   | —       |
| 4     | Observability & Monitoring        | ✅ Complete   | —       |
| 5     | Mobile Coordination               | ⏳ Pending    | —       |
| 6     | Validation & Testing              | 🔲 Pending    | —       |
| 7     | Cleanup (Legacy Removal)          | 🔲 Pending    | Deferred|

---

## Decisions Locked In

1. **Backend proxy** — NOT direct frontend Google SDK. All Places API calls go through COCPIT backend.
2. **No `user_locations` table** in Phase 1. Use additive columns on `users`.
3. **Coordinates are optional** — do not block onboarding if Places Details call fails.
4. **Legacy `locations` table and `/api/locations` route are PRESERVED** until after Phase 6 validation.
5. **Experience/Education forms remain on legacy system** — migrate separately after onboarding stabilizes.
6. **Google Places Autocomplete (New)** selected over legacy (see `ARCHITECTURE_NOTES.md`).
7. **Redis caching** — introduced in Phase 1 alongside the proxy.

---

## Immediate Next Steps (For Mobile Team)

1. Review the updated `API_CONTRACTS.md`.
2. Update iOS and Android clients to use the new nested `location` payload on `PATCH /api/onboarding/location` and `POST /api/auth/onboarding`.
3. Provide sign-off so backend can proceed to Phase 7 (Cleanup).

> **Note to USER:** You must provide the Google Maps API key in `.env` (`GOOGLE_MAPS_API_KEY=...`) to test the flow end-to-end.

---

## What Can Be Started Now (No Blockers)

- [ ] DB migration script drafted (additive columns only)
- [ ] Zod schema rewrite for `updateLocationSchema`
- [ ] `LocationSuggestion` TypeScript interface extension

---

## Files To NOT Touch Until Phase 7

```
src/modules/location/location.routes.js     ← Keep alive for experience/education
src/scripts/seedLocations.js                ← Keep as historical reference  
schema.sql locations table                  ← Do NOT drop
src/components/profile/AddExperienceForm    ← Phase 7+ scope
src/components/profile/AddEducationForm     ← Phase 7+ scope
```

---

## Continuation Guide

If this session is interrupted, continue from:
1. Read `IMPLEMENTATION_PLAN.md` for full phase breakdown
2. Read `TASK_PROGRESS.md` for exact checklist
3. Read `API_CONTRACTS.md` for the before/after contract
4. Read `DATABASE_CHANGES.md` for exact SQL migration scripts
5. Read `NEXT_STEPS.md` for immediate next action
