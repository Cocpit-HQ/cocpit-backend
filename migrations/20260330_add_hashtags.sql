-- 1. Create hashtags table
CREATE TABLE IF NOT EXISTS hashtags (
    hashtag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag VARCHAR(30) UNIQUE NOT NULL,
    type VARCHAR(20) DEFAULT 'normal' CHECK (type IN ('normal', 'intent')),
    usage_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Lowercase tag indexing
CREATE UNIQUE INDEX IF NOT EXISTS idx_hashtags_name ON hashtags(LOWER(tag));

-- 2. Create post_hashtags table
CREATE TABLE IF NOT EXISTS post_hashtags (
    post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
    hashtag_id UUID REFERENCES hashtags(hashtag_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (post_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag_id ON post_hashtags(hashtag_id);

-- 3. Update posts indexes if missing (crucial for my posts & visibility checks)
CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visibility_broadcast ON posts(visibility, is_broadcast) INCLUDE (post_id);

-- 4. Enhance event_outbox for robustness
ALTER TABLE event_outbox 
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_event_outbox_retry 
ON event_outbox(status, next_retry_at) 
WHERE status = 'PENDING';
