---
name: team
description: N coordinated agents on shared task list using tmux-based orchestration
---

# Team Skill

`$team` is the tmux-based parallel execution mode for OMX. It starts real worker Codex and/or Claude CLI sessions in split panes and coordinates them through `.omx/state/team/...` files plus CLI team interop (`omx team api ...`) and state files.

This skill is operationally sensitive. Treat it as an operator workflow, not a generic prompt pattern. In Codex App or plain outside-tmux sessions, do not present `$team` / `omx team` as directly available; launch OMX CLI from shell first, or stay on the nearest app-safe surface until the user explicitly wants the tmux runtime.

## Team vs Native Subagents

- Use **Codex native subagents** for bounded, in-session parallelism where one leader thread can fan out a few independent subtasks and wait for them directly.
- Use **`omx team`** when you need durable tmux workers, shared task state, mailbox/dispatch coordination, worktrees, explicit lifecycle control, or long-running parallel execution that must survive beyond one local reasoning burst.
- Native subagents can complement team/ralph execution, but they do **not** replace the tmux team runtime's stateful coordination contract.

## What This Skill Must Do

## GPT-5.4 Guidance Alignment

Use the shared workflow guidance pattern: concise, evidence-dense progress and completion reporting, local overrides for the active workflow branch, persistent inspection/verification while correctness depends on it, and automatic continuation for safe reversible steps. Ask only for material, destructive, or preference-dependent branches.

When user triggers `$team`, the agent must:

1. Invoke OMX runtime directly with `omx team ...`
2. Avoid replacing the flow with in-process `spawn_agent` fanout
3. Verify startup and surface concrete state/pane evidence
4. If active team mode state is missing, initialize/sync it from canonical team runtime state before proceeding
5. Keep team state alive until workers are terminal (unless explicit abort)
6. Handle cleanup and stale-pane recovery when needed

If `omx team` is unavailable, stop with a hard error.

## Invocation Contract

```bash
omx team [N:agent-type] "<task description>"
```

Examples:

```bash
omx team 3:executor "analyze feature X and report flaws"
omx team "debug flaky integration tests"
omx team "ship end-to-end fix with verification"
```

### Team-first launch contract

`omx team ...` is now the canonical launch path for coordinated execution.
Team mode should carry its own parallel delivery + verification lanes without
requiring a separate linked Ralph launch up front.

- **Canonical launch:** use plain `omx team ...` / `$team ...` for coordinated workers.
- **Verification ownership:** keep one lane focused on tests, regression coverage, and evidence before shutdown.
- **Escalation:** start a separate `omx ralph ...` / `$ralph ...` only when a later manual follow-up still needs a persistent single-owner fix/verification loop.
- **Deprecation:** `omx team ralph ...` has been removed. Use plain `omx team ...` for team execution or run `omx ralph ...` separately when you explicitly want a later Ralph loop.

### Claude teammates (v0.6.0+)

Important: `N:agent-type` (for example `2:executor`) selects the **worker role prompt**, not the worker CLI (`codex` vs `claude`).

To launch Claude teammates, use the team worker CLI env vars:

```bash
# Force all teammates to Claude CLI
OMX_TEAM_WORKER_CLI=claude omx team 2:executor "update docs and report"

# Mixed team (worker 1 = Codex, worker 2 = Claude)
OMX_TEAM_WORKER_CLI_MAP=codex,claude omx team 2:executor "split doc/code tasks"

# Auto mode: Claude is selected when worker launch args/model contains 'claude'
OMX_TEAM_WORKER_CLI=auto OMX_TEAM_WORKER_LAUNCH_ARGS="--model claude-..." omx team 2:executor "run mixed validation"
```

## Preconditions

Before running `$team`, confirm:

1. `tmux` installed (`tmux -V`)
2. Current leader session is inside tmux (`$TMUX` is set)
3. `omx` command resolves to the intended install/build
4. If running repo-local `node bin/omx.js ...`, run `npm run build` after `src` changes
5. Check HUD pane count in the leader window and avoid duplicate `hud --watch` panes before split

Suggested preflight:

```bash
tmux list-panes -F '#{pane_id}\t#{pane_start_command}' | rg 'hud --watch' || true
```

If duplicates exist, remove extras before `omx team` to prevent HUD ending up in worker stack.

## Pre-context Intake Gate

Before launching `omx team`, require a grounded context snapshot:

1. Derive a task slug from the request.
2. Reuse the latest relevant snapshot in `.omx/context/{slug}-*.md` when available.
3. If none exists, create `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
   - task statement
   - desired outcome
   - known facts/evidence
   - constraints
   - unknowns/open questions
   - likely codebase touchpoints
4. If ambiguity remains high, run `explore` first for brownfield facts, then run `$deep-interview --quick <task>` before team launch.
5. If current correctness depends on official docs, version-aware framework guidance, best practices, or external dependency behavior, auto-delegate `researcher` as an evidence lane before or alongside worker launch instead of relying on repo-local recall alone.

Do not start worker panes until this gate is satisfied; if forced to proceed quickly, state explicit scope/risk limitations in the launch report.

For simple read-only brownfield lookups during intake, follow active session guidance: when `USE_OMX_EXPLORE_CMD` is enabled, prefer `omx explore` with narrow, concrete prompts; otherwise use the richer normal explore path and fall back normally if `omx explore` is unavailable.

## Follow-up Staffing Contract

When `$team` is used as a follow-up mode from ralplan, carry forward the approved plan's explicit **available-agent-types roster** and convert it into concrete staffing guidance before launch:

- keep worker-role choices inside the known roster
- state the recommended headcount and role counts
- state the suggested reasoning level for each lane when available
- explain why each lane exists (delivery, verification, specialist support)
- include an explicit launch hint (`omx team N "<task>"` / `$team N "<task>"`) for the coordinated team run; mention a later separate Ralph follow-up only when genuinely needed
- if the ideal role is unavailable, choose the closest role from the roster and say so

## Current Runtime Behavior (As Implemented)

`omx team` currently performs:

1. Parse args (`N`, `agent-type`, task)
2. Sanitize team name from task text
3. Initialize team state:
   - `.omx/state/team/<team>/config.json`
   - `.omx/state/team/<team>/manifest.v2.json`
   - `.omx/state/team/<team>/tasks/task-<id>.json`
4. Compose team-scoped worker instructions file at:
   - `.omx/state/team/<team>/worker-agents.md`
   - Uses project `AGENTS.md` content (if present) + worker overlay, without mutating project `AGENTS.md`
5. Resolve canonical shared state root from leader cwd (`<leader-cwd>/.omx/state`)
6. Split current tmux window into worker panes
7. Launch workers with:
   - `OMX_TEAM_WORKER=<team>/worker-<n>`
   - `OMX_TEAM_STATE_ROOT=<leader-cwd>/.omx/state`
   - `OMX_TEAM_LEADER_CWD=<leader-cwd>`
   - worker CLI selected by `OMX_TEAM_WORKER_CLI` / `OMX_TEAM_WORKER_CLI_MAP` (`codex` or `claude`)
   - optional worktree metadata envs when `--worktree` is used
7. Wait for worker readiness (`capture-pane` polling)
8. Write per-worker `inbox.md` and trigger via `tmux send-keys`
9. Return control to leader; follow-up uses `status` / `resume` / `shutdown`

If coarse active team mode state is missing while canonical team runtime state exists, restore/sync the active team mode state before relying on hook/mode-aware behavior.

Important:

- Leader remains in existing pane
- Worker panes are independent full Codex/Claude CLI sessions
- Workers may run in separate git worktrees (`omx team --worktree[=<name>]`) while sharing one team state root
- Worker ACKs go to `mailbox/leader-fixed.json`
- Notify hook updates worker heartbeat and nudges leader during active team mode
- Submit routing uses this CLI resolution order per worker trigger:
  1) explicit worker CLI provided by runtime state (persisted on worker identity/config),
  2) `OMX_TEAM_WORKER_CLI_MAP` entry for that worker index,
  3) fallback `OMX_TEAM_WORKER_CLI` / auto detection.
- Mixed CLI-map teams are supported for both startup and trigger submit behavior.
- Trigger submit differs by CLI:
  - Codex may use queue-first `Tab` on busy panes (strategy-dependent).
  - Claude always uses direct Enter-only (`C-m`) rounds (never queue-first `Tab`).

### Team worker model + thinking resolution (current contract)

Team mode resolves worker **model flags** from one shared launch-arg set (not per-worker model selection).

Model precedence (highest to lowest):
1. Explicit worker model in `OMX_TEAM_WORKER_LAUNCH_ARGS`
2. Inherited leader `--model` flag
3. Low-complexity default from `OMX_DEFAULT_SPARK_MODEL` (legacy alias: `OMX_SPARK_MODEL`) when 1+2 are absent and team `agentType` is low-complexity

Default-model rule:
- Do **not** assume a frontier or spark model from recency or model-family heuristics.
- Use `OMX_DEFAULT_FRONTIER_MODEL` for frontier-default guidance.
- Use `OMX_DEFAULT_SPARK_MODEL` for spark/low-complexity worker-default guidance.

Thinking-level rule (critical):
- **No model-name heuristic mapping.**
- Team runtime must **not** infer `model_reasoning_effort` from model-name substrings (e.g., `spark`, `high-capability`, `mini`).
- When the leader assigns teammate roles/tasks, OMX allocates **per-worker reasoning effort dynamically** from the resolved worker role (`low`, `medium`, `high`).
- Explicit launch args still win: if `OMX_TEAM_WORKER_LAUNCH_ARGS` already includes `-c model_reasoning_effort=...`, that explicit value overrides dynamic allocation for every worker.

Normalization requirements:
- Parse both `--model <value>` and `--model=<value>`
- Remove duplicate/conflicting model flags
- Emit exactly one final canonical flag: `--model <value>`
- Preserve unrelated args in worker launch config
- If explicit reasoning exists, preserve canonical `-c model_reasoning_effort="<level>"`; otherwise inject the worker role's default reasoning level

## Required Lifecycle (Operator Contract)

Follow this exact lifecycle when running `$team`:

1. Start team and verify startup evidence (team line, tmux target, panes, ACK mailbox)
2. Monitor task and worker progress with runtime/state tools first (`omx team status <team>`, `omx team resume <team>`, mailbox/state files)
3. Wait for terminal task state before shutdown:
   - `pending=0`
   - `in_progress=0`
   - `failed=0` (or explicitly acknowledged failure path)
4. Only then run `omx team shutdown <team>`
5. Verify shutdown evidence and state cleanup

Do not run `shutdown` while workers are actively writing updates unless user explicitly requested abort/cancel.
Do not treat ad-hoc pane typing as primary control flow when runtime/state evidence is available.

### Active leader monitoring rule

While a team is **ON/running**, the leader must not go blind. Keep checking live team state until terminal completion.

Minimum acceptable loop:

```bash
sleep 30 && omx team status <team-name>
```

Repeat that check while the team stays active, or use `omx team await <team-name> --timeout-ms 30000 --json` when event-driven waiting is a better fit.

If the leader gets a stale/team-stalled nudge, immediately run `omx team status <team-name>` before taking any manual intervention.

## Message Dispatch Policy (CLI-first, state-first)

To avoid brittle behavior, **message/task delivery must not be driven by ad-hoc tmux typing**.

Required default path:

1. Use `omx team ...` runtime lifecycle commands for orchestration.
2. Use `omx team api ... --json` for mailbox/task mutations.
3. Verify delivery via mailbox/state evidence (`mailbox/*.json`, task status, `omx team status`).

Strict rules:

- **MUST NOT** use direct `tmux send-keys` as the primary mechanism to deliver instructions/messages.
- **MUST NOT** spam Enter/trigger keys without first checking runtime/state evidence.
- **MUST** prefer durable state writes + runtime dispatch (`dispatch/requests.json`, mailbox, inbox).
- Direct tmux interaction is **fallback-only** and only after failure checks (for example `worker_notify_failed:<worker>`) or explicit user request (for example “press enter”).

## Operational Commands

```bash
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Semantics:

- `status`: reads team snapshot (task counts, dead/non-reporting workers)
- `resume`: reconnects to live team session if present
- `shutdown`: graceful shutdown request, then cleanup (deletes `.omx/state/team/<team>`)

## Data Plane and Control Plane

### Control Plane

- tmux panes/processes (`OMX_TEAM_WORKER` per worker)
- leader notifications via `tmux display-message`

### Data Plane

- `.omx/state/team/<team>/...` files
- Team mailbox files:
- `.omx/state/team/<team>/mailbox/leader-fixed.json`
- `.omx/state/team/<team>/mailbox/worker-<n>.json`
- `.omx/state/team/<team>/dispatch/requests.json` (durable dispatch queue; hook-preferred, fallback-aware)

### Key Files

- `.omx/state/team/<team>/config.json`
- `.omx/state/team/<team>/manifest.v2.json`
- `.omx/state/team/<team>/tasks/task-<id>.json`
- `.omx/state/team/<team>/workers/worker-<n>/identity.json`
- `.omx/state/team/<team>/workers/worker-<n>/inbox.md`
- `.omx/state/team/<team>/workers/worker-<n>/heartbeat.json`
- `.omx/state/team/<team>/workers/worker-<n>/status.json`
- `.omx/state/team-leader-nudge.json`


## Team Mutation Interop (CLI-first)

Use `omx team api` for machine-readable mutation/reads instead of legacy `team_*` MCP tools.

```bash
omx team api <operation> --input '{"team_name":"my-team",...}' --json
```

Examples:

```bash
omx team api send-message --input '{"team_name":"my-team","from_worker":"worker-1","to_worker":"leader-fixed","body":"ACK"}' --json
omx team api claim-task --input '{"team_name":"my-team","task_id":"1","worker":"worker-1"}' --json
omx team api transition-task-status --input '{"team_name":"my-team","task_id":"1","from":"in_progress","to":"completed","claim_token":"<token>"}' --json
```

`--json` responses include stable metadata for automation:
- `schema_version`
- `timestamp`
- `command`
- `ok`
- `operation`
- `data` or `error`

## Team + Worker Protocol Notes

Leader-to-worker:

- Write full assignment to worker `inbox.md`
- Send short trigger (<200 chars) with `tmux send-keys`

Worker-to-leader:

- Send ACK to `leader-fixed` mailbox via `omx team api send-message --json`
- Claim/transition/release task lifecycle via `omx team api <operation> --json`

Worker commit protocol (critical for incremental integration):

- After completing task work and before reporting completion, workers MUST commit:
  `git add -A && git commit -m "task: <task-subject>"`
- This ensures changes are available for incremental integration into the leader branch
- If a worker forgets to commit, the runtime auto-commits as a fallback, but explicit commits are preferred

Task ID rule (critical):

- File path uses `task-<id>.json` (example `task-1.json`)
- MCP API `task_id` uses bare id (example `"1"`, not `"task-1"`)
- Never instruct workers to read `tasks/{id}.json`

## Environment Knobs

Useful runtime env vars:

- `OMX_TEAM_READY_TIMEOUT_MS`
  - Worker readiness timeout (default 45000)
- `OMX_TEAM_SKIP_READY_WAIT=1`
  - Skip readiness wait (debug only)
- `OMX_TEAM_AUTO_TRUST=0`
  - Disable auto-advance for trust prompt (default behavior auto-advances)
- `OMX_TEAM_AUTO_ACCEPT_BYPASS=0`
  - Disable Claude bypass-permissions prompt auto-accept (default behavior auto-accepts `2` + Enter)
- `OMX_TEAM_WORKER_LAUNCH_ARGS`
  - Extra args passed to worker launch command
- `OMX_TEAM_WORKER_CLI`
  - Worker CLI selector: `auto|codex|claude` (default: `auto`)
  - `auto` chooses `claude` when worker `--model` contains `claude`, otherwise `codex`
  - In `claude` mode, workers launch with exactly one `--dangerously-skip-permissions`
    and ignore explicit model/config/effort launch overrides (uses default `settings.json`)
- `OMX_TEAM_WORKER_CLI_MAP`
  - Per-worker CLI selector (comma-separated `auto|codex|claude`)
  - Length must be `1` (broadcast) or exactly the team worker count
  - Example: `OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude`
  - When present, overrides `OMX_TEAM_WORKER_CLI`
- `OMX_TEAM_AUTO_INTERRUPT_RETRY`
  - Trigger submit fallback (default: enabled)
  - `0` disables adaptive queue->resend escalation
- `OMX_TEAM_LEADER_NUDGE_MS`
  - Leader nudge interval in ms (default 120000)
- `OMX_TEAM_STRICT_SUBMIT=1`
  - Force strict send-keys submit failure behavior

## Failure Modes and Diagnosis

Operator note (important for Claude panes):
- Manual Enter injection (`tmux send-keys ... C-m`) can appear to "do nothing" when a worker is actively processing; Enter may be queued by the pane/task flow.
- This is not necessarily a runtime bug. Confirm worker/team state before diagnosing dispatch failure.
- Avoid repeated blind Enter spam; it can create noisy duplicate submits once the pane becomes idle.

### Safe Manual Intervention (last resort)

Use only after checking `omx team status <team>` and mailbox/state evidence:

1. Capture pane tail to confirm current worker state:
   - `tmux capture-pane -t %<worker-pane> -p -S -120`
   - If a larger-tail read or bounded summary would help, prefer explicit opt-in inspection via `omx sparkshell --tmux-pane %<worker-pane> --tail-lines 400` before improvising extra tmux commands.
2. If the pane is stuck in an interactive state, safely return to idle prompt first:
   - optional interrupt `C-c` or escape flow (CLI-specific) once, then re-check pane capture
3. Send one concise trigger (single line) and wait for evidence:
   - `tmux send-keys -t %<worker-pane> "ack + continue current task; report status" C-m`
4. Re-check:
   - pane output via `capture-pane`
   - mailbox updates (`mailbox/leader-fixed.json` or worker mailbox)
   - `omx team status <team>`

### `worker_notify_failed:<worker>`

Meaning:
- Leader wrote inbox but trigger submit path failed

Checks:

1. `tmux list-panes -F '#{pane_id}\t#{pane_start_command}'`
2. `tmux capture-pane -t %<worker-pane> -p -S -120`
3. Verify worker process alive and not stuck on trust prompt
4. Rebuild if running repo-local (`npm run build`)

### Team starts but leader gets no ACK

Checks:

1. Worker pane capture shows inbox processing
2. `.omx/state/team/<team>/mailbox/leader-fixed.json` exists
3. Worker skill loaded and `omx team api send-message --json` called
4. Task-id mismatch not blocking worker flow

### Worker logs `omx team api ... ENOENT` (or legacy `team_send_message ENOENT` / `team_update_task ENOENT`)

Meaning:
- Team state path no longer exists while worker is still running.
- Typical cause: leader/manual flow ran `omx team shutdown <team>` (or removed `.omx/state/team/<team>`) before worker finished.

Checks:

1. `omx team status <team>` and confirm whether tasks were still `in_progress` when shutdown occurred
2. Verify whether `.omx/state/team/<team>/` exists
3. Inspect worker pane tail for post-shutdown writes
4. Confirm no external cleanup (`rm -rf .omx/state/team/<team>`) happened during execution

Prevention:

1. Enforce completion gate (no in-progress tasks) before shutdown
2. Use `shutdown` only for terminal completion or explicit abort
3. If aborting, expect late worker writes to fail and treat ENOENT as expected teardown artifact

### Shutdown reports success but stale worker panes remain

Cause:
- stale pane outside config tracking or previous failed run

Fix:
- manual pane cleanup (see clean-slate commands)

## Clean-Slate Recovery

Run from leader pane:

```bash
# 1) Inspect panes
tmux list-panes -F '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'

# 2) Kill stale worker panes only (examples)
tmux kill-pane -t %450
tmux kill-pane -t %451

# 3) Remove stale team state (example)
rm -rf .omx/state/team/<team-name>

# 4) Retry
omx team 1:executor "fresh retry"
```

Guidelines:

- Do not kill leader pane
- Do not kill HUD pane (`omx hud --watch`) unless intentionally restarting HUD

## Required Reporting During Execution

When operating this skill, provide concrete progress evidence:

1. Team started line (`Team started: <name>`)
2. tmux target and worker pane presence
3. leader mailbox ACK path/content check
4. status/shutdown outcomes

Do not claim success without file/pane evidence.
Do not claim clean completion if shutdown occurred with `in_progress>0`.
Use `omx sparkshell --tmux-pane ...` as an explicit opt-in operator aid for pane inspection and summaries; keep raw `tmux capture-pane` evidence available for manual intervention and proof.

## Programmatic Team Orchestration

Use the `omx team ...` CLI as the supported team-launch surface. For automation, drive the same CLI flow from scripts or supervising agents rather than relying on a separate MCP runner.

### Supported current surfaces

- **`omx team ...` CLI** — Primary method for interactive or automated team orchestration. Use this when you want direct tmux-pane visibility or a scriptable launch path.
- **Team state files** — Inspect `.omx/state/team/<team>/` when you need status, task, or mailbox evidence after launch.

### Cleanup distinction

Two cleanup paths exist and must not be confused:

- `team_cleanup` (**state-server**): Deletes team state **files** on disk (`.omx/state/team/<team>/`). Use after a team run is fully complete.
- tmux/session cleanup: Use the documented `omx team` shutdown / cleanup flow when you need to stop worker panes or clean up an interrupted run.

### Automation example

```
1. omx team 1:executor "fix bugs"
2. omx team status <team-name>
3. omx team shutdown <team-name>
4. Clean up the finished team state for <team-name>
```

## Limitations

- Worktree provisioning requires a git repository and can fail on branch/path collisions
- send-keys interactions can be timing-sensitive under load
- stale panes from prior runs can interfere until manually cleaned

## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.
