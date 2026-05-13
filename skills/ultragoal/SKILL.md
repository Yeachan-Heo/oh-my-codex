---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over Codex goal mode artifacts.
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal planning, or sequential execution over Codex `/goal`.

## Purpose

`ultragoal` turns a brief into repo-native artifacts and then drives a Codex goal safely through goal tools. New plans default to an aggregate Codex goal for the whole ultragoal run while OMX tracks G001/G002 story progress in the ledger.

- `.omx/ultragoal/brief.md`
- `.omx/ultragoal/goals.json`
- `.omx/ultragoal/ledger.jsonl`

## Create goals

1. Run one of:
   - `omx ultragoal create-goals --brief "<brief>"`
   - `omx ultragoal create-goals --brief-file <path>`
   - `cat <brief> | omx ultragoal create-goals --from-stdin`
   - `omx ultragoal create-goals --codex-goal-mode per-story --brief "<brief>"` only when one fresh Codex thread per story is explicitly preferred
2. Inspect `.omx/ultragoal/goals.json` and refine if needed.

## Complete goals

Loop until `omx ultragoal status` reports all goals complete:

1. Run `omx ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `get_goal`.
4. If no active Codex goal exists, call `create_goal` with the printed payload. In aggregate mode, if the same aggregate Codex objective is already active, continue the current OMX story without creating a new Codex goal.
5. Complete the current OMX story only.
6. Run a completion audit against the story objective and real artifacts/tests.
7. In aggregate mode, do **not** call `update_goal` for intermediate stories; checkpoint with a fresh `get_goal` snapshot whose aggregate objective is still `active`. On the final story only, first run the mandatory final cleanup/review gate below; call `update_goal({status: "complete"})` only after that gate is clean, then call `get_goal` again for a fresh `complete` snapshot.
8. Checkpoint the durable ledger with that snapshot. Intermediate aggregate checkpoints use only `--codex-goal-json`; final clean checkpoints also require `--quality-gate-json`:
   `omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --codex-goal-json <get_goal-json-or-path> [--quality-gate-json <quality-gate-json-or-path>]`
9. If blocked or failed, checkpoint failure:
   `omx ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
10. For legacy per-story completed-goal blockers, preserve the non-terminal blocker with:
   `omx ultragoal checkpoint --goal-id <id> --status blocked --evidence "<completed legacy Codex goal blocks create_goal in this thread>" --codex-goal-json <get_goal-json-or-path>`
11. Resume failed goals with `omx ultragoal complete-goals --retry-failed`.

## Use Ultragoal and Team together

Use ultragoal and team together for a durable Ultragoal story that benefits from parallel execution. Ultragoal remains leader-owned: `.omx/ultragoal/goals.json` stores the story plan and `.omx/ultragoal/ledger.jsonl` stores checkpoints. Team is the parallel execution engine and returns task/evidence status to the leader.

The leader checkpoints Ultragoal from Team evidence with a fresh `get_goal` snapshot:

```sh
omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .omx/ultragoal and <id>>" --codex-goal-json <fresh-get_goal-json-or-path>
```

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Team launch remains explicit; Ultragoal does not auto-launch Team and performs no hidden Codex goal mutation.

## Mandatory final cleanup and review gate

The final ultragoal story is not complete until the active agent has run the final quality gate:

1. Run targeted verification for the story.
2. Run `ai-slop-cleaner` on changed files only; if there are no relevant edits, the cleaner still runs and records a passed/no-op report.
3. Rerun verification after the cleaner pass.
4. Run `$code-review`. Clean means `codeReview.recommendation: "APPROVE"` and `codeReview.architectStatus: "CLEAR"`; `COMMENT`, `WATCH`, `REQUEST CHANGES`, and `BLOCK` are non-clean.
5. If review is non-clean, do **not** call `update_goal`. Record durable blocker work instead:

   ```sh
   omx ultragoal record-review-blockers --goal-id <id> --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --codex-goal-json <active-get-goal-json-or-path>
   ```

   This marks the current story `review_blocked`, appends a pending blocker-resolution story, keeps the Codex goal active, and lets `omx ultragoal complete-goals` start the blocker next. In legacy per-story mode, the blocker may need a fresh/available Codex goal context because the old per-story Codex goal remains active/incomplete.

6. If review is clean, call `update_goal({status: "complete"})`, call `get_goal`, and checkpoint with a structured final gate:

   ```sh
   omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<tests/files/review evidence>" --codex-goal-json <fresh-complete-get-goal-json-or-path> --quality-gate-json <quality-gate-json-or-path>
   ```

`--quality-gate-json` must include:

```json
{
  "aiSlopCleaner": { "status": "passed", "evidence": "cleaner report" },
  "verification": { "status": "passed", "commands": ["npm test"], "evidence": "post-cleaner verification" },
  "codeReview": { "recommendation": "APPROVE", "architectStatus": "CLEAR", "evidence": "final review synthesis" }
}
```

## Constraints

- The shell command cannot directly invoke Codex interactive `/goal`; it emits a model-facing handoff for the active Codex agent.
- Never call `create_goal` when `get_goal` reports a different active goal.
- Never call `update_goal` unless the aggregate run or legacy per-story goal is actually complete.
- In aggregate mode, intermediate story checkpoints require a matching `active` Codex snapshot; final story completion requires a matching `complete` snapshot after `update_goal`.
- Completion checkpoints require read-only Codex snapshot reconciliation: pass fresh `get_goal` JSON/path with `--codex-goal-json`; shell commands and hooks must not mutate Codex goal state.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
