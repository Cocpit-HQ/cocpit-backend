-- ==============================================================================
-- UAT Migration v1.9.0
-- Target Database: cocpit_backend_uat (also applied to staging/production)
-- Prepared Date:  2026-10-30 (Updated 2026-11-05)
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
--
-- Reference:
--   - schema.sql (Lines 148-151, 475-487, 746-751, 830-842, 924-927, 1742-1748)
--   - uat_schema.sql (Section 20, 22 & 23)
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

COMMIT;
