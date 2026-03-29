-- Migration: Create Reporting System (Phase 1)
-- Date: 2026-03-29

-- ---------------------------------------------------------
-- 1. report_reasons Table
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_reasons (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  active BOOLEAN DEFAULT TRUE
);

-- Seed Default Data (idempotent via ON CONFLICT)
INSERT INTO report_reasons (code, label) VALUES
('SPAM', 'Spam or misleading'),
('ABUSE', 'Abusive content'),
('HARASSMENT', 'Harassment or bullying'),
('FAKE', 'Fake account/company'),
('INAPPROPRIATE', 'Inappropriate content'),
('OTHER', 'Other')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------
-- 2. reports Table
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type VARCHAR(20) NOT NULL, -- 'POST', 'USER', 'COMMENT', 'COMPANY'
  target_id UUID NOT NULL, -- Target entity ID (Post, User, etc.)
  reason_id INT REFERENCES report_reasons(id) ON DELETE SET NULL,
  custom_reason TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- Unique constraint: preventing same user from reporting same target twice
  UNIQUE (reporter_id, target_type, target_id)
);

-- Index for admin moderation (Phase 2)
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
