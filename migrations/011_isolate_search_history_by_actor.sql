-- ==============================================================================
-- Migration: 011_isolate_search_history_by_actor.sql
-- Description: Isolates user search history between Personal and Business/Org accounts
-- Jira: SCRUM-1039 (Parent: SCRUM-114 Business Profile)
-- ==============================================================================

BEGIN;

-- 1. Add org_id column referencing organizations
ALTER TABLE user_search_history 
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- 2. Drop legacy single-user unique index
DROP INDEX IF EXISTS uq_user_search_history_user_query;

-- 3. Create actor-aware unique index supporting NULL org_id via COALESCE
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_search_history_actor_query 
ON user_search_history (
    user_id, 
    COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), 
    query_normalized
);

-- 4. Create composite lookup index for performance
CREATE INDEX IF NOT EXISTS idx_user_search_history_actor_created 
ON user_search_history (user_id, org_id, created_at DESC);

COMMIT;
