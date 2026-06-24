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
    "avatar_url": "https://res.cloudinary.com/doxkaqqt4/image/upload/v1782205851/avatars/avatar-e8d559d4-d606-4dbe-86bc-c8fddb3caed3-1782205848996.jpg",
    "roles": [],
    "onboarding_complete": true,
    "account_name": "rupa_rani"
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
    "job_id": "7e73167e-05fd-4f96-8673-70e60130bc2d",
    "recruiter_id": "e8d559d4-d606-4dbe-86bc-c8fddb3caed3",
    "title": "Software Engineer - Full Stack",
    "company_name": "Anushri sharma",
    "location": null,
    "description": "We are seeking a versatile Software Engineer to join our team and contribute to the development of our core web applications. You will work across the entire technical stack to build scalable, high-performance solutions that deliver exceptional user experiences.\n\n### Description\nAs a Full Stack Software Engineer at our team, you will play a pivotal role in designing, developing, and maintaining robust software applications that drive our business forward. You will collaborate closely with cross-functional teams, including product managers, designers, and other engineers, to translate complex requirements into elegant, functional code. The ideal candidate possesses a deep understanding of modern web technologies, a passion for clean architecture, and a commitment to continuous improvement. At our team, we foster an environment of innovation and mentorship, providing you with the opportunity to influence our technical roadmap and grow your professional expertise in a supportive and inclusive atmosphere. You will be responsible for the full software development lifecycle, from initial conceptualization and system design to deployment and post-launch monitoring. Your ability to bridge the gap between user-facing interface design and backend server-side logic will be critical to our success.\n\n### Responsibilities\n- Design and develop responsive, user-centric web applications using modern front-end and back-end frameworks.\n- Collaborate with product designers to implement intuitive user interfaces that meet accessibility and usability standards.\n- Build and maintain secure, scalable server-side APIs to support front-end functionality and data processing.\n- Conduct thorough code reviews to ensure high quality, maintainability, and adherence to established engineering standards.\n- Identify and resolve performance bottlenecks to optimize application speed and responsiveness across all platforms.\n- Participate in agile development ceremonies to plan, execute, and deliver high-impact software features on schedule.\n- Contribute to the continuous improvement of our deployment pipelines and infrastructure automation strategies.\n\n### Requirements\n- Proven experience building and maintaining production-grade web applications using modern programming languages and frameworks.\n- Strong proficiency in designing and consuming RESTful APIs or GraphQL services within distributed systems.\n- Comprehensive understanding of database management, including relational and non-relational database design and optimization strategies.\n- Demonstrated ability to work effectively within an agile team environment while maintaining clear and professional communication.\n- Deep knowledge of web security best practices to protect application data and ensure user privacy.\n\n### Preferred Skills\n- Experience with cloud-based infrastructure services such as AWS, Google Cloud, or Azure for scalable application hosting.\n- Prior involvement in contributing to open-source projects or maintaining personal technical documentation and portfolios.\n- Familiarity with containerization technologies like Docker and orchestration tools such as Kubernetes for streamlined deployment.\n\n### Benefits\n- Comprehensive health, dental, and vision insurance coverage\n- Flexible working hours and remote work options\n- Generous professional development and training budget\n- Collaborative and inclusive team-oriented workplace culture\n- Paid time off and company-sponsored wellness programs",
    "work_mode": null,
    "company_type": null,
    "experience_level": null,
    "match_score": null,
    "is_active": true,
    "created_at": "2026-06-24T06:41:38.719Z",
    "is_offer": false,
    "job_type": null,
    "about_company": null,
    "easy_apply": false,
    "actively_hiring": false,
    "industry": "",
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

### 4. Autosave / Patch Draft (`PATCH /api/jobs/7e73167e-05fd-4f96-8673-70e60130bc2d`)
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
    "job_id": "7e73167e-05fd-4f96-8673-70e60130bc2d",
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
    "created_at": "2026-06-24T06:41:38.719Z",
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

### 5. Publish Job (`POST /api/jobs/7e73167e-05fd-4f96-8673-70e60130bc2d/submit`)
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
    "job_id": "7e73167e-05fd-4f96-8673-70e60130bc2d",
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
    "created_at": "2026-06-24T06:41:38.719Z",
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
    "job_id": "7e73167e-05fd-4f96-8673-70e60130bc2d",
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
    "created_at": "2026-06-24T06:41:38.719Z",
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
