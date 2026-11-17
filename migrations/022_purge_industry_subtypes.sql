-- 022_purge_industry_subtypes.sql
-- Purges sub-type hierarchy from industries_master and organizations per product requirement.
-- Industries will be flat, with no sub-types.

BEGIN;

-- 1. Drop index on industries_master.parent_id if exists
DROP INDEX IF EXISTS idx_industries_master_parent_id;

-- 2. Drop parent_id and display_order columns from industries_master
ALTER TABLE industries_master
  DROP COLUMN IF EXISTS parent_id CASCADE,
  DROP COLUMN IF EXISTS display_order CASCADE;

-- 3. Drop index on organizations.industry_sub_type_id if exists
DROP INDEX IF EXISTS idx_organizations_industry_sub_type_id;

-- 4. Drop industry_sub_type_id column from organizations
-- NOTE: Dropping a column on organizations with CASCADE causes PostgreSQL
-- to automatically drop dependent views: active_organizations, organization_display_profiles,
-- active_post_likes, active_post_comments, active_comment_likes.
-- We must recreate them immediately.
ALTER TABLE organizations
  DROP COLUMN IF EXISTS industry_sub_type_id CASCADE;

-- 5. Recreate active_organizations view
CREATE OR REPLACE VIEW active_organizations AS 
SELECT * FROM organizations 
WHERE (is_deleted IS FALSE OR is_deleted IS NULL) 
  AND (is_suspended IS FALSE OR is_suspended IS NULL) 
  AND (is_deactivated IS FALSE OR is_deactivated IS NULL);

-- 6. Recreate organization_display_profiles view
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

-- 7. Recreate active views for likes and comments
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
