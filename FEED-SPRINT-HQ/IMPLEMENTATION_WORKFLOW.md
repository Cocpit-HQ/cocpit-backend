# Implementation Workflow

> The exact sequence every developer and AI agent must follow.
> No implementation happens outside this workflow.

---

## The 8-Step Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 1: ORIENT                                             │
│  Read CONTEXT_SNAPSHOT.md → Read today's tracker           │
│  Read the relevant contract for your module                 │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 2: CLAIM                                              │
│  Find your task in today's dayN-tracker.md                  │
│  Mark it [/] (in progress)                                  │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 3: VERIFY OWNERSHIP                                   │
│  Check OWNERSHIP_MATRIX.md → Confirm you own this module    │
│  If not yours: notify the owner before touching it          │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 4: CHECK FOR EXISTING CODE                            │
│  Search src/core/ src/utils/ src/services/ first            │
│  Do NOT duplicate what already exists                       │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 5: IMPLEMENT                                          │
│  Build exactly what the architecture specifies              │
│  Use contract-defined field names                           │
│  Use registry-defined Redis keys                            │
│  Add implementation header comment                          │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 6: VALIDATE                                           │
│  Manually test the happy path                               │
│  Test one edge case                                         │
│  Verify Redis keys match registry                           │
│  Verify response shape matches contract                     │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 7: LOG                                                │
│  Mark task [x] in tracker                                   │
│  Write handoff note if switching context                    │
│  Update CONTEXT_SNAPSHOT.md if significant state changed    │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 8: CHECKPOINT (EOD only)                              │
│  Run EOD integration checkpoint from CHECKPOINT_PROTOCOL.md │
│  Log results in integration-log.md                          │
│  Both devs sign off                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Reference — What To Do When You're Stuck

| Situation | Action |
|-----------|--------|
| Contract doesn't cover your use case | Log blocker → file CCP → both devs decide |
| Redis key you need isn't in registry | Register it first (both devs approve), then use it |
| Module you need doesn't exist yet | Check with its owner → use a stub/interface for now |
| AI agent wants to modify frozen file | Stop → get human approval → proceed |
| Your implementation contradicts architecture | Stop → re-read architecture → align or propose change |
| You broke a passing checkpoint | Log blocker → fix before any new feature work |
| Unsure about ownership | Check matrix → ask the other developer |

---

## What Integration-Ready Means

A module is "integration-ready" when:
1. Happy path works
2. Implementation header is present
3. No hardcoded values
4. All Redis keys are in the registry
5. Response shapes match contracts
6. The module owner has reviewed their own work

**Integration-ready ≠ production-ready.** Day 5 production gate adds the rest.

---

## AI Agent Activation Prompt Template

Use this to initialize any AI agent for a task:

```
You are working on the COCPIT feed engine.
Architecture is FROZEN — do not redesign.

READ FIRST:
1. FEED-SPRINT-HQ/context/CONTEXT_SNAPSHOT.md
2. FEED-SPRINT-HQ/contracts/[relevant-contract.md]
3. FEED-SPRINT-HQ/ownership/OWNERSHIP_MATRIX.md

YOUR TASK:
- Day: [N]
- Task ID: [A/B + number]
- Module: [path]
- Owner: [Dev A / Dev B]

CONSTRAINTS:
- Do not modify frozen files (architecture/, contracts/)
- Use only Redis keys from the registry
- Use field names exactly as defined in schemas
- Add implementation header comment to new files
- Do not add new npm packages without approval

AFTER COMPLETING:
- Provide an AI Implementation Summary
- List all files created/modified
- List all Redis keys used
- Highlight anything that needs human review
```
