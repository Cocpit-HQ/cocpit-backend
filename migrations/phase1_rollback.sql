-- ============================================================
-- PHASE 1 ROLLBACK: Reverse Organization Abstraction
-- Reverses all renames from phase1_org_abstraction.sql
-- ============================================================

BEGIN;

-- Drop entity_type column
ALTER TABLE organizations DROP COLUMN IF EXISTS entity_type;

-- Reverse column renames (do BEFORE table renames)
ALTER TABLE organizations RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_roles RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_members RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_invites RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_verifications RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_followers RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_connections RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_connection_requests RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_gallery RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_tech_stack RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_notification_preferences RENAME COLUMN org_id TO company_id;
ALTER TABLE organization_chat_sessions RENAME COLUMN org_id TO company_id;

-- Content tables
ALTER TABLE posts RENAME COLUMN author_org_id TO author_company_id;
ALTER TABLE post_likes RENAME COLUMN org_id TO company_id;
ALTER TABLE post_comments RENAME COLUMN author_org_id TO author_company_id;
ALTER TABLE comment_likes RENAME COLUMN org_id TO company_id;

-- Stories
ALTER TABLE stories RENAME COLUMN author_org_id TO author_company_id;
ALTER TABLE story_views RENAME COLUMN viewer_org_id TO viewer_company_id;
ALTER TABLE story_reactions RENAME COLUMN reactor_org_id TO reactor_company_id;
ALTER TABLE story_comments RENAME COLUMN author_org_id TO author_company_id;

-- Notifications
ALTER TABLE notifications RENAME COLUMN recipient_org_id TO recipient_company_id;

-- Messaging
ALTER TABLE messages RENAME COLUMN author_org_id TO author_company_id;
ALTER TABLE conversation_participants RENAME COLUMN org_id TO company_id;

-- Jobs & Events
ALTER TABLE jobs RENAME COLUMN org_id TO company_id;
ALTER TABLE events RENAME COLUMN org_id TO company_id;
ALTER TABLE job_offers RENAME COLUMN org_id TO company_id;

-- Reverse table renames
ALTER TABLE organizations RENAME TO companies;
ALTER TABLE organization_roles RENAME TO company_roles;
ALTER TABLE organization_members RENAME TO company_members;
ALTER TABLE organization_invites RENAME TO company_invites;
ALTER TABLE organization_verifications RENAME TO company_verifications;
ALTER TABLE organization_followers RENAME TO company_followers;
ALTER TABLE organization_connections RENAME TO company_connections;
ALTER TABLE organization_connection_requests RENAME TO company_connection_requests;
ALTER TABLE organization_gallery RENAME TO company_gallery;
ALTER TABLE organization_tech_stack RENAME TO company_tech_stack;
ALTER TABLE organization_notification_preferences RENAME TO company_notification_preferences;
ALTER TABLE organization_chat_sessions RENAME TO company_chat_sessions;

-- Reverse index renames
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_organizations_slug') THEN
        ALTER INDEX idx_organizations_slug RENAME TO idx_companies_slug;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_organizations_website') THEN
        ALTER INDEX idx_organizations_website RENAME TO idx_companies_website;
    END IF;
END $$;

COMMIT;
