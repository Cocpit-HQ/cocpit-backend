# Deployment Checklist — Feed Engine v1.0.0

> Run this checklist before deploying feed engine to production.
> Every item must be ✅ before deployment proceeds.

---

## Pre-Deployment Gate

### Code Completeness
- [ ] All Day 1–5 tracker tasks marked complete
- [ ] All Day 5 integration checkpoint items passing
- [ ] No `TODO`, `FIXME`, or `HACK` comments in production code
- [ ] All implementation header comments present in new files
- [ ] `ranking_version: "1.0.0"` set in ranking calculator

### Architecture Compliance
- [ ] All Redis keys match `contracts/redis-key-registry.md`
- [ ] All API responses match `contracts/api-contracts.md`
- [ ] Ranking formula verified against `contracts/ranking-features.md`
- [ ] All event types match `contracts/event-types.md`
- [ ] No schema fields renamed or removed

### Database
- [ ] All migrations applied to staging DB
- [ ] All migrations verified reversible
- [ ] Indexes created: `feed_events(user_id, timestamp)`, `feed_sessions(user_id, expires_at)`
- [ ] No existing tables modified (only new tables added)

### Redis
- [ ] Redis connection confirmed on target environment
- [ ] All feed keys have TTL configured (no persistent feed keys)
- [ ] Seen set max size enforced (5000 members)
- [ ] No PII stored in any feed Redis key

### Testing
- [ ] Integration tests passing on staging
- [ ] Contract tests passing
- [ ] Edge cases tested: cold start, empty feed, full seen set
- [ ] Load test: 20 concurrent requests < 500ms average

### Security
- [ ] Rate limiting active on all feed endpoints
- [ ] Auth middleware applied to all feed routes (except none are public)
- [ ] Input validation on `POST /api/feed/event` body
- [ ] No user data exposed in error messages

### Operations
- [ ] Feed worker starts cleanly (verify startup log)
- [ ] DB failure does not crash server (non-fatal retry)
- [ ] Redis failure falls back gracefully (no crash)
- [ ] Error responses use `errorHandler` middleware
- [ ] New Relic monitoring covers feed module (check transaction traces)

### Environment
- [ ] No hardcoded URLs or IPs in new code
- [ ] Feed-related env vars documented (add to `.env.example`)
- [ ] `NODE_ENV=production` tested if applicable

---

## Deployment Steps

1. **Apply migrations** to production DB
   ```bash
   node src/db/feed-migrations/run-migrations.js up
   ```

2. **Deploy new code** (standard deployment pipeline)

3. **Verify feed worker started** (check logs for `[FeedWorker] Started`)

4. **Smoke test** production
   ```bash
   GET /api/feed  → 200 with items
   POST /api/feed/event → 202
   GET /api/feed/session → 200
   ```

5. **Monitor** for 30 minutes:
   - New Relic: feed transaction errors < 1%
   - Redis memory: no unexpected growth
   - DB: `feed_events` table writing correctly

---

## Rollback Plan

If post-deployment issues arise:

1. **Revert code** to previous version via deployment pipeline
2. **Run DB migration DOWN** to remove feed tables (no existing data affected)
3. **Flush feed Redis keys** (optional, safe — they expire anyway):
   ```bash
   redis-cli --scan --pattern "feed:*" | xargs redis-cli del
   ```
4. **Notify team** with incident summary

---

## Sign-off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Dev A | — | — | — |
| Dev B | — | — | — |
