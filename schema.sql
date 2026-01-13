-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums for constrained values (or use lookup tables if mutable)
CREATE TYPE visibility_type AS ENUM ('public', 'connections', 'private');
CREATE TYPE connection_status AS ENUM ('pending', 'connected', 'blocked');
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
  headline TEXT,
  avatar_url TEXT,
  job_title TEXT,
  company_name TEXT,
  school TEXT,
  degree TEXT,
  location TEXT,
  about_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
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

CREATE TABLE post_comments (
  comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);


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
  title TEXT ,
  media_url TEXT NOT NULL,
  media_type TEXT CHECK (media_type IN ('image', 'video')) DEFAULT 'image',
  description TEXT,
expires_at TIMESTAMPTZ NOT NULL,, -- usually created_at + 24h
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE story_views (
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  viewer_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE TABLE story_reactions (
  story_id UUID REFERENCES stories(story_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE, --sender_id instead of user id 
  reaction_type BOOLEAN, 
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

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
  -- pending | connected | rejected
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE (sender_id, receiver_id),
  CHECK (sender_id <> receiver_id)
);

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
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE conversation_participants (
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  --  receiver_id UUID REFERENCES users(user_id),
  text_content TEXT,
  --story_id UUID REFERENCES stories(story_id),
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ -- NULL if unread
);

CREATE TABLE notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'like', 'comment', 'view', 'job_alert'
  text TEXT NOT NULL,
  reference_id UUID, -- ID of the post/job/user
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
  location TEXT,
  event_type event_type NOT NULL,
  max_attendees INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE event_registrations (
  event_id UUID REFERENCES events(event_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  registered_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
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
