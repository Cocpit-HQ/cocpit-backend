# Feature Context: Explore Jobs & Advanced Filtering

**Problem Statement:**
The "Explore Jobs" tab in the frontend requires robust, multi-faceted filtering capabilities (by job type, experience, date posted, salary, work mode, industry, and text search) along with cursor-based pagination. The current API backend filtering logic supported some of these but used mismatched parameter names and enumerations compared to the frontend UI mockups.

**Business Goals:**
- Empower users to quickly find relevant jobs using comprehensive filters.
- Ensure the API is fully compatible with the frontend UI without modifying the established user-facing designs.
- Maintain high performance for text searches.

**Requirements:**
- Map complex UI string values (like "today", "last 7 days") directly within the query builder to keep the frontend payload clean.
- Implement a `search` / `q` text search that checks both `title` and `company_name` but intentionally excludes `description` to prevent slow full-table scans.
- Provide cursor-based pagination utilizing `created_at` timestamps for seamless infinite scrolling.

**Dependencies:**
- `jobQueryBuilder.js` modification for parameter ingestion.
- Frontend `jobs.service.ts` migration from mock data to Axios API.
