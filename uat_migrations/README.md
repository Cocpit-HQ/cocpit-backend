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
Brings UAT database schema into alignment for Release 1.8.0 (`organization_notification_settings`).

#### Changes Included:
1. **`organization_notification_settings` table & index**:
   - Creates table for organization-wide notification preferences (`org_id` PK, `user_id`, `events_enabled`, `jobs_enabled`, `posts_enabled`, `messages_enabled`, `messages_chat_enabled`, `messages_jobs_enabled`, `email_enabled`, `push_enabled`, `created_at`, `updated_at`).
   - Adds index `idx_org_notification_settings_org_id ON organization_notification_settings(org_id)`.

---

## How to Run

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
