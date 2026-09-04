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

## How to Run

Whenever you are ready to apply the migration, you can run it using any of the following methods:

### Option 1: Using npm script
```bash
npm run migrate:uat
```

### Option 2: Using Node runner directly
```bash
node uat_migrations/run_uat_migration.js
```

### Option 3: Using `psql` directly
```bash
psql -h 192.168.1.50 -U swaroop -d cocpit_backend_uat -f uat_migrations/v1.1.0_uat_migration.sql
```
