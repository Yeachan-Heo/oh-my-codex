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
- `ledger.jsonl` — append-only checkpoint events (`plan_created`, `goal_started`, `goal_resumed`, `goal_completed`, `goal_failed`, `goal_retried`).

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
omx ultragoal checkpoint --goal-id G001-example --status complete --evidence "npm test passed; docs updated"
```

Failure handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status failed --evidence "blocked on missing credential"
omx ultragoal complete-goals --retry-failed
```

Status:

```sh
omx ultragoal status
omx ultragoal status --json
```

## Integration constraints

- One Codex thread can have at most one active goal.
- `create_goal` starts the active objective; it is not a general plan store.
- `update_goal` is completion-only; pause/resume/budget state is controlled by Codex/user/system, not OMX.
- Ultragoal owns durable plan and ledger state; Codex goal mode owns active-thread focus and accounting.
- A goal is not complete merely because tests pass or a ledger entry exists. The agent must audit the objective against files, commands, tests, PR state, or other concrete evidence.
