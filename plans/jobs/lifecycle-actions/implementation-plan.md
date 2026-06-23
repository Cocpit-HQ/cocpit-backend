# Implementation Plan: Moderation & Lifecycle Actions (Phase 2)

## 1. Backwards Compatibility (`job.controller.js`)
- **`createJob`**: Change inserted `status` from `'DRAFT'` back to `'ACTIVE'`.
- **`submitJob`**: Change updated `status` from `'UNDER_REVIEW'` back to `'ACTIVE'`.

## 2. Role Validation Overrides (`job.routes.js`)
- Strip all `requireRoles(["Recruiter", "Admin", "Employer"])` middlewares from `/jobs` routes. Anyone can post a job.

## 3. Controllers (`job.controller.js`)
Implement the following methods with strict state transition checks and ownership verification (but no role enforcement):

- **`pauseJob`**: 
  - Allowed from: `ACTIVE`.
  - Sets to: `PAUSED`.
- **`closeJob`**:
  - Allowed from: `ACTIVE`, `PAUSED`.
  - Sets to: `CLOSED`.
- **`archiveJob`**:
  - Allowed from: ANY.
  - Sets to: `ARCHIVED`.
- **`approveJob`**:
  - Allowed from: `UNDER_REVIEW`.
  - Sets to: `ACTIVE`.
- **`rejectJob`**:
  - Allowed from: `UNDER_REVIEW`.
  - Sets to: `REJECTED`.

*Note: All actions must log an event to `job_activity`.*

## 4. Routes (`job.routes.js`)
- Register `POST /:id/pause`
- Register `POST /:id/close`
- Register `POST /:id/archive`
- Register `POST /:id/approve`
- Register `POST /:id/reject`
