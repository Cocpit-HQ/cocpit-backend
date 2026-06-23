# Implementation Plan: Create Job (Phase 1)

## 1. Database Schema (`schema.sql`)
- Drop `experience_level`, add `experience_min`, `experience_max`, and `experience_label`.
- Alter `status` constraint to include `PAUSED` and `ARCHIVED`.
- Alter salary constraint to be NULL-safe: `(salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)`.
- Create `job_activity` table.
- Alter `job_versions` to include `trigger_event` and `provenance`.

## 2. Validation Services
- Implement Joi/Zod schemas for `JobDraftUpdate` (type validation only).
- Implement business validation function for `JobSubmission` (e.g., salary_max >= salary_min, description > 100 chars).

## 3. Controllers (`job.controller.js`)
- Refactor `createJob`: Accepts minimal payload, inserts with `status='DRAFT'`, returns `job_id`.
- Add `updateDraft`: Handles `PATCH /:id`, uses `JobDraftUpdate` schema.
- Add `submitJob`: Handles `POST /:id/submit`, uses `JobSubmission` validation, sets `status='UNDER_REVIEW'`, logs to `job_activity`.
- Add `cloneJob`: Duplicates a job into a new `DRAFT`.
- Update `getAllJobs` / `getMyJobs` to handle `status` filters.

## 4. Routes (`job.routes.js`)
- Register new endpoints (`PATCH /:id`, `POST /:id/submit`, `POST /:id/clone`).
- Ensure `requireAuth` and appropriate RBAC checks.