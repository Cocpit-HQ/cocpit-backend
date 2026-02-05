-- Add last_message details to conversations table for better performance and sorting
ALTER TABLE conversations
ADD COLUMN last_message TEXT,
ADD COLUMN last_message_at TIMESTAMPTZ DEFAULT now();

-- Update existing conversations to have a default value (optional, can be better populated via script)
UPDATE conversations
SET last_message_at = updated_at
WHERE last_message_at IS NULL;
