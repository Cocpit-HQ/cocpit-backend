-- ============================================================
-- PHASE 1 MIGRATION: Organization Abstraction
-- Safe, metadata-only renames. Zero data movement.
-- Run inside a transaction. Rollback script: phase1_rollback.sql
-- ============================================================

BEGIN;

-- ==========================================
-- STEP 1: Rename Core Tables
-- ==========================================

ALTER TABLE companies RENAME TO organizations;
ALTER TABLE company_roles RENAME TO organization_roles;
ALTER TABLE company_members RENAME TO organization_members;
ALTER TABLE company_invites RENAME TO organization_invites;
ALTER TABLE company_verifications RENAME TO organization_verifications;
ALTER TABLE company_followers RENAME TO organization_followers;
ALTER TABLE company_connections RENAME TO organization_connections;
ALTER TABLE company_connection_requests RENAME TO organization_connection_requests;
ALTER TABLE company_gallery RENAME TO organization_gallery;
ALTER TABLE company_tech_stack RENAME TO organization_tech_stack;
ALTER TABLE company_notification_preferences RENAME TO organization_notification_preferences;
ALTER TABLE company_chat_sessions RENAME TO organization_chat_sessions;

-- ==========================================
-- STEP 2: Rename Primary Key Column (organizations)
-- ==========================================

ALTER TABLE organizations RENAME COLUMN company_id TO org_id;

-- ==========================================
-- STEP 3: Add entity_type discriminator column
-- ==========================================

ALTER TABLE organizations 
ADD COLUMN entity_type VARCHAR(20) DEFAULT 'COMPANY' NOT NULL
CHECK (entity_type IN ('COMPANY', 'INSTITUTION'));

-- ==========================================
-- STEP 4: Rename Foreign Key Columns (all related tables)
-- ==========================================

-- organization_roles
ALTER TABLE organization_roles RENAME COLUMN company_id TO org_id;

-- organization_members
ALTER TABLE organization_members RENAME COLUMN company_id TO org_id;

-- organization_invites
ALTER TABLE organization_invites RENAME COLUMN company_id TO org_id;

-- organization_verifications
ALTER TABLE organization_verifications RENAME COLUMN company_id TO org_id;

-- organization_followers
ALTER TABLE organization_followers RENAME COLUMN company_id TO org_id;

-- organization_connections
ALTER TABLE organization_connections RENAME COLUMN company_id TO org_id;

-- organization_connection_requests
ALTER TABLE organization_connection_requests RENAME COLUMN company_id TO org_id;

-- organization_gallery
ALTER TABLE organization_gallery RENAME COLUMN company_id TO org_id;

-- organization_tech_stack
ALTER TABLE organization_tech_stack RENAME COLUMN company_id TO org_id;

-- organization_notification_preferences
ALTER TABLE organization_notification_preferences RENAME COLUMN company_id TO org_id;

-- organization_chat_sessions
ALTER TABLE organization_chat_sessions RENAME COLUMN company_id TO org_id;

-- ==========================================
-- STEP 5: Rename Columns in Content Tables
-- ==========================================

-- Posts
ALTER TABLE posts RENAME COLUMN author_company_id TO author_org_id;

-- Post likes
ALTER TABLE post_likes RENAME COLUMN company_id TO org_id;

-- Comments
ALTER TABLE post_comments RENAME COLUMN author_company_id TO author_org_id;

-- Comment likes
ALTER TABLE comment_likes RENAME COLUMN company_id TO org_id;

-- ==========================================
-- STEP 6: Rename Columns in Stories Tables
-- ==========================================

ALTER TABLE stories RENAME COLUMN author_company_id TO author_org_id;
ALTER TABLE story_views RENAME COLUMN viewer_company_id TO viewer_org_id;
ALTER TABLE story_reactions RENAME COLUMN reactor_company_id TO reactor_org_id;
ALTER TABLE story_comments RENAME COLUMN author_company_id TO author_org_id;

-- ==========================================
-- STEP 7: Rename Columns in Notifications
-- ==========================================

ALTER TABLE notifications RENAME COLUMN recipient_company_id TO recipient_org_id;

-- ==========================================
-- STEP 8: Rename Columns in Messaging
-- ==========================================

ALTER TABLE messages RENAME COLUMN author_company_id TO author_org_id;
ALTER TABLE conversation_participants RENAME COLUMN company_id TO org_id;

-- ==========================================
-- STEP 9: Rename Columns in Jobs & Events
-- ==========================================

ALTER TABLE jobs RENAME COLUMN company_id TO org_id;
ALTER TABLE events RENAME COLUMN company_id TO org_id;
ALTER TABLE job_offers RENAME COLUMN company_id TO org_id;

-- ==========================================
-- STEP 10: Rename Key Indexes (for clarity)
-- ==========================================

-- Only rename explicitly-named indexes. Auto-generated ones follow automatically.
DO $$
BEGIN
    -- Safely rename indexes if they exist
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_companies_slug') THEN
        ALTER INDEX idx_companies_slug RENAME TO idx_organizations_slug;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_companies_website') THEN
        ALTER INDEX idx_companies_website RENAME TO idx_organizations_website;
    END IF;
END $$;

-- ==========================================
-- VALIDATION
-- ==========================================

-- Verify the organizations table exists with entity_type
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'organizations' AND column_name = 'entity_type'
    ) THEN
        RAISE EXCEPTION 'Migration validation failed: entity_type column not found';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'organizations' AND column_name = 'org_id'
    ) THEN
        RAISE EXCEPTION 'Migration validation failed: org_id column not found';
    END IF;
    
    RAISE NOTICE 'Phase 1 migration validation PASSED';
END $$;

COMMIT;
