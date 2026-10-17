-- =============================================================================
-- ONE-OFF PATCH: Add missing columns to warnings tables
-- Description: The original UAT migration script (20260921_post_1.2.0_uat_schema_changes.sql) 
-- used CREATE TABLE IF NOT EXISTS, which skipped adding 'message' and 'is_severe' 
-- because the tables already existed. This script manually appends them.
-- =============================================================================

BEGIN;

ALTER TABLE user_warnings 
ADD COLUMN IF NOT EXISTS message TEXT, 
ADD COLUMN IF NOT EXISTS is_severe BOOLEAN DEFAULT FALSE;

ALTER TABLE organization_warnings 
ADD COLUMN IF NOT EXISTS message TEXT, 
ADD COLUMN IF NOT EXISTS is_severe BOOLEAN DEFAULT FALSE;

COMMIT;
