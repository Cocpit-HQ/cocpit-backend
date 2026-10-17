# Mobile Integration Guide: Follow APIs (User ↔ User, User ↔ Company, Company ↔ Company)

## Background

Follow relationships exist in three shapes on this platform:

1. **User follows User** — plain, always allowed.
2. **User follows Company / Company follows User** — a personal user follows an org, or an org follows a user back.
3. **Company follows Company** — one org follows another org, acting through a team member.

For (2) and (3), the request must be made **as the company** — i.e. the mobile app must be in "acting as company" mode and send the actor-context headers described below. Only **Admins/Owners** of the acting company are allowed to perform the follow/unfollow action on its behalf; everyone else must see the button disabled. This doc covers the actor-context contract, every follow-related endpoint, the exact enable/disable rule for the button, and how to read follow state correctly for each target type.

This mirrors the current web implementation (`cocpit-frontend/src/context/SocialContext.tsx`, `cocpit-frontend/src/features/companyprofile/components/view/CompanyProfileHeader.tsx`) — use those as reference if anything here is ambiguous.

---

## 1. Actor context: how the backend knows "who is acting"

Every authenticated request already carries the user's JWT. On top of that, two headers tell the backend **which profile the user is currently acting as**:

| Header | Value | When to send |
|---|---|---|
| `x-actor-type` | `ORGANIZATION` | Only when the user has switched to a company profile |
| `x-actor-id` | the company's `org_id` | Only when `x-actor-type` is `ORGANIZATION` |

- **Omit both headers entirely** when acting as the personal user — the backend defaults to the human user in that case.
- These headers must be attached to **every** API call while a company profile is active (not just follow calls) — the backend resolves `req.actor` from them on every authenticated request (`requireAuth` → `resolveActorContextForRequest`, `cocpit-backend/src/core/middlewares/actor-context.middleware.js`).
- If `x-actor-type: ORGANIZATION` is sent but the user isn't an active member of that org (stale membership, removed, etc.), the backend **silently falls back to the user actor** rather than erroring the whole request — don't rely on a 403 to detect that; re-sync membership state instead.

### Getting the current actor + role/permissions

```
GET /api/auth/actor-context
```
Returns:
```json
{
  "actor": { "type": "USER" | "ORGANIZATION", "id": "...", "viewer_role_data": { ... } | null },
  "organizations": [
    {
      "org_id": "...",
      "name": "...",
      "logo_url": "...",
      "entity_type": "COMPANY" | "INSTITUTION",
      "viewer_role_data": { "name": "Admin" | "Member" | ..., "permissions": ["*"] | ["MANAGE_COMPANY", ...], "priority": 100 }
    }
  ],
  "source": "..."
}
```
`viewer_role_data` for each organization is exactly what you need for the button-enable rule below. Switching profile is:
```
POST /api/auth/actor-context
{ "type": "ORGANIZATION", "id": "<org_id>" }   // or { "type": "USER" }
```
After switching, start attaching the `x-actor-type`/`x-actor-id` headers (or stop, for `USER`) on all subsequent requests.

---

## 2. Follow-button enable/disable rule (when acting as a company)

**Rule:** when the active profile is a company, the Follow/Unfollow button (for following another user *or* another company) is only **enabled** if the acting member is an **Owner or Admin** of that company. Everyone else sees it **disabled** (grayed out, non-tappable) — never hidden, so the user understands the feature exists but isn't available to their role.

```
const perms = viewer_role_data?.permissions || [];
const isOwner = perms.includes('*');
const isAdmin = (viewer_role_data?.name || '').toUpperCase() === 'ADMIN';

canFollow = (activeProfile.type !== 'COMPANY') || isOwner || isAdmin;
```

- If `activeProfile.type === 'USER'` (personal profile), `canFollow` is always `true` — no restriction.
- If `activeProfile.type === 'COMPANY'`, `canFollow` is `true` only for Owner/Admin.

This must be enforced **client-side before the tap even happens** — the backend enforces the same rule server-side (see below) and will reject with 403, but a disabled button avoids the round-trip and the confusing error toast.

### Server-side enforcement (defense in depth)

The org→user and org→company follow endpoints are gated by `requireOrgPermission("MANAGE_COMPANY")`. If a non-admin/owner company member calls them anyway, the response is:
```
HTTP 403
{ "message": "You do not have permission: MANAGE_COMPANY" }
```
Handle this the same way you'd handle any 403 — but it should be effectively unreachable if the client-side gate above is implemented, since it's really just a safety net.

---

## 3. Endpoints

All paths below are relative to the API base URL. All require `Authorization: Bearer <token>`; add the actor headers from §1 when acting as a company.

### 3.1 User → User (always allowed, no permission gate)

| Action | Method & Path |
|---|---|
| Follow a user | `POST /api/users/:id/follow` |
| Unfollow a user | `DELETE /api/users/:id/unfollow` |
| Get a user's followers | `GET /api/users/:id/followers` |
| Get who a user is following | `GET /api/users/:id/following` |

### 3.2 User → Company (personal user follows a company; always allowed)

| Action | Method & Path |
|---|---|
| Follow a company | `POST /api/organizations/:orgId/follow` |
| Unfollow a company | `DELETE /api/organizations/:orgId/unfollow` |

### 3.3 Company → User (**Owner/Admin only** — gated by §2)

| Action | Method & Path |
|---|---|
| Company follows a user | `POST /api/organizations/:orgId/following/users/:userId` |
| Company unfollows a user | `DELETE /api/organizations/:orgId/following/users/:userId` |

`:orgId` is the **acting** company's own id (from `activeProfile.id`), `:userId` is the target user.

### 3.4 Company → Company (**Owner/Admin only** — gated by §2)

| Action | Method & Path |
|---|---|
| Company follows another company | `POST /api/organizations/:orgId/following/organizations/:targetOrgId` |
| Company unfollows another company | `DELETE /api/organizations/:orgId/following/organizations/:targetOrgId` |

`:orgId` is the acting company's own id, `:targetOrgId` is the company being followed.

### 3.5 Relationship / follow-state lookups

| Purpose | Method & Path | Notes |
|---|---|---|
| Is *(current actor)* following this **company**? | `GET /api/organizations/:orgId/relationship` | **Actor-aware.** Returns `{ "isFollowing": boolean, "followerCount": number }`. When acting as a company, `isFollowing` reflects whether *that company* follows `:orgId` (not the human user). |
| Is *(current actor)* following this **user**? | `GET /api/users/:id` | The full profile payload includes `is_following` (and `is_followed_by`, `connection_request_status`, etc). **Actor-aware** — when acting as a company, `is_following` reflects whether *that company* follows this user. |

**Important caveat:** the company profile endpoint (`GET /api/organizations/:slug/profile`) also embeds a `relationship.is_following` field, but that embedded field is **not** actor-aware — it always reflects the logged-in human's own personal follow status, regardless of which company you're acting as. **Do not use it to decide the follow button's state while acting as a company.** Always call the dedicated `GET /api/organizations/:orgId/relationship` endpoint above instead when `activeProfile.type === 'COMPANY'`. (Web works around this the same way — see `CompanyProfilePage.tsx`'s `orgRelationship` query.)

### 3.6 Followers / Following lists (company profile)

| Purpose | Method & Path |
|---|---|
| Who follows this company (users **and** companies) | `GET /api/organizations/:orgId/followers` |
| Who this company follows (users **and** companies) | `GET /api/organizations/:orgId/following` |

Both lists mix user and company entries in one array — you must branch on a `type` field per item. **The raw field names differ slightly between the two endpoints**, so normalize on the client rather than assuming one shape:

**`/followers` response** — array of:
```json
{ "user_id": "...", "full_name": "...", "headline": "...", "avatar_url": "...", "followed_at": "...", "is_followed_back": false, "type": "user" | "company" }
```
(for `type: "company"` items, `full_name` is the company name, `headline` is its industry, `avatar_url` is its logo)

**`/following` response** — array of:
```json
{ "user_id": "...", "name": "...", "avatar": "...", "headline": "...", "created_at": "...", "type": "user" | "company" }
```

Recommended normalization (matches `cocpit-frontend/src/features/companyprofile/services/companyprofile.service.ts`):
```js
{
  id: item.user_id || item.org_id || item.id,
  name: item.name || item.full_name,
  avatarUrl: item.avatar || item.avatar_url || item.logo_url,
  type: item.type, // 'user' | 'company'
  isFollowedBack: item.is_followed_back || false,
}
```

---

## 4. Example: Company follows another Company

```
POST /api/organizations/b6b0430b-760b-4c47-9eec-ba6ad71a036f/following/organizations/49139f72-4e1f-47b1-875c-2b857d99a748
Authorization: Bearer <token>
x-actor-type: ORGANIZATION
x-actor-id: b6b0430b-760b-4c47-9eec-ba6ad71a036f
```
Response:
```json
{ "success": true, "message": "Organization followed organization" }
```
Afterward, confirm state with:
```
GET /api/organizations/49139f72-4e1f-47b1-875c-2b857d99a748/relationship
x-actor-type: ORGANIZATION
x-actor-id: b6b0430b-760b-4c47-9eec-ba6ad71a036f
```
```json
{ "isFollowing": true, "followerCount": 12 }
```

## 5. Example: Non-admin company member attempts to follow

```
POST /api/organizations/{orgId}/following/users/{userId}
x-actor-type: ORGANIZATION
x-actor-id: {orgId}          // member has role "Member", not Admin/Owner
```
```
HTTP 403
{ "message": "You do not have permission: MANAGE_COMPANY" }
```
This should be unreachable in the app — the button should already be disabled per §2 for this member.

---

## Summary checklist for mobile

- [ ] Attach `x-actor-type` / `x-actor-id` headers on every request while a company profile is active; omit both for the personal profile.
- [ ] Read `viewer_role_data` from `GET /api/auth/actor-context` for the active company and compute `canFollow` per §2 — disable (don't hide) the Follow button when `false`.
- [ ] Use `GET /api/organizations/:orgId/relationship` for company-target follow state, and `GET /api/users/:id`'s `is_following` for user-target follow state — never the embedded `relationship.is_following` on the company profile payload while acting as a company.
- [ ] Use `.../following/users/:userId` and `.../following/organizations/:targetOrgId` for company-initiated follows; use `/follow`, `/unfollow` on `/users/:id` or `/organizations/:orgId` for personal-user-initiated follows.
- [ ] Normalize `/followers` and `/following` list items per §3.6 — field names differ between the two endpoints.

## Where this lives in the backend (for reference)

- Routes: `cocpit-backend/src/modules/social/social.routes.js`
- Controllers: `cocpit-backend/src/modules/social/social.controller.js` (`getCompanyRelationship`, `getCompanyFollowers`, `getOrganizationFollowing`, `organizationFollowUser`, `organizationFollowOrganization`, etc.), `cocpit-backend/src/modules/user/user.controller.js` (`getUserProfile`)
- Actor resolution: `cocpit-backend/src/core/middlewares/actor-context.middleware.js`, `cocpit-backend/src/core/middlewares/organization.auth.middleware.js`
- Web reference implementation: `cocpit-frontend/src/context/SocialContext.tsx`, `cocpit-frontend/src/features/companyprofile/components/view/CompanyProfileHeader.tsx`, `cocpit-frontend/src/lib/actor-context.ts`
