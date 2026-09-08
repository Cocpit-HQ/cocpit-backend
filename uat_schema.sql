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

COMMIT;
