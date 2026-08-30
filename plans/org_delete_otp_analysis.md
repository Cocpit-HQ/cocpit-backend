# ORG DELETE — OTP VERIFICATION ANALYSIS REPORT
Senior Full Stack Developer Analysis

---

## SECTION 1 — DESIGN FLOW SUMMARY (Reference: Change Email OTP Flow)

As instructed, reference was taken from the existing Change Email OTP modal (`ChangeEmailModal.tsx`) since dedicated org delete design screenshots are unavailable.

### Step-by-Step UI Flow for Org Delete OTP Verification:
1. **Trigger Screen (Screen 1):**
   - Location: `CompanyAccountSettingsPage.tsx` under "Delete company account" / "Delete institution account" section.
   - Action: Owner clicks the **"Delete"** button.
   - Guard: Button is enabled only if `isOwner === true` (using `viewer_role_data.is_owner`).

2. **Step 1: Confirmation & Request OTP (Screen 2):**
   - Modal Opens: `DeleteCompanyModal.tsx` (re-engineered into multi-step OTP modal).
   - Display: Displays a warning header *"Delete your Cocpit [company/institution]"*, explanation text about permanent removal, and the target email address where the verification code will be sent.
   - Target Email Displayed: Masked email format (e.g., `o***r@domain.com` or `c***y@domain.com`) derived from the organization's email or fallback owner's email.
   - Action: User clicks **"Send OTP"** / **"Continue"**.
   - API Call: Calls `POST /api/v1/organizations/:orgId/delete/send-otp`.

3. **Step 2: OTP Input Screen (Screen 3):**
   - UI Elements:
     - 6-digit numeric OTP input field (`maxLength={6}`, numeric filtering `/\D/g`).
     - Subtitle showing masked email: *"A 6-digit verification code has been sent to xyz***@domain.com"*.
     - Countdown timer (30 seconds resend cooldown).
     - **"Resend Code"** button (disabled while countdown > 0).
     - Inline success badge / error message indicators.
     - Auto-submission when 6 digits are typed or manual click on **"Verify & Delete"** button.
   - Action: User enters 6-digit OTP and clicks **"Verify & Delete"**.
   - API Call: Calls `POST /api/v1/organizations/:orgId/delete/verify-otp`.

4. **Step 3: Final Completion & Redirection (Screen 4):**
   - Loading State: Button shows `"Deleting..."` with disabled state.
   - Success Toast: `"Your [company/institution] page has been scheduled for deletion"`.
   - Real-time Events: Socket event `org_deleted` broadcasted to all active members of the organization.
   - Redirection: Active profile automatically switched to `"USER"` context, and router redirects to `/feed`.

---

## SECTION 2 — EXISTING DELETE ORG CODE STATE

### Backend:
- **Endpoint Exists:** YES
- **Exact Path & Method:** `DELETE /api/v1/organizations/:orgId`
- **Controller File:** [organization.controller.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/modules/organization/organization.controller.js#L426-L531) (`deleteOrganization`)
- **Route File:** [organization.routes.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/modules/organization/organization.routes.js#L103)
- **Middleware Chain:** `requireAuth`, `requireOrgPermission("MANAGE_COMPANY")`, `organizationActionLimiter`
- **Current Verification Method:** Password-based (`req.body.password` compared against logged-in user's `password_hash` in `users` table via `comparePassword`).
- **Deletion Type:** Soft delete + Scheduled permanent deletion window (40 days grace period).
  - Nullifies `parent_org_id` on child organizations.
  - Inserts entry into `deletion_batches` table (`type = 'STANDALONE_COMPANY'`).
  - Sets `is_deleted = TRUE`, `deleted_at = NOW()`, `deletion_scheduled_at = NOW()`, `deletion_execute_at = NOW() + 40 days`, `deletion_batch_id`.
  - Generates SHA-256 restoration token in `organization_restoration_tokens`.
- **Database Tables Affected:** `organizations`, `deletion_batches`, `organization_restoration_tokens`, `organization_audit_logs`.
- **Session Cleanup:** Calls `chatSessionCtrl.endAllSessionsForOrganization(client, orgId, userId)`.
- **Email Sent:** Calls `emailService.sendOrganizationDeletionEmail(ownerEmail, orgName, rawToken, deletionExecuteAt)`.
- **Socket Events:** None currently emitted on deletion (only REST response returned).

### Frontend:
- **UI Exists:** YES
- **Component File:** [DeleteCompanyModal.tsx](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-frontend/src/features/settings/tabs/account/components/modals/DeleteCompanyModal.tsx)
- **Parent Page:** [CompanyAccountSettingsPage.tsx](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-frontend/src/features/settings/tabs/account/pages/CompanyAccountSettingsPage.tsx)
- **Current Flow:** Password-based input field -> calls `companyService.deleteCompany(companyId, password)`.
- **Service File:** [organization.service.ts](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-frontend/src/services/organization.service.ts)

---

## SECTION 3 — OTP SYSTEM CURRENT STATE

- **Exists:** YES
- **Primary Files:**
  - Backend Service: [otp.service.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/modules/auth/otp.service.js)
  - Backend Controller: [otp.controller.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/modules/auth/otp.controller.js)
  - Email Service: [email.service.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/core/services/email.service.js)
  - DB Table Migration: [migration_email_otps.sql](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/db/migration_email_otps.sql)

### Technical Specifications of Existing OTP System:
- **Generation:** 6-digit cryptographically secure random number using `crypto.randomInt(100000, 999999)`.
- **Storage:** Table `email_otps` (`id`, `email`, `otp_hash`, `expires_at`, `attempts`, `created_at`, `request_count`).
- **Hashing:** `bcrypt.hash(otp, 10)`.
- **Expiry:** Configurable via `process.env.OTP_EXPIRY_MINUTES` (defaults to 5 minutes).
- **Verification:** `bcrypt.compare(otp, record.otp_hash)`. Single-use enforcement via immediate `DELETE FROM email_otps WHERE email = $1`.
- **Rate Limiting & Cooldown:**
  - 5-second minimum gap between requests.
  - Max 3 requests per email per 60-second window.
  - Max 5 wrong verification attempts before OTP is invalidated.
- **Purposes Supported Currently:** `"signup"`, `"password_reset"`, `"email_change"`, `"recovery"`.

### Reusability Analysis:
The existing `otp.service.js` is clean, robust, and directly reusable by passing purpose `"org_delete"`.

---

## SECTION 4 — ORG EMAIL IDENTIFICATION

- **Database Table:** `organizations`
- **Email Column:** `email VARCHAR(255)` (Line 269 of `schema.sql`)
- **Owner Relationship:** `created_by UUID REFERENCES users(user_id)`
- **Resolution Logic:**
  1. Primary target: `organizations.email`
  2. Fallback target (if `organizations.email` is null/empty): Query `users.email` where `user_id = organizations.created_by`.
- **Masking Helper:** Email should be masked before returning to frontend for privacy (e.g., `j***n@example.com`).

---

## SECTION 5 — GAP SUMMARY

| Gap ID | Description | Severity | Resolution Strategy |
|:---|:---|:---|:---|
| **GAP 1** | Existing endpoint requires user password; org actors operate via actor context without passwords. | **CRITICAL** | Replace password verification in org deletion flow with 2-step OTP verification. |
| **GAP 2** | Missing dedicated endpoints for Org Delete OTP generation and verification. | **HIGH** | Add `POST /organizations/:orgId/delete/send-otp` and `POST /organizations/:orgId/delete/verify-otp`. |
| **GAP 3** | `email.service.js` lacks a specific HTML email template for `org_delete` OTP purpose. | **MEDIUM** | Extend `sendOTPEmail` in `email.service.js` with `purpose === "org_delete"`. |
| **GAP 4** | Frontend `DeleteCompanyModal.tsx` currently renders password input instead of multi-step OTP UI. | **HIGH** | Refactor `DeleteCompanyModal.tsx` into a 2-step OTP wizard (Send OTP -> Enter 6-digit OTP -> Delete). |
| **GAP 5** | Lack of real-time socket notification when an organization is deleted. | **MEDIUM** | Broadcast `org_deleted` socket event to all active organization members upon successful deletion. |

---

## SECTION 6 — POST-DELETE IMPACT

When an organization is scheduled for deletion:
1. **Active Sessions:** Calls `chatSessionCtrl.endAllSessionsForOrganization` to terminate active organization messaging sessions.
2. **Actor Switch:** Frontend switches active actor back to `USER` context and redirects to `/feed`.
3. **Real-time Sync:** Socket event `org_deleted` triggers `refreshProfile()` on connected clients, removing the organization from their active organization switcher dropdown.
4. **Data Integrity:** Soft deletion (`is_deleted = TRUE`, `deleted_at = NOW()`) keeps all posts, members, and jobs intact during the 40-day recovery window before background permanent cleanup.
