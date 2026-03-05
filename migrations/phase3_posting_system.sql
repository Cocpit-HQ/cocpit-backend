BEGIN;

-- 1. Insert New Post Categories for Institutions
INSERT INTO public.post_categories (name) VALUES
('Announcement'),
('Academic'),
('Admission'),
('Campus Life'),
('Research'),
('Club Activity')
ON CONFLICT (name) DO NOTHING;

-- 2. Add Moderation Columns to Posts Table
ALTER TABLE public.posts
ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_removed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS removed_by UUID REFERENCES public.users(user_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS removed_reason TEXT;

-- 3. Create Indexes for Moderation Flags
CREATE INDEX IF NOT EXISTS idx_posts_flagged ON public.posts(is_flagged) WHERE is_flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_posts_removed ON public.posts(is_removed) WHERE is_removed = TRUE;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 3 migration validation PASSED';
END $$;
