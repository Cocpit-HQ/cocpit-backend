-- ─────────────────────────────────────────────────────────────────────────────
-- Migration : achievement_images
-- Purpose   : Creates the achievement_images table for shared Cloudinary
--             achievement assets, and adds a nullable FK to posts.
-- Author    : Dev  |  Achievement Image Refactor
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- UP — apply migration
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ==============================================================================
-- Table: achievement_images
-- ==============================================================================
-- Stores predefined achievement images uploaded to Cloudinary exactly once.
-- Each row represents a shared asset that many posts can reference via FK.
CREATE TABLE IF NOT EXISTS achievement_images (
    id              SERIAL PRIMARY KEY,
    key             VARCHAR(100) UNIQUE NOT NULL,
    title           VARCHAR(255) NOT NULL,
    cloudinary_url  TEXT NOT NULL,
    display_order   INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by key (used during seed idempotency check)
CREATE INDEX IF NOT EXISTS idx_achievement_images_key
    ON achievement_images(key);

-- Picker ordering: active images sorted by display_order
CREATE INDEX IF NOT EXISTS idx_achievement_images_active_order
    ON achievement_images(is_active, display_order)
    WHERE is_active = TRUE;

-- ==============================================================================
-- Extend: posts table — add nullable achievement_image_id FK
-- ==============================================================================
-- This is a backward-compatible additive change.
-- Existing posts will have achievement_image_id = NULL.
-- Only new predefined achievement posts will populate this column.
ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS achievement_image_id
    INTEGER REFERENCES achievement_images(id);

-- Partial index for posts that reference a shared achievement image
CREATE INDEX IF NOT EXISTS idx_posts_achievement_image_id
    ON posts(achievement_image_id)
    WHERE achievement_image_id IS NOT NULL;

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- DOWN — rollback migration
-- ══════════════════════════════════════════════════════════════════════════════

-- BEGIN;
-- ALTER TABLE posts DROP COLUMN IF EXISTS achievement_image_id;
-- DROP INDEX IF EXISTS idx_posts_achievement_image_id;
-- DROP INDEX IF EXISTS idx_achievement_images_active_order;
-- DROP INDEX IF EXISTS idx_achievement_images_key;
-- DROP TABLE IF EXISTS achievement_images;
-- COMMIT;
