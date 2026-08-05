# SETTINGS ACTOR CONTEXT ANALYSIS REPORT
**Senior Full Stack Developer Analysis**
**Repository:** Cocpit Engine / Business & Personal Settings Architecture
**Reference Documents:** PM Specification (`businesSettingDocPM.docx`) & User Technical Directives
**Date:** 2026-08-05

---

## EXECUTIVE SUMMARY

This analysis report documents the final settings architecture, endpoint reuse strategy, audit logging requirements, real-time socket events, permission validation rules, and network data leak protection protocols for the Cocpit platform.

---

## SECTION 1 — CRITICAL BUG RESOLUTION & ACTOR HEADER MAPPING

### Institution & Entity Header Normalization
- **Header Received**: `x-actor-type` (Values: `"INSTITUTION"`, `"INSTITUTE"`, `"COMPANY"`, `"ORG"`, `"ORGANIZATION"`, `"USER"`).
- **Resolution**: In `actor-context.middleware.js`, `normalizeActorType(rawType)` accepts `"INSTITUTION"` and `"INSTITUTE"` and normalizes them to `"ORGANIZATION"` context.
- **RBAC Aliasing**: Normalizes permission aliases (`MANAGE_COMPANY`, `MANAGE_INSTITUTION`, `MANAGE_ORGANIZATION`, `MANAGE_SETTINGS`, `SETTINGS`) so institution roles pass authorization seamlessly.

---

## SECTION 2 — UNIFIED ENDPOINTS & ZERO URL CHANGE POLICY

No existing API endpoint URLs are changed. All endpoints are reused and rendered **100% Actor-Aware** via `x-actor-type` and `x-actor-id`:

| Action / Setting | Reused API Endpoint | Personal Behavior (`USER`) | Business Behavior (`ORGANIZATION` / `INSTITUTION`) |
|---|---|---|---|
| **Request Delete OTP** | `POST /api/user/account/delete-otp` | Sends OTP to user's registered primary email. | Verifies user is Owner (`created_by`), then sends deletion OTP to owner's registered email. |
| **Confirm Deletion** | `DELETE /api/user/account` | Accepts `{ otp }` -> 40-day soft deletion of user account. | Accepts `{ otp }` -> 40-day soft deletion of organization page (`organizations.is_deleted = true`). |
| **Email Change** | `PUT /api/user/email` & `confirm` | OTP to new email -> updates `users.email`. | OTP to new email -> updates `organizations.email` (**no password required**). |
| **Privacy Settings** | `GET/PUT /api/user/privacy` | Reads/updates `users` privacy. | Reads/updates `organization_privacy_settings` (3-option tag scale & audience controls). |
| **Notification Prefs** | `GET/PUT /api/user/notifications/preferences` | Reads/updates `user_notification_preferences`. | Reads/updates `organization_notification_preferences` (org-wide, includes `message_chats`/`message_jobs` sub-toggles). |
| **Blocked Accounts** | `GET/DELETE /api/user/blocked` | Reads/removes `user_blocks`. | Reads/removes `organization_blocked_accounts` (`blocked_type: 'user' | 'company'`). |
| **Transfer Ownership** | `POST /api/organizations/:orgId/transfer-ownership` | N/A | Owner-only: transfers ownership to a team member in `organization_members`. Reuses member list API `GET /api/organizations/:orgId/teams/members`. |

---

## SECTION 3 — DEACTIVATION & REACTIVATION ARCHITECTURE

### 1. Deactivate Organization (`PATCH /api/organizations/:orgId/deactivate`)
- **Access**: Strictly restricted to Owner (`created_by` / Owner role). Non-owners receive 403 Forbidden.
- **Action**: Sets `is_deactivated = true`, `deactivated_at = NOW()`.
- **Platform Effect**: Exactly like soft-deletion, a deactivated organization is hidden from active platform operations (Feeds, Search, Public Profiles, Tagging, New DMs). All posts, followers, and members are retained.
- **Audit & Socket**: Logs `ORGANIZATION_DEACTIVATED` audit log and emits `ORGANIZATION_DEACTIVATED` socket event.

### 2. Reactivate Organization (`PATCH /api/organizations/:orgId/reactivate`)
- **Access**: Strictly restricted to Owner (`created_by`), executed from the owner's personal account dashboard (since the deactivated org page is hidden).
- **Action**: Sets `is_deactivated = false`, `deactivated_at = NULL`.
- **Platform Effect**: Instantly restores organization visibility across Feeds, Search, Profiles, and Chat.
- **Audit & Socket**: Logs `ORGANIZATION_REACTIVATED` audit log and emits `ORGANIZATION_REACTIVATED` socket event.

---

## SECTION 4 — NETWORK DATA LEAK PROTECTION & PERMISSION KEYS

To protect sensitive data from being inspected or leaked in Browser Developer Tools / Network Tab:
1. **Boolean Visibility Keys**:
   - `showMessage`: `true` if requesting user is permitted to send DMs based on `message_permission`, `false` otherwise.
   - `showFollowersList`: `true` if requesting user is permitted to view followers list based on `followers_visibility`, `false` otherwise.
   - `showFollowingList`: `true` if requesting user is permitted to view following list based on `following_visibility`, `false` otherwise.
   - `tagPermission`: `'everyone' | 'followers_only' | 'no_one'`.
2. **Backend Payload Stripping (Zero Network Data Leak)**:
   - When boolean key is `false`, the backend **strips the sensitive payload entirely**, setting `email = null`, `phone = null`, `followers = []`, `following = []`.
   - `GET /api/organizations/:orgId/followers` and `GET /api/organizations/:orgId/following` return an empty array `[]` with `{ hasAccess: false }` when visibility is restricted.
