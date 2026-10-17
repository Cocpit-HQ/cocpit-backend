# Implementation Plan: Explore Jobs API Alignment

## 1. Query Builder Mapping (`jobQueryBuilder.js`)
- **Text Search (`q` / `search`)**: Add support to parse a `q` or `search` query parameter. Combine it in a SQL condition: `(j.title ILIKE $n OR j.company_name ILIKE $n)`. Exclude `description` to avoid performance degradation prior to implementing full-text search (e.g., ElasticSearch / tsvector).
- **Date Filtering (`datePosted`)**: Enhance `datePosted` parsing to recognize frontend-native strings (`"today"`, `"last 7 days"`, `"last 30 days"`) alongside the legacy `"Past 24 hours"`, `"Past week"`, `"Past month"`.

## 2. API Contract & Frontend Integration (`jobs.service.ts` & `api/jobs.ts`)
- Remove `DUMMY_JOBS` local state and network latency simulators.
- Update `getAllJobs` in `api/jobs.ts` to accept `minSalary` and `maxSalary` parameters.
- Transform UI `salary_range` strings (e.g. "$50k - $100k") into numeric `minSalary`/`maxSalary` boundaries inside the UI adapter (`jobs.service.ts`).
- Handle the `location_type === 'country'` filter mapping directly to `workMode=Remote`.

## 3. Pagination Implementation
- **Cursor State**: The frontend previously maintained integer indexes as cursors.
- **Update**: Extract the `createdAt` ISO string from the final job in the fetched list array, and pass it as the `cursor` param in subsequent requests. The backend `getAllJobs` endpoint correctly processes timestamp-based cursors via `j.created_at < $cursor`.
