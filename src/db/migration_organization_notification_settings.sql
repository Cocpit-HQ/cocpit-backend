-- Migration: Create organization_notification_settings table
-- Holds org-wide notification settings per organization (org_id is PK, user_id tracks last updater)

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

CREATE INDEX IF NOT EXISTS idx_org_notification_settings_org_id 
    ON organization_notification_settings(org_id);
