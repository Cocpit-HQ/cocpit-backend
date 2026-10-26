-- Additive feed-media processing fields. Apply through the normal migration process.
ALTER TABLE post_media ADD COLUMN IF NOT EXISTS fallback_url TEXT;
ALTER TABLE post_media ADD COLUMN IF NOT EXISTS avif_url TEXT;
ALTER TABLE post_media ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE post_media ADD COLUMN IF NOT EXISTS processing_error TEXT;

DO $$ BEGIN
  ALTER TABLE post_media ADD CONSTRAINT post_media_processing_status_check
    CHECK (processing_status IN ('processing', 'ready', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
