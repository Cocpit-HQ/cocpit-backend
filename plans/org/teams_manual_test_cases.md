# Comprehensive QA Test Suite: Organisation Teams & RBAC System
**Document Scope:** Backend API & RBAC Authorization Logic  
**Testing Level:** Integration, Security, Boundary, Negative, & Matrix Validation  
**Target Audience:** QA Engineering Team (3+ Years Experience)

---

## 1. Module 1: Role Management (100+ Matrix Test Scenarios)

This matrix validates role creation, updates, deletes, permissions, colors, description boundaries, and hierarchy enforcement.

### 1.1 Permission Combination Matrix (90 Scenarios)
Validate role creation (`POST /teams/roles`) with every possible permutation of the 9 UI checklist permissions.

| Test IDs | Permission Checklist Combination | Enforced Backend Validation / Rule | Expected Status |
|---|---|---|---|
| **TC-PERM-01** | `[]` (Empty permissions array) | Allowed. Custom role has no access features. | 201 Created |
| **TC-PERM-02** | `["CREATE_POST"]` | Allowed. | 201 Created |
| **TC-PERM-03** | `["CHANNEL"]` | Allowed. | 201 Created |
| **TC-PERM-04** | `["CHAT"]` | Allowed. (Bypasses QUERIES at runtime). | 201 Created |
| **TC-PERM-05** | `["QUERIES"]` | Allowed. Independent child permission. | 201 Created |
| **TC-PERM-06** | `["TEAMS"]` | Allowed. | 201 Created |
| **TC-PERM-07** | `["ACTIVITY_LOGS"]` | **Blocked**. Save-time validation (requires TEAMS). | 400 Bad Request |
| **TC-PERM-08** | `["TEAMS", "ACTIVITY_LOGS"]` | Allowed. Both present. | 201 Created |
| **TC-PERM-09** | `["JOBS"]` | Allowed. (Bypasses JOBS_CHAT at runtime). | 201 Created |
| **TC-PERM-10** | `["JOBS_CHAT"]` | Allowed. Independent child permission. | 201 Created |
| **TC-PERM-11** | `["ANALYTICS"]` | Allowed. | 201 Created |
| **TC-PERM-12..90** | All other permutations (78 combinations) | If `ACTIVITY_LOGS` is present: requires `TEAMS` to be present. Otherwise, all combinations are allowed. | 201 / 400 |

### 1.2 System Permission Protection & Boundary Scenarios (15 Scenarios)

| Test ID | Method | Endpoint | Input Payload / Action | Expected Result / Message |
|---|---|---|---|---|
| **TC-RBD-01** | `POST` | `/teams/roles` | `{"name": "Owner"}` | `400 Bad Request` - `"Cannot create a role named Owner"` |
| **TC-RBD-02** | `POST` | `/teams/roles` | `{"name": "owner"}` | `400 Bad Request` - case-insensitive duplicate check |
| **TC-RBD-03** | `POST` | `/teams/roles` | `{"name": "  Owner  "}` | `400 Bad Request` - trimmed name check |
| **TC-RBD-04** | `POST` | `/teams/roles` | `{"name": "Admin"}` (system Admin role already exists) | `400 Bad Request` - duplicate role check |
| **TC-RBD-05** | `POST` | `/teams/roles` | Permissions contain `'MANAGE_COMPANY'` (system key) | `400 Bad Request` - `"System permission keys are not allowed for dynamic roles"` |
| **TC-RBD-06** | `POST` | `/teams/roles` | Permissions contain `'SWITCH_TO_COMPANY'` (system key) | `400 Bad Request` - System permission key block |
| **TC-RBD-07** | `PUT` | `/teams/roles/:id` | Attempt to rename dynamic role to `"Owner"` | `400 Bad Request` - Reserved word protection |
| **TC-RBD-08** | `PUT` | `/teams/roles/:id` | Rename system role (e.g. Admin or Owner) | `400 Bad Request` - `"Cannot change the name of a system role"` |
| **TC-RBD-09** | `DELETE`| `/teams/roles/:id` | Delete system role (Owner) | `400 Bad Request` - `"Cannot delete system roles"` |
| **TC-RBD-10** | `DELETE`| `/teams/roles/:id` | Delete role currently assigned to members | `400 Bad Request` - `"Cannot delete this role. Members are currently assigned..."` |
| **TC-RBD-11** | `POST` | `/teams/roles` | Empty role name | `400 Bad Request` - `"Role name is required"` |
| **TC-RBD-12** | `POST` | `/teams/roles` | Role name exceeding 50 characters | `400 Bad Request` - Length validation error |
| **TC-RBD-13** | `POST` | `/teams/roles` | Color hex value is missing | `201 Created` - Defaults to `#808080` |
| **TC-RBD-14** | `POST` | `/teams/roles` | Description length > 1000 characters | `400 Bad Request` - Length validation error |
| **TC-RBD-15** | `PUT` | `/teams/roles/:id`| Attempt to modify role priority | `400 Bad Request` - Priority cannot be updated directly |

---

## 2. Module 2: Member & Role Assignment (60+ Scenarios)

Validates pagination, filtering, display settings, and hierarchical role updates.

### 2.1 Members Listing & Detail (10 Scenarios)
*   **Endpoints:** `GET /teams/members`, `GET /teams/members/:userId`

| Test ID | Query Params / Path | Scenario | Expected Result |
|---|---|---|---|
| **TC-MEM-01** | None | Get all members | 200 OK - Return list ordered by role priority |
| **TC-MEM-02** | `?page=1&limit=5` | Pagination boundary | 200 OK - Return exactly 5 members |
| **TC-MEM-03** | `?search=John` | Search filter (by name) | 200 OK - Return list matching "John" |
| **TC-MEM-04** | `?search=john` | Case-insensitive search | 200 OK - Case-insensitive match |
| **TC-MEM-05** | `?search=Software` | Search filter (by headline) | 200 OK - Return list matching "Software" |
| **TC-MEM-06** | `?search=XYZXYZ` | Search with no results | 200 OK - Return empty list, total count = 0 |
| **TC-MEM-07** | `/members/user-123` | Retrieve active member detail | 200 OK - Returns role details, permissions, join date |
| **TC-MEM-08** | `/members/non-existent-id`| Retrieve non-existent member | 404 Not Found - `"Member not found"` |
| **TC-MEM-09** | `?page=-1&limit=abc` | Invalid query param values | 400 Bad Request |
| **TC-MEM-10** | `/members/user-123` | Verify email field is masked for non-admin actors | 200 OK - Email field returned only if actor has VIEW_MEMBERS |

### 2.2 Role Assignment & Hierarchy Matrix (50 Scenarios)
*   **Endpoint:** `PUT /teams/members/:userId/role`
*   **Actors tested:** Owner (priority 100), Admin (priority 90), Custom Manager (priority 50).
*   **Target Roles tested:** Owner (100), Admin (90), Custom Manager (50), Employee (10).

| Test ID | Actor Role | Target Member Role | Assigned New Role | Expected Result |
|---|---|---|---|---|
| **TC-HR-01** | Admin (90) | Employee (10) | Admin (90) | **Blocked** (403) - Cannot assign peer role (priority >= own) |
| **TC-HR-02** | Admin (90) | Employee (10) | Owner (100) | **Blocked** (400) - Cannot assign Owner role |
| **TC-HR-03** | Admin (90) | Employee (10) | Custom Manager (50) | **Allowed** (200) |
| **TC-HR-04** | Owner (100) | Employee (10) | Admin (90) | **Allowed** (200) - Owner bypasses priority cap |
| **TC-HR-05** | Owner (100) | Admin (90) | Owner (100) | **Blocked** (400) - Cannot duplicate Owner role |
| **TC-HR-06** | Custom Manager (50)| Employee (10) | Admin (90) | **Blocked** (403) - Assigned priority is higher than actor |
| **TC-HR-07** | Admin (90) | Owner (100) | Custom Manager (50) | **Blocked** (403) - Cannot demote Owner |
| **TC-HR-08** | Admin (90) | Admin (90) | Employee (10) | **Blocked** (403) - Cannot demote peer Admin |
| **TC-HR-09** | Owner (100) | Admin (90) | Employee (10) | **Allowed** (200) - Owner can demote anyone |
| **TC-HR-10..50**| Various | Various | Various | Validate priority constraint: `Target Role Priority < Actor Role Priority` (except Owner) |

---

## 3. Module 3: Member Removal & Ownership (30+ Scenarios)

### 3.1 Member Removal Flow (15 Scenarios)
*   **Endpoint:** `DELETE /teams/members/:userId`

| Test ID | Actor Role | Target Member Role | Expected Result |
|---|---|---|---|
| **TC-RM-01** | Admin (90) | Employee (10) | **Allowed** (200) - Member removed successfully |
| **TC-RM-02** | Admin (90) | Owner (100) | **Blocked** (403) - `"The organization Owner cannot be removed"` |
| **TC-RM-03** | Admin (90) | Admin (90) (Peer) | **Allowed** (200) - Admin can remove other admins |
| **TC-RM-04** | Employee (10) | Employee (10) | **Blocked** (403) - Lack of REMOVE_MEMBERS permission |
| **TC-RM-05** | Owner (100) | Admin (90) | **Allowed** (200) |
| **TC-RM-06** | Owner (100) | Owner (100) (Self) | **Blocked** (400) - Owner cannot remove self |
| **TC-RM-07** | Admin (90) | Admin (90) (Self) | **Blocked** (400) - `"You cannot remove yourself. Use Leave instead."` |

### 3.2 Ownership Transfer Flow (15 Scenarios)
*   **Endpoint:** `POST /teams/transfer-ownership`

| Test ID | Actor Role | Target User ID | Target Member Status | Expected Result |
|---|---|---|---|---|
| **TC-OW-01** | Owner (100) | Active Member (User B) | ACTIVE | **Allowed** (200) - User B becomes Owner, User A becomes Admin |
| **TC-OW-02** | Admin (90) | Active Member (User B) | ACTIVE | **Blocked** (403) - `"Only the Owner can transfer organization ownership"` |
| **TC-OW-03** | Owner (100) | Pending Invite User | PENDING_INVITE | **Blocked** (400) - Target must be an active member |
| **TC-OW-04** | Owner (100) | Non-existent User | None | **Blocked** (400) - Target member must exist |
| **TC-OW-05** | Owner (100) | Owner (Self) | ACTIVE | **Blocked** (400) - `"You are already the owner"` |
| **TC-OW-06** | Owner (100) | Suspended Member | SUSPENDED | **Blocked** (400) - Target member must be active |

---

## 4. Module 4: Follower Invitation & Acceptance (80+ Scenarios)

### 4.1 Invite Candidates (Follower Filtering) (30 Scenarios)
*   **Endpoint:** `GET /teams/invite-candidates`

| Test ID | Scenario | Follower Database State | Expected Result |
|---|---|---|---|
| **TC-IC-01** | Follower is not a member | Follower row exists, no member row | **Included** in candidates list |
| **TC-IC-02** | Follower is already ACTIVE member | Follower row exists, member row ACTIVE | **Excluded** from candidates list |
| **TC-IC-03** | Follower is already SUSPENDED member| Follower row exists, member row SUSPENDED| **Excluded** from candidates list |
| **TC-IC-04** | Follower has PENDING invite | Follower row exists, invite status PENDING | **Excluded** from candidates list |
| **TC-IC-05** | Follower has ACCEPTED invite | Follower row exists, invite status ACCEPTED | **Excluded** from candidates list |
| **TC-IC-06** | Follower has EXPIRED invite | Follower row exists, invite status EXPIRED | **Included** in candidates list |
| **TC-IC-07** | Follower has CANCELLED invite | Follower row exists, invite status CANCELLED| **Included** in candidates list |
| **TC-IC-08** | Non-follower user | No follower row exists | **Excluded** from candidates list |
| **TC-IC-09** | Pagination check (limit & cursor) | 100 followers in database | Returns cursor-based pagination metadata |
| **TC-IC-10** | Search filter | Match partial follower name | Return matching followers list only |

### 4.2 Invitation Sending & Accept/Cancel Flow (50 Scenarios)
*   **Endpoints:** `POST /teams/invite`, `DELETE /teams/invites/:inviteId`, `POST /organizations/invites/accept`

| Test ID | Scenario | Input Data | Target State | Expected Status |
|---|---|---|---|---|
| **TC-IN-01** | Send invite to valid follower | Valid `userId`, `roleId` | Follower not yet invited | 200 OK - Invite created |
| **TC-IN-02** | Send invite to non-follower | Valid `userId`, `roleId` | User not following org | 400 Bad Request |
| **TC-IN-03** | Send invite to active member | Valid `userId`, `roleId` | User already ACTIVE | 400 Bad Request |
| **TC-IN-04** | Send invite to pending member | Valid `userId`, `roleId` | User already has PENDING invite | 400 Bad Request |
| **TC-IN-05** | Invite to Owner role | Valid `userId`, `roleId` of Owner | Owner role specified | 400 Bad Request |
| **TC-IN-06** | Invite to peer Admin | Valid `userId`, `roleId` Admin | Actor is Admin (90) | 403 Forbidden |
| **TC-IN-07** | Withdraw pending invite | Valid `inviteId` | Status changes to CANCELLED | 200 OK |
| **TC-IN-08** | Withdraw non-existent invite | Invalid `inviteId` | Invite not found | 404 Not Found |
| **TC-IN-09** | Accept valid invite | Valid token | status = ACTIVE | 200 OK |
| **TC-IN-10** | Accept expired invite | Expired token | status = EXPIRED | 400 Bad Request |
| **TC-IN-11** | Accept cancelled invite | Cancelled token | status = CANCELLED | 400 Bad Request |
| **TC-IN-12** | Get pending invites list | None | Returns list of PENDING invites | 200 OK |

---

## 5. Module 5: RBAC Middleware & Route Security (50+ Scenarios)

Enforce that the `requireOrgAccess(featureKey, isPublicRoute)` middleware checks permissions only when acting as `ORGANIZATION` actor, and supports public routes.

### 5.1 Route Security Matrix (40 Scenarios)

| Test ID | HTTP Route tested | requiredKey | Actor type | Actor Role / Permissions | Expected Result |
|---|---|---|---|---|---|
| **TC-SEC-01** | `POST /teams/roles` | `MANAGE_ROLES` | USER | Normal user sub-profile | **Allowed** (200) - Bypasses check |
| **TC-SEC-02** | `POST /teams/roles` | `MANAGE_ROLES` | ORGANIZATION | Owner (`*`) | **Allowed** (200) - Owner bypass |
| **TC-SEC-03** | `POST /teams/roles` | `MANAGE_ROLES` | ORGANIZATION | Admin (`MANAGE_ROLES`) | **Allowed** (200) |
| **TC-SEC-04** | `POST /teams/roles` | `MANAGE_ROLES` | ORGANIZATION | Employee (`TEAMS` only) | **Blocked** (403) - Lack of perm |
| **TC-SEC-05** | `GET /teams/activity` | `ACTIVITY_LOGS`| ORGANIZATION | Employee (`TEAMS`, `ACTIVITY_LOGS`)| **Allowed** (200) |
| **TC-SEC-06** | `GET /teams/activity` | `ACTIVITY_LOGS`| ORGANIZATION | Employee (`TEAMS` only) | **Blocked** (403) - Lack of perm |
| **TC-SEC-07** | `GET /profile` (Public) | `PROFILE` (isPublic)| USER | Normal user | **Allowed** (200) - Bypassed |
| **TC-SEC-08** | `GET /profile` (Public) | `PROFILE` (isPublic)| ORGANIZATION | Employee (No perms) | **Allowed** (200) - Public bypass |
| **TC-SEC-09** | `GET /teams/roles` | `TEAMS` | ORGANIZATION | orgId mismatch in header/route | **Blocked** (403) - Org ID mismatch |

### 5.2 Sub-permission Fallback Checks (10 Scenarios)

| Test ID | requiredKey | Actor Permissions | Logic Evaluated | Expected Result |
|---|---|---|---|---|
| **TC-FB-01** | `QUERIES` | `["CHAT"]` | `CHAT` covers `QUERIES` | **Allowed** |
| **TC-FB-02** | `QUERIES` | `["QUERIES"]` | Exact match | **Allowed** |
| **TC-FB-03** | `QUERIES` | `["CREATE_POST"]` | No match | **Blocked (403)** |
| **TC-FB-04** | `JOBS_CHAT` | `["JOBS"]` | `JOBS` covers `JOBS_CHAT` | **Allowed** |
| **TC-FB-05** | `JOBS_CHAT` | `["JOBS_CHAT"]` | Exact match | **Allowed** |
| **TC-FB-06** | `ACTIVITY_LOGS`| `["TEAMS"]` | `TEAMS` does NOT cover `ACTIVITY_LOGS` | **Blocked (403)** |

---

## 6. Module 6: Activity Logging & Auditing (30+ Scenarios)

### 6.1 Audit Log Parameter Matrix (20 Scenarios)
*   **Endpoint:** `GET /teams/activity`

| Test ID | Filter Query Parameters | Scenario | Expected Result |
|---|---|---|---|
| **TC-AUD-01** | None | Get all logs | 200 OK - Return list ordered by `created_at DESC` |
| **TC-AUD-02** | `?action=INVITE_MEMBER` | Filter by action type | 200 OK - Return invite logs only |
| **TC-AUD-03** | `?memberId=user-123` | Filter by actor member | 200 OK - Return logs performed by user-123 |
| **TC-AUD-04** | `?dateFrom=2026-07-01` | Filter by start date | 200 OK - Return logs after date |
| **TC-AUD-05** | `?dateTo=2026-07-18` | Filter by end date | 200 OK - Return logs before date |
| **TC-AUD-06** | Combined filters | Action + Member + Dates | 200 OK - Return fully filtered log list |

### 6.2 Audit Log Capture Scenarios (10 Scenarios)
Verify that performing actions as an `ORGANIZATION` actor records the correct role name and request metadata.

| Test ID | Performed Action | Log Entity | Log Actor Role | Log Metadata Captured |
|---|---|---|---|---|
| **TC-ALC-01** | Invite a member | `INVITE_MEMBER` | actor's current role name | `targetUserId`, `roleId`, `roleName`, `ip`, `userAgent` |
| **TC-ALC-02** | Remove a member | `REMOVE_MEMBER` | actor's current role name | `targetUserId`, `ip`, `userAgent` |
| **TC-ALC-03** | Create dynamic role | `CREATE_ROLE` | actor's current role name | `roleName`, `permissions`, `ip` |
| **TC-ALC-04** | Transfer ownership | `TRANSFER_OWNERSHIP` | `"Owner"` | `previousOwnerId`, `newOwnerId` |
| **TC-ALC-05** | View public profile | `VIEW_PROFILE` | actor's current role name | `path`, `method`, `ip` (Log-only route) |
