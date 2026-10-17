# Phase 5: On-Demand Analysis + triggerAnalysis

## Objective
Allow recruiters to trigger Gemini analysis manually for candidates who were not queued automatically (Tier 3) or who are waiting in the deferred queue (Tier 2).

## Implementation Steps
1. Modify `src/modules/jobs/applications/application.controller.js` (`triggerAnalysis`):
   - Check if an analysis is already queued (`PENDING` or `PROCESSING`).
   - If yes, return `202 Accepted` with a message.
   - If not, insert a new row into `ai_analysis_queue` with `priority = 3` (highest) and `reason = 'ON_DEMAND_RECRUITER'`.
   - Return `202 Accepted`.

## Automation Testing Instructions
- Create `scratch/test_phase5.js` to mock an HTTP POST to `/applications/:id/analyze`.
- Verify the `ai_analysis_queue` table reflects the high-priority insertion.
