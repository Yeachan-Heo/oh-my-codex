---
name: team
description: N coordinated agents on shared task list using tmux-based orchestration
---

# Team Skill

`$team` is the tmux-based parallel execution mode for OMX. It starts real worker Codex sessions in split panes and coordinates them through `.omx/state/team/...` files plus MCP team tools.

This skill is operationally sensitive. Treat it as an operator workflow, not a generic prompt pattern.

## What This Skill Must Do

When user triggers `$team`, the agent must:

1. Invoke OMX runtime directly with `omx team ...`
2. Avoid replacing the flow with in-process `spawn_agent` fanout
3. Verify startup and surface concrete state/pane evidence
4. Keep team state alive until workers are terminal (unless explicit abort)
5. Handle cleanup and stale-pane recovery when needed

If `omx team` is unavailable, stop with a hard error.

## Invocation Contract

```bash
omx team [ralph] [N:agent-type] "<task description>"
```

Examples:

```bash
omx team 3:executor "analyze feature X and report flaws"
omx team "debug flaky integration tests"
omx team ralph "ship end-to-end fix with verification"
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

## Current Runtime Behavior (As Implemented)

`omx team` currently performs:

1. Parse args (`ralph`, `N`, `agent-type`, task)
2. Sanitize team name from task text
3. Initialize team state:
   - `.omx/state/team/<team>/config.json`
   - `.omx/state/team/<team>/manifest.v2.json`
   - `.omx/state/team/<team>/tasks/task-<id>.json`
4. Apply worker overlay to project `AGENTS.md`
5. Split current tmux window into worker panes
6. Launch workers with `OMX_TEAM_WORKER=<team>/worker-<n>`
7. Wait for worker readiness (`capture-pane` polling)
8. Write per-worker `inbox.md` and trigger via `tmux send-keys`
9. Return control to leader; follow-up uses `status` / `resume` / `shutdown`

Important:

- Leader remains in existing pane
- Worker panes are independent full Codex sessions
- Worker ACKs go to `mailbox/leader-fixed.json`
- Notify hook updates worker heartbeat and nudges leader during active team mode

### Team worker model resolution (current contract)

Team mode resolves worker model flags from one shared launch-arg set (not per-worker model selection).

Precedence (highest to lowest):
1. Explicit worker model in `OMX_TEAM_WORKER_LAUNCH_ARGS`
2. Inherited leader `--model` flag
3. Injected low-complexity default: `gpt-5.3-codex-spark` (only when 1+2 are absent and team `agentType` is low-complexity)

Normalization requirements:
- Parse both `--model <value>` and `--model=<value>`
- Remove duplicate/conflicting model flags
- Emit exactly one final canonical flag: `--model <value>`
- Preserve unrelated args in worker launch config

## Required Lifecycle (Operator Contract)

Follow this exact lifecycle when running `$team`:

1. Start team and verify startup evidence (team line, tmux target, panes, ACK mailbox)
2. Monitor task and worker progress (`omx team status <team>`)
3. Wait for terminal task state before shutdown:
   - `pending=0`
   - `in_progress=0`
   - `failed=0` (or explicitly acknowledged failure path)
4. Only then run `omx team shutdown <team>`
5. Verify shutdown evidence and state cleanup

Do not run `shutdown` while workers are actively writing updates unless user explicitly requested abort/cancel.

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

### Key Files

- `.omx/state/team/<team>/config.json`
- `.omx/state/team/<team>/manifest.v2.json`
- `.omx/state/team/<team>/tasks/task-<id>.json`
- `.omx/state/team/<team>/workers/worker-<n>/identity.json`
- `.omx/state/team/<team>/workers/worker-<n>/inbox.md`
- `.omx/state/team/<team>/workers/worker-<n>/heartbeat.json`
- `.omx/state/team/<team>/workers/worker-<n>/status.json`
- `.omx/state/team-leader-nudge.json`

## Team + Worker Protocol Notes

Leader-to-worker:

- Write full assignment to worker `inbox.md`
- Send short trigger (<200 chars) with `tmux send-keys`

Worker-to-leader:

- Send ACK to `leader-fixed` mailbox via `team_send_message`
- Claim task via state API, execute, update task + status

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
- `OMX_TEAM_WORKER_LAUNCH_ARGS`
  - Extra args passed to worker `codex` launch
- `OMX_TEAM_LEADER_NUDGE_MS`
  - Leader nudge interval in ms (default 120000)
- `OMX_TEAM_STRICT_SUBMIT=1`
  - Force strict send-keys submit failure behavior

## Failure Modes and Diagnosis

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
3. Worker skill loaded and `team_send_message` called
4. Task-id mismatch not blocking worker flow

### Worker logs `team_send_message ENOENT` / `team_update_task ENOENT`

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

## Limitations

- No git worktree isolation; workers share working tree
- send-keys interactions can be timing-sensitive under load
- stale panes from prior runs can interfere until manually cleaned
