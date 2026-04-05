/**
 * Team monitor — snapshot collection & monitor-cycle orchestration.
 *
 * Handles polling tasks/workers/integration, emitting derived events,
 * rebalancing tasks, and persisting the monitor snapshot.
 */
import { performance } from 'perf_hooks';

import { sanitizeTeamName, isWorkerAlive } from './tmux-session.js';
import {
  type TeamConfig,
  type TeamTask,
  teamReadConfig as readTeamConfig,
  teamReadManifest as readTeamManifestV2,
  teamReadWorkerHeartbeat as readWorkerHeartbeat,
  teamReadWorkerStatus as readWorkerStatus,
  teamReclaimExpiredTaskClaim as reclaimExpiredTaskClaim,
  teamListTasks as listTasks,
  teamAppendEvent as appendTeamEvent,
  teamMarkMessageDelivered as markMessageDelivered,
  teamListMailbox as listMailboxMessages,
  teamReadMonitorSnapshot as readMonitorSnapshot,
  teamWriteMonitorSnapshot as writeMonitorSnapshot,
  teamReadPhase as readTeamPhaseState,
  teamWritePhase as writeTeamPhaseState,
  type TeamMonitorSnapshotState,
  type TeamPhaseState,
} from './team-ops.js';
import { type TeamPhase, type TerminalPhase } from './orchestrator.js';
import { inferPhaseTargetFromTaskCounts, reconcilePhaseStateForMonitor } from './phase-controller.js';
import { hasStructuredVerificationEvidence } from '../verification/verifier.js';
import { buildRebalanceDecisions } from './rebalance-policy.js';
import { readModeState, updateModeState } from '../modes/base.js';
import { isPromptWorkerAlive } from './runtime-prompt-worker.js';
import { integrateWorkerCommitsIntoLeader } from './runtime-integration.js';
import { resolveDispatchPolicy, deliverPendingMailboxMessages } from './runtime-dispatch.js';
import type { TeamTask, WorkerStatus, WorkerHeartbeat } from './team-ops.js';
import type { TeamPhase, TerminalPhase } from './orchestrator.js';

/** Local snapshot type — avoids importing from runtime.ts to prevent circular deps */
interface MonitorTeamSnapshot {
  teamName: string;
  phase: TeamPhase | TerminalPhase;
  workers: Array<{
    name: string;
    alive: boolean;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    turnsWithoutProgress: number;
  }>;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
    items: TeamTask[];
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  nonReportingWorkers: string[];
  recommendations: string[];
  performance?: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    mailbox_delivery_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

// ── Sync root team mode state (terminal phase) ──
// This is a thin copy from runtime.ts to avoid circular dep.
// Inlined because it's a tiny utility (~30 lines).

async function syncRootTeamModeStateOnTerminalPhase(
  teamName: string,
  phase: TeamPhase | TerminalPhase,
  cwd: string,
): Promise<void> {
  if (phase !== 'complete' && phase !== 'failed' && phase !== 'cancelled') return;

  try {
    const teamState = await readModeState('team', cwd);
    if (!teamState) return;

    const stateTeamName = typeof teamState.team_name === 'string' ? teamState.team_name.trim() : '';
    if (stateTeamName && stateTeamName !== teamName) return;

    const alreadySynced = teamState.active === false
      && teamState.current_phase === phase
      && typeof teamState.completed_at === 'string'
      && teamState.completed_at.length > 0;
    if (alreadySynced) return;

    const updates: Record<string, unknown> = {
      active: false,
      current_phase: phase,
      team_name: teamName,
    };
    if (typeof teamState.completed_at !== 'string' || !teamState.completed_at) {
      updates.completed_at = new Date().toISOString();
    }

    await updateModeState('team', updates, cwd);
  } catch {
    // Best-effort compatibility sync only.
  }
}

// ── Forward ref to avoid circular dep (assignTask lives in runtime.ts) ──

let _assignTask: ((teamName: string, workerName: string, taskId: string, cwd: string) => Promise<void>) | undefined;

export function injectAssignTask(fn: typeof _assignTask): void {
  _assignTask = fn;
}

// ── Emit monitor derived events (forward-ref) ──

let _emitMonitorDerivedEvents: ((teamName: string, tasks: TeamTask[], workers: TeamSnapshot['workers'], previous: TeamMonitorSnapshotState | null, workerLaunchMode: TeamConfig['worker_launch_mode'], cwd: string) => Promise<void>) | undefined;

export function injectEmitMonitorDerivedEvents(fn: typeof _emitMonitorDerivedEvents): void {
  _emitMonitorDerivedEvents = fn;
}

// ── Main monitor entry point ──

export async function monitorTeam(teamName: string, cwd: string): Promise<MonitorTeamSnapshot | null> {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  const sessionName = config.tmux_session;
  const listTasksStartMs = performance.now();
  const allTasks = await listTasks(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;

  const reclaimedTaskIds: string[] = [];
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.claim?.leased_until) continue;
    if (new Date(task.claim.leased_until) > new Date()) continue;
    const reclaimed = await reclaimExpiredTaskClaim(sanitized, task.id, cwd);
    if (reclaimed.ok && reclaimed.reclaimed) reclaimedTaskIds.push(task.id);
  }
  let taskView = reclaimedTaskIds.length > 0 ? await listTasks(sanitized, cwd) : allTasks;
  const taskById = new Map(taskView.map((task) => [task.id, task] as const));
  const inProgressByOwner = new Map<string, TeamTask[]>();
  for (const task of taskView) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  const workers: TeamSnapshot['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const alive = config.worker_launch_mode === 'prompt'
        ? isPromptWorkerAlive(config, worker)
        : isWorkerAlive(sessionName, worker.index, worker.pane_id);
      const [status, heartbeat] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
      ]);
      return { worker, alive, status, heartbeat };
    })
  );
  const workerScanMs = performance.now() - workerScanStartMs;

  for (const { worker: w, alive, status, heartbeat } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
    const currentTaskId = status.current_task_id ?? '';
    const turnsWithoutProgress =
      heartbeat &&
      previousTurns !== null &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId !== '' &&
      previousTaskId === currentTaskId
        ? Math.max(0, heartbeat.turn_count - previousTurns)
        : 0;

    workers.push({
      name: w.name,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress,
    });

    if (!alive) {
      deadWorkers.push(w.name);
      const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }

    if (alive && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
      recommendations.push(`Send reminder to non-reporting ${w.name}`);
    }
  }

  for (const taskId of reclaimedTaskIds) {
    recommendations.push(`Reclaimed expired claim for task-${taskId}`);
  }
  const rebalanceDecisions = buildRebalanceDecisions({
    tasks: taskView,
    workers: workers.map((worker) => ({
      name: worker.name,
      role: config.workers.find((entry) => entry.name === worker.name)?.role,
      alive: worker.alive,
      status: worker.status,
    })),
    reclaimedTaskIds,
  });

  let assignedDuringMonitor = false;
  for (const decision of rebalanceDecisions) {
    if (decision.type === 'assign' && decision.taskId && decision.workerName) {
      if (_assignTask) {
        try {
          await _assignTask(sanitized, decision.workerName, decision.taskId, cwd);
          recommendations.push(`Assigned task-${decision.taskId} to ${decision.workerName}: ${decision.reason}`);
          assignedDuringMonitor = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recommendations.push(`Unable to assign task-${decision.taskId} to ${decision.workerName}: ${message}`);
        }
      } else {
        recommendations.push(`assignTask not injected; skipping ${decision.reason}`);
      }
    } else {
      recommendations.push(decision.reason);
    }
  }

  if (assignedDuringMonitor) {
    taskView = await listTasks(sanitized, cwd);
  }

  const taskCounts = {
    total: taskView.length,
    pending: taskView.filter(t => t.status === 'pending').length,
    blocked: taskView.filter(t => t.status === 'blocked').length,
    in_progress: taskView.filter(t => t.status === 'in_progress').length,
    completed: taskView.filter(t => t.status === 'completed').length,
    failed: taskView.filter(t => t.status === 'failed').length,
  };

  const verificationPendingTasks = taskView.filter(
    (task) => task.status === 'completed'
      && task.requires_code_change === true
      && !hasStructuredVerificationEvidence(task.result),
  );
  if (verificationPendingTasks.length > 0) {
    for (const task of verificationPendingTasks) {
      recommendations.push(`Verification evidence missing for task-${task.id}; require structured PASS/FAIL evidence before terminal success`);
    }
  }

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
  const deadWorkerStall =
    config.worker_launch_mode === 'prompt'
    && config.workers.length > 0
    && deadWorkers.length >= config.workers.length
    && !allTasksTerminal;

  const persistedPhase = await readTeamPhaseState(sanitized, cwd);
  const targetPhase = deadWorkerStall
    ? 'failed'
    : inferPhaseTargetFromTaskCounts(taskCounts, {
      verificationPending: verificationPendingTasks.length > 0,
    });
  const phaseState: TeamPhaseState = reconcilePhaseStateForMonitor(persistedPhase, targetPhase);
  await writeTeamPhaseState(sanitized, phaseState, cwd);
  const phase: TeamPhase | TerminalPhase = phaseState.current_phase;
  await syncRootTeamModeStateOnTerminalPhase(sanitized, phase, cwd);

  if (deadWorkerStall) {
    recommendations.push('All workers are dead while work remains; mark the team failed or restart with fresh workers.');
  }

  if (_emitMonitorDerivedEvents) {
    await _emitMonitorDerivedEvents(sanitized, taskView, workers, previousSnapshot, config.worker_launch_mode, cwd);
  }

  const integrationByWorker = await integrateWorkerCommitsIntoLeader({
    teamName: sanitized,
    config,
    previous: previousSnapshot,
    cwd,
  });

  const mailboxDeliveryStartMs = performance.now();
  const mailboxNotifiedByMessageId = await deliverPendingMailboxMessages(
    sanitized,
    config,
    workers,
    previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    dispatchPolicy,
    cwd
  );
  const mailboxDeliveryMs = performance.now() - mailboxDeliveryStartMs;

  // Prune ephemeral status messages from leader mailbox (TTL: 60s)
  try {
    const leaderMailbox = await listMailboxMessages(sanitized, 'leader-fixed', cwd);
    const now = Date.now();
    for (const msg of leaderMailbox) {
      if (msg.from_worker === 'system' && msg.created_at) {
        const age = now - new Date(msg.created_at).getTime();
        if (age > 60_000) {
          await markMessageDelivered(sanitized, 'leader-fixed', msg.message_id, cwd);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
  }

  const updatedAt = new Date().toISOString();
  const totalMs = performance.now() - monitorStartMs;
  await writeMonitorSnapshot(
    sanitized,
    {
      taskStatusById: Object.fromEntries(taskView.map((t) => [t.id, t.status])),
      workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
      workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
      workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
      workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
      mailboxNotifiedByMessageId,
      completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
      integrationByWorker,
      monitorTimings: {
        list_tasks_ms: Number(listTasksMs.toFixed(2)),
        worker_scan_ms: Number(workerScanMs.toFixed(2)),
        mailbox_delivery_ms: Number(mailboxDeliveryMs.toFixed(2)),
        total_ms: Number(totalMs.toFixed(2)),
        updated_at: updatedAt,
      },
    },
    cwd
  );

  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: taskView,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
    performance: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      mailbox_delivery_ms: Number(mailboxDeliveryMs.toFixed(2)),
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  };
}
