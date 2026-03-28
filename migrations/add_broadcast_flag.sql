-- Migration: Add broadcast flag to posts table
-- Enables parent org admins to send posts that fan-out to all child org member feeds

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS is_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS broadcast_scope VARCHAR(20) DEFAULT 'CHILDREN';

-- Index to efficiently filter broadcast posts by org
CREATE INDEX IF NOT EXISTS idx_posts_broadcast ON posts (author_org_id, is_broadcast, created_at DESC)
  WHERE is_broadcast = TRUE;

-- Index to efficiently find parent org for a given user's memberships (used in feed query)
CREATE INDEX IF NOT EXISTS idx_org_members_user_status ON organization_members (user_id, status)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_org_parent ON organizations (parent_org_id)
  WHERE parent_org_id IS NOT NULL AND is_deleted = FALSE;
