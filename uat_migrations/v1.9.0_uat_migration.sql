-- ==============================================================================
-- UAT Migration v1.9.0
-- Target Database: cocpit_backend_uat (also applied to staging/production)
-- Prepared Date:  2026-10-30
-- Description: Mixed-Media Carousels (Images & Videos) support in post_media.
--              Adds order_index, thumbnail_url, and duration_seconds columns,
--              backfills order_index for existing records, and creates
--              composite index for deterministic ordering.
--
-- Reference:
--   - schema.sql (Lines 475-487)
--   - uat_schema.sql
-- ==============================================================================

BEGIN;

-- 1. Add order_index column for deterministic carousel slide sequencing
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0;

-- 2. Add thumbnail_url for video slide posters
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- 3. Add duration_seconds for video slide length
ALTER TABLE post_media 
    ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(6,2);

-- 4. Backfill existing records that have NULL order_index using row_number() over (PARTITION BY post_id ORDER BY media_id)
WITH ranked_media AS (
    SELECT media_id, ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY media_id) - 1 AS calc_order
    FROM post_media
    WHERE order_index IS NULL
)
UPDATE post_media pm
SET order_index = rm.calc_order
FROM ranked_media rm
WHERE pm.media_id = rm.media_id;

-- 5. Create index on (post_id, order_index) for fast ordered retrieval
CREATE INDEX IF NOT EXISTS idx_post_media_post_order ON post_media(post_id, order_index);

COMMIT;

