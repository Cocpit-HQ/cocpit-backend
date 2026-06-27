# Phase 0: Database Migrations

## Objective
Extend existing tables and create new tables required for the frozen snapshots, queueing, and three-tier scoring strategy.

## Implementation Steps
1. Create `migrations/20260627_003_frozen_filters.sql`
   - Add `frozen_experience_years`, `frozen_location`, `frozen_highest_degree`, `frozen_skills`, `backend_score` to `job_applications`
   - Add indexes for fast filtering and sorting.
2. Create `migrations/20260627_004_application_snapshots.sql`
   - Create `application_snapshots` table with `application_id`, `candidate_snapshot`, `job_snapshot`.
3. Create `migrations/20260627_005_ai_analysis_queue.sql`
   - Create `ai_analysis_queue` table with `queue_id`, `application_id`, `status`, `priority`, `reason`, `retry_count`, `error_message`.
   - Add index on `priority DESC, created_at ASC WHERE status = 'PENDING'`.
4. Create `migrations/20260627_006_extend_ai_analyses.sql`
   - Add `analysis_type`, `prompt_version`, `latency_ms`, `tokens_in`, `tokens_out` to `application_ai_analyses`.
5. Create `migrations/20260627_007_job_ai_requirements.sql`
   - Add `ai_extracted_requirements` to `jobs` table.
6. Create `migrations/run_20260627_003_to_007.js` (Optional but recommended for automation).
   - Script to run these migrations.

## Automation Testing Instructions
- After running migrations, execute a simple database check script to ensure all new columns and tables exist.
- Run `npm test` to ensure no existing DB queries break due to schema changes.
