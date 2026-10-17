# Content Tab API Plan

**Target Component:** `src/features/analytics/components/profile-analytics/ContentTab.tsx`

## API Contract

**Endpoint:** `GET /users/me/analytics/content`
**Query Parameters:**
- `range`: Time range filter (`today`, `7d`, `30d`, `all_time`). Default `30d`.
- `sortBy`: Sorting option for top posts (`engagement`, `views`, `likes`, `shares`). Default `engagement`.

### Response Payload Schema
```json
{
  "status": "success",
  "data": {
    "formatPerformance": {
      "articlesViews": { "value": "12.4k", "icon": "solar:document-add-linear" },
      "mediaViews": { "value": "8.7k", "icon": "stash:image" },
      "pollsViews": { "value": "5k", "icon": "fluent:poll-16-regular" },
      "textViews": { "value": "1.8k", "icon": "lucide:type" }
    },
    "topPosts": [
      {
        "id": "post-uuid",
        "title": "Redesigning the SaaS Onboarding Experience",
        "type": "Article post",
        "date": "oct 15 2026",
        "views": "12.4k",
        "likes": "1.2k",
        "shares": "342",
        "imgSrc": "https://images.unsplash.com/...",
        "icon": null
      }
    ]
  }
}
```

## Business Logic & Implementation Flow

### 1. Data Retrieval: Format Performance
- Query the `post_analytics_daily` table joined with the `posts` table for the requesting `user_id`.
- **SQL Equivalent**: 
  ```sql
  SELECT p.post_type, SUM(pad.impressions) as total_views 
  FROM posts p 
  LEFT JOIN post_analytics_daily pad ON p.post_id = pad.post_id 
  WHERE p.user_id = :userId AND pad.date BETWEEN :start AND :end 
  GROUP BY p.post_type
  ```
- **Mapping**: Map `post_type = 'ARTICLE'` to `articlesViews`, `'MEDIA'` to `mediaViews`, `'POLL'` to `pollsViews`, and `'TEXT'` to `textViews`.
- **Formatting**: Convert raw numbers to abbreviated strings (e.g., `12400` -> `"12.4k"`) using a backend formatter utility.

### 2. Data Retrieval: Top Performing Posts
- Retrieve the user's top posts aggregated over the time range.
- **SQL Equivalent**:
  ```sql
  SELECT 
    p.post_id, p.title, p.post_type, p.created_at, p.media_urls,
    SUM(pad.impressions) as views,
    SUM(pad.likes) as likes,
    SUM(pad.shares) as shares,
    (SUM(pad.likes) + SUM(pad.shares) + SUM(pad.comments)) as engagement_score
  FROM posts p
  LEFT JOIN post_analytics_daily pad ON p.post_id = pad.post_id
  WHERE p.user_id = :userId AND pad.date BETWEEN :start AND :end
  GROUP BY p.post_id
  ```
- **Sorting Logic (`sortBy`)**:
  - `engagement`: `ORDER BY engagement_score DESC`
  - `views`: `ORDER BY views DESC`
  - `likes`: `ORDER BY likes DESC`
  - `shares`: `ORDER BY shares DESC`
- **Limit**: Append `LIMIT 10` to keep the payload lightweight.

### 3. Data Transformation & Formatting
- **Dates**: Convert `created_at` to the required format `"MMM DD YYYY"` (e.g., "oct 15 2026").
- **Metrics**: Abbreviate `views`, `likes`, and `shares` integers to strings (e.g. `1.2k`).
- **Images/Icons**: 
  - If `p.media_urls` is not empty, set `imgSrc` to the first URL and `icon` to `null`.
  - If empty, set `imgSrc` to `null` and map `p.post_type` to a fallback icon string (e.g. `'POLL'` -> `"fluent:poll-16-regular"`).
