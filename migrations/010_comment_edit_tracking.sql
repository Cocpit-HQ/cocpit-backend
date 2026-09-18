-- 010_comment_edit_tracking.sql
-- Add is_edited and ensure updated_at exists on post_comments

ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE;

ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- Recreate active_post_comments view appending updated_at and is_edited at the end to preserve column ordering
CREATE OR REPLACE VIEW active_post_comments AS
SELECT 
    pc.comment_id,
    pc.post_id,
    pc.author_id,
    pc.content,
    pc.created_at,
    pc.parent_id,
    pc.is_pinned,
    pc.pinned_at,
    pc.pinned_by,
    pc.author_org_id,
    pc.pinned_by_org_id,
    pc.updated_at,
    pc.is_edited
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);
