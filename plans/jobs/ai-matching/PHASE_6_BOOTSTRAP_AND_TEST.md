# Phase 6: Worker Bootstrap & Integration Test

## Objective
Connect the worker to the server lifecycle and perform a full end-to-end integration test.

## Implementation Steps
1. Modify `src/server.js`:
   - Import `processAnalysisQueue` from `applicationAnalysisWorker.js`.
   - Use `setInterval(processAnalysisQueue, process.env.AI_ANALYSIS_INTERVAL_MS || 30000)`.
2. Integration Test:
   - Perform the checklist defined in `CONTEXT.md` to ensure all functionality works together seamlessly.

## Automation Testing Instructions
- Use `scratch/run_listings_test.js` (or similar) to run the full end-to-end flow.
- Confirm background workers process items successfully without manual invocation.
