# Analytics API — Developer Task Guide & Testing Checklist

**Branch**: `feature/analytics-api`  
**Mode**: One developer using an AI agent. The agent writes all code; the developer triggers commands and pastes outputs back.

---

## How This Works (Read First)

All development and testing is handled by the AI agent. Your role as the developer is limited to:

| You do | When |
|--------|------|
| Run the migration SQL | After Section 1 |
| Run the seed data SQL | Before Section 9 testing |
| Run the test script and paste output | After each section's coding is done |
| Paste any error output back to the agent | Whenever a step fails |

> **Rule**: Never manually write code for this feature. Give the agent the relevant plan file for each section and let it generate the code. If you find a bug, describe it to the agent — don't patch it manually.

---

## Module Path Convention (Critical)

This project uses a **module-based** folder structure, not a flat routes/controllers structure. All new analytics files must be created at:

```
src/modules/analytics/
  analytics.routes.js
  analytics.controller.js
  analytics.service.js
  analytics.helpers.js
  post.analytics.controller.js
  post.analytics.service.js
```

The agent must also register the analytics router in `src/app.js` (follow the pattern of existing module routers already registered there).

> **Known paths** (confirmed in codebase):
> - Profile Strength calculator → `src/modules/profile/profile.calculator.js`
> - Dashboard profile-view handler → `src/modules/dashboard/dashboard.controller.js` + `src/modules/dashboard/dashboard.service.js`
> - Worker pattern reference → `src/workers/feedWorker.js` or `accountCleanupWorker.js`

---

## Section 0 — Pre-Start: Agent Context Setup (~5 min)

Before the agent writes any code, give it the following files as context in a single message:

1. `plans/analytics backend plan/01_database_schema_updates.md`
2. `plans/analytics backend plan/02_overview_tab_api.md`
3. `plans/analytics backend plan/03_content_tab_api.md`
4. `plans/analytics backend plan/04_audience_tab_api.md`
5. `plans/analytics backend plan/05_opportunities_tab_api.md`
6. `plans/analytics backend plan/06_post_analytics_api.md`
7. `src/app.js` (so the agent knows how to register the router)
8. `src/modules/dashboard/dashboard.controller.js` (pattern reference)
9. `src/modules/dashboard/dashboard.service.js` (pattern reference)

The agent will derive all function signatures, response shapes, and SQL logic from these documents. No manual signature agreement is needed.

**Agreed function signatures** (for reference — agent generates implementations):

```js
// analytics.service.js
getOverviewData(userId, { filter, startDate, endDate })      → Promise<OverviewData>
getAudienceData(userId, { filter, startDate, endDate })      → Promise<AudienceData>
getOpportunitiesData(userId, { filter, startDate, endDate }) → Promise<OpportunitiesData>
getContentData(userId, { filter, startDate, endDate, sort }) → Promise<ContentData>

// post.analytics.service.js
getPostAnalyticsData(postId, userId, { filter, startDate, endDate }) → Promise<PostAnalyticsData>
```

---

## Section 1 — Database Setup

> **Agent generates**: `migrations/analytics_schema.sql`  
> **You run**: `psql -d <your_db> -f migrations/analytics_schema.sql`  
> **You do**: Paste the terminal output back to the agent to confirm success.

- [x] Agent writes migration: Create `resume_view_events` table with index
- [x] Agent writes migration: Create `profile_analytics_daily` table with unique constraint and index
- [x] Agent writes migration: Create `post_analytics_daily` table with unique constraint and index
- [x] Agent writes migration: Add `viewer_industry` column to `profile_views`
- [x] Agent writes migration: Add `viewer_company_org_id` column to `profile_views`
- [x] Agent writes migration: Add `source` column to `profile_views` (VARCHAR 50, values: `'search'`, `'direct'`, `'job_application_dashboard'`, etc.)
- [x] Agent writes migration: Add `source_post_id` column to `profile_views`
- [x] Agent writes migration: Add `view_date` computed/stored column to `post_impressions`
- [x] Agent writes migration: Add `view_count` and `download_count` columns to `user_resumes`
- [x] Agent writes migration: Add `source_post_id` column to `followers`
- [x] Agent checks: `search_appearances` table already exists in `schema.sql` — **do NOT recreate it**
- [x] **You run migration** and paste the output
- [x] Agent confirms all tables/columns created without errors

---

## Section 2 — Cron Job / Background Worker

> **Agent generates**: `src/workers/analytics.cron.js`  
> **Pattern reference**: Agent reads `src/workers/accountCleanupWorker.js` for structure.

- [x] Agent writes daily cron to aggregate `profile_analytics_daily` from:
  - `profile_views` → count per `profile_owner_id` per day → `profile_views`
  - `search_appearances` → count per `profile_owner_id` per day → `search_appearances`
  - `followers` → count per `following_id` per day → `new_followers`
  - `connection_requests` → count per `receiver_id` per day → `new_connections`
- [x] Agent writes daily cron to aggregate `post_analytics_daily` from:
  - `post_impressions` → `impressions` per `post_id` per day
  - engagement tables (`likes`, `comments`, `shares`, `saves`) per `post_id` per day
- [x] Agent uses `INSERT ... ON CONFLICT (profile_owner_id, profile_type, date) DO UPDATE` (upsert) to make cron idempotent
- [x] Agent writes a manual-trigger test function (e.g. `runCronNow()`) so you can invoke it once to verify table rows are populated

---

## Section 3 — Routes

> **Agent generates**: `src/modules/analytics/analytics.routes.js`  
> **Agent also updates**: `src/app.js` to register the new router.

- [x] `GET /users/me/analytics/overview` → `analyticsController.getOverview`
- [x] `GET /users/me/analytics/audience` → `analyticsController.getAudience`
- [x] `GET /users/me/analytics/opportunities` → `analyticsController.getOpportunities`
- [x] `GET /users/me/analytics/content` → `analyticsController.getContent`
- [x] `GET /posts/:postId/analytics` → `postAnalyticsController.getPostAnalytics`
- [x] Apply `authenticate` middleware to all routes
- [x] Add input validation middleware for `filter`, `startDate`, `endDate` params
- [x] Agent registers analytics router in `src/app.js`

---

## Section 4 — Overview Tab (`02_overview_tab_api.md`)

> **Agent generates**: controller function in `analytics.controller.js` + service function in `analytics.service.js`

### Controller (`analytics.controller.js`)
- [x] Implement `getOverview(req, res)`:
  - [x] Extract `filter`, `startDate`, `endDate` from query params
  - [x] Validate: if `filter = 'custom'`, both `startDate` and `endDate` must be present and `startDate <= endDate`
  - [x] Call `analyticsService.getOverviewData(userId, { filter, startDate, endDate })`
  - [x] Return `{ status: 'success', data: result }` with 200
  - [x] Handle errors with proper status codes (400 for bad params, 500 for service errors)

### Service (`analytics.service.js`)
- [x] Implement `getOverviewData(userId, { filter, startDate, endDate })`:
  - [x] Resolve `start`/`end`/`previousStart`/`previousEnd` from filter params (reusable helper in `analytics.helpers.js`)
  - [x] Query `profile_analytics_daily` for Profile Views (current + previous period → trend)
  - [x] Query `profile_analytics_daily` for Search Appearances (current + previous period → trend)
  - [x] Query `connection_requests` — COUNT all statuses (Accepted/Rejected/Withdrawn) within period
  - [x] Query `followers` — COUNT Follow action only (not connection) within period
  - [x] Query `profile_views` — COUNT where `source` is a qualifying recruiting surface for Opportunity Views
  - [x] Query `resume_view_events` — `event_type = 'view'` for Resume Views
  - [x] Query `resume_view_events` — `event_type = 'download'` ONLY for Resume Downloads
  - [x] Call `profile.calculator.js` (at `src/modules/profile/profile.calculator.js`) and extract `score`, `missingFields`, `message`
  - [x] Run Chart Data query:
    - [x] If range ≤ 31 days: day-wise, zero-fill missing dates
    - [x] If range > 31 days: week-wise buckets
  - [x] Run Chart Tip logic: find peak date → check for user post within 24–48h prior
  - [x] Generate 3 insights from metric trends
  - [x] Return full `OverviewData` object

### Testing Checklist (Agent writes test script; you run it)
- [ ] `GET /users/me/analytics/overview?filter=last_7_days` — 7 data points in chart
- [ ] `GET /users/me/analytics/overview?filter=last_30_days` — 30 data points in chart
- [ ] `GET /users/me/analytics/overview?filter=custom&startDate=2026-07-01&endDate=2026-08-13` — 44 days → weekly chart (7 buckets)
- [ ] `GET /users/me/analytics/overview?filter=custom&startDate=2026-08-01&endDate=2026-08-13` — 13 days → daily chart
- [ ] `GET /users/me/analytics/overview?filter=custom` (missing dates) — returns 400
- [ ] `GET /users/me/analytics/overview?filter=custom&startDate=2026-08-13&endDate=2026-08-01` — returns 400 (startDate > endDate)
- [ ] Verify `connectionRequests` count includes withdrawn requests
- [ ] Verify `opportunityViews` only counts `source = 'job_application_dashboard'` type views, NOT search views
- [ ] Verify `resumeDownloads` does NOT count view events
- [ ] Verify trend shows `"Stable"` when both periods are 0
- [ ] Verify chart tip returns `null` when no post precedes the peak

---

## Section 5 — Audience Tab (`04_audience_tab_api.md`)

> **Agent generates**: controller function in `analytics.controller.js` + service function in `analytics.service.js`

### Controller (`analytics.controller.js`)
- [x] Implement `getAudience(req, res)`:
  - [x] Extract and validate `filter`, `startDate`, `endDate`
  - [x] Call `analyticsService.getAudienceData(userId, { filter, startDate, endDate })`
  - [x] Return `{ status: 'success', data: result }`

### Service (`analytics.service.js`)
- [x] Implement `getAudienceData(userId, { filter, startDate, endDate })`:
  - [x] Build `viewers CTE`: UNION of unique `viewer_id`s from `profile_views` + `post_impressions`
  - [x] Compute Overall Reach, Profile Views, Engagement Rate (current + previous periods → trends)
  - [x] Query top **2** countries only (join viewers with `users.location_country`)
  - [x] Query top **4** cities (join viewers with `users.location_city`)
  - [x] Query audience industries with `COALESCE(NULLIF(u.industry,''), 'Other')` — never exclude unset viewers
  - [x] Generate 3 audience-pattern insights (no content-format insights — those belong to Content tab)
  - [x] Return full `AudienceData` object

### Testing Checklist
- [ ] Countries array has a **maximum of 2** entries
- [ ] Cities array has a **maximum of 4** entries
- [ ] Viewers with no industry set appear under `"Other"` bucket — NOT excluded
- [ ] Insight 2 is a location/demographic insight, NOT a content format comparison
- [ ] All 3 filter presets return data
- [ ] Custom range works correctly

---

## Section 6 — Opportunities Tab (`05_opportunities_tab_api.md`)

> **Agent generates**: controller function in `analytics.controller.js` + service function in `analytics.service.js`

### Controller
- [x] Implement `getOpportunities(req, res)`:
  - [x] Extract and validate `filter`, `startDate`, `endDate`
  - [x] Call `analyticsService.getOpportunitiesData(userId, { filter, startDate, endDate })`
  - [x] Return `{ status: 'success', data: result }`

### Service
- [x] Implement `getOpportunitiesData(userId, { filter, startDate, endDate })`:
  - [x] Query Opportunity Views (`profile_views` where `source` is recruiting surface) (Current vs Prev trend)
  - [x] Query Resume View rate vs Download rate (`resume_view_events`) (Current vs Prev trend)
  - [x] Query Top Viewers:
    - [x] Join `profile_views` to `users` and `organizations` via `viewer_id` or `viewer_company_org_id`
    - [x] Filter out anonymous/private viewers
    - [x] Return `name`, `industry`, `profilePicture`, `url` (or ID to construct URL)
  - [x] Generate 2 insights focusing on Resume performance and Recruiting interest.
  - [x] Return full `OpportunitiesData` object
  - [x] Query organization industries: from `viewer_company_org_id` join with org profiles
    - [x] Apply `"Other"` bucket for orgs with no industry set
  - [x] Generate insights
  - [x] Return full `OpportunitiesData` object

### Testing Checklist
- [ ] Regular individual user profile views do NOT appear in opportunity activity
- [ ] An org must have viewed > 1 time to qualify as a repeat visitor
- [ ] Top organizations list: each row has org name, visit count, job title OR `"No active roles"`
- [ ] No `"Company"` label appears anywhere in the response — only `"Organization"`
- [ ] Org with no industry set appears under `"Other"` in org industries

---

## Section 7 — Content Tab (`03_content_tab_api.md`)

> **Agent generates**: controller function in `analytics.controller.js` + service function in `analytics.service.js`

> **Resolved inconsistency**: Two plan files had conflicting values. The following are the canonical values to use:
> - Top posts limit: **5** (not 10)
> - Sort param name: `sort` (not `sortBy`)
> - Sort values: `top_performing | most_viewed | most_liked | most_shared` (not `engagement | views | likes | shares`)

### Controller
- [x] Implement `getContent(req, res)`:
  - [x] Extract and validate `filter`, `startDate`, `endDate`
  - [x] Accept optional `sort` param: `top_performing` | `most_viewed` | `most_liked` | `most_shared`. Default: `top_performing`
  - [x] Call `analyticsService.getContentData(userId, { filter, startDate, endDate, sort })`
  - [x] Return `{ status: 'success', data: result }`

### Service
- [x] Implement `getContentData(userId, { filter, startDate, endDate, sort })`:
  - [x] Query content format performance: aggregate views by post type (Article, Media, Poll, Text)
  - [x] Query top posts: rank by view count DESC, **return top 5 only**
  - [x] Apply sort param to change ranking column
  - [ ] Use `analytics.helpers.js` number formatter (`12400 → "12.4k"`) for all numeric values
  - [ ] Return full `ContentData` object

### Testing Checklist
- [ ] Top-performing posts list returns **maximum 5** posts
- [ ] Default sort is by `top_performing` (engagement score) DESC
- [ ] All 4 sort options (`top_performing`, `most_viewed`, `most_liked`, `most_shared`) return different orderings
- [ ] Content format breakdown covers Articles, Media, Polls, Text
- [ ] Date filter applies correctly to post list

---

## Section 8 — Post Analytics (`06_post_analytics_api.md`)

> **Agent generates**: `post.analytics.controller.js` + `post.analytics.service.js`

### Controller (`post.analytics.controller.js`)
- [x] Implement `getPostAnalytics(req, res)`:
  - [x] Extract `postId` from route params, `filter`/`startDate`/`endDate` from query
  - [x] Verify the post belongs to the authenticated user — return 403 if not
  - [x] Call `postAnalyticsService.getPostAnalyticsData(postId, userId, { filter, startDate, endDate })`
  - [x] Return `{ status: 'success', data: result }`

### Service (`post.analytics.service.js`)
- [x] Implement `getPostAnalyticsData(postId, userId, { filter, startDate, endDate })`:
  - [x] Fetch post details (title, type, publishedAt, contentSnippet, mediaUrl)
  - [x] Query `post_analytics_daily` for content performance: sum views, likes, comments, shares, saves
  - [x] Calculate Engagement Rate = `((likes + comments + shares + saves) / impressions) * 100`
  - [x] Format large numbers: `12400 → "12.4k"` (use shared helper from `analytics.helpers.js`)
  - [x] Build total reach chart: daily impressions from `post_analytics_daily` with zero-fill
  - [x] Direct Impact — Profile Visits: `profile_views WHERE source_post_id = :postId`
  - [x] Direct Impact — New Followers: `followers WHERE source_post_id = :postId`
  - [x] Direct Impact — Organization Views: `post_impressions WHERE post_id = :postId AND viewer_org_id IS NOT NULL`
  - [x] Calculate `vsAvg` trend for each direct impact metric (vs. average of user's other posts)
  - [x] Build audience demographics: top **4** cities, **4** countries, **4** industries from `post_impressions` viewers
  - [x] Return full `PostAnalyticsData` object

### Testing Checklist
- [ ] Returns 403 if `postId` belongs to a different user
- [ ] Engagement rate calculation: `((likes+comments+shares+saves) / impressions) * 100`, rounded
- [ ] `"12400"` renders as `"12.4k"` in `contentPerformance`
- [ ] Organization Views counts ONLY impressions with `viewer_org_id IS NOT NULL`
- [ ] `vsAvg` is correctly compared against all other posts by the same user, not just this post
- [ ] Total reach chart: one data point per day in the selected range, missing days zero-filled

---

## Section 9 — Dashboard Handler Updates

> **Agent reads**: `src/modules/dashboard/dashboard.controller.js` + `src/modules/dashboard/dashboard.service.js`  
> **Agent patches**: the profile-view write path to include the new columns.

- [x] Agent updates `dashboard.service.js`: when a profile view is recorded, also write `viewer_industry`, `source`, `source_post_id`, `viewer_company_org_id` to `profile_views`
- [x] Agent updates dashboard follow endpoint (e.g. `POST /users/:id/follow`) to accept and store `source_post_id` in `followers` table
- [x] Agent verifies the existing `search_appearances` insert logic writes correctly — do NOT create a new table

---

## Section 10 — Final Integration Tests

> **Agent generates**: `scripts/test-analytics.js` — a runnable Node.js script that covers every test case below using real HTTP calls with a test auth token.  
> **Agent also generates**: `scripts/seed-analytics-test-data.sql` — inserts controlled test users with known activity data so test assertions are predictable.  
> **You run**: `node scripts/seed-analytics-test-data.sql` then `node scripts/test-analytics.js`. Paste all output back to the agent.

- [ ] Verify all responses match the JSON schema defined in the plan files exactly (field names, nesting)
- [ ] Load test: simulate 30-day range query for a user with 10k profile views — response < 200ms (should be fast due to `profile_analytics_daily`)
  - Agent writes a seed script that inserts 10k `profile_analytics_daily` rows for a test user, then times the API response
