-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Backfill institution_type for existing INSTITUTION orgs
--
-- Before this fix, publishNewOrganization and updateOrgProfile both wrote the
-- Stage 1 "type" dropdown value (School/College/University/Coaching/Tuition)
-- into the generic `industry` column for every org, including institutions.
-- The dedicated `institution_type` column was always left NULL for institutes
-- created through the live onboarding wizard.
--
-- This is idempotent — it only touches rows still in the broken state, so it's
-- safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE organizations
SET institution_type = LOWER(TRIM(industry)),
    industry = NULL
WHERE entity_type = 'INSTITUTION'
  AND institution_type IS NULL
  AND industry IS NOT NULL
  AND TRIM(industry) != '';
