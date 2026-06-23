### 1. Login (`POST /api/auth/login`)
**Request:**
```json
{
  "email": "rupa@gmail.com",
  "password": "Rupa@123"
}
```
**Response:**
```json
{
  "accessToken": "<JWT_TOKEN>",
  "refreshToken": "<REFRESH_TOKEN>",
  "user": {
    "id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "email": "rupa@gmail.com",
    "full_name": "Anushri sharma",
    "avatar_url": "https://res.cloudinary.com/dst2rqu4h/image/upload/v1781585217/avatars/avatar-e8d559d4-d606-4dbe-86bc-c8fddb3caed3-1781585215515.jpg",
    "roles": [],
    "onboarding_complete": true,
    "account_name": "rupa"
  }
}
```
---

### 2. Fetch Job Role Suggestions (`GET /api/jobs/roles?q=Soft`)
**Response:**
```json
[
  {
    "role_name": "Software Engineer",
    "category": "Engineering"
  }
]
```
---

### 3. Initialize Draft (`POST /api/jobs`)
**Request:**
```json
{
  "title": "Software Engineer - Full Stack"
}
```
**Response:**
```json
{
  "message": "Draft created successfully",
  "job": {
    "job_id": "dc80b357-960e-4432-9d25-5fb197e88ec0",
    "recruiter_id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "title": "Software Engineer - Full Stack",
    "company_name": "Anushri sharma",
    "location": null,
    "description": null,
    "work_mode": null,
    "company_type": null,
    "experience_level": null,
    "match_score": null,
    "is_active": true,
    "created_at": "2026-06-23T05:38:35.870Z",
    "is_offer": false,
    "job_type": null,
    "about_company": null,
    "easy_apply": false,
    "actively_hiring": false,
    "industry": null,
    "salary_min": null,
    "salary_max": null,
    "org_id": null,
    "posted_as_company": false,
    "status": "DRAFT",
    "expires_at": null,
    "salary_currency": "USD",
    "salary_period": "YEARLY",
    "salary_visibility": "PUBLIC",
    "jd_text": null,
    "jd_raw_url": null,
    "experience_min": null,
    "experience_max": null,
    "experience_label": null
  }
}
```
---

### 4. Autosave / Patch Draft (`PATCH /api/jobs/dc80b357-960e-4432-9d25-5fb197e88ec0`)
**Request:**
```json
{
  "title": "Software Engineer - Full Stack",
  "location": "Remote (India)",
  "industry": "Technology",
  "experience_min": 2,
  "experience_max": 5,
  "job_type": "Full-time",
  "work_mode": "Remote",
  "salary_min": 1500000,
  "salary_max": 2500000,
  "description": "We are looking for a passionate Software Engineer to build robust scalable systems. You will be responsible for creating amazing features that scale to millions of users worldwide and help shape the future of our product line. Strong problem-solving skills and a team-first mindset are a must!"
}
```
**Response:**
```json
{
  "message": "Job updated",
  "job": {
    "job_id": "dc80b357-960e-4432-9d25-5fb197e88ec0",
    "recruiter_id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "title": "Software Engineer - Full Stack",
    "company_name": "Anushri sharma",
    "location": "Remote (India)",
    "description": "We are looking for a passionate Software Engineer to build robust scalable systems. You will be responsible for creating amazing features that scale to millions of users worldwide and help shape the future of our product line. Strong problem-solving skills and a team-first mindset are a must!",
    "work_mode": "Remote",
    "company_type": null,
    "experience_level": null,
    "match_score": null,
    "is_active": true,
    "created_at": "2026-06-23T05:38:35.870Z",
    "is_offer": false,
    "job_type": "Full-time",
    "about_company": null,
    "easy_apply": false,
    "actively_hiring": false,
    "industry": "Technology",
    "salary_min": 1500000,
    "salary_max": 2500000,
    "org_id": null,
    "posted_as_company": false,
    "status": "DRAFT",
    "expires_at": null,
    "salary_currency": "USD",
    "salary_period": "YEARLY",
    "salary_visibility": "PUBLIC",
    "jd_text": null,
    "jd_raw_url": null,
    "experience_min": 2,
    "experience_max": 5,
    "experience_label": null
  }
}
```
---

### 5. Publish Job (`POST /api/jobs/dc80b357-960e-4432-9d25-5fb197e88ec0/submit`)
**Request:**
```json
{
  "title": "Software Engineer - Full Stack",
  "location": "Remote (India)",
  "industry": "Technology",
  "experience_min": 2,
  "experience_max": 5,
  "job_type": "Full-time",
  "work_mode": "Remote",
  "salary_min": 1500000,
  "salary_max": 2500000,
  "description": "We are looking for a passionate Software Engineer to build robust scalable systems. You will be responsible for creating amazing features that scale to millions of users worldwide and help shape the future of our product line. Strong problem-solving skills and a team-first mindset are a must!"
}
```
**Response:**
```json
{
  "message": "Job submitted for review",
  "job": {
    "job_id": "dc80b357-960e-4432-9d25-5fb197e88ec0",
    "recruiter_id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "title": "Software Engineer - Full Stack",
    "company_name": "Anushri sharma",
    "location": "Remote (India)",
    "description": "We are looking for a passionate Software Engineer to build robust scalable systems. You will be responsible for creating amazing features that scale to millions of users worldwide and help shape the future of our product line. Strong problem-solving skills and a team-first mindset are a must!",
    "work_mode": "Remote",
    "company_type": null,
    "experience_level": null,
    "match_score": null,
    "is_active": true,
    "created_at": "2026-06-23T05:38:35.870Z",
    "is_offer": false,
    "job_type": "Full-time",
    "about_company": null,
    "easy_apply": false,
    "actively_hiring": false,
    "industry": "Technology",
    "salary_min": 1500000,
    "salary_max": 2500000,
    "org_id": null,
    "posted_as_company": false,
    "status": "ACTIVE",
    "expires_at": null,
    "salary_currency": "USD",
    "salary_period": "YEARLY",
    "salary_visibility": "PUBLIC",
    "jd_text": null,
    "jd_raw_url": null,
    "experience_min": 2,
    "experience_max": 5,
    "experience_label": null
  }
}
```
---

### 6. Verify on Explore API (`GET /api/jobs?limit=5`)
**Response:**
```json
{
  "summary": "Fetched 5 jobs.",
  "foundOurJob": true,
  "jobData": {
    "job_id": "dc80b357-960e-4432-9d25-5fb197e88ec0",
    "recruiter_id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "title": "Software Engineer - Full Stack",
    "company_name": "Anushri sharma",
    "location": "Remote (India)",
    "description": "We are looking for a passionate Software Engineer to build robust scalable systems. You will be responsible for creating amazing features that scale to millions of users worldwide and help shape the future of our product line. Strong problem-solving skills and a team-first mindset are a must!",
    "work_mode": "Remote",
    "company_type": null,
    "experience_level": null,
    "match_score": null,
    "is_active": true,
    "created_at": "2026-06-23T05:38:35.870Z",
    "is_offer": false,
    "job_type": "Full-time",
    "about_company": null,
    "easy_apply": false,
    "actively_hiring": false,
    "industry": "Technology",
    "salary_min": 1500000,
    "salary_max": 2500000,
    "org_id": null,
    "posted_as_company": false,
    "status": "ACTIVE",
    "expires_at": null,
    "salary_currency": "USD",
    "salary_period": "YEARLY",
    "salary_visibility": "PUBLIC",
    "jd_text": null,
    "jd_raw_url": null,
    "experience_min": 2,
    "experience_max": 5,
    "experience_label": null,
    "recruiter_name": "Anushri sharma",
    "company_logo": null,
    "company_slug": null,
    "isSaved": false,
    "hasApplied": false,
    "applicationStatus": null,
    "applicants": 0
  }
}
```
---
