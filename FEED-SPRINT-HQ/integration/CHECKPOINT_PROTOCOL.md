# Integration Checkpoint Protocol

> Run this checklist at the END of each sprint day.
> Do NOT skip. Discovering incompatibilities on Day 5 is a sprint failure.

---

## How It Works

1. **Dev B runs** the integration checkpoint (owns test harness)
2. **Dev A reviews** the results
3. **Both sign off** before day is considered complete
4. Results logged in `integration/integration-log.md`

---

## Daily Checkpoint Checklists

### Day 1 EOD Checkpoint

**Theme:** Foundation is wired

```
[ ] Redis is running and accessible
[ ] Feed session can be created and retrieved
[ ] Session cursor exists in Redis with correct TTL
[ ] GET /api/feed returns 200 (empty results OK)
[ ] GET /api/feed/session returns valid FeedSession shape
[ ] DELETE /api/feed/session clears Redis keys
[ ] DB migrations ran cleanly on fresh DB
[ ] Migrations can be rolled back (run DOWN migration)
[ ] Pool.js: DB connection failure does NOT crash server
```

### Day 2 EOD Checkpoint

**Theme:** Data flows through the ranking pipeline

```
[ ] candidateGenerator.generateForUser(userId) returns CandidateItem[]
[ ] All CandidateItems have required fields from schema
[ ] Candidate pool cached in Redis: feed:candidates:{userId}
[ ] rankingCalculator.rankCandidates() returns sorted array
[ ] Ranking is deterministic: run 3x, same output each time
[ ] ranking_version is set on all results
[ ] Diversity penalty applied (author frequency tracked)
[ ] Seen set correctly filters already-viewed candidates
```

### Day 3 EOD Checkpoint

**Theme:** Full page assembly works

```
[ ] feed.service.getFeed(userId) returns exactly 20 items
[ ] Exploration slots at positions [3, 10, 17]
[ ] Opportunity slots at positions [6, 13, 19]
[ ] No author appears more than 2 times in 20-item page
[ ] No content type appears more than 3 times in 20-item page
[ ] Analytics event recorded when feed is assembled
[ ] feed:slice:{userId}:{cursor} exists in Redis after first call
[ ] Second call within 5min uses cached slice (cache_hit: true)
```

### Day 4 EOD Checkpoint

**Theme:** Full API works end-to-end

```
[ ] GET /api/feed with real JWT returns 200 + items
[ ] GET /api/feed response shape matches api-contracts.md exactly
[ ] POST /api/feed/event with valid body returns 202
[ ] POST /api/feed/event with invalid body returns 400
[ ] GET /api/feed/session returns current session state
[ ] DELETE /api/feed/session resets seen set (next call returns different items)
[ ] Rate limit: 61st request in 60s returns 429
[ ] Feed worker running (check server startup log)
[ ] Analytics events written to DB (check feed_events table)
```

### Day 5 EOD Checkpoint (Production Gate)

```
[ ] All Day 1–4 checkpoints still pass
[ ] Integration test suite: 100% passing
[ ] Contract test suite: 100% passing
[ ] Edge case tests: cold start, full seen set, empty candidates
[ ] Load test: 20 concurrent requests complete < 500ms
[ ] All Redis keys match registry (automated check if possible)
[ ] All migrations reversible
[ ] No PII in Redis
[ ] Code review: no TODOs, no debug logs, no hardcoded values
[ ] Both developers have signed off
```

---

## Cross-Module Compatibility Matrix

| Consumer | Depends On | Interface | Verified Day |
|----------|-----------|-----------|-------------|
| Ranking Engine | Candidate Generator | `CandidateItem[]` | Day 2 |
| Reranking | Ranking Engine | `ScoredCandidate[]` | Day 3 |
| Feed Service | Reranking | `FeedItem[]` (20 items) | Day 3 |
| Feed Controller | Feed Service | `{ items, cursor, meta }` | Day 4 |
| Feed Controller | Session Service | `FeedSession` | Day 1 |
| Feed Controller | Analytics Service | void (fire-and-forget) | Day 4 |
| Feed Worker | Exploration Pool | Redis sorted set | Day 4 |
| Feed Worker | Analytics Service | event queue processing | Day 4 |

---

## Failure Protocol

If a checkpoint fails:
1. Document the failure in `integration/integration-log.md`
2. Log a blocker in `blockers/BLOCKER_LOG.md`
3. Do NOT merge code that fails a checkpoint into the shared branch
4. Assign a fix owner and estimated resolution time
5. Re-run checkpoint after fix
