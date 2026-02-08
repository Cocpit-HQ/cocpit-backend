-- Add deletion flags to messages table (for "Delete for Everyone")
ALTER TABLE messages
ADD COLUMN is_deleted_for_everyone BOOLEAN DEFAULT FALSE,
ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Create table for per-user deletion ("Delete for Me")
CREATE TABLE message_delete (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(message_id, user_id)
);

-- Index for efficient lookup of deleted messages per user
CREATE INDEX idx_message_delete_user_id ON message_delete(user_id);
