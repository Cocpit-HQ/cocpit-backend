-- 004_add_message_reads.sql
-- Created for Group Chat Read Receipts

CREATE TABLE IF NOT EXISTS message_reads (
  message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Index for counting unread messages efficiently
-- (Finding messages for a user that are NOT in this table is the main query)
-- The PK covers (message_id, user_id), but we might want to query by user_id efficiently 
-- to find all messages read by a user (e.g. for analytics or cleanup)
CREATE INDEX IF NOT EXISTS idx_message_reads_user_id ON message_reads(user_id);

-- Index for "Seen by" feature (finding all users who read a specific message)
-- The PK (message_id, user_id) already covers efficient lookup by message_id.
