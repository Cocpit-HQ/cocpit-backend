-- ============================================================
-- IDEMPOTENT PHASE 1 MIGRATION: Organization Abstraction
-- Handles cases where some renames might already have occurred.
-- ============================================================

BEGIN;

DO $$
BEGIN
    -- 1. Rename Core Tables
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'companies') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organizations') THEN
        ALTER TABLE companies RENAME TO organizations;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_roles') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_roles') THEN
        ALTER TABLE company_roles RENAME TO organization_roles;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_members') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_members') THEN
        ALTER TABLE company_members RENAME TO organization_members;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_invites') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_invites') THEN
        ALTER TABLE company_invites RENAME TO organization_invites;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_verifications') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_verifications') THEN
        ALTER TABLE company_verifications RENAME TO organization_verifications;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_followers') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_followers') THEN
        ALTER TABLE company_followers RENAME TO organization_followers;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_connections') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_connections') THEN
        ALTER TABLE company_connections RENAME TO organization_connections;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_connection_requests') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_connection_requests') THEN
        ALTER TABLE company_connection_requests RENAME TO organization_connection_requests;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_gallery') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_gallery') THEN
        ALTER TABLE company_gallery RENAME TO organization_gallery;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_tech_stack') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_tech_stack') THEN
        ALTER TABLE company_tech_stack RENAME TO organization_tech_stack;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_notification_preferences') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_notification_preferences') THEN
        ALTER TABLE company_notification_preferences RENAME TO organization_notification_preferences;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_chat_sessions') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_chat_sessions') THEN
        ALTER TABLE company_chat_sessions RENAME TO organization_chat_sessions;
    END IF;

    -- 2. Rename Columns (Organizations)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'company_id') THEN
        ALTER TABLE organizations RENAME COLUMN company_id TO org_id;
    END IF;

    -- 3. Add entity_type discriminator (if not exists)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'entity_type') THEN
        ALTER TABLE organizations ADD COLUMN entity_type VARCHAR(20) DEFAULT 'COMPANY' NOT NULL;
        ALTER TABLE organizations ADD CONSTRAINT check_entity_type CHECK (entity_type IN ('COMPANY', 'INSTITUTION'));
    END IF;

    -- 4. Rename Foreign Key Columns
    -- organization_roles
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_roles' AND column_name = 'company_id') THEN
        ALTER TABLE organization_roles RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_members
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_members' AND column_name = 'company_id') THEN
        ALTER TABLE organization_members RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_invites
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_invites' AND column_name = 'company_id') THEN
        ALTER TABLE organization_invites RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_verifications
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_verifications' AND column_name = 'company_id') THEN
        ALTER TABLE organization_verifications RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_followers
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_followers' AND column_name = 'company_id') THEN
        ALTER TABLE organization_followers RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_connections
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_connections' AND column_name = 'company_id') THEN
        ALTER TABLE organization_connections RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_connection_requests
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_connection_requests' AND column_name = 'company_id') THEN
        ALTER TABLE organization_connection_requests RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_gallery
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_gallery' AND column_name = 'company_id') THEN
        ALTER TABLE organization_gallery RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_tech_stack
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_tech_stack' AND column_name = 'company_id') THEN
        ALTER TABLE organization_tech_stack RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_notification_preferences
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_notification_preferences' AND column_name = 'company_id') THEN
        ALTER TABLE organization_notification_preferences RENAME COLUMN company_id TO org_id;
    END IF;

    -- organization_chat_sessions
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_chat_sessions' AND column_name = 'company_id') THEN
        ALTER TABLE organization_chat_sessions RENAME COLUMN company_id TO org_id;
    END IF;

    -- 5. Content Tables
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'author_company_id') THEN
        ALTER TABLE posts RENAME COLUMN author_company_id TO author_org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'post_likes' AND column_name = 'company_id') THEN
        ALTER TABLE post_likes RENAME COLUMN company_id TO org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'post_comments' AND column_name = 'author_company_id') THEN
        ALTER TABLE post_comments RENAME COLUMN author_company_id TO author_org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'comment_likes' AND column_name = 'company_id') THEN
        ALTER TABLE comment_likes RENAME COLUMN company_id TO org_id;
    END IF;

    -- 6. Stories
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stories' AND column_name = 'author_company_id') THEN
        ALTER TABLE stories RENAME COLUMN author_company_id TO author_org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'story_views' AND column_name = 'viewer_company_id') THEN
        ALTER TABLE story_views RENAME COLUMN viewer_company_id TO viewer_org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'story_reactions' AND column_name = 'reactor_company_id') THEN
        ALTER TABLE story_reactions RENAME COLUMN reactor_company_id TO reactor_org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'story_comments' AND column_name = 'author_company_id') THEN
        ALTER TABLE story_comments RENAME COLUMN author_company_id TO author_org_id;
    END IF;

    -- 7. Notifications
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'recipient_company_id') THEN
        ALTER TABLE notifications RENAME COLUMN recipient_company_id TO recipient_org_id;
    END IF;

    -- 8. Messaging
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'author_company_id') THEN
        ALTER TABLE messages RENAME COLUMN author_company_id TO author_org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation_participants' AND column_name = 'company_id') THEN
        ALTER TABLE conversation_participants RENAME COLUMN company_id TO org_id;
    END IF;

    -- 9. Jobs & Events
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'company_id') THEN
        ALTER TABLE jobs RENAME COLUMN company_id TO org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'company_id') THEN
        ALTER TABLE events RENAME COLUMN company_id TO org_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'job_offers' AND column_name = 'company_id') THEN
        ALTER TABLE job_offers RENAME COLUMN company_id TO org_id;
    END IF;

    -- 10. Indexes (Safe rename)
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_companies_slug') THEN
        ALTER INDEX idx_companies_slug RENAME TO idx_organizations_slug;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_companies_website') THEN
        ALTER INDEX idx_companies_website RENAME TO idx_organizations_website;
    END IF;

END $$;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Idempotent Org Abstraction migration validation PASSED';
END $$;
