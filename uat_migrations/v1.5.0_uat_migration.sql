-- ==============================================================================
-- UAT Migration v1.5.0
-- Target Database: cocpit_backend_uat
-- Description: Brings UAT database schema into alignment with Staging for recent features
-- Changes Included:
--   1. users & organizations: Add country_code for international phone numbers
-- ==============================================================================

BEGIN;

-- 1. Add country_code for international phone numbers
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10);

ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10);

COMMIT;


