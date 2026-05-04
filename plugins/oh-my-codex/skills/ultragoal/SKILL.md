---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over Codex goal mode artifacts.
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal planning, or sequential execution over Codex `/goal`.

## Purpose

`ultragoal` turns a brief into repo-native artifacts and then drives one goal at a time through Codex goal tools:

- `.omx/ultragoal/brief.md`
- `.omx/ultragoal/goals.json`
- `.omx/ultragoal/ledger.jsonl`

## Create goals

1. Run one of:
   - `omx ultragoal create-goals --brief "<brief>"`
   - `omx ultragoal create-goals --brief-file <path>`
   - `cat <brief> | omx ultragoal create-goals --from-stdin`
2. Inspect `.omx/ultragoal/goals.json` and refine if needed.

## Complete goals

Loop until `omx ultragoal status` reports all goals complete:

1. Run `omx ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `get_goal`.
4. If no active Codex goal exists, call `create_goal` with the printed payload.
5. Complete that single goal only.
6. Run a completion audit against the objective and real artifacts/tests.
7. When complete, call `update_goal({status: "complete"})`.
8. Checkpoint the durable ledger:
   `omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>"`
9. If blocked or failed, checkpoint failure:
   `omx ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
10. Resume failed goals with `omx ultragoal complete-goals --retry-failed`.

## Constraints

- The shell command cannot directly invoke Codex interactive `/goal`; it emits a model-facing handoff for the active Codex agent.
- Never call `create_goal` when `get_goal` reports a different active goal.
- Never call `update_goal` unless the current goal is actually complete.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
