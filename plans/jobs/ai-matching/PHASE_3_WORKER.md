# Phase 3: Background AI Worker

## Objective
Implement a robust, polling background worker that processes the `ai_analysis_queue` based on priority, interacts safely with Gemini, and updates the analysis row.

## Implementation Steps
1. Create `src/core/ai/helpers.js`:
   - Extract `withTimeout`, `withRetry`, `sleep`, `isRetryable` from `src/services/ai.service.js`.
   - Update `ai.service.js` to import these helpers.
2. Create `src/prompts/applicant-evaluator.v1.js`:
   - Define `SYSTEM_INSTRUCTION`, `ANALYSIS_SCHEMA`, and `buildAnalysisPrompt`.
3. Create `src/services/candidateAnalysis.service.js`:
   - Fetch ONLY from `application_snapshots` (never `users` or `jobs`).
   - Call Gemini.
   - `UPDATE application_ai_analyses` to replace the backend score with the rich AI result and set `analysis_type = 'GEMINI'`.
4. Create `src/workers/applicationAnalysisWorker.js`:
   - Implement `processAnalysisQueue()` using `FOR UPDATE SKIP LOCKED`.
   - Prioritize Priority 2/3 jobs over Priority 1 jobs.
   - Implement exponential backoff for retries.

## Automation Testing Instructions
- Create `scratch/test_phase3.js` to manually insert a dummy queue row and trigger the worker function.
- Verify `ai_analysis_queue` updates to `COMPLETED`.
- Verify `application_ai_analyses` is correctly updated with Gemini output.
