# Backend Architecture Analysis + PostgreSQL Schema + Auth System

## Overview
This document provides a comprehensive analysis of the frontend data model and designs a production-ready PostgreSQL backend. It includes a normalized 3NF schema, executable SQL queries, and a secure JWT-based authentication system.

**Objective:**
- Analyze frontend entities and relationships.
- Design a normalized PostgreSQL schema (version 15).
- Provide SQL `CREATE TABLE` statements using `pgcrypto` for UUIDs.
- Design a Role-Based Access Control (RBAC) system.
- Document JWT authentication flow and API contracts.

---

## Frontend Data Model Analysis

The frontend relies on several React Contexts and TypeScript interfaces to manage state. We have identified the following key entities:

### 1. Users & Profiles
- **Context/Source**: `src/types/user.ts`, `src/lib/data/users.ts`
- **Purpose**: Represents the core user identity and their professional profile.
- **Key Fields**:
  - `User`: ID, name, email, headline, avatar, location, about.
  - `Profile`: Extended attributes like `experiences`, `educations`, and `skills`.
  - `Identity Chips`: "Open To", "Availability", "Work Preference".
  - `Insights`: Analytics data (views, search appearances).
- **Relationships**:
  - A User has one Profile.
  - A Profile has many Experiences, Educations, and Skills.

### 2. Jobs & Applications
- **Context/Source**: `JobsContext`, `src/types/jobs.ts`
- **Purpose**: Job listings and the user's interaction with them.
- **Key Fields**:
  - `Job`: Title, company, location, salary, work mode (Remote/Hybrid), company type, match score.
  - `Application`: Status (Applied, Interviewing, Offer), Timeline history.
- **Relationships**:
  - Users apply to Jobs.
  - Users save Jobs.

### 3. Events
- **Context/Source**: `EventsContext`, `src/types/events.ts`
- **Purpose**: Professional gatherings, webinars, and meetups.
- **Key Fields**: Title, date, location, type (Online/InPerson), organizer info, attendees count.
- **Relationships**:
  - Users register for Events.
  - Users save Events.
  - Users (Organizers) create Events.

### 4. Feed & Posts
- **Context/Source**: `FeedContext`, `src/types/entities.ts`
- **Purpose**: User-generated content shared on the feed.
- **Key Fields**: Content, media (images/video), category (Personal/Professional/Achievement), visibility.
- **Relationships**:
  - Users create Posts.
  - Users like and comment on Posts.

### 5. Social & Messaging
- **Context/Source**: `SocialContext`, `src/data/mockMessaging.ts`
- **Purpose**: Connections and private communication.
- **Key Fields**:
  - `ChatThread`: Participants, last message, unread count.
  - `Message`: Sender, text, timestamp.
- **Relationships**:
  - Users follow other Users.
  - Users participate in Conversations.

### 6. Stories (Showcase)
- **Context/Source**: `src/constants/stories.ts`
- **Purpose**: Ephemeral content (24h visibility).
- **Key Fields**: Media URL, viewers list, expiration.

---

## PostgreSQL Schema Design

This schema is designed with **strict 3NF normalization**. It avoids `JSONB` for core relational data to ensure data integrity and queryability.

### key Decisions
- **PostgreSQL 15**: Leveraging stable features.
- **UUIDs**: All primary keys use `gen_random_uuid()` via the `pgcrypto` extension.
- **Naming Convention**: `snake_case` for all tables and columns.
- **No JSONB for Structured Data**: Skills, Experiences, Educations, and Job Timelines are stored in separate tables.
- **Authentication**: Passwords are hashed in the application layer (e.g., bcrypt), not the DB.

### Tables Overview

#### IAM (Identity & Access Management)
- **`users`**: Central identity table.
- **`roles`**: Definitions for 'User', 'Recruiter', 'Admin'.
- **`user_roles`**: Many-to-many link for role assignment.
- **`refresh_tokens`**: Securely stored tokens for JWT rotation.

#### Profile & Professional Data
- **`profiles`**: Stores identity chips (`open_to`, `work_preference`) and links to the user.
- **`experiences`**: Professional history.
- **`educations`**: Academic history.
- **`skills`**: Global lookup table for skills (prevents duplicates).
- **`user_skills`**: Links profiles to skills.
- **`experience_skills`**: Links specific experiences to skills (for validation/context).

#### Social Graph & Content
- **`followers`**: Directed graph (follower -> following).
- **`posts`**: User content with visibility settings.
- **`post_categories`**: Lookup for 'Personal', 'Professional', 'Achievement'.
- **`post_media`**: Images or videos attached to posts.
- **`stories`**: Ephemeral media.
- **`story_views`**: Tracking who viewed a story.
- **`story_reactions`**: Likes/reactions on stories.

#### Jobs System
- **`jobs`**: Listings created by Recruiters or scraped.
- **`job_applications`**: Tracks the *current* status of a user's application.
- **`application_status_history`**: Audit log of status changes (e.g., 'Applied' -> 'Interview').

#### Events & Messaging
- **`events`**: Event details.
- **`event_registrations`**: Link between users and events.
- **`conversations`**: Chat threads.
- **`conversation_participants`**: Users in a thread.
- **`messages`**: Individual messages within a thread.
- **`notifications`**: User alerts for system activity.


## SQL Schema (CREATE TABLE Statements)

Run the following SQL in a PostgreSQL 15 database.

### 1. Extensions & Enums

```sql
-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums for constrained values (or use lookup tables if mutable)
CREATE TYPE visibility_type AS ENUM ('public', 'connections', 'private');
CREATE TYPE connection_status AS ENUM ('pending', 'connected', 'blocked');
CREATE TYPE job_work_mode AS ENUM ('Remote', 'Hybrid', 'Onsite');
CREATE TYPE job_company_type AS ENUM ('Startup', 'MNC', 'Product-based', 'Service-based');
CREATE TYPE event_type AS ENUM ('Online', 'InPerson');
CREATE TYPE sender_type AS ENUM ('me', 'other'); -- Frontend uses 'me'/'other', but DB should track user_id
```

### 2. IAM & Users

```sql
CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, -- Hashed via bcrypt/argon2 in app
  full_name TEXT NOT NULL,
  headline TEXT,
  avatar_url TEXT,
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
  revoked BOOLEAN DEFAULT FALSE
);
```

### 3. Profile Data

```sql
CREATE TABLE profiles (
  profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  -- Identity Chips
  open_to TEXT, -- e.g., 'Full-time', 'Freelance'
  availability TEXT, -- e.g., 'Immediate'
  work_preference TEXT, -- e.g., 'Remote', 'Hybrid'
  -- Metrics
  profile_views_count INTEGER DEFAULT 0,
  search_appearances_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
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
```

### 4. Content (Posts & Stories)

```sql
CREATE TABLE post_categories (
  category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL -- 'Personal', 'Professional', 'Achievement'
);

CREATE TABLE posts (
  post_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  category_id UUID REFERENCES post_categories(category_id),
  content TEXT,
  visibility visibility_type DEFAULT 'public',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE post_media (
  media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(post_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  media_type TEXT, -- 'image' or 'video'
  aspect_ratio TEXT -- e.g., '4:5'
);

CREATE TABLE stories (
  story_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  media_url TEXT NOT NULL,
  media_type TEXT DEFAULT 'image',
  expires_at TIMESTAMPTZ NOT NULL, -- usually created_at + 24h
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
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  reaction_type TEXT, -- e.g., '❤️', '🔥'
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);
```

### 5. Social & Messaging

```sql
CREATE TABLE followers (
  follower_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  following_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (follower_id, following_id)
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
  text_content TEXT,
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
```

### 6. Jobs System

```sql
CREATE TABLE jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  location TEXT,
  description TEXT,
  salary_range TEXT, -- Keeping as text per frontend 'Avg' logic, or use numeric range
  work_mode job_work_mode,
  company_type job_company_type,
  experience_level TEXT,
  match_score INTEGER, -- Mock score
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE job_applications (
  application_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(job_id) ON DELETE CASCADE,
  applicant_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  current_status TEXT NOT NULL DEFAULT 'Applied',
  applied_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(job_id, applicant_id)
);

CREATE TABLE application_status_history (
  history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES job_applications(application_id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- 'Applied', 'Under Review', 'Interview', 'Offer'
  changed_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT
);
```

### 7. Events

```sql
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
```


## Role-Based Authentication Design

### Role Hierarchy
- **User (Base Role)**: Default for all registered users. Can edit profile, post content, apply to jobs, and view events.
- **Recruiter**: Extends **User**. Can create jobs, view applicants, and update application statuses.
- **Admin**: Full system access. Can manage users, moderate content, and configure system settings.

### Database Strategy
Roles are stored in the `roles` table and assigned via `user_roles`. This allows for future flexibility (e.g., a user can be both a Recruiter and an Admin, though typically roles are singular in simple apps).

### Permission Logic
- **Middleware Check**: API routes will check for role presence.
  - `GET /jobs`: Open to all.
  - `POST /jobs`: Requires `recruiter` or `admin`.
  - `DELETE /users/:id`: Requires `admin`.
- **Event Organizers**: Not a separate role. Implemented via `events.organizer_id`. Users can only edit events they own (or if they are Admin).

---

## JWT Authentication Strategy

We use a **dual-token system** to balance security and user experience.

### 1. Access Token (Short-lived)
- **Format**: JWT (JSON Web Token)
- **Payload**: `{ userId, email, role, exp }`
- **Lifespan**: 15 minutes
- **Storage**: Memory (client-side variable) or non-httpOnly cookie (if needing access in generic fetch). Ideally Memory.
- **Usage**: Sent in `Authorization: Bearer <token>` header for API requests.

### 2. Refresh Token (Long-lived)
- **Format**: Opaque UUID (or JWT)
- **Lifespan**: 7 days
- **Storage**: **httpOnly, Secure, SameSite=Strict Cookie**.
- **Usage**: Sent automatically by the browser to `/auth/refresh` to get a new Access Token.
- **Rotation**:
  - When a refresh token is used, it is invalidated (or rotated).
  - The database tracks `refresh_tokens` (hash, user_id, expires_at).
  - If a used token is presented again (replay attack), invalidate *all* tokens for that user.

### Logout Flow
1. Client calls `/auth/logout`.
2. Server deletes the refresh token from the database.
3. Server clears the httpOnly cookie.

---

## Authentication API Design

### 1. Register
- **Endpoint**: `POST /auth/register`
- **Body**: `{ email, password, fullName, role? }` (Role defaults to 'User' unless admin key provided)
- **Response**: `201 Created`
- **Security**: Hash password with bcrypt before storing.

### 2. Login
- **Endpoint**: `POST /auth/login`
- **Body**: `{ email, password }`
- **Response**:
  - Body: `{ accessToken: "eyJ...", user: { id, name, role } }`
  - Cookie: `refreshToken=abc-123; HttpOnly; Secure; Path=/auth/refresh`

### 3. Refresh Token
- **Endpoint**: `POST /auth/refresh`
- **Cookie**: `refreshToken`
- **Response**:
  - Body: `{ accessToken: "new-jwt..." }`
  - Cookie: `refreshToken=new-token; ...` (Rotation)

### 4. Get Current User
- **Endpoint**: `GET /auth/me`
- **Headers**: `Authorization: Bearer <accessToken>`
- **Response**:
  ```json
  {
    "user_id": "uuid...",
    "email": "user@example.com",
    "full_name": "Jane Doe",
    "roles": ["User"],
    "profile_id": "uuid..."
  }
  ```
- **Note**: Does *not* return heavy data like experiences or skills.

### 5. Logout
- **Endpoint**: `POST /auth/logout`
- **Cookie**: `refreshToken`
- **Action**: Delete token from DB, clear cookie.
- **Response**: `200 OK`


## PostgreSQL Setup Guide

Follow these steps to set up the database and apply the schema.

### 1. Install PostgreSQL
- **Linux (Ubuntu)**:
  ```bash
  sudo apt update
  sudo apt install postgresql postgresql-contrib
  ```
- **Windows**: Download and install from [postgresql.org](https://www.postgresql.org/download/windows/).

### 2. Create Database & User
Access the `psql` shell:
```bash
sudo -u postgres psql
```

Run SQL commands:
```sql
CREATE DATABASE platform_db;
CREATE USER platform_admin WITH ENCRYPTED PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE platform_db TO platform_admin;
```

### 3. Apply Schema
Connect to the new database:
```bash
psql -U platform_admin -d platform_db -f schema.sql
```
*(Or copy-paste the SQL queries from the 'SQL Schema' section above into your DB tool).*

### 4. Connection String
Use this environment variable in your backend (Node/Express/Next.js):
```env
DATABASE_URL=postgres://platform_admin:secure_password@localhost:5432/platform_db
```

---

## Security Best Practices

### 1. Password Hashing
- **Algorithm**: Use **bcrypt** (cost factor 10+) or **Argon2id**.
- **Never** store plain-text passwords.
- **Library**: Use `bcryptjs` or `argon2` in Node.js.

### 2. SQL Injection Prevention
- Use **Parameterized Queries** or an ORM (like Prisma, TypeORM, or Drizzle).
- **Never** concatenate strings directly into SQL queries.
  - ❌ `db.query("SELECT * FROM users WHERE email = '" + email + "'")`
  - ✅ `db.query("SELECT * FROM users WHERE email = ", [email])`

### 3. Rate Limiting
- Implement rate limiting on sensitive routes (`/auth/login`, `/auth/register`).
- Example: Max 5 login attempts per minute per IP.
- Use libraries like `express-rate-limit` or Redis-based limiters.

### 4. CORS & Headers
- Restrict Access-Control-Allow-Origin to your frontend domain.
- Use Helmet.js to set security headers (X-Frame-Options, CSP, etc.).

### 5. Audit Logging
- Track critical actions (login, role change, data deletion).
- Store logs in a separate table or external logging service.
