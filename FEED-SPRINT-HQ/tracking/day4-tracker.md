# Day 4 Execution Tracker

> **Date:** Sprint Day 4
> **Focus:** API Layer + Background Worker + Wiring

---

## Day 4 Goal

Complete, working API. Feed requests return real data.
End of Day 4: `GET /api/feed` works end-to-end for a real user.

---

## Dev B Tasks — Day 4 (Primary)

### Task B8 — Feed API Controller (Complete)
**Module:** `src/modules/feed/feed.controller.js`

- [ ] **B8.1** `getFeed(req, res)` — orchestrate full service call, return paginated response
- [ ] **B8.2** `trackEvent(req, res)` — validate event body, call analytics service, return 202
- [ ] **B8.3** `getSession(req, res)` — return current session state
- [ ] **B8.4** `resetSession(req, res)` — clear session + seen set
- [ ] **B8.5** Apply rate limiting middleware on all routes
- [ ] **B8.6** Validate request body against contracts (use Joi or manual validation)
- [ ] **B8.7** Return exact response shape from `contracts/api-contracts.md`

**Status:** 🔲 Not started

---

### Task B9 — Feed Background Worker
**Module:** `src/workers/feedWorker.js`

- [ ] **B9.1** Create `feedWorker.js` — runs on interval (configurable, default 5min)
- [ ] **B9.2** Refresh exploration pool: `explorationPool.refreshExplorationPool()`
- [ ] **B9.3** Process analytics event queue: `feedAnalytics.processEventQueue()`
- [ ] **B9.4** Expire old sessions in DB
- [ ] **B9.5** Wire worker into `src/server.js` (via `setInterval`)

**Status:** 🔲 Not started

---

### Task B10 — App.js Route Registration
**File:** `src/app.js`
**Requires:** Both Dev A + Dev B approval

- [ ] **B10.1** Register `feedRoutes` under `/api/feed`
- [ ] **B10.2** Confirm auth middleware applied correctly to feed routes

**Status:** 🔲 Not started

---

## Dev A Tasks — Day 4

### Task A9 — Candidate Pool Validation
**Cross-cutting**

- [ ] **A9.1** Validate that all candidate sources return correct `CandidateItem` shape
- [ ] **A9.2** Add logging: candidate count per source (debug mode only)
- [ ] **A9.3** Test edge case: user with no follows (should still get trending + explore)
- [ ] **A9.4** Test edge case: new user with no history (cold start)
- [ ] **A9.5** Test edge case: seen set full (5000 items) — should auto-clear oldest

**Status:** 🔲 Not started

---

## Day 4 EOD Integration Checkpoint

- [ ] `GET /api/feed` with real JWT returns 200 + populated items
- [ ] `POST /api/feed/event` with valid body returns 202
- [ ] `GET /api/feed/session` returns current session
- [ ] `DELETE /api/feed/session` resets session in Redis
- [ ] Rate limiting: 61st request in 1min returns 429
- [ ] Feed worker running (verify in server startup logs)
- [ ] Analytics events written to DB
- [ ] Response shape matches `contracts/api-contracts.md` exactly

**Checkpoint Status:** 🔲 Pending
