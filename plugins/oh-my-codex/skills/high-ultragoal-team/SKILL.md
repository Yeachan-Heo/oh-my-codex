---
name: high-ultragoal-team
description: Mode-based OMX orchestration recipe for leader-owned Ultragoal campaigns with high-reasoning Team workers. Use only when the objective can be split into independent lanes that return verifiable artifacts to a single leader who owns goal/checkpoint state. Do not use for single-threaded debugging, vague backlog cleanup, or unclear ownership.
---

# High Ultragoal Team

A custom OMX recipe that composes existing primitives. It is not a built-in OMX command and not a repo implementation guide by itself.

Use this only when the objective can be split into independent implementation, verification, or review lanes that return verifiable artifacts—such as diffs, test output, log excerpts, file paths, PR/check status, or reproducible findings—to one leader who preserves goal/checkpoint authority. Do not use it merely because a task feels "large"; skip it for one-file edits, single-threaded debugging, vague backlog cleanup/triage, unclear ownership, or work where a single Ralph/local loop is simpler and safer.

Cold contract:
- Workers must never modify `.omx/ultragoal`, Codex goal state, or checkpoints.
- Worker output must return verifiable artifacts: diffs, test output, log excerpts, file paths, PR/check status, or reproducible findings.
- If a worker touches prohibited state: quarantine output, inspect diff/logs, discard prohibited state, then recover from a fresh leader `get_goal` snapshot.

## Decision gate

Default to the lightest mode that is safe. If the task cannot name independent lanes or the verifiable artifacts each lane should return, do not launch Team.

| Mode | Use when | Required layers | Limits |
|---|---|---|---|
| `quick-wave` | Scope is already clear; 1 issue/task with separable artifact-returning lanes, or 1-3 tightly related files/issues | `ultragoal`; `team` only when worker artifacts help | max 1 wave; 0-2 workers unless justified |
| `campaign` | Related artifact-returning lanes need multiple waves | `ultragoal` + `team` | default max 3 waves; explicit stop condition |
| `deliberate-campaign` | Architecture/scope ambiguity, high-risk changes, migrations, security, public API breakage, or long-running supervision | `explore`/`ralplan --deliberate` before `ultragoal`; then `team` | max waves defined by approved plan |

If a task does not need durable state, do not use this skill.

## Universal invariants

Hard rules for every mode:

- The current Codex thread is the **leader**.
- The leader owns Codex `get_goal` / `create_goal` / `update_goal` decisions.
- The leader owns `.omx/ultragoal/*` and all `omx ultragoal checkpoint`, `add-goal`, and `record-review-blockers` calls.
- Workers implement, inspect, test, review, and report evidence only.
- Workers must not mutate `.omx/ultragoal`, call Codex `create_goal` / `update_goal`, checkpoint Ultragoal, or silently expand scope.
- Workers may use Team state through `omx team api`; do not forbid `.omx/state/team` runtime files.
- If `get_goal` reports a different active goal, stop and resolve the conflict.
- After `update_goal({status:"complete"})`, treat the thread goal as terminal; use a fresh/forked leader for unrelated new work.
- `omx ultragoal complete-goals` only prints a model-facing handoff; shell commands cannot invoke Codex goal tools directly.

## Leader effort

- `quick-wave`: leader `medium` or `high`, workers `high` when workers are used.
- `campaign`: leader `high` or `xhigh`, workers `high`.
- `deliberate-campaign`: leader `xhigh`, workers `high`.

Worker effort is explicit and team-wide through `OMX_TEAM_WORKER_LAUNCH_ARGS`; the leader's effort does not propagate automatically.

## Layer catalog

Use optional layers only when their trigger applies:

- `omx explore`: read-only repo facts before planning; do not let it mutate state.
- `$ralplan --deliberate`: planning/review for ambiguous or high-risk campaigns; it produces a plan, not automatic execution.
- `$best-practice-research`: current external docs or ecosystem behavior is material.
- `omx team`: durable parallel worker lanes and evidence reporting.
- `omx ralph` / `$ralph`: optional serial follow-up when Team evidence shows a blocker is no longer parallelizable. Do not use removed `omx team ralph`.
- `$ai-slop-cleaner` and `$code-review`: risk-based quality gates; mandatory only for deliberate-campaign final completion or escalated campaign/quick-wave risk.

## Goal and Ultragoal setup

Precheck:

```bash
omx ultragoal status
```

Before starting or continuing an Ultragoal story, take a fresh Codex goal snapshot:

```text
get_goal
```

- If `get_goal` reports no active goal and the Ultragoal handoff is current, the leader may `create_goal` from the handoff.
- If `get_goal` reports the same in-progress aggregate/story, continue normally.
- If `get_goal` reports a different in-progress goal, stop and resolve the conflict; do not overwrite it.
- If `get_goal` reports a completed unrelated/legacy goal in this thread, do not start a new unrelated campaign in this thread. Record a non-terminal Ultragoal blocker if needed, then continue from a fresh/forked leader thread in the same repo/worktree.

- If an active campaign exists, continue it; do not overwrite `.omx/ultragoal`.
- If starting a new campaign/wave and old completed artifacts exist, replace deliberately only when intended:

```bash
omx ultragoal create-goals --brief "<bounded brief>" [--force]
```

- For a new wave inside an active campaign, prefer pending goals or add a bounded goal:

```bash
omx ultragoal add-goal --title "<wave>" --objective "<bounded objective>"
```

Start the next story:

```bash
omx ultragoal complete-goals
```

Then the leader follows the printed handoff with Codex goal tools: `get_goal`, then `create_goal` only if no conflicting active goal exists.

## Mode recipes

### quick-wave

1. Confirm scope is already concrete, owned, and artifact-returning.
2. Run Ultragoal setup or continue the active story.
3. Launch 0-2 high workers only if parallel evidence helps.
4. Leader integrates, verifies, checks mutation guard, and checkpoints.
5. If new scope appears, do not grow the wave; record next wave or blocker.

### campaign

1. Define objective, included/excluded scope, max waves, and stop condition.
2. Create one aggregate Codex goal for the campaign.
3. Run each wave through Team evidence, leader integration, verification, and checkpoint.
4. Use `add-goal` for non-blocking next waves.
5. Use `record-review-blockers` for blocking review findings with a fresh active `get_goal` snapshot.
6. Call `update_goal({status:"complete"})` only after the final campaign gate.

### deliberate-campaign

1. Use `omx explore` for repo facts when needed.
2. Use `$ralplan --deliberate` for scope/architecture consensus.
3. Convert the approved plan into the Ultragoal brief, including stop condition, acceptance criteria, wave plan, worker lanes, and final gate.
4. Continue as `campaign`.

## Worker launch template

Preflight for Team:

```bash
tmux -V
test -n "$TMUX"
omx --help >/dev/null
```

If not in an OMX/tmux-capable leader session, do not launch Team directly; downgrade to local work or open an OMX leader session.

Canonical high-worker launch:

```bash
OMX_TEAM_WORKER_LAUNCH_ARGS='-c model_reasoning_effort="high"' \
omx team 3:executor "Work on the active Ultragoal story. Do not mutate .omx/ultragoal or create/update Codex goals. Report files changed, tests run, evidence, risks, and whether prohibited state was touched."
```

Notes:

- `N:agent-type` selects worker role prompt, not Codex vs Claude CLI.
- Use `OMX_TEAM_WORKER_CLI` or `OMX_TEAM_WORKER_CLI_MAP` for Codex/Claude selection.
- Explicit model/reasoning in `OMX_TEAM_WORKER_LAUNCH_ARGS` applies to all workers in that team.

## Integration and mutation guard

Workers produce evidence, not authority. Before accepting worker output, the leader must:

1. Read Team status/mailbox evidence.
2. Review worker patches/commits; no blind merge.
3. Check that `.omx/ultragoal` was not changed by workers.
4. Reconcile conflicts in the leader context.
5. Run targeted verification.
6. If prohibited state was touched, run the violation recovery procedure before accepting any worker output.

### Violation recovery

If a worker mutates `.omx/ultragoal`, calls Codex goal tools, checkpoints, or silently expands scope:

1. Quarantine that worker's output; do not merge or trust its reported completion.
2. Inspect the diff/logs to identify every prohibited state mutation.
3. Revert or discard the prohibited state changes from the leader context.
4. Take a fresh `get_goal` snapshot before any new checkpoint decision.
5. Reconstruct or rewrite checkpoint/evidence from leader-verified facts only.
6. Record the violation in the campaign notes or `record-review-blockers` when it affects completion confidence.
7. Relaunch a replacement worker only with a narrower prompt, or continue locally if the lane is no longer safely parallelizable.

### Completed-goal collision recovery

If `.omx/ultragoal` has an in-progress story but `get_goal` returns a completed unrelated/legacy objective from an earlier quick-wave in the same thread:

1. Treat this as a leader-thread state collision, not an implementation failure.
2. Do not call `create_goal`; completed Codex goal state cannot be reused for a new unrelated campaign in the same thread.
3. Do not repeatedly attempt a `complete` checkpoint against the unrelated completed goal.
4. If the current Ultragoal story is not actually implemented, checkpoint it as `blocked` with the fresh `get_goal` JSON and evidence naming the completed legacy goal collision.
5. If the completed Codex goal is genuinely the same aggregate planned scope, checkpoint `complete` only with evidence that names the Ultragoal goal id and `.omx/ultragoal/goals.json` or `ledger.jsonl`; otherwise prefer `blocked`.
6. Continue the Ultragoal from a fresh/forked Codex leader thread in the same repo/worktree, then create the intended Codex goal there.
7. Hooks must not mutate Codex goal state; the active leader owns Codex goal tool calls.

Minimum worker report:

```text
files changed:
tests/commands run:
evidence:
risks:
prohibited state touched: yes/no
```

## Checkpoint and gates

Gate strength is mode-specific; do not impose the final campaign ceremony on every quick-wave.

| Mode | Minimum gate | Escalate when |
|---|---|---|
| `quick-wave` | Targeted verification, leader diff review, mutation guard, concise Ultragoal checkpoint if an Ultragoal story is active | Public API, security, migrations, broad refactor, worker conflict, or suspicious/low-evidence output |
| `campaign` | Per-wave targeted verification, mutation guard, checkpoint with evidence; final campaign gate before Codex goal completion | Review blockers, cross-wave coupling, flaky tests, or non-trivial architecture changes |
| `deliberate-campaign` | Approved `ralplan --deliberate` acceptance criteria, per-wave verification/checkpoints, final gate with review evidence | Any plan drift, principle violation, security/compliance concern, or unresolved architect/critic issue |

Intermediate wave checkpoint from the leader only:

```bash
omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --codex-goal-json <fresh-get-goal-json-or-path>
```

Allowed checkpoint statuses are `complete`, `failed`, and `blocked`. Do not use `review_blocked` as a checkpoint status; use `record-review-blockers` for non-clean final reviews/blocking review findings.

Final Ultragoal/Codex goal completion by mode:

- `quick-wave`: targeted verification + leader diff review + mutation guard are enough unless the escalation triggers above apply. If Ultragoal state is active, checkpoint with concise evidence; do not require `$ai-slop-cleaner` or `$code-review` by default.
- `campaign`: final completion requires targeted verification, mutation guard, rerun of relevant verification after integration, fresh `get_goal`, and final checkpoint evidence. Use `$ai-slop-cleaner` and `$code-review` when the campaign changed production code, touched multiple subsystems, or had worker/review uncertainty.
- `deliberate-campaign`: final completion requires the full gate: targeted verification, `$ai-slop-cleaner` or recorded no-op pass, rerun verification, `$code-review` with `APPROVE` + `CLEAR`, `update_goal({status:"complete"})`, fresh `get_goal`, and `omx ultragoal checkpoint ... --quality-gate-json <json-or-path>`.

If the applicable final gate is not clean, do not complete the Codex goal; record blockers and continue or stop with evidence.

## Team monitoring and shutdown

Monitor with runtime/state tools:

```bash
omx team status <team-name>
omx team await <team-name> --timeout-ms 30000 --json
```

Shutdown only when terminal: `pending=0`, `in_progress=0`, and failures are resolved or explicitly accepted.

```bash
omx team shutdown <team-name>
```

Use `--force` only for explicit abort/cleanup.

## Stop rules

Stop and ask/report instead of improvising when:

- `get_goal` shows a different active goal.
- The leader's Codex goal is already `complete` and the work is unrelated; record a blocked Ultragoal checkpoint if an in-progress story was created, then continue from a fresh/forked leader thread.
- An active campaign exists and replacing it would require `create-goals --force`.
- Team is not available because the leader is outside tmux/OMX.
- Worker output lacks evidence or touches prohibited `.omx/ultragoal` state.
- New scope appears; split it into `add-goal`, `record-review-blockers`, or a new issue instead of mutating the active wave.
- Team still has pending/in-progress/failed tasks and the user did not request abort.
