# 🔴 Document 2: Functionality Breaks — What This Branch Broke

> Features that were **working in `develop`** but are now **broken or degraded** in the analytics branches.

---

## SEVERITY: CRITICAL 🔴

### B1 — Analytics Cron Running TWICE Every 10 Seconds (server.js)

**File:** [`src/server.js`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-backend/src/server.js)

**What happened:** The analytics cron is wired up **twice** in the same file. First as `processAnalyticsAggregations`, then again as `runCronNow` — both with 10-second intervals. This means the aggregation query runs every 10 seconds, twice in parallel.

```diff
// First registration (correct)
+ processAnalyticsAggregations(); // run immediately on startup
+ setInterval(() => {
+   processAnalyticsAggregations();
+ }, 10 * 1000);

// Second registration (DUPLICATE — bug)
+ const { runCronNow } = require('./workers/analytics.cron');
+ setInterval(() => {
+   runCronNow().catch(err => console.error("Test Cron Error:", err));
+ }, 10 * 1000);
```

**Impact:**
- In production this will run a heavy multi-table `INSERT...SELECT` query **12 times per minute**
- Both invocations compete for the same DB rows with `ON CONFLICT DO UPDATE` — causing thrashing
- Will cause serious DB CPU spikes and degraded performance for all users
- The 10-second interval is a **testing leftover** that was never changed before commit

**Fix required:** Remove the duplicate `setInterval` entirely. Change interval to `60 * 60 * 1000` (1 hour) for prod, protected by `NODE_ENV`:
```js
if (process.env.NODE_ENV !== 'production') {
  setInterval(() => processAnalyticsAggregations(), 10 * 1000);
} else {
  setInterval(() => processAnalyticsAggregations(), 60 * 60 * 1000);
}
```

---

### B2 — `error.log` Being Written to Filesystem in Production (dashboard.controller.js)

**File:** [`src/modules/dashboard/dashboard.controller.js`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-backend/src/modules/dashboard/dashboard.controller.js)

**What happened:** A raw `fs.appendFileSync` call was added in the catch block of `recordProfileView`.

```diff
+ require('fs').appendFileSync('error.log', err.stack + '\\n');
```

**Impact:**
- This writes to a local file at the process working directory every time `recordProfileView` throws
- On high-traffic servers (cloud containers, serverless, read-only filesystems), this **will crash the server** with an `EROFS` or `EACCES` error
- Even on regular servers, this log file will grow unbounded with no rotation
- This is the kind of debug statement accidentally left in from local testing

**Fix:** Remove immediately. Errors are already handled by `console.error`. Use a proper logger (Winston/Pino) if persistence is needed.

---

### B3 — Query Cache Miss: `useProfile` Query Key Changed

**File:** [`src/features/publicProfile/hooks/usePublicProfile.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/features/publicProfile/hooks/usePublicProfile.ts)

**What happened:** The TanStack Query key for `useProfile` changed from `["profile", userId]` to `["profile", userId, sourcePostId]`.

**Impact:**
- Every time a user visits a profile from a post (where `sourcePostId` is in the URL), a **new cache entry** is created
- The same profile visited from different posts creates different cache entries
- All existing cached profile data is effectively **invalidated** on every navigation
- This causes unnecessary re-fetches and worse LCP/UX performance on profile pages

**Fix:** Keep the query key as `["profile", userId]`. Pass `sourcePostId` only as a query parameter to the API, not as part of the cache key. Attribution data should not affect caching identity.

---

### B4 — `useSearchHistory` Breaks Existing Users' Search History

**File:** [`src/hooks/useSearchHistory.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/hooks/useSearchHistory.ts)

**What happened:** The `localStorage` key changed from `search_history_v2_${userId}` to `search_history_v2_${userId}_${contextId}`.

**Impact:**
- Every existing user on production will lose their entire search history the moment they update to this version
- This is a **silent data loss** — no migration, no warning, no fallback to old key
- For users who switch between personal/company profiles, they now get separate histories (this may be intentional, but the data loss is not)

**Fix:** On first load, check if old key has data and migrate it to the new key format:
```ts
const oldKey = `search_history_v2_${userId}`;
const newKey = `search_history_v2_${userId}_${contextId}`;
if (!localStorage.getItem(newKey) && localStorage.getItem(oldKey)) {
  localStorage.setItem(newKey, localStorage.getItem(oldKey)!);
  localStorage.removeItem(oldKey);
}
```

---

## SEVERITY: HIGH 🟠

### B5 — Impression Threshold Silently Lowered from 60% to 20%

**File:** [`src/hooks/usePostImpression.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/hooks/usePostImpression.ts)

**What happened:**
```diff
- export const usePostImpression = (postId: string, threshold = 0.6) => {
+ export const usePostImpression = (postId: string, threshold = 0.2) => {
```

**Impact:**
- A post now registers an "impression" when only **20% of it is visible**, down from 60%
- This **inflates impression counts by 3-4x** — a post at the top of the feed that someone barely scrolled past now counts as viewed
- Existing analytics data (if any) and future data will be **incomparable** — benchmarks are broken
- Users and internal teams who were used to the 60% threshold will see misleading spikes in impression metrics

**Fix:** Revert to `0.6` or discuss the change explicitly. If 0.2 is intentional for analytics accuracy, document it clearly and reset historical baseline.

---

### B6 — `getUserById` Bypasses Axios Params Serialization

**File:** [`src/services/api/user.ts`](file:///c:/Users/Swaroop/Desktop/COCPIT/cocpit-frontend/src/services/api/user.ts)

**What happened:**
```diff
- const response = await api.get(`/users/${id}`);
+ const params = sourcePostId ? `?sourcePostId=${encodeURIComponent(sourcePostId)}` : '';
+ const response = await api.get(`/users/${id}${params}`);
```

**Impact:**
- Manually building query strings bypasses Axios's built-in params serialization
- If `sourcePostId` is a UUID with special characters (unlikely but possible), it could cause encoding issues
- Inconsistent with every other API call in the codebase which uses `{ params: { ... } }`
- The Axios interceptors that handle auth/error may not apply correctly when the URL is manually modified

**Fix:**
```ts
const response = await api.get(`/users/${id}`, { params: sourcePostId ? { sourcePostId } : {} });
```

---

### B7 — Share Count Double-Counting Risk

**Files:** `socialGraphSource.js`, `trendingSource.js`, `explorationPool.js`, `user.controller.js`, `organization.posts.controller.js`

**What happened:** The original `share_count` query counted rows from `posts` table (reposts). It was changed to count from **both** `posts` (reposts) and `shares` table (external shares).

**Impact:**
- The new query uses `COUNT(DISTINCT sender_id)` on the `shares` table and `COUNT(DISTINCT author_id)` on `posts`. While this avoids per-user duplicates, it means **one person sharing the same post twice** (once as repost, once as message) counts as 2 shares
- The feed ranking algorithm uses `share_count` with a 1.5× weight multiplier. Inflating share counts by even 10-20% can **significantly alter feed ranking** for all users — popular posts will dominate even more
- This was changed without a separate PR or discussion, bundled silently into the analytics branch

---

### B8 — `source_post_id` FK in `profile_views` Can Silently Fail

**File:** `migrations/analytics_schema.sql` + `dashboard.service.js`

**What happened:** `source_post_id UUID REFERENCES posts(post_id)` was added to `profile_views`. The value is passed from client URL params.

**Impact:**
- If a post is deleted between when the URL is shared and when someone clicks it, the FK constraint will **cause the INSERT to fail silently** (the FK violation exception is caught and swallowed)
- Profile view won't be recorded at all — legitimate views lost
- No `ON DELETE SET NULL` constraint is set on this FK in the migration

**Fix:** Add `ON DELETE SET NULL` to the FK:
```sql
source_post_id UUID REFERENCES posts(post_id) ON DELETE SET NULL
```

---

## SEVERITY: MEDIUM 🟡

### B9 — `actorContext` Resolved Inside `getUserProfile` But Only Used Conditionally

**File:** `src/modules/user/user.controller.js`

The actor context is now resolved at the top of `getUserProfile` for all non-self visits. Previously it was resolved lazily only when needed for audit logging. This adds a **DB/middleware round-trip** for every profile view by any user, even when the actor is a regular user (not an organization). Adds latency to all profile fetches.

---

### B10 — `organization_profile_views` Lacks Unique Constraint

**File:** `dashboard.service.js` (addProfileView for org context)

When an org views a profile, the code checks for a row in `organization_profile_views` within 24 hours and inserts if none found. But this check-then-insert is **not atomic** — under concurrent requests (e.g. the same org user opening a profile in two tabs), two rows can be inserted before either check completes.

**Fix:** Add a unique constraint to `organization_profile_views(organization_id, profile_owner_id, profile_type)` and use `ON CONFLICT DO NOTHING`.
