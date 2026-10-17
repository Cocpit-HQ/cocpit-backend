-- Missing Schema Migrations for cocpit_admin_panel

-- 1. Missing Tables from schema.sql
CREATE TABLE IF NOT EXISTS organization_permission_keys (
    permission_key  VARCHAR(100) PRIMARY KEY,
    label           VARCHAR(200) NOT NULL,
    ui_type         VARCHAR(10)  NOT NULL DEFAULT 'toggle'
        CHECK (ui_type IN ('toggle', 'checkbox')),
    parent_key      VARCHAR(100) REFERENCES organization_permission_keys(permission_key),
    requires_parent BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order      INTEGER      NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS community_subscriptions (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    community_id UUID REFERENCES communities(community_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'SUBSCRIBED' CHECK (status IN ('SUBSCRIBED', 'UNSUBSCRIBED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, community_id)
);
CREATE INDEX IF NOT EXISTS idx_community_subscribers_comm_id ON community_subscriptions(community_id);

CREATE TABLE IF NOT EXISTS organization_key_offerings (
    offering_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    icon VARCHAR(255),
    label VARCHAR(255),
    position INT DEFAULT 0,
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Missing Tables from external migration scripts
CREATE TABLE IF NOT EXISTS organization_user_follows (
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS organization_org_follows (
    follower_org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    followed_org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_org_id, followed_org_id),
    CHECK (follower_org_id != followed_org_id)
);

-- 3. Missing Columns from schema.sql
ALTER TABLE organization_roles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE organization_roles ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE communities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE communities ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS banner_url VARCHAR(255);
ALTER TABLE post_shares ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS resume_file_name VARCHAR(255);
ALTER TABLE organization_invites ADD COLUMN IF NOT EXISTS invited_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE organization_verifications ADD COLUMN IF NOT EXISTS request_count INT DEFAULT 1;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_role VARCHAR(50);
ALTER TABLE organization_connection_requests ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
ALTER TABLE organization_connection_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE organization_offices ADD COLUMN IF NOT EXISTS address TEXT;
