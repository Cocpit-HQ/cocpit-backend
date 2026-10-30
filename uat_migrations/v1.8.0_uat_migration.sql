-- ==============================================================================
-- UAT Migration v1.8.0
-- Target Database: cocpit_backend_uat (also applied to staging/production)
-- Prepared Date:  2026-10-27
-- Description: Creates organization_notification_settings table and index for
--              org-wide notification preferences, and adds member_id column
--              to organization_members for surrogate identification.
--
-- Reference:
--   - uat_schema.sql (Lines 166-188)
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


COMMIT;
