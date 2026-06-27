# AI Candidate Matching — Feature Context & Progress Tracker

> **Branch:** `feature/jdMatching`
> **Last Updated:** 2026-06-27
> **Current Phase:** NOT STARTED

---

## How to Use This File

This file is the **single source of truth** for anyone resuming work on this feature.

1. Read this file first before touching any code.
2. Check **Current Status** to see what is done and what is next.
3. After completing a phase, update the status table and check off the box.
4. Never skip a phase's automated test suite before marking it complete.

---

## Feature Summary

**Goal:** Implement a Hybrid AI Candidate Matching system that:
- Calculates a free backend score (skills + experience) for every applicant at apply-time.
- Freezes a complete candidate snapshot and job snapshot inside the same DB transaction.
- Auto-queues Gemini analysis only when a job has ≥ 25 total applications.
- Uses a three-tier priority system for Gemini calls (Immediate / Deferred / Skip).
- Lets recruiters trigger manual on-demand Gemini analysis for any candidate at any time.
- Serves the recruiter dashboard with instant filter + sort by AI/backend score via native SQL indexes.

**Business Rule (non-negotiable):**
The AI worker must ONLY read from `application_snapshots`. It must NEVER query live `users`, `profiles`, `experiences`, or `jobs` tables. This guarantees the evaluation is always based on data as it existed at the millisecond of application.

---

## Phase Status

| Phase | Name | Status | Test Passed |
|-------|------|--------|-------------|
| 0 | Database Migrations | ✅ Complete | ✅ |
| 1 | Job-Level Skill Extraction (Extract Once) | ✅ Complete | ✅ |
| 2 | Apply Flow — Snapshot Freeze + Tiered Queue | ✅ Complete | ✅ |
| 3 | Background AI Worker | ✅ Complete | ✅ |
| 4 | Recruiter Read Path (Filtering + Sorting) | ✅ Complete | ✅ |
| 5 | On-Demand Analysis + triggerAnalysis | ✅ Complete | ✅ |
| 6 | Worker Bootstrap + Integration Test | ✅ Complete | ✅ |

> Status values: ⬜ Not Started | 🔄 In Progress | ✅ Complete | ❌ Failed

---

## Architecture Decisions (Locked — Do Not Change Without Review)

| Decision | Choice | Reason |
|----------|--------|--------|
| When to freeze snapshots | Inside `applyJob` transaction | Eliminates race condition if candidate edits profile before worker runs |
| When to call Gemini | Background worker only | Recruiter dashboard must never trigger AI |
| Minimum pool before auto-analysis | 25 applications | Prevents wasting budget on low-traffic jobs |
| Tier 1 threshold | Score ≥ 65 OR top 15 for the job | Relative + absolute prevents jobs with weak pools from never getting AI |
| Tier 2 threshold | Score ≥ 30 | Queue but process only during idle time |
| Tier 3 (skip) | Score < 30 | Obvious spam — never auto-analyzed |
| Snapshot storage | Separate `application_snapshots` table | Keeps massive JSONB out of the core `job_applications` row |
| Score column | `backend_score` on `job_applications` + `match_score` on `application_ai_analyses` | Allows sorting before AI is done |
| analysis_type column | `'BACKEND'` or `'GEMINI'` on `application_ai_analyses` | Frontend badge differentiation |

---

## Environment Variables

Add these to `.env`:

```env
AI_MIN_APPLICATIONS_FOR_AUTO=25   # Minimum applications before any auto-Gemini runs
AI_TIER1_SCORE_THRESHOLD=65       # Score >= this → Tier 1 (immediate Gemini)
AI_TIER1_TOP_N=15                 # Always analyze top N for this job regardless of score
AI_TIER2_SCORE_THRESHOLD=30       # Score >= this → Tier 2 (deferred idle-time Gemini)
AI_ANALYSIS_INTERVAL_MS=30000     # Worker poll interval in milliseconds
AI_MODEL=gemini-2.5-flash         # Gemini model to use for analysis
```

---

## New Files to Create

| File | Purpose |
|------|---------|
| `migrations/20260627_003_frozen_filters.sql` | Frozen scalar columns + indexes on `job_applications` |
| `migrations/20260627_004_application_snapshots.sql` | New `application_snapshots` table |
| `migrations/20260627_005_ai_analysis_queue.sql` | New `ai_analysis_queue` table |
| `migrations/20260627_006_extend_ai_analyses.sql` | Add `analysis_type`, telemetry columns to existing table |
| `migrations/20260627_007_job_ai_requirements.sql` | Add `ai_extracted_requirements` to `jobs` |
| `src/core/ai/helpers.js` | Shared `withTimeout`, `withRetry`, `isRetryable` |
| `src/prompts/applicant-evaluator.v1.js` | Gemini prompt for candidate analysis |
| `src/services/candidateAnalysis.service.js` | Orchestrator: reads snapshots → calls Gemini → saves result |
| `src/workers/applicationAnalysisWorker.js` | Background polling worker |

## Files to Modify

| File | Change |
|------|--------|
| `src/prompts/jd-generator.v1.js` | Add `required_skills_keywords` to schema output |
| `src/modules/jobs/job.controller.js` | `applyJob`: wrap in transaction, freeze snapshots, tiered queue. `generateJD`: save `ai_extracted_requirements`. |
| `src/modules/jobs/applications/application.utils.js` | Add `calculateBackendScore` function |
| `src/modules/jobs/applications/application.queries.js` | `getApplicantList`: dynamic filters + score sort |
| `src/modules/jobs/applications/application.controller.js` | `getAnalysis`: remove 3 secondary queries. `triggerAnalysis`: implement. `getApplicantList`: pass filters. |
| `src/services/ai.service.js` | Import shared helpers from `core/ai/helpers.js` |
| `src/server.js` | Register `applicationAnalysisWorker` with `setInterval` |

---

## Key DB Tables Quick Reference

```
job_applications          — Core ledger. Has frozen_* columns + backend_score.
application_snapshots     — Immutable JSON vault. Written once at apply time.
ai_analysis_queue         — Outbox queue. priority: 3=on-demand, 2=tier1, 1=tier2.
application_ai_analyses   — AI output. analysis_type: 'BACKEND' | 'GEMINI'.
jobs                      — Has ai_extracted_requirements JSONB column.
```

---

## Testing Checklist (Run After ALL Phases Complete)

- [ ] Candidate applies → 201 response in < 500ms
- [ ] `application_snapshots` row exists after apply
- [ ] `application_ai_analyses` row exists with `analysis_type = 'BACKEND'`
- [ ] No Gemini call made during apply (check logs)
- [ ] Apply 25 candidates to same job → 26th triggers auto-queue
- [ ] Apply < 25 → `ai_analysis_queue` table stays empty
- [ ] Worker picks up queue row, calls Gemini, `analysis_type` becomes `'GEMINI'`
- [ ] `POST /applications/:id/analyze` returns 202 and inserts priority=3 queue row
- [ ] `GET /jobs/:id/applicants` sorts by `match_score DESC`
- [ ] Filter `?minExperience=3` returns only candidates with `frozen_experience_years >= 3`
- [ ] Filter `?skills=React,Node.js` returns only candidates with those in `frozen_skills`
- [ ] Candidate edits profile → existing application analysis unchanged
- [ ] Existing JD generation still works (no regression)
- [ ] Existing applicant status update still works (no regression)
- [ ] Existing recruiter notes still work (no regression)
