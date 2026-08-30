# Analytics Database Schema Updates

This document tracks the required database schema changes to support the new user analytics frontend implementation.

> **Note on existing schema**: Before adding anything, verify against `schema.sql`. The following already exist and must NOT be recreated:
> - `search_appearances` table (line 1554 in schema.sql) — already has `viewer_id`, `profile_owner_id`, `profile_type`, `appearance_date`, `created_at`.
> - `profiles.profile_views_count` and `profiles.search_appearances_count` — denormalized counters already present on the `profiles` table.
> - `post_impressions` table (line 1664) — already has `impression_id`, `post_id`, `viewer_id`, `viewer_org_id`, `created_at`. Only the `view_date` column is missing.

> **CRITICAL — Two separate counting systems, do NOT mix them:**
>
> | System | Column/Table | What it stores | Who uses it |
> |--------|-------------|----------------|-------------|
> | **Denormalized counter** | `profiles.profile_views_count` | All-time running total, incremented on every profile view | Other parts of the app (e.g. profile badge, quick display) |
> | **Analytics aggregation** | `profile_analytics_daily` | Daily bucketed counts within a date range, populated by a cron job from raw `profile_views` rows | Analytics API endpoints **only** |
>
> **Analytics endpoints must NEVER read `profiles.profile_views_count`**. That counter cannot answer date-filtered queries (e.g. "Last 7 days") or compute trends. All analytics metric computation must go through `profile_analytics_daily` (for profile views and search appearances) or direct `COUNT(1)` row queries on the source tables (for connection requests, followers, etc.) scoped to the requested `startDate`/`endDate`.

## 1. New Tables to Create

### `resume_view_events`
Tracks individual resume view/download events with viewer information.
```sql
CREATE TABLE resume_view_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resume_id UUID REFERENCES user_resumes(resume_id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    event_type VARCHAR(20) CHECK (event_type IN ('view', 'download')),
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_resume_views_resume_id ON resume_view_events(resume_id, created_at DESC);
```

### `profile_analytics_daily`
A pre-aggregated table for fast querying of daily profile stats. Populated by a background cron job from raw event tables.
```sql
CREATE TABLE profile_analytics_daily (
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
CREATE INDEX idx_pad_owner_date ON profile_analytics_daily(profile_owner_id, date DESC);
```

### `post_analytics_daily`
A pre-aggregated table for fast querying of daily post performance. Populated by a background cron job from `post_impressions` and engagement tables.
```sql
CREATE TABLE post_analytics_daily (
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
CREATE INDEX idx_post_analytics_post_date ON post_analytics_daily(post_id, date DESC);
```

## 2. Columns to Add to Existing Tables

| Table | New Column | Type / Constraint | Purpose |
|---|---|---|---|
| `profile_views` | `viewer_industry` | VARCHAR(100) | For Audience Tab demographics — snapshot the viewer's industry at view time so it doesn't change if the viewer updates their profile later |
| `profile_views` | `viewer_company_org_id` | UUID | For Opportunities Tab tracking — org the viewer belongs to |
| `profile_views` | `source` | VARCHAR(50) | Surface/context of the view (e.g. `'job_application_dashboard'`, `'search'`, `'direct'`). Used to identify qualifying opportunity/recruiter views — the correct approach instead of relying on a viewer account flag |
| `profile_views` | `source_post_id` | UUID REFERENCES posts(post_id) | Track profile visits that originated from a specific post (Direct Impact metric) |
| `post_impressions` | `view_date` | DATE | Pre-computed date column for easy daily aggregation without casting `created_at` every query |
| `user_resumes` | `view_count` | INT DEFAULT 0 | Denormalized counter for fast read access |
| `user_resumes` | `download_count` | INT DEFAULT 0 | Denormalized counter for fast read access |
| `followers` | `source_post_id` | UUID REFERENCES posts(post_id) | Track new followers that came from a specific post (Direct Impact metric) |

> **Removed from earlier draft**: `users.is_recruiter` column has been removed. The correct approach for opportunity/recruiter view identification is to filter on `profile_views.source` (the context/surface of the view), not on the viewer's account type flag. A view only qualifies as an opportunity view when it originates from a hiring/recruiting surface, regardless of who the viewer is.

> **Removed from earlier draft**: `profile_link_clicks` table is out of scope for the current analytics plan.

## 3. Background Workers & API Context
- A **daily cron job** will need to be created to populate `profile_analytics_daily` and `post_analytics_daily` from the raw event tables (`profile_views`, `post_impressions`, etc.).
- Update `dashboard.controller.js` and `dashboard.service.js` to ensure the new columns (`viewer_industry`, `source`, `source_post_id`, `viewer_company_org_id`) are written when `POST /dashboard/view` (or equivalent profile view endpoint) is hit.
- Update the follow user endpoint (e.g., `POST /users/:id/follow`) to accept and store a `source_post_id` parameter to attribute new followers to specific posts.
- **Do NOT create a new `search_appearances` table** — it already exists. Ensure the existing insert logic writes to it correctly when a profile appears in search results.