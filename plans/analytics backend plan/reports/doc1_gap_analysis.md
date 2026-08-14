# 📊 Document 1: Gap Analysis — Analytics Branch vs Develop

> **Scope:** `feature/analyticsBackend` (backend) + `feature/analyticsFrontend` (frontend) vs `origin/develop`
> **Total changes:** ~3,608 lines backend · ~2,457 lines frontend · 35 files each
> **Last verified:** 2026-08-14 (post-merge of `analytics_schema.sql` + `schema.sql` changes)

---

## 1. What Was Added (New Capability)

### Backend — New Files

| File | Purpose |
|---|---|
| `migrations/analytics_schema.sql` | DB migration: 3 new tables, 11 new columns on existing tables |
| `src/modules/analytics/analytics.service.js` | Core analytics logic: Overview, Audience, Content, Opportunities data |
| `src/modules/analytics/analytics.controller.js` | REST controllers for analytics endpoints |
| `src/modules/analytics/analytics.routes.js` | Route definitions for `/users/me/analytics/*` + `/analytics/resume-events` |
| `src/modules/analytics/analytics.helpers.js` | Shared helpers: `resolveDateRange`, `calculateTrend`, `formatNumber` |
| `src/modules/analytics/post.analytics.service.js` | Per-post analytics: impressions, engagement rate, reach chart |
| `src/modules/analytics/post.analytics.controller.js` | REST controller for `/posts/:postId/analytics` |
| `src/workers/analytics.cron.js` | Daily aggregation cron: aggregates raw events → `profile_analytics_daily` + `post_analytics_daily` |
| `scripts/run-migration.js` | Helper to run the migration SQL |
| `scripts/seed-analytics-test-data.sql` | Test seed data for analytics tables |
| `scripts/test-analytics.js` | Test script to validate analytics endpoints |
| `plans/` (5 docs + overview) | Planning documentation |

### Backend — Modified Files

| File | Change Summary |
|---|---|
| `src/app.js` | Registers new analytics routes |
| `src/server.js` | Schedules analytics cron with `NODE_ENV`-aware interval (1hr prod / 10s dev) |
| `src/modules/dashboard/dashboard.service.js` | `addProfileView()` extended with `options` (source, sourcePostId, viewerCompanyOrgId, actor) |
| `src/modules/dashboard/dashboard.controller.js` | `recordProfileView` reads source attribution from request; adds raw `fs.appendFileSync` error logging |
| `src/modules/dashboard/dashboard.routes.js` | Adds `resolveActorContext` middleware to `/dashboard/view` route |
| `src/modules/user/user.controller.js` | `getUserProfile` refactored to resolve actor context once upfront; share_count query now counts distinctly from both tables |
| `src/modules/social/social.controller.js` | Follow user/org endpoints now accept optional `sourcePostId` in body |
| `src/modules/organization/organization.controller.js` | `getOrganization` passes source attribution to `addProfileView` |
| `src/modules/organization/organization.posts.controller.js` | share_count query unified across both share tables |
| `src/modules/feed/candidates/sources/socialGraphSource.js` | share_count SQL fixed to count from both posts and shares tables |
| `src/modules/feed/candidates/sources/trendingSource.js` | Same share_count fix + ordering query updated |
| `src/modules/feed/exploration/explorationPool.js` | Same share_count fix in two places |
| `src/modules/share/share.service.js` | Exports new `trackShare` function |
| `src/core/middlewares/actor-context.middleware.js` | Minor export addition |
| `schema.sql` | Appends 3 `ALTER TABLE` statements for org follow tables |

### Frontend — New Files

| File | Purpose |
|---|---|
| `src/services/api/analytics.ts` | All analytics API calls: overview, audience, content, opportunities, post analytics, resume events |

### Frontend — Major Modified Files

| File | Change Summary |
|---|---|
| `src/features/analytics/types/profile-analytics.types.ts` | Complete type system rewrite: old mock-oriented types → real API response types |
| `src/features/analytics/data/mock-data.ts` | Mock data stripped down; most hardcoded data removed |
| `src/features/profile-analytics/ProfileAnalyticsHome.tsx` | Now fetches real data from API; filter/date state management |
| `src/features/profile-analytics/OverviewTab.tsx` | Wired to `getAnalyticsOverview` API |
| `src/features/profile-analytics/AudienceTab.tsx` | Wired to `getAnalyticsAudience` API |
| `src/features/profile-analytics/ContentTab.tsx` | Wired to `getAnalyticsContent` API |
| `src/features/profile-analytics/OpportunitiesTab.tsx` | Wired to `getAnalyticsOpportunities` API |
| `src/features/profile-analytics/PostAnalytics.tsx` | Wired to `getPostAnalytics` API |
| `src/context/SocialContext.tsx` | `followUser` now accepts optional `sourcePostId` |
| `src/features/publicProfile/PublicProfilePage.tsx` | Reads `sourcePostId` from URL params; passes to profile view, follow, and user fetch |
| `src/features/publicProfile/hooks/usePublicProfile.ts` | `useProfile` hook accepts `sourcePostId`; query key includes it |
| `src/features/profile/commonProfileComponents/LivingResume.tsx` | Tracks resume view/download events via analytics API; new public download handler |
| `src/features/profile/commonProfileComponents/ProfileHeader.tsx` | Tracks profile resume download via analytics API |
| `src/features/profile/pages/ProfilePage.tsx` | Wraps `LivingResume` in a named anchor div; passes `userId` |
| `src/features/feed/components/parts/PostHeader.tsx` | Author profile links now append `?sourcePostId=<id>`; follow actions pass sourcePostId |
| `src/features/feed/components/parts/PostSharedContent.tsx` | Shared post "View Profile" links append `?sourcePostId=<id>` |
| `src/features/companyProfile/services/companyprofile.service.ts` | `followOrganization` accepts optional `sourcePostId` |
| `src/features/companyProfile/components/view/CompanyProfileHeader.tsx` | Follow button passes sourcePostId |
| `src/hooks/usePostImpression.ts` | Impression threshold lowered 60% → 20% |
| `src/hooks/useSearchHistory.ts` | Storage key now scoped by activeProfile context |
| `src/services/api/dashboard.ts` | `recordProfileView` accepts optional `sourcePostId` |
| `src/services/api/user.ts` | `getUserById` accepts optional `sourcePostId`; manually appends query string |

---

## 2. What Is Missing (Gaps)

> ⚠️ **Corrections vs. previous version of this document:**
> - **G2 is RESOLVED** — `server.js` has a `NODE_ENV` guard: 1hr in prod, 10s in dev.
> - **G3 is RESOLVED** — `/analytics/resume-events` IS registered in `analytics.routes.js` line 39.
> - **G10 was WRONG** — "Today" is not in `ANALYTICS_FILTER_LABELS`. The real bug is a filter key mismatch (see updated G10 below).
> - **G12 is RESOLVED** — `job_offers` table confirmed at `schema.sql:1437` with `user_id` + `created_at` columns. Analytics query is valid.

### Critical Gaps

| # | Gap | Risk | Details |
|---|---|---|---|
| G1 | **No error boundaries on analytics tabs** | 🔴 High | If any analytics API call fails, the whole tab crashes with no fallback UI. No `try/catch` + skeleton or error state in OverviewTab, AudienceTab, ContentTab, OpportunitiesTab |
| G2 | ~~Analytics cron 10s in production~~ | ✅ Fixed | `server.js` uses `NODE_ENV === 'production' ? 60 * 60 * 1000 : 10 * 1000`. No longer a risk. |
| G3 | ~~resume-events route not wired~~ | ✅ Fixed | `router.post('/analytics/resume-events', requireAuth, ...)` is registered in `analytics.routes.js`. |
| G10 | **Filter key mismatch frontend↔backend** | 🔴 High | `buildAnalyticsParams` in `analytics.ts` maps "Last 7 Days" → `"7days"` and "Last 30 Days" → `"30days"`, but `resolveDateRange` in `analytics.helpers.js` only recognizes `'last_7_days'` and `'last_30_days'`. All filter queries fall through to `default: 'last_30_days'` — meaning "Last 7 Days" silently returns 30-day data |
| G12 | ~~`job_offers` table queried but doesn't exist~~ | ✅ **RESOLVED** | Table confirmed at `schema.sql:1437` with correct `user_id` + `created_at` columns. Analytics query is valid. |

### Medium / Low Gaps

| # | Gap | Risk | Details |
|---|---|---|---|
| G4 | **`post_impressions.view_date` column not backfilled** | 🟠 Medium | Migration adds `view_date` column but no `UPDATE` to fill historical rows. All pre-migration impressions have `NULL` dates and are invisible in date-filtered analytics |
| G5 | **Analytics not implemented for Organization profiles** | 🟠 Medium | Routes and service only handle `users/me/analytics/*`. No org-admin equivalent, despite `profile_analytics_daily` having a `profile_type` column that supports `'organization'` |
| G6 | **No loading/skeleton states in analytics frontend** | 🟠 Medium | While data is fetching from real APIs, there are no loading spinners or skeleton placeholders — UI shows blank until data arrives |
| G7 | **`useSearchHistory` storage key change breaks existing history** | 🟠 Medium | Changing from `search_history_v2_${userId}` to `search_history_v2_${userId}_${contextId}` means all existing users lose saved search history on first deploy |
| G11 | **`fs.appendFileSync` blocking log write in production** | 🟠 Medium | `dashboard.controller.js` added `fs.appendFileSync('error.log', ...)`. This is a synchronous, blocking file write on every error path — degrades performance under load and creates unmanaged log files on the server |
| G8 | **`source_post_id` FK not validated server-side** | 🟡 Low | `sourcePostId` from URL/body is passed directly to DB without checking if the post exists. An invalid UUID causes a silent DB constraint error |
| G9 | **No analytics data for new users (0-day users)** | 🟡 Low | `resolveDateRange` uses `user.created_at` as the floor for `all_time`, but `profile_analytics_daily` has no rows for brand-new users. No empty-state UI is shown |

### Missing Documentation

| Gap | Detail |
|---|---|
| No `CHANGELOG.md` / `MIGRATION_GUIDE.md` for team | Developers picking up this branch don't know what DB migrations need to run |
| No `.env` additions documented | If analytics requires new env vars, they aren't listed anywhere |
| `plans/` directory committed to source code | Planning docs should live in Notion/Confluence, not in the repo itself |

---

## 3. Summary Table

| # | Gap | Risk | Status |
|---|---|---|---|
| G1 | No error boundaries on analytics tabs | 🔴 High | 🔴 Open |
| G2 | Cron 10s in production | ~~🔴 Critical~~ | ✅ Fixed |
| G3 | resume-events route not wired | ~~🔴 High~~ | ✅ Fixed |
| G4 | `view_date` not backfilled | 🟠 Medium | 🔴 Open |
| G5 | No org analytics | 🟠 Medium | 🔴 Open |
| G6 | No loading/skeleton states | 🟠 Medium | 🔴 Open |
| G7 | Search history key migration breaks data | 🟠 Medium | 🔴 Open |
| G8 | `source_post_id` not validated | 🟡 Low | 🔴 Open |
| G9 | Empty state for 0-data users | 🟡 Low | 🔴 Open |
| G10 | Filter key mismatch frontend↔backend | 🔴 High | 🔴 Open |
| G11 | `fs.appendFileSync` blocking log write | 🟠 Medium | 🔴 Open |
| G12 | `job_offers` table queried but doesn't exist | ~~🔴 High~~ | ✅ Resolved |
