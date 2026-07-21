# ACTIVITY LOGS — COMPREHENSIVE IMPLEMENTATION PLAN

## 1. Core Architectural Guidelines

1. **Backend Audit Logging**:
   - **Successful Operations**: Logged in API controllers after successful DB operations when acting under an organization context (`companyId` / `orgId`).
   - **Unauthorized Access / RBAC Violations**: Logged in authentication/RBAC middlewares (e.g., `requireOrgActorPermission` in `actor-context.middleware.js` and `org-rbac.middleware.js`) when a user attempts an unauthorized action or hits a forbidden route (`403 Forbidden`).
2. **Infinite Scroll with Cursor-Based Fetching**:
   - Backend `GET /organizations/:orgId/teams/activity` uses cursor parameters (`cursorCreatedAt`, `cursorLogId`).
   - Frontend UI uses infinite scroll (Intersection Observer / React Query `useInfiniteQuery`) to seamlessly append logs as the user scrolls down.
3. **Clickable Target Links**:
   - Highlighted target words in UI (`post`, `job`, `role`, `message`) render as clickable blue links redirecting to `/post/:id`, `/jobs/:id`, `/team/role/:id`, etc.
4. **Denormalized Metadata**:
   - Target names (`targetName`, `roleName`, `jobTitle`) are stored inside `metadata` JSONB for display safety even if targets are deleted.

---

## 2. Proposed Metadata Schema

```json
{
  "targetType": "post | job | member | role | channel | query | permission",
  "targetId": "UUID of targeted resource",
  "targetName": "Title or name of targeted resource",
  "linkUrl": "/post/123 or /jobs/456 or /team/role/789",
  "highlightedText": "post | job | message | role",
  "unauthorizedAttempt": true
}
```

---

## 3. Comprehensive Action Catalog Across All Categories

### Category 1: Page / Profile (`entity_type = 'ORGANIZATION'`)
- `CREATE_PAGE`: Organization page created during onboarding (`[Actor] created the company page`).
- `UPDATE_PROFILE`: Organization profile/settings updated (`[Actor] updated organization profile`).
- `UPLOAD_VERIFICATION_DOC`: Verification document uploaded (`[Actor] uploaded verification document`).
- `VERIFICATION_STATUS_CHANGED`: Verification status changed (`[Actor] verification status changed`).

### Category 2: Team Management
- `INVITE_MEMBER`: Team member invited (`[Actor] invited [Member] as [Role]`).
- `WITHDRAW_INVITE`: Member invitation withdrawn (`[Actor] withdrew invitation for [Member]`).
- `ACCEPT_INVITE`: Member accepted invitation and joined (`[Actor] joined organization as [Role]`).
- `REMOVE_MEMBER`: Member removed from organization (`[Actor] removed [Member] from organization`).
- `ASSIGN_ROLE`: Member role updated (`[Actor] updated role for [Member]`).
- `CREATE_ROLE`: New custom role created (`[Actor] created role [Role Name]`).
- `DELETE_ROLE`: Custom role deleted (`[Actor] deleted role [Role Name]`).

### Category 3: Jobs
- `CREATE_JOB`: Job posted (`[Actor] created job [Job Title]`).
- `CLOSE_JOB`: Job closed/deactivated (`[Actor] closed job [Job Title]`).
- `DELETE_JOB`: Job deleted (`[Actor] deleted job [Job Title]`).
- `SEND_OFFER`: Job offer sent (`[Actor] sent offer to [Candidate Name] for [Job Title]`).
- `SHORTLIST_APPLICATION`: Candidate shortlisted (`[Actor] shortlisted [Candidate Name] for [Job Title]`).
- `DECLINE_APPLICATION`: Candidate application declined (`[Actor] declined application from [Candidate Name]`).

### Category 4: Posts
- `CREATE_POST`: Post created (`[Actor] created post`).
- `EDIT_POST`: Post content edited (`[Actor] edited post`).
- `CHANGE_VISIBILITY`: Post visibility modified (`[Actor] changed post visibility`).
- `DELETE_POST`: Post deleted (`[Actor] deleted post`).
- `LIKE`: Post liked (`[Actor] liked post by [Author] post`).
- `COMMENT`: Comment added to post (`[Actor] commented on [Author] post`).
- `REPOST`: Post reposted (`[Actor] reposted post by [Author] post`).
- `SHARE_POST`: Post shared externally (`[Actor] shared post`).
- `REPORT_POST`: Post reported (`[Actor] reported post`).
- `SAVE_POST`: Post saved (`[Actor] saved post`).

### Category 5: Community
- `CREATE_CHANNEL`: Channel created (`[Actor] created channel [Channel Name]`).
- `CREATE_ARTICLE`: Community article created (`[Actor] created article [Title]`).
- `EDIT_ARTICLE`: Community article edited (`[Actor] edited article [Title]`).
- `DELETE_ARTICLE`: Article deleted (`[Actor] deleted article [Title]`).
- `POST_THOUGHT`: Thought posted (`[Actor] posted thought`).
- `DELETE_THOUGHT`: Thought deleted (`[Actor] deleted thought`).
- `REPLY_THOUGHT`: Thought reply added (`[Actor] replied to [Author] message`).

### Category 6: Chat & Support
- `RESOLVE_QUERY`: Support query resolved (`[Actor] resolved query [Query Title]`).
- `REASSIGN_QUERY`: Support query reassigned (`[Actor] reassigned query to [Member]`).
- `CLOSE_QUERY`: Support query closed (`[Actor] closed query [Query Title]`).
- `START_CHAT_SESSION`: Chat session initiated (`[Actor] started chat session with [Target]`).

### Category 7: People / Connections
- `ACCEPT_CONNECTION`: Connection request accepted (`[Actor] accepted connection request from [User]`).
- `EXTERNAL_CONNECTION`: External connection added (`[Actor] added external connection [User]`).

### Category 8: Security & Unauthorized Access
- `UNAUTHORIZED_ACCESS_ATTEMPT`: Unauthorized route or permission failure (`[Actor] attempted unauthorized access: [Permission / Action]`).

---

## 4. Middleware Unauthorized Access Logging

In `actor-context.middleware.js` and `org-rbac.middleware.js`:
When `hasActorPermission` returns `false` or forbidden check fails:

```javascript
// Log unauthorized attempt before throwing 403 error
if (req.actor && req.actor.orgId) {
    await logAudit(pool, {
        entityId: req.actor.orgId,
        actorId: req.actor.userId,
        actorRole: req.actor.roleName || null,
        action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        metadata: {
            attemptedPermission: permission,
            attemptedRoute: req.originalUrl,
            unauthorizedAttempt: true
        }
    });
}
```

---

## 5. UI Infinite Scroll Implementation

In `TeamActivityLogPage.tsx` (`src/features/manage-team/pages/TeamActivityLogPage.tsx`):
- Replace standard pagination controls with `useInfiniteQuery` or scroll position listener.
- When user reaches bottom of activity list container, trigger `fetchNextPage()` using `cursorCreatedAt` and `cursorLogId` from previous page result.

---

## 6. Execution Order

1. **Step 1 — RBAC Middleware Audit Triggers**: Add `UNAUTHORIZED_ACCESS_ATTEMPT` logging in `actor-context.middleware.js`.
2. **Step 2 — Backend Cursor-Based Endpoint**: Update `/organizations/:orgId/teams/activity` query for cursor pagination.
3. **Step 3 — Controller Audit Triggers**: Verify `logAudit` calls across all 8 feature categories.
4. **Step 4 — UI Infinite Scroll & Target Links**: Update `TeamActivityLogPage.tsx` for infinite scroll and `ActivityLogRow.tsx` for clickable resource links.
