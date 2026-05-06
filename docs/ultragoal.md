# Ultragoal

`ultragoal` is a durable, repo-native multi-goal workflow layered over Codex goal mode. It keeps the long-range plan in files while letting Codex treat exactly one item at a time as the active thread goal.

## Why this shape

Codex CLI 0.128.0 exposes `goals` as an enabled feature, but `codex --help` has no `goal` shell subcommand. In this runtime, goal mode is exposed to the agent as model tools:

- `get_goal` reads the active thread goal.
- `create_goal` creates one active objective for a thread and fails if the thread already has a goal.
- `update_goal` can only mark the existing goal `complete`.

Upstream Codex goal source also constrains objectives to 4,000 characters, tracks token/time usage, emits `ThreadGoalUpdated` events, and uses continuation/budget-limit prompts to keep work focused. OMX therefore must not pretend a shell command can mutate hidden Codex thread state. Instead, `omx ultragoal complete-goals` checkpoints repo state and prints an explicit handoff for the active Codex agent to call goal tools safely.

## Artifacts

All artifacts live under `.omx/ultragoal/`:

- `brief.md` — original project/conversation brief.
- `goals.json` — ordered durable plan with status, attempts, evidence, and the active goal id.
- `ledger.jsonl` — append-only checkpoint events (`plan_created`, `goal_started`, `goal_resumed`, `goal_completed`, `goal_blocked`, `goal_failed`, `goal_retried`).

## Commands

Create a plan:

```sh
omx ultragoal create-goals --brief "Ship the feature in three safe milestones"
omx ultragoal create-goals --brief-file docs/my-brief.md
cat docs/my-brief.md | omx ultragoal create-goals --from-stdin
```

Start or resume the next goal:

```sh
omx ultragoal complete-goals
```

The command marks the next pending goal `in_progress`, appends a ledger entry, and prints a goal-tool handoff. The agent should call `get_goal`, then `create_goal` only if no active Codex goal exists. After the goal is complete, the agent calls `update_goal({status: "complete"})` and checkpoints:

```sh
omx ultragoal checkpoint --goal-id G001-example --status complete --evidence "npm test passed; docs updated" --codex-goal-json ./get-goal.json
```

Failure handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status failed --evidence "blocked on missing credential"
omx ultragoal complete-goals --retry-failed
```

Completed legacy thread-goal blocker handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status blocked --evidence "completed legacy Codex goal blocks create_goal in this thread" --codex-goal-json ./get-goal.json
```

`--status blocked` is a non-terminal ledger checkpoint for issue #2139-style sessions: a previous, different Codex thread goal is already `complete`, and the current `get_goal`/`create_goal` tool surface has no reset/new-goal operation that can clear that completed goal from the same thread. This writes a `goal_blocked` event, preserves the ultragoal as `in_progress`, and records that the agent must continue the same repo/worktree from a fresh Codex thread where `create_goal` can start the active ultragoal objective.

Status:

```sh
omx ultragoal status
omx ultragoal status --codex-goal-json ./get-goal.json
omx ultragoal status --json
```

## Integration constraints

- One Codex thread can have at most one active goal.
- `create_goal` starts the active objective; it is not a general plan store.
- `update_goal` is completion-only; pause/resume/budget state is controlled by Codex/user/system, not OMX.
- There is currently no Codex goal-tool reset/new-goal surface for replacing a completed legacy thread goal. If `get_goal` returns a different completed objective and `create_goal` rejects because the thread already has a goal, record `omx ultragoal checkpoint --status blocked` with that `get_goal` JSON, then continue in a fresh Codex thread on the same branch/worktree and call `create_goal` there for the ultragoal payload.
- Ultragoal owns durable plan and ledger state; Codex goal mode owns active-thread focus and accounting.
- OMX never edits upstream Codex source such as `../../codex`, never shells out to a hidden `/goal` mutator, and never claims that `omx ultragoal checkpoint` changes Codex's active thread goal. The only Codex goal-mode handoff is explicit: `get_goal`, then `create_goal` when no active goal exists, then `update_goal({status: "complete"})` after the real completion audit passes.
- Completion checkpoints require a fresh `get_goal` snapshot. Save or pass the JSON from `get_goal` with `--codex-goal-json <json-or-path>`; OMX compares the objective and requires Codex status `complete` before accepting `--status complete`.
- Active or incomplete wrong Codex goals remain strict mismatch errors. The `--status blocked` workaround only applies when the blocking Codex snapshot is `complete` and has a different objective from the active ultragoal; it must not be used to bypass active-goal mismatch protection.
- A goal is not complete merely because tests pass or a ledger entry exists. The agent must audit the objective against files, commands, tests, PR state, or other concrete evidence.
