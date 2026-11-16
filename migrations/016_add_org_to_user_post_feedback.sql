-- Migration 016: Add org_id and organization-level tracking to user_post_feedback

DO $$
BEGIN
    -- 1. Add org_id column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_post_feedback' AND column_name = 'org_id'
    ) THEN
        ALTER TABLE user_post_feedback 
        ADD COLUMN org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE DEFAULT NULL;
    END IF;

    -- 2. Add id surrogate primary key column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_post_feedback' AND column_name = 'id'
    ) THEN
        ALTER TABLE user_post_feedback 
        ADD COLUMN id UUID DEFAULT gen_random_uuid();
    END IF;

    -- 3. Drop existing composite primary key if present
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'user_post_feedback_pkey'
    ) THEN
        ALTER TABLE user_post_feedback DROP CONSTRAINT user_post_feedback_pkey;
    END IF;

    -- 4. Set id as PRIMARY KEY
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'user_post_feedback_pkey'
    ) THEN
        ALTER TABLE user_post_feedback ADD CONSTRAINT user_post_feedback_pkey PRIMARY KEY (id);
    END IF;
END $$;

-- 5. Create unique indexes matching reports pattern:
-- Separate uniqueness for individual user feedback vs organization actor feedback
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_post_feedback_personal 
ON user_post_feedback (user_id, post_id) 
WHERE org_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_post_feedback_org 
ON user_post_feedback (org_id, post_id) 
WHERE org_id IS NOT NULL;

-- 6. Exclusion indexes for rapid feed & profile queries
CREATE INDEX IF NOT EXISTS idx_user_post_feedback_filter_org 
ON user_post_feedback (org_id, post_id) 
WHERE feedback_type = 'NOT_INTERESTED';

CREATE INDEX IF NOT EXISTS idx_user_post_feedback_filter_user 
ON user_post_feedback (user_id, post_id) 
WHERE org_id IS NULL AND feedback_type = 'NOT_INTERESTED';

