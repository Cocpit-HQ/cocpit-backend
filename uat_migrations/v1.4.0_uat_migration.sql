-- ==============================================================================
-- UAT Migration v1.4.0 (Experience Roles Update)
-- Target Database: cocpit_backend_uat
-- Description: Brings UAT database schema into alignment with Staging for the Experience Feature
-- Changes Included:
--   1. Drop `idx_one_current_role_per_company` to allow multiple current roles at the same company
-- ==============================================================================

BEGIN;

-- 1. Drop the unique index that prevents a user from having multiple active roles at the same company
-- This is necessary to support the new promotion/multiple-role grouping feature.
DROP INDEX IF EXISTS idx_one_current_role_per_company;

COMMIT;
