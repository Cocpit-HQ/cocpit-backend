-- Migration: Fix shared_post_id constraint to allow post deletion
-- This allows account deletion to work when users have posts shared in messages

-- Drop the existing constraint
ALTER TABLE messages 
DROP CONSTRAINT IF EXISTS messages_shared_post_id_fkey;

-- Recreate with ON DELETE SET NULL
ALTER TABLE messages 
ADD CONSTRAINT messages_shared_post_id_fkey 
FOREIGN KEY (shared_post_id) 
REFERENCES posts(post_id) 
ON DELETE SET NULL;
