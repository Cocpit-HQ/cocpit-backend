-- Migration: Add message deletion support
-- 1. Add columns to 'messages' table for "Delete for Everyone"
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS is_deleted_for_everyone BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2. Create 'message_delete' table for "Delete for Me"
CREATE TABLE IF NOT EXISTS message_delete (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(message_id, user_id)
);

-- Index for performance when filtering messages
CREATE INDEX IF NOT EXISTS idx_message_delete_user_msg ON message_delete(user_id, message_id);
