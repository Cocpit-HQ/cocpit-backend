# Feature Context: Moderation & Lifecycle Actions (Phase 2)

**Problem Statement:**
The Phase 1 API established the foundational draft-first architecture, but the platform lacks the ability for recruiters to pause, close, or archive their jobs. Additionally, there are no endpoints for administrators to moderate jobs (approve or reject them) from the `UNDER_REVIEW` queue.

**Business Goals:**
- Support the full Applicant Tracking System (ATS) lifecycle for jobs.
- Empower admins to curate the platform quality via moderation.
- Implement a temporary backwards-compatibility fallback so jobs are automatically `ACTIVE` upon creation, allowing legacy frontends to function until the Draft UI is ready.

**Requirements:**
- Implement Recruiter Lifecycle endpoints: `pauseJob`, `closeJob`, `archiveJob`.
- Implement Admin Moderation endpoints: `approveJob`, `rejectJob`.
- Apply state machine validations to prevent invalid transitions.
- Temporarily override `POST /jobs` and `POST /jobs/:id/submit` to transition directly to `ACTIVE`.

**Dependencies:**
- Phase 1 database schema (specifically `jobs.status` constraints and `job_activity`).
