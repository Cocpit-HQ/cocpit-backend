-- =========================================================================
-- MIGRATION: Expand organizations.headline to VARCHAR(255)
-- =========================================================================
-- Reason: Onboarding Stage 2 and UI allow up to 255 characters for headline.
-- Due to PostgreSQL view dependencies, dependent views are dropped and recreated.
-- =========================================================================

BEGIN;

-- 1. Drop dependent views
DROP VIEW IF EXISTS active_post_likes CASCADE;
DROP VIEW IF EXISTS active_post_comments CASCADE;
DROP VIEW IF EXISTS active_comment_likes CASCADE;
DROP VIEW IF EXISTS active_organizations CASCADE;
DROP VIEW IF EXISTS organization_display_profiles CASCADE;

-- 2. Alter column type to VARCHAR(255)
ALTER TABLE organizations ALTER COLUMN headline TYPE VARCHAR(255);

-- 3. Recreate active_organizations
CREATE OR REPLACE VIEW active_organizations AS 
SELECT * FROM organizations 
WHERE (is_deleted IS FALSE OR is_deleted IS NULL) 
  AND (is_suspended IS FALSE OR is_suspended IS NULL) 
  AND (is_deactivated IS FALSE OR is_deactivated IS NULL);

-- 4. Recreate organization_display_profiles
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

-- 5. Recreate active views for likes and comments
CREATE OR REPLACE VIEW active_post_likes AS
SELECT pl.* 
FROM post_likes pl
LEFT JOIN active_users au ON au.user_id = pl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = pl.org_id
WHERE (pl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

CREATE OR REPLACE VIEW active_post_comments AS
SELECT pc.*
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);

CREATE OR REPLACE VIEW active_comment_likes AS
SELECT cl.*
FROM comment_likes cl
LEFT JOIN active_users au ON au.user_id = cl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = cl.org_id
WHERE (cl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (cl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

COMMIT;
