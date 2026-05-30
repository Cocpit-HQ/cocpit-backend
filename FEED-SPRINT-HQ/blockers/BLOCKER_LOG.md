# Blocker Log

> Log every blocker here the moment it's discovered.
> Do NOT hold up work waiting to log — log first, work around second.

---

## Format

```
| BLOCKER-XXX | [INFRA/CONTRACT/CODE/DEPENDENCY] | [Module] | Description | Owner | Logged | Status |
```

---

## Active Blockers

| ID | Type | Module | Description | Owner | Logged | Status |
|----|------|--------|-------------|-------|--------|--------|
| — | — | — | No active blockers | — | — | — |

---

## Resolved Blockers

| ID | Type | Module | Description | Resolution | Resolved |
|----|------|--------|-------------|------------|---------|
| BLOCKER-001 | INFRA | core/db | `pool.js` crashed server on DB timeout → `process.exit(1)` | Changed to warn-and-retry (non-fatal). Pool retries every 30s. | 2026-05-23 |

---

## Blocker Severity Levels

| Level | Meaning | Response Time |
|-------|---------|--------------|
| 🔴 CRITICAL | Blocks another developer's work | Fix within 2 hours |
| 🟡 HIGH | Blocks own progress | Fix within 4 hours or find workaround |
| 🟢 LOW | Nice-to-fix, not blocking | Address end of day |

---

## Escalation Protocol

1. Log the blocker here immediately
2. Notify the other developer (chat/call)
3. If blocking for >2 hours: propose a workaround and continue with mock/stub
4. If contract change needed: file `governance/proposals/CCP-XXX.md`
5. If infra blocker: both devs investigate together
