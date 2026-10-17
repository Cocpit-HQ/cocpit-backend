-- UAT Schema Incremental Migrations
-- Source of truth: schema.sql (Staging)
-- See uat_migrations/v1.1.0_uat_migration.sql for detailed runner.

BEGIN;

-- 1. users: Add dob column
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS dob DATE;

-- 2. organizations: Add verification fields
ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE;

-- 3. email_otps: Add purpose, session expiry, verified_at, and update unique constraint
ALTER TABLE email_otps 
    ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(100) NOT NULL DEFAULT 'signup';

ALTER TABLE email_otps 
    DROP CONSTRAINT IF EXISTS unique_email_otp,
    DROP CONSTRAINT IF EXISTS unique_email_otp_purpose;

ALTER TABLE email_otps 
    ADD CONSTRAINT unique_email_otp_purpose UNIQUE (email, purpose);

-- 4. password_reset_tokens: Ensure table and indexes exist
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    used BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- 5. blocks & active_users
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_blocked_id_fkey;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_blocker_id_fkey;
CREATE OR REPLACE VIEW active_users AS SELECT * FROM users;

-- 6. user_post_feedback: Feed interaction mechanism
CREATE TABLE IF NOT EXISTS user_post_feedback (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
    feedback_type VARCHAR(20) NOT NULL CHECK (feedback_type IN ('INTERESTED', 'NOT_INTERESTED')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);

-- 7. post_media: Add width and height columns
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS width INT,
    ADD COLUMN IF NOT EXISTS height INT;

COMMIT;

-- 010_comment_edit_tracking.sql
-- Add is_edited and ensure updated_at exists on post_comments

ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE;

ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- Recreate active_post_comments view appending updated_at and is_edited at the end to preserve column ordering
CREATE OR REPLACE VIEW active_post_comments AS
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
    pc.is_edited
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);

-- 11. user_search_history: Persistent recent search tracking
CREATE TABLE IF NOT EXISTS user_search_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    query_text TEXT NOT NULL,
    query_normalized TEXT NOT NULL,
    profile_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_search_history 
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;
DROP INDEX IF EXISTS uq_user_search_history_user_query;
CREATE INDEX IF NOT EXISTS idx_user_search_history_user_created ON user_search_history(user_id, org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_search_history_actor_query ON user_search_history(user_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), query_normalized);

-- 12. Add country_code for international phone numbers
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10);

ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10);

-- 13. organizations: Add location coordinates & details for mapping support
ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS location_formatted TEXT,
    ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_place_id TEXT;

CREATE INDEX IF NOT EXISTS idx_organizations_location_coords ON organizations(location_lat, location_lng) WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- 14. users: Update mobile_format constraint to support international phone numbers (7 to 15 digits)
ALTER TABLE users 
    DROP CONSTRAINT IF EXISTS mobile_format;

ALTER TABLE users 
    ADD CONSTRAINT mobile_format CHECK (mobile_number IS NULL OR mobile_number ~ '^[0-9]{7,15}$');

COMMIT;

INSERT INTO feature_flags (flag_key, is_enabled, updated_at)
VALUES 
  ('enableTeamsModule', TRUE, now()),
  ('enableTeams', TRUE, now()),
  ('teams', TRUE, now()),
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
