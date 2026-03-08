---
name: review
description: Reviewer-only pass for /plan --review and cleanup artifact review
---

# Review (Reviewer-Only Pass)

Review is a shorthand alias for `/plan --review`. It triggers Critic evaluation of an existing plan and is intended to preserve writer/reviewer separation.

## Usage

```
/review
/review "path/to/plan.md"
```

## Behavior

This skill invokes the Plan skill in review mode:

```
/plan --review <arguments>
```

The review workflow:
1. Treat review as a reviewer-only pass. The authoring context may write the plan or cleanup proposal, but a separate reviewer context must issue the verdict.
2. Read plan file from `.omx/plans/` (or specified path)
3. Evaluate via Critic agent
4. For cleanup/refactor/anti-slop work, confirm the artifact includes a cleanup plan, regression-test coverage or an explicit test gap, bounded smell-by-smell passes, and quality gates.
5. Return verdict: APPROVED, REVISE (with specific feedback), or REJECT (replanning required)

## Guardrails

- Never write and approve in the same context.
- If the current context authored the artifact, hand review to Critic or another reviewer role.
- Approval must cite concrete evidence, not author claims.

Follow the Plan skill's full documentation for review mode details.
