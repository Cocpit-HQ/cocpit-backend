# Jobs Domain Architecture

## System Architecture
The Jobs Domain is structured around a single aggregate: the `Job` resource. The backend's responsibility is to manage the lifecycle of a Job, while external systems (like the AI Generation Service) act as trusted clients that interact with the Job through the same APIs as the mobile and web applications.

## Domain Boundaries
- The Job Domain owns `jobs`, `job_versions`, `job_activity`, and associated junction tables (e.g., `job_skills`).
- The Applications/ATS Domain (Applicant Tracking) is a distinct sub-domain. It owns `job_applications`, `application_status_history`, `application_notes`, and `application_ai_analyses`. It treats the `Job` as its root parent.
- It interfaces with the Organizations Domain (for company details/permissions) and the Users Domain (for recruiter details).

## Database Philosophy
- **Single Source of Truth:** The `jobs` table represents the current state. We do not use "Draft Sessions" tables; a draft is simply a job with `status = 'DRAFT'`.
- **Null-Safe Constraints:** Database constraints protect business rules for published jobs while allowing partial data for drafts (e.g., `CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)`).
- **Data Provenance:** The `jobs` table strictly stores business data. Information regarding *who* or *what* (e.g., AI) made changes is recorded in `job_versions` and `job_activity`.
- **ATS Isolation:** AI evaluation of candidates is strictly separated from the application row. The `application_ai_analyses` table acts as a frozen contract schema between the core Application domain and the AI Engineer's inference services.

## State Machine
The lifecycle of a job follows a strict state progression:
`DRAFT` -> `UNDER_REVIEW` -> `ACTIVE` -> `PAUSED` | `CLOSED` | `EXPIRED` -> `ARCHIVED`
(Or `UNDER_REVIEW` -> `REJECTED`)

Transitions are enforced by the Service Layer, not just the Database Layer.

## Permissions & Ownership
- Jobs are owned either by a specific `recruiter_id` (personal) or an `org_id` (company).
- Permissions to edit, submit, pause, or close are determined by Organization RBAC roles (e.g., `MANAGE_COMPANY`, `POST_JOBS`) or direct ownership.
- Access to Applicants is strictly gated by the parent job's ownership and the `VIEW_APPLICANTS` / `MANAGE_APPLICANTS` org permissions.

## AI Integration Strategy
The AI Service is loosely coupled.
1. It does not "own" the job or the application.
2. For job generation: It receives requests via `POST /jobs/:id/ai/actions` and updates the draft via `PATCH /jobs/:id`.
3. For applicant evaluation: It exposes a trigger at `POST /applications/:id/analyze`, pulls the job and applicant data, runs inference, and writes exactly one row to `application_ai_analyses`. It does not touch the core `job_applications` table.

## Future Extensibility
The architecture is designed to support the complete ATS workflow. The stable `job_id` and explicitly tracked lifecycle states ensure that downstream processes (candidate applications, scorecards, offer letters) have a reliable reference point. The strict separation of `Applications` into its own module lays the foundation for moving from simple statuses (`Applied`, `Shortlisted`) to full, customizable pipeline stages.