-- ==============================================================================
-- Migration: 019_add_hashtag_search_indexes.sql
-- Enables GIN trigram and B-Tree sorting indexes for COCPIT Hashtag Global Search.
-- Accelerates:
--   1. Trigram ILIKE substring search (LOWER(tag))
--   2. Most Popular sort (posts_count DESC)
--   3. Most Used sort (usage_count DESC)
--   4. Recently Added sort (created_at DESC)
--   5. Trending sort (last_used_at DESC)
-- ==============================================================================

BEGIN;

-- 1. Ensure Trigram Extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Trigram GIN index for fast substring/prefix match on hashtags
CREATE INDEX IF NOT EXISTS idx_hashtags_tag_trgm 
ON hashtags USING GIN (tag gin_trgm_ops);

-- 3. Composite B-Tree indexes for multi-mode sorting without sort overhead
CREATE INDEX IF NOT EXISTS idx_hashtags_posts_count 
ON hashtags (posts_count DESC, usage_count DESC);

CREATE INDEX IF NOT EXISTS idx_hashtags_usage_count 
ON hashtags (usage_count DESC, posts_count DESC);

CREATE INDEX IF NOT EXISTS idx_hashtags_created_at 
ON hashtags (created_at DESC, hashtag_id DESC);

CREATE INDEX IF NOT EXISTS idx_hashtags_last_used_at 
ON hashtags (last_used_at DESC NULLS LAST);

COMMIT;

