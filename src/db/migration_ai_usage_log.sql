-- Migration: Create ai_usage_log table for AI telemetry

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID,
  org_id UUID,
  feature TEXT NOT NULL,           -- 'jd_generate' | 'jd_extract' | 'candidate_analyze'
  related_entity_id UUID,          -- job_id or application_id
  model TEXT,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  cost_estimate_usd NUMERIC(10,6) DEFAULT 0,
  latency_ms INT DEFAULT 0,
  cache_hit BOOLEAN DEFAULT FALSE,
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  source_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_user_time ON ai_usage_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_time ON ai_usage_log (created_at);
