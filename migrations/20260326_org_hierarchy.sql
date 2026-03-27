-- Migration: Organization Hierarchy (parent_org_id)
-- Date: 2026-03-26
-- Reviewed & approved via org_hierarchy_review.md

-- --------------------------------------------------------
-- Step 1: Add parent_org_id to organizations
-- ON DELETE SET NULL: if parent is deleted, children become top-level orgs
-- --------------------------------------------------------
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS parent_org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL;

-- --------------------------------------------------------
-- Step 2: Partial index — only covers rows that HAVE a parent
-- Keeps the index small and always useful for children lookups
-- --------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orgs_parent_id
ON organizations(parent_org_id)
WHERE parent_org_id IS NOT NULL AND is_deleted = FALSE;

-- --------------------------------------------------------
-- Step 3: org_parent_requests — approval flow for hierarchy association
-- UNIQUE(child_org_id) prevents conflicting simultaneous requests
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_parent_requests (
    request_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    child_org_id  UUID         NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    parent_org_id UUID         NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    requested_by  UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status        VARCHAR(20)  DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
    message       TEXT,
    created_at    TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW(),
    -- Only one active request per child org at any time
    UNIQUE(child_org_id)
);

-- Index for parent org to quickly fetch incoming requests
CREATE INDEX IF NOT EXISTS idx_opr_parent_org
ON org_parent_requests(parent_org_id, status);

-- Trigger: keep updated_at fresh on status changes
CREATE OR REPLACE FUNCTION update_opr_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_opr_updated_at
    BEFORE UPDATE ON org_parent_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_opr_updated_at();
