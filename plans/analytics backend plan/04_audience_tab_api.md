# Audience Tab API Plan

**Target Component:** `src/features/analytics/components/profile-analytics/AudienceTab.tsx`

## API Contract

**Endpoint:** `GET /users/me/analytics/audience`
**Query Parameters:**
- `filter`: Time range filter preset (`last_7_days`, `last_30_days`, `all_time`, `custom`). Default `last_30_days`.
- `startDate`: Required when `filter=custom`. ISO 8601 Date (e.g. `2026-07-01`).
- `endDate`: Required when `filter=custom`. ISO 8601 Date (e.g. `2026-08-13`).

### Response Payload Schema
```json
{
  "status": "success",
  "data": {
    "topMetrics": {
      "overallReach": { "value": "14,208", "trend": "+24%", "isPositive": true },
      "profileViews": { "value": "3,450", "trend": "+5.2%", "isPositive": true },
      "engagementRate": { "value": "4.8%", "trend": "-0.7%", "isPositive": false }
    },
    "audienceLocation": {
      "countries": [
        { "name": "India", "value": 77 },
        { "name": "UAE", "value": 18 }
      ],
      "cities": [
        { "name": "Mumbai", "value": 45 },
        { "name": "Bengaluru", "value": 22 },
        { "name": "Dubai", "value": 18 },
        { "name": "Delhi", "value": 10 }
      ]
    },
    "audienceIndustries": [
      { "name": "Software development", "value": 45 },
      { "name": "Fintech & banking", "value": 22 },
      { "name": "UX/UI design agencies", "value": 18 },
      { "name": "Other", "value": 15 }
    ],
    "insights": [
      "Your profile is most popular among technology professionals in Bengaluru",
      "Majority of your audience is based in India",
      "Your engagement increased by 5.2% this period"
    ]
  }
}
```

> **Note on `audienceLocation`**: The frontend renders Countries and Cities as two tabs of a single togglable UI element. The API must return both lists in a single `audienceLocation` object so the frontend can toggle between them without a second network call. Countries are capped at **top 2**; Cities are capped at **top 4**.

## Business Logic & Implementation Flow

### 1. Time Range Calculation
- **Preset filters**: Resolve `start` and `end` dates from the `filter` param:
  - `last_7_days`: `[NOW() - 7 days, NOW()]`
  - `last_30_days`: `[NOW() - 30 days, NOW()]`
  - `all_time`: `[account_created_at, NOW()]`
  - `custom`: Use `startDate` and `endDate` directly. Validate that `startDate <= endDate`.
- **`previous_period`**: Mirror-window of the same duration immediately before `start`. Used for trend calculation.
- **Trend Formula**: `((current - previous) / previous) * 100`. Round to 1 decimal place. If previous is 0 and current > 0, trend is `"+100%"`. If both are 0, trend is `"Stable"`.

### 2. Top Metrics Computation

- **Overall Reach**: Count of distinct `viewer_id`s from both `profile_views` and `post_impressions` (UNION, deduplicated) for `current_period`. Compute the same for `previous_period` to derive trend.
- **Profile Views**: Sum of `profile_views` from `profile_analytics_daily` for `current_period` vs `previous_period`.
- **Engagement Rate**:
  - Aggregate `likes + comments + shares + saves` from `post_analytics_daily` for `current_period`.
  - Formula: `(Total Engagements / Total Impressions) * 100`. Round to 1 decimal place.
  - Compute for both periods to derive trend.

### 3. Audience Location Computation

Build a CTE of all unique viewers (profile + post) for the period:
```sql
WITH viewers AS (
  SELECT viewer_id FROM profile_views WHERE profile_owner_id = :userId AND view_date BETWEEN :start AND :end
  UNION
  SELECT viewer_id FROM post_impressions pi JOIN posts p ON p.post_id = pi.post_id
  WHERE p.user_id = :userId AND pi.created_at BETWEEN :start AND :end
)
```

- **Countries** — Return **top 2 only**:
  ```sql
  SELECT u.location_country AS name, COUNT(1) AS cnt
  FROM viewers v JOIN users u ON u.user_id = v.viewer_id
  WHERE u.location_country IS NOT NULL
  GROUP BY u.location_country ORDER BY cnt DESC LIMIT 2
  ```
  - `value` = `ROUND((cnt / total_viewers) * 100, 1)`

- **Cities** — Return **top 4 only**:
  ```sql
  SELECT u.location_city AS name, COUNT(1) AS cnt
  FROM viewers v JOIN users u ON u.user_id = v.viewer_id
  WHERE u.location_city IS NOT NULL
  GROUP BY u.location_city ORDER BY cnt DESC LIMIT 4
  ```
  - `value` = `ROUND((cnt / total_viewers) * 100, 1)`

### 4. Audience Industries Computation

- Source: The `industry` field on each viewer's user profile.
- **`Other` bucket**: Viewers where `industry IS NULL` or `industry = ''` must be **grouped together under the label `"Other"`**, not excluded. This is a hard product requirement.
- Query:
  ```sql
  SELECT
    COALESCE(NULLIF(u.industry, ''), 'Other') AS name,
    COUNT(1) AS cnt
  FROM viewers v JOIN users u ON u.user_id = v.viewer_id
  GROUP BY name ORDER BY cnt DESC LIMIT 5
  ```
  - `value` = `ROUND((cnt / total_viewers) * 100, 1)`
  - If `Other` appears, it should always be surfaced (do not drop it to keep "clean" top-N — it carries meaningful signal).

### 5. Dynamic Insights Generator

Insights must summarize **audience patterns** — they must not duplicate raw metric numbers already visible on the page, and must not include content-format comparisons (those belong to the Content tab).

- **Insight 1 (Demographics)**: Pick the top city and top industry from the computed lists.
  - Template: `"Your profile is most popular among {top_industry} professionals in {top_city}"`
- **Insight 2 (Location concentration)**: Pick the top country and its share percentage.
  - Template: `"Majority of your audience is based in {top_country}"` or `"{top_country} accounts for {pct}% of your audience"` if the percentage is high (>50%).
- **Insight 3 (Engagement trend)**: Use the trend value of `engagementRate`.
  - Template: `"Your engagement {increased/decreased} by {|trend|}% this period"`. If trend is `"Stable"`, output `"Your engagement rate remained stable this period"`.
