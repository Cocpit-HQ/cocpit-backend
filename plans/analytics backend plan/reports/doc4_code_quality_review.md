# 🧹 Document 4: Unnecessary & Poor-Quality Changes — Code Review

> This document identifies all changes in the analytics branches that are **not required**, **violate industry standards**, or are **poor engineering practices** that need to be fixed before merging to `develop` or `main`.

---

## Category 1: Testing Code Left in Production 🔴

### P1 — Analytics Cron Set to 10 Seconds (Testing Interval in `server.js`)

**File:** [`src/server.js`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-backend/src/server.js)

```js
// TEMP: Run Analytics Cron every 10 seconds for real-time testing
const { runCronNow } = require('./workers/analytics.cron');
setInterval(() => {
  runCronNow().catch(err => console.error("Test Cron Error:", err));
}, 10 * 1000);
```

**Problem:** This is explicitly commented as "TEMP" and "for real-time testing" but was committed to the branch. A cron that aggregates analytics across all users running **12 times per minute** will destroy DB performance.

**Required fix:** Remove this entire block. Use a proper `NODE_ENV` check or a config-driven interval.

---

### P2 — `fs.appendFileSync` Raw Error Logging

**File:** [`src/modules/dashboard/dashboard.controller.js`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-backend/src/modules/dashboard/dashboard.controller.js)

```js
require('fs').appendFileSync('error.log', err.stack + '\\n');
```

**Problems:**
- Requiring `fs` inline at runtime is an anti-pattern
- `appendFileSync` is blocking — it will block the event loop on every error
- Writing to `error.log` with no rotation will fill the disk on a production server
- This is a debugging remnant, not a logging solution

**Required fix:** Remove this line entirely.

---

### P3 — Seed and Test Scripts Committed to Source

**Files:** `scripts/seed-analytics-test-data.sql`, `scripts/test-analytics.js`

These are test-only utilities. They should either:
- Live in a dedicated `/test` directory and be in `.gitignore` for local-only use
- Or be documented as one-time migration helpers, not permanent codebase additions

**Recommendation:** Move to `scripts/dev-only/` and add to `.gitignore`. At minimum, add a header comment making clear they must NEVER be run on production data.

---

## Category 2: Planning/Documentation Files in Source Code 🟠

### P4 — `plans/` Directory Committed to Repo

**Files:** `plans/analytics backend plan/*.md` (6 files, 1,400+ lines of documentation)

```
plans/analytics backend plan/00_developer_task_guide.md
plans/analytics backend plan/01_database_schema_updates.md
plans/analytics backend plan/02_overview_tab_api.md
...
plans/analytics backend plan/requirement documentation.md
```

**Problem:** Planning documentation should live in **Confluence, Notion, Google Docs, or a Wiki** — not in the source code repository. Having planning docs in the repo:
- Bloats the git history and clone size permanently
- Gets stale the moment code diverges from the plan
- Creates confusion about which document is authoritative

**Required fix:** Delete the `plans/` directory from the branch. Move content to Notion/Confluence. Add `plans/` to `.gitignore` to prevent this in future.

---

## Category 3: Inconsistent Code Style & Poor Patterns 🟠

### P5 — Inline `require()` Inside Function Bodies

**File:** `src/modules/user/user.controller.js`

```js
const { resolveActorContextForRequest } = require("../../core/middlewares/actor-context.middleware");
const { logAudit } = require("../../core/infrastructure/audit.service");
```

Both of these `require()` calls are inside a function body (`getUserProfile`). Node.js caches modules, so this doesn't cause performance issues per se, but it:
- Is inconsistent with the rest of the codebase which uses top-level `require()`
- Makes it impossible to see dependencies at a glance
- Breaks linting rules in most ESLint configs

**Required fix:** Move all `require()` calls to the top of the file.

---

### P6 — Manual Query String Construction Bypassing Axios

**File:** [`src/services/api/user.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/services/api/user.ts)

```ts
// Bad — manual string building
const params = sourcePostId ? `?sourcePostId=${encodeURIComponent(sourcePostId)}` : '';
const response = await api.get(`/users/${id}${params}`);

// Good — use Axios params option (consistent with rest of codebase)
const response = await api.get(`/users/${id}`, { 
  params: sourcePostId ? { sourcePostId } : undefined 
});
```

**Required fix:** Use Axios's `params` option. This is how every other API call in the project works.

---

### P7 — Duplicate `buildAnalyticsParams` Filter Entries

**File:** [`src/services/api/analytics.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/services/api/analytics.ts)

```ts
const map: Record<string, string> = {
  Today: "7days",           // Bug: "Today" maps to 7days, not today
  "Last 7 days": "7days",
  "Last 7 Days": "7days",   // Duplicate with different casing
  "Last 30 days": "30days",
  "Last 30 Days": "30days", // Duplicate with different casing
  "All time": "all_time",
  "All Time": "all_time",   // Duplicate with different casing
};
```

**Problems:**
- 3 pairs of duplicate entries (different casing) — indicates the UI filter labels aren't standardized
- "Today" maps to `"7days"` — this is almost certainly a bug; today should map to a `today` or `1day` filter
- This will silently show wrong data to users who select "Today"

**Required fix:** Standardize UI filter label casing across all components. Create a single enum/const for filter values. Fix the `Today → "7days"` mapping to a proper `today` backend parameter.

---

### P8 — `schema.sql` Used as Migration File

**File:** `schema.sql`

```sql
-- Added for Analytics tracking (source post attribution)
ALTER TABLE organization_followers ADD COLUMN IF NOT EXISTS source_post_id ...
ALTER TABLE organization_user_follows ADD COLUMN IF NOT EXISTS source_post_id ...
ALTER TABLE organization_org_follows ADD COLUMN IF NOT EXISTS source_post_id ...
```

**Problem:** `schema.sql` is the canonical schema definition file — it should represent the **complete schema from scratch**. Adding `ALTER TABLE` statements to it conflates migrations with schema definitions. If someone runs `schema.sql` fresh, it will fail because the tables already exist with those columns.

**Industry standard:** All schema changes should go in timestamped migration files (like `migrations/analytics_schema.sql` that was also added). The `schema.sql` file should be regenerated from the actual current DB state using `pg_dump --schema-only`.

**Required fix:** Remove the 4 lines from `schema.sql`. They already exist in `migrations/analytics_schema.sql`. Ensure teams know to run migrations, not schema.sql.

---

### P9 — `console.log` Statements Left in Production Code

**File:** `src/workers/analytics.cron.js`

```js
console.log(`[AnalyticsCronWorker] Aggregating Profile Analytics for ${dateStr}`);
console.log(`[AnalyticsCronWorker] Aggregating Post Analytics for ${dateStr}`);
console.log("[AnalyticsCronWorker] Aggregations completed successfully.");
console.error("[AnalyticsCronWorker] Error processing aggregations:", err);
```

While some `console.log` for worker status is acceptable, there are 10+ `console.log` statements across the analytics files. The project should use a structured logger (the existing logger in the codebase, if one exists, or introduce `pino`/`winston`). Log messages should be structured JSON in production, not plain strings.

**Recommendation:** Replace with the project's existing logging mechanism. If none exists, this branch is a good opportunity to introduce one.

---

## Category 4: Architectural Issues 🟡

### P10 — `global.viewSafetyMap` Is a Memory Leak

**File:** `src/modules/dashboard/dashboard.service.js`

```js
if (!global.viewSafetyMap) {
  global.viewSafetyMap = new Map();
  setInterval(() => {
    global.viewSafetyMap.clear();
  }, 3600000); // clear every hour
}
```

**Problems:**
- Using `global` for application state is an anti-pattern in Node.js
- The map grows unbounded for up to an hour — on a busy server with many unique user+profile combinations, this Map can hold tens of thousands of entries in memory
- In a multi-instance / clustered deployment (PM2 cluster mode, Kubernetes), each instance has its own `global` — so the safety check doesn't work across instances anyway (Redis already handles the distributed case)
- The `setInterval` inside a service function that can be called multiple times will create multiple intervals if the file is somehow re-required (unlikely but possible)

**Recommended fix:** Remove the `global.viewSafetyMap` entirely since Redis already handles distributed deduplication. Only keep the in-memory map as a LRU cache with a size limit, not a global `Map`.

---

### P11 — `actorContext` Resolution Duplicated in Two Places

**File:** `src/modules/user/user.controller.js`

After the refactor, `resolveActorContextForRequest` is called once inside `getUserProfile`. But the old code also had a separate `resolveActorContextForRequest` call inside the audit logging block. The new code resolved this partially but the logic is still inlined inside the controller instead of being handled by middleware — the `resolveActorContext` middleware already exists and is used in other routes.

**Recommended fix:** Add `resolveActorContext` middleware to the `GET /users/:id` route definition. Then access `req.actor` inside the controller without calling the resolver manually.

---

### P12 — `useProfile` Query Key Includes `sourcePostId` (Breaks Caching)

**File:** [`src/features/publicProfile/hooks/usePublicProfile.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/features/publicProfile/hooks/usePublicProfile.ts)

```ts
// Bad: sourcePostId changes cache identity
queryKey: ["profile", userId, sourcePostId],

// Good: attribution doesn't change the data returned
queryKey: ["profile", userId],
```

This was covered in Doc 2 (B3) as a functionality break, but it's also a poor engineering decision. The API response for `/users/:id?sourcePostId=xyz` is identical to `/users/:id` — the `sourcePostId` only affects a server-side side-effect (tracking). Including it in the cache key creates unnecessary cache misses and redundant network requests.

---

## Summary Table

| ID | File | Category | Severity | Action |
|---|---|---|---|---|
| P1 | `server.js` | Testing code in prod | 🔴 Critical | Remove duplicate setInterval |
| P2 | `dashboard.controller.js` | Testing code in prod | 🔴 Critical | Remove `fs.appendFileSync` |
| P3 | `scripts/*.sql`, `scripts/*.js` | Testing artifacts | 🟠 Medium | Move to dev-only, gitignore |
| P4 | `plans/*.md` | Docs in source | 🟠 Medium | Delete from repo |
| P5 | `user.controller.js` | Code style | 🟡 Low | Move `require()` to top |
| P6 | `services/api/user.ts` | Code style | 🟡 Low | Use Axios params option |
| P7 | `services/api/analytics.ts` | Logic bug + style | 🟠 Medium | Fix duplicate map keys + Today mapping |
| P8 | `schema.sql` | Architecture | 🟠 Medium | Remove ALTER statements |
| P9 | `analytics.cron.js` + others | Code style | 🟡 Low | Replace with structured logger |
| P10 | `dashboard.service.js` | Architecture | 🟠 Medium | Replace `global.viewSafetyMap` |
| P11 | `user.controller.js` | Architecture | 🟡 Low | Use existing middleware instead |
| P12 | `usePublicProfile.ts` | Architecture | 🟠 Medium | Remove `sourcePostId` from query key |
