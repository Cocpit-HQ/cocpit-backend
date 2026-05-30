-- ─────────────────────────────────────────────────────────────────────────────
-- Migration : 003_create_feed_candidate_pool
-- Table     : feed_candidate_pool
-- Purpose   : Debug / observability table that snapshots candidate items
--             considered for a user's feed at generation time.
--             Enables offline analysis of candidate generation and ranking
--             without exposing internals in production query paths.
-- Author    : Dev A  |  Sprint Day 1  |  COCPIT Feed System
-- Date      : 2026-05-23
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- UP — apply migration
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS feed_candidate_pool (
    -- ── Identity ──────────────────────────────────────────────────────────────
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ── Ownership ─────────────────────────────────────────────────────────────
    user_id          UUID        NOT NULL,

    -- ── Candidate item ────────────────────────────────────────────────────────
    item_id          UUID        NOT NULL,
    item_type        TEXT        NOT NULL
        CONSTRAINT chk_candidate_item_type CHECK (
            item_type IN (
                'post',
                'project',
                'job',
                'profile',
                'article',
                'event',
                'ad'
            )
        ),

    -- ── Retrieval provenance ──────────────────────────────────────────────────
    -- Where this candidate came from, e.g.:
    --   'network_posts', 'trending', 'collaborative_filter',
    --   'keyword_match', 'editorial', 'promoted'
    source           TEXT        NOT NULL,

    -- ── Ranking signal snapshot ───────────────────────────────────────────────
    -- Raw composite score at generation time (higher = more relevant).
    -- DOUBLE PRECISION for sub-cent precision without float rounding issues.
    score            DOUBLE PRECISION
        CONSTRAINT chk_score_range CHECK (score IS NULL OR (score >= 0.0 AND score <= 1.0)),

    -- Human-readable explanation of why this candidate was selected.
    -- e.g. "Top post from 2nd-degree connection with 3 mutual followers"
    reason           TEXT,

    -- ── Lifecycle ─────────────────────────────────────────────────────────────
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- ── Extensible metadata ───────────────────────────────────────────────────
    -- Any extra ranking signals, feature values, or debug info the
    -- candidate pipeline wants to store (e.g., freshness_score, author_affinity).
    metadata         JSONB       NOT NULL DEFAULT '{}'
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary query pattern: "what candidates were generated for user X, most recent first?"
CREATE INDEX IF NOT EXISTS idx_feed_candidate_pool_user_created
    ON feed_candidate_pool (user_id, created_at DESC);

-- Candidate-level lookups: "how often does item Y appear as a candidate for any user?"
CREATE INDEX IF NOT EXISTS idx_feed_candidate_pool_item_created
    ON feed_candidate_pool (item_id, created_at DESC);

-- Source-level analysis: "how many candidates came from 'trending' in the last hour?"
CREATE INDEX IF NOT EXISTS idx_feed_candidate_pool_source_created
    ON feed_candidate_pool (source, created_at DESC);

-- Score distribution analysis / threshold debugging
CREATE INDEX IF NOT EXISTS idx_feed_candidate_pool_user_score
    ON feed_candidate_pool (user_id, score DESC NULLS LAST);

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- DOWN — rollback migration
-- ══════════════════════════════════════════════════════════════════════════════

-- BEGIN;
-- DROP INDEX  IF EXISTS idx_feed_candidate_pool_user_score;
-- DROP INDEX  IF EXISTS idx_feed_candidate_pool_source_created;
-- DROP INDEX  IF EXISTS idx_feed_candidate_pool_item_created;
-- DROP INDEX  IF EXISTS idx_feed_candidate_pool_user_created;
-- DROP TABLE  IF EXISTS feed_candidate_pool;
-- COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- Verification queries
-- ══════════════════════════════════════════════════════════════════════════════

-- Confirm table exists:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'feed_candidate_pool';

-- Confirm columns and types:
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'feed_candidate_pool'
--  ORDER BY ordinal_position;

-- Confirm indexes:
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'feed_candidate_pool';

-- Inspect score distribution (run after seeding test data):
-- SELECT MIN(score), MAX(score), AVG(score), COUNT(*) FROM feed_candidate_pool;
