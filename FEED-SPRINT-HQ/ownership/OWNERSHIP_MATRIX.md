# Developer Ownership Matrix

> **Last updated:** Sprint Day 0
> **Sprint:** 5-Day Feed Engine Implementation
> **Team:** Dev A + Dev B

---

## Ownership Legend

| Symbol | Meaning |
|--------|---------|
| 🟢 **PRIMARY** | Full ownership — implement, test, review own work |
| 🔵 **REVIEWER** | Must review before merge |
| 🟡 **CONSULT** | Must be consulted before changes |
| ⬜ **NONE** | No involvement |

---

## Module Ownership Grid

| Module | File / Path | Dev A | Dev B | Notes |
|--------|-------------|-------|-------|-------|
| **Candidate Generation** | `src/modules/feed/candidates/` | 🟢 PRIMARY | 🔵 REVIEWER | Core logic Dev A owns |
| **Candidate Sources** | `candidates/sources/*.js` | 🟢 PRIMARY | ⬜ NONE | Social graph, trending, explore sources |
| **Ranking Engine** | `src/modules/feed/ranking/` | 🟢 PRIMARY | 🔵 REVIEWER | Deterministic scorer |
| **Ranking Calculator** | `ranking/rankingCalculator.js` | 🟢 PRIMARY | 🔵 REVIEWER | Signal weight logic — Dev B must review |
| **Reranking / Diversity** | `src/modules/feed/reranking/` | 🔵 REVIEWER | 🟢 PRIMARY | Diversity + anti-spam |
| **Feed Session Tracking** | `src/modules/feed/session/` | 🔵 REVIEWER | 🟢 PRIMARY | Session state + cursor |
| **Redis Cache Service** | `src/modules/feed/cache/` | 🟡 CONSULT | 🟢 PRIMARY | Key patterns from registry |
| **Feed API Controller** | `src/modules/feed/feed.controller.js` | 🟡 CONSULT | 🟢 PRIMARY | Route → service orchestration |
| **Feed Routes** | `src/modules/feed/feed.routes.js` | ⬜ NONE | 🟢 PRIMARY | Endpoint definitions |
| **Analytics / Events** | `src/modules/feed/analytics/` | 🟢 PRIMARY | 🔵 REVIEWER | Event ingestion + processing |
| **Exploration System** | `src/modules/feed/exploration/` | 🟢 PRIMARY | 🟡 CONSULT | Explore pool maintenance |
| **Feed Worker** | `src/workers/feedWorker.js` | 🟡 CONSULT | 🟢 PRIMARY | Background precompute worker |
| **DB Migrations** | `src/db/feed-migrations/` | 🟢 PRIMARY | 🔵 REVIEWER | Schema changes |
| **Intent Engine** (existing) | `src/workers/intentEngine.js` | 🔵 REVIEWER | 🟡 CONSULT | Read-only during sprint |
| **Pool / DB Config** (existing) | `src/core/db/pool.js` | 🟡 CONSULT | 🟡 CONSULT | Shared infra — mutual approval |
| **Redis Client** (existing) | `src/core/cache/` | 🟡 CONSULT | 🟡 CONSULT | Shared infra — mutual approval |
| **App Router** | `src/app.js` | 🔵 REVIEWER | 🟢 PRIMARY | Adding feed routes |
| **Integration Tests** | `tests/feed/` | 🔵 REVIEWER | 🟢 PRIMARY | Dev B owns test harness |
| **Contract Docs** | `FEED-SPRINT-HQ/contracts/` | 🟡 CONSULT | 🟡 CONSULT | Both must approve changes |

---

## Daily Responsibilities

### Dev A
- Owns candidate generation + ranking engine implementation
- Writes DB migrations for any new feed tables
- Maintains the exploration pool update logic
- Implements analytics event ingestion
- Reviews all Dev B PRs touching ranking logic

### Dev B
- Owns the feed API controller + routes (the "serving layer")
- Owns Redis cache layer implementation
- Owns feed session tracking
- Owns the reranking/diversity enforcement layer
- Owns the feed background worker
- Owns the integration test suite
- Reviews all Dev A PRs touching the API surface

---

## Conflict Resolution Rules

1. **If both devs edit the same file:** The PRIMARY owner's version wins. Reviewer must raise objections within 2 hours of PR.
2. **If a shared-infra file needs changing:** Both devs must +1 before merge.
3. **If a contract needs changing:** Use `governance/CONTRACT_CHANGE_PROCESS.md`. Both devs must approve.
4. **If blocked:** Log in `blockers/BLOCKER_LOG.md`. Don't hold up sprint.

---

## Integration Approval Flow

```
Dev A PR → Dev B reviews → Passes integration checkpoint → Merge
Dev B PR → Dev A reviews → Passes integration checkpoint → Merge
Shared infra PR → Both review → Both approve → Merge
Contract change → Both review → Both approve + log → Freeze
```

---

## Files That Require BOTH Developers to Approve

- `src/core/db/pool.js`
- `src/core/cache/*.js`
- `src/app.js`
- `FEED-SPRINT-HQ/contracts/*`
- `FEED-SPRINT-HQ/architecture/*`
- Any `*.schema.json` file
