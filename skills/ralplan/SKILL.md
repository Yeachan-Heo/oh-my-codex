---
name: ralplan
description: Alias for /plan --consensus
---

# Ralplan (Consensus Planning Alias)

Ralplan is a shorthand alias for `/plan --consensus`. It triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached.

## Usage

```
/ralplan "task description"
/ralplan --interactive "task description"
```

## Flags

| Flag | Description |
|------|-------------|
| *(none)* | Default non-interactive mode: auto-proceeds through all steps without pausing |
| `--interactive` | Pauses at draft feedback (step 2) and final approval (step 6) to prompt the user |

## Behavior

This skill invokes the Plan skill in consensus mode:

```
/plan --consensus <arguments>
/plan --consensus --interactive <arguments>
```

The consensus workflow (default — non-interactive):
1. **Planner** creates initial plan
2. *(skipped in default mode)* Auto-proceeds to Architect review
3. **Architect** reviews for architectural soundness
4. **Critic** evaluates against quality criteria
5. If Critic rejects: iterate with feedback (max 5 iterations)
6. *(skipped in default mode)* Auto-approves on Critic approval
7. **MUST** invoke `/ralph` for execution -- never implement directly

With `--interactive` flag, steps 2 and 6 pause to ask the user via `AskUserQuestion`:
- Step 2 options: Proceed to review / Request changes / Skip review
- Step 6 options: Approve and execute / Request changes / Reject

Follow the Plan skill's full documentation for consensus mode details.
