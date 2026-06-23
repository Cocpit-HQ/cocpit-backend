# Testing Plan: Explore Jobs APIs

This document outlines the testing strategy for verifying the alignment of the backend API filters for the Explore Jobs feature.

## 1. Unit Tests (Backend `jobQueryBuilder.js`)

**Objective:** Verify the query builder logic constructs the correct SQL conditions and values array based on input parameters.

### 1.1 Text Search (`search` or `q`)
*   **Action:** Call `buildJobFilters({ search: 'engineer' })`.
*   **Expected:** Conditions array contains `(j.title ILIKE $1 OR j.company_name ILIKE $1)`. Values array contains `['%engineer%']`.
*   **Action:** Call `buildJobFilters({ title: 'developer' })` (Legacy support).
*   **Expected:** Conditions array contains `(j.title ILIKE $1 OR j.company_name ILIKE $1)`. Values array contains `['%developer%']`.

### 1.2 Date Posted Mapping
*   **Action:** Call `buildJobFilters({ datePosted: 'today' })`.
*   **Expected:** Conditions array contains `j.created_at >= $1`. Values array contains a Date object representing ~24 hours ago.
*   **Action:** Call `buildJobFilters({ datePosted: 'last 7 days' })`.
*   **Expected:** Conditions array contains `j.created_at >= $1`. Values array contains a Date object representing ~7 days ago.
*   **Action:** Call `buildJobFilters({ datePosted: 'Past month' })` (Legacy support).
*   **Expected:** Values array contains a Date object representing ~1 month ago.

## 2. Integration Tests (API Endpoints)

**Objective:** Verify the `GET /api/v1/jobs` endpoint returns the correct dataset when specific filters are applied.

### 2.1 Search by Company Name
*   **Setup:** Seed database with Job A (Title: 'Developer', Company: 'Acme Corp') and Job B (Title: 'Designer', Company: 'Globex').
*   **Action:** `GET /api/v1/jobs?search=Acme`
*   **Expected:** Returns Job A.

### 2.2 Cursor-based Pagination
*   **Setup:** Seed 10 jobs. Note the `created_at` timestamp of the 5th job.
*   **Action:** `GET /api/v1/jobs?limit=5&cursor=<timestamp_of_5th_job>`
*   **Expected:** Returns 5 jobs created *before* that timestamp.

## 3. End-to-End Tests (Frontend -> Backend)

**Objective:** Verify the frontend Explore UI correctly translates user interactions into valid API requests.

### 3.1 Salary Range Mapping
*   **Action:** In the UI, select salary range "$100k - $150k".
*   **Expected (Network Tab):** The outgoing request contains `&minSalary=100000&maxSalary=150000`.

### 3.2 Location Type Mapping
*   **Action:** In the UI, select location type "country".
*   **Expected (Network Tab):** The outgoing request contains `&workMode=Remote`.
