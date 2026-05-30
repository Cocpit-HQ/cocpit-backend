# AI Agent Registry

> All AI agents active during the sprint must be registered here.
> Unregistered agents have no task scope and must not write code.

---

## Active Agents

| Agent | Platform | Assigned Modules | Current Task | Context Provided | Status |
|-------|---------|-----------------|-------------|-----------------|--------|
| Antigravity | IDE (in-editor) | All modules (human-directed) | Engineering Ops | ✅ Full context | 🟢 Active |
| Codex | OpenAI API | TBD by devs | — | 🔲 Needs context | ⬜ Not assigned |

---

## Agent Capability Matrix

| Capability | Antigravity | Codex |
|-----------|------------|-------|
| Read frozen architecture | ✅ | ✅ |
| Modify frozen contracts | ❌ | ❌ |
| Create new implementation files | ✅ | ✅ |
| Modify existing working modules | ⚠️ With approval | ⚠️ With approval |
| Register new Redis keys | ❌ | ❌ |
| Write DB migrations | ✅ | ✅ |
| Approve contract changes | ❌ | ❌ |
| Add npm packages | ❌ | ❌ |
| Write to .env | ❌ | ❌ |

---

## Context Required Before Activating Any Agent

Every AI agent session must start with:

1. `FEED-SPRINT-HQ/context/CONTEXT_SNAPSHOT.md` (current state)
2. `FEED-SPRINT-HQ/tracking/dayN-tracker.md` (today's tasks)
3. The specific contract for the assigned module
4. `FEED-SPRINT-HQ/governance/AI_RULES.md` (operational rules)

Without this context, agents should request it before writing any code.

---

## Agent Session Log

| Date | Agent | Task | Files Modified | Summary |
|------|-------|------|---------------|---------|
| 2026-05-23 | Antigravity | Sprint HQ Setup | FEED-SPRINT-HQ/* + core/db/pool.js | Built full execution workspace; fixed DB crash bug |
