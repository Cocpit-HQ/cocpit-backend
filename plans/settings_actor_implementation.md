# SETTINGS ACTOR CONTEXT IMPLEMENTATION PLAN (W5 SPECIFICATION)
**Senior Full Stack Developer Specification**
**Repository:** Cocpit Backend Architecture
**Reference Documents:** PM Specification (`businesSettingDocPM.docx`) & User Directives
**Date:** 2026-08-05

---

## 1. W5 ARCHITECTURE FRAMEWORK

### 1. WHO
- **Developer Role**: Senior Full Stack Developer.
- **Active Actor Contexts**:
  - **Personal User Actor** (`x-actor-type: USER`, `x-actor-id: <user_id>`): Individual human user.
  - **Business/Organization Actor** (`x-actor-type: ORGANIZATION` | `COMPANY` | `INSTITUTION` | `INSTITUTE`, `x-actor-id: <org_id>`): User acting on behalf of a company or institution.
- **RBAC Matrix**:
  - **Owner Role** (`created_by` / `Owner` role): Full access to ALL organization settings, including 3 **Owner-Only Actions**: **Deactivate**, **Transfer Ownership**, and **Delete Account**.
  - **Admin / Member Role** (with `MANAGE_SETTINGS` / `SETTINGS` / `*` permission): Full access to organization settings options (email, phone, privacy, notifications, blocked accounts), **EXCEPT the 3 Owner-Only Actions** (Deactivate, Transfer Ownership, Delete Account). Non-permissioned members receive 403.

### 2. WHAT
- **Core Deliverables**:
  1. **Institution Actor Type Mapping**: Add `INSTITUTION` and `INSTITUTE` to `normalizeActorType` in `actor-context.middleware.js`.
  2. **Zero URL Change Policy**: All existing API endpoints (`/api/user/*`, `/api/settings/*`) are reused and made 100% actor-aware (`x-actor-type`, `x-actor-id`).
  3. **Unified Single Delete OTP API**: `POST /api/user/account/delete-otp` sends deletion OTP to registered primary email for User or Org Owner. `DELETE /api/user/account` accepts `{ otp }` and executes 40-day soft deletion.
  4. **Deactivation & Reactivation Architecture**: `PATCH /api/organizations/:orgId/deactivate` (soft hides org page, retains posts/followers) and `PATCH /api/organizations/:orgId/reactivate` (owner personal session restoration).
  5. **Reuse Transfer Ownership API**: Reuses existing `POST /api/organizations/:orgId/transfer-ownership` and member list API `GET /api/organizations/:orgId/teams/members`.
  6. **Profile Permission Keys & Zero Network Data Leak**: Surface `showMessage`, `showFollowersList`, `showFollowingList`, and `tagPermission` in profile endpoints (`GET /api/profile`, `GET /api/organizations/:slug`). When permission is `false`, backend **strips sensitive data payload** (returns `null`/`[]`) to prevent network data leaks.
  7. **Org-Wide Notification Preferences**: Applied org-wide per `org_id` in `organization_notification_preferences`, supporting `message_chats` and `message_jobs` sub-toggles.
  8. **Device-Scoped Theme**: DB theme persistence commented out; theme managed at client/device level.
  9. **Audit Logging & Socket Events**: All org settings changes logged via `logAudit` (`entityType: 'ORGANIZATION'`) and emitted via Socket.IO events (`ORGANIZATION_PRIVACY_UPDATED`, `ORGANIZATION_NOTIFICATIONS_UPDATED`, `ORGANIZATION_DEACTIVATED`, `ORGANIZATION_REACTIVATED`).
  10. **Schema Tracking**: `schema.sql` updated alongside `20260805_settings_actor_context.sql`.

### 3. WHERE
- **Middleware**: `src/core/middlewares/actor-context.middleware.js`, `src/core/middlewares/organization.auth.middleware.js`, `src/core/middlewares/org-rbac.middleware.js`.
- **Controllers**: `src/modules/settings/preferences.controller.js`, `src/modules/user/userSettings.controller.js`, `src/modules/organization/organization.settings.controller.js`, `src/modules/organization/organization.profile.controller.js`, `src/modules/content/postTags.controller.js`.
- **Infrastructure**: `src/services/audit.service.js` (`logAudit`), `src/core/infrastructure/socket.service.js`.
- **Database & Tracking**: `src/db/migrations/20260805_settings_actor_context.sql` & `schema.sql`.

### 4. WHEN
- **Actor Resolution**: Evaluated per request via headers (`x-actor-type`, `x-actor-id`).
- **OTP Verification**: Required before email update or account/org deletion.
- **Audit & Socket Dispatch**: Executed synchronously upon setting mutation.

### 5. WHY
- Guarantees zero breaking changes for existing API consumers while delivering complete actor isolation.
- Resolves institution RBAC issues.
- Prevents network data leaks by stripping unpermitted profile data on the backend.

---

## 2. DETAILED IMPLEMENTATION STEPS

### STEP 1: FIX INSTITUTION ACTOR TYPE RESOLUTION & PERMISSION ALIASES
File: `src/core/middlewares/actor-context.middleware.js`
```javascript
const normalizeActorType = (rawType) => {
    if (!rawType || typeof rawType !== "string") return null;
    const normalized = rawType.trim().toUpperCase();
    if (["COMPANY", "ORG", "ORGANIZATION", "INSTITUTION", "INSTITUTE"].includes(normalized)) {
        return "ORGANIZATION";
    }
    if (normalized === "USER") return "USER";
    return null;
};
```

---

### STEP 2: DATABASE MIGRATION & SCHEMA.SQL TRACKING
File: `src/db/migrations/20260805_settings_actor_context.sql` AND `schema.sql`

```sql
-- 1. Organization Privacy Settings Table
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

-- 2. Extended Organization Notification Preferences
ALTER TABLE organization_notification_preferences
    ADD COLUMN IF NOT EXISTS messages_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS messages_chat_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS messages_jobs_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT true;

-- 3. Deactivation Support for Organizations
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- 4. Organization Blocked Accounts Table
CREATE TABLE IF NOT EXISTS organization_blocked_accounts (
    block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    blocked_type VARCHAR(20) NOT NULL CHECK (blocked_type IN ('user', 'company')),
    blocked_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, blocked_type, blocked_id)
);
```

---

### STEP 3: CONTROLLER ACTOR BRANCHING & AUDIT LOGGING

1. **Privacy Settings (`getPrivacySettings` / `updatePrivacySettings`)**:
   - Inspect `req.actor`.
   - If `ORGANIZATION`: Query/Upsert `organization_privacy_settings WHERE org_id = $1`.
   - Log Audit: `logAudit(pool, { entityId: req.actor.orgId, entityType: 'ORGANIZATION', actorId: req.user.sub, action: 'ORGANIZATION_PRIVACY_UPDATED', metadata: req.body })`.
   - Socket IO: Emit `ORGANIZATION_PRIVACY_UPDATED`.

2. **Notification Preferences (`getNotificationPreferences` / `updateNotificationPreferences`)**:
   - Inspect `req.actor`.
   - If `ORGANIZATION`: Query/Upsert `organization_notification_preferences WHERE org_id = $1` (Org-wide preference).
   - Log Audit: `logAudit(pool, { entityId: req.actor.orgId, entityType: 'ORGANIZATION', actorId: req.user.sub, action: 'ORGANIZATION_NOTIFICATIONS_UPDATED', metadata: req.body })`.
   - Socket IO: Emit `ORGANIZATION_NOTIFICATIONS_UPDATED`.

3. **Unified OTP Account/Org Deletion**:
   - `POST /api/user/account/delete-otp`: Checks `req.actor`. Sends OTP to registered primary email for User or Org Owner.
   - `DELETE /api/user/account`: Accepts `{ otp }`. Verifies OTP -> executes 40-day soft deletion for user or organization.

4. **Deactivation & Reactivation**:
   - `PATCH /api/organizations/:orgId/deactivate`: Owner-only (`req.user.sub === created_by`). Sets `is_deactivated = true, deactivated_at = NOW()`. Logs audit & emits socket event.
   - `PATCH /api/organizations/:orgId/reactivate`: Owner-only. Sets `is_deactivated = false, deactivated_at = NULL`.

---

### STEP 4: PROFILE PERMISSION KEYS & ZERO DATA LEAK STRIPPING

1. Update `organization.profile.controller.js` and `user.controller.js` profile GET responses:
   - Calculate boolean keys: `showMessage`, `showFollowersList`, `showFollowingList`, and `tagPermission`.
   - **Backend Data Stripping**: If `showFollowersList === false`, set `followers = []` and `followers_count = 0` (or hide). If `showEmail === false`, set `email = null`.
2. Update `GET /api/organizations/:orgId/followers` & `GET /api/organizations/:orgId/following`:
   - Verify `followers_visibility` / `following_visibility`. If permission denied, return `{ success: true, hasAccess: false, data: [] }`.

---

## 3. VERIFICATION & TESTING

1. **Network Data Leak Test**: Fetch organization profile as non-follower when `followers_visibility = 'followers_only'`. Inspect network response: verify `showFollowersList = false` AND followers payload is empty (`[]`), preventing network tab data leaks.
2. **Actor Context Reuse Test**: Call `GET /api/user/privacy` with `x-actor-type: USER` vs `x-actor-type: INSTITUTION`. Verify correct settings returned for each context.
3. **Owner-Only Enforcement Test**: Call `PATCH /deactivate` as non-owner Admin. Verify 403 Forbidden.
