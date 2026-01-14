-- Fix missing session_id column in refresh_tokens (required for auth)
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_idx ON refresh_tokens (session_id);

-- Add onboarding fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_onboarding_complete BOOLEAN DEFAULT FALSE;

-- Add unique index for account_name (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS users_account_name_idx ON users (lower(account_name));
