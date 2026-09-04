-- ==============================================================================
-- Consolidated Migration File
-- 
-- Note: This file is for historical reference. The schema changes documented 
-- here have already been applied to the production database via various one-off 
-- scripts that were previously at the root of the repository.
-- All DDL statements are written to be idempotent.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. AI JD Cache
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_jd_cache (
    role_hash VARCHAR(64) PRIMARY KEY,
    role_name TEXT NOT NULL,
    company_name TEXT,
    ai_content JSONB NOT NULL,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days',
    prompt_version VARCHAR(10) DEFAULT 'v1.0'
);

-- ------------------------------------------------------------------------------
-- 2. User Verifications & Adjustments
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_verifications (
    verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    verification_type VARCHAR(50) DEFAULT 'IDENTITY',
    front_image_url TEXT NOT NULL,
    back_image_url TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'VERIFIED',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    document_type VARCHAR(50)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_identity_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- ------------------------------------------------------------------------------
-- 3. Deletion Batches (Must precede references)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deletion_batches (
    batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_batch_id UUID;
ALTER TABLE users DROP CONSTRAINT IF EXISTS fk_user_deletion_batch;
ALTER TABLE users ADD CONSTRAINT fk_user_deletion_batch FOREIGN KEY (deletion_batch_id) REFERENCES deletion_batches(batch_id) ON DELETE SET NULL;

-- ------------------------------------------------------------------------------
-- 4. Organization Verifications & Onboarding
-- ------------------------------------------------------------------------------
ALTER TABLE organization_verifications 
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE,
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS verification_type VARCHAR(20) DEFAULT 'EMAIL' CHECK (verification_type IN ('EMAIL', 'PHONE', 'EDU_EMAIL', 'DOCUMENT')),
    ADD COLUMN IF NOT EXISTS target_value VARCHAR(255),
    ADD COLUMN IF NOT EXISTS request_count INTEGER DEFAULT 1;

ALTER TABLE organization_verifications ALTER COLUMN org_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_verifications_lookup ON organization_verifications(org_id, verification_type, is_verified);

-- ------------------------------------------------------------------------------
-- 5. Organizations Enhancements
-- ------------------------------------------------------------------------------
ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE,
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_execute_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_batch_id UUID,
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
    ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS country VARCHAR(100),
    ADD COLUMN IF NOT EXISTS city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS headline VARCHAR(200),
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS onboarding_step VARCHAR(50) DEFAULT 'IDENTITY',
    ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS fk_org_deletion_batch;
ALTER TABLE organizations ADD CONSTRAINT fk_org_deletion_batch FOREIGN KEY (deletion_batch_id) REFERENCES deletion_batches(batch_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_created_by ON organizations(created_by);
CREATE INDEX IF NOT EXISTS idx_organizations_onboarding_completed ON organizations(onboarding_completed) WHERE onboarding_completed = FALSE;

-- ------------------------------------------------------------------------------
-- 6. Organization Restoration & Documents
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_restoration_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_documents (
    document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    document_url TEXT NOT NULL,
    document_name VARCHAR(255) NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_documents_org_id ON organization_documents(org_id);

-- ------------------------------------------------------------------------------
-- 7. Organization Follows
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_user_follows (
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_user_follows_org_id ON organization_user_follows(org_id);

CREATE TABLE IF NOT EXISTS organization_org_follows (
    follower_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    following_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_org_id, following_org_id),
    CHECK (follower_org_id <> following_org_id)
);
CREATE INDEX IF NOT EXISTS idx_org_org_follows_follower ON organization_org_follows(follower_org_id);

-- ------------------------------------------------------------------------------
-- 8. Key Offerings & Media
-- ------------------------------------------------------------------------------
ALTER TABLE organization_key_offerings 
    ADD COLUMN IF NOT EXISTS icon VARCHAR(100),
    ADD COLUMN IF NOT EXISTS label VARCHAR(50);

ALTER TABLE message_media ADD COLUMN IF NOT EXISTS filename TEXT;

-- ------------------------------------------------------------------------------
-- 9. Users Locations Cleanup & Enhancements
-- ------------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_location_id_fkey;
ALTER TABLE users DROP COLUMN IF EXISTS location_id;
DROP TABLE IF EXISTS locations CASCADE;

ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS location_country TEXT,
    ADD COLUMN IF NOT EXISTS location_state TEXT,
    ADD COLUMN IF NOT EXISTS location_city TEXT,
    ADD COLUMN IF NOT EXISTS location_formatted TEXT,
    ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location_place_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_location_country ON users(location_country) WHERE location_country IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_location_city ON users(LOWER(location_city)) WHERE location_city IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 10. Reports Constraints Adjustments
-- ------------------------------------------------------------------------------
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reporter_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_reporter_id_target_type_target_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_user ON reports (reporter_id, target_type, target_id) WHERE reporter_org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_org ON reports (reporter_id, target_type, target_id, reporter_org_id) WHERE reporter_org_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 11. Jobs & Activity
-- ------------------------------------------------------------------------------
ALTER TABLE jobs ALTER COLUMN salary_min DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN salary_max DROP NOT NULL;
ALTER TABLE jobs 
    ADD COLUMN IF NOT EXISTS experience_min INTEGER,
    ADD COLUMN IF NOT EXISTS experience_max INTEGER,
    ADD COLUMN IF NOT EXISTS experience_label TEXT;

ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'EXPIRED', 'REJECTED', 'UNDER_REVIEW', 'PAUSED', 'ARCHIVED'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_salary_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_salary_check CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max);

ALTER TABLE job_versions 
    ADD COLUMN IF NOT EXISTS trigger_event VARCHAR(50),
    ADD COLUMN IF NOT EXISTS provenance VARCHAR(50) DEFAULT 'USER';

CREATE TABLE IF NOT EXISTS job_activity (
    activity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 12. Views Updates
-- ------------------------------------------------------------------------------
CREATE OR REPLACE VIEW active_organizations AS
SELECT * FROM organizations 
WHERE deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE;

CREATE OR REPLACE VIEW active_users AS
SELECT * FROM users
WHERE deletion_execute_at IS NULL AND is_deactivated = FALSE;

CREATE OR REPLACE VIEW user_display_profiles AS
SELECT
    user_id,
    account_name AS original_username,
    CASE WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN full_name ELSE 'Deactivated User' END AS display_name,
    CASE WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN account_name ELSE 'deactivated_user' END AS display_username,
    CASE WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN avatar_url ELSE NULL END AS display_avatar,
    CASE WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN headline ELSE 'This account has been deactivated' END AS display_headline,
    CASE WHEN deletion_execute_at IS NULL AND is_deactivated = FALSE THEN location ELSE NULL END AS location
FROM users;

CREATE OR REPLACE VIEW organization_display_profiles AS
SELECT 
    org_id,
    CASE WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN name ELSE 'Deleted Page' END AS name,
    CASE WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN slug ELSE 'deleted_page' END AS slug,
    CASE WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN logo_url ELSE NULL END AS logo_url,
    CASE WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN headline ELSE 'This page has been deactivated' END AS headline,
    entity_type
FROM organizations;

COMMIT;
