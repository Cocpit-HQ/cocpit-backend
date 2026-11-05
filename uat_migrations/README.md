# UAT Migrations

This directory contains versioned incremental migration files and execution runners for the UAT database (`cocpit_backend_uat`).

---

## Migrations

### `v1.1.0_uat_migration.sql`
Synchronizes the UAT database with the Staging database (`schema.sql`).

#### Changes Included:
1. **`users` table**:
   - Adds `dob DATE` column.
2. **`organizations` table**:
   - Adds `legal_name VARCHAR(255)` column.
   - Adds `incorporation_date DATE` column.
3. **`email_otps` table**:
   - Adds `purpose VARCHAR(100) NOT NULL DEFAULT 'signup'`.
   - Adds `session_expires_at TIMESTAMPTZ`.
   - Adds `verified_at TIMESTAMPTZ`.
   - Drops single-email constraint `unique_email_otp`.
   - Adds compound constraint `unique_email_otp_purpose UNIQUE (email, purpose)`.
4. **`password_reset_tokens` table**:
   - Ensures table and lookup indexes exist.
5. **`blocks` table & `active_users` view**:
   - Drops foreign key block constraints and ensures `active_users` view is up to date.

---

### `v1.6.0_uat_migration.sql`
Brings UAT database schema into alignment with Staging for the v1.6.0 release (Business Profile, Organization Location, International Phone Number support).

#### Changes Included:
1. **`organizations` table**:
   - Adds `location_formatted TEXT` column.
   - Adds `location_lat DOUBLE PRECISION` column.
   - Adds `location_lng DOUBLE PRECISION` column.
   - Adds `location_place_id TEXT` column.
   - Adds `idx_organizations_location_coords` spatial index.
   - Expands `headline` from `VARCHAR(200)` to `VARCHAR(255)` with full dependent-view drop/recreate cycle.
2. **`users` table**:
   - Drops old `mobile_format` constraint (strict 10-digit).
   - Adds new `mobile_format` check: nullable + `'^[0-9]{7,15}$'` (international support).
3. **`event_registrations` table**:
   - Same `mobile_format` constraint relaxation as `users`.
4. **`user_search_history` table**:
   - Adds `org_id UUID` column referencing `organizations` (for Business Profile actor isolation, SCRUM-1039).
   - Drops legacy unique index `uq_user_search_history_user_query`.
   - Drops legacy lookup index `idx_user_search_history_user_created`.
   - Creates actor-aware unique index `uq_user_search_history_actor_query`.
   - Creates actor composite lookup index `idx_user_search_history_actor_created`.
5. **`feature_flags` table**:
   - Inserts Teams Module feature flags (`enableTeamsModule`, `enableTeams`, `teams`) with default enabled.

---

### `v1.7.0_uat_migration.sql`
Promotes `MANAGE_COMPANY_DETAILS` from a locked system key (`sort_order = 0`) to a dynamic UI checklist key (`sort_order = 20`) in `organization_permission_keys`.

#### Changes Included:
1. **`organization_permission_keys` table**:
   - Updates `MANAGE_COMPANY_DETAILS` with `sort_order = 20`, `label = 'Edit company profile'`, `ui_type = 'toggle'`, `requires_parent = FALSE`.
   - Allows organization admins to assign profile-editing permissions via dynamic roles in the Teams section.

---

### `v1.8.0_uat_migration.sql`
Brings UAT database schema into alignment for Release 1.8.0 (`organization_notification_settings`, `organization_deactivation_history`, and `user_post_feedback` multi-actor support).

#### Changes Included:
1. **`organization_notification_settings` table & index**:
   - Creates table for organization-wide notification preferences (`org_id` PK, `user_id`, `events_enabled`, `jobs_enabled`, `posts_enabled`, `messages_enabled`, `messages_chat_enabled`, `messages_jobs_enabled`, `email_enabled`, `push_enabled`, `created_at`, `updated_at`).
   - Adds index `idx_org_notification_settings_org_id ON organization_notification_settings(org_id)`.
2. **`organization_members.member_id` column**:
   - Adds surrogate identifier column `member_id UUID DEFAULT gen_random_uuid()`.
3. **`organization_deactivation_history` table & indexes**:
   - Creates audit table tracking organizations automatically frozen during personal account deactivation.
   - Adds index `idx_org_deactivation_history_user_unrecovered` for rapid login/reactivation retrieval.
   - Adds index `idx_org_deactivation_history_org_id` for organization lifecycle tracking.
4. **`user_post_feedback` table enhancements**:
   - Adds `org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE DEFAULT NULL`.
   - Adds surrogate `id UUID PRIMARY KEY`.
   - Creates partial unique index `idx_user_post_feedback_personal` on `(user_id, post_id) WHERE org_id IS NULL`.
   - Creates partial unique index `idx_user_post_feedback_org` on `(org_id, post_id) WHERE org_id IS NOT NULL`.
   - Creates partial lookup indexes `idx_user_post_feedback_filter_org` and `idx_user_post_feedback_filter_user`.

---

### `v1.9.0_uat_migration.sql`
Brings UAT database schema into alignment for Release 1.9.0 (Mixed Media Carousel: Images & Videos support, Jobs Explore & Recommendation System, and Reusable Resume History).

#### Changes Included:
1. **`post_media` table**:
   - Adds `order_index INT DEFAULT 0` column for deterministic carousel sequencing.
   - Adds `thumbnail_url TEXT` column for video slide posters.
   - Adds `duration_seconds NUMERIC(6,2)` column for video durations.
   - Backfills existing records with sequential ordering per post.
   - Creates index `idx_post_media_post_order ON post_media(post_id, order_index)`.
2. **`experiences` table**:
   - Adds `org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL` column to link user work experience with official organizations.
   - Creates index `idx_experiences_org_id ON experiences(org_id)`.
   - Creates partial index `idx_experiences_current_org ON experiences(org_id) WHERE is_current = TRUE AND org_id IS NOT NULL` for rapid resolution of 1st-degree connections who currently work at hiring organizations ("From your network").
3. **`jobs` table**:
   - Creates partial composite index `idx_jobs_active_created ON jobs(created_at DESC, job_id DESC) WHERE is_active = TRUE AND status = 'ACTIVE'` for high-throughput listing retrieval and keyset pagination across all recommendation categories.
4. **`job_saves` table**:
   - Creates reverse lookup index `idx_job_saves_job_id ON job_saves(job_id)` to optimize `saves_count` aggregation queries used by the Featured opportunities quality heuristic.
5. **`user_activity_log` table**:
   - Creates targeted partial index `idx_activity_job_views ON user_activity_log(user_id, entity_id, created_at DESC) WHERE action_type = 'view_job' AND entity_type = 'job'` for sub-millisecond retrieval of candidate Recently Viewed jobs.
6. **`user_resume_history` table**:
   - Creates `user_resume_history` table to store applicant reusable resumes.
   - Creates index `idx_user_resume_history_user_last_used ON user_resume_history(user_id, last_used_at DESC)`.
   - Backfills `user_resume_history` records from existing `job_applications`.

---

## How to Run

### Running v1.9.0 Migration

#### Option 1: Using npm script (recommended)
```bash
npm run migrate:uat:v1.9.0
```

#### Option 2: Using Node runner directly
```bash
node uat_migrations/run_v1.9.0_migration.js
```

#### Option 3: Using `psql` directly
```bash
psql -h 192.168.1.50 -U swaroop -d cocpit_backend_uat -f uat_migrations/v1.9.0_uat_migration.sql
```

---

### Running v1.8.0 Migration

#### Option 1: Using npm script (recommended)
```bash
npm run migrate:uat:v1.8.0
```

#### Option 2: Using Node runner directly
```bash
node uat_migrations/run_v1.8.0_migration.js
```

#### Option 3: Using `psql` directly
```bash
psql -h 192.168.1.50 -U swaroop -d cocpit_backend_uat -f uat_migrations/v1.8.0_uat_migration.sql
```

---

### Running v1.7.0 Migration

#### Option 1: Using npm script (recommended)
```bash
npm run migrate:uat:v1.7.0
```

#### Option 2: Using Node runner directly
```bash
node uat_migrations/run_v1.7.0_migration.js
```

#### Option 3: Using `psql` directly
```bash
psql -h 192.168.1.50 -U swaroop -d cocpit_backend_uat -f uat_migrations/v1.7.0_uat_migration.sql
```

---

### Running v1.6.0 Migration
```bash
npm run migrate:uat:v1.6.0
```

---

### Running v1.1.0 Migration (legacy)

```bash
npm run migrate:uat
# or
node uat_migrations/run_uat_migration.js
```
