-- ==============================================================================
-- UAT Migration v1.8.0
-- Target Database: cocpit_backend_uat (also applied to staging/production)
-- Prepared Date:  2026-10-27 (Updated 2026-10-30)
-- Description: 
--   18. Creates organization_notification_settings table and index for
--       org-wide notification preferences.
--   19. Adds member_id column to organization_members for surrogate identification.
--   20. Creates organization_deactivation_history table and indexes to track
--       organizations automatically frozen by personal account deactivation.
--   21. Enhances user_post_feedback with org_id and partial unique indexes to
--       enable organization-scoped "Not Interested" feedback across teams (SCRUM-1514).
--
-- Reference:
--   - uat_schema.sql (Lines 47-73 and Lines 180-223)
-- ==============================================================================

BEGIN;

-- 18. organization_notification_settings: Org-wide notification preferences per organization
CREATE TABLE IF NOT EXISTS organization_notification_settings (
    org_id UUID PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    events_enabled BOOLEAN NOT NULL DEFAULT true,
    jobs_enabled BOOLEAN NOT NULL DEFAULT true,
    posts_enabled BOOLEAN NOT NULL DEFAULT true,
    messages_enabled BOOLEAN NOT NULL DEFAULT true,
    messages_chat_enabled BOOLEAN NOT NULL DEFAULT true,
    messages_jobs_enabled BOOLEAN NOT NULL DEFAULT true,
    email_enabled BOOLEAN NOT NULL DEFAULT true,
    push_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_notification_settings_org_id ON organization_notification_settings(org_id);

-- 19. organization_members: Add member_id column for surrogate identifier
ALTER TABLE organization_members 
    ADD COLUMN IF NOT EXISTS member_id UUID DEFAULT gen_random_uuid();

-- 20. organization_deactivation_history: Tracks organizations automatically deactivated by personal account deactivation
CREATE TABLE IF NOT EXISTS organization_deactivation_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    deactivation_event_id UUID NOT NULL,
    reason VARCHAR(50) NOT NULL DEFAULT 'PERSONAL_ACCOUNT',
    deactivated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    restored_at TIMESTAMPTZ DEFAULT NULL
);

-- Rapid lookup index for unrecovered organizations during login/reactivation
CREATE INDEX IF NOT EXISTS idx_org_deactivation_history_user_unrecovered
    ON organization_deactivation_history (user_id, restored_at)
    WHERE restored_at IS NULL;

-- Index for organization lifecycle audit tracking
CREATE INDEX IF NOT EXISTS idx_org_deactivation_history_org_id 
    ON organization_deactivation_history (org_id);

-- 21. user_post_feedback: Add org_id and organization-level tracking (SCRUM-1514)
DO $$
BEGIN
    -- Add org_id column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_post_feedback' AND column_name = 'org_id'
    ) THEN
        ALTER TABLE user_post_feedback 
        ADD COLUMN org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE DEFAULT NULL;
    END IF;

    -- Add surrogate id column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_post_feedback' AND column_name = 'id'
    ) THEN
        ALTER TABLE user_post_feedback 
        ADD COLUMN id UUID DEFAULT gen_random_uuid();
    END IF;

    -- Drop legacy composite primary key if present
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'user_post_feedback_pkey'
    ) THEN
        ALTER TABLE user_post_feedback DROP CONSTRAINT user_post_feedback_pkey;
    END IF;

    -- Set id as primary key
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'user_post_feedback_pkey'
    ) THEN
        ALTER TABLE user_post_feedback ADD CONSTRAINT user_post_feedback_pkey PRIMARY KEY (id);
    END IF;
END $$;

-- Personal feedback uniqueness: one feedback per user per post
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_post_feedback_personal 
ON user_post_feedback (user_id, post_id) 
WHERE org_id IS NULL;

-- Organization feedback uniqueness: one authoritative feedback per org per post
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_post_feedback_org 
ON user_post_feedback (org_id, post_id) 
WHERE org_id IS NOT NULL;

-- Fast exclusion lookup indexes for Feed and Profile queries
CREATE INDEX IF NOT EXISTS idx_user_post_feedback_filter_org 
ON user_post_feedback (org_id, post_id) 
WHERE feedback_type = 'NOT_INTERESTED';

CREATE INDEX IF NOT EXISTS idx_user_post_feedback_filter_user 
ON user_post_feedback (user_id, post_id) 
WHERE org_id IS NULL AND feedback_type = 'NOT_INTERESTED';

COMMIT;
