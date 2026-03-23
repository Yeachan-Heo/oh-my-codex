---
name: ralph-init
description: "Creates a structured PRD (Product Requirements Document) at .omx/plans/ via interactive interview, giving ralph a concrete definition-of-done before execution starts. Use when you want ralph to iterate against explicit acceptance criteria rather than a vague task — say 'ralph-init', 'create a PRD', or 'write requirements before we start'."
---

# Ralph Init

Initialize a PRD (Product Requirements Document) for structured ralph-loop execution. Creates a structured requirements document that Ralph can use for goal-driven iteration.

## Usage

```
/ralph-init "project or feature description"
```

## Behavior

1. **Gather requirements** via interactive interview or from the provided description
2. **Create PRD** at `.omx/plans/prd-{slug}.md` with:
   - Problem statement
   - Goals and non-goals
   - Acceptance criteria (testable)
   - Technical constraints
   - Implementation phases
3. **Link to Ralph** so that `/ralph` can use the PRD as its completion criteria
4. **Initialize/ensure canonical progress ledger** at `.omx/state/{scope}/ralph-progress.json` (session scope if active session exists)

### Canonical source contract

- Canonical PRD source of truth is `.omx/plans/prd-{slug}.md`.
- Ralph progress source of truth is `.omx/state/{scope}/ralph-progress.json` (session scope when available).
- Legacy `.omx/prd.json` / `.omx/progress.txt` inputs are compatibility-only and migrate one-way into canonical artifacts.

## Output

A structured PRD file saved to `.omx/plans/` that serves as the definition of done for Ralph execution.

## Next Steps

After creating the PRD, start execution with:
```
/ralph "implement the PRD"
```

Ralph will iterate until all acceptance criteria in the PRD are met and architect-verified.
