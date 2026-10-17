-- =============================================================================
-- MIGRATION SCRIPT: Post 1.2.0 UAT Schema Changes
-- Description: Aggregates all new tables, columns, and views introduced after 
--              the UAT 1.2.0 release (from 01_admin_panel_db_migration.sql, 
--              02_og_backend_db_migration.sql, and 03_feature_flags_table.sql)
-- Safety: Fully idempotent (uses IF NOT EXISTS and DROP/CREATE OR REPLACE VIEW)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. ADMIN PANEL & MODERATION TABLES (from 02_og_backend_db_migration.sql)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_panel_users (
    admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    role VARCHAR(50) NOT NULL DEFAULT 'MODERATOR' CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'SUPPORT')),
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES admin_panel_users(admin_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_actions (
    action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type VARCHAR(50) NOT NULL CHECK (target_type IN ('USER', 'ORGANIZATION', 'POST', 'COMMENT', 'JOB')),
    target_id UUID NOT NULL,
    action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('WARNING', 'SUSPENSION', 'BAN', 'CONTENT_REMOVAL', 'RESTORE')),
    reason TEXT NOT NULL,
    duration_days INT,
    performed_by UUID REFERENCES admin_panel_users(admin_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeal_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id UUID REFERENCES moderation_actions(action_id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_appeals (
    appeal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID REFERENCES appeal_tokens(token_id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    action_id UUID REFERENCES moderation_actions(action_id) ON DELETE CASCADE,
    appeal_reason TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    reviewed_by UUID REFERENCES admin_panel_users(admin_id) ON DELETE SET NULL,
    review_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS post_appeals (
    appeal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    reviewed_by UUID REFERENCES admin_panel_users(admin_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_warnings (
    warning_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    message TEXT,
    is_severe BOOLEAN DEFAULT FALSE,
    issued_by UUID REFERENCES admin_panel_users(admin_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_warnings (
    warning_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    message TEXT,
    is_severe BOOLEAN DEFAULT FALSE,
    issued_by UUID REFERENCES admin_panel_users(admin_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_security_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_replies (
    reply_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL,
    sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('USER', 'ADMIN')),
    sender_id UUID NOT NULL,
    message TEXT NOT NULL,
    attachments JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. SYSTEM MONITORING TABLES (from 02_og_backend_db_migration.sql)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS background_tasks (
    task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    payload JSONB,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
    deployment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version VARCHAR(50) NOT NULL,
    environment VARCHAR(50) NOT NULL DEFAULT 'production',
    deployed_by VARCHAR(100),
    status VARCHAR(50) NOT NULL DEFAULT 'SUCCESS',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_alerts (
    alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level VARCHAR(20) NOT NULL CHECK (level IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
    component VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    is_resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slow_queries (
    query_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_text TEXT NOT NULL,
    duration_ms INT NOT NULL,
    called_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    ip_address VARCHAR(45),
    device_info TEXT,
    last_activity_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 3. DELETION AND RESTORATION TABLES (from 01_admin_panel_db_migration.sql)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deletion_batches (
    batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT now(),
    executed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS organization_restoration_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 4. FEATURE FLAGS (from 03_feature_flags_table.sql)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS feature_flags (
    flag_key VARCHAR(100) PRIMARY KEY,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 5. NEW COLUMNS TO EXISTING TABLES (from 01 & 02 migrations)
-- -----------------------------------------------------------------------------

-- user_warnings table columns
ALTER TABLE user_warnings
    ADD COLUMN IF NOT EXISTS message TEXT,
    ADD COLUMN IF NOT EXISTS is_severe BOOLEAN DEFAULT FALSE;

-- organization_warnings table columns
ALTER TABLE organization_warnings
    ADD COLUMN IF NOT EXISTS message TEXT,
    ADD COLUMN IF NOT EXISTS is_severe BOOLEAN DEFAULT FALSE;


-- users table columns
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deletion_batch_id UUID REFERENCES deletion_batches(batch_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS acquisition_source VARCHAR(100),
    ADD COLUMN IF NOT EXISTS user_type VARCHAR(50) DEFAULT 'INDIVIDUAL',
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS moderation_flags INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS suspension_count INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- organizations table columns
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_execute_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_batch_id UUID REFERENCES deletion_batches(batch_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS onboarding_stage VARCHAR(50) DEFAULT 'COMPLETED',
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS moderation_flags INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS suspension_count INT DEFAULT 0;

-- posts table columns
ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS is_unlisted BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- post_comments table columns
ALTER TABLE post_comments
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- jobs table columns
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(50) DEFAULT 'APPROVED',
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- organization_documents table columns
ALTER TABLE organization_documents
    ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- organization_connection_requests table columns
ALTER TABLE organization_connection_requests
    ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- reports table columns
ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS reason TEXT,
    ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'MEDIUM',
    ADD COLUMN IF NOT EXISTS content_preview TEXT,
    ADD COLUMN IF NOT EXISTS offenses INT DEFAULT 1,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- saved_folders table columns
ALTER TABLE saved_folders
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;

-- profiles table columns
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS preferred_industry VARCHAR(100);

-- user_notification_preferences table columns
ALTER TABLE user_notification_preferences
    ADD COLUMN IF NOT EXISTS profile_notifications BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS connection_requests BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS messages BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS marketing_emails BOOLEAN DEFAULT FALSE;

-- post_shares table columns
ALTER TABLE post_shares
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;

-- organization_verifications table columns
ALTER TABLE organization_verifications
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE;

-- user_verifications table columns
ALTER TABLE user_verifications
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(100);

-- -----------------------------------------------------------------------------
-- 6. RECREATING VIEWS WITH MODERATION & SUSPENSION FILTERS
-- -----------------------------------------------------------------------------

DROP VIEW IF EXISTS active_users CASCADE;
CREATE VIEW active_users AS
SELECT * 
FROM users 
WHERE is_suspended = FALSE 
  AND (is_deleted IS FALSE OR is_deleted IS NULL);

DROP VIEW IF EXISTS active_organizations CASCADE;
CREATE VIEW active_organizations AS
SELECT * 
FROM organizations 
WHERE is_suspended = FALSE 
  AND (is_deactivated IS FALSE OR is_deactivated IS NULL);

-- =========================================================================
-- ACTIVE VIEWS FOR LIKES AND COMMENTS (Excluding Soft-Deleted Entities)
-- =========================================================================
 
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

DROP VIEW IF EXISTS admin_reports_view CASCADE;
CREATE VIEW admin_reports_view AS
SELECT 
    r.id AS report_id,
    r.reporter_id,
    CASE WHEN r.target_type = 'USER' THEN r.target_id ELSE NULL END AS reported_user_id,
    r.target_type,
    r.target_id,
    r.reason,
    r.status,
    r.created_at,
    u.account_name AS reporter_username,
    target_u.account_name AS reported_username
FROM reports r
LEFT JOIN users u ON r.reporter_id = u.user_id
LEFT JOIN users target_u ON (r.target_type = 'USER' AND r.target_id = target_u.user_id);

COMMIT;
