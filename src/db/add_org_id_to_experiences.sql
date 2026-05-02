-- Migration: Add org_id to experiences table
-- This allows linking experiences to official organizations on the platform.

ALTER TABLE experiences ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL;

-- Index for performance when joining with organizations
CREATE INDEX IF NOT EXISTS idx_experiences_org_id ON experiences(org_id);
