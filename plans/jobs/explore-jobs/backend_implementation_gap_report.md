# Backend Implementation Gap Report (Explore Jobs Filters)

This report compares the current `cocpit-backend` implementation against the approved specifications for the **Explore Jobs** feature filtering system. It provides a clear roadmap for the engineering team to align the backend APIs with frontend requirements.

---

## 1. Query Builder & Parameters (`jobQueryBuilder.js`)

| Gap Discovered | Current State | Target State | Classification | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Search Parameter** | Only accepts `title` and checks `j.title ILIKE %title%`. | Accept `q` or `search` and check `(j.title ILIKE %q% OR j.company_name ILIKE %q%)`. Exclude description for performance. | **Must implement before integration** | Query Logic |
| **Date Posted Enumerations** | Hardcoded to `"Past 24 hours"`, `"Past week"`, `"Past month"`. | Add support for frontend string values: `"today"`, `"last 7 days"`, `"last 30 days"`. | **Must implement before integration** | Query Logic |

## 2. API Routes & Controllers (`job.routes.js`, `job.controller.js`)

| Gap Discovered | Current State | Target State | Classification | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Pagination Mapping** | Relies on `cursor` as an ISO timestamp (`created_at < $cursor`). | Frontend sends integer cursors. The backend API is fine, but this requires an adjustment on the frontend API client to extract the timestamp. | **Must implement before integration** | Frontend Client / API Usage |
| **Salary Range Parsing** | Expects numeric `minSalary` and `maxSalary` queries. | Frontend uses a single string (`"$50k - $100k"`). This requires an adjustment in the frontend API client. | **Must implement before integration** | Frontend Client / API Usage |

---

## 3. Implementation Roadmap & Strategy

### Phase 1: API Parameter Alignment
*Goal: Ensure the backend correctly parses and executes the complex filter combinations sent by the UI.*
1.  **Search Expansion:** Update `buildJobFilters` to accept `search`/`q` and expand the SQL condition to include `company_name`.
2.  **Date Normalization:** Update `buildJobFilters` to map `"today"` to 1 day ago, `"last 7 days"` to 7 days ago, etc.

### Phase 2: Frontend API Integration
*Goal: Replace dummy data services with actual REST calls.*
1.  **Frontend Service Refactor:** Modify `jobs.service.ts` to transform UI state into `JobSearchParams` matching the backend contract.
2.  **Pagination Strategy:** Update `useJobs` or the API client to utilize `job.createdAt` as the cursor for subsequent fetches.
