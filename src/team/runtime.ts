import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { getModelForMode } from '../config/models.js';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  createTeamSession,
  waitForWorkerReady,
  sendToWorker,
  notifyLeaderStatus,
  isWorkerAlive,
  getWorkerPanePid,
  killWorker,
  killWorkerByPaneId,
  destroyTeamSession,
  listTeamSessions,
} from './tmux-session.js';
import {
  teamInit as initTeamState,
  DEFAULT_MAX_WORKERS,
  teamReadConfig as readTeamConfig,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamReadWorkerHeartbeat as readWorkerHeartbeat,
  teamReadWorkerStatus as readWorkerStatus,
  teamWriteWorkerInbox as writeWorkerInbox,
  teamCreateTask as createStateTask,
  teamReadTask as readTask,
  teamListTasks as listTasks,
  teamReadManifest as readTeamManifestV2,
  teamClaimTask as claimTask,
  teamReleaseTaskClaim as releaseTaskClaim,
  teamAppendEvent as appendTeamEvent,
  teamReadTaskApproval as readTaskApproval,
  teamListMailbox as listMailboxMessages,
  teamMarkMessageNotified as markMessageNotified,
  teamCleanup as cleanupTeamState,
  teamSaveConfig as saveTeamConfig,
  teamWriteShutdownRequest as writeShutdownRequest,
  teamReadShutdownAck as readShutdownAck,
  teamReadMonitorSnapshot as readMonitorSnapshot,
  teamWriteMonitorSnapshot as writeMonitorSnapshot,
  type TeamConfig,
  type WorkerInfo,
  type WorkerHeartbeat,
  type WorkerStatus,
  type TeamTask,
  type ShutdownAck,
  type TeamMonitorSnapshotState,
} from './team-ops.js';
import {
  queueInboxInstruction,
  queueDirectMailboxMessage,
  queueBroadcastMailboxMessage,
} from './mcp-comm.js';
import {
  generateWorkerOverlay,
  writeTeamWorkerInstructionsFile,
  removeTeamWorkerInstructionsFile,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  generateMailboxTriggerMessage,
} from './worker-bootstrap.js';
import { type TeamPhase, type TerminalPhase } from './orchestrator.js';

/** Snapshot of the team state at a point in time */
export interface TeamSnapshot {
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
}

/** Runtime handle returned by startTeam */
export interface TeamRuntime {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
}

interface ShutdownOptions {
  force?: boolean;
}

const MODEL_FLAG = '--model';
const MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
export const TEAM_LOW_COMPLEXITY_DEFAULT_MODEL = 'gpt-5.3-codex';
const previousModelInstructionsFileByTeam = new Map<string, string | undefined>();

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function shouldSkipWorkerReadyWait(env: NodeJS.ProcessEnv): boolean {
  return env.OMX_TEAM_SKIP_READY_WAIT === '1';
}

function hasExplicitModelArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === MODEL_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && maybeValue.trim() !== '' && !maybeValue.startsWith('-')) {
        return true;
      }
      continue;
    }

    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inline = arg.slice(`${MODEL_FLAG}=`.length).trim();
      if (inline !== '') return true;
    }
  }
  return false;
}

function setTeamModelInstructionsFile(teamName: string, filePath: string): void {
  if (!previousModelInstructionsFileByTeam.has(teamName)) {
    previousModelInstructionsFileByTeam.set(teamName, process.env[MODEL_INSTRUCTIONS_FILE_ENV]);
  }
  process.env[MODEL_INSTRUCTIONS_FILE_ENV] = filePath;
}

function restoreTeamModelInstructionsFile(teamName: string): void {
  if (!previousModelInstructionsFileByTeam.has(teamName)) return;

  const previous = previousModelInstructionsFileByTeam.get(teamName);
  previousModelInstructionsFileByTeam.delete(teamName);

  if (typeof previous === 'string') {
    process.env[MODEL_INSTRUCTIONS_FILE_ENV] = previous;
    return;
  }
  delete process.env[MODEL_INSTRUCTIONS_FILE_ENV];
}

export function resolveWorkerLaunchArgsFromEnv(env: NodeJS.ProcessEnv, agentType: string, configuredModel?: string): string[] {
  // Keep it intentionally simple: whitespace split, no quoting/escaping support.
  // Primary use is passing stable Codex flags like `--no-alt-screen`.
  const raw = env.OMX_TEAM_WORKER_LAUNCH_ARGS;
  const args = (!raw || raw.trim() === '')
    ? []
    : raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (hasExplicitModelArg(args)) return args;

  // Use configured model (from .omx-config.json "models" section) for all agent types
  if (typeof configuredModel === 'string' && configuredModel.trim() !== '') {
    return [...args, MODEL_FLAG, configuredModel.trim()];
  }

  // Hardcoded fallback: all agent types get the default model
  return [...args, MODEL_FLAG, TEAM_LOW_COMPLEXITY_DEFAULT_MODEL];
}

/**
 * Start a new team: init state, create tmux session, bootstrap workers.
 */
export async function startTeam(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[] }>,
  cwd: string,
): Promise<TeamRuntime> {
  if (process.env.OMX_TEAM_WORKER) {
    throw new Error('nested_team_disallowed');
  }

  // tmux-only runtime
  if (!isTmuxAvailable()) {
    throw new Error('Team mode requires tmux. Install with: apt install tmux / brew install tmux');
  }
  const displayMode = 'split_pane';
  if (!process.env.TMUX) {
    throw new Error('Team mode requires running inside tmux current leader pane');
  }

  const leaderSessionId = await resolveLeaderSessionId(cwd);

  // Topology guard: one active team per leader session/process context.
  const activeTeams = await findActiveTeams(cwd, leaderSessionId);
  if (activeTeams.length > 0) {
    throw new Error(`leader_session_conflict: active team exists (${activeTeams.join(', ')})`);
  }

  // 2. Sanitize team name
  const sanitized = sanitizeTeamName(teamName);
  let sessionName = `omx-team-${sanitized}`;
  const overlay = generateWorkerOverlay(sanitized);
  let workerInstructionsPath: string | null = null;
  let sessionCreated = false;
  const createdWorkerPaneIds: string[] = [];
  let createdLeaderPaneId: string | undefined;
  const configuredModel = getModelForMode('team');
  const workerLaunchArgs = resolveWorkerLaunchArgsFromEnv(process.env, agentType, configuredModel);
  const workerReadyTimeoutMs = resolveWorkerReadyTimeoutMs(process.env);
  const skipWorkerReadyWait = shouldSkipWorkerReadyWait(process.env);

  try {
    // 3. Init state directory + config
    const config = await initTeamState(
      sanitized,
      task,
      agentType,
      workerCount,
      cwd,
      DEFAULT_MAX_WORKERS,
      { ...process.env, OMX_TEAM_DISPLAY_MODE: displayMode },
    );

    // 4. Create tasks
    for (const t of tasks) {
      await createStateTask(sanitized, {
        subject: t.subject,
        description: t.description,
        status: 'pending',
        owner: t.owner,
        blocked_by: t.blocked_by,
      }, cwd);
    }

    // 5. Write team-scoped worker instructions file (no mutation of project AGENTS.md)
    workerInstructionsPath = await writeTeamWorkerInstructionsFile(sanitized, cwd, overlay);
    setTeamModelInstructionsFile(sanitized, workerInstructionsPath);

    // 6. Create tmux session with workers
    const createdSession = createTeamSession(sanitized, workerCount, cwd, workerLaunchArgs);
    sessionName = createdSession.name;
    createdWorkerPaneIds.push(...createdSession.workerPaneIds);
    createdLeaderPaneId = createdSession.leaderPaneId;
    config.tmux_session = sessionName;
    config.leader_pane_id = createdSession.leaderPaneId;
    if (createdSession.hudPaneId) config.hud_pane_id = createdSession.hudPaneId;
    await saveTeamConfig(config, cwd);
    sessionCreated = true;

    // 7. Wait for all workers to be ready, then bootstrap them
    const allTasks = await listTasks(sanitized, cwd);
    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const paneId = createdSession.workerPaneIds[i - 1];

      // Get tasks assigned to this worker
      const workerTasks = allTasks.filter(t => t.owner === workerName);

      // Write worker identity
      const identity: WorkerInfo = {
        name: workerName,
        index: i,
        role: agentType,
        assigned_tasks: workerTasks.map(t => t.id),
      };

      // Get pane PID and store it
      const panePid = getWorkerPanePid(sessionName, i);
      if (panePid) identity.pid = panePid;
      if (paneId) identity.pane_id = paneId;
      if (paneId && config.workers[i - 1]) config.workers[i - 1].pane_id = paneId;

      await writeWorkerIdentity(sanitized, workerName, identity, cwd);

      // Wait for worker readiness
      if (!skipWorkerReadyWait) {
        const ready = waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);
        if (!ready) {
          throw new Error(`Worker ${workerName} did not become ready in tmux session ${sessionName}`);
        }
      }

      // Queue inbox via MCP/state then notify worker via tmux transport.
      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks);
      const trigger = generateTriggerMessage(workerName, sanitized);
      const notified = await queueInboxInstruction({
        teamName: sanitized,
        workerName,
        workerIndex: i,
        paneId,
        inbox,
        triggerMessage: trigger,
        cwd,
        notify: (_target, message) => notifyWorker(config, i, message, paneId),
      });
      if (!notified) {
        throw new Error(`worker_notify_failed:${workerName}`);
      }
    }
    await saveTeamConfig(config, cwd);

    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName,
      config,
      cwd,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];

    if (sessionCreated) {
      try {
        // In split-pane topology, we must not kill the entire tmux session; kill only created panes.
        if (sessionName.includes(':')) {
          for (const paneId of createdWorkerPaneIds) {
            try { killWorkerByPaneId(paneId, createdLeaderPaneId); } catch { /* ignore */ }
          }
        } else {
          destroyTeamSession(sessionName);
        }
      } catch (cleanupError) {
        rollbackErrors.push(`destroyTeamSession: ${String(cleanupError)}`);
      }
    }

    if (workerInstructionsPath) {
      try {
        await removeTeamWorkerInstructionsFile(sanitized, cwd);
      } catch (cleanupError) {
        rollbackErrors.push(`removeTeamWorkerInstructionsFile: ${String(cleanupError)}`);
      }
    }
    restoreTeamModelInstructionsFile(sanitized);

    try {
      await cleanupTeamState(sanitized, cwd);
    } catch (cleanupError) {
      rollbackErrors.push(`cleanupTeamState: ${String(cleanupError)}`);
    }

    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; rollback encountered errors: ${rollbackErrors.join(' | ')}`);
    }

    throw error;
  }
}

/**
 * Monitor team state by polling files. Returns a snapshot.
 */
export async function monitorTeam(teamName: string, cwd: string): Promise<TeamSnapshot | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  const sessionName = config.tmux_session;
  const allTasks = await listTasks(sanitized, cwd);
  const inProgressByOwner = new Map<string, TeamTask[]>();
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  const workers: TeamSnapshot['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  for (const w of config.workers) {
    const alive = isWorkerAlive(sessionName, w.index, w.pane_id);
    const [status, heartbeat] = await Promise.all([
      readWorkerStatus(sanitized, w.name, cwd),
      readWorkerHeartbeat(sanitized, w.name, cwd),
    ]);

    const currentTask = status.current_task_id ? allTasks.find((t) => t.id === status.current_task_id) : null;
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
      // Find in-progress tasks owned by this dead worker
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

  // Count tasks
  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter(t => t.status === 'pending').length,
    blocked: allTasks.filter(t => t.status === 'blocked').length,
    in_progress: allTasks.filter(t => t.status === 'in_progress').length,
    completed: allTasks.filter(t => t.status === 'completed').length,
    failed: allTasks.filter(t => t.status === 'failed').length,
  };

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;

  // Determine phase from state file (simplified -- read from mode state if available)
  // For now use a heuristic based on task statuses
  let phase: TeamPhase | TerminalPhase = 'team-exec';
  if (allTasksTerminal && taskCounts.failed === 0) phase = 'complete';
  else if (allTasksTerminal && taskCounts.failed > 0) phase = 'team-fix';

  await emitMonitorDerivedEvents(sanitized, allTasks, workers, previousSnapshot, cwd);
  const mailboxNotifiedByMessageId = await deliverPendingMailboxMessages(
    sanitized,
    config,
    workers,
    previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    cwd
  );
  await writeMonitorSnapshot(
    sanitized,
      {
        taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
        workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
        workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
        workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
        workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
        mailboxNotifiedByMessageId,
      },
      cwd
  );

  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: allTasks,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
  };
}

/**
 * Assign a task to a worker by writing inbox and sending trigger.
 */
export async function assignTask(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const task = await readTask(sanitized, taskId, cwd);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);

  if (manifest?.policy?.delegation_only && workerName === 'leader-fixed') {
    throw new Error('delegation_only_violation');
  }

  if (manifest?.policy?.plan_approval_required && task.requires_code_change === true) {
    const approved = await isTaskApprovedForExecution(sanitized, taskId, cwd);
    if (!approved) {
      throw new Error('plan_approval_required');
    }
  }
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const workerInfo = config.workers.find(w => w.name === workerName);
  if (!workerInfo) throw new Error(`Worker ${workerName} not found in team`);

  const claim = await claimTask(sanitized, taskId, workerName, task.version ?? 1, cwd);
  if (!claim.ok) {
    if (claim.error === 'blocked_dependency') {
      throw new Error(`blocked_dependency:${(claim.dependencies ?? []).join(',')}`);
    }
    throw new Error(claim.error);
  }

  try {
    const inbox = generateTaskAssignmentInbox(workerName, sanitized, taskId, task.description);
    const notified = await queueInboxInstruction({
      teamName: sanitized,
      workerName,
      workerIndex: workerInfo.index,
      paneId: workerInfo.pane_id,
      inbox,
      triggerMessage: generateTriggerMessage(workerName, sanitized),
      cwd,
      notify: (_target, message) => notifyWorker(config, workerInfo.index, message, workerInfo.pane_id),
    });
    if (!notified) {
      throw new Error('worker_notify_failed');
    }
  } catch (error) {
    // Roll back claim to avoid stuck in_progress tasks on any post-claim dispatch failure.
    const released = await releaseTaskClaim(sanitized, taskId, claim.claimToken, workerName, cwd);

    const reason = error instanceof Error && error.message.trim() !== ''
      ? error.message
      : 'worker_assignment_failed';

    try {
      await writeWorkerInbox(
        sanitized,
        workerName,
        `# Assignment Cancelled\n\nTask ${taskId} was not dispatched due to ${reason}.\nDo not execute this task from prior inbox content.`,
        cwd,
      );
    } catch {
      // best effort
    }

    if (!released.ok) {
      throw new Error(`${reason}:${released.error}`);
    }

    if (reason === 'worker_notify_failed') throw new Error('worker_notify_failed');
    throw new Error(`worker_assignment_failed:${reason}`);
  }
}

/**
 * Reassign a task from one worker to another.
 */
export async function reassignTask(
  teamName: string,
  taskId: string,
  _fromWorker: string,
  toWorker: string,
  cwd: string,
): Promise<void> {
  await assignTask(teamName, toWorker, taskId, cwd);
}

/**
 * Graceful shutdown: send shutdown inbox to all workers, wait, force kill, cleanup.
 */
export async function shutdownTeam(teamName: string, cwd: string, options: ShutdownOptions = {}): Promise<void> {
  const force = options.force === true;
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) {
    // No config -- just try to kill tmux session and clean up
    try { destroyTeamSession(`omx-team-${sanitized}`); } catch { /* ignore */ }
    await cleanupTeamState(sanitized, cwd);
    restoreTeamModelInstructionsFile(sanitized);
    return;
  }

  const sessionName = config.tmux_session;
  const shutdownRequestTimes = new Map<string, string>();

  // 1. Send shutdown inbox to each worker
  for (const w of config.workers) {
    try {
      const requestedAt = new Date().toISOString();
      await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
      shutdownRequestTimes.set(w.name, requestedAt);
      const notified = await queueInboxInstruction({
        teamName: sanitized,
        workerName: w.name,
        workerIndex: w.index,
        paneId: w.pane_id,
        inbox: generateShutdownInbox(sanitized, w.name),
        triggerMessage: generateTriggerMessage(w.name, sanitized),
        cwd,
        notify: (_target, message) => notifyWorker(config, w.index, message, w.pane_id),
      });
      if (!notified) {
        // best effort: worker may already be gone
      }
    } catch { /* worker might already be dead */ }
  }

  // 2. Wait up to 15s for workers to exit and collect acks
  const deadline = Date.now() + 15_000;
  const rejected: Array<{ worker: string; reason: string }> = [];
  const ackedWorkers = new Set<string>();
  while (Date.now() < deadline) {
    for (const w of config.workers) {
      const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
      if (ack && !ackedWorkers.has(w.name)) {
        ackedWorkers.add(w.name);
        await appendTeamEvent(sanitized, {
          type: 'shutdown_ack',
          worker: w.name,
          reason: ack.status === 'reject' ? `reject:${ack.reason || 'no_reason'}` : 'accept',
        }, cwd);
      }
      if (ack?.status === 'reject') {
        if (!rejected.some((r) => r.worker === w.name)) {
          rejected.push({ worker: w.name, reason: ack.reason || 'no_reason' });
        }
      }
    }
    if (rejected.length > 0 && !force) {
      const detail = rejected.map(r => `${r.worker}:${r.reason}`).join(',');
      throw new Error(`shutdown_rejected:${detail}`);
    }

    const anyAlive = config.workers.some(w => isWorkerAlive(sessionName, w.index, w.pane_id));
    if (!anyAlive) break;
    // Sleep 2s
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const anyAliveAfterWait = config.workers.some(w => isWorkerAlive(sessionName, w.index, w.pane_id));
  if (anyAliveAfterWait && !force) {
    // Workers may have accepted shutdown but not exited (Codex TUI requires explicit exit).
    // In this case, proceed to force kill panes (next step) rather than failing and leaving state around.
  }

  // 3. Force kill remaining workers
  const leaderPaneId = config.leader_pane_id;
  const hudPaneId = config.hud_pane_id;
  for (const w of config.workers) {
    try {
      // Guard: never kill the leader's own pane or the HUD pane.
      if (leaderPaneId && w.pane_id === leaderPaneId) continue;
      if (hudPaneId && w.pane_id === hudPaneId) continue;
      if (isWorkerAlive(sessionName, w.index, w.pane_id)) {
        killWorker(sessionName, w.index, w.pane_id, leaderPaneId);
      }
    } catch { /* ignore */ }
  }

  // 4. Destroy tmux session
  if (!sessionName.includes(':')) {
    try { destroyTeamSession(sessionName); } catch { /* ignore */ }
  }

  // 5. Remove team-scoped worker instructions file (no mutation of project AGENTS.md)
  try { await removeTeamWorkerInstructionsFile(sanitized, cwd); } catch { /* ignore */ }
  restoreTeamModelInstructionsFile(sanitized);

  // 6. Cleanup state
  await cleanupTeamState(sanitized, cwd);
}

/**
 * Resume monitoring an existing team.
 */
export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;

  // Check if tmux session still exists
  const sessions = listTeamSessions();
  const baseSession = config.tmux_session.split(':')[0];
  if (!sessions.includes(baseSession)) return null;

  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName: config.tmux_session,
    config,
    cwd,
  };
}

async function findActiveTeams(cwd: string, leaderSessionId: string): Promise<string[]> {
  const root = join(cwd, '.omx', 'state', 'team');
  if (!existsSync(root)) return [];
  const sessions = new Set(listTeamSessions());
  const entries = await readdir(root, { withFileTypes: true });
  const active: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const teamName = e.name;
    const cfg = await readTeamConfig(teamName, cwd);
    const manifest = await readTeamManifestV2(teamName, cwd);
    if (manifest?.policy?.one_team_per_leader_session === false) continue;
    const tmuxSession = (manifest?.tmux_session || cfg?.tmux_session || `omx-team-${teamName}`).split(':')[0];
    if (leaderSessionId) {
      const ownerSessionId = manifest?.leader?.session_id?.trim() ?? '';
      if (ownerSessionId && ownerSessionId !== leaderSessionId) continue;
    }
    if (sessions.has(tmuxSession)) active.push(teamName);
  }
  return active;
}

async function resolveLeaderSessionId(cwd: string): Promise<string> {
  const fromEnv = process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.SESSION_ID;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  const p = join(cwd, '.omx', 'state', 'session.json');
  if (!existsSync(p)) return '';
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim() !== '') return parsed.session_id.trim();
  } catch {
    return '';
  }
  return '';
}

async function isTaskApprovedForExecution(teamName: string, taskId: string, cwd: string): Promise<boolean> {
  const record = await readTaskApproval(teamName, taskId, cwd);
  return record?.status === 'approved';
}

async function emitMonitorDerivedEvents(
  teamName: string,
  tasks: TeamTask[],
  workers: TeamSnapshot['workers'],
  previous: TeamMonitorSnapshotState | null,
  cwd: string,
): Promise<void> {
  if (!previous) return;

  for (const task of tasks) {
    const prevStatus = previous.taskStatusById[task.id];
    if (prevStatus && prevStatus !== 'completed' && task.status === 'completed') {
      await appendTeamEvent(
        teamName,
        {
          type: 'task_completed',
          worker: task.owner || 'unknown',
          task_id: task.id,
          message_id: null,
          reason: undefined,
        },
        cwd
      );
    }
  }

  for (const worker of workers) {
    const prevAlive = previous.workerAliveByName[worker.name];
    if (prevAlive === true && worker.alive === false) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_stopped',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
        },
        cwd
      );
    }

    const prevState = previous.workerStateByName[worker.name];
    if (prevState && prevState !== 'idle' && worker.status.state === 'idle') {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_idle',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: undefined,
        },
        cwd
      );
    }
  }
}

function notifyWorker(config: TeamConfig, workerIndex: number, message: string, workerPaneId?: string): boolean {
  if (!config.tmux_session || !isTmuxAvailable()) return false;
  try {
    sendToWorker(config.tmux_session, workerIndex, message, workerPaneId);
    return true;
  } catch {
    return false;
  }
}

function notifyLeader(config: TeamConfig, message: string): boolean {
  if (!config.tmux_session) return false;
  return notifyLeaderStatus(config.tmux_session, message);
}

async function deliverPendingMailboxMessages(
  teamName: string,
  config: TeamConfig,
  workers: TeamSnapshot['workers'],
  previousNotifications: Record<string, string>,
  cwd: string,
): Promise<Record<string, string>> {
  const nextNotifications: Record<string, string> = {};
  const pendingIdsAcrossTeam = new Set<string>();

  for (const worker of workers) {
    if (!worker.alive) continue;
    const workerInfo = config.workers.find((w) => w.name === worker.name);
    if (!workerInfo) continue;
    const mailbox = await listMailboxMessages(teamName, worker.name, cwd);
    const pending = mailbox.filter((m) => !m.delivered_at);
    if (pending.length === 0) continue;

    const pendingIds = pending.map((m) => m.message_id);
    for (const id of pendingIds) pendingIdsAcrossTeam.add(id);

    // Preserve already-tracked notification timestamps in the next snapshot.
    for (const msg of pending) {
      nextNotifications[msg.message_id] = msg.notified_at || previousNotifications[msg.message_id] || '';
    }

    // Only notify for messages that have never been successfully notified.
    // Using a message-ID set prevents re-notification on every monitor poll
    // (issue #116). A message is considered notified when either:
    //   - notified_at is set in the mailbox file (persisted by markMessageNotified), or
    //   - the message_id exists in previousNotifications from the last snapshot.
    // Both checks use Boolean() so an empty-string value is treated as unnotified.
    const unnotified = pending.filter(
      (m) => !m.notified_at && !previousNotifications[m.message_id],
    );
    if (unnotified.length === 0) continue;

    const notifiedNow = notifyWorker(
      config,
      workerInfo.index,
      generateMailboxTriggerMessage(worker.name, teamName, unnotified.length),
      workerInfo.pane_id,
    );

    if (!notifiedNow) continue;

    for (const msg of unnotified) {
      const notified = await markMessageNotified(teamName, worker.name, msg.message_id, cwd);
      if (notified) {
        nextNotifications[msg.message_id] = new Date().toISOString();
      }
    }
  }

  const pruned: Record<string, string> = {};
  for (const [messageId, ts] of Object.entries(nextNotifications)) {
    if (pendingIdsAcrossTeam.has(messageId) && ts) pruned[messageId] = ts;
  }
  return pruned;
}

export async function sendWorkerMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  if (toWorker === 'leader-fixed') {
    await queueDirectMailboxMessage({
      teamName: sanitized,
      fromWorker,
      toWorker,
      body,
      triggerMessage: `Team ${sanitized}: new worker message for leader from ${fromWorker}`,
      cwd,
      notify: (_target, message) => notifyLeader(config, message),
    });
    return;
  }

  const recipient = config.workers.find((w) => w.name === toWorker);
  if (!recipient) throw new Error(`Worker ${toWorker} not found in team`);

  await queueDirectMailboxMessage({
    teamName: sanitized,
    fromWorker,
    toWorker,
    toWorkerIndex: recipient.index,
    toPaneId: recipient.pane_id,
    body,
    triggerMessage: generateMailboxTriggerMessage(toWorker, sanitized, 1),
    cwd,
    notify: (_target, message) => notifyWorker(config, recipient.index, message, recipient.pane_id),
  });
}

export async function broadcastWorkerMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);

  await queueBroadcastMailboxMessage({
    teamName: sanitized,
    fromWorker,
    recipients: config.workers.map((w) => ({ workerName: w.name, workerIndex: w.index, paneId: w.pane_id })),
    body,
    cwd,
    triggerFor: (workerName) => generateMailboxTriggerMessage(workerName, sanitized, 1),
    notify: (target, message) =>
      typeof target.workerIndex === 'number'
        ? notifyWorker(config, target.workerIndex, message, target.paneId)
        : false,
  });
}
