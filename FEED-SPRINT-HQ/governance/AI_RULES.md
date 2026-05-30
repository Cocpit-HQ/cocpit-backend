# AI Agent Operational Rules

> **Version:** 1.0.0 | **Effective:** Sprint Day 1
> ⛔ These rules apply to ALL AI agents: Antigravity, Codex, and any other agents.

---

## Prime Directive

**AI agents accelerate implementation of the frozen architecture.**
AI agents do NOT redesign, refactor architecturally, or make unilateral contract decisions.

---

## Rule 1 — Immutable Files

The following files **MUST NEVER be modified by any AI agent** without explicit human approval:

```
FEED-SPRINT-HQ/architecture/**          ← Architecture is frozen
FEED-SPRINT-HQ/contracts/**             ← Contracts are frozen
FEED-SPRINT-HQ/contracts/schemas/**     ← Schemas are frozen
FEED-SPRINT-HQ/ownership/**             ← Ownership is fixed
src/core/db/pool.js                     ← Shared infra (both devs must approve)
src/core/cache/**                       ← Shared infra
src/app.js                              ← Route registration (Dev B owns)
```

If an AI agent determines a change is needed to any of these files, it must:
1. Stop work
2. State clearly: *"I need to modify [file] — this requires human approval"*
3. Describe the proposed change
4. Wait for explicit approval before proceeding

---

## Rule 2 — Contract Drift Prevention

AI agents must:
- **Always read** `contracts/api-contracts.md` before generating controller or route code
- **Always read** `contracts/redis-key-registry.md` before writing any Redis operations
- **Always use** schema-defined field names exactly (no renaming, no snake_case → camelCase without approval)
- **Never invent** new Redis key patterns not in the registry

**Violation protocol:** If an AI agent generates code that uses a Redis key not in the registry, that code is rejected and must be regenerated.

---

## Rule 3 — Context Registration Before Coding

Before starting any implementation task, an AI agent must confirm it has read:
- [ ] The frozen architecture spec
- [ ] The relevant contract for the module
- [ ] The current ownership matrix
- [ ] Today's tracker for the assigned module

If context is missing, the AI agent must ask for the relevant document, not assume.

---

## Rule 4 — Scope Limitation

AI agents are scoped to **a single module per task**. They may not:
- Refactor sibling modules while implementing their assigned module
- Add utility functions to shared files without explicit permission
- Change existing working modules (auth, messaging, etc.) without flagging

---

## Rule 5 — Code Review Requirements

All AI-generated code must:
1. **Be reviewed** by the module owner before being considered final
2. **Include a brief implementation summary** at the top of any new file:
   ```js
   /**
    * Module: [module name]
    * Sprint Task: [day and task ID from tracker]
    * Owner: [Dev A or Dev B]
    * AI-Assisted: Yes (Antigravity / Codex)
    * Contracts read: [list which contracts were consulted]
    * Last reviewed: [date]
    */
   ```
3. **Not include** debug `console.log` statements in production paths
4. **Include** basic input validation on all public functions

---

## Rule 6 — Schema Change Protocol

If an AI agent identifies that the current schema is insufficient for the implementation:

1. **Do not** change the schema file
2. **Do not** change the implementation to work around the schema
3. **Document** the gap in `blockers/BLOCKER_LOG.md`
4. **Flag** for human decision with specific options

---

## Rule 7 — Forbidden Actions for AI Agents

| Action | Status |
|--------|--------|
| Modifying frozen architecture docs | ❌ FORBIDDEN |
| Creating new DB tables without migration file | ❌ FORBIDDEN |
| Changing Redis key patterns not in registry | ❌ FORBIDDEN |
| Adding new npm packages without human approval | ❌ FORBIDDEN |
| Modifying `package.json` | ❌ FORBIDDEN without human review |
| Creating test data with real user IDs | ❌ FORBIDDEN |
| Writing to `.env` | ❌ FORBIDDEN |
| Removing existing non-feed modules | ❌ FORBIDDEN |
| Making network requests during implementation | ❌ FORBIDDEN |

---

## Rule 8 — Implementation Logging

After completing each task, the AI agent must provide:

```
## AI Implementation Summary
- Task: [task ID from tracker]
- Module: [module name]
- Files created: [list]
- Files modified: [list]
- Contracts consulted: [list]
- Redis keys used: [list — must all be in registry]
- Known limitations: [any edge cases not handled]
- Test coverage: [what was/wasn't tested]
- Human review needed on: [highlight specific logic]
```

---

## Rule 9 — Duplication Prevention

Before implementing any utility function or service, an AI agent must check:
1. Does this already exist in `src/core/`?
2. Does this already exist in `src/services/`?
3. Does this already exist in `src/utils/`?

If it exists, **use the existing implementation**. Do NOT create a duplicate.

---

## Rule 10 — Daily Synchronization

At the start of each session, AI agents must be provided with:
- `context/CONTEXT_SNAPSHOT.md` (current system state)
- Today's tracker (`tracking/dayN-tracker.md`)
- Their specific task assignment

Without this context, AI agents should request it before proceeding.
