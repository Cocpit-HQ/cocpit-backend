-- Migration 021: Add trigram indexes on organizations headline and description for specific search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_organizations_headline_trgm 
ON organizations USING GIN (headline gin_trgm_ops) 
WHERE headline IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_description_trgm 
ON organizations USING GIN (description gin_trgm_ops) 
WHERE description IS NOT NULL;
