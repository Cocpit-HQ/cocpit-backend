-- Analytics Backend Migration
-- Creates new tables and adds columns for the analytics tracking features.

-- 1. Create `resume_view_events` table
CREATE TABLE IF NOT EXISTS resume_view_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resume_id UUID REFERENCES user_resumes(resume_id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    viewer_company_org_id UUID,
    event_type VARCHAR(20) CHECK (event_type IN ('view', 'download')),
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resume_views_resume_id ON resume_view_events(resume_id, created_at DESC);

-- 1b. Create missing `organization_profile_views` table
CREATE TABLE IF NOT EXISTS organization_profile_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    profile_owner_id UUID NOT NULL,
    profile_type VARCHAR(50) NOT NULL,
    viewed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_profile_views_org_id ON organization_profile_views(organization_id, viewed_at DESC);

-- 2. Create `profile_analytics_daily` table
CREATE TABLE IF NOT EXISTS profile_analytics_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_owner_id UUID NOT NULL,
    profile_type VARCHAR(20) NOT NULL CHECK (profile_type IN ('user', 'organization')),
    date DATE NOT NULL,
    profile_views INT DEFAULT 0,
    search_appearances INT DEFAULT 0,
    new_followers INT DEFAULT 0,
    new_connections INT DEFAULT 0,
    post_impressions INT DEFAULT 0,
    UNIQUE (profile_owner_id, profile_type, date)
);
CREATE INDEX IF NOT EXISTS idx_pad_owner_date ON profile_analytics_daily(profile_owner_id, date DESC);

-- 3. Create `post_analytics_daily` table
CREATE TABLE IF NOT EXISTS post_analytics_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    impressions INT DEFAULT 0,
    likes INT DEFAULT 0,
    comments INT DEFAULT 0,
    shares INT DEFAULT 0,
    saves INT DEFAULT 0,
    UNIQUE (post_id, date)
);
CREATE INDEX IF NOT EXISTS idx_post_analytics_post_date ON post_analytics_daily(post_id, date DESC);

-- 4. Add columns to existing tables
-- Adding columns safely by checking if they exist using DO block
DO $$ 
BEGIN 
    -- profile_views
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profile_views' AND column_name = 'viewer_industry') THEN
        ALTER TABLE profile_views ADD COLUMN viewer_industry VARCHAR(100);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profile_views' AND column_name = 'viewer_company_org_id') THEN
        ALTER TABLE profile_views ADD COLUMN viewer_company_org_id UUID;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profile_views' AND column_name = 'source') THEN
        ALTER TABLE profile_views ADD COLUMN source VARCHAR(50);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profile_views' AND column_name = 'source_post_id') THEN
        ALTER TABLE profile_views ADD COLUMN source_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL;
    END IF;

    -- post_impressions
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'post_impressions' AND column_name = 'view_date') THEN
        ALTER TABLE post_impressions ADD COLUMN view_date DATE;
    END IF;
    -- Backfill view_date for existing rows (G4)
    UPDATE post_impressions SET view_date = DATE(created_at) WHERE view_date IS NULL;

    -- user_resumes
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_resumes' AND column_name = 'view_count') THEN
        ALTER TABLE user_resumes ADD COLUMN view_count INT DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_resumes' AND column_name = 'download_count') THEN
        ALTER TABLE user_resumes ADD COLUMN download_count INT DEFAULT 0;
    END IF;

    -- resume_view_events
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'resume_view_events' AND column_name = 'viewer_company_org_id') THEN
        ALTER TABLE resume_view_events ADD COLUMN viewer_company_org_id UUID;
    END IF;

    -- followers
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'followers' AND column_name = 'source_post_id') THEN
        ALTER TABLE followers ADD COLUMN source_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL;
    END IF;
    -- organization_followers
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_followers' AND column_name = 'source_post_id') THEN
        ALTER TABLE organization_followers ADD COLUMN source_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL;
    END IF;

    -- organization_user_follows
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_user_follows' AND column_name = 'source_post_id') THEN
        ALTER TABLE organization_user_follows ADD COLUMN source_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL;
    END IF;

    -- organization_org_follows
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization_org_follows' AND column_name = 'source_post_id') THEN
        ALTER TABLE organization_org_follows ADD COLUMN source_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL;
    END IF;
END $$;

-- Prevent concurrent duplicate org profile views (atomic deduplication)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'uq_org_profile_views_24h' 
    AND conrelid = 'organization_profile_views'::regclass
  ) THEN
    -- Note: A full unique constraint requires a different approach since we allow
    -- one view per org per profile per day. Use a partial unique index instead:
    -- This prevents true duplicates at the DB level using a date-truncated unique index.
    EXECUTE $idx$
      CREATE UNIQUE INDEX IF NOT EXISTS uq_org_profile_view_daily
      ON organization_profile_views (organization_id, profile_owner_id, profile_type, DATE(viewed_at));
    $idx$;
  END IF;
END $$;
