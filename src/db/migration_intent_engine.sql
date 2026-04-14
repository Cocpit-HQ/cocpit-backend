-- Intent Layer DB Migrations (MVP)
-- Note: 'user_activity_log' remains strictly untouched per instructions.

-- Create user_intent_scores table to track MVP persona metrics natively
CREATE TABLE IF NOT EXISTS user_intent_scores (
  user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  
  job_seeker_score INT DEFAULT 0,
  recruiter_score INT DEFAULT 0,
  creator_score INT DEFAULT 0,
  networker_score INT DEFAULT 0,
  event_score INT DEFAULT 0,

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
