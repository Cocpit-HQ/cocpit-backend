# Contract Change Process

> Use this process for ANY change to: schemas, Redis keys, event types, API contracts, ranking weights.

---

## When Is This Required?

This process is **mandatory** before changing:
- Any file in `contracts/`
- Any file in `contracts/schemas/`
- Signal weights in `ranking-features.md`
- Slot injection positions or counts
- Redis key TTLs
- API endpoint signatures

---

## Change Process

### Step 1 — Identify the Gap

Document the gap in `blockers/BLOCKER_LOG.md`:
```
BLOCKER-XXX | CONTRACT | [module] needs [what] which is missing from [contract file]
```

### Step 2 — Write a Change Proposal

Create a file in `governance/proposals/`:
```
governance/proposals/CCP-XXX-[short-description].md
```

Template:
```markdown
## Contract Change Proposal CCP-XXX
- **Proposed by:** [Dev A / Dev B / AI Agent via Dev A]
- **Date:** YYYY-MM-DD
- **Contract file:** [which file]
- **Current value:** [current definition]
- **Proposed value:** [new definition]
- **Reason:** [why is this needed]
- **Impact on:** [list modules that depend on this contract]
- **Migration needed:** [yes/no — and how]
```

### Step 3 — Get Approval

Both developers must explicitly approve:
```
Dev A: ✅ Approved | ❌ Rejected
Dev B: ✅ Approved | ❌ Rejected
```

No AI agent can approve a contract change.

### Step 4 — Update the Contract

Once both approve:
1. Update the contract file
2. Increment the `version` field if present
3. Update the change log at the bottom of the contract file
4. Notify the AI agents of the change in their next context snapshot

### Step 5 — Update Dependent Modules

List all code that needs to change as a result, and track completion:
```
- [ ] `src/modules/feed/ranking/rankingCalculator.js` — update weight
- [ ] `src/modules/feed/cache/feedCache.js` — update TTL
```

---

## Emergency Change Protocol

If a contract change is blocking the sprint and cannot wait:
1. Both devs verbally/chat-agree
2. Dev B implements and logs the change immediately
3. Formal CCP is filed retrospectively within 2 hours
4. All affected modules are updated same day

---

## Change Log Format (append to each contract file)

```
| Version | Date | Change | Approved By |
|---------|------|--------|-------------|
| 1.0.0 | 2026-05-23 | Initial freeze | Dev A + Dev B |
```
