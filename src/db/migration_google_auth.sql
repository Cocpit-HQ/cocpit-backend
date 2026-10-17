-- Migration: Add Google OAuth support to users table
-- Date: 2026-03-10
-- Description: Adds auth_provider, google_id columns and relaxes password_hash NOT NULL constraint
--              to allow social (Google) authentication alongside existing email/password login.

-- 1. Add auth_provider column to track how the user was created
--    Defaults to 'local' so all existing users are unaffected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'local';

-- 2. Add google_id column with a UNIQUE constraint to prevent duplicate Google accounts.
--    This stores the Google `sub` (subject) claim — a stable, unique identifier per Google account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

-- 3. Allow password_hash to be NULL for social-auth users (Google users have no password).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- 4. Add a CHECK constraint to ensure data integrity:
--    - Local users MUST have a password_hash.
--    - Social-auth users are allowed to have NULL password_hash.
--    Using NOT VALID to avoid scanning existing rows (they all satisfy this already).
ALTER TABLE users ADD CONSTRAINT password_or_social
CHECK (
  (auth_provider = 'local' AND password_hash IS NOT NULL)
  OR
  (auth_provider != 'local')
) NOT VALID;

-- Validate the constraint against existing data (safe, all existing rows have password_hash set).
ALTER TABLE users VALIDATE CONSTRAINT password_or_social;
