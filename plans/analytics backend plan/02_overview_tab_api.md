# Overview Tab API Plan

**Target Component:** `src/features/analytics/components/profile-analytics/OverviewTab.tsx`

## API Contract

**Endpoint:** `GET /users/me/analytics/overview`
**Query Parameters:**
- `filter`: Time range filter preset (e.g., `last_7_days`, `last_30_days`, `all_time`, `custom`). Default `last_30_days`.
- `startDate`: Used when filter is `custom`. ISO 8601 Date.
- `endDate`: Used when filter is `custom`. ISO 8601 Date.

### Response Payload Schema
```json
{
  "status": "success",
  "data": {
    "keyMetrics": {
      "profileViews": { "value": 1284, "trend": "+12%", "isPositive": true },
      "searchAppearances": { "value": 156, "trend": "+24%", "isPositive": true },
      "connectionRequests": { "value": 34, "trend": "-2%", "isPositive": false },
      "followerGrowth": { "value": 123, "trend": "+24%", "isPositive": true },
      "opportunityViews": { "value": 42, "trend": "Stable", "isPositive": null },
      "resumeViews": { "value": 1890, "trend": "Stable", "isPositive": null },
      "resumeDownloads": { "value": 342, "trend": "+24%", "isPositive": true }
    },
    "chart": {
      "labels": ["2026-08-01", "2026-08-02", "...", "2026-08-30"],
      "datasets": [
        {
          "label": "Profile Views",
          "data": [12, 19, 3, 5, 2, 3]
        }
      ],
      "startDate": "01 August 2026",
      "endDate": "30 August 2026",
      "tip": "Your activity peaked after Thursday's post."
    },
    "profileStrength": {
      "score": 92,
      "missingFields": ["project", "education"],
      "message": "Add 'project' & 'education' to hit 100%"
    },
    "insights": [
      "Profile visibility increased 12%",
      "Recruiter interest increased 24%",
      "Your articles generated the most profile visits"
    ]
  }
}
```

## Business Logic & Implementation Flow

### 1. Time Range Calculation
- **Preset filters**: Resolve `start` and `end` dates from the `filter` param:
  - `last_7_days`: `[NOW() - 7 days, NOW()]`
  - `last_30_days`: `[NOW() - 30 days, NOW()]`
  - `all_time`: `[account_created_at, NOW()]`
  - `custom`: Use `startDate` and `endDate` directly. Validate that `startDate <= endDate`.
- **`previous_period`**: Mirror-window of the same duration immediately before `start`. Used for trend calculation.
- **Trend Formula**: `((current - previous) / previous) * 100`. Round to 1 decimal place. If previous is 0 and current > 0, trend is `"+100%"`. If both are 0, trend is `"Stable"`.

### 2. Key Metrics Computation (SQL Logic)
- **Profile Views**: Sum of `profile_views` from `profile_analytics_daily` table for `current_period`. 
- **Search Appearances**: Sum of `search_appearances` from `profile_analytics_daily`.
- **Connection Requests**: `SELECT COUNT(1) FROM connection_requests WHERE receiver_id = :userId AND created_at BETWEEN :start AND :end`.
  > **Counting Rule**: Include ALL requests regardless of final status — `Accepted`, `Rejected`, and `Withdrawn` all count toward the historical total for that period. Do NOT filter by status, and do NOT retroactively adjust counts when status changes.
- **Follower Growth**: `SELECT COUNT(1) FROM followers WHERE following_id = :userId AND created_at BETWEEN :start AND :end`.
  > **Counting Rule**: Count the **Follow action only**. Follow and Connect are separate actions and must be tracked as separate metrics. Do NOT conflate with connection requests, even if the same two users both follow and connect with each other.
- **Opportunity Views**: `SELECT COUNT(1) FROM profile_views WHERE profile_owner_id = :userId AND view_context = 'recruiting' AND view_date BETWEEN :start AND :end`.
  > **Counting Rule**: Count only views that originate from a **qualifying hiring/recruiting context** (e.g. a recruiter viewing the profile via an applications list). Views from search or any other non-hiring surface are **not counted**, even if the viewer is an organization account. The filter must be on the `view_context` (or equivalent referrer/surface column), not on the viewer's account type.
- **Resume Views**: `SELECT COUNT(1) FROM resume_view_events rve JOIN user_resumes ur ON ur.resume_id = rve.resume_id WHERE ur.user_id = :userId AND rve.event_type = 'view' AND rve.created_at BETWEEN :start AND :end`.
- **Resume Downloads**: `SELECT COUNT(1) FROM resume_view_events rve JOIN user_resumes ur ON ur.resume_id = rve.resume_id WHERE ur.user_id = :userId AND rve.event_type = 'download' AND rve.created_at BETWEEN :start AND :end`.
  > **Counting Rule**: Downloads are counted **only on an explicit Download button click**. A resume view does not count as a download. Query must filter strictly on `event_type = 'download'`.

### 3. Chart Data Generation
- **For Ranges <= 31 Days:**
  - `SELECT date, SUM(profile_views) FROM profile_analytics_daily WHERE profile_owner_id = :userId AND date BETWEEN :start AND :end GROUP BY date ORDER BY date`.
  - Format `date` as "DD MMM" (e.g. `05 Aug`) for `labels` array. 
  - **CRITICAL:** You must generate a continuous array of all dates in the requested range and fill missing dates with `0`. This is required for the frontend chart tooltips to work seamlessly on hover for every day.
- **For Ranges > 31 Days (Week-wise Aggregation):**
  - Group dates into 7-day buckets starting from the `:start` date.
  - `SELECT DATE_TRUNC('week', date) as week_start, SUM(profile_views) FROM profile_analytics_daily WHERE profile_owner_id = :userId AND date BETWEEN :start AND :end GROUP BY week_start ORDER BY week_start`.
  - Format the label as `"DD MMM-DD MMM"` representing the start and end of that week bucket.
  - Map the aggregated sum into `datasets[0].data`. Fill missing weeks with `0`.

### 4. Chart Tip Logic
- Find the date with `MAX(profile_views)` in the `chart.data` array. Let's call this `PeakDate`.
- Query the user's `posts` (or other activities like comments/shares) to find if an activity occurred within `24 to 48 hours` prior to `PeakDate`. 
- If an activity exists, extract the Day of Week (e.g., Thursday) and generate the string: `"Your activity peaked after {DayOfWeek}'s post."` 
- If no recent activity is found, return `null` so the frontend can hide the tip UI.

### 5. Profile Strength Computation
- Call the existing `profile.calculator.js` passing the user's profile object.
- Extract `score`. Identify sections that received 0 points to populate `missingFields`. 
- Construct the `message` string dynamically based on `missingFields`.

### 6. Dynamic Insights Generator
- **Insight 1 (Visibility)**: Take the trend percentage of Profile Views. If positive, `"Profile visibility increased {trend}%"`.
- **Insight 2 (Recruiter)**: Take the trend percentage of Opportunity Views. If positive, `"Recruiter interest increased {trend}%"`.
- **Insight 3 (Content attribution)**: Query `post_impressions` joined with `posts` grouped by `post_type`. Find the post type with highest impressions. `"Your {post_type}s generated the most profile visits"`.
