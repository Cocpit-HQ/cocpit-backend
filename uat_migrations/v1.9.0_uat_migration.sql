-- ==============================================================================
-- UAT Migration v1.9.0
-- Target Database: cocpit_backend_uat (also applied to staging/production)
-- Prepared Date:  2026-10-30 (Updated 2026-11-06)
-- Description: 
--   1. Mixed-Media Carousels (Images & Videos) support in post_media:
--      Adds order_index, thumbnail_url, and duration_seconds columns,
--      backfills order_index for existing records, and creates composite
--      index for deterministic ordering.
--   2. Jobs Explore & Recommendation System:
--      - Adds org_id column to experiences table to link candidate work history
--        with official organizations.
--      - Creates idx_experiences_org_id and idx_experiences_current_org for
--        rapid network affiliation graph traversals ("From your network").
--      - Creates idx_jobs_active_created partial index on jobs for high-throughput
--        listing retrieval and keyset cursor pagination across Explore categories.
--      - Creates idx_job_saves_job_id on job_saves for O(1) saves_count aggregations
--        in Featured opportunities quality scoring.
--      - Creates idx_activity_job_views on user_activity_log for sub-millisecond
--        retrieval of candidate Recently Viewed jobs.
--   3. Reusable Resume History (user_resume_history):
--      - Creates user_resume_history table to track applicant reusable resumes.
--      - Creates idx_user_resume_history_user_last_used index for instant lookup
--        by applicant ordered by most recent use.
--      - Backfills user_resume_history from existing job_applications.
--   4. Job Publishing Timing Support (published_at):
--      - Adds published_at TIMESTAMPTZ column to jobs table to track the exact
--        moment a job listing transitions from draft to active/live.
--      - Backfills published_at from created_at for existing ACTIVE jobs.
--      - Creates idx_jobs_published_at and idx_jobs_coalesce_published_created
--        indexes for chronological feed ranking, cursor pagination, and date filters.
--   5. Global Search Trigram Indexing (pg_trgm):
--      - Ensures pg_trgm extension for high-performance fuzzy substring matching.
--      - Creates GIN trigram indexes on users (full_name, account_name),
--        organizations (name), jobs (title, company_name), and posts (content on
--        active public posts).
--   6. Hashtag Global Search & Multi-Mode Ranking Indexes:
--      - Creates GIN trigram index on hashtags.tag for rapid autocomplete.
--      - Creates composite B-Tree indexes on hashtags for zero-cost multi-mode sorting
--        (Popular, Most Used, Recently Added, Trending).
--   7. Search Filter Master Tables & Profile Extensions:
--      - Creates job_roles_master & industries_master reference lookup tables.
--      - Adds working_industry & work_mode to profiles table for people filtering.
--      - Relaxes jobs.industry NOT NULL constraint to support draft listings.
--
-- Reference:
--   - schema.sql (Lines 148-151, 475-487, 746-751, 830-842, 924-927, 1742-1748, 1933-1960)
--   - migrations/018_add_search_trgm_indexes.sql
--   - migrations/019_add_hashtag_search_indexes.sql
--   - uat_schema.sql (Sections 20, 22, 23, 24, 25, 26, 27)
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Mixed-Media Carousels in post_media
-- ------------------------------------------------------------------------------

-- 1.1. Add order_index column for deterministic carousel slide sequencing
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0;

-- 1.2. Add thumbnail_url for video slide posters
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- 1.3. Add duration_seconds for video slide length
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(6,2);

-- 1.4. Backfill existing records that have NULL order_index using row_number() over (PARTITION BY post_id ORDER BY media_id)
WITH ranked_media AS (
    SELECT media_id, ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY media_id) - 1 AS calc_order
    FROM post_media
    WHERE order_index IS NULL
)
UPDATE post_media pm
SET order_index = rm.calc_order
FROM ranked_media rm
WHERE pm.media_id = rm.media_id;

-- 1.5. Create index on (post_id, order_index) for fast ordered retrieval
CREATE INDEX IF NOT EXISTS idx_post_media_post_order ON post_media(post_id, order_index);

-- ------------------------------------------------------------------------------
-- 2. Jobs Explore & Recommendation System
-- ------------------------------------------------------------------------------

-- 2.1. experiences: Link work experience to organizations
ALTER TABLE experiences 
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_experiences_org_id 
    ON experiences(org_id);

CREATE INDEX IF NOT EXISTS idx_experiences_current_org 
    ON experiences(org_id) 
    WHERE is_current = TRUE AND org_id IS NOT NULL;

-- 2.2. jobs: Composite partial index for active listings & keyset pagination
CREATE INDEX IF NOT EXISTS idx_jobs_active_created 
    ON jobs(created_at DESC, job_id DESC) 
    WHERE is_active = TRUE AND status = 'ACTIVE';

-- 2.3. job_saves: Reverse lookup index on job_id for saves_count aggregation
CREATE INDEX IF NOT EXISTS idx_job_saves_job_id 
    ON job_saves(job_id);

-- 2.4. user_activity_log: Targeted partial index for instant "Recently Viewed" job retrieval
CREATE INDEX IF NOT EXISTS idx_activity_job_views 
    ON user_activity_log(user_id, entity_id, created_at DESC) 
    WHERE action_type = 'view_job' AND entity_type = 'job';

-- ------------------------------------------------------------------------------
-- 3. Reusable Resume History (user_resume_history)
-- ------------------------------------------------------------------------------

-- 3.1. Create user_resume_history table
CREATE TABLE IF NOT EXISTS user_resume_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resume_url TEXT NOT NULL,
    resume_file_name TEXT DEFAULT 'Resume.pdf',
    created_at TIMESTAMPTZ DEFAULT now(),
    last_used_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, resume_url)
);

-- 3.2. Index for rapid lookup by applicant ordered by most recent use
CREATE INDEX IF NOT EXISTS idx_user_resume_history_user_last_used 
    ON user_resume_history(user_id, last_used_at DESC);

-- 3.3. Backfill user_resume_history from existing job_applications
INSERT INTO user_resume_history (user_id, resume_url, resume_file_name, last_used_at)
SELECT applicant_id, resume_url, 
       COALESCE((array_agg(resume_file_name ORDER BY applied_at DESC))[1], 'Resume.pdf') AS resume_file_name, 
       MAX(applied_at) AS last_used_at
FROM job_applications
WHERE resume_url IS NOT NULL
GROUP BY applicant_id, resume_url
ON CONFLICT (user_id, resume_url) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 4. Job Publishing Timing Support (published_at)
-- ------------------------------------------------------------------------------

-- 4.1. Add published_at column to jobs table
ALTER TABLE jobs 
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL;

-- 4.2. Backfill published_at for existing ACTIVE jobs from created_at
UPDATE jobs 
SET published_at = created_at 
WHERE status = 'ACTIVE' AND published_at IS NULL;

-- 4.3. Indexes for fast ordering and filtering by published timestamp
CREATE INDEX IF NOT EXISTS idx_jobs_published_at 
    ON jobs(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_coalesce_published_created 
    ON jobs((COALESCE(published_at, created_at)) DESC);

-- ------------------------------------------------------------------------------
-- 5. Global Search Trigram Indexing (pg_trgm)
-- ------------------------------------------------------------------------------

-- 5.1. Ensure Trigram Extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 5.2. Users Trigram Indexes
CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm 
    ON users USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_account_name_trgm 
    ON users USING GIN (account_name gin_trgm_ops);

-- 5.3. Organizations Trigram Index
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm 
    ON organizations USING GIN (name gin_trgm_ops);

-- 5.4. Jobs Trigram Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm 
    ON jobs USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_jobs_company_trgm 
    ON jobs USING GIN (company_name gin_trgm_ops);

-- 5.5. Public Post Content Partial GIN Index
CREATE INDEX IF NOT EXISTS idx_posts_content_trgm 
    ON posts USING GIN (content gin_trgm_ops) 
    WHERE (is_removed IS FALSE OR is_removed IS NULL) 
      AND is_active = TRUE 
      AND visibility = 'public';

-- ------------------------------------------------------------------------------
-- 6. Hashtag Global Search & Multi-Mode Ranking Indexes
-- ------------------------------------------------------------------------------

-- 6.1. Trigram GIN index for fast substring/prefix match on hashtags
CREATE INDEX IF NOT EXISTS idx_hashtags_tag_trgm 
    ON hashtags USING GIN (tag gin_trgm_ops);

-- 6.2. Composite B-Tree indexes for multi-mode sorting without sort overhead
CREATE INDEX IF NOT EXISTS idx_hashtags_posts_count 
    ON hashtags (posts_count DESC, usage_count DESC);

CREATE INDEX IF NOT EXISTS idx_hashtags_usage_count 
    ON hashtags (usage_count DESC, posts_count DESC);

CREATE INDEX IF NOT EXISTS idx_hashtags_created_at 
    ON hashtags (created_at DESC, hashtag_id DESC);

CREATE INDEX IF NOT EXISTS idx_hashtags_last_used_at 
    ON hashtags (last_used_at DESC NULLS LAST);

-- ------------------------------------------------------------------------------
-- 7. Search Filter Master Tables & Profile Extensions
-- ------------------------------------------------------------------------------

-- 7.1. Reference Tables: Job Roles Master
CREATE TABLE IF NOT EXISTS job_roles_master (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_roles_name ON job_roles_master (role_name);

-- 7.2. Reference Tables: Industries Master
CREATE TABLE IF NOT EXISTS industries_master (
    industry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_industries_name ON industries_master (industry_name);

-- 7.3. Profiles: Add working_industry and work_mode for people filtering
ALTER TABLE profiles 
    ADD COLUMN IF NOT EXISTS working_industry TEXT;

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_work_mode') THEN
        CREATE TYPE job_work_mode AS ENUM ('Remote', 'Hybrid', 'Onsite');
    END IF;
END $$;

ALTER TABLE profiles 
    ADD COLUMN IF NOT EXISTS work_mode job_work_mode;

-- 7.4. Jobs: Allow drafts to be created without industry
ALTER TABLE jobs 
    ALTER COLUMN industry DROP NOT NULL;

COMMIT;
