# Phase 4: Recruiter Read Path (Filtering + Sorting)

## Objective
Update the dashboard queries to filter using native PostgreSQL indexes (the frozen scalar fields) and sort by the combined AI/Backend match score.

## Implementation Steps
1. Modify `src/modules/jobs/applications/application.queries.js` (`getApplicantList`):
   - Accept `filters` object (`status`, `minExperience`, `location`, `skills`).
   - Build dynamic `WHERE` clauses for `frozen_experience_years`, `frozen_location`, `frozen_skills`, and `current_status`.
   - Add `analysis_type` to the `SELECT` output.
   - Set `ORDER BY aaa.match_score DESC NULLS LAST, ja.applied_at DESC`.
2. Modify `src/modules/jobs/applications/application.controller.js` (`getApplicantList`):
   - Parse `req.query` and pass `filters` to the query layer.
   - Return `analysisType` to the frontend.
3. Modify `src/modules/jobs/applications/application.controller.js` (`getAnalysis`):
   - Simplify the response: remove the 3 secondary DB queries calculating experience/qualification.
   - Just return the existing data from `application_ai_analyses`.

## Automation Testing Instructions
- Write `scratch/test_phase4.js` to mock HTTP GET requests to the `/applicants` endpoint with various filters (`minExperience=3`, `skills=React`).
- Ensure SQL queries execute correctly and filter accurately based on the frozen fields.
