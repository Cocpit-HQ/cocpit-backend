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


-- ==============================================================================
-- UAT Migration v1.5.0 (Organizations Location & Mapping Support)
-- Target Database: cocpit_backend_uat
-- Description: Adds location coordinates, formatted address, and Google Place ID
--              to organizations table to support map rendering and geospatial features.
-- ==============================================================================

BEGIN;

ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS location_formatted TEXT,
    ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_place_id TEXT;

CREATE INDEX IF NOT EXISTS idx_organizations_location_coords 
    ON organizations(location_lat, location_lng) 
    WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

COMMIT;

-- ==============================================================================
-- UAT Migration v1.5.0 (International Phone Number Support 7-15 Digits)
-- Target Database: cocpit_backend_uat
-- Description: Updates users check constraint mobile_format to support 7 to 15 digits
-- ==============================================================================

BEGIN;

ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS mobile_format;

ALTER TABLE users 
    ADD CONSTRAINT mobile_format CHECK (mobile_number IS NULL OR mobile_number ~ '^[0-9]{7,15}$');

COMMIT;
