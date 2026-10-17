# Opportunities Tab API Plan

**Target Component:** `src/features/analytics/components/profile-analytics/OpportunitiesTab.tsx`
*(Note: As requested, Skill Gap Analysis / North Star / AI sections are excluded from this backend contract)*

## API Contract

**Endpoint:** `GET /users/me/analytics/opportunities`
**Query Parameters:**
- `range`: Time range filter (`today`, `7d`, `30d`, `all_time`). Default `30d`.

### Response Payload Schema
```json
{
  "status": "success",
  "data": {
    "topMetrics": {
      "opportunityActivity": {
        "value": "42",
        "trend": "+15%",
        "label": "recruiter views"
      },
      "repeatVisitors": {
        "percentage": "24%",
        "count": 10,
        "label": "recruiters returned to your profile multiple times."
      }
    },
    "topOrganizations": [
      {
        "name": "Driftline Agency",
        "industry": "SaaS",
        "visits": "12 visits",
        "role": "VP of marketing",
        "icon": "/images/analytics/organization1.png"
      },
      {
        "name": "Acme.in",
        "industry": "IT Solutions",
        "visits": "4 visits",
        "role": "VP of marketing",
        "icon": "/images/analytics/organization3.png"
      }
    ],
    "organizationIndustries": [
      { "name": "Software development", "value": 45 },
      { "name": "Fintech & banking", "value": 22 },
      { "name": "UX/UI design agencies", "value": 18 },
      { "name": "University", "value": 10 }
    ],
    "insights": [
      "Recruiters from SaaS companies showed the highest interest this month",
      "Product-design roles generated the most profile visits",
      "Recruiters revisited your profile 24% more often than last month"
    ]
  }
}
```

## Business Logic & Implementation Flow

### 1. Top Metrics Computation
- **Opportunity Activity (Recruiter Views)**:
  - This metric is a combination of two specific events:
    1. **Dashboard Profile Views:** When a recruiter or normal user who posted a job views an applicant's profile from the job application dashboard. Tracked via `profile_views` where `source = 'job_application_dashboard'`.
    2. **Offers Received:** When an organization or user sends a direct offer. Tracked via an `offers` table (or equivalent offer events table).
  - Query 1: Count `profile_views` where `profile_owner_id = :userId`, `source = 'job_application_dashboard'`, and `view_date` within `current_period`.
  - Query 2: Count offers where `receiver_id = :userId` and `created_at` within `current_period`.
  - **Total Value** = Query 1 count + Query 2 count.
  - Perform the exact same queries for `previous_period` to calculate the `% trend`.
- **Repeat Visitors**:
  - Out of the unique recruiters who viewed the profile in `current_period`, count how many had `COUNT(view_date) > 1`. This becomes the `count` (e.g. 10).
  - Calculate `percentage` = `(Repeat Recruiters / Total Unique Recruiters) * 100`.

### 2. Top Organizations (SQL Aggregation)
- Aggregate profile views by the viewer's organization ID (`viewer_company_org_id`), regardless of whether they are a recruiter or a normal user.
- **SQL Equivalent**:
  ```sql
  SELECT 
    org.name, org.industry, org.logo_url as icon,
    COUNT(1) as visits_count,
    u.headline as role -- Role of the most frequent viewer from this org, or a generic string
  FROM profile_views pv
  JOIN users u ON pv.viewer_id = u.user_id
  JOIN organizations org ON pv.viewer_company_org_id = org.org_id
  WHERE pv.profile_owner_id = :userId AND pv.view_date BETWEEN :start AND :end
  GROUP BY pv.viewer_company_org_id
  ORDER BY visits_count DESC
  LIMIT 4
  ```
- Format `visits_count` to append `" visits"`. 

### 3. Organization Industries
- Run a similar aggregation query grouping by `org.industry` instead of `org_id`.
- Calculate the percentage share of each industry against the total organization visits (where `viewer_company_org_id IS NOT NULL`).
- Limit to the top 4 industries to pass to the frontend array.

### 4. Dynamic Insights Generator
- **Insight 1 (Industry Interest)**: Pick the top industry from the `organizationIndustries` array. 
  - Template: `"Recruiters from {top_industry} companies showed the highest interest this month"`
- **Insight 2 (Role Interest)**: Based on the `role` field from the most frequent repeat visitors or search appearances (`search_appearances.query`).
  - Template: `"{top_role} roles generated the most profile visits"`
- **Insight 3 (Repeat Trend)**: Compare the `repeatVisitors.percentage` between the `current_period` and `previous_period`.
  - Template: `"Recruiters revisited your profile {trend}% {more/less} often than last period"`
