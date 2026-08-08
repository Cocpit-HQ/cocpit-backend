-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums for constrained values (or use lookup tables if mutable)
CREATE TYPE visibility_type AS ENUM ('public', 'connections', 'private');
CREATE TYPE connection_status AS ENUM ('pending', 'connected', 'blocked', 'rejected');
CREATE TYPE job_work_mode AS ENUM ('Remote', 'Hybrid', 'Onsite');
CREATE TYPE job_company_type AS ENUM ('Startup', 'MNC', 'Product-based', 'Service-based');
CREATE TYPE event_type AS ENUM ('Online', 'InPerson');
CREATE TYPE sender_type AS ENUM ('me', 'other'); -- Frontend uses 'me'/'other', but DB should track user_id

ALTER TABLE jobs
ADD CONSTRAINT salary_valid CHECK (salary_min <= salary_max);

CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,       -- Hashed via bcrypt/argon2 in app
  full_name TEXT NOT NULL,
  mobile_number TEXT,
  headline TEXT,
  avatar_url TEXT,
  cover_image_url TEXT,
  job_title TEXT,
  company_name TEXT,
  school TEXT,
  degree TEXT,
  location TEXT,
  location_country TEXT,
  location_state TEXT,
  location_city TEXT,
  location_formatted TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  location_place_id TEXT,
    about_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deletion_scheduled_at TIMESTAMPTZ,
  deletion_execute_at TIMESTAMPTZ,
  is_deactivated BOOLEAN DEFAULT false,
  CONSTRAINT mobile_format CHECK (mobile_number ~ '^[0-9]{10}$')
);


CREATE TABLE roles (
  role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name TEXT UNIQUE NOT NULL -- 'User', 'Recruiter', 'Admin'
);

CREATE TABLE user_roles (
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(role_id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_social_accounts (
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL, -- e.g., 'google', 'apple'
  provider_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX idx_user_social_accounts_user_id ON user_social_accounts(user_id);

CREATE TABLE refresh_tokens (
  token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  session_id UUID UNIQUE NOT NULL, -- Logical session identifier
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked BOOLEAN DEFAULT FALSE,
  user_agent TEXT NOT NULL,
  ip_address INET NOT NULL
);

CREATE TABLE password_reset_tokens (
  token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  used BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- Track devices and link them to specific user sessions and FCM tokens

CREATE TABLE profiles (
  profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  -- Identity Chips
  account_type TEXT NOT NULL CHECK (account_type IN ('Fresher', 'Employee', 'Student', 'Freelancer', 'Employer', 'Admin')),
  open_to TEXT, -- e.g., 'Full-time', 'Freelance'
  availability TEXT, -- e.g., 'Immediate'
  work_preference TEXT, -- e.g., 'Remote', 'Hybrid'
  -- Metrics
  profile_views_count INTEGER DEFAULT 0,
  search_appearances_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE user_resumes (
    resume_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_type TEXT,
    file_size INTEGER,
    uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE skills (
  skill_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE user_skills (
  profile_id UUID REFERENCES profiles(profile_id) ON DELETE CASCADE,
  skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, skill_id)
);

CREATE TABLE experiences (
  experience_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(profile_id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  location TEXT,
  work_type TEXT,
  work_mode TEXT,
  start_date DATE NOT NULL,
  end_date DATE, -- NULL if current
  is_current BOOLEAN DEFAULT FALSE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_experience_date_range CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Index for organization linking performance
CREATE INDEX IF NOT EXISTS idx_experiences_org_id ON experiences(org_id);

-- Enforce only one active role per company at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_role_per_company
    ON experiences (profile_id, LOWER(TRIM(company_name)))
    WHERE is_current = true;

CREATE TABLE experience_skills (
  experience_id UUID REFERENCES experiences(experience_id) ON DELETE CASCADE,
  skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
  PRIMARY KEY (experience_id, skill_id)
);

CREATE TABLE educations (
  education_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(profile_id) ON DELETE CASCADE,
  school_name TEXT NOT NULL,
  school_org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL,
  degree TEXT,
  field_of_study TEXT,
  location TEXT,
  start_date DATE,
  end_date DATE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE post_categories (
  category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL -- 'Personal', 'Professional', 'Achievement' ,'All'
);

-- ---------------------------------------------------------
-- HASHTAG SYSTEM
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS hashtags (
    hashtag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag VARCHAR(30) UNIQUE NOT NULL,
    type VARCHAR(20) DEFAULT 'normal' CHECK (type IN ('normal', 'intent')),
    usage_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Lowercase tag indexing
CREATE UNIQUE INDEX IF NOT EXISTS idx_hashtags_name ON hashtags(LOWER(tag));

-- Junction table for posts and hashtags
CREATE TABLE IF NOT EXISTS post_hashtags (
    post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
    hashtag_id UUID REFERENCES hashtags(hashtag_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (post_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag_id ON post_hashtags(hashtag_id);

-- User-Hashtag scores for recommendation tracking
CREATE TABLE IF NOT EXISTS user_hashtag_scores (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    hashtag_id UUID NOT NULL REFERENCES hashtags(hashtag_id) ON DELETE CASCADE,
    score INT DEFAULT 0 NOT NULL,
    last_updated TIMESTAMP DEFAULT NOW() NOT NULL,
    PRIMARY KEY (user_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS idx_user_hashtag_scores_score ON user_hashtag_scores(score DESC);

-- Predefined Achievement Images
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

CREATE INDEX IF NOT EXISTS idx_achievement_images_key ON achievement_images(key);
CREATE INDEX IF NOT EXISTS idx_achievement_images_active_order ON achievement_images(is_active, display_order) WHERE is_active = TRUE;

CREATE TABLE posts (
  post_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  category_id UUID REFERENCES post_categories(category_id),
  title TEXT,
  content TEXT,
  location TEXT,
  visibility visibility_type DEFAULT 'public',
  shared_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL,
  shared_job_id UUID REFERENCES jobs(job_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  post_type  AS ENUM ('image', 'video', 'article', 'poll') NOT NULL,
  -- Cross-org Broadcast (28/03/2026)
  is_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  broadcast_scope VARCHAR(20) DEFAULT 'CHILDREN',
  -- Predefined achievement image (Optional)
  achievement_image_id INTEGER REFERENCES achievement_images(id)
);

CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visibility_broadcast ON posts(visibility, is_broadcast) INCLUDE (post_id);
CREATE INDEX IF NOT EXISTS idx_posts_achievement_image_id ON posts(achievement_image_id) WHERE achievement_image_id IS NOT NULL;

CREATE TABLE post_polls (
  poll_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL UNIQUE
    REFERENCES posts(post_id) ON DELETE CASCADE,
  duration INTERVAL NOT NULL DEFAULT INTERVAL '7 days',
  allow_multiple_votes BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------
-- COMPANY SYSTEM (Core)
-- ---------------------------------------------------------

CREATE TABLE organizations (
    org_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255),
    industry VARCHAR(100),
    size VARCHAR(50),
    website TEXT,
    location VARCHAR(255),
    slogan TEXT,
    logo_url TEXT,
    cover_url TEXT,
    description TEXT,
        entity_type VARCHAR(20) DEFAULT 'COMPANY' NOT NULL,
    institution_type VARCHAR(50),
    established_year INTEGER,
    campus_location VARCHAR(255),
    verified_edu BOOLEAN DEFAULT FALSE,
    auto_verify_domains VARCHAR(255)[] DEFAULT '{}',
    verification_status VARCHAR(20) DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED', 'DOMAIN_PENDING', 'DOMAIN_VERIFIED', 'REJECTED')),
    email_verified BOOLEAN DEFAULT FALSE,
    phone VARCHAR(20),
    phone_verified BOOLEAN DEFAULT FALSE,
    country VARCHAR(100),
    city VARCHAR(100),
    headline VARCHAR(200),
    created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    onboarding_step VARCHAR(50) DEFAULT 'IDENTITY',
    onboarding_completed BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE INDEX idx_companies_slug ON organizations(slug);
CREATE INDEX idx_companies_website ON organizations(website);
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON organizations USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_organizations_created_by ON organizations(created_by);
CREATE INDEX IF NOT EXISTS idx_organizations_onboarding_completed ON organizations(onboarding_completed) WHERE onboarding_completed = FALSE;

-- Dynamic Roles & Members
CREATE TABLE organization_roles (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color VARCHAR(7) DEFAULT '#808080',
    description TEXT,
    permissions JSONB DEFAULT '[]'::jsonb,
    priority INTEGER DEFAULT 0,
    is_system_role BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS organization_permission_keys (
    permission_key  VARCHAR(100) PRIMARY KEY,
    label           VARCHAR(200) NOT NULL,
    ui_type         VARCHAR(10)  NOT NULL DEFAULT 'toggle'
        CHECK (ui_type IN ('toggle', 'checkbox')),
    parent_key      VARCHAR(100) REFERENCES organization_permission_keys(permission_key),
    requires_parent BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order      INTEGER      NOT NULL DEFAULT 0
);

CREATE TABLE organization_members (
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    role_id UUID REFERENCES organization_roles(role_id) ON DELETE SET NULL,
    role TEXT, -- Deprecated, kept for back-compat if needed
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING_INVITE', 'REMOVED')),
    expires_at TIMESTAMPTZ DEFAULT NULL,
    is_primary_display BOOLEAN DEFAULT FALSE,
    is_role_visible BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (org_id, user_id)
);

CREATE UNIQUE INDEX idx_company_members_user_primary ON organization_members (user_id) WHERE is_primary_display = TRUE;

CREATE TABLE organization_gallery (
  gallery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  type TEXT CHECK (type IN ('image', 'video')),
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE organization_tech_stack (
    stack_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    name TEXT NOT NULL, -- e.g. "React", "Node.js"
    category TEXT, -- e.g. "Frontend", "Backend" (Optional)
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS org_parent_requests (
    request_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    child_org_id  UUID         NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    parent_org_id UUID         NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    requested_by  UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status        VARCHAR(20)  DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
    message       TEXT,
    created_at    TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW(),
    -- Only one active request per child org at any time
    UNIQUE(child_org_id)
);

-- Index for parent org to quickly fetch incoming requests
CREATE INDEX IF NOT EXISTS idx_opr_parent_org
ON org_parent_requests(parent_org_id, status);

-- Trigger: keep updated_at fresh on status changes
CREATE OR REPLACE FUNCTION update_opr_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_opr_updated_at
    BEFORE UPDATE ON org_parent_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_opr_updated_at();

CREATE TABLE poll_options (
  option_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL
    REFERENCES post_polls(poll_id) ON DELETE CASCADE,
  option_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE poll_votes (
    vote_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL
        REFERENCES post_polls(poll_id) ON DELETE CASCADE,
    option_id UUID NOT NULL
        REFERENCES poll_options(option_id) ON DELETE CASCADE,
    voter_id UUID NOT NULL
        REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    -- one vote per poll per user (single-choice)
    UNIQUE (poll_id, voter_id, org_id)
);

CREATE TABLE post_likes (
  like_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(post_id, user_id)
);

CREATE TABLE post_shares (
  share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);


CREATE TABLE post_comments (
  comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  parent_id UUID NULL REFERENCES post_comments(comment_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  is_pinned BOOLEAN DEFAULT false,
  pinned_at TIMESTAMPTZ NULL,
  pinned_by UUID NULL REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE INDEX idx_post_comments_parent_id ON post_comments(parent_id);
CREATE INDEX idx_post_comments_is_pinned ON post_comments(is_pinned, pinned_at DESC);

CREATE TABLE comment_likes (
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  comment_id UUID REFERENCES post_comments(comment_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, comment_id)
);

CREATE INDEX idx_comment_likes_comment_id ON comment_likes(comment_id);
CREATE INDEX idx_comment_likes_user_id ON comment_likes(user_id);


CREATE TABLE post_media (
  media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
 media_type TEXT CHECK (media_type IN ('image', 'video')),
  aspect_ratio TEXT -- e.g., '4:5'
);

CREATE TABLE stories (
  story_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT,
  media_url TEXT NOT NULL,
  media_type TEXT CHECK (media_type IN ('image', 'video')) DEFAULT 'image',
  description TEXT,
  cld_public_id TEXT,
  shared_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL,
  story_metadata JSONB DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL, -- usually created_at + 24h
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stories_metadata_job_type 
ON stories ((story_metadata->>'type')) 
WHERE (story_metadata->>'type' = 'job');

CREATE TABLE story_views (
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  viewer_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  viewer_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ DEFAULT now()
  -- Removed PK (story_id, viewer_id) to allow same user to view as company
);

-- Index for Personal Views (Unique per user if not acting as company)
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_views_personal_unique 
ON story_views (story_id, viewer_id) 
WHERE viewer_org_id IS NULL;

-- Index for Company Views (Unique per company, regardless of which member viewed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_views_company_unique 
ON story_views (story_id, viewer_org_id) 
WHERE viewer_org_id IS NOT NULL;

CREATE TABLE story_reactions (
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE, --sender_id instead of user id 
  reactor_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  reaction_type BOOLEAN, 
  created_at TIMESTAMPTZ DEFAULT now()
  -- Removed PK (story_id, user_id)
);

-- Index for Personal Reactions
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_reactions_personal_unique 
ON story_reactions (story_id, user_id) 
WHERE reactor_org_id IS NULL;

-- Index for Company Reactions
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_reactions_company_unique 
ON story_reactions (story_id, reactor_org_id) 
WHERE reactor_org_id IS NOT NULL;

CREATE TABLE story_comments (
  comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  author_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_story_comments_story_id ON story_comments(story_id);

CREATE TABLE followers (
  follower_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  following_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE connection_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL
    REFERENCES users(user_id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL
    REFERENCES users(user_id) ON DELETE CASCADE,
  status connection_status DEFAULT 'pending',
  -- pending | connected | blocked | rejected
  message TEXT,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE (sender_id, receiver_id),
  CHECK (sender_id <> receiver_id)
);

-- Strict Bidirectional Index for Pending Requests (Prevent A->B and B->A simultaneously)
CREATE UNIQUE INDEX IF NOT EXISTS connection_requests_bidirectional_idx 
ON connection_requests (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
WHERE status = 'pending';

-- Index for Cooldown/Block lookups
CREATE INDEX IF NOT EXISTS connection_requests_cooldown_idx 
ON connection_requests (sender_id, receiver_id, status, cooldown_until)
WHERE status IN ('rejected', 'blocked');

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_connection_requests_updated_at
    BEFORE UPDATE ON connection_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL
    REFERENCES users(user_id) ON DELETE CASCADE,
  connected_user_id UUID NOT NULL
    REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, connected_user_id),
  CHECK (user_id <> connected_user_id)
);



CREATE TABLE IF NOT EXISTS conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group BOOLEAN DEFAULT FALSE,
  conversation_name TEXT,
  group_headline TEXT CHECK (char_length(group_headline) <= 100),
  group_avatar TEXT,
  description TEXT,
  created_by UUID REFERENCES users(user_id) ON DELETE CASCADE,
  admin_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  last_message TEXT,
  last_message_at TIMESTAMPTZ DEFAULT now(),
  is_requesting BOOLEAN DEFAULT FALSE,
  is_job_chat BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_is_job_chat ON conversations(is_job_chat);

CREATE TABLE conversation_participants (
  participant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  left_at TIMESTAMPTZ, -- NULL if active, timestamp if left
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  last_read_at TIMESTAMPTZ DEFAULT now(),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')), --8/2/2026
  left_group_name TEXT DEFAULT NULL,
  left_group_avatar TEXT DEFAULT NULL,
  left_group_description TEXT DEFAULT NULL,
  left_group_headline TEXT DEFAULT NULL
);

CREATE INDEX idx_cp_active_user ON conversation_participants (conversation_id, user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  text_content TEXT,
  shared_post_id UUID,
  shared_profile_id UUID,
  shared_profile_type VARCHAR(20),
  message_type TEXT DEFAULT 'text',
  action_type TEXT,
  target_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  entity_type TEXT,
  entity_id TEXT,
  author_org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL,
  replied_msg_id UUID NULL REFERENCES messages(message_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT messages_shared_post_id_fkey FOREIGN KEY (shared_post_id) REFERENCES posts(post_id) ON DELETE SET NULL
);

CREATE TABLE notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(user_id) ON DELETE CASCADE, -- Actor who triggered notification
  type TEXT NOT NULL, -- 'like', 'comment', 'view', 'job_alert'
  text TEXT NOT NULL,
  reference_id UUID, -- ID of the post/job/user
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb, -- Additional data (e.g., comment_id, reply_id)
  is_read BOOLEAN DEFAULT FALSE,
  recipient_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_company ON notifications(recipient_org_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS organization_notification_preferences (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    events_enabled BOOLEAN DEFAULT TRUE,
    jobs_enabled BOOLEAN DEFAULT TRUE,
    posts_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_cnp_company_id ON organization_notification_preferences(org_id);
CREATE INDEX IF NOT EXISTS idx_cnp_user_company ON organization_notification_preferences(user_id, org_id);

CREATE TABLE jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  location TEXT,
  description TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  job_type TEXT, -- Full-time, Part-time, Contract etc.
  work_mode job_work_mode, -- Remote | Hybrid | Onsite
  company_type job_company_type, -- Startup | MNC etc.
  experience_min INTEGER,
  experience_max INTEGER,
  experience_label TEXT,
  experience_level TEXT,
  about_company TEXT,
  industry TEXT NOT NULL , --new field
  easy_apply BOOLEAN DEFAULT false,
  actively_hiring BOOLEAN DEFAULT false,
  match_score INTEGER, -- optional / mock
  is_active BOOLEAN DEFAULT TRUE,
  posted_as_company BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'EXPIRED', 'REJECTED', 'UNDER_REVIEW', 'PAUSED', 'ARCHIVED')),
  expires_at TIMESTAMPTZ,
  salary_currency VARCHAR(10) DEFAULT 'USD',
  salary_period VARCHAR(20) DEFAULT 'YEARLY' CHECK (salary_period IN ('YEARLY', 'MONTHLY', 'HOURLY')),
  salary_visibility VARCHAR(20) DEFAULT 'PUBLIC' CHECK (salary_visibility IN ('PUBLIC', 'PRIVATE')),
  ai_extracted_requirements JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
);

-- Prevent race condition duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_recent_job_company
ON jobs(org_id, title, location)
WHERE status = 'ACTIVE';

-- Analytics/Dashboard optimization
CREATE INDEX IF NOT EXISTS idx_jobs_company_status 
ON jobs(org_id, status);

CREATE TABLE event_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
  retry_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_pending ON event_outbox(status) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_event_outbox_retry 
ON event_outbox(status, next_retry_at) 
WHERE status = 'PENDING';

CREATE TABLE job_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REVIEWED', 'RESOLVED', 'DISMISSED')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE job_versions (
  version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  changed_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  trigger_event VARCHAR(50),
  provenance VARCHAR(50) DEFAULT 'USER',
  previous_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE job_activity (
  activity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE job_skills (
  job_id UUID REFERENCES jobs(job_id) ON DELETE CASCADE,
  skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, skill_id)
);


CREATE TABLE job_applications (
  application_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(job_id) ON DELETE CASCADE,
  applicant_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  resume_url TEXT NOT NULL,
  resume_file_name TEXT,
  cover_note TEXT,
  current_status TEXT NOT NULL DEFAULT 'Applied',
  applied_at TIMESTAMPTZ DEFAULT now(),
  frozen_experience_years SMALLINT DEFAULT 0,
  frozen_location TEXT,
  frozen_highest_degree TEXT,
  frozen_skills TEXT[],
  backend_score SMALLINT DEFAULT 0,
  UNIQUE(job_id, applicant_id)
);

CREATE INDEX IF NOT EXISTS idx_ja_job_backend_score ON job_applications(job_id, backend_score DESC);
CREATE INDEX IF NOT EXISTS idx_ja_job_exp ON job_applications(job_id, frozen_experience_years DESC);
CREATE INDEX IF NOT EXISTS idx_ja_skills_gin ON job_applications USING GIN (frozen_skills);

CREATE TABLE IF NOT EXISTS application_notes (
  note_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES job_applications(application_id) ON DELETE CASCADE,
  author_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(application_id, author_id)
);

CREATE INDEX IF NOT EXISTS idx_application_notes_app_id
  ON application_notes(application_id);

CREATE TABLE IF NOT EXISTS application_ai_analyses (
  analysis_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES job_applications(application_id) ON DELETE CASCADE,
  match_score    INTEGER CHECK (match_score >= 0 AND match_score <= 100),
  summary        JSONB,
  skills         JSONB,
  experience     JSONB,
  qualification  JSONB,
  provider       TEXT DEFAULT 'gemini',
  model          TEXT,
  analysis_type  TEXT NOT NULL DEFAULT 'BACKEND' CHECK (analysis_type IN ('BACKEND','GEMINI')),
  prompt_version TEXT,
  latency_ms     INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_analyses_app_id
  ON application_ai_analyses(application_id);

CREATE TABLE IF NOT EXISTS application_snapshots (
  application_id     UUID PRIMARY KEY REFERENCES job_applications(application_id) ON DELETE CASCADE,
  candidate_snapshot JSONB NOT NULL,
  job_snapshot       JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_analysis_queue (
  queue_id        UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID     NOT NULL REFERENCES job_applications(application_id) ON DELETE CASCADE,
  status          TEXT     NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  priority        SMALLINT NOT NULL DEFAULT 1,
  reason          TEXT     NOT NULL DEFAULT 'TIER1_AUTO',
  retry_count     SMALLINT NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_queue_pending ON ai_analysis_queue(priority DESC, created_at ASC) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_ai_queue_application ON ai_analysis_queue(application_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_analysis_queue_dedup_idx ON ai_analysis_queue(application_id) WHERE status IN ('PENDING', 'PROCESSING');

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID,
  org_id UUID,
  feature TEXT NOT NULL,
  related_entity_id UUID,
  model TEXT,
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  cost_estimate_usd NUMERIC(10,6),
  latency_ms INT,
  cache_hit BOOLEAN DEFAULT FALSE,
  success BOOLEAN,
  error_message TEXT,
  source_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_user_time ON ai_usage_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_time ON ai_usage_log (created_at);

CREATE TABLE job_saves (
  user_id UUID NOT NULL
    REFERENCES users(user_id) ON DELETE CASCADE,

  job_id UUID NOT NULL
    REFERENCES jobs(job_id) ON DELETE CASCADE,

  saved_at TIMESTAMPTZ DEFAULT now(),

  PRIMARY KEY (user_id, job_id)
);


CREATE TABLE application_status_history (
  history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES job_applications(application_id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- 'Applied', 'Under Review', 'Interview', 'Offer'
  changed_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT
);

CREATE TABLE events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  event_type event_type NOT NULL,
  location TEXT,
  virtual_link TEXT,
  virtual_link_visible_at TIMESTAMPTZ,
  banner_url TEXT,
  max_attendees INTEGER,
  waitlist_enabled BOOLEAN DEFAULT false,
  registration_deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);


CREATE TABLE event_registrations (
  event_id UUID REFERENCES events(event_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  mobile_number TEXT NOT NULL,
  company_name TEXT,
  job_title TEXT,
  registered_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT mobile_format CHECK (mobile_number ~ '^[0-9]{10}$')
);

CREATE TABLE event_saves (
  user_id UUID NOT NULL
    REFERENCES users(user_id) ON DELETE CASCADE,

  event_id UUID NOT NULL
    REFERENCES events(event_id) ON DELETE CASCADE,

  saved_at TIMESTAMPTZ DEFAULT now(),

  PRIMARY KEY (user_id, event_id)
);

CREATE TABLE IF NOT EXISTS tickets (
    ticket_id VARCHAR(50) PRIMARY KEY,
    event_id UUID REFERENCES events(event_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'valid',
    checked_in_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Seed initial roles
INSERT INTO roles (role_name) VALUES ('User'), ('Employer'), ('Admin');

--14/01/2026 -- Unique Account Names and Onboarding Status
ALTER TABLE users
ADD COLUMN account_name VARCHAR(30),
ADD COLUMN is_onboarding_complete BOOLEAN DEFAULT FALSE;

CREATE UNIQUE INDEX users_account_name_unique
ON users (LOWER(account_name))
WHERE account_name IS NOT NULL;

--16/01/2026 --profile view count 
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS profile_views (
    view_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    viewer_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    profile_owner_id UUID NOT NULL,
    profile_type TEXT NOT NULL CHECK (profile_type IN ('user', 'organization')),
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    view_date DATE GENERATED ALWAYS AS ((viewed_at AT TIME ZONE 'UTC')::date) STORED
);

CREATE INDEX idx_profile_views_lookup ON profile_views(viewer_id, profile_owner_id, viewed_at);
CREATE INDEX idx_profile_views_owner ON profile_views(profile_type, profile_owner_id);
-- Removed unique_daily_profile_view to allow multiple views per day to increment count

--20-01-26 -- student account type added 
ALTER TABLE profiles
DROP CONSTRAINT profiles_account_type_check;

ALTER TABLE profiles
ADD CONSTRAINT profiles_account_type_check
CHECK (account_type IN (
  'Employer',
  'Admin',
  'Fresher',
  'Student'
));

--22/01/26  category column added in events table with their fixed values
ALTER TABLE events
ADD COLUMN category VARCHAR(30)
CHECK (category IN (
  'Tech',
  'Business',
  'Networking',
  'Workshop',
  'Summit',
  'Conference',
  'Masterclass'
));

ALTER TABLE events
ALTER COLUMN category SET NOT NULL;

-- Search Optimization (From 001_user_search_indexes.sql)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm
ON users USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_email_trgm
ON users USING GIN (email gin_trgm_ops);

ANALYZE users;
----3/02/2026 group chat
CREATE TABLE group_invitations (
  invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  inviter_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  invitee_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(conversation_id, invitee_id)
);

-- 5/02/2026 Migration: Create blocks table
CREATE TABLE IF NOT EXISTS blocks (
    blocker_id UUID NOT NULL,
    blocked_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    is_org_block BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id, is_org_block),
    CONSTRAINT no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked_id ON blocks(blocked_id);
CREATE INDEX IF NOT EXISTS idx_blocks_is_org ON blocks(is_org_block);

-- 8/02/2026 Migration: Create message_reads table for group chat read receipts
-- (004_add_message_reads.sql)

CREATE TABLE IF NOT EXISTS message_reads (
  message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Index for counting unread messages efficiently
-- (Finding messages for a user that are NOT in this table is the main query)
-- The PK covers (message_id, user_id), but we might want to query by user_id efficiently 
-- to find all messages read by a user (e.g. for analytics or cleanup)
CREATE INDEX IF NOT EXISTS idx_message_reads_user_id ON message_reads(user_id);

-- Index for "Seen by" feature (finding all users who read a specific message)
-- The PK (message_id, user_id) already covers efficient lookup by message_id.

-- 10/02/2026 Migration: Create message_media table
CREATE TABLE IF NOT EXISTS message_media (
  media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  media_type TEXT CHECK (media_type IN ('image', 'video', 'document')) DEFAULT 'image',
  filename TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 10/02/2026 Migration: Create organizations (Moved to top)

-- 3. COMPANY INVITES Table
CREATE TABLE IF NOT EXISTS organization_invites (
    invite_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    inviter_id UUID REFERENCES users(user_id) ON DELETE SET NULL, -- Who sent the invite
    email VARCHAR(255) NOT NULL,
    invited_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    role_id UUID REFERENCES organization_roles(role_id) ON DELETE SET NULL, -- Modern link
    role TEXT, -- Fallback role name
    token VARCHAR(255) NOT NULL, -- For email link
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'REJECTED')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(org_id, email) -- One active invite per email per company (simplified)
);

CREATE INDEX idx_company_invites_token ON organization_invites(token);


-- 4. COMPANY VERIFICATIONS Table
CREATE TABLE IF NOT EXISTS organization_verifications (
    verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    otp VARCHAR(255) NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    is_verified BOOLEAN DEFAULT FALSE, -- To track if this specific OTP was used successfully
    verification_type VARCHAR(20) DEFAULT 'EMAIL' CHECK (verification_type IN ('EMAIL', 'PHONE', 'EDU_EMAIL', 'DOCUMENT')),
    target_value VARCHAR(255),
    request_count INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_org_verifications_lookup ON organization_verifications(org_id, verification_type, is_verified);

-- 4b. COMPANY VERIFICATION DOCUMENTS Table
CREATE TABLE IF NOT EXISTS organization_documents (
    document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    document_url TEXT NOT NULL,
    document_name VARCHAR(255) NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_documents_org_id ON organization_documents(org_id);


-- 5. AUDIT LOGS Table
-- Generic enough for other systems, but focused on company for now
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(50) NOT NULL, -- e.g., 'COMPANY'
    entity_id UUID NOT NULL, -- org_id
    actor_id UUID REFERENCES users(user_id) ON DELETE SET NULL, -- Who performed the action
    actor_role VARCHAR(100),
    action VARCHAR(50) NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'TRANSFER_OWNERSHIP', 'VERIFY_DOMAIN', 'INVITE_MEMBER'
    metadata JSONB DEFAULT '{}'::jsonb, -- Store diffs or details
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_actor ON audit_logs(entity_id, actor_id, created_at DESC);


-- Triggers for updated_at
CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_company_invites_updated_at
    BEFORE UPDATE ON organization_invites
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 11/02/2026 Migration: Add company support for comments and likes
-- 009_company_comments_likes.sql

-- 1. POST COMMENTS
-- Add author_org_id column
ALTER TABLE post_comments
ADD COLUMN author_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- 2. POST LIKES
ALTER TABLE post_likes
ADD COLUMN org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- Drop existing constraint: UNIQUE(post_id, user_id)
ALTER TABLE post_likes
DROP CONSTRAINT post_likes_post_id_user_id_key;

-- Add conditional unique indexes
-- Case 1: User Like (org_id IS NULL)
CREATE UNIQUE INDEX idx_post_likes_user_unique 
ON post_likes (post_id, user_id) 
WHERE org_id IS NULL;

-- Case 2: Company Like (org_id IS NOT NULL)
-- A company can only like a post once. The actor (user) doesn't matter for uniqueness, only the company entity.
CREATE UNIQUE INDEX idx_post_likes_company_unique 
ON post_likes (post_id, org_id) 
WHERE org_id IS NOT NULL;


-- 3. COMMENT LIKES
ALTER TABLE comment_likes
ADD COLUMN org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- Drop existing PK/Constraint: PRIMARY KEY (user_id, comment_id)
ALTER TABLE comment_likes
DROP CONSTRAINT comment_likes_pkey;

-- Add conditional unique indexes
-- Case 1: User Like (org_id IS NULL)
CREATE UNIQUE INDEX idx_comment_likes_user_unique 
ON comment_likes (comment_id, user_id) 
WHERE org_id IS NULL;

-- Case 2: Company Like (org_id IS NOT NULL)
CREATE UNIQUE INDEX idx_comment_likes_company_unique 
ON comment_likes (comment_id, org_id) 
WHERE org_id IS NOT NULL;

-- 11/02/2026 Migration: Phase 1 Production Fixes
-- (010_phase1_production_fixes.sql)

-- 1. STORIES ATTRIBUTION
ALTER TABLE stories
ADD COLUMN author_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- 2. POSTS ATTRIBUTION (Missing from prev migrations)
ALTER TABLE posts
ADD COLUMN author_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;

-- 3. PERFORMANCE INDEXES for Company Foreign Keys
CREATE INDEX IF NOT EXISTS idx_posts_author_company_id ON posts(author_org_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_author_company_id ON post_comments(author_org_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_company_id ON post_likes(org_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_company_id ON comment_likes(org_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_company_id ON notifications(recipient_org_id);
CREATE INDEX IF NOT EXISTS idx_stories_author_company_id ON stories(author_org_id);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer_company_id ON story_views(viewer_org_id);
CREATE INDEX IF NOT EXISTS idx_story_reactions_reactor_company_id ON story_reactions(reactor_org_id);

-- 4. SEARCH OPTIMIZATION (GIN index for organizations)
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm
ON organizations USING GIN (name gin_trgm_ops);

-- ANALYZE for statistics
ANALYZE organizations;
ANALYZE posts;
ANALYZE post_comments;
ANALYZE stories;

-- 11/02/2026 Migration: Phase 3 Social Growth
-- (011_company_followers.sql)

CREATE TABLE IF NOT EXISTS organization_followers (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_company_followers_company_id ON organization_followers(org_id);
-- 11/02/2026 Create saved_post table
CREATE TABLE saved_post(
	user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
	post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
	saved_at TIMESTAMPTZ DEFAULT now(),
	PRIMARY KEY (user_id , post_id)
);

-- 17/02/2026 Seed Data for Post Categories
INSERT INTO post_categories (name) VALUES 
('Personal'),
('Professional'),
('Achievement'),
('Update'),
('Hiring'),
('Milestone'),
('Insight')
ON CONFLICT (name) DO NOTHING;

-- 18/02/2026 Migration: Company Messaging Support
-- (013_company_messaging.sql)

-- 1. Create sender_type enum
DO $$ BEGIN
    CREATE TYPE sender_type_enum AS ENUM ('USER', 'COMPANY');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Update messages table: add sender_type, soft-delete, and edit tracking columns
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS sender_type sender_type_enum DEFAULT 'USER',
ADD COLUMN IF NOT EXISTS is_deleted_for_everyone BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- 3. Update conversation_participants: add org_id, make user_id nullable
ALTER TABLE conversation_participants
ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL;

ALTER TABLE conversation_participants
ALTER COLUMN user_id DROP NOT NULL;

-- Constraint: each participant row must be either a user OR a company (not both, not neither)
ALTER TABLE conversation_participants
ADD CONSTRAINT participant_identity_check
CHECK (
    (user_id IS NOT NULL AND org_id IS NULL) OR
    (user_id IS NULL AND org_id IS NOT NULL)
);

ALTER TABLE conversation_participants
ADD COLUMN IF NOT EXISTS is_muted BOOLEAN DEFAULT FALSE;

ALTER TABLE conversation_participants
ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;

ALTER TABLE conversation_participants
ADD COLUMN IF NOT EXISTS mute_updated_at TIMESTAMPTZ;

-- 4. Create message_delete table (per-user soft delete)
CREATE TABLE IF NOT EXISTS message_delete (
  message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(user_id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_cp_company_id ON conversation_participants(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_type ON messages(sender_type);
CREATE INDEX IF NOT EXISTS idx_message_delete_user_id ON message_delete(user_id);

-- 19/02/2026 Migration: Company Chat Sessions
-- (015_company_chat_sessions.sql)

CREATE TABLE IF NOT EXISTS organization_chat_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    handler_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    handler_name_snapshot TEXT NOT NULL,
    handler_role_id_snapshot UUID,
    handler_role_name_snapshot TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'TIMED_OUT', 'ENDED', 'TRANSFERRED')),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    end_reason VARCHAR(30)
        CHECK (end_reason IS NULL OR end_reason IN (
            'manual', 'timeout', 'transfer', 'force_takeover',
            'member_removed', 'company_deactivated', 'system'
        )),
    message_count INTEGER DEFAULT 0,
    transferred_to UUID REFERENCES users(user_id) ON DELETE SET NULL,
    transferred_from_session_id UUID REFERENCES organization_chat_sessions(session_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ccs_active
ON organization_chat_sessions (conversation_id, org_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_ccs_company ON organization_chat_sessions(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ccs_handler ON organization_chat_sessions(handler_user_id, status);
CREATE INDEX IF NOT EXISTS idx_ccs_timeout ON organization_chat_sessions(status, last_activity_at) WHERE status = 'ACTIVE';

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES organization_chat_sessions(session_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT chk_session_sender_type
    CHECK ((session_id IS NULL) OR (sender_type = 'COMPANY'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------
-- COMPANY CONNECTIONS (25/02/2026)
-- ---------------------------------------------------------

-- Company Connection Requests (pending/rejected/blocked)
CREATE TABLE IF NOT EXISTS organization_connection_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  initiated_by UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
  message TEXT,
  cooldown_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- Company Connections (accepted, bidirectional)
CREATE TABLE IF NOT EXISTS organization_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- Add counter cache to organizations for 1M user scale performance
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS followers_count INTEGER DEFAULT 0;

-- Index for receiver (user) to see invitations
CREATE INDEX IF NOT EXISTS idx_company_conn_req_user_id ON organization_connection_requests(user_id);

-- Index for company to see its connections
CREATE INDEX IF NOT EXISTS idx_company_conn_company_id ON organization_connections(org_id);

-- ---------------------------------------------------------
-- SOCIAL SYSTEM INDEXING (26/02/2026)
-- Supports bidirectional social graph lookups at 1M user scale
-- ---------------------------------------------------------

-- 1. Reverse index for Followers list (Who follows me?)
-- The primary key (follower_id, following_id) already covers "Who am I following?" efficiently.
-- This index covers the reverse lookup.
CREATE INDEX IF NOT EXISTS idx_followers_following_id 
ON followers(following_id, follower_id);

-- 2. Index for Company Followers
CREATE INDEX IF NOT EXISTS idx_company_followers_company_id
ON organization_followers(org_id, user_id);

-- 3. Composite index for connections
CREATE INDEX IF NOT EXISTS idx_connections_bidirectional
ON connections(user_id, connected_user_id);

-- ---------------------------------------------------------
-- DIRECT JOB OFFERS (26/02/2026)
-- ---------------------------------------------------------

-- Direct Job Offers Table
-- A lean table that references the existing `jobs` table for job details
-- Only stores offer-specific data: who sent it, who it's for, status
CREATE TABLE IF NOT EXISTS job_offers (
  offer_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  org_id   UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  sent_by      UUID NOT NULL REFERENCES users(user_id),
  message      TEXT,
  status       VARCHAR(20) DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  responded_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_offers_user ON job_offers(user_id, status);
CREATE INDEX IF NOT EXISTS idx_job_offers_company ON job_offers(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_offers_no_dup ON job_offers(job_id, user_id) WHERE status = 'pending';

-- ---------------------------------------------------------
-- COMPANY NOTIFICATION PREFERENCES (03/03/2026)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_notification_preferences (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    events_enabled BOOLEAN DEFAULT TRUE,
    jobs_enabled BOOLEAN DEFAULT TRUE,
    posts_enabled BOOLEAN DEFAULT TRUE,
    announcements_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_cnp_company_id ON organization_notification_preferences(org_id);
CREATE INDEX IF NOT EXISTS idx_cnp_user_company ON organization_notification_preferences(user_id, org_id);


-- ---------------------------------------------------------
-- INSTITUTION TABLES
-- ---------------------------------------------------------
CREATE TABLE institution_enrollments (
    enrollment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL CHECK (role IN ('STUDENT', 'FACULTY', 'ALUMNI')),
    verification_method VARCHAR(50) NOT NULL CHECK (verification_method IN ('EMAIL', 'ID_UPLOAD', 'MANUAL')),
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
    document_url VARCHAR(255),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, user_id)
);

CREATE OR REPLACE FUNCTION update_enrollment_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_institution_enrollments_updated_at
    BEFORE UPDATE ON institution_enrollments
    FOR EACH ROW
    EXECUTE FUNCTION update_enrollment_updated_at_column();


-- ---------------------------------------------------------
-- UNIVERSAL SHARES
-- ---------------------------------------------------------
CREATE TABLE shares (
    id            BIGSERIAL PRIMARY KEY,
    sender_id     TEXT NOT NULL,
    receiver_id   TEXT,
    entity_type   VARCHAR(50) NOT NULL,
    entity_id     TEXT NOT NULL,
    share_method  VARCHAR(20) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shares_entity ON shares(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_shares_sender ON shares(sender_id);
CREATE INDEX IF NOT EXISTS idx_shares_created_at ON shares(created_at);

CREATE INDEX IF NOT EXISTS idx_messages_entity ON messages(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(entity_type, entity_id);

-- 07/03/2026 OTP Verification System
CREATE TABLE IF NOT EXISTS email_otps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    request_count INTEGER DEFAULT 1,
    CONSTRAINT unique_email_otp UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);

-- 10/03/2026 Google OAuth Support
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'local';
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD CONSTRAINT password_or_social
CHECK (
  (auth_provider = 'local' AND password_hash IS NOT NULL)
  OR
  (auth_provider != 'local')
) NOT VALID;

ALTER TABLE users VALIDATE CONSTRAINT password_or_social;

-- 15/03/2026 Search Appearances 
CREATE TABLE search_appearances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    viewer_id UUID,
    profile_owner_id UUID NOT NULL,

    profile_type TEXT NOT NULL
        CHECK (profile_type IN ('user','organization')),

    appearance_date DATE NOT NULL DEFAULT CURRENT_DATE,

    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE search_appearances
ADD CONSTRAINT unique_daily_search
UNIQUE (viewer_id, profile_owner_id, profile_type, appearance_date);

CREATE INDEX idx_search_appearance_owner_type
ON search_appearances(profile_owner_id, profile_type);

-- 25/03/2026 Attendance Table (QR Check-In)
CREATE TABLE IF NOT EXISTS attendance (
    attendance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    ticket_id VARCHAR(100) NOT NULL,
    checked_in_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance(event_id);

-- ---------------------------------------------------------
-- 28/03/2026 Migration: Org Hierarchy + Cross-Org Broadcasts
-- ---------------------------------------------------------

-- 1. Add parent_org_id to organizations (Org Hierarchy MVP)
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS parent_org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_org_parent
ON organizations (parent_org_id)
WHERE parent_org_id IS NOT NULL AND is_deleted = FALSE;

-- 2. Add broadcast flag to posts (Cross-Org Broadcasts)
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS is_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS broadcast_scope VARCHAR(20) DEFAULT 'CHILDREN';

-- Index for efficient broadcast feed lookups
CREATE INDEX IF NOT EXISTS idx_posts_broadcast
ON posts (author_org_id, is_broadcast, created_at DESC)
WHERE is_broadcast = TRUE;

-- Index for efficient per-user membership lookups (used in broadcast feed query)
CREATE INDEX IF NOT EXISTS idx_org_members_user_status
ON organization_members (user_id, status)
WHERE status = 'ACTIVE';

-- ---------------------------------------------------------
-- 29/03/2026 Reporting System (Phase 1)
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS report_reasons (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  active BOOLEAN DEFAULT TRUE
);

-- Seed Default Data (idempotent via ON CONFLICT)
INSERT INTO report_reasons (code, label) VALUES
('SPAM', 'Spam or misleading'),
('ABUSE', 'Abusive content'),
('HARASSMENT', 'Harassment or bullying'),
('FAKE', 'Fake account/company'),
('INAPPROPRIATE', 'Inappropriate content'),
('OTHER', 'Other')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type VARCHAR(20) NOT NULL, -- 'POST', 'USER', 'COMMENT', 'COMPANY'
  target_id UUID NOT NULL, -- Target entity ID (Post, User, etc.)
  reason_id INT REFERENCES report_reasons(id) ON DELETE SET NULL,
  custom_reason TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- Unique constraint: preventing same user from reporting same target twice
  UNIQUE (reporter_id, target_type, target_id)
);

-- Index for admin moderation (Phase 2)
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);

-- ---------------------------------------------------------
-- Missing tables (blocks, post_impressions)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocks (
    blocker_id UUID NOT NULL,
    blocked_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    is_org_block BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id, is_org_block),
    CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS post_impressions (
    impression_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    viewer_org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_impressions_post_id ON post_impressions(post_id);

-- ---------------------------------------------------------
-- YOUR ACTIVITY LOG SYSTEM
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes for dashboard queries
CREATE INDEX IF NOT EXISTS idx_activity_user_type 
ON user_activity_log(user_id, action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_user_entity 
ON user_activity_log(user_id, entity_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_created 
ON user_activity_log(created_at DESC);

CREATE TABLE user_activities (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_intent_scores (
  user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,

  job_seeker_score INT DEFAULT 0,
  creator_score INT DEFAULT 0,
  event_score INT DEFAULT 0,

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2026-04-19: Device management for push notifications
CREATE TABLE IF NOT EXISTS device_sessions (
    device_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES refresh_tokens(session_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    fcm_token TEXT,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
    is_active BOOLEAN DEFAULT TRUE,
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, session_id)
);

CREATE INDEX idx_device_sessions_active_user ON device_sessions(user_id) WHERE is_active = TRUE;
CREATE INDEX idx_device_sessions_session_id ON device_sessions(session_id);

CREATE TRIGGER update_device_sessions_updated_at
BEFORE UPDATE ON device_sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 21/04/2026 - INTEREST SYSTEM (Production Grade)
CREATE TABLE interests (
    interest_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,      
    category TEXT,                 
    icon_url TEXT,                 
    usage_count INTEGER DEFAULT 0, 
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_interests_name_lower ON interests(LOWER(name));

CREATE TABLE user_interests (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    interest_id UUID REFERENCES interests(interest_id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('onboarding', 'like', 'view', 'search', 'follow')),
    score FLOAT DEFAULT 0 CHECK (score >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, interest_id)
);

CREATE INDEX idx_ui_user_score ON user_interests(user_id, score DESC);
CREATE INDEX idx_ui_interest ON user_interests(interest_id);

CREATE TABLE interest_hashtags (
    interest_id UUID REFERENCES interests(interest_id) ON DELETE CASCADE,
    hashtag_id UUID REFERENCES hashtags(hashtag_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (interest_id, hashtag_id)
);

CREATE TRIGGER trg_user_interests_updated
    BEFORE UPDATE ON user_interests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_interests_updated
    BEFORE UPDATE ON interests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- User Tagging in Posts
CREATE TABLE IF NOT EXISTS post_tags (
    tag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
    tagged_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    is_active_tag BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_post_user_tag UNIQUE(post_id, tagged_user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_post_id ON post_tags(post_id);
CREATE INDEX IF NOT EXISTS idx_post_tags_user_id ON post_tags(tagged_user_id);

-- ---------------------------------------------------------
-- COMMENT HIDING SYSTEM (LinkedIn Style)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS hidden_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    comment_id UUID NOT NULL REFERENCES post_comments(comment_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique indexes to prevent duplicate hides per identity
CREATE UNIQUE INDEX IF NOT EXISTS hidden_comments_user_idx ON hidden_comments (user_id, comment_id) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hidden_comments_org_idx ON hidden_comments (org_id, comment_id) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_reactions (
  reaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT message_reactions_unique UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_users_location_country ON users(location_country) WHERE location_country IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_location_city ON users(LOWER(location_city)) WHERE location_city IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_restoration_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- Views for Soft Deletion & Anonymization
-- ==========================================

CREATE OR REPLACE VIEW active_users AS 
SELECT * FROM users 
WHERE deletion_execute_at IS NULL;

CREATE OR REPLACE VIEW user_display_profiles AS
SELECT
    user_id,
    account_name AS original_username,

    CASE
        WHEN deletion_execute_at IS NULL THEN full_name
        ELSE 'Deactivated User'
    END AS display_name,

    CASE
        WHEN deletion_execute_at IS NULL THEN account_name
        ELSE 'deactivated_user'
    END AS display_username,

    CASE
        WHEN deletion_execute_at IS NULL THEN avatar_url
        ELSE NULL
    END AS display_avatar,

    CASE
        WHEN deletion_execute_at IS NULL THEN headline
        ELSE 'This account has been deactivated'
    END AS display_headline,

    CASE
        WHEN deletion_execute_at IS NULL THEN location
        ELSE NULL
    END AS location
FROM users;

-- 1. Add working_industry
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS working_industry TEXT;
 
-- 2. Add work_mode as a new column
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS work_mode job_work_mode;

-- =========================================================================
-- REFERENCE TABLES
-- =========================================================================
CREATE TABLE IF NOT EXISTS job_roles_master (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_roles_name ON job_roles_master (role_name);

CREATE TABLE IF NOT EXISTS industries_master (
    industry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_industries_name ON industries_master (industry_name);

-- Fix: Allow drafts to be created without industry
ALTER TABLE jobs ALTER COLUMN industry DROP NOT NULL;

-- -------------------------------------------------------------------------
-- TRIGGER: Update offer expiry on job close
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_offer_expiry_on_job_close()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'CLOSED' AND (OLD.status IS DISTINCT FROM 'CLOSED') THEN
        UPDATE job_offers
        SET expires_at = LEAST(expires_at, NOW() + INTERVAL '10 days')
        WHERE job_id = NEW.job_id AND status = 'pending';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_offer_expiry_on_job_close ON jobs;
CREATE TRIGGER trg_update_offer_expiry_on_job_close
AFTER UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION update_offer_expiry_on_job_close();

-- ==========================================================================
-- ORGANISATION PROFILE FEATURE (2026-07-03)
-- New tables and columns for the public org profile tabs:
--   About tab  → offices, links, specialties
--   People tab → member title, description, core team flag
--   Alumni tab → graduation year, field of study
-- ==========================================================================

-- 1. Multiple office locations (About tab — Offices section)
CREATE TABLE IF NOT EXISTS organization_offices (
    office_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    city VARCHAR(100) NOT NULL,
    country VARCHAR(100) NOT NULL,
    address TEXT DEFAULT '',
    is_headquarters BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_offices_org_id ON organization_offices(org_id);
CREATE INDEX IF NOT EXISTS idx_org_offices_active ON organization_offices(org_id) WHERE is_deleted = FALSE;

-- 2. Typed social/external links (About tab — Links section)
CREATE TABLE IF NOT EXISTS organization_links (
    link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,   -- 'linkedin', 'twitter', 'instagram', 'facebook', 'youtube', 'other'
    url TEXT NOT NULL,
    display_label VARCHAR(100),
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_links_org_id ON organization_links(org_id);
CREATE INDEX IF NOT EXISTS idx_org_links_active ON organization_links(org_id) WHERE is_deleted = FALSE;

-- 3. Specialties tags (About tab — Specialties section)
CREATE TABLE IF NOT EXISTS organization_specialties (
    specialty_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_specialties_org_id ON organization_specialties(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_specialties_unique_active ON organization_specialties(org_id, name) WHERE is_deleted = FALSE;

-- 4. Core team flag + public title/description per member (People tab, Core Team section)
ALTER TABLE organization_members
    ADD COLUMN IF NOT EXISTS title VARCHAR(100),
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS is_core_team BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_org_members_core_team
    ON organization_members(org_id, is_core_team)
    WHERE is_core_team = TRUE;

-- 5. Alumni graduation year + field of study (Alumni tab)
ALTER TABLE institution_enrollments
    ADD COLUMN IF NOT EXISTS graduation_year INTEGER,
    ADD COLUMN IF NOT EXISTS field_of_study VARCHAR(200);

-- 04/07/2026 Migration: Company/Organization Subscription (Soft-Deletable)
CREATE TABLE IF NOT EXISTS organization_subscribers (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'SUBSCRIBED' CHECK (status IN ('SUBSCRIBED', 'UNSUBSCRIBED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_company_subscribers_company_id ON organization_subscribers(org_id);

-- Migration: Communities
CREATE TABLE IF NOT EXISTS communities (
    community_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    banner_url TEXT
);

-- 07/14/2026 Migration: Community Subscription
CREATE TABLE IF NOT EXISTS community_subscriptions (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    community_id UUID REFERENCES communities(community_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'SUBSCRIBED' CHECK (status IN ('SUBSCRIBED', 'UNSUBSCRIBED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, community_id)
);
CREATE INDEX IF NOT EXISTS idx_community_subscribers_comm_id ON community_subscriptions(community_id);

-- ==========================================================================
-- ORGANISATION KEY OFFERINGS (2026-07-10)
-- Editable "Key offerings" list on the Profile edit tab, shown on the
-- public profile Home tab (formerly the static "Relevance" bullets).
-- ==========================================================================
CREATE TABLE IF NOT EXISTS organization_key_offerings (
    offering_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    icon VARCHAR(100),
    label VARCHAR(50),
    position INTEGER NOT NULL DEFAULT 0,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_key_offerings_org_id ON organization_key_offerings(org_id);
CREATE INDEX IF NOT EXISTS idx_org_key_offerings_active ON organization_key_offerings(org_id) WHERE is_deleted = FALSE;

-- 07/16/2026 Migration: Community Article Indicator
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_community_article BOOLEAN DEFAULT FALSE;

-- ==========================================================================
-- PROFILE PROJECTS FEATURE (2026-07-28)
-- Supports user portfolio projects with associated skill tags and media attachments.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    details TEXT,
    start_month VARCHAR(20) NOT NULL,
    start_year VARCHAR(10) NOT NULL,
    end_month VARCHAR(20),
    end_year VARCHAR(10),
    is_current BOOLEAN DEFAULT FALSE,
    role VARCHAR(100),
    team_size VARCHAR(50),
    role_description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT chk_projects_date_range CHECK (
        is_current = true OR (end_year IS NOT NULL AND end_month IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_projects_profile_id ON projects(profile_id);
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);

CREATE TABLE IF NOT EXISTS project_skills (
    project_id UUID REFERENCES projects(project_id) ON DELETE CASCADE,
    skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_project_skills_project_id ON project_skills(project_id);

CREATE TABLE IF NOT EXISTS project_media (
    media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    media_type VARCHAR(20) NOT NULL CHECK (media_type IN ('link', 'image', 'document')),
    title VARCHAR(255) NOT NULL,
    url TEXT,
    file_url TEXT,
    file_name VARCHAR(255),
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_media_project_id ON project_media(project_id);

-- ============================================================
-- SETTINGS MODULE SCHEMA ADDITIONS
-- ============================================================

-- 1. Add settings columns to users
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS theme_preference VARCHAR(10) DEFAULT 'system'
        CHECK (theme_preference IN ('system', 'light', 'dark')),
    ADD COLUMN IF NOT EXISTS recovery_email TEXT,
    ADD COLUMN IF NOT EXISTS recovery_email_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS profile_show_email BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS profile_show_phone BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tag_permission VARCHAR(20) DEFAULT 'everyone'
        CHECK (tag_permission IN ('everyone', 'connections_only', 'followers_only', 'no_one'));

-- Re-create active_users view to pick up new columns added to users table
CREATE OR REPLACE VIEW active_users AS
SELECT * FROM users
WHERE deletion_execute_at IS NULL;

-- 2. User notification preferences (1:1 with user)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    all_notifications BOOLEAN DEFAULT TRUE,
    post_notifications BOOLEAN DEFAULT TRUE,
    job_alerts BOOLEAN DEFAULT TRUE,
    message_notifications BOOLEAN DEFAULT TRUE,
    email_notifications BOOLEAN DEFAULT TRUE,
    push_notifications BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Saved folders (referenced by savedPost.controller.js)
CREATE TABLE IF NOT EXISTS saved_folders (
    folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    cover_image TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_folders_user_id ON saved_folders(user_id);

-- 4. saved_post: add org_id and folder_id
ALTER TABLE saved_post
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES saved_folders(folder_id) ON DELETE SET NULL;

-- 5. Support tickets
CREATE TABLE IF NOT EXISTS support_tickets (
    ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    description TEXT NOT NULL,
    attachment_url TEXT,
    status VARCHAR(20) DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. User feedback (one per user per app version)
CREATE TABLE IF NOT EXISTS user_feedback (
    feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    app_version TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_feedback_version ON user_feedback(user_id, app_version);


-- ==========================================================================
-- ACCOUNT STATUS FEATURE (Phase 2 — 2026-08-01)
-- Your Reports + Account Actions tabs in Settings
-- ==========================================================================

-- 1. Add status tracking to the existing reports table
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'under_review', 'action_taken', 'no_action', 'dismissed'));

-- 2. Moderator review notes — timeline of updates per report
--    is_system = TRUE: auto-generated on report creation
--    is_system = FALSE: written by a moderator (via admin panel, Phase 3)
CREATE TABLE IF NOT EXISTS report_review_notes (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  BIGINT  NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  message    TEXT    NOT NULL,
  is_system  BOOLEAN DEFAULT TRUE,
  created_by UUID    REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_review_notes_report ON report_review_notes(report_id);

-- 3. Moderation actions issued against a user (populated by admin panel in Phase 3)
--    Suspension status is auto-resolved at query time:
--      expires_at < NOW()  →  status returned as 'completed'
CREATE TABLE IF NOT EXISTS account_actions (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID    NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  action_type    VARCHAR(30) NOT NULL
    CHECK (action_type IN ('warning', 'post_removed', 'comment_removed', 'suspension', 'ban')),
  reason_id      INT     REFERENCES report_reasons(id) ON DELETE SET NULL,
  custom_reason  TEXT,
  moderator_note TEXT,
  affected_type  VARCHAR(20),      -- 'POST', 'COMMENT', etc.
  affected_id    UUID,
  affected_title TEXT,             -- snapshot of content title at time of action
  duration_days  INT,              -- for suspensions (e.g. 7)
  status         VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'appealed', 'overturned')),
  expires_at     TIMESTAMPTZ,      -- created_at + INTERVAL 'duration_days days'
  issued_by      UUID    REFERENCES users(user_id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_actions_user ON account_actions(user_id, created_at DESC);

-- ==========================================================================
-- OWNERSHIP TRANSFERS FEATURE (2026-08-02)
-- Tracks historical organization ownership transfers
-- ==========================================================================

CREATE TABLE IF NOT EXISTS ownership_transfers (
    transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    transferred_from UUID REFERENCES users(user_id) ON DELETE SET NULL,
    transferred_to UUID REFERENCES users(user_id) ON DELETE SET NULL,
    transferred_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_org ON ownership_transfers(org_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_from ON ownership_transfers(transferred_from);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_to ON ownership_transfers(transferred_to);

-- =========================================================================
-- ACTIVE VIEWS FOR LIKES AND COMMENTS (Excluding Soft-Deleted Entities)
-- =========================================================================

CREATE OR REPLACE VIEW active_post_likes AS
SELECT pl.* 
FROM post_likes pl
LEFT JOIN active_users au ON au.user_id = pl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = pl.org_id
WHERE (pl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

CREATE OR REPLACE VIEW active_post_comments AS
SELECT pc.*
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);

CREATE OR REPLACE VIEW active_comment_likes AS
SELECT cl.*
FROM comment_likes cl
LEFT JOIN active_users au ON au.user_id = cl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = cl.org_id
WHERE (cl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (cl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);



CREATE OR REPLACE VIEW organization_display_profiles AS
SELECT 
    org_id,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN name 
        ELSE 'Deleted Page' 
    END AS name,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN slug 
        ELSE 'deleted_page' 
    END AS slug,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN logo_url 
        ELSE NULL 
    END AS logo_url,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN headline 
        ELSE 'This page has been deactivated' 
    END AS headline,
    entity_type
FROM organizations;

-- ==========================================
-- SETTINGS ACTOR CONTEXT SCHEMA EXTENSIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS organization_privacy_settings (
    org_id UUID PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
    show_email BOOLEAN NOT NULL DEFAULT true,
    show_phone BOOLEAN NOT NULL DEFAULT true,
    tag_permission VARCHAR(20) NOT NULL DEFAULT 'everyone'
        CHECK (tag_permission IN ('everyone', 'followers_only', 'no_one')),
    following_visibility VARCHAR(20) NOT NULL DEFAULT 'everyone'
        CHECK (following_visibility IN ('everyone', 'followers_only', 'no_one')),
    followers_visibility VARCHAR(20) NOT NULL DEFAULT 'everyone'
        CHECK (followers_visibility IN ('everyone', 'followers_only', 'no_one')),
    message_permission VARCHAR(20) NOT NULL DEFAULT 'everyone'
        CHECK (message_permission IN ('everyone', 'followers_only', 'no_one')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_privacy_org_id ON organization_privacy_settings(org_id);

ALTER TABLE organization_notification_preferences
    ADD COLUMN IF NOT EXISTS messages_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS messages_chat_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS messages_jobs_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS organization_blocked_accounts (
    block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    blocked_type VARCHAR(20) NOT NULL CHECK (blocked_type IN ('user', 'company')),
    blocked_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, blocked_type, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_org_blocked_org ON organization_blocked_accounts(org_id);




-- Added for user identity verification
CREATE TABLE user_verifications (
  verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  verification_type VARCHAR(50) DEFAULT 'IDENTITY',
  front_image_url TEXT NOT NULL,
  back_image_url TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'VERIFIED',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
