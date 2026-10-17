# ORG DELETE — OTP VERIFICATION IMPLEMENTATION PLAN (UPDATED)

---

## Executive Summary & Updated Requirements

Per user feedback, the Organisation Delete OTP system has been updated with the following precise guidelines:
1. **Dual Email Delivery:** The 6-digit OTP will be dispatched to **BOTH** the Organization's registered email (`organizations.email`) AND the Owner's personal registered email (`users.email`). If they are identical, 1 email is sent; if different, both recipients receive the code simultaneously.
2. **Professional Email Template:** Email format will use premium, responsive HTML styling with clear branding, organization name display, large OTP styling, and prominent security warnings.
3. **Settings-Based 40-Day Restoration:** The 40-day soft-deletion grace period remains active, but restoration is triggered by the owner directly from the Owner Settings UI (not via email links).
4. **Zero Regression Guarantee:** The User Account Deletion flow (`DeleteAccountModal.tsx` and User Delete API) remains 100% untouched and isolated.

---

## Detailed Technical Architecture

### 1. Dual Email Resolution & OTP Dispatch
When the owner clicks "Send OTP" for an organization:
```javascript
// 1. Fetch organization email & owner's user ID
const orgRes = await client.query(
    "SELECT name, email, created_by FROM organizations WHERE org_id = $1",
    [orgId]
);

// 2. Fetch owner's user email
const ownerRes = await client.query(
    "SELECT email FROM users WHERE user_id = $1",
    [orgRes.rows[0].created_by]
);

// 3. Build unique recipient array
const recipients = Array.from(new Set([
    orgRes.rows[0].email?.toLowerCase().trim(),
    ownerRes.rows[0].email?.toLowerCase().trim()
].filter(Boolean)));
```

### 2. Dual-Recipient Email Template (`email.service.js`)
Subject: `Action Required: Organization Deletion Verification Code for [Org Name]`

HTML Layout Features:
- Dark theme header (`#0F172A`) with Cocpit logo branding.
- Dynamic greeting highlighting the specific Organization Name.
- Styled OTP box (`#F0F4FF` background, `#2563eb` text, `32px` font size, `6px` letter spacing).
- Multi-recipient notification: Explains that the code was dispatched to all registered administrative contact emails for the organization.
- Explicit security callout explaining expiry (5 minutes) and security guidance if unauthorized.

---

## API Design

### API 1: Send Org Delete OTP
* **Method:** `POST`
* **Path:** `/api/v1/organizations/:orgId/delete/send-otp`
* **Auth & Middlewares:** `requireAuth`, `requireOrgPermission("MANAGE_COMPANY")`, `otpGenerationLimiter`
* **Controller:** `organization.controller.js` -> `sendDeleteOrgOTP`
* **Flow:**
  1. Authorize owner/admin using `checkOrgPermission`.
  2. Query `organizations` and `users` to collect all registered emails (Org Email + Owner Email).
  3. Generate & hash 6-digit OTP in `email_otps` table for the primary email key.
  4. Send styled email to `recipients` array (both emails receiving the exact same code).
  5. Return `{ success: true, email_masked: maskedEmailDisplay, expires_in_seconds: 300, cooldown_seconds: 30 }`.

### API 2: Verify OTP & Soft Delete Organization
* **Method:** `POST`
* **Path:** `/api/v1/organizations/:orgId/delete/verify-otp`
* **Auth & Middlewares:** `requireAuth`, `requireOrgPermission("MANAGE_COMPANY")`, `organizationActionLimiter`
* **Controller:** `organization.controller.js` -> `verifyOTPAndDeleteOrganization`
* **Body:** `{ "otp": "123456" }`
* **Flow:**
  1. Authorize owner/admin.
  2. Verify 6-digit OTP against `email_otps` table.
  3. Begin DB Transaction:
     - Detach child organizations (`UPDATE organizations SET parent_org_id = NULL`).
     - Create entry in `deletion_batches`.
     - Set `is_deleted = TRUE`, `deleted_at = NOW()`, `deletion_execute_at = NOW() + 40 days`.
     - End active messaging sessions via `chatSessionCtrl.endAllSessionsForOrganization`.
     - Log audit event.
  4. Commit Transaction.
  5. Broadcast socket event `org_deleted` to all active connected members of `orgId`.
  6. Return `{ success: true, message: "Organization scheduled for deletion", deletionDate: deletionExecuteAt }`.

---

## Proposed File Changes

### [Backend] `cocpit-backend`

#### [MODIFY] [email.service.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/core/services/email.service.js)
- Add `sendOrgDeleteOTPEmail(recipients, otp, orgName)` function supporting multi-recipient email sending (`to: recipients`) with professional HTML layout.

#### [MODIFY] [organization.controller.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/modules/organization/organization.controller.js)
- Add `sendDeleteOrgOTP` controller function.
- Add `verifyOTPAndDeleteOrganization` controller function.

#### [MODIFY] [organization.routes.js](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-backend/src/modules/organization/organization.routes.js)
- Register `POST /organizations/:orgId/delete/send-otp`
- Register `POST /organizations/:orgId/delete/verify-otp`

---

### [Frontend] `cocpit-frontend`

#### [MODIFY] [organization.service.ts](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-frontend/src/services/organization.service.ts)
- Add `sendDeleteOrgOTP(orgId: string)`
- Add `verifyAndDeleteCompany(orgId: string, otp: string)`

#### [MODIFY] [DeleteCompanyModal.tsx](file:///c:/Users/shubh/OneDrive/Desktop/Cocpit/cocpit-frontend/src/features/settings/tabs/account/components/modals/DeleteCompanyModal.tsx)
- Transform into 2-step OTP modal:
  - **Step 1:** Confirmation view displaying target emails where code will be sent + "Send OTP" button.
  - **Step 2:** 6-digit numeric input with auto-formatting, 30s countdown timer, Resend button, and "Verify & Delete" trigger.

---

## Isolation & Non-Breaking Verification

| Flow | File / Route | Impact Status |
|:---|:---|:---|
| **User Account Delete** | `DeleteAccountModal.tsx`, `/auth/account` | **UNTOUCHED (0% Risk)** |
| **User Password Reset** | `passwordReset.controller.js` | **UNTOUCHED (0% Risk)** |
| **Org Ownership Transfer** | `TransferOwnershipModal.tsx` | **UNTOUCHED (0% Risk)** |
| **Org Deactivation** | `DeactivateCompanyModal.tsx` | **UNTOUCHED (0% Risk)** |

---

## Step-by-Step Implementation Sequence

1. **Step 1:** Add `sendOrgDeleteOTPEmail` function in `email.service.js` with dual-recipient support and clean HTML template.
2. **Step 2:** Implement `sendDeleteOrgOTP` and `verifyOTPAndDeleteOrganization` in `organization.controller.js`.
3. **Step 3:** Register new routes in `organization.routes.js`.
4. **Step 4:** Add API service methods in `organization.service.ts`.
5. **Step 5:** Update `DeleteCompanyModal.tsx` UI to the 2-step OTP flow.
6. **Step 6:** Verify complete flow end-to-end.
