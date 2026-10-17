# 🚀 COCPIT Feed Sprint — Execution HQ

> **Version:** 1.0.0 | **Sprint:** 5-Day Feed Engine Implementation | **Status:** ACTIVE

This is the **single source of truth** for the 5-day COCPIT feed engine sprint.
All architecture decisions are **frozen**. This HQ governs **execution only**.

---

## 📁 Workspace Structure

```
FEED-SPRINT-HQ/
├── README.md                        ← You are here
│
├── architecture/                    ← FROZEN. Read-only. No edits without approval.
│   ├── ARCHITECTURE_FROZEN.md       ← Master architecture spec
│   ├── feed-flow-diagram.md         ← End-to-end feed flow
│   └── module-boundaries.md        ← Module isolation rules
│
├── contracts/                       ← IMMUTABLE during sprint. Change process required.
│   ├── api-contracts.md             ← All API endpoint signatures
│   ├── redis-key-registry.md        ← All Redis key patterns
│   ├── event-types.md               ← Feed analytics event catalog
│   ├── ranking-features.md          ← Ranking signal definitions
│   ├── candidate-source-types.md    ← Candidate source enum + weights
│   └── schemas/
│       ├── feed-session.schema.json
│       ├── candidate.schema.json
│       ├── ranking-result.schema.json
│       └── feed-event.schema.json
│
├── ownership/
│   ├── OWNERSHIP_MATRIX.md          ← Developer ownership per module
│   └── review-responsibilities.md  ← Who reviews what
│
├── tracking/
│   ├── SPRINT_DASHBOARD.md          ← Live sprint health dashboard
│   ├── day1-tracker.md
│   ├── day2-tracker.md
│   ├── day3-tracker.md
│   ├── day4-tracker.md
│   └── day5-tracker.md
│
├── context/
│   ├── CONTEXT_SNAPSHOT.md          ← Current system state (updated daily)
│   ├── handoff-log.md               ← Dev-to-dev / AI handoff records
│   └── ai-agent-registry.md        ← Active AI agents + their assigned scope
│
├── governance/
│   ├── AI_RULES.md                  ← AI agent operational rules
│   ├── CONTRACT_CHANGE_PROCESS.md  ← How to propose schema/contract changes
│   └── IMMUTABLE_FILES.md          ← List of files AI agents cannot touch
│
├── integration/
│   ├── CHECKPOINT_PROTOCOL.md      ← Daily integration checkpoint process
│   ├── compatibility-matrix.md     ← Cross-module dependency grid
│   └── integration-log.md          ← Integration test results log
│
├── blockers/
│   └── BLOCKER_LOG.md              ← Active blockers + escalation status
│
└── deployment/
    └── DEPLOYMENT_CHECKLIST.md     ← Pre-production readiness checklist
```

---

## ⚡ Quick Start (Every Developer, Every Session)

**Step 1 — Read context snapshot**
```
contracts/context/CONTEXT_SNAPSHOT.md
```

**Step 2 — Check ownership matrix**
```
ownership/OWNERSHIP_MATRIX.md
```

**Step 3 — Check today's tracker**
```
tracking/dayN-tracker.md
```

**Step 4 — Claim your task** (mark `[/]` in tracker)

**Step 5 — Implement → Log → Validate → Mark complete**

---

## 🔒 Golden Rules

1. **Architecture is frozen.** No module redesigns during the sprint.
2. **Contracts are immutable.** Schema changes require a formal proposal.
3. **AI agents cannot modify** files in `architecture/` or `contracts/` without human approval.
4. **Every implementation must be logged** in the daily tracker before end of day.
5. **Integration checkpoints run daily at EOD.** No merges without passing checkpoint.
