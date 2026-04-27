# Team Allocation and Rebalance Policy Notes

This note documents the current team-mode allocation/rebalance seam and the constraints that the phased allocation/rebalance upgrade must preserve.

## Current baseline

### Startup allocation
- `buildTeamExecutionPlan()` splits the top-level request, routes each subtask to a role, then assigns owners via `distributeTasksToWorkers()`.
- Ownership now flows through `allocateTasksToWorkers()` so startup assignment stays lane-aware instead of pure round-robin (`src/cli/team.ts`, `src/team/allocation-policy.ts`).
- The current heuristic keeps same-role work grouped when possible, prefers explicit worker-role matches, and falls back to load balancing with lighter-lane bias for blocked work.
- Atomic tasks still fan out into the fixed aspect trio: implement, test, review/document, but each lane now carries an `allocation_reason` for traceability before CLI output strips the internal field.

### Runtime monitoring
- `monitorTeam()` already gathers the signals needed for rebalance decisions: task inventory, lease expiry, worker liveness, worker status, heartbeat turn counts, and verification evidence gaps (`src/team/runtime.ts:1212-1420`).
- The runtime currently turns those signals into recommendations such as:
  - reassign work from dead workers (`src/team/runtime.ts:1288-1294`)
  - remind non-reporting workers (`src/team/runtime.ts:1297-1300`)
  - surface missing PASS/FAIL verification evidence (`src/team/runtime.ts:1313-1321`)
  - note reclaimed expired claims (`src/team/runtime.ts:1343-1345`)
- `assignTask()` remains the claim + dispatch gateway, including approval checks and post-claim rollback when worker notification fails (`src/team/runtime.ts:1426-1527`).

### Claim-safety invariants
- `claimTask()` can only move work into `in_progress` after dependency readiness succeeds and no active claim is held by another worker (`src/team/state/tasks.ts:56-113`).
- `transitionTaskStatus()` requires the active claim token before terminal completion/failure (`src/team/state/tasks.ts:132-200`).
- `releaseTaskClaim()` and `reclaimExpiredTaskClaim()` are the safe rollback/requeue paths; both clear owner + claim and return the task to `pending` (`src/team/state/tasks.ts:204-265`).

## Recommended policy seam

To keep the upgrade incremental and reversible, separate **signal collection** from **decision policy**:

1. **Allocation policy**
   - Input: decomposed tasks, routed roles, worker roster, dependency readiness, and current load.
   - Output: chosen owner, ranked fallbacks, and a short reason string.
   - Integration point: replace the round-robin-only decision inside `buildTeamExecutionPlan()` without changing task decomposition or role routing.

2. **Rebalance policy**
   - Input: the runtime snapshot inputs already assembled by `monitorTeam()`.
   - Output: structured actions (`noop`, `recommend`, `requeue`, `reassign`) plus rationale.
   - Integration point: let `monitorTeam()` compute richer actions, but keep `assignTask()` as the only real dispatch path.

## Safety rules for v1
- Do not steal active work that still has a valid claim lease.
- Only auto-reassign when work is pending, explicitly released, reclaimed after lease expiry, or attached to a dead/non-recoverable worker.
- Keep tmux layout and scale-up behavior unchanged for the first milestone.
- Preserve `.omx/state/team/...` storage and `omx team api` contracts.
- Make every allocation/rebalance decision explainable with a reason string suitable for logs, snapshots, and tests.

## Repo-aware DAG handoff seam

The repo-aware RALPLAN -> Team handoff should enter before `startTeam()` and before worker inbox generation. Keep the decomposition gate as a bounded preflight module that returns normalized startup tasks, an effective worker count, and an inspectable metadata/report payload. Runtime dispatch should remain unchanged: workers still receive tasks through inboxes and must claim through the existing lifecycle APIs.

Preflight allocation may use DAG `filePaths`, `domains`, `lane`, and symbolic dependency metadata to improve owner assignment, but only concrete runtime task IDs should reach `blocked_by` / `depends_on`. Rich metadata belongs in a decomposition report or manifest policy block unless the Team task schema intentionally supports it.

See `docs/contracts/repo-aware-team-dag-decomposition.md` for the detailed artifact precedence, worker-count provenance, dependency remap, and worker-inbox UX contract.

## Review notes
- The code already has good low-level claim primitives; the main gap is decision logic, not transport.
- The clearest review risk is letting new heuristics bypass `assignTask()`/claim safety. Any rebalance helper should return a decision, not perform ad-hoc mutation.
- Startup assignment and runtime rebalance should stay small, explicit policy seams so `src/cli/team.ts` and `src/team/runtime.ts` do not absorb another large block of inline heuristics.
- `allocation_reason` should remain explainable enough for tests, snapshots, and leader review even if the public task payload hides the internal field after planning.
