-- migration_ai_queue_dedup_index.sql
-- Create a partial unique index to prevent duplicate jobs in the queue
-- Only one PENDING or PROCESSING entry per application_id is allowed.

CREATE UNIQUE INDEX IF NOT EXISTS ai_analysis_queue_dedup_idx 
ON ai_analysis_queue(application_id) 
WHERE status IN ('PENDING', 'PROCESSING');
