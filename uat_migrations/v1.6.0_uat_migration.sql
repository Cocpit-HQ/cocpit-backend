-- ==============================================================================
-- UAT Migration v1.6.0
-- Target Database: cocpit_backend_uat
-- Prepared Date:  2026-10-17
-- Description: Brings UAT database schema into alignment with Staging for v1.6.0 features
--              (Business Profile, Organization Location, International Phone Support)
--
-- Changes Included:
--   1. organizations: Add location columns (location_formatted, location_lat, location_lng,
--      location_place_id) + spatial index idx_organizations_location_coords
--   2. organizations.headline: Expand from VARCHAR(200) to VARCHAR(255) with full
--      dependent-view drop/recreate cycle
--   3. users & organizations: Add country_code for international phone numbers
--   4. users.mobile_format constraint: Relax from strict 10-digit to nullable 7-15 digits
--   5. event_registrations.mobile_format constraint: Same relaxation as users
--   6. user_search_history: Add org_id column for Business Profile actor isolation
--      + replace legacy indexes with actor-aware ones (SCRUM-1039)
--   7. feature_flags: Insert Teams Module feature flags ('enableTeamsModule', 'enableTeams', 'teams')
--   8. feature_flags: Insert Org Settings, Org Analytics, and Org Notifications feature flags
--
-- Database Changes Made By (Staging):
--   - Shubham Hindurao Patil <Sp6698@github.com>
--       PR #501 Feature/org onbording: Added location columns to organizations
--   - Sanika Mane <sanikamane0106@gmail.com>
--       PR #504 Bugfix/sanika 10 10 26: Expanded organizations.headline to VARCHAR(255),
--         view recreations (migration_expand_org_headline_255.sql)
--       PR #522: Relaxed mobile_format constraint on users + event_registrations
--       Teams Module: Feature flags for teams module ('enableTeamsModule', 'enableTeams', 'teams')
--       PR #524: Feature flags for Org Settings, Org Analytics, and Org Notifications
--   - Harshada Babasaheb Khot <harshadakhot14@gmail.com>
--       PR #509: Added org_id to user_search_history, actor-aware indexes (SCRUM-1039)
--
-- Merged into develop by:
--   - Swaroop Manade <SwaroopManade@github.com> (PRs #501, #504, #509, #514, #515,
--       #517, #519, #520, #522, #524 merged into develop)
-- ==============================================================================


-- ==============================================================================
-- PART 1: Add location columns to organizations table
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
-- PART 2: Expand organizations.headline from VARCHAR(200) to VARCHAR(255)
-- Note: Requires dropping dependent views and recreating them after column change.
-- ==============================================================================

BEGIN;

-- 1. Drop all views that depend on organizations.headline
DROP VIEW IF EXISTS active_post_likes CASCADE;
DROP VIEW IF EXISTS active_post_comments CASCADE;
DROP VIEW IF EXISTS active_comment_likes CASCADE;
DROP VIEW IF EXISTS active_organizations CASCADE;
DROP VIEW IF EXISTS organization_display_profiles CASCADE;

-- 2. Alter column
ALTER TABLE organizations ALTER COLUMN headline TYPE VARCHAR(255);

-- 3. Recreate active_organizations view
CREATE OR REPLACE VIEW active_organizations AS
SELECT * FROM organizations
WHERE (is_deleted IS FALSE OR is_deleted IS NULL)
  AND (is_suspended IS FALSE OR is_suspended IS NULL)
  AND (is_deactivated IS FALSE OR is_deactivated IS NULL);

-- 4. Recreate organization_display_profiles view
CREATE OR REPLACE VIEW organization_display_profiles AS
SELECT
    org_id,
    CASE
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN name
        ELSE 'Deleted Page'
    END AS name,
    CASE
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN slug
        ELSE 'deleted_page'
    END AS slug,
    CASE
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN logo_url
        ELSE NULL
    END AS logo_url,
    CASE
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN headline
        ELSE 'This page has been deactivated'
    END AS headline,
    entity_type
FROM organizations;

-- 5. Recreate active_post_likes view
CREATE OR REPLACE VIEW active_post_likes AS
SELECT pl.*
FROM post_likes pl
LEFT JOIN active_users au ON au.user_id = pl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = pl.org_id
WHERE (pl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

-- 6. Recreate active_post_comments view (preserving is_edited and updated_at)
CREATE OR REPLACE VIEW active_post_comments AS
SELECT pc.*
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);

-- 7. Recreate active_comment_likes view
CREATE OR REPLACE VIEW active_comment_likes AS
SELECT cl.*
FROM comment_likes cl
LEFT JOIN active_users au ON au.user_id = cl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = cl.org_id
WHERE (cl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (cl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

COMMIT;


-- ==============================================================================
-- PART 3: Add country_code for international phone numbers
-- ==============================================================================

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10);

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10);

COMMIT;


-- ==============================================================================
-- PART 4: Relax mobile_format constraint on users table
-- Supports international phone numbers (7 to 15 digits), nullable
-- ==============================================================================

BEGIN;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS mobile_format;

ALTER TABLE users
    ADD CONSTRAINT mobile_format CHECK (mobile_number IS NULL OR mobile_number ~ '^[0-9]{7,15}$');

COMMIT;


-- ==============================================================================
-- PART 5: Relax mobile_format constraint on event_registrations table
-- ==============================================================================

BEGIN;

ALTER TABLE event_registrations
    DROP CONSTRAINT IF EXISTS mobile_format;

ALTER TABLE event_registrations
    ADD CONSTRAINT mobile_format CHECK (mobile_number IS NULL OR mobile_number ~ '^[0-9]{7,15}$');

COMMIT;


-- ==============================================================================
-- PART 6: Isolate user_search_history by actor (Personal vs Business Profile)
-- Jira: SCRUM-1039 (Parent: SCRUM-114 Business Profile)
-- ==============================================================================

BEGIN;

-- 1. Add org_id column referencing organizations
ALTER TABLE user_search_history
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- 2. Drop legacy single-user unique index
DROP INDEX IF EXISTS uq_user_search_history_user_query;


-- 3. Drop legacy composite lookup index (replaced below)
DROP INDEX IF EXISTS idx_user_search_history_user_created;

-- 4. Create actor-aware unique index supporting NULL org_id via COALESCE
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_search_history_actor_query
ON user_search_history (
    user_id,
    COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    query_normalized
);

-- 5. Create composite lookup index for performance
CREATE INDEX IF NOT EXISTS idx_user_search_history_actor_created
ON user_search_history (user_id, org_id, created_at DESC);

COMMIT;


-- ==============================================================================
-- PART 7: Teams Module Feature Flags
-- Adds feature flags required for Teams Module functionality in UAT
-- ==============================================================================

BEGIN;

INSERT INTO feature_flags (flag_key, is_enabled, updated_at)
VALUES
  ('enableTeamsModule', TRUE, now()),
  ('enableTeams', TRUE, now()),
  ('teams', TRUE, now())
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;


-- ==============================================================================
-- PART 8: Org Settings, Org Analytics, Org Notifications Feature Flags
-- Adds feature flags required for Org management modules in UAT
-- ==============================================================================

BEGIN;

INSERT INTO feature_flags (flag_key, is_enabled, updated_at)
VALUES
  ('enableOrgSettingsModule', TRUE, now()),
  ('enableOrgSettings', TRUE, now()),
  ('orgSettings', TRUE, now()),
  ('enableOrgAnalyticsModule', TRUE, now()),
  ('enableOrgAnalytics', TRUE, now()),
  ('orgAnalytics', TRUE, now()),
  ('enableOrgNotificationsModule', TRUE, now()),
  ('enableOrgNotifications', TRUE, now()),
  ('orgNotifications', TRUE, now())
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
