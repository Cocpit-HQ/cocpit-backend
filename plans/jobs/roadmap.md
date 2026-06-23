# Jobs Domain Roadmap

## Phase 1: Core Lifecycle & APIs (Current)
- Database schema migrations (constraints, experience fields, audit tables)
- `POST /jobs` creates a draft
- `PATCH /jobs/:id` with schema validation
- `POST /jobs/:id/submit` with strict business validation
- `POST /jobs/:id/clone`
- `GET /jobs` and `GET /jobs/:id` listing updates

## Phase 2: Moderation & Advanced Management (Planned)
- Job Activity Audit UI/APIs
- Lifecycle actions: `PAUSE`, `CLOSE`, `ARCHIVE`
- Moderation endpoints: `APPROVE`, `REJECT`

## Phase 3: AI Integration (Deferred)
- Generic AI action endpoint (`/jobs/:id/ai/actions`)
- Provenance tracking in `job_versions`