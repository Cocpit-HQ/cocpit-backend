-- Migration: Strict Bidirectional Connection Requests
-- Purpose: Prevent A->B and B->A pending requests simultaneously to avoid race conditions.

-- 1. Create a unique index on the pair of users for pending requests regardless of direction
-- We use LEAST and GREATEST to normalize the pair (A,B) and (B,A) to be the same.
CREATE UNIQUE INDEX IF NOT EXISTS connection_requests_bidirectional_idx 
ON connection_requests (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
WHERE status = 'pending';

-- 2. Add an index for quick lookup of cooldowns/blocks
CREATE INDEX IF NOT EXISTS connection_requests_cooldown_idx 
ON connection_requests (sender_id, receiver_id, status, cooldown_until)
WHERE status IN ('rejected', 'blocked');
