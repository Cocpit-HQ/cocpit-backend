-- 03/03/2026 Migration: Company Notification Preferences
-- LinkedIn-style per-user per-company notification category toggles

CREATE TABLE IF NOT EXISTS company_notification_preferences (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    events_enabled BOOLEAN DEFAULT TRUE,
    jobs_enabled BOOLEAN DEFAULT TRUE,
    posts_enabled BOOLEAN DEFAULT TRUE,
    announcements_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_cnp_company_id ON company_notification_preferences(company_id);
CREATE INDEX IF NOT EXISTS idx_cnp_user_company ON company_notification_preferences(user_id, company_id);
