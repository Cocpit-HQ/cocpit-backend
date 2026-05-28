# DATABASE CHANGES — Location Migration

**Last Updated:** 2026-05-26  
**Strategy:** Additive columns on `users` table (Phase 1). No new table. No dropped columns.

---

## Phase 1 Schema Migration — Additive Columns on `users`

### Migration Script (Safe, Additive, Backward Compatible)

```sql
-- ============================================================
-- Migration: 2026-XX-XX_add_structured_location_to_users.sql
-- Description: Add structured Google Places location fields
--              to users table. All columns are nullable.
--              Existing rows (location TEXT, location_id INT)
--              remain untouched and backward compatible.
-- Risk: ZERO — additive only, no data dropped
-- Rollback: DROP COLUMN each field (see rollback section)
-- ============================================================

BEGIN;

-- Structured location fields from Google Places Autocomplete (New)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location_country TEXT,        -- "India" / "United Arab Emirates" / "Singapore"
  ADD COLUMN IF NOT EXISTS location_state   TEXT,        -- "Maharashtra" / "Dubai" / null (SG has no states)
  ADD COLUMN IF NOT EXISTS location_city    TEXT,        -- "Mumbai" / "Dubai" / "Singapore"
  ADD COLUMN IF NOT EXISTS location_formatted TEXT,      -- "Mumbai, Maharashtra, India" (display string)
  ADD COLUMN IF NOT EXISTS location_lat     DOUBLE PRECISION,  -- 19.0760 (optional, nullable)
  ADD COLUMN IF NOT EXISTS location_lng     DOUBLE PRECISION,  -- 72.8777 (optional, nullable)
  ADD COLUMN IF NOT EXISTS location_place_id TEXT;       -- "ChIJwe1EZjDG5zsRaYxkjY_tpF0" (Google placeId)

-- Performance index for future geo-based queries (country filter)
CREATE INDEX IF NOT EXISTS idx_users_location_country 
  ON users(location_country) 
  WHERE location_country IS NOT NULL;

-- Performance index for future city-based user discovery
CREATE INDEX IF NOT EXISTS idx_users_location_city 
  ON users(LOWER(location_city)) 
  WHERE location_city IS NOT NULL;

-- Note: location_place_id index — deferred to Phase 6 when geo-features are planned
-- CREATE INDEX IF NOT EXISTS idx_users_location_place_id ON users(location_place_id);

COMMIT;
```

---

## Field Mapping — Old vs New

| Old Column      | Type  | New Column            | Type             | Notes                                         |
|-----------------|-------|-----------------------|------------------|-----------------------------------------------|
| `location`      | TEXT  | `location_formatted`  | TEXT             | Old column preserved; new column mirrors it   |
| `location_id`   | INT   | `location_place_id`   | TEXT             | Old = serial int FK; New = Google placeId     |
| *(none)*        | —     | `location_country`    | TEXT             | New: ISO country name                         |
| *(none)*        | —     | `location_state`      | TEXT             | New: state/emirate/null                       |
| *(none)*        | —     | `location_city`       | TEXT             | New: city name                                |
| *(none)*        | —     | `location_lat`        | DOUBLE PRECISION | New: latitude (nullable)                      |
| *(none)*        | —     | `location_lng`        | DOUBLE PRECISION | New: longitude (nullable)                     |

### Preserved Legacy Columns (Do NOT Drop — Phase 1–6)

```sql
-- These columns remain active for backward compatibility:
users.location       TEXT  -- used by profile read APIs, social queries, share previews
users.location_id    INT   -- used by auth/onboarding.controller.js (still active)
```

---

## Write Strategy During Transition

When a new user completes onboarding after Phase 3:

```sql
-- Phase 3+ updateLocation() writes to BOTH old AND new columns
UPDATE users
SET 
  -- Legacy columns (preserve for backward compat)
  location     = $1,   -- formattedAddress (same as before)
  location_id  = NULL, -- explicitly NULL for new users (no longer FK to locations table)
  
  -- New structured columns
  location_formatted = $1,   -- "Mumbai, Maharashtra, India"
  location_country   = $2,   -- "India"
  location_state     = $3,   -- "Maharashtra"
  location_city      = $4,   -- "Mumbai"
  location_lat       = $5,   -- 19.0760 (nullable)
  location_lng       = $6,   -- 72.8777 (nullable)
  location_place_id  = $7,   -- "ChIJwe1EZjDG5zsRaYxkjY_tpF0"
  
  updated_at = NOW()
WHERE user_id = $8;
```

**This dual-write approach means:**
- Existing read APIs (`u.location`) continue working without any changes
- New columns populate for new users
- Old users retain their legacy `location` field value

---

## Existing Tables with `location TEXT` (NOT affected by this migration)

These tables use freeform `location TEXT` fields unrelated to the `locations` table.  
**No changes needed** in Phase 1–3:

```sql
experiences.location     TEXT  -- freeform, stays freeform
educations.location      TEXT  -- freeform, stays freeform
organizations.location   VARCHAR(255) -- freeform, stays freeform
jobs.location            TEXT  -- freeform, stays freeform
events.location          TEXT  -- freeform, stays freeform
posts.location           TEXT  -- freeform, stays freeform
```

---

## `locations` Table — Preservation Plan

```sql
-- The `locations` table (GeoNames seed data) is PRESERVED.
-- Used by: GET /api/locations, auth/onboarding.controller.js (until Phase 6)
-- Used by: AddExperienceForm, AddEducationForm (until Phase 7)

-- CURRENT STATE (2026-05-26):
-- Only India data seeded (seedLocations.js filters for IN only)
-- AE and SG data NEVER seeded (bug found in investigation)
-- Has no FK constraint from users.location_id (no REFERENCES)

-- DO NOT DROP until Phase 7 cleanup confirmation
```

---

## Future Phase: PostGIS (Phase 7+, Not In Scope Now)

```sql
-- Future geo-feature enablement (NOT part of this migration):
-- CREATE EXTENSION IF NOT EXISTS postgis;
-- ALTER TABLE users ADD COLUMN location_point GEOGRAPHY(POINT, 4326);
-- CREATE INDEX idx_users_location_geo ON users USING GIST(location_point);
-- UPDATE users SET location_point = ST_MakePoint(location_lng, location_lat) 
--   WHERE location_lat IS NOT NULL;
```

---

## Rollback Script

If migration must be fully rolled back:

```sql
-- ROLLBACK: Remove new columns from users
-- Safe to run at any point before Phase 7 cleanup
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
-- Result: System returns to legacy state. Old columns untouched.
```

---

## Verification Queries (Post-Migration)

```sql
-- Verify new columns exist
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN (
    'location_country', 'location_state', 'location_city',
    'location_formatted', 'location_lat', 'location_lng', 'location_place_id'
  )
ORDER BY column_name;

-- Verify no existing data was altered
SELECT COUNT(*) as total_users,
       COUNT(location) as has_legacy_location,
       COUNT(location_id) as has_legacy_location_id,
       COUNT(location_formatted) as has_new_location  -- should be 0 until onboarding runs
FROM users;

-- Verify indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'users'
  AND indexname IN ('idx_users_location_country', 'idx_users_location_city');
```
