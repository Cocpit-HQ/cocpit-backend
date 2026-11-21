-- ==============================================================================
-- Migration: 024_add_closed_at_to_jobs.sql
-- Description:
--   1. Adds closed_at column to jobs table.
--   2. Creates partial index on (org_id, closed_at DESC) and (recruiter_id, closed_at DESC)
--      for closed jobs list query efficiency.
--   3. Idempotently backfills closed_at for existing CLOSED jobs from job_activity.
-- ==============================================================================

BEGIN;

-- 1. Jobs: Add closed_at column if not exists
ALTER TABLE jobs 
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- 2. Index for efficient keyset pagination and ordering on closed jobs
CREATE INDEX IF NOT EXISTS idx_jobs_org_closed 
    ON jobs(org_id, closed_at DESC) 
    WHERE status = 'CLOSED';

CREATE INDEX IF NOT EXISTS idx_jobs_recruiter_closed 
    ON jobs(recruiter_id, closed_at DESC) 
    WHERE status = 'CLOSED';

-- 3. Idempotent backfill from job_activity for existing CLOSED jobs
UPDATE jobs j
SET closed_at = COALESCE(
    (SELECT ja.created_at FROM job_activity ja WHERE ja.job_id = j.job_id AND ja.action = 'CLOSE' ORDER BY ja.created_at DESC LIMIT 1),
    j.updated_at,
    j.published_at,
    j.created_at
)
WHERE j.status = 'CLOSED' 
  AND j.closed_at IS NULL;

COMMIT;
