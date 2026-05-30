-- ─────────────────────────────────────────────────────────────────────────────
-- Migration : 002_create_feed_events
-- Table     : feed_events
-- Purpose   : Tracks every user interaction with feed items:
--             impressions, clicks, likes, comments, skips, and dwell time.
--             This is the primary behavioral signal table for the feed.
-- Author    : Dev A  |  Sprint Day 1  |  COCPIT Feed System
-- Date      : 2026-05-23
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- UP — apply migration
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Allowed event_type values.
-- Use a CHECK constraint rather than an ENUM so we can add new types via a
-- simple migration without a full table rewrite.
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

-- ── Indexes ───────────────────────────────────────────────────────────────────

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

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- DOWN — rollback migration
-- ══════════════════════════════════════════════════════════════════════════════

-- BEGIN;
-- DROP INDEX  IF EXISTS idx_feed_events_type_timestamp;
-- DROP INDEX  IF EXISTS idx_feed_events_item_type;
-- DROP INDEX  IF EXISTS idx_feed_events_session_timestamp;
-- DROP INDEX  IF EXISTS idx_feed_events_user_timestamp;
-- DROP TABLE  IF EXISTS feed_events;
-- COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- Verification queries
-- ══════════════════════════════════════════════════════════════════════════════

-- Confirm table exists:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'feed_events';

-- Confirm columns and types:
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'feed_events'
--  ORDER BY ordinal_position;

-- Confirm indexes:
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'feed_events';

-- Confirm CHECK constraints:
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'feed_events'::regclass AND contype = 'c';
