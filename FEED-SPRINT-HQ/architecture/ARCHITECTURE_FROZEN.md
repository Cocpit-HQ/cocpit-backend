# COCPIT Feed Engine — Frozen Architecture Specification

> **Status: FROZEN ✅**
> **Approved by:** Engineering Lead
> **Frozen on:** Sprint Day 0
> **Version:** 1.0.0

⛔ This document is READ-ONLY during the sprint.
Any proposed change requires the Contract Change Process (`governance/CONTRACT_CHANGE_PROCESS.md`).

---

## System Overview

The COCPIT Feed Engine is a **unified intelligent feed system** that aggregates, ranks, and serves personalized content across all COCPIT entity types (posts, jobs, events, startups, people).

### Design Principles
1. **Deterministic ranking core** — scoring is reproducible and auditable
2. **Layered architecture** — candidate generation → ranking → reranking → serving
3. **Session-aware** — feed state persists per user session
4. **Exploration-safe** — 15% slot reserved for serendipitous discovery
5. **Anti-spam by default** — deduplication and fatigue heuristics built-in
6. **Redis-first caching** — hot feeds served from cache, not DB on every request

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    FEED API LAYER                           │
│  GET /api/feed  ·  POST /api/feed/event  ·  feed-session    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│               CANDIDATE GENERATION LAYER                    │
│  Sources: social-graph · jobs · events · trending · explore │
│  Output: CandidateItem[]  (schema frozen in contracts/)     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│            DETERMINISTIC RANKING ENGINE                     │
│  Inputs: candidate pool + user intent vector                │
│  Signals: recency · engagement · relationship · intent      │
│  Output: ScoredCandidate[]  (ranked list, reproducible)     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│           RERANKING + DIVERSITY LAYER                       │
│  - Content-type diversity enforcement                       │
│  - Anti-spam: duplicate author, repeated content filters    │
│  - Opportunity-aware slot injection (jobs, events)          │
│  - 15% exploration slot                                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│           FEED SESSION TRACKING                             │
│  - User's seen set (Redis TTL: 24h)                         │
│  - Pagination cursor                                        │
│  - Session expiry (30 min idle)                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│               REDIS CACHING LAYER                           │
│  - Precomputed feed slices (TTL: 5 min)                     │
│  - Candidate pool cache (TTL: 2 min)                        │
│  - Session state                                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                     Served to Client
```

---

## Module Inventory

| Module | Path | Owner | Status |
|--------|------|-------|--------|
| Candidate Generation | `src/modules/feed/candidates/` | Dev A | 🔲 Not started |
| Ranking Engine | `src/modules/feed/ranking/` | Dev A | 🔲 Not started |
| Reranking/Diversity | `src/modules/feed/reranking/` | Dev B | 🔲 Not started |
| Feed Session Tracking | `src/modules/feed/session/` | Dev B | 🔲 Not started |
| Feed API Controller | `src/modules/feed/feed.controller.js` | Dev B | 🔲 Not started |
| Feed Routes | `src/modules/feed/feed.routes.js` | Dev B | 🔲 Not started |
| Analytics/Event Tracking | `src/modules/feed/analytics/` | Dev A | 🔲 Not started |
| Exploration System | `src/modules/feed/exploration/` | Dev A | 🔲 Not started |
| Redis Cache Service | `src/modules/feed/cache/` | Dev B | 🔲 Not started |
| Feed Worker | `src/workers/feedWorker.js` | Dev B | 🔲 Not started |
| DB Migrations | `src/db/feed-migrations/` | Dev A | 🔲 Not started |

---

## Data Flow

```
User Request
    │
    ▼
[1] Validate session token + extract user_id + intent_vector
    │
    ▼
[2] Check Redis: feed:{user_id}:{cursor} exists?
    │   YES → serve cached slice → update session cursor
    │   NO  → proceed to generation
    ▼
[3] Candidate Generation
    ├── Social graph candidates (follows, connections)
    ├── Trending candidates (last 24h engagement)
    ├── Job/Event opportunity candidates
    └── Exploration candidates (random diversity pool)
    │
    ▼
[4] Filter seen set (Redis: feed:seen:{user_id})
    │
    ▼
[5] Deterministic Ranking (score each candidate)
    │
    ▼
[6] Reranking + Diversity enforcement
    │
    ▼
[7] Inject exploration slots (15%)
    │
    ▼
[8] Store result slice in Redis (TTL: 5min)
    │
    ▼
[9] Update session cursor + seen set
    │
    ▼
[10] Return paginated feed response
```

---

## Anti-Spam Heuristics (Frozen)

- Max 2 items from the same author per 20-item page
- Max 3 items of the same content type per 20-item page
- Seen items excluded (Redis set, 24h TTL)
- Engagement bait signals penalized (high share, low dwell time ratio)
- Recency decay: content older than 72h scaled by 0.4x

---

## Exploration System

- 15% of each feed page (≈ 3 items per 20) reserved for exploration
- Exploration pool sourced from: trending globally, outside social graph, new creator content
- Exploration slots injected at positions [3, 10, 17] in a 20-item feed
- User can opt-out via profile settings flag: `exploration_enabled: boolean`
