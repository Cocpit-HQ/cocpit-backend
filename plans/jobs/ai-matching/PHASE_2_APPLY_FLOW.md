# Phase 2: Apply Flow — Snapshot Freeze + Tiered Queue

## Objective
Make the application write path transactional, calculate the free backend score, freeze immutable snapshots, and intelligently queue based on a three-tier system + minimum pool gate.

## Implementation Steps
1. Create `calculateBackendScore` helper in `src/modules/jobs/applications/application.utils.js`:
   - Inputs: candidate skills, total years, job requirements.
   - Outputs: 0-100 score.
2. Refactor `applyJob` in `src/modules/jobs/job.controller.js`:
   - Wrap in `BEGIN`/`COMMIT` transaction using `pool.connect()`.
   - Fetch candidate live profile data (skills, experience, education).
   - Calculate `backendScore`.
   - `INSERT INTO job_applications` with new frozen fields.
   - `INSERT INTO application_snapshots`.
   - `INSERT INTO application_ai_analyses` (with `analysis_type='BACKEND'`).
   - Implement the Minimum Pool Gate (only auto-queue if job has >= 25 applications).
   - Implement the Three-Tier Queue Logic (Priority 2 for top 15/score>=65, Priority 1 for score>=30).
   - Implement the Queue Demotion Logic (demote previous Priority 2 to Priority 1 if displaced).

## Automation Testing Instructions
- Create a test script `scratch/test_phase2.js` to simulate 30 applications to a single job.
- Verify that apps 1-24 are NOT queued.
- Verify that app 25 triggers queueing.
- Verify that snapshots are correctly populated.
- Verify `backend_score` is correct.
- Run `npm test` to verify `job.lifecycle.test.js` is green.
