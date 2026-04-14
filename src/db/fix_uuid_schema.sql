-- FIX: Mismatch between users.user_id (UUID) and intent tables (currently INT)
-- We drop and recreate since it's an MVP and likely no mission-critical data exists yet.

DROP TABLE IF EXISTS user_intent_scores;
DROP TABLE IF EXISTS user_activities;

CREATE TABLE user_activities (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_intent_scores (
  user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  job_seeker_score INT DEFAULT 0,
  creator_score INT DEFAULT 0,
  event_score INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Re-create index for activities
CREATE INDEX idx_user_activities_user_id ON user_activities(user_id);
