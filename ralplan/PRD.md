# PRD: Dynamic Worker Scaling for Team Mode

**Issue:** #332
**Status:** Draft - Awaiting Owner Review
**Date:** 2026-02-26
**Author:** Claude (AI-assisted design)
**Scope:** Design only - no implementation

---

## 1. Problem Statement

Team workers are fixed at spawn time. Once `omx team N:agent-type "task"` launches N workers, the topology is locked for the entire session. There is no mechanism to add workers when the workload exceeds capacity, release idle workers when demand drops, or redistribute work when imbalance is detected.

### Current Constraints (as-built)

| Constraint | Location | Value |
|---|---|---|
| Default worker count | `src/cli/team.ts:35` | 3 |
| CLI range validation | `src/cli/team.ts:47` | 1-20 |
| `DEFAULT_MAX_WORKERS` | `src/team/state.ts:228` | 20 |
| `ABSOLUTE_MAX_WORKERS` | `src/team/state.ts:229` | 20 |
| Worker CLI map enforcement | `src/team/tmux-session.ts:441` | Length must be 1 or exactly N |
| Single-team-per-session | `src/team/runtime.ts:410` | `findActiveTeams()` guard |
| Bootstrap task model | `src/cli/team.ts:72` | 1 task per worker, pre-assigned |

### Impact

- **Over-provisioning:** Users guess high N "just in case", wasting resources on idle workers that consume terminal panes and system memory.
- **Under-provisioning:** Users guess low N, and the team bottlenecks on a few workers while tasks queue up.
- **No recovery:** If a worker dies or becomes stuck, its tasks are orphaned until manual intervention.
- **Rigid topology:** Mixed teams (`OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude`) cannot adapt to shifting task composition.

---

## 2. Goals and Non-Goals

### Goals

1. **Scale Up:** Leader can request additional workers mid-session without restarting the team.
2. **Scale Down:** Idle workers are detected and can be released or repurposed.
3. **Auto-Scaling:** The system detects workload imbalance and suggests or applies adjustments.
4. **Resource Awareness:** CPU and memory limits are respected before spawning new workers.
5. **Graceful Transitions:** Workers finish their current task before being reassigned or released.

### Non-Goals

- Multi-team orchestration (multiple concurrent teams from one leader session).
- Cross-machine distributed workers (all workers remain local tmux panes or child processes).
- Automatic model/tier selection for scaled workers (uses the team's existing model resolution).
- Changes to the task state machine (`pending -> in_progress -> completed/failed`).
- Billing or cost optimization (out of scope for this feature).

---

## 3. User Stories

### US-1: Manual Scale Up

> As a team leader, I want to add workers to a running team so that I can increase throughput when the task queue is deep.

**Acceptance Criteria:**
- Leader can invoke a scale-up command (e.g., `omx team scale-up <team> [N[:agent-type]]`) while the team is active.
- New workers join the existing tmux session with new split panes.
- New workers receive the same `worker-agents.md` instructions and team state root.
- New workers can immediately claim pending tasks from the shared task queue.
- The team's `config.json` and `manifest.v2.json` are updated atomically to include new workers.
- `omx team status` reflects the expanded worker pool.

### US-2: Manual Scale Down

> As a team leader, I want to release idle workers so that I can free system resources when demand decreases.

**Acceptance Criteria:**
- Leader can invoke a scale-down command (e.g., `omx team scale-down <team> [N|worker-name]`) while the team is active.
- The system identifies which workers are idle (no `in_progress` tasks, worker status state is `idle` or `done`).
- Targeted workers receive a graceful shutdown request via the existing inbox/shutdown protocol.
- Workers finish any in-progress work before shutting down (never mid-task termination).
- Worker panes are cleaned up after shutdown acknowledgment.
- Minimum worker count of 1 is enforced (cannot scale to zero while team is active).
- Team state files are updated to remove released workers.

### US-3: Auto-Scale Recommendations

> As a team leader, I want the system to detect workload imbalance and recommend scaling actions so that I don't have to monitor task queues manually.

**Acceptance Criteria:**
- `monitorTeam()` computes a scaling recommendation based on queue depth, worker utilization, and idle time.
- Recommendations are surfaced in `omx team status` output (e.g., "Recommendation: scale up by 2 workers - 8 pending tasks, 3 busy workers").
- Recommendations are also written to a well-known state file for programmatic consumption.
- No automatic action is taken without leader confirmation (advisory mode by default).
- An opt-in auto-scaling mode (`OMX_TEAM_AUTO_SCALE=1`) enables automatic execution of recommendations.

### US-4: Resource-Aware Scaling

> As a team leader, I want the system to respect CPU and memory limits when scaling so that my machine doesn't become unresponsive.

**Acceptance Criteria:**
- Before spawning new workers, the system checks available system resources (CPU load average, available memory).
- Configurable thresholds via environment variables (`OMX_TEAM_SCALE_MAX_CPU_PERCENT`, `OMX_TEAM_SCALE_MIN_FREE_MEM_MB`).
- Scale-up requests are rejected with a clear message when resource limits would be exceeded.
- `ABSOLUTE_MAX_WORKERS` remains the hard ceiling regardless of available resources.
- Resource checks are lightweight (single `os.loadavg()` + `os.freemem()` call, no sustained monitoring daemon).

### US-5: Graceful Worker Transitions

> As a team leader, I want workers to complete their current task before being reassigned or released so that no work is lost.

**Acceptance Criteria:**
- Scale-down never interrupts a worker with `in_progress` tasks.
- When a worker is marked for release, it enters a `draining` state: it finishes current work but does not claim new tasks.
- The draining state is visible in `omx team status` output.
- A configurable drain timeout (`OMX_TEAM_DRAIN_TIMEOUT_MS`, default 5 minutes) triggers escalation (warning to leader) if the worker hasn't completed its task.
- Task reassignment (repurposing) follows the same drain-then-reassign protocol.

---

## 4. Technical Design

### 4.1 Architecture Overview

The scaling system adds three new capabilities layered on top of the existing team runtime:

```
                        +-------------------+
                        |   Leader CLI      |
                        | (scale-up/down)   |
                        +--------+----------+
                                 |
                        +--------v----------+
                        |  Scaling Engine   |  <-- NEW
                        |  (resource check, |
                        |   recommendation, |
                        |   orchestration)  |
                        +--------+----------+
                                 |
              +------------------+------------------+
              |                  |                   |
     +--------v------+  +-------v-------+  +--------v--------+
     | Worker Spawner |  | Worker Drainer|  | State Reconciler|
     | (addWorker)    |  | (drainWorker) |  | (config update) |
     +---------------+  +---------------+  +-----------------+
```

### 4.2 State Changes

#### 4.2.1 New Fields in `config.json`

```typescript
interface TeamConfig {
  // ... existing fields ...

  /** Original worker count at team creation. */
  initial_worker_count: number;

  /** Current active worker count (may differ from initial after scaling). */
  active_worker_count: number;

  /** Workers marked for draining (finishing current work, no new claims). */
  draining_workers: string[];

  /** Scaling policy configuration. */
  scaling: {
    /** Whether auto-scaling recommendations are enabled. */
    auto_recommend: boolean;
    /** Whether auto-scaling actions are enabled (requires auto_recommend). */
    auto_apply: boolean;
    /** Minimum workers (floor). Default: 1. */
    min_workers: number;
    /** Maximum workers (ceiling, <= ABSOLUTE_MAX_WORKERS). */
    max_workers: number;
    /** Pending-tasks-per-worker ratio that triggers scale-up recommendation. */
    scale_up_threshold: number;    // default: 3.0
    /** Idle-worker ratio that triggers scale-down recommendation. */
    scale_down_threshold: number;  // default: 0.5
    /** Cooldown between scaling actions in ms. */
    cooldown_ms: number;           // default: 60000
    /** Timestamp of last scaling action. */
    last_scale_action_at: string | null;
  };

  /** Resource limits for scaling decisions. */
  resource_limits: {
    max_cpu_percent: number;       // default: 80
    min_free_mem_mb: number;       // default: 512
  };
}
```

#### 4.2.2 New Worker States

The existing `WorkerStatus.state` union gains one value. Note: the `state` field lives on `WorkerStatus` (`state.ts:56-61`), not on `WorkerHeartbeat` (`state.ts:49-54`) which tracks `pid`, `last_turn_at`, `turn_count`, and `alive`.

```typescript
// WorkerStatus.state (src/team/state.ts:57)
type WorkerState = 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'unknown'
  | 'draining';  // <-- NEW: finishing current task, will not claim new work
```

#### 4.2.3 New State File: `scaling-history.json`

```typescript
interface ScalingEvent {
  timestamp: string;
  action: 'scale_up' | 'scale_down' | 'recommendation';
  trigger: 'manual' | 'auto';
  workers_added?: string[];
  workers_removed?: string[];
  reason: string;
  resource_snapshot: {
    cpu_load_1m: number;
    free_mem_mb: number;
    active_workers: number;
    pending_tasks: number;
    idle_workers: number;
  };
}
```

Located at `.omx/state/team/<team>/scaling-history.json`. Append-only log, capped at 100 entries (FIFO eviction).

### 4.3 New CLI Commands

#### `omx team scale-up <team> [N[:agent-type]]`

1. Validate team exists and is active.
2. Check resource limits (CPU, memory).
3. Validate `active_worker_count + N <= max_workers`.
4. Check scaling cooldown.
5. For each new worker:
   a. Generate worker identity (`worker-{next_index}`).
   b. Create tmux split pane in the existing team session.
   c. Launch worker CLI with team environment variables.
   d. Wait for readiness (`waitForWorkerReady`).
   e. Write initial inbox with pending task list.
   f. Trigger via `sendToWorker`.
6. Update `config.json` and `manifest.v2.json` atomically.
7. Log scaling event.

#### `omx team scale-down <team> [N|worker-name]`

1. Validate team exists and is active.
2. If worker name specified, target that worker. Otherwise, select N idle workers (preference: longest idle time, no in-progress tasks).
3. Validate `active_worker_count - N >= min_workers`.
4. For each targeted worker:
   a. If worker has `in_progress` tasks: mark as `draining` in config, set heartbeat state to `draining`. Worker finishes current task but `claimTask()` rejects new claims from draining workers.
   b. If worker is already idle: send shutdown request immediately.
5. Monitor draining workers. On task completion, send shutdown request.
6. On shutdown ACK, clean up pane and remove from config.
7. Log scaling event.

#### `omx team scale-auto <team> [on|off]`

Toggle auto-scaling mode. When on:
- `monitorTeam()` evaluates scaling policy on each poll cycle.
- If `pending_tasks / active_workers > scale_up_threshold` and cooldown has elapsed: auto scale-up by `ceil(pending / scale_up_threshold) - active` workers (capped by `max_workers` and resource limits).
- If `idle_workers / active_workers > scale_down_threshold` and cooldown has elapsed: auto scale-down by `idle_workers - ceil(active * scale_down_threshold)` workers.

### 4.4 Core Functions (New)

```
src/team/scaling.ts          -- scaling engine (resource check, recommendation, orchestration)
src/team/resource-monitor.ts -- lightweight CPU/memory sampling
```

#### `checkResourceLimits(limits: ResourceLimits): ResourceCheckResult`

Uses Node.js `os.loadavg()` and `os.freemem()`. Returns `{ allowed: boolean, cpu_load_1m: number, free_mem_mb: number, reason?: string }`.

#### `computeScalingRecommendation(snapshot: TeamSnapshot, config: TeamConfig): ScalingRecommendation`

Pure function. Inputs: current task counts, worker states, config thresholds. Outputs: `{ action: 'scale_up' | 'scale_down' | 'none', count: number, reason: string }`.

#### `addWorkers(teamName: string, count: number, agentType: string, cwd: string): Promise<string[]>`

Orchestrates pane creation, identity generation, bootstrap, and config update for N new workers. Returns the names of added workers.

#### `drainWorker(teamName: string, workerName: string, cwd: string): Promise<void>`

Marks a worker as draining. Modifies config and heartbeat state. Does not wait for completion (caller polls).

#### `removeWorker(teamName: string, workerName: string, cwd: string): Promise<void>`

Sends shutdown request, waits for ACK (with timeout), kills pane, removes worker from config.

### 4.5 Modifications to Existing Code

#### `src/team/state.ts`

- `claimTask()`: Reject claims from workers in `draining_workers` list. Check at the optimistic lock stage before writing.
- `initTeamState()`: Set `initial_worker_count = workerCount`, `active_worker_count = workerCount`, initialize `scaling` and `resource_limits` with defaults.
- `readTeamConfig()` / `saveTeamConfig()`: Handle new fields with backward-compatible defaults (missing fields fall back to current behavior).
- `teamManifestFromConfig()` (`state.ts:712`) and `teamConfigFromManifest()` (`state.ts:678`): Must be updated to round-trip the new config fields (`scaling`, `resource_limits`, `draining_workers`, `initial_worker_count`, `active_worker_count`, `next_worker_index`).
- New export: `isWorkerDraining(teamName, workerName, cwd): Promise<boolean>`.

#### `src/team/runtime.ts`

- `monitorTeam()`: Add scaling recommendation to `TeamSnapshot`. Note that `TeamSnapshot` already has a `recommendations: string[]` field (`runtime.ts:120`); extend this existing field with scaling recommendations rather than adding a separate structure. Call `computeScalingRecommendation()` and include result. If auto-scaling is enabled, execute recommendation.
- `shutdownTeam()`: Drain all active workers before shutdown (existing behavior enhanced, not replaced).

#### `src/cli/team.ts`

- New subcommands: `scale-up`, `scale-down`, `scale-auto`.
- `parseTeamArgs()`: No changes needed (existing N:agent-type syntax is for initial spawn only).

#### `src/team/tmux-session.ts`

- New export: `addPaneToSession(sessionName: string, workerSpec: WorkerProcessLaunchSpec): PaneInfo`. Splits an existing pane to add a new worker without recreating the session.
- `OMX_TEAM_WORKER_CLI_MAP` validation: Relax the "length must be 1 or exactly N" constraint to allow dynamic growth. The map becomes append-only during scale-up.

### 4.6 Prompt-Mode Transport

The prompt-mode transport (`spawnPromptWorker` via `child_process.spawn`) must also support dynamic scaling:

- `addWorkers()` detects the transport mode from `config.worker_launch_mode`.
- For `prompt` mode: spawn new child processes and register them in config.
- For `interactive` (tmux) mode: split new panes.
- The draining and shutdown protocol is transport-agnostic (uses inbox files and state, not pane-specific commands).

### 4.7 Worker Index Assignment

Current workers use sequential indices (`worker-1`, `worker-2`, ..., `worker-N`). Dynamic scaling requires:

- **Monotonic index counter** stored in `config.json` as `next_worker_index`. Never reuse indices within a session.
- Workers added via scale-up get indices starting from `next_worker_index`.
- Removed workers leave gaps in the index sequence (by design, to avoid identity confusion).

---

## 5. Scaling Policy Details

### 5.1 Scale-Up Triggers

| Signal | Threshold | Default |
|---|---|---|
| Pending tasks per active worker | `> scale_up_threshold` | 3.0 |
| All workers in `working` state | AND pending > 0 | N/A |
| Resource headroom available | CPU < max, mem > min | 80% / 512 MB |
| Cooldown elapsed | `> cooldown_ms` since last action | 60s |

**Scale-up formula:**
```
desired = ceil(pending_tasks / scale_up_threshold)
to_add  = min(desired - active_workers, max_workers - active_workers)
to_add  = min(to_add, resource_allowed_count)
```

Where `resource_allowed_count` is estimated as:
```
per_worker_mem_mb = 200  // empirical estimate for CLI process
resource_allowed  = floor((free_mem_mb - min_free_mem_mb) / per_worker_mem_mb)
```

### 5.2 Scale-Down Triggers

| Signal | Threshold | Default |
|---|---|---|
| Idle worker ratio | `> scale_down_threshold` | 0.5 |
| Worker idle duration | `> idle_timeout_ms` | 120s (2 min) |
| No pending tasks | AND idle workers > min_workers | N/A |
| Cooldown elapsed | `> cooldown_ms` since last action | 60s |

**Scale-down formula:**
```
idle_count  = count(workers where state == 'idle' && idle_duration > idle_timeout)
to_remove   = min(idle_count, active_workers - min_workers)
```

**Worker selection priority for removal (highest first):**
1. Longest idle duration.
2. No in-progress tasks.
3. Highest worker index (newest workers released first - LIFO).

### 5.3 Cooldown and Stability

- After any scaling action, a cooldown period prevents thrashing.
- Default cooldown: 60 seconds (configurable via `OMX_TEAM_SCALE_COOLDOWN_MS`).
- During cooldown, recommendations are still computed and logged but not acted upon.
- If the same recommendation persists across 3 consecutive poll cycles, it is flagged as `high_confidence`.

---

## 6. Environment Variables (New)

| Variable | Type | Default | Description |
|---|---|---|---|
| `OMX_TEAM_AUTO_SCALE` | `0\|1` | `0` | Enable automatic scaling actions |
| `OMX_TEAM_SCALE_MAX_CPU_PERCENT` | number | `80` | CPU load threshold (1-min avg as %) |
| `OMX_TEAM_SCALE_MIN_FREE_MEM_MB` | number | `512` | Minimum free memory before rejecting scale-up |
| `OMX_TEAM_SCALE_COOLDOWN_MS` | number | `60000` | Cooldown between scaling actions |
| `OMX_TEAM_SCALE_UP_THRESHOLD` | number | `3.0` | Pending-tasks-per-worker ratio for scale-up |
| `OMX_TEAM_SCALE_DOWN_THRESHOLD` | number | `0.5` | Idle-worker ratio for scale-down |
| `OMX_TEAM_SCALE_IDLE_TIMEOUT_MS` | number | `120000` | Worker idle duration before eligible for release |
| `OMX_TEAM_DRAIN_TIMEOUT_MS` | number | `300000` | Max drain wait before escalation warning |
| `OMX_TEAM_SCALE_MIN_WORKERS` | number | `1` | Floor for scale-down |
| `OMX_TEAM_SCALE_PER_WORKER_MEM_MB` | number | `200` | Estimated memory per worker for resource checks |

---

## 7. Observability

### 7.1 Status Output Enhancement

`omx team status <team>` gains a new scaling section:

```
Team: my-feature (active, 5 workers)
  Workers: 3 working, 1 idle, 1 draining
  Tasks: 2 completed, 3 in_progress, 5 pending
  Scaling:
    Mode: auto (cooldown: 45s remaining)
    Recommendation: scale-up by 2 (reason: 5 pending / 3 active = 1.67 > threshold)
    History: +2 workers at 14:30, -1 worker at 14:35
    Resources: CPU 45%, Memory 2.1 GB free
```

### 7.2 Scaling History

`omx team scale-history <team>` prints the scaling event log from `scaling-history.json`.

### 7.3 Leader Notifications

- Scale-up/down actions trigger `tmux display-message` notifications to the leader pane.
- Auto-scaling actions include the reason in the notification.
- Drain timeout warnings are surfaced as high-priority notifications.

---

## 8. Edge Cases and Failure Modes

### 8.1 Scale-Up During Scale-Down (and vice versa)

- Scaling actions are serialized through a file-based lock (`scaling.lock` in team state directory).
- If a scale-down is in progress (workers draining), a scale-up can proceed for new workers but cannot cancel an in-progress drain.
- If conflicting actions are requested simultaneously, the lock holder wins and the other receives an error.

### 8.2 Worker Fails During Drain

- If a draining worker's process dies before completing its task:
  - The task remains `in_progress` with an expired lease.
  - The lease expiration mechanism (existing `DEFAULT_CLAIM_LEASE_MS = 15 min`) eventually frees the task.
  - `monitorTeam()` detects the dead worker and marks the task for reassignment.
  - A new healthy worker can claim the freed task.

### 8.3 Resource Exhaustion Mid-Session

- If the system runs low on resources after workers are already spawned, scaling does not retroactively kill workers.
- The resource check only gates new scale-up requests.
- `omx team status` surfaces a resource warning when limits are approached.

### 8.4 Tmux Pane Limit

- Tmux has practical limits on pane count per window (varies by terminal size).
- After ~8-10 panes, individual panes become too small to be useful.
- The scaling engine should warn when pane count exceeds a configurable threshold (`OMX_TEAM_SCALE_PANE_WARN`, default 8).
- For large worker counts, recommend prompt-mode transport instead.

### 8.5 CLI Map Incompatibility

- When `OMX_TEAM_WORKER_CLI_MAP` was set at startup with an exact-length list, dynamically added workers need a CLI assignment.
- Resolution: new workers inherit from `OMX_TEAM_WORKER_CLI` (broadcast mode) or default to the team's primary agent CLI.
- The strict length validation in `tmux-session.ts:441` is relaxed to allow maps shorter than the current worker count (missing entries use the fallback).

### 8.6 Stale Scaling Lock Recovery

- If the leader process dies mid-scaling operation, the `scaling.lock` file becomes orphaned.
- The scaling lock follows the same stale-lock recovery pattern as existing team locks: locks older than `LOCK_STALE_MS` (5 min, `state.ts:231`) are considered stale and can be safely reclaimed.
- On each scaling operation, check lock age before acquiring. If stale, log a warning and override.

### 8.7 Manifest Schema Version

- Adding new fields to `config.json` and `manifest.v2.json` should be handled as backward-compatible extensions of the v2 schema (all new fields are optional with defaults).
- If a future change requires breaking the manifest format, bump `schema_version` to 3. For this feature, optional-field extension is sufficient and no version bump is needed.
- `readTeamConfig()` migration logic (Section 8.8) ensures old manifests are populated with defaults.

### 8.8 Backward Compatibility

- Teams created before this feature lack the new config fields.
- `readTeamConfig()` applies defaults for missing fields:
  - `initial_worker_count = workers.length`
  - `active_worker_count = workers.length`
  - `draining_workers = []`
  - `scaling = { auto_recommend: false, auto_apply: false, min_workers: 1, max_workers: DEFAULT_MAX_WORKERS, ... }`
  - `resource_limits = { max_cpu_percent: 80, min_free_mem_mb: 512 }`
- Old teams function identically to today (no scaling, fixed topology).

---

## 9. Security Considerations

- **Resource limits prevent DoS:** Auto-scaling respects CPU/memory bounds, preventing runaway worker spawning.
- **File-based locking:** Scaling operations use filesystem locks to prevent race conditions between concurrent CLI invocations.
- **No privilege escalation:** New workers inherit the same permissions and environment as the original team. No new trust boundaries are crossed.
- **State file integrity:** Atomic writes (`writeAtomic`) are used for all config and manifest updates, consistent with existing patterns.
- **Worker identity:** Monotonic indices prevent identity reuse. A removed `worker-5` is never replaced by a new `worker-5` in the same session.

---

## 10. Testing Strategy

### Unit Tests

- `computeScalingRecommendation()` with various task/worker distributions.
- `checkResourceLimits()` with mocked `os.loadavg()` and `os.freemem()`.
- `claimTask()` rejection for draining workers.
- Config migration (old configs without scaling fields).
- Worker index monotonicity across add/remove cycles.
- Scale-down worker selection priority logic.

### Integration Tests

- Full scale-up flow: spawn team with 2 workers, scale up to 4, verify all 4 claim tasks.
- Full scale-down flow: spawn team with 4 workers, complete all tasks, scale down to 2, verify pane cleanup.
- Drain flow: scale down while a worker is in_progress, verify it completes before shutdown.
- Cooldown enforcement: rapid scale requests are throttled.
- Resource limit rejection: mock low memory, verify scale-up is denied.
- Auto-scaling cycle: create task surplus, verify recommendation appears in status.

### Manual / QA Tests

- Visual verification of tmux pane layout after scale-up/down.
- HUD display updates during scaling events.
- Prompt-mode transport scaling (non-tmux path).
- Mixed CLI team scaling (codex + claude workers).

---

## 11. Rollout Plan

### Phase 1: Foundation (Manual Scaling)

- Implement `addWorkers()`, `drainWorker()`, `removeWorker()`.
- Add `scale-up` and `scale-down` CLI subcommands.
- Add draining state and `claimTask()` guard.
- Update config schema with backward-compatible defaults.
- Monotonic worker index counter.

### Phase 2: Observability

- Scaling recommendation in `monitorTeam()` output.
- Enhanced `omx team status` display.
- `scaling-history.json` logging.
- Leader pane notifications.

### Phase 3: Resource Awareness

- `checkResourceLimits()` implementation.
- Resource gating on scale-up.
- Resource warnings in status output.
- Pane count warnings.

### Phase 4: Auto-Scaling

- `scale-auto` CLI subcommand.
- Auto-scaling loop in `monitorTeam()`.
- Cooldown and stability mechanisms.
- High-confidence recommendation flagging.

---

## 12. Open Questions

1. **Should `ABSOLUTE_MAX_WORKERS` be raised from 20?** The current value is shared with `DEFAULT_MAX_WORKERS`. Dynamic scaling may need a higher absolute ceiling (e.g., 50) while keeping the default lower.

2. **Should scaled workers inherit the original team's `agentType` or allow mixed types?** The `scale-up` command accepts an optional `agent-type` parameter, but should the default be the team's original type or configurable?

3. **Should auto-scaling be aware of task complexity?** Simple tasks might not need additional workers even with a deep queue, while complex tasks might warrant more parallelism.

4. **Prompt-mode priority:** Should prompt-mode transport support be included in Phase 1, or deferred? It has no pane layout concerns but requires different process management.

5. **Worker reuse vs. fresh spawn:** When scaling up after a scale-down, should the system prefer reusing still-alive but idle workers (if any remain in a "suspended" state) over spawning fresh ones?

---

## 13. Appendix: Current Architecture Reference

### File Layout (Team State)

```
.omx/state/team/<team>/
  config.json              # Team configuration (workers, session, policies)
  manifest.v2.json         # Manifest with worker/task metadata
  worker-agents.md         # Shared worker instructions
  scaling-history.json     # NEW: scaling event log
  scaling.lock             # NEW: file-based scaling operation lock
  tasks/
    task-1.json            # Individual task files
    task-2.json
  workers/
    worker-1/
      identity.json        # Worker identity
      inbox.md             # Leader -> worker instructions
      heartbeat.json       # Worker health/activity
      status.json          # Worker current state
    worker-2/
      ...
  mailbox/
    leader-fixed.json      # Worker -> leader ACKs
    worker-1.json          # Directed messages
    worker-2.json
```

### Communication Channels

| Channel | Direction | Mechanism | Latency |
|---|---|---|---|
| Inbox | Leader -> Worker | File write + tmux send-keys trigger | ~1-2s |
| Mailbox | Worker -> Leader | JSON file + poll in monitorTeam() | Poll-dependent |
| Mailbox | Peer -> Peer | JSON file + tmux send-keys trigger | ~1-2s |
| Shutdown | Leader -> Worker | Inbox with shutdown flag | ~1-2s + drain time |
| Heartbeat | Worker -> State | Periodic file write | Worker turn interval |

### Key Constants

| Constant | Value | Location |
|---|---|---|
| `DEFAULT_MAX_WORKERS` | 20 | `src/team/state.ts:228` |
| `ABSOLUTE_MAX_WORKERS` | 20 | `src/team/state.ts:229` |
| `DEFAULT_CLAIM_LEASE_MS` | 15 min | `src/team/state.ts:230` |
| `LOCK_STALE_MS` | 5 min | `src/team/state.ts:231` |
| Shutdown grace period | 15 s | `src/team/runtime.ts` (shutdownTeam) |
| Leader nudge interval | 120 s | `OMX_TEAM_LEADER_NUDGE_MS` |
| Worker readiness timeout | 45 s | `OMX_TEAM_READY_TIMEOUT_MS` |
