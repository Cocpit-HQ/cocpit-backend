# AI Integration: Implemented API Flow

This document outlines the final implemented architecture for the AI Job Description Auto-Generation feature, specifically tailored for the Android, iOS, and Frontend teams.

## 1. The "One-Shot" Job Creation Flow

Originally, the architecture called for a complex multi-step flow where the frontend had to create a blank draft, fetch AI text, and then save it via an `aiAction`. 

**Final Decision:** To radically simplify frontend complexity and improve the user experience, the AI generation was integrated directly into the `POST /api/jobs` (Create Job) endpoint.

### How it works for Mobile/Frontend:
You only need to make **one** API call.

**Request:**
`POST /api/jobs`
```json
{
  "title": "LLM Ops",
  "org_id": "optional-org-id"
}
```

**Response (201 Created):**
The backend intercepts this request, securely connects to Google Gemini, streams the job title, applies strict HR constraints, and returns a fully populated Draft job.

```json
{
  "message": "Draft created successfully",
  "job": {
    "job_id": "8b529205-df36-4128-8077-a58de2e8ad0a",
    "title": "LLM Ops",
    "company_name": "Sakshi Patilll",
    "status": "DRAFT",
    "description": "We are seeking a talented LLM Ops engineer to join Sakshi Patilll...\n\n### Responsibilities\n- Design AI pipelines...\n\n### Requirements\n- Python, PyTorch...",
    "created_at": "2026-06-23T12:01:42.336Z"
  }
}
```

**Key Benefit:** The `description` field will automatically contain a beautifully formatted, Markdown-compatible Job Description specifically tailored to the requested `title` and dynamically injected with the user's `company_name`. 

## 2. Dynamic Company Name Injection

If a user is posting on behalf of an Organization, the AI dynamically inserts the Organization's name into the text.
If a user is a freelancer or independent recruiter (no `org_id`), the backend gracefully injects the phrase **"our team"** instead of their personal name, ensuring the generated text always reads professionally.

## 3. Two-Tier Caching System

The backend employs a sophisticated caching mechanism to ensure API responses are lightning-fast for identical job roles.

1. **Redis (Tier 1):** In-memory cache for ultra-fast, sub-millisecond retrieval.
2. **PostgreSQL (Tier 2):** Persistent storage table (`ai_jd_cache`) ensuring we don't lose cached generations on server restart.

**What Mobile Teams should expect:**
- If a user types a completely unique job title, the request will take **~4 to 6 seconds** while the backend queries the Google Gemini API.
- If a user (or any other user globally) types a job title that has been generated before, the request will take **< 50 milliseconds** due to a 100% cache hit. 
- *Mobile teams should ensure their loading spinners accommodate a potential 6-second wait.*

## 4. Error Handling & Fallbacks (Fail-Safe Design)

The `POST /api/jobs` API is designed to be **fail-safe**. 

If the Google Gemini API goes down, times out, or the backend is unable to connect to Redis, the `createJob` request **WILL NOT FAIL**. It will silently catch the AI error and successfully return a `201 Created` draft, but the `description` field will be empty (`""` or `null`).

**Mobile/Frontend Requirement:** 
You must gracefully handle an empty `description` field in the response. If the AI text is missing, simply present the user with an empty text editor so they can manually write the description. Do not crash the app or show an error modal for the job creation itself.

## 5. The Explicit "Re-Generate" API

If a user clears their Job Description text editor or explicitly clicks a "Re-Generate with AI" button on the draft edit screen, you can trigger AI generation for an *existing* draft without creating a new job.

**Request:**
`POST /api/v1/jobs/:id/generate`
```json
{
  "role": "Software Engineer"
}
```

**Response:**
This endpoint returns the raw generated Job Description JSON directly, which you can format into markdown or use to populate your UI form fields.
