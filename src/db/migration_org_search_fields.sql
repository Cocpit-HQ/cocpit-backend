-- migration_org_search_fields.sql
-- Adds sector to organizations.

BEGIN;

-- Extend organizations with sector
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS sector VARCHAR(100) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_sector
  ON organizations (sector) WHERE sector IS NOT NULL;

COMMIT;

