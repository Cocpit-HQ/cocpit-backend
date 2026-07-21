# Organization Teams & RBAC System Context and Decisions

## Overview
This document contains the final backend architecture decisions and implementation plan for the Organisation Teams and Role-Based Access Control (RBAC) system in Cocpit.

---

## 1. Core Architecture Decisions

### Actor Context & RBAC Middleware
1. **Actor Verification Rule**: The RBAC middleware checks `req.actor.type`.
   - **If the type is NOT 'ORGANIZATION'**: Do **NOT** perform any organization permission checks. Let the request pass through (`next()`). This avoids blocking public profile routes, feeds, and normal user-level access.
   - **If the type IS 'ORGANIZATION'**: Perform active permission checks against `req.actor.permissions`.
2. **Owner Bypass**: The organization Owner (creator of the company) has `*` permissions or role name `'Owner'`. The Owner bypasses all checks.
3. **No 403 on User Actor**: Since the UI controls whether a user switches to the organization profile, the backend middleware should not throw 403 if the user is in `USER` actor type; it only checks permissions when explicitly acting as an `ORGANIZATION` actor.

### Team Roles & Hierarchy
1. **Dynamic Roles**: All roles except `Owner` are completely dynamic and created by organization Admins. The default seeded roles (Admin, Editor, Recruiter, Analyst) are removed from the default org creation seed.
2. **Owner Protection**: The Owner cannot be removed, demoted, or have their role changed by any Admin.
3. **Admin Hierarchy**: Admins can remove other admins or members (except the Owner). Priority-based controls for admin-to-admin modifications are bypassed, except for protecting the Owner.

### Member Invite Flow
1. **Followers Only**: Invites can only be sent to users who are currently following the organization (queried from `organization_followers`).
2. **Invite Candidates**: When querying invite candidates, exclude existing members and users who already have pending invites.
3. **Status Flow**:
   - Invitation sent → Member added with status `PENDING_INVITE`.
   - User accepts → Status becomes `ACTIVE`.
   - Admin withdraws → Status becomes `CANCELLED` (user becomes eligible for invite again).

---

## 2. Permission Key System (UI Checklist vs System Keys)

### UI Checklist Keys (Custom Roles)
*   `CREATE_POST` (Create post)
*   `CHANNEL` (Channel)
*   `CHAT` (Chat)
    *   ↳ `QUERIES` (Queries - independent of Chat toggle at runtime)
*   `TEAMS` (Teams)
    *   ↳ `ACTIVITY_LOGS` (Activity logs - **requires** Teams toggle to be enabled at save-time)
*   `JOBS` (Jobs)
    *   ↳ `JOBS_CHAT` (Jobs chat - independent of Jobs toggle at runtime)
*   `ANALYTICS` (Analytics)

### Runtime Dependency Exceptions
*   If a request requires `QUERIES` permission, it is allowed if the user has either `QUERIES` **or** `CHAT` (since full Chat access implies Queries).
*   If a request requires `JOBS_CHAT` permission, it is allowed if the user has either `JOBS_CHAT` **or** `JOBS` (since full Jobs access implies Jobs Chat).
*   If a request requires `ACTIVITY_LOGS`, it explicitly checks `ACTIVITY_LOGS` (it does not fall back to `TEAMS`).

---

## 3. Middleware Implementation Code

```javascript
const AppError = require("../errors/AppError");

function checkFeaturePermission(permissions, requiredKey) {
    if (!permissions || !Array.isArray(permissions)) return false;

    // Owner wildcard
    if (permissions.includes('*')) return true;

    // Admin system key: MANAGE_COMPANY grants everything
    if (permissions.includes('MANAGE_COMPANY')) return true;

    // Exact match
    if (permissions.includes(requiredKey)) return true;

    // Sub-permission fallbacks
    if (requiredKey === 'QUERIES' && permissions.includes('CHAT')) return true;
    if (requiredKey === 'JOBS_CHAT' && permissions.includes('JOBS')) return true;

    return false;
}

const requireOrgAccess = (featureKey, isPublicRoute = false) => async (req, res, next) => {
    // 1. If not acting as ORGANIZATION actor type, skip check completely
    if (!req.actor || req.actor.type !== 'ORGANIZATION') {
        return next();
    }

    // 2. Ensure actor matches target organization in route
    const urlOrgId = req.params.orgId || req.params.companyId;
    if (urlOrgId && req.actor.orgId !== urlOrgId) {
        return next(new AppError("Active organization actor does not match the target organization", 403));
    }

    // 3. Log organization activity (since actor is ORGANIZATION type)
    // We log the action (using the featureKey as the action name or similar)
    // Fire-and-forget logging
    const { logAudit } = require("../../core/infrastructure/audit.service");
    logAudit(pool, {
        entityId: req.actor.orgId,
        actorId: req.actor.userId,
        actorRole: req.actor.roleName,
        action: isPublicRoute ? `VIEW_${featureKey}` : featureKey,
        metadata: {
            path: req.originalUrl,
            method: req.method,
            ip: req.ip,
            userAgent: req.headers['user-agent']
        }
    }).catch(err => console.error("Failed to log organization activity:", err));

    // 4. If this is a public GET / open route, skip permission enforcement
    if (isPublicRoute) {
        return next();
    }

    const permissions = req.actor.permissions || [];

    // 5. Owner Bypass
    const isOwner = permissions.includes('*') || req.actor.roleName === 'Owner';
    if (isOwner) {
        return next();
    }

    // 6. Feature Check
    if (checkFeaturePermission(permissions, featureKey)) {
        return next();
    }

    return next(new AppError(`You don't have access to ${featureKey}. Ask your admin to update your role permissions.`, 403));
};
```
