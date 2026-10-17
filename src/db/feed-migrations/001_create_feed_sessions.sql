-- ─────────────────────────────────────────────────────────────────────────────
-- Migration : 001_create_feed_sessions
-- Table     : feed_sessions
-- Purpose   : Stores feed session state, infinite-scroll cursors,
--             session recovery data, and per-session exploration flags.
-- Author    : Dev A  |  Sprint Day 1  |  COCPIT Feed System
-- Date      : 2026-05-23
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- UP — apply migration
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- ensures gen_random_uuid() is available

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

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access pattern: look up active sessions for a user, filter expired ones.
CREATE INDEX IF NOT EXISTS idx_feed_sessions_user_expires
    ON feed_sessions (user_id, expires_at);

-- Speed up "find latest session for user" queries.
CREATE INDEX IF NOT EXISTS idx_feed_sessions_user_last_active
    ON feed_sessions (user_id, last_active_at DESC);

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- DOWN — rollback migration
-- ══════════════════════════════════════════════════════════════════════════════

-- Run this block manually or via a migration runner when rolling back.
--
-- BEGIN;
-- DROP INDEX  IF EXISTS idx_feed_sessions_user_last_active;
-- DROP INDEX  IF EXISTS idx_feed_sessions_user_expires;
-- DROP TABLE  IF EXISTS feed_sessions;
-- COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- Verification queries (uncomment after applying to confirm state)
-- ══════════════════════════════════════════════════════════════════════════════

-- Confirm table exists:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'feed_sessions';

-- Confirm columns:
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'feed_sessions'
--  ORDER BY ordinal_position;

-- Confirm indexes:
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'feed_sessions';
