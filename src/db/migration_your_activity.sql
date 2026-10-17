-- =============================================================
-- Your Activity Feature — Database Migration
-- =============================================================
-- New table for tracking user engagement (likes, comments, views, etc.)
-- Safe to run multiple times (IF NOT EXISTS guards).
-- =============================================================

CREATE TABLE IF NOT EXISTS user_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes for dashboard queries
CREATE INDEX IF NOT EXISTS idx_activity_user_type 
ON user_activity_log(user_id, action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_user_entity 
ON user_activity_log(user_id, entity_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_created 
ON user_activity_log(created_at DESC);
