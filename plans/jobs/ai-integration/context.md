# Feature Context: Phase 3 AI Integration & Automated Testing

**Problem Statement:**
The upcoming Auto Description Generator (Timeline 2) will require an API to seamlessly apply AI-generated job content to drafts while keeping an audit trail of changes made by the AI vs. humans. Additionally, our new state machine logic lacks test coverage.

**Business Goals:**
- Standardize how external services (like the AI microservice) mutate jobs.
- Prevent regressions in our complex ATS state machine via test coverage.

**Requirements:**
- Build `POST /jobs/:id/ai/actions` endpoint.
- Track `provenance = 'AI'` in the `job_versions` log whenever this endpoint is hit.
- Build a robust Jest test suite covering validation and state transitions.

**Dependencies:**
- `job_versions` schema updates (completed in Phase 1).
