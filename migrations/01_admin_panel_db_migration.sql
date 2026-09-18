-- =============================================================================
-- MIGRATION SCRIPT 1: For Admin Panel Database (cocpit_admin_panel)
-- Description: Adds all missing tables, columns, and views from schema.sql & uat_schema.sql
-- Run target: DB_NAME=cocpit_admin_panel
-- Safety: Fully idempotent (uses IF NOT EXISTS and DROP/CREATE OR REPLACE VIEW)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. MISSING TABLES & VIEWS
-- -----------------------------------------------------------------------------

-- 1.1 user_post_feedback (Feed interaction: INTERESTED / NOT_INTERESTED)
CREATE TABLE IF NOT EXISTS user_post_feedback (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
    feedback_type VARCHAR(20) NOT NULL CHECK (feedback_type IN ('INTERESTED', 'NOT_INTERESTED')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);

-- 1.2 user_search_history (Persistent recent search tracking)
CREATE TABLE IF NOT EXISTS user_search_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    query_text TEXT NOT NULL,
    query_normalized TEXT NOT NULL,
    profile_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_search_history_user_created ON user_search_history(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_search_history_user_query ON user_search_history(user_id, query_normalized);

-- 1.3 deletion_batches (Account deletion batching)
CREATE TABLE IF NOT EXISTS deletion_batches (
    batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT now(),
    executed_at TIMESTAMPTZ
);

-- 1.4 organization_restoration_tokens
CREATE TABLE IF NOT EXISTS organization_restoration_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. MISSING COLUMNS
-- -----------------------------------------------------------------------------

-- 2.1 organizations
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE,
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_execute_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_batch_id UUID REFERENCES deletion_batches(batch_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- 2.2 users
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS dob DATE,
    ADD COLUMN IF NOT EXISTS deletion_batch_id UUID REFERENCES deletion_batches(batch_id) ON DELETE SET NULL;

-- 2.3 post_media
ALTER TABLE post_media
    ADD COLUMN IF NOT EXISTS width INT,
    ADD COLUMN IF NOT EXISTS height INT;

-- 2.4 post_comments
ALTER TABLE post_comments
    ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- 2.5 email_otps
ALTER TABLE email_otps
    ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(100) NOT NULL DEFAULT 'signup';

ALTER TABLE email_otps 
    DROP CONSTRAINT IF EXISTS unique_email_otp,
    DROP CONSTRAINT IF EXISTS unique_email_otp_purpose;

ALTER TABLE email_otps 
    ADD CONSTRAINT unique_email_otp_purpose UNIQUE (email, purpose);

-- 2.6 organization_verifications
ALTER TABLE organization_verifications
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE;

-- 2.7 user_verifications
ALTER TABLE user_verifications
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(100);

-- 2.8 user_notification_preferences
ALTER TABLE user_notification_preferences
    ADD COLUMN IF NOT EXISTS profile_notifications BOOLEAN DEFAULT TRUE;

-- -----------------------------------------------------------------------------
-- 3. RECREATING VIEWS
-- -----------------------------------------------------------------------------

DROP VIEW IF EXISTS active_post_comments CASCADE;

CREATE VIEW active_post_comments AS
SELECT 
    pc.comment_id,
    pc.post_id,
    pc.author_id,
    pc.content,
    pc.created_at,
    pc.parent_id,
    pc.is_pinned,
    pc.pinned_at,
    pc.pinned_by,
    pc.author_org_id,
    pc.pinned_by_org_id,
    pc.updated_at,
    pc.is_edited,
    pc.is_deleted
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);

COMMIT;
