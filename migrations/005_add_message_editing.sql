-- Add editing support to messages table
ALTER TABLE messages
ADD COLUMN edited_at TIMESTAMP DEFAULT NULL,
ADD COLUMN is_edited BOOLEAN DEFAULT FALSE;
