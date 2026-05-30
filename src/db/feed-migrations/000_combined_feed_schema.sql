-- ─────────────────────────────────────────────────────────────────────────────
-- Migration : combined_feed_schema
-- Purpose   : Consolidates feed sessions, events, and candidate pool tables
--             into a single unified initial migration script.
-- Author    : Dev A  |  Sprint Day 1  |  COCPIT Feed System
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- UP — apply migration
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- ensures gen_random_uuid() is available

-- ==============================================================================
-- Table: feed_sessions
-- ==============================================================================
CREATE TABLE IF NOT EXISTS feed_sessions (
    -- ── Identity ──────────────────────────────────────────────────────────────
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ── Ownership ─────────────────────────────────────────────────────────────
    -- Soft FK: references users(id). No hard constraint so the feed system
    -- can operate independently of the users table schema.
    user_id          UUID        NOT NULL,

    -- ── Pagination state ──────────────────────────────────────────────────────
    -- Opaque cursor used for infinite-scroll; typically encodes last seen
    -- item id + score so the feed can resume from exactly this point.
    cursor           TEXT,

    -- ── Session context ───────────────────────────────────────────────────────
    -- Arbitrary JSON blob: device type, app version, locale, A/B cohort, etc.
    -- Stored as JSONB for indexing & querying individual keys if needed later.
    context          JSONB       NOT NULL DEFAULT '{}',

    -- ── Feed state ────────────────────────────────────────────────────────────
    seen_count           INTEGER     NOT NULL DEFAULT 0
        CONSTRAINT chk_seen_count_non_negative CHECK (seen_count >= 0),
    exploration_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,

    -- ── Lifecycle timestamps ──────────────────────────────────────────────────
    started_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT (NOW() + INTERVAL '24 hours'),
    last_active_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- ── Integrity guard ───────────────────────────────────────────────────────
    CONSTRAINT chk_session_expiry CHECK (expires_at > started_at)
);

-- Primary access pattern: look up active sessions for a user, filter expired ones.
CREATE INDEX IF NOT EXISTS idx_feed_sessions_user_expires
    ON feed_sessions (user_id, expires_at);

-- Speed up "find latest session for user" queries.
CREATE INDEX IF NOT EXISTS idx_feed_sessions_user_last_active
    ON feed_sessions (user_id, last_active_at DESC);


-- ==============================================================================
-- Table: feed_events
-- ==============================================================================
-- Tracks every user interaction with feed items:
-- impressions, clicks, likes, comments, skips, and dwell time.
CREATE TABLE IF NOT EXISTS feed_events (
    -- ── Identity ──────────────────────────────────────────────────────────────
    event_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ── Event classification ──────────────────────────────────────────────────
    event_type       TEXT        NOT NULL
        CONSTRAINT chk_event_type CHECK (
            event_type IN (
                'impression',
                'click',
                'like',
                'unlike',
                'comment',
                'skip',
                'share',
                'save',
                'report',
                'dwell'
            )
        ),

    -- ── Subject (what was acted upon) ─────────────────────────────────────────
    item_id          UUID        NOT NULL,
    item_type        TEXT        NOT NULL
        CONSTRAINT chk_item_type CHECK (
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

    -- ── Actor (who performed the action) ──────────────────────────────────────
    -- Soft FKs — no hard references to keep feed tables decoupled.
    user_id          UUID        NOT NULL,
    session_id       UUID        NOT NULL,   -- references feed_sessions(id)

    -- ── Feed position context ─────────────────────────────────────────────────
    -- 0-indexed position of the item in the rendered feed at the time of event.
    position         INTEGER
        CONSTRAINT chk_position_non_negative CHECK (position IS NULL OR position >= 0),

    -- ── Engagement signals ────────────────────────────────────────────────────
    -- Milliseconds the item was visible before the event (meaningful for
    -- 'dwell' and 'skip' events; NULL for clicks / likes / etc.).
    dwell_ms         INTEGER
        CONSTRAINT chk_dwell_ms_non_negative CHECK (dwell_ms IS NULL OR dwell_ms >= 0),

    -- ── Slot metadata ─────────────────────────────────────────────────────────
    -- Which feed slot type rendered this item: 'organic', 'promoted', 'explore', etc.
    slot_type        TEXT,

    -- ── Timing ────────────────────────────────────────────────────────────────
    -- Client-reported event time (may differ from server ingestion time).
    timestamp        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- ── Flexible context / metadata ───────────────────────────────────────────
    -- context  : rendering context (viewport size, network type, theme, etc.)
    -- metadata : event-specific extra data (comment text preview, share target, etc.)
    context          JSONB       NOT NULL DEFAULT '{}',
    metadata         JSONB       NOT NULL DEFAULT '{}'
);

-- Primary query pattern: "all events for user X, ordered by time"
CREATE INDEX IF NOT EXISTS idx_feed_events_user_timestamp
    ON feed_events (user_id, timestamp DESC);

-- Session-scoped event replay / debugging
CREATE INDEX IF NOT EXISTS idx_feed_events_session_timestamp
    ON feed_events (session_id, timestamp DESC);

-- Item-level analytics: "how many impressions / likes for item Y?"
CREATE INDEX IF NOT EXISTS idx_feed_events_item_type
    ON feed_events (item_id, event_type);

-- Event-type bucketing for aggregations (e.g., total likes in last 7 days)
CREATE INDEX IF NOT EXISTS idx_feed_events_type_timestamp
    ON feed_events (event_type, timestamp DESC);


-- ==============================================================================
-- Table: feed_candidate_pool
-- ==============================================================================
-- Debug / observability table that snapshots candidate items considered 
-- for a user's feed at generation time.
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

-- DROP INDEX  IF EXISTS idx_feed_events_type_timestamp;
-- DROP INDEX  IF EXISTS idx_feed_events_item_type;
-- DROP INDEX  IF EXISTS idx_feed_events_session_timestamp;
-- DROP INDEX  IF EXISTS idx_feed_events_user_timestamp;
-- DROP TABLE  IF EXISTS feed_events;

-- DROP INDEX  IF EXISTS idx_feed_sessions_user_last_active;
-- DROP INDEX  IF EXISTS idx_feed_sessions_user_expires;
-- DROP TABLE  IF EXISTS feed_sessions;
-- COMMIT;
