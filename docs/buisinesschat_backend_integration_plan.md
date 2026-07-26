# Business Chat Backend Integration Plan (Permanent Repository Record)

**Specification Reference**: `Cocpit.docx` / `buisinesschat.md`  
**Target Codebase**: `cocpit-backend` (`c:\Users\shubh\OneDrive\Desktop\Cocpit\cocpit-backend`)  
**Date**: 2026-07-24  

---

## 1. Executive Summary & Architectural Overview

This document serves as the authoritative, permanent backend integration plan for **Business Chat** (User ↔ Organization messaging) on the Cocpit platform. 

All logic is designed to integrate **directly into the existing backend codebase** (`cocpit-backend/src/modules/social/social.controller.js`, `src/modules/share/share.service.js`, `src/sockets/chat.handler.js`, `src/models/block.model.js`, etc.) without creating redundant new service layers or duplicate APIs.

---

## 2. Core Principles & Business Rules (Complete Specification Compliance)

### Rule 1: Single Thread per User–Company Pair (§3)
- Exactly **one** conversation exists per `(User, Company)` pair regardless of entry point (General Profile Message or Job Application Chat).
- If a conversation already exists in `conversations` + `conversation_participants`, it is **always reused — never duplicated**.

### Rule 2: No Pending / Chat Request State (§1, §5, §14)
- Company conversations do **not** use the Request / Accept-Decline flow.
- All User ↔ Company conversations are created with `is_requesting = FALSE` (automatically active).
- Opening the composer never creates a DB record; the conversation record is created **only when the first message is sent**.

### Rule 3: Actor-Based Inbox Categorization & View Switching (§2, §4, §12)
- **User Mode (`req.actor.type === 'USER'`)**:
  - `GET /conversations` returns the User's personal inbox (conversations where `user_id` is a direct participant).
- **Organization Mode (`req.actor.type === 'ORGANIZATION'`)**:
  - `GET /conversations` returns **ONLY** the Organization's inbox (conversations where `org_id = req.actor.id` in `conversation_participants`).
  - Personal user conversations are strictly excluded.
  - All active admins of the Organization share the same single organizational conversation view.
- **Company Inbox Structure**:
  - Contains strictly **two tabs**: **General** and **Jobs**.
  - No Requests tab, No Groups tab.

### Rule 4: Group Chat Restrictions (§1, §11)
- Group chat is strictly a User ↔ User feature.
- Organizations **cannot** create group chats, join group chats, or be added to group chats by users.
- When acting as an Organization (`req.actor.type === 'ORGANIZATION'`), all group chats (`is_group = TRUE`) are filtered out of the API response.

### Rule 5: Messaging Permissions & Recruitment Override (§6, §7, §14)
- **Current Behavior**: Default to allowing all users to message any Organization account (since setting UI/DB is not implemented yet).
- **Future-Proof Structure**: The permission evaluation helper is structured to seamlessly support `EVERYONE`, `FOLLOWERS`, `NO_ONE` settings:
  1. **Block check**: Is User blocked by Company? -> Deny.
  2. **Existing Thread check**: Thread exists? -> Allow (bypasses general privacy settings & follow status changes).
  3. **Recruitment Check**: User has applied and is in `SHORTLISTED` or `OFFER_ACCEPTED` status? -> Allow (overrides `NO_ONE` setting).
  4. **General Privacy Check**: Evaluates setting (`EVERYONE` -> Allow, `FOLLOWERS` -> Check `followers` table, `NO_ONE` -> Deny).

### Rule 6: Jobs Tab Categorization (`is_job_chat` / `isJobChat`) (§8, §9)
- A new column `is_job_chat BOOLEAN DEFAULT FALSE` is added to `conversations`.
- `GET /conversations?tab=JOBS` returns conversations with `is_job_chat = TRUE`.
- `GET /conversations?tab=GENERAL` returns conversations with `is_job_chat = FALSE`.
- **Context Menu Actions**: `Move to Jobs` / `Remove from Jobs` context menu items invoke `PATCH /conversations/:id/category` with `{ isJobChat: boolean }` to switch tabs without deleting messages.

### Rule 7: Generalized Organization Entity Share Restrictions (§10)
- **Generalized Check**: Share guards check for organization entity types (`targetType IN ('company', 'organization', 'ORGANIZATION')` or presence of `targetOrgId`).
- **User → Organization Share Restriction**: Users **cannot** share posts or content to Organization accounts. Submitting a share targeting an Organization returns `403 Forbidden`.
- **Share Picker Filtering**: When a User opens their share-recipient picker (`GET /share/recipients`), Organization accounts are filtered out entirely.
- **Organization → User Sharing**: Organizations **can** share posts/content to eligible Users.

### Rule 8: Company Identity Rendering (§12)
- **User View**: Display Organization name (`org.name`) and logo (`org.logo_url`). Individual admin identity is never shown.
- **Company View**: Display User profile name (`u.full_name`) and avatar (`u.avatar_url`).

### Rule 9: Company Blocking (§13)
- When an Organization blocks a User:
  - Immediate check in `blocks` table before sending/fetching messages or applying to jobs.
  - Returns `403 Forbidden` ("Interaction blocked by organization").

---

## 3. Realtime Socket Events Specification

| Event Name | Emitter & Scope | Payload & Behavior |
| :--- | :--- | :--- |
| `newMessage` | Server → Client (`user_<user_id>` / `org_<org_id>`) | Broadcasts new message payload. For company recipients, delivered to all active admins in room `org_<org_id>` with organization identity. |
| `conversationUpdated` | Server → Client | Updates last message snippet and timestamp for real-time inbox list ordering. |
| `conversationCategoryUpdated` | Server → Client | Emitted on context menu toggle ("Move to Jobs" / "Remove from Jobs"). Payload: `{ conversationId, isJobChat: boolean }`. |
| `isTyping` / `stoppedTyping` | Bidirectional | Live typing indicators for User and Org Admins in active conversation. |
| `messagesRead` | Server → Client | Synchronizes read receipts across all participants/admins. |
| `conversationBlocked` | Server → Client | Emitted when company blocks user. Instantly disables open chat composer. |

---

## 4. File-by-File Implementation Changes

### A. Database Schema
- **`schema.sql`**:
  ```sql
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_job_chat BOOLEAN DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS idx_conversations_is_job_chat ON conversations(is_job_chat);
  ```

### B. Controller & Routes (`social.controller.js` & `social.routes.js`)
- **`getConversations`**:
  - Differentiate actor context (`req.actor.type === 'ORGANIZATION'` vs `'USER'`).
  - Add `?tab=JOBS` vs `?tab=GENERAL` filtering using `is_job_chat`.
  - Include `is_job_chat AS "isJobChat"` in payload.
  - Exclude group chats (`is_group = FALSE`) when acting as an Organization.
- **`sendMessage`**:
  - Enforce single thread per `(user_id, org_id)` pair.
  - Force `is_requesting = FALSE` for Organization DMs.
- **`toggleJobChatCategory`** (`PATCH /conversations/:id/category`):
  - Updates `is_job_chat` column for context menu tab movements.

### C. Universal Share Service (`share.service.js`)
- **`shareViaMessage`**:
  - Add guard: If `!senderOrgId` and `targetType IN ('company', 'organization', 'ORGANIZATION')`, throw 403 error ("Users cannot share posts to organization accounts").
- **`getShareRecipients`**:
  - If caller is a User (`!senderOrgId`), exclude all Organization entities from recipient picker lists.

### D. Socket Service & Realtime Handler (`socket.service.js` & `chat.handler.js`)
- Deliver messages to `org_<org_id>` room so all active admins receive messages in real time.
- Format identity metadata (Organization name & logo for User view).

---

## 5. Verification & Test Plan

1. **Actor Switch Test**: Verify `GET /conversations` as User vs Organization returns distinct, isolated list of conversations.
2. **Share Restriction Test**: Verify User cannot see Organization in share picker and `POST /share` targeting Organization returns 403.
3. **Jobs Tab Toggle Test**: Test `PATCH /conversations/:id/category` and verify tab movement (`GET /conversations?tab=JOBS`).
4. **Realtime Socket Verification**: Verify real-time message broadcast to all active org admins in `org_<org_id>` room.
