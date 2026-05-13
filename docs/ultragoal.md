# Ultragoal

`ultragoal` is a durable, repo-native multi-goal workflow layered over Codex goal mode. It keeps the long-range plan in files while Codex goal mode tracks the active thread focus.

## Why this shape

Codex CLI 0.128.0 exposes `goals` as an enabled feature, but `codex --help` has no `goal` shell subcommand. In this runtime, goal mode is exposed to the agent as model tools:

- `get_goal` reads the active thread goal.
- `create_goal` creates one active objective for a thread and fails if the thread already has a goal.
- `update_goal` can only mark the existing goal `complete`.

Upstream Codex goal source also constrains objectives to 4,000 characters, tracks token/time usage, emits `ThreadGoalUpdated` events, and uses continuation/budget-limit prompts to keep work focused. OMX therefore must not pretend a shell command can mutate hidden Codex thread state. Instead, `omx ultragoal complete-goals` checkpoints repo state and prints an explicit handoff for the active Codex agent to call goal tools safely.

New ultragoal plans default to **aggregate Codex goal mode**: Codex gets one objective for the whole ultragoal run, while OMX owns G001/G002 story state and ledger checkpoints. This avoids the impossible same-thread transition from a completed G001 Codex goal to a new G002 Codex goal. Legacy or explicitly requested **per-story** plans remain supported for users who want one Codex thread per story.

## Artifacts

All artifacts live under `.omx/ultragoal/`:

- `brief.md` — original project/conversation brief.
- `goals.json` — ordered durable plan with status, attempts, evidence, and the active goal id.
- `ledger.jsonl` — append-only checkpoint events (`plan_created`, `goal_started`, `goal_resumed`, `goal_completed`, `goal_blocked`, `goal_failed`, `goal_retried`, `goal_added`, `final_review_failed`, `goal_review_blocked`).

In aggregate mode, `goals.json` also stores:

- `codexGoalMode: "aggregate"`
- `codexObjective` — the exact deterministic objective sent to `create_goal`, capped to Codex's objective limit and referencing `.omx/ultragoal/goals.json`.

## Commands

Create a plan:

```sh
omx ultragoal create-goals --brief "Ship the feature in three safe milestones"
omx ultragoal create-goals --brief-file docs/my-brief.md
cat docs/my-brief.md | omx ultragoal create-goals --from-stdin
omx ultragoal create-goals --codex-goal-mode per-story --brief "Use one fresh Codex thread per story"
```

Start or resume the next goal:

```sh
omx ultragoal complete-goals
```

The command marks the next pending OMX story `in_progress`, appends a ledger entry, and prints a goal-tool handoff. In aggregate mode, the agent should call `get_goal`, then `create_goal` only if no active Codex goal exists. If the same aggregate objective is already active, the agent continues the next OMX story without creating a new Codex goal.

For intermediate stories, do **not** call `update_goal`; checkpoint the OMX story with a fresh `get_goal` snapshot whose objective matches `codexObjective` and whose status is still `active`:

```sh
omx ultragoal checkpoint --goal-id G001-example --status complete --evidence "npm test passed; docs updated" --codex-goal-json ./get-goal.json
```

For the final story, run the whole-run audit plus the mandatory final `ai-slop-cleaner`, post-cleaner verification, and `$code-review` gate. If review is clean (`APPROVE` + `CLEAR`), call `update_goal({status: "complete"})`, call `get_goal` again, and checkpoint with the fresh complete aggregate snapshot plus `--quality-gate-json`. If review is non-clean, do not call `update_goal`; use `omx ultragoal record-review-blockers` to append a durable blocker-resolution story and continue.

Failure handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status failed --evidence "blocked on missing credential"
omx ultragoal complete-goals --retry-failed
```

Completed legacy thread-goal blocker handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status blocked --evidence "completed legacy Codex goal blocks create_goal in this thread" --codex-goal-json ./get-goal.json
```

`--status blocked` is a non-terminal ledger checkpoint for legacy per-story or pre-aggregate sessions: a previous, different Codex thread goal is already `complete`, and the current `get_goal`/`create_goal` tool surface has no reset/new-goal operation that can clear that completed goal from the same thread. This writes a `goal_blocked` event, preserves the ultragoal as `in_progress`, and records that the agent must continue the same repo/worktree from a fresh Codex thread where `create_goal` can start the active ultragoal objective.

Status:

```sh
omx ultragoal status
omx ultragoal status --codex-goal-json ./get-goal.json
omx ultragoal status --json
```

## Use Ultragoal and Team together

Use ultragoal and team together when one durable Ultragoal story needs parallel execution lanes. Ultragoal remains the leader-owned durable goal wrapper: `.omx/ultragoal/goals.json` stores story state and `.omx/ultragoal/ledger.jsonl` stores the audit trail. Team is the parallel execution engine: workers own Team tasks, mailbox updates, verification notes, and terminal task evidence.

The leader checkpoints Ultragoal from Team evidence only after reconciling the Codex goal state. For an intermediate aggregate story, the leader calls `get_goal`, confirms the aggregate objective is still `active`, then runs:

```sh
omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .omx/ultragoal and <id>>" --codex-goal-json <fresh-get_goal-json-or-path>
```

For the final aggregate story, run the mandatory final cleanup/review gate first, call `update_goal({status: "complete"})` only when it is clean, call `get_goal` again, and checkpoint with `--quality-gate-json`.

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Team launch is explicit operator action; `omx ultragoal` does not auto-launch Team and performs no hidden Codex goal mutation.

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

## Integration constraints

- One Codex thread can have at most one goal focus.
- `create_goal` starts the active objective; it is not a general plan store.
- `update_goal` is completion-only; pause/resume/budget state is controlled by Codex/user/system, not OMX.
- Aggregate mode is the default: one Codex objective covers the whole ultragoal run, and G001/G002 are OMX ledger stories.
- Intermediate aggregate story checkpoints require a matching `active` Codex snapshot. A `complete` snapshot before the final story is rejected to prevent premature `update_goal`. A non-clean final review records the old story as `review_blocked` and appends a pending blocker story before any completion checkpoint.
- Final aggregate story checkpoints require a matching `complete` Codex snapshot captured after `update_goal({status: "complete"})`.
- There is currently no Codex goal-tool reset/new-goal surface for replacing a completed legacy thread goal. In per-story mode, if `get_goal` returns a different completed objective and `create_goal` rejects because the thread already has a goal, record `omx ultragoal checkpoint --status blocked` with that `get_goal` JSON, then continue in a fresh Codex thread on the same branch/worktree and call `create_goal` there for the ultragoal payload.
- Ultragoal owns durable plan and ledger state; Codex goal mode owns active-thread focus and accounting.
- OMX never edits upstream Codex source such as `../../codex`, never shells out to a hidden `/goal` mutator, and never claims that `omx ultragoal checkpoint` changes Codex's active thread goal. The only Codex goal-mode handoff is explicit: `get_goal`, then `create_goal` when no active goal exists, then `update_goal({status: "complete"})` after the real completion audit passes.
- Completion checkpoints require a fresh `get_goal` snapshot. Save or pass the JSON from `get_goal` with `--codex-goal-json <json-or-path>`; OMX compares the objective and enforces the mode-specific status (`active` for intermediate aggregate stories, `complete` for final aggregate or per-story completion).
- Active or incomplete wrong Codex goals remain strict mismatch errors. The `--status blocked` workaround only applies when the blocking Codex snapshot is `complete` and has a different objective from the active ultragoal; it must not be used to bypass active-goal mismatch protection.
- A goal is not complete merely because tests pass or a ledger entry exists. The agent must audit the objective against files, commands, tests, PR state, or other concrete evidence.
