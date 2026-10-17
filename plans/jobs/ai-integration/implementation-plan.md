# Implementation Plan: Phase 3 AI Integration & Automated Testing

## 1. AI Action Controller (`job.controller.js`)
- Implement `aiAction` method to handle `POST /jobs/:id/ai/actions`.
- Receives payload: `{ action: string, updates: object }`.
- Applies updates to the draft safely.
- Inserts `job_versions` record with `provenance = 'AI'`.

## 2. API Registration (`job.routes.js`)
- Bind the new route `POST /:id/ai/actions` with ownership checks.

## 3. Swagger Updates (`openapi.yaml`)
- Document the new endpoint and payload.

## 4. Testing (`src/modules/jobs/__tests__/job.lifecycle.test.js`)
- Write Jest suites that mock the DB `pool`.
- Test Business Validation (salary constraint on submit).
- Test State Machine Rules (preventing illegal transitions).
- Test AI Action provenance tracking.
