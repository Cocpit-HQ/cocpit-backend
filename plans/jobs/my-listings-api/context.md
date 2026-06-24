# Context: My Listings API Separation

This plan refactors and secures the backend API endpoints supporting the **My Listings** dashboard page. It addresses permission leaks and overlaps between candidate-facing search endpoints and recruiter-facing management endpoints.

## Objectives
- Secure `/organizations/:orgId/jobs?scope=internal` to prevent anonymous access to internal job drafts.
- Clarify data boundaries so `/jobs/my` strictly serves individual recruiter listings, and `/organizations/:orgId/jobs` serves company/business listings.
