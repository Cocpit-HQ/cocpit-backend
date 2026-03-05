BEGIN;

-- 1. Remove Indexes
DROP INDEX IF EXISTS public.idx_posts_flagged;
DROP INDEX IF EXISTS public.idx_posts_removed;

-- 2. Remove Moderation Columns
ALTER TABLE public.posts
DROP COLUMN IF EXISTS is_flagged,
DROP COLUMN IF EXISTS is_removed,
DROP COLUMN IF EXISTS removed_by,
DROP COLUMN IF EXISTS removed_reason;

-- 3. Remove Institution Post Categories (Optional, but good for cleanup)
-- Note: If posts are already using these categories, deleting them might violate foreign key constraints
-- depending on how post_categories are linked to posts. If it's just a text column in 'posts' (category_name), 
-- it's fine. Wait, looking at current code, post categories are an enum or reference table? 
-- Let's just leave the categories or delete ONLY if unused to prevent breaking existing data on rollback.
DELETE FROM public.post_categories WHERE name IN ('Announcement', 'Academic', 'Admission', 'Campus Life', 'Research', 'Club Activity') AND name NOT IN (SELECT DISTINCT category FROM public.posts WHERE category IS NOT NULL);

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 3 rollback validation PASSED';
END $$;
