-- =============================================================
-- Universal Share Architecture — Database Migration
-- =============================================================
-- Safe to run multiple times (IF NOT EXISTS guards).
-- =============================================================

-- ─── Step 1: Add universal entity columns ───────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_id   TEXT;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id   TEXT;

-- ─── Step 2: Backfill existing data ─────────────────────────

-- Posts shared in messages
UPDATE messages
SET    entity_type = 'post',
       entity_id   = shared_post_id::TEXT
WHERE  shared_post_id IS NOT NULL
  AND  entity_type IS NULL;

-- Profiles shared in messages (user profiles → 'profile', company profiles → 'company')
UPDATE messages
SET    entity_type = CASE
           WHEN shared_profile_type = 'company' THEN 'company'
           ELSE 'profile'
       END,
       entity_id   = shared_profile_id::TEXT
WHERE  shared_profile_id IS NOT NULL
  AND  entity_type IS NULL;

-- Notifications (profile_share type)
UPDATE notifications
SET    entity_type = 'profile',
       entity_id   = reference_id::TEXT
WHERE  type = 'profile_share'
  AND  entity_type IS NULL
  AND  reference_id IS NOT NULL;

-- ─── Step 3: Performance indexes ────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_entity
ON messages(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_notifications_entity
ON notifications(entity_type, entity_id);

-- ─── Step 4: Share tracking table ───────────────────────────

CREATE TABLE IF NOT EXISTS shares (
    id            BIGSERIAL PRIMARY KEY,
    sender_id     TEXT NOT NULL,
    receiver_id   TEXT,
    entity_type   VARCHAR(50) NOT NULL,
    entity_id     TEXT NOT NULL,
    share_method  VARCHAR(20) NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Analytics indexes
CREATE INDEX IF NOT EXISTS idx_shares_entity
ON shares(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_shares_sender
ON shares(sender_id);

CREATE INDEX IF NOT EXISTS idx_shares_created_at
ON shares(created_at);
