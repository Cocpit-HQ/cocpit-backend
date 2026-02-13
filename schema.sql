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
  about_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
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

CREATE TABLE refresh_tokens (
  token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked BOOLEAN DEFAULT FALSE,
  user_agent TEXT NOT NULL,
  ip_address INET NOT NULL
);

CREATE TABLE profiles (
  profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  -- Identity Chips
  account_type TEXT NOT NULL CHECK (account_type IN ('Fresher', 'Employee', 'Student', 'Freelancer', 'Employer')),
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
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  location TEXT,
  start_date DATE,
  end_date DATE, -- NULL if current
  is_current BOOLEAN DEFAULT FALSE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE experience_skills (
  experience_id UUID REFERENCES experiences(experience_id) ON DELETE CASCADE,
  skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
  PRIMARY KEY (experience_id, skill_id)
);

CREATE TABLE educations (
  education_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(profile_id) ON DELETE CASCADE,
  school_name TEXT NOT NULL,
  degree TEXT,
  field_of_study TEXT,
  start_date DATE,
  end_date DATE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE post_categories (
  category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL -- 'Personal', 'Professional', 'Achievement' ,'All'
);

CREATE TABLE posts (
  post_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  category_id UUID REFERENCES post_categories(category_id),
  title TEXT,
  content TEXT,
  visibility visibility_type DEFAULT 'public',
  shared_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  post_type  AS ENUM ('image', 'video', 'article', 'poll') NOT NULL
);

CREATE TABLE post_polls (
  poll_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL UNIQUE
    REFERENCES posts(post_id) ON DELETE CASCADE,
  duration INTERVAL NOT NULL DEFAULT INTERVAL '7 days',
  allow_multiple_votes BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

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
    created_at TIMESTAMPTZ DEFAULT now(),
    -- one vote per poll per user (single-choice)
    UNIQUE (poll_id, voter_id)
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
  media_status TEXT DEFAULT 'ready',
  cld_public_id TEXT,
  shared_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL,
  story_metadata JSONB DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL, -- usually created_at + 24h
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE story_views (
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  viewer_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  viewer_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ DEFAULT now()
  -- Removed PK (story_id, viewer_id) to allow same user to view as company
);

-- Index for Personal Views (Unique per user if not acting as company)
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_views_personal_unique 
ON story_views (story_id, viewer_id) 
WHERE viewer_company_id IS NULL;

-- Index for Company Views (Unique per company, regardless of which member viewed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_views_company_unique 
ON story_views (story_id, viewer_company_id) 
WHERE viewer_company_id IS NOT NULL;

CREATE TABLE story_reactions (
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE, --sender_id instead of user id 
  reactor_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
  reaction_type BOOLEAN, 
  created_at TIMESTAMPTZ DEFAULT now()
  -- Removed PK (story_id, user_id)
);

-- Index for Personal Reactions
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_reactions_personal_unique 
ON story_reactions (story_id, user_id) 
WHERE reactor_company_id IS NULL;

-- Index for Company Reactions
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_reactions_company_unique 
ON story_reactions (story_id, reactor_company_id) 
WHERE reactor_company_id IS NOT NULL;

CREATE TABLE story_comments (
  comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  author_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
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



CREATE TABLE conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group BOOLEAN DEFAULT FALSE,
  conversation_name TEXT,
  group_avatar TEXT,
  description TEXT,
  admin_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE conversation_participants (
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  left_at TIMESTAMPTZ, -- NULL if active, timestamp if left
  last_read_at TIMESTAMPTZ DEFAULT now(),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),--8/2/2026
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  --  receiver_id UUID REFERENCES users(user_id),
  text_content TEXT,
  shared_post_id UUID, -- Reference to shared post (snapshot preserved even if post deleted)
  message_type TEXT DEFAULT 'text', -- 'text', 'system', etc.
  --story_id UUID REFERENCES stories(story_id),
  action_type TEXT, -- 'add', 'leave', 'remove', 'create'
  target_id UUID REFERENCES users(user_id) ON DELETE SET NULL, -- Subject of the action
  author_company_id UUID REFERENCES companies(company_id) ON DELETE SET NULL, -- acting as company
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ, -- NULL if unread
  CONSTRAINT messages_shared_post_id_fkey FOREIGN KEY (shared_post_id) REFERENCES posts(post_id) ON DELETE SET NULL
);

CREATE TABLE notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(user_id) ON DELETE CASCADE, -- Actor who triggered notification
  type TEXT NOT NULL, -- 'like', 'comment', 'view', 'job_alert'
  text TEXT NOT NULL,
  reference_id UUID, -- ID of the post/job/user
  metadata JSONB DEFAULT '{}'::jsonb, -- Additional data (e.g., comment_id, reply_id)
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  location TEXT,
  description TEXT,
  salary_min INTEGER NOT NULL,
  salary_max INTEGER NOT NULL,
  job_type TEXT, -- Full-time, Part-time, Contract etc.
  work_mode job_work_mode, -- Remote | Hybrid | Onsite
  company_type job_company_type, -- Startup | MNC etc.
  experience_level TEXT,
  about_company TEXT,
  industry TEXT NOT NULL , --new field
  easy_apply BOOLEAN DEFAULT false,
  actively_hiring BOOLEAN DEFAULT false,
  match_score INTEGER, -- optional / mock
  is_active BOOLEAN DEFAULT TRUE,
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
  cover_note TEXT,
  current_status TEXT NOT NULL DEFAULT 'Applied',
  applied_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(job_id, applicant_id)
);

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
    profile_owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_profile_views_lookup ON profile_views(viewer_id, profile_owner_id, viewed_at);

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
    blocker_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    blocked_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked_id ON blocks(blocked_id);

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
  media_type TEXT CHECK (media_type IN ('image', 'video')) DEFAULT 'image',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 10/02/2026 Migration: Create companies, company_members, company_invites, company_verifications, audit_logs tables
-- (007_create_companies.sql)

-- 1. COMPANIES Table
CREATE TABLE IF NOT EXISTS companies (
    company_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255), -- Contact email for the company
    industry VARCHAR(100),
    size VARCHAR(50), -- e.g., '1-10', '11-50'
    website VARCHAR(255),
    location VARCHAR(255),
    slogan TEXT,
    logo_url TEXT,
    cover_url TEXT,
    description TEXT,
    
    -- Verification
    verification_status VARCHAR(20) DEFAULT 'UNVERIFIED' 
        CHECK (verification_status IN ('UNVERIFIED', 'DOMAIN_PENDING', 'DOMAIN_VERIFIED', 'REJECTED')),
    
    -- Meta
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

-- Index for slug lookups
CREATE INDEX idx_companies_slug ON companies(slug);
-- Index for domain verification checks (if we add domain column later, or use website)
CREATE INDEX idx_companies_website ON companies(website);


-- 2. COMPANY MEMBERS Table
CREATE TABLE IF NOT EXISTS company_members (
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'RECRUITER', 'ANALYST')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (company_id, user_id)
);

CREATE INDEX idx_company_members_user_id ON company_members(user_id);
CREATE INDEX idx_company_members_role ON company_members(role);


-- 3. COMPANY INVITES Table
CREATE TABLE IF NOT EXISTS company_invites (
    invite_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    inviter_id UUID REFERENCES users(user_id) ON DELETE SET NULL, -- Who sent the invite
    email VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'EDITOR', 'RECRUITER', 'ANALYST')), -- Owner cannot be invited, must be transferred
    token VARCHAR(255) NOT NULL, -- For email link
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(company_id, email) -- One active invite per email per company (simplified)
);

CREATE INDEX idx_company_invites_token ON company_invites(token);


-- 4. COMPANY VERIFICATIONS Table
CREATE TABLE IF NOT EXISTS company_verifications (
    verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    otp VARCHAR(10) NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    is_verified BOOLEAN DEFAULT FALSE -- To track if this specific OTP was used successfully
);


-- 5. AUDIT LOGS Table
-- Generic enough for other systems, but focused on company for now
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(50) NOT NULL, -- e.g., 'COMPANY'
    entity_id UUID NOT NULL, -- company_id
    actor_id UUID REFERENCES users(user_id) ON DELETE SET NULL, -- Who performed the action
    action VARCHAR(50) NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'TRANSFER_OWNERSHIP', 'VERIFY_DOMAIN', 'INVITE_MEMBER'
    metadata JSONB DEFAULT '{}'::jsonb, -- Store diffs or details
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);


-- Triggers for updated_at
CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_company_invites_updated_at
    BEFORE UPDATE ON company_invites
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 11/02/2026 Migration: Add company support for comments and likes
-- 009_company_comments_likes.sql

-- 1. POST COMMENTS
-- Add author_company_id column
ALTER TABLE post_comments
ADD COLUMN author_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;

-- 2. POST LIKES
ALTER TABLE post_likes
ADD COLUMN company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;

-- Drop existing constraint: UNIQUE(post_id, user_id)
ALTER TABLE post_likes
DROP CONSTRAINT post_likes_post_id_user_id_key;

-- Add conditional unique indexes
-- Case 1: User Like (company_id IS NULL)
CREATE UNIQUE INDEX idx_post_likes_user_unique 
ON post_likes (post_id, user_id) 
WHERE company_id IS NULL;

-- Case 2: Company Like (company_id IS NOT NULL)
-- A company can only like a post once. The actor (user) doesn't matter for uniqueness, only the company entity.
CREATE UNIQUE INDEX idx_post_likes_company_unique 
ON post_likes (post_id, company_id) 
WHERE company_id IS NOT NULL;


-- 3. COMMENT LIKES
ALTER TABLE comment_likes
ADD COLUMN company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;

-- Drop existing PK/Constraint: PRIMARY KEY (user_id, comment_id)
ALTER TABLE comment_likes
DROP CONSTRAINT comment_likes_pkey;

-- Add conditional unique indexes
-- Case 1: User Like (company_id IS NULL)
CREATE UNIQUE INDEX idx_comment_likes_user_unique 
ON comment_likes (comment_id, user_id) 
WHERE company_id IS NULL;

-- Case 2: Company Like (company_id IS NOT NULL)
CREATE UNIQUE INDEX idx_comment_likes_company_unique 
ON comment_likes (comment_id, company_id) 
WHERE company_id IS NOT NULL;

-- 11/02/2026 Migration: Phase 1 Production Fixes
-- (010_phase1_production_fixes.sql)

-- 1. STORIES ATTRIBUTION
ALTER TABLE stories
ADD COLUMN author_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;

-- 2. POSTS ATTRIBUTION (Missing from prev migrations)
ALTER TABLE posts
ADD COLUMN author_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;

-- 3. PERFORMANCE INDEXES for Company Foreign Keys
CREATE INDEX IF NOT EXISTS idx_posts_author_company_id ON posts(author_company_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_author_company_id ON post_comments(author_company_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_company_id ON post_likes(company_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_company_id ON comment_likes(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_company_id ON notifications(recipient_company_id);
CREATE INDEX IF NOT EXISTS idx_stories_author_company_id ON stories(author_company_id);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer_company_id ON story_views(viewer_company_id);
CREATE INDEX IF NOT EXISTS idx_story_reactions_reactor_company_id ON story_reactions(reactor_company_id);

-- 4. SEARCH OPTIMIZATION (GIN index for companies)
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm
ON companies USING GIN (name gin_trgm_ops);

-- ANALYZE for statistics
ANALYZE companies;
ANALYZE posts;
ANALYZE post_comments;
ANALYZE stories;

-- 11/02/2026 Migration: Phase 3 Social Growth
-- (011_company_followers.sql)

CREATE TABLE IF NOT EXISTS company_followers (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_company_followers_company_id ON company_followers(company_id);
