# Feature Context: Job Creation & Lifecycle APIs (Phase 1)

**Problem Statement:**
The current `POST /jobs` API immediately publishes a job, bypassing any draft or review phase. Mobile and web teams are blocked from building the new AI-assisted Job Creation flow until the backend supports partial drafts, strict submissions, and an audit trail.

**Business Goals:**
- Unblock frontend teams with stable, mobile-first API contracts.
- Support the "Human + AI Collaborative Editor" paradigm by separating data generation (Draft) from business validation (Submit).

**Requirements:**
- Convert job creation to a `DRAFT` first workflow.
- Support high-frequency autosaves (`PATCH`) with loose validation.
- Enforce strict business constraints only on `/submit`.
- Ensure robust data integrity without blocking partial drafts.

**Dependencies:**
- Database schema migrations (Constraints, Audit Log).
- Service layer validation logic.