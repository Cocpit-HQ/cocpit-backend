-- ==============================================================================
-- UAT Migration v1.1.0
-- Target Database: cocpit_backend_uat
-- Description: Brings UAT database schema into alignment with Staging (schema.sql)
-- Changes Included:
--   1. users: Add `dob` column
--   2. organizations: Add `legal_name`, `incorporation_date`
--   3. email_otps: Add `purpose`, `session_expires_at`, `verified_at`
--   4. email_otps: Replace `unique_email_otp` with `unique_email_otp_purpose` (email, purpose)
--   5. password_reset_tokens: Ensure table and indexes exist
--   6. blocks & active_users: Relax blocks foreign keys & ensure active_users view exists
-- ==============================================================================

BEGIN;

-- 1. users: Add dob (Date of Birth) column
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS dob DATE;

-- 2. organizations: Add verification fields (legal_name, incorporation_date)
ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS incorporation_date DATE;

-- 3. email_otps: Add missing OTP columns
ALTER TABLE email_otps 
    ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(100) NOT NULL DEFAULT 'signup';

-- 4. email_otps: Replace unique constraint
-- Drop old constraint (unique_email_otp) and any previous version of unique_email_otp_purpose
ALTER TABLE email_otps 
    DROP CONSTRAINT IF EXISTS unique_email_otp,
    DROP CONSTRAINT IF EXISTS unique_email_otp_purpose;

-- Add new compound unique constraint on (email, purpose)
ALTER TABLE email_otps 
    ADD CONSTRAINT unique_email_otp_purpose UNIQUE (email, purpose);

-- 5. password_reset_tokens: Ensure table & lookup indexes exist
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

-- 6. blocks & active_users: Ensure foreign key relaxations & view compatibility
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_blocked_id_fkey;
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_blocker_id_fkey;

CREATE OR REPLACE VIEW active_users AS SELECT * FROM users;

COMMIT;
