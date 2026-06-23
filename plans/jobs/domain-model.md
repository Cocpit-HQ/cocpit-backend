# Domain Model: Jobs

This document defines the complete `Job` domain.

## `jobs` Table (Aggregate Root)
| Field | Type | Nullable | Default | Validation | Editable? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `job_id` | UUID | No | `gen_random_uuid()` | UUID | No |
| `title` | TEXT | No | - | Not empty | Yes |
| `status` | VARCHAR | No | `'DRAFT'` | IN (DRAFT, UNDER_REVIEW, ACTIVE, PAUSED, CLOSED, EXPIRED, REJECTED, ARCHIVED) | Via Actions |
| `org_id` | UUID | Yes | - | Valid Organization UUID | No |
| `recruiter_id` | UUID | Yes | - | Valid User UUID | No |
| `description` | TEXT | Yes* | - | > 100 chars (on submit) | Yes |
| `location` | TEXT | Yes* | - | Not empty (on submit) | Yes |
| `salary_min` | INT | Yes* | - | >= 0 | Yes |
| `salary_max` | INT | Yes* | - | >= salary_min | Yes |
| `experience_min`| INT | Yes* | - | >= 0 | Yes |
| `experience_max`| INT | Yes* | - | >= experience_min | Yes |
| `experience_label`| TEXT | Yes | - | E.g. "Junior", "Senior" | Yes |
| `work_mode` | VARCHAR | Yes* | - | IN (Remote, Hybrid, Onsite) | Yes |
| `job_type` | TEXT | Yes* | - | E.g. "Full-time", "Contract" | Yes |
| `created_at` | TIMESTAMPTZ | No | `now()` | - | No |

*\* Nullable during `DRAFT` status, but required upon submission depending on business rules.*

## `job_versions` Table (History & Provenance)
Tracks changes for audit and rollback purposes.
- `version_id` (UUID)
- `job_id` (UUID)
- `trigger_event` (VARCHAR) - e.g., 'MANUAL_SAVE', 'AI_GENERATE', 'SUBMIT'
- `provenance` (VARCHAR) - 'USER', 'AI', 'SYSTEM'
- `previous_data` (JSONB)
- `changed_by` (UUID) - User ID or System ID

## `job_activity` Table (Audit Trail)
Tracks lifecycle business events.
- `activity_id` (UUID)
- `job_id` (UUID)
- `action` (VARCHAR) - e.g., 'DRAFT_CREATED', 'SUBMITTED', 'APPROVED', 'PAUSED'
- `actor_id` (UUID) - The user who triggered the action
- `created_at` (TIMESTAMPTZ)