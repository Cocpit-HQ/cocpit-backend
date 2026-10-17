# Recommended Jobs API Reference

This document describes the API endpoint to retrieve AI-recommended jobs for candidates on the Cocpit platform.

## Get Recommendations

Retrieves a curated list of jobs recommended for the user. Although the full recommendation engine calculations (matching candidate profiles and resumes with job specifications) are currently mocked, the API is fully wired and includes the necessary matching fields.

* **URL**: `/api/jobs/recommendations`
* **Method**: `GET`
* **Auth Required**: Optional (but highly recommended. If authenticated, the response matches the current user context, checking application and save status. Unauthenticated requests are allowed for general discovery but skip user-specific saved/applied state tracking.)

### Request Headers

| Header | Value | Description |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <accessToken>` | Optional. The JWT access token of the authenticated candidate. |
| `Content-Type` | `application/json` | Required. |

### Request Parameters

None.

---

### Response (200 OK)

Returns a JSON array containing the recommended jobs. Each job object contains standard job details along with the specific recommendation metadata.

#### Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `job_id` | `UUID` | Unique identifier for the job. |
| `recruiter_id` | `UUID` | ID of the recruiter who posted the job. |
| `title` | `String` | Job title. |
| `company_name` | `String` | Name of the company/organization. |
| `location` | `String` \| `null` | Job location. |
| `description` | `String` \| `null` | Job description (Markdown supported). |
| `job_type` | `String` \| `null` | Employment type (e.g., `"Full time"`, `"Part time"`). |
| `work_mode` | `String` \| `null` | Workplace model (e.g., `"Remote"`, `"Hybrid"`, `"Onsite"`). |
| `salary_min` | `Number` \| `null` | Minimum salary. |
| `salary_max` | `Number` \| `null` | Maximum salary. |
| `salary_currency` | `String` | Currency code (e.g., `"USD"`, `"INR"`). |
| `salary_period` | `String` | Salary payment frequency (e.g., `"YEARLY"`). |
| `salary_visibility` | `String` | Visibility level of salary (`"PUBLIC"` or `"PRIVATE"`). |
| `experience_min` | `Number` \| `null` | Minimum required experience in years. |
| `experience_max` | `Number` \| `null` | Maximum required experience in years. |
| `experience_label` | `String` \| `null` | Seniority level (e.g., `"Fresher"`, `"Senior"`). |
| `company_logo` | `String` \| `null` | Logo image URL for the company. |
| `company_slug` | `String` \| `null` | URL-friendly name slug for company. |
| `isSaved` | `Boolean` | Whether the current user has saved this job. |
| `hasApplied` | `Boolean` | Whether the current user has applied for this job. |
| `applicationStatus` | `String` \| `null` | Current status of application if applied. |
| `applicants` | `Number` | Total count of candidates who have applied for this job. |
| `is_recommended` | `Boolean` | Always `true` for jobs returned by this endpoint. |
| `recommended_badge` | `String` | Percentile match badge (e.g., `"Top 5%"`, `"Top 10%"`, `"Top 15%"`). |
| `response_rate` | `String` | Historical recruiter response rate (e.g., `"98%"`). |
| `avg_reply` | `String` | Average time recruiter takes to reply to applications (e.g., `"1 day"`). |
| `match_reason` | `String` | AI-generated reason explaining the recommendation. |
| `match_score` | `Number` | Percentage matching score calculated from the profile comparison (e.g., `95`). |

---

### Response Example

```json
[
  {
    "job_id": "057e7236-d5ba-4fd6-ab03-e6a2418ecf69",
    "recruiter_id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "title": "Senior UI UX Engineer",
    "company_name": "TechFlow",
    "location": "San Francisco, CA",
    "description": "We are seeking a talented UI/UX engineer to design and build stunning interfaces...",
    "work_mode": "Hybrid",
    "company_type": null,
    "experience_level": null,
    "match_score": 95,
    "is_active": true,
    "created_at": "2026-06-27T08:48:45.194Z",
    "is_offer": false,
    "job_type": "Full time",
    "about_company": null,
    "easy_apply": false,
    "actively_hiring": false,
    "industry": "",
    "salary_min": 160000,
    "salary_max": 210000,
    "org_id": null,
    "posted_as_company": false,
    "status": "ACTIVE",
    "expires_at": null,
    "salary_currency": "USD",
    "salary_period": "YEARLY",
    "salary_visibility": "PUBLIC",
    "experience_min": 5,
    "experience_max": 8,
    "experience_label": "Senior (5+ yrs)",
    "recruiter_name": "John Doe",
    "company_logo": "https://example.com/logo.png",
    "company_slug": "techflow",
    "isSaved": false,
    "hasApplied": false,
    "applicationStatus": null,
    "applicants": 4,
    "is_recommended": true,
    "recommended_badge": "Top 10%",
    "response_rate": "98%",
    "avg_reply": "1 day",
    "match_reason": "Matches your skills in React and Node.js"
  }
]
```

### Errors

* **401 Unauthorized**: Returned if the user is in a state where onboarding is incomplete or global onboarding constraints enforce authentication (under `/api` routes check).
* **500 Internal Server Error**: Database or server execution issues.
