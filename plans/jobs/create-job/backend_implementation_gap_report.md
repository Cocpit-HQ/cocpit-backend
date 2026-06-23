# Backend Implementation Gap Report (Revised)

This report compares the current `cocpit-backend` implementation against the approved **Architecture & API Specification** for the Job Management Platform. It categorizes every gap into implementation phases, providing a clear roadmap for the engineering team.

---

## 1. Database Schema (`schema.sql`)

| Gap Discovered | Current State | Target State | Classification | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Salary Constraint** | `CHECK (salary_min <= salary_max)` blocks partial drafts. | `CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)` | **Must implement before Phase 1** | Schema Migration |
| **Experience Fields** | Only `experience_level` (TEXT) exists. | Keep `experience_level` (as a derived label like 'Junior') AND add `experience_min` (INT) and `experience_max` (INT). | **Must implement before Phase 1** | Schema Migration |
| **Status CHECK Constraint** | `status` allows `('DRAFT', 'ACTIVE', 'CLOSED', 'EXPIRED', 'REJECTED', 'UNDER_REVIEW')`. | Add `PAUSED`, `ARCHIVED` to the `CHECK` constraint. (`SUBMITTED` is handled by `UNDER_REVIEW`). | **Must implement before Phase 1** | Schema Migration |
| **Job Activity Log** | Does not exist. Only `job_versions` exists. | Create `job_activity` table (job_id, actor_id, action, timestamp). | **Must implement before Phase 1** | Schema Addition |
| **Job Versions Trigger** | `job_versions` lacks provenance tracking. | Add `provenance` (USER/AI/SYSTEM) and `trigger_event`. Create versions on explicit events (Manual Save, AI Generate, Submit, Approve). | **Must implement before Phase 1** | Schema Migration |

---

## 2. API Routes & Controllers (`job.routes.js`, `job.controller.js`)

| Gap Discovered | Current State | Target State | Classification | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Draft Creation** | `POST /` immediately publishes (`status` defaults to `ACTIVE`). | `POST /` creates a job with `status = 'DRAFT'`. Returns `job_id`. | **Must implement before Phase 1** | API / Controller |
| **Autosave Endpoint** | Missing. Existing `PUT /:id` expects a full payload. | Create `PATCH /:id` for partial updates. | **Must implement before Phase 1** | API / Controller |
| **Submission Workflow** | Missing. Jobs are published at creation. | Create `POST /:id/submit`. Enforces strict validation and changes state to `UNDER_REVIEW`. | **Must implement before Phase 1** | API / Controller |
| **Clone Endpoint** | Missing. | Create `POST /:id/clone` to duplicate a job as a new `DRAFT`. | **Must implement before Phase 1** | API / Controller |
| **Search & Listing** | Existing `GET /jobs` and `GET /jobs/my` rely heavily on `is_active=TRUE`. | Update listing APIs to filter explicitly by `status` and `org_id`/`recruiter_id`. | **Must implement before Phase 1** | API / Controller |
| **Lifecycle Endpoints** | Missing specific action endpoints. | Create `POST /:id/pause`, `POST /:id/close`, `POST /:id/archive`. | **Should implement in Phase 2** | API / Controller |
| **Moderation Endpoints** | Missing. | Create `POST /:id/approve` and `POST /:id/reject` for admins/moderators. | **Should implement in Phase 2** | API / Controller |

---

## 3. Validation & Services Layer

| Gap Discovered | Current State | Target State | Classification | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Dual Validation Logic** | Strict validation occurs inside `createJob`. | **PATCH Validation:** Strict Schema/Type validation (e.g., salary must be an integer, not a string), NO business validation.<br>**Submit Validation:** Strict business validation (salary_min <= salary_max, description > 100 chars). | **Must implement before Phase 1** | Services / Validation |
| **State Machine Guardrails** | Controller logic lacks explicit state checks. | A service layer must verify valid transitions (e.g., cannot transition from `CLOSED` to `DRAFT`). | **Must implement before Phase 1** | Services / Logic |

---

## 4. Ownership & Permissions

| Gap Discovered | Current State | Target State | Classification | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Lifecycle Permissions** | `createJob` checks `POST_JOBS` / `MANAGE_COMPANY`. | Ensure only `recruiter_id` or Users with `MANAGE_COMPANY` role for `org_id` can `PATCH`, `Submit`, `Pause`, or `Close`. | **Must implement before Phase 1** | Middleware / Logic |

---

## 5. Implementation Roadmap & Strategy

To minimize disruption, the backend should be implemented in this sequence:

### Phase 1: Core Lifecycle & APIs (Immediate Priority)
*Goal: Provide Android, iOS, and Web teams with stable API endpoints so they can begin building the Job Creation UI, and establish an audit trail.*
1.  **Schema Migrations:** Write and run SQL migrations for `status` constraints, `salary_valid` null-safety, `experience_min/max`, and create the `job_activity` table.
2.  **Listing & Core CRUD:** Update `POST /jobs` (Create Draft), `GET /jobs/:id`, `PATCH /jobs/:id` (Schema validation only), and `DELETE /jobs/:id`. Update `GET /jobs` to support `status` filtering.
3.  **Workflow & Utility:** Implement `POST /jobs/:id/submit` (Business validation) and `POST /jobs/:id/clone`.

### Phase 2: Moderation & Advanced Management (Fast Follow)
*Goal: Support the full ATS lifecycle.*
1.  **Implement Lifecycle Actions:** Build endpoints for `pause`, `close`, and `archive`.
2.  **Implement Moderation:** Build `approve` and `reject` endpoints for the `UNDER_REVIEW` queue.

### Phase 3: AI Integration (Deferred)
*Goal: Integrate the AI generation engine.*
1.  Implement `POST /jobs/:id/ai/actions` endpoint to handle generic AI commands (`generate`, `rewrite`, `improve`). The AI service will act as a client that patches the draft and generates a `job_version`.
