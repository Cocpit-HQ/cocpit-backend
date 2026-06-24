# Implementation Plan: My Listings API Separation

## 1. Security Enforcement on Org Scope
Modify `getOrganizationJobs` in `organization.jobs.controller.js`:
- For `scope = 'internal'`, query the database to verify if `req.user.sub` exists as an active member in `organization_members` for the given `orgId`.
- Return `403 Forbidden` if validation fails.

## 2. API Refactor
Refactor `getMyJobs` in `job.controller.js`:
- Remove the organization actor check (`req.actor`).
- Restrict `getMyJobs` to strictly query jobs where `recruiter_id = userId` AND `posted_as_company = FALSE` (or `org_id IS NULL`).
