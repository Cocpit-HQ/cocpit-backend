# Jobs Domain Architecture

## System Architecture
The Jobs Domain is structured around a single aggregate: the `Job` resource. The backend's responsibility is to manage the lifecycle of a Job, while external systems (like the AI Generation Service) act as trusted clients that interact with the Job through the same APIs as the mobile and web applications.

## Domain Boundaries
- The Job Domain owns `jobs`, `job_versions`, `job_activity`, and associated junction tables (e.g., `job_skills`).
- It interfaces with the Organizations Domain (for company details/permissions) and the Users Domain (for recruiter details).
- Future ATS domains (Applications, Interviews, Offers) will treat the `Job` as the root entity they attach to.

## Database Philosophy
- **Single Source of Truth:** The `jobs` table represents the current state. We do not use "Draft Sessions" tables; a draft is simply a job with `status = 'DRAFT'`.
- **Null-Safe Constraints:** Database constraints protect business rules for published jobs while allowing partial data for drafts (e.g., `CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)`).
- **Data Provenance:** The `jobs` table strictly stores business data. Information regarding *who* or *what* (e.g., AI) made changes is recorded in `job_versions` and `job_activity`.

## State Machine
The lifecycle of a job follows a strict state progression:
`DRAFT` -> `UNDER_REVIEW` -> `ACTIVE` -> `PAUSED` | `CLOSED` | `EXPIRED` -> `ARCHIVED`
(Or `UNDER_REVIEW` -> `REJECTED`)

Transitions are enforced by the Service Layer, not just the Database Layer.

## Permissions & Ownership
- Jobs are owned either by a specific `recruiter_id` (personal) or an `org_id` (company).
- Permissions to edit, submit, pause, or close are determined by Organization RBAC roles (e.g., `MANAGE_COMPANY`, `POST_JOBS`) or direct ownership.

## AI Integration Strategy
The AI Service is loosely coupled.
1. It does not "own" the job.
2. It receives generation requests via a unified action endpoint (`POST /jobs/:id/ai/actions`).
3. It updates the draft by calling the standard `PATCH /jobs/:id` endpoint.
4. It logs its actions to `job_versions` to maintain a distinct audit trail.

## Future Extensibility
The architecture is designed to support the complete ATS workflow. The stable `job_id` and explicitly tracked lifecycle states (`ACTIVE`, `CLOSED`, `ARCHIVED`) ensure that downstream processes (candidate applications, scorecards, offer letters) have a reliable reference point that won't disappear or unpredictably change states.