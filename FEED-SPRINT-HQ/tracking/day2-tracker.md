# Day 2 Execution Tracker

> **Date:** Sprint Day 2
> **Focus:** Core Engine — Candidate Generation + Ranking

---

## Day 2 Goal

Full candidate generation pipeline producing ranked results.
End of Day 2: Given a user_id, generate a ranked list of feed candidates.

---

## Dev A Tasks — Day 2

### Task A3 — Social Graph Candidate Source
**Module:** `src/modules/feed/candidates/sources/socialGraphSource.js`
**Priority:** 🔴 CRITICAL

- [x] **A3.1** Query posts from followed users (last 72h) — 1st-degree via `followers` table, `visibility = 'public'`
- [x] **A3.2** Query posts from 2nd-degree connections (last 48h) — double-join on `followers`, excludes already-followed authors
- [x] **A3.3** Compute `relationship_score` per author — 0.75 mutual (via `connections` table), 0.50 1st-degree, 0.25 2nd-degree
- [x] **A3.4** Return array of `CandidateItem` objects — factory-mapped, schema-aligned
- [x] **A3.5** Apply 50-candidate cap — dedup by `contentId` (1st-degree wins), then `.slice(0, 50)`

**Status:** ✅ Complete
**Completion:** 5 / 5 subtasks
**Completed:** 2026-05-24 12:30 IST

---

### Task A4 — Trending Candidate Source
**Module:** `src/modules/feed/candidates/sources/trendingSource.js`
**Priority:** 🟡

- [x] **A4.1** Query content by engagement score (last 24h) — DB fallback: `post_likes × 0.6 + post_comments × 1.2 + shared_post × 1.5`
- [x] **A4.2** Populate `feed:trending:global` Redis sorted set (TTL: 600s = 10min) — pipeline ZADD + EXPIRE
- [x] **A4.3** Filter content already in social graph source — `socialGraphIds` Set passed as param, O(1) lookup
- [x] **A4.4** Return 30 trending candidates max — Redis-first, DB fallback, resilient (returns `[]` on both fail)

**Status:** ✅ Complete
**Completion:** 4 / 4 subtasks
**Completed:** 2026-05-24 12:35 IST

---

### Task A5 — Ranking Engine
**Module:** `src/modules/feed/ranking/`
**Priority:** 🔴 CRITICAL

- [x] **A5.1** Created `ranking/rankingCalculator.js` — Signal Registry pattern (weights from frozen contract, formula is a registry loop)
- [x] **A5.2** `computeRecency(candidate, ctx)` → 0–1 — < 1h: 1.0 | 1–72h: linear decay | >72h: exponential × 0.4 | floor: 0.05
- [x] **A5.3** `computeEngagement(candidate, ctx)` → 0–1 — normalized: `candidate.score / maxEngagement` (ctx computed once per run)
- [x] **A5.4** `computeIntentMatch(candidate, ctx)` → 0–1 — 1 DB query per `rankCandidates` call (not per candidate), maps job/event/post types
- [x] **A5.5** `computeFinalScore(candidate, ctx)` → `{ score, breakdown }` — loops SIGNAL_REGISTRY, auto-generates `score_breakdown`
- [x] **A5.6** `rankCandidates(candidates, userId, pool)` → `ScoredCandidate[]` — sorted DESC, position: null (Day 3)
- [x] **A5.7** `ranking_version: "1.0.0"` attached to every result — tested ✅
- [x] **A5.8** Determinism test passing — 11/11 Jest tests ✅ (`npm test -- --testPathPatterns=rankingCalculator`)

**Status:** ✅ Complete
**Completion:** 8 / 8 subtasks
**Completed:** 2026-05-24 12:45 IST
**Test result:** 11/11 passing — 0 failures

---

## Dev B Tasks — Day 2

### Task B4 — Reranking / Diversity (Scaffold + Part 1)
**Module:** `src/modules/feed/reranking/`
**Priority:** 🟡 Start Day 2, finish Day 3

- [x] **B4.1** Create `rerankingEngine.js`
- [x] **B4.2** Implement author-diversity enforcement (max 2 per page)
- [x] **B4.3** Implement content-type diversity enforcement (max 3 of same type)
- [x] **B4.4** Apply diversity penalties to ranked list (do not remove, just penalize)
- [x] **B4.5** Implement seen-set filter (exclude items in `feed:seen:{userId}`)

**Status:** ✅ Complete
**Completion:** 5 / 5 subtasks
**Completed:** 2026-05-24 IST

---

### Task B5 — Candidate Generator Orchestration
**Module:** `src/modules/feed/candidates/candidateGenerator.js`
**Priority:** 🟡

- [x] **B5.1** Orchestrate all candidate sources (social, trending, opportunity, explore)
- [x] **B5.2** Merge and deduplicate candidates
- [x] **B5.3** Cache candidate pool in Redis: `feed:candidates:{userId}` (TTL: 2min)
- [x] **B5.4** Return merged `CandidateItem[]`

**Status:** ✅ Complete
**Completion:** 4 / 4 subtasks
**Completed:** 2026-05-24 IST

---

## Day 2 EOD Integration Checkpoint

- [x] `rankingCalculator.rankCandidates(candidates, userId)` returns sorted `ScoredCandidate[]` ✅
- [x] Ranking is deterministic (same inputs → same order) — Jest determinism test passing ✅
- [x] `ranking_version: "1.0.0"` is set on all ranking results ✅
- [x] No schema field mismatches vs `candidate.schema.json` ✅
- [x] `feed:trending:global` Redis key populated with TTL 600s ✅
- [x] `candidateGenerator.generateForUser(userId)` end-to-end with live DB ✅
- [x] Candidate pool cached in Redis `feed:candidates:{userId}` (TTL 120s) ✅

**Dev A checkpoint items: ✅ All complete**
**Dev B checkpoint items: ✅ All complete**

**Checkpoint Status:** ✅ Day 2 Complete
