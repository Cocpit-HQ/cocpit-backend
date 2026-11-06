-- ==============================================================================
-- Migration: 018_add_search_trgm_indexes.sql
-- Enables idempotent GIN trigram indexing for COCPIT Global Search
-- Targets: users (full_name, account_name), organizations (name),
--          jobs (title, company_name), and posts (content on public active posts).
-- ==============================================================================

BEGIN;

-- 1. Ensure Trigram Extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Idempotent User and Company Trigram Indexes
CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm 
ON users USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_account_name_trgm 
ON users USING GIN (account_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_companies_name_trgm 
ON organizations USING GIN (name gin_trgm_ops);

-- 3. Accelerate Job Title and Company Search Predicate (Supporting BitmapOr)
CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm 
ON jobs USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_jobs_company_trgm 
ON jobs USING GIN (company_name gin_trgm_ops);

-- 4. Accelerate Public Post Content Search (Partial GIN Index)
CREATE INDEX IF NOT EXISTS idx_posts_content_trgm 
ON posts USING GIN (content gin_trgm_ops) 
WHERE (is_removed IS FALSE OR is_removed IS NULL) 
  AND is_active = TRUE 
  AND visibility = 'public';

COMMIT;

