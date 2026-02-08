-- Add role column to conversation_participants
ALTER TABLE conversation_participants 
ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member' CHECK (role IN ('member', 'admin'));

-- Set existing admins
UPDATE conversation_participants cp
SET role = 'admin'
FROM conversations c
WHERE cp.conversation_id = c.conversation_id 
AND cp.user_id = c.admin_id;
