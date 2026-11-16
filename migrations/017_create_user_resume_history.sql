-- Migration 017: Create user_resume_history table and backfill from job_applications
-- Ticket: [ID-1532] / SCRUM-1532

BEGIN;

-- 1. Create user_resume_history table
CREATE TABLE IF NOT EXISTS user_resume_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resume_url TEXT NOT NULL,
    resume_file_name TEXT DEFAULT 'Resume.pdf',
    created_at TIMESTAMPTZ DEFAULT now(),
    last_used_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, resume_url)
);

-- 2. Index for rapid lookup by applicant ordered by most recent use
CREATE INDEX IF NOT EXISTS idx_user_resume_history_user_last_used 
    ON user_resume_history(user_id, last_used_at DESC);

-- 3. Backfill user_resume_history from existing job_applications
INSERT INTO user_resume_history (user_id, resume_url, resume_file_name, last_used_at)
SELECT applicant_id, resume_url, 
       COALESCE((array_agg(resume_file_name ORDER BY applied_at DESC))[1], 'Resume.pdf') AS resume_file_name, 
       MAX(applied_at) AS last_used_at
FROM job_applications
WHERE resume_url IS NOT NULL
GROUP BY applicant_id, resume_url
ON CONFLICT (user_id, resume_url) DO NOTHING;

COMMIT;
