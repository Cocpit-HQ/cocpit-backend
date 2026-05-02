-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Experience data integrity constraints
-- Run this once against your PostgreSQL database.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Clean up any existing corrupt rows where end_date < start_date.
-- Sets their end_date to NULL so they appear as "Present" rather than showing
-- inverted dates. These rows need manual review by the user afterward.
UPDATE experiences
SET end_date = NULL,
    is_current = true
WHERE end_date IS NOT NULL
  AND end_date < start_date;

-- Step 2: Add CHECK constraint to prevent future corrupt rows.
-- Uses >= so that same-day entries (start == end) are also rejected.
ALTER TABLE experiences
    ADD CONSTRAINT chk_experience_date_range
    CHECK (end_date IS NULL OR end_date >= start_date);

-- Step 3: Deduplicate multiple is_current=true rows for the same company.
-- Keeps the role with the latest start_date as current.
-- Sets all older duplicates to is_current=false and assigns an end_date
-- equal to the start_date of the newer role at the same company.
WITH ranked AS (
    SELECT
        experience_id,
        profile_id,
        LOWER(TRIM(company_name)) AS company_norm,
        start_date,
        ROW_NUMBER() OVER (
            PARTITION BY profile_id, LOWER(TRIM(company_name))
            ORDER BY start_date DESC
        ) AS rn
    FROM experiences
    WHERE is_current = true
),
duplicates AS (
    SELECT r.experience_id, r.profile_id, r.company_norm
    FROM ranked r
    WHERE r.rn > 1  -- all but the most recent current role per company
)
UPDATE experiences e
SET
    is_current = false,
    -- end_date = start_date of the newest current role at the same company
    end_date = (
        SELECT MIN(e2.start_date)
        FROM experiences e2
        WHERE e2.profile_id = e.profile_id
          AND LOWER(TRIM(e2.company_name)) = LOWER(TRIM(e.company_name))
          AND e2.is_current = true
          AND e2.experience_id != e.experience_id
    )
FROM duplicates d
WHERE e.experience_id = d.experience_id;

-- Step 4: Now the table is clean. Create the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_role_per_company
    ON experiences (profile_id, LOWER(TRIM(company_name)))
    WHERE is_current = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run after applying migration to confirm state)
-- ─────────────────────────────────────────────────────────────────────────────

-- Should return 0 rows after the UPDATE above:
-- SELECT * FROM experiences WHERE end_date IS NOT NULL AND end_date < start_date;

-- Shows any profiles with multiple current roles per company (should be 0):
-- SELECT profile_id, LOWER(TRIM(company_name)) as company, COUNT(*) as active_roles
-- FROM experiences
-- WHERE is_current = true
-- GROUP BY profile_id, LOWER(TRIM(company_name))
-- HAVING COUNT(*) > 1;
