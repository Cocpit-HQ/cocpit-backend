-- Migration: Add index for job-related stories in story_metadata
-- Date: 2026-03-21

CREATE INDEX IF NOT EXISTS idx_stories_metadata_job_type 
ON stories ((story_metadata->>'type')) 
WHERE (story_metadata->>'type' = 'job');
