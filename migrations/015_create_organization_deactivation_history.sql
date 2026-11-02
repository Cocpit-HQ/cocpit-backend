
CREATE TABLE IF NOT EXISTS organization_deactivation_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    deactivation_event_id UUID NOT NULL,
    reason VARCHAR(50) NOT NULL DEFAULT 'PERSONAL_ACCOUNT',
    deactivated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    restored_at TIMESTAMPTZ DEFAULT NULL
);

-- Index for rapid retrieval during user login / account reactivation
CREATE INDEX IF NOT EXISTS idx_org_deactivation_history_user_unrecovered
    ON organization_deactivation_history (user_id, restored_at)
    WHERE restored_at IS NULL;

-- Index for organization lifecycle lookup
CREATE INDEX IF NOT EXISTS idx_org_deactivation_history_org_id 
    ON organization_deactivation_history (org_id);
