-- Migration: Enable Trigram Search & Create Indexes
--
-- INSTRUCTIONS:
-- Run this script manually in your PostgreSQL database to enable fast "as-you-type" search.
--
-- Command Example:
-- psql -h localhost -U your_user -d your_db -f sql/001_user_search_indexes.sql
--
-- Note: Requires superuser privileges to enable extensions.

-- 1. Enable the pg_trgm extension for fuzzy string matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Create GIN index on users.full_name for fast ILIKE and similarity searches
CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm
ON users USING GIN (full_name gin_trgm_ops);

-- 3. Create GIN index on users.email for fast lookup (optional but recommended for search)
CREATE INDEX IF NOT EXISTS idx_users_email_trgm
ON users USING GIN (email gin_trgm_ops);

-- 4. Analyze table to update statistics immediately
ANALYZE users;
