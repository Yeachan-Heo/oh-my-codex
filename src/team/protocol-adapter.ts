/**
 * Protocol Adapter — wraps cli-agent-mail with OMX function signatures.
 *
 * This module translates between cli-agent-mail's protocol types and
 * OMX's internal types (TeamTask, TeamMailboxMessage, etc.).
 * It is the single indirection layer so that team-ops.ts can import
 * from here instead of state.ts for all functions that have a
 * cli-agent-mail equivalent.
 *
 * Functions that have NO cli-agent-mail equivalent remain in state.ts
 * and are re-exported from team-ops.ts directly.
 */

import { join } from 'path';
import { omxStateDir } from '../utils/paths.js';

// cli-agent-mail imports
import {
  // manifest / lifecycle
  initTeam as camInitTeam,
  readManifest as camReadManifest,
  writeManifest as camWriteManifest,
  cleanupTeam as camCleanupTeam,

  // tasks
  createTask as camCreateTask,
  readTask as camReadTask,
  listTasks as camListTasks,
  updateTask as camUpdateTask,

  // claims
  claimTask as camClaimTask,
  releaseTaskClaim as camReleaseTaskClaim,
  transitionTask as camTransitionTask,
  computeTaskReadiness as camComputeTaskReadiness,

  // messaging
  sendMessage as camSendMessage,
  broadcastMessage as camBroadcastMessage,
  listMessages as camListMessages,
  markDelivered as camMarkDelivered,
  markNotified as camMarkNotified,

  // events
  appendEvent as camAppendEvent,

  // worker state
  writeHeartbeat as camWriteHeartbeat,
  readHeartbeat as camReadHeartbeat,
  readWorkerStatus as camReadWorkerStatus,
  writeWorkerIdentity as camWriteWorkerIdentity,

  // signals
  requestShutdown as camRequestShutdown,
  ackShutdown as camAckShutdown,

  // monitor
  readMonitorSnapshot as camReadMonitorSnapshot,
  writeMonitorSnapshot as camWriteMonitorSnapshot,

  // summary
  buildTeamSummary as camBuildTeamSummary,

  // atomic helpers
  atomicWriteJsonSync,
  readJsonSync,
  ensureDir,

  // paths
  workerInboxPath as camWorkerInboxPath,
  approvalFilePath as camApprovalFilePath,

  // constants
  DEFAULT_MAX_WORKERS as CAM_DEFAULT_MAX_WORKERS,
  ABSOLUTE_MAX_WORKERS as CAM_ABSOLUTE_MAX_WORKERS,

  // types
  type ProtocolTask,
  type ProtocolMessage,
  type ProtocolManifest,
  type ProtocolEvent,
  type ProtocolHeartbeat,
  type ProtocolWorkerStatus,
  type ProtocolWorkerInfo,
  type TaskApprovalRecord,
  type ClaimTaskResult as CamClaimResult,
  type TransitionTaskResult as CamTransitionResult,
  type ReleaseTaskClaimResult as CamReleaseResult,
  type TaskReadiness as CamTaskReadiness,
  type TeamSummary as CamTeamSummary,
  type TeamMonitorSnapshot,
  type ShutdownAck as CamShutdownAck,
  type InitTeamOptions,
} from 'cli-agent-mail';

// OMX types — re-exported so team-ops can import everything from here
export type {
  TeamConfig,
  WorkerInfo,
  WorkerHeartbeat,
  WorkerStatus,
  TeamTask,
  TeamTaskV2,
  TeamTaskClaim,
  TeamManifestV2,
  TeamLeader,
  TeamPolicy,
  PermissionsSnapshot,
  TeamEvent,
  TeamMailboxMessage,
  TeamMailbox,
  TaskApprovalRecord,
  TaskReadiness,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TeamSummary,
  ShutdownAck,
  TeamMonitorSnapshotState,
} from './state.js';

import type {
  TeamConfig,
  WorkerInfo,
  WorkerHeartbeat,
  WorkerStatus,
  TeamTask,
  TeamTaskV2,
  TeamTaskClaim,
  TeamManifestV2,
  TeamLeader,
  TeamPolicy,
  PermissionsSnapshot,
  TeamEvent,
  TeamMailboxMessage,
  TaskReadiness,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TeamSummary,
  ShutdownAck,
  TeamMonitorSnapshotState,
} from './state.js';

import { writeAtomic } from './state.js';
export { writeAtomic };

// === Constants ===
export const DEFAULT_MAX_WORKERS = CAM_DEFAULT_MAX_WORKERS;
export const ABSOLUTE_MAX_WORKERS = CAM_ABSOLUTE_MAX_WORKERS;

// === Helpers ===

function stateRoot(cwd: string): string {
  return omxStateDir(cwd);
}

// --- Type Converters ---

/**
 * Convert a ProtocolTask to OMX TeamTaskV2.
 * Maps protocol fields to OMX equivalents:
 *   - depends_on stays as depends_on (+ aliased as blocked_by)
 *   - schema_version is stripped
 */
function protocolTaskToOmx(pt: ProtocolTask): TeamTaskV2 {
  return {
    id: pt.id,
    subject: pt.subject,
    description: pt.description,
    status: pt.status,
    requires_code_change: pt.requires_code_change,
    owner: pt.owner,
    result: pt.result,
    error: pt.error,
    blocked_by: pt.depends_on ?? [],
    depends_on: pt.depends_on ?? [],
    version: pt.version,
    claim: pt.claim as TeamTaskClaim | undefined,
    created_at: pt.created_at,
    completed_at: pt.completed_at,
  };
}

/**
 * Convert a ProtocolMessage to OMX TeamMailboxMessage.
 * Maps from/to to from_worker/to_worker.
 */
function protocolMessageToOmx(pm: ProtocolMessage): TeamMailboxMessage {
  return {
    message_id: pm.message_id,
    from_worker: pm.from,
    to_worker: pm.to,
    body: pm.body,
    created_at: pm.created_at,
    notified_at: pm.notified_at,
    delivered_at: pm.delivered_at,
  };
}

/**
 * Convert a ProtocolManifest to OMX TeamManifestV2.
 * Maps session_handle → tmux_session, adds display_mode and permissions_snapshot.
 */
function protocolManifestToOmx(pm: ProtocolManifest): TeamManifestV2 {
  return {
    schema_version: 2,
    name: pm.name,
    task: pm.task,
    leader: pm.leader as TeamLeader,
    policy: {
      display_mode: (pm.metadata?.display_mode as TeamPolicy['display_mode']) ?? 'auto',
      delegation_only: pm.policy.delegation_only,
      plan_approval_required: pm.policy.plan_approval_required,
      nested_teams_allowed: (pm.metadata?.nested_teams_allowed as boolean) ?? false,
      one_team_per_leader_session: (pm.metadata?.one_team_per_leader_session as boolean) ?? true,
      cleanup_requires_all_workers_inactive: pm.policy.cleanup_requires_all_workers_inactive,
    },
    permissions_snapshot: (pm.metadata?.permissions_snapshot as PermissionsSnapshot) ?? {
      approval_mode: 'unknown',
      sandbox_mode: 'unknown',
      network_access: true,
    },
    tmux_session: pm.session_handle,
    worker_count: pm.worker_count,
    workers: pm.workers as WorkerInfo[],
    next_task_id: pm.next_task_id,
    created_at: pm.created_at,
  };
}

/**
 * Convert OMX TeamManifestV2 to a ProtocolManifest for writing.
 */
function omxManifestToProtocol(m: TeamManifestV2): ProtocolManifest {
  return {
    schema_version: 2,
    name: m.name,
    task: m.task,
    session_handle: m.tmux_session,
    worker_count: m.worker_count,
    workers: m.workers as ProtocolWorkerInfo[],
    next_task_id: m.next_task_id,
    created_at: m.created_at,
    leader: m.leader,
    policy: {
      delegation_only: m.policy.delegation_only,
      plan_approval_required: m.policy.plan_approval_required,
      cleanup_requires_all_workers_inactive: m.policy.cleanup_requires_all_workers_inactive,
    },
    metadata: {
      display_mode: m.policy.display_mode,
      nested_teams_allowed: m.policy.nested_teams_allowed,
      one_team_per_leader_session: m.policy.one_team_per_leader_session,
      permissions_snapshot: m.permissions_snapshot,
    },
  };
}

/**
 * Convert a ProtocolEvent to OMX TeamEvent.
 * OMX event types are a subset — map protocol-only types to closest equivalent.
 */
function protocolEventToOmx(pe: ProtocolEvent): TeamEvent {
  // OMX event types: task_completed | worker_idle | worker_stopped | message_received | shutdown_ack | approval_decision | team_leader_nudge
  // Protocol adds: task_failed | task_claimed | worker_ready
  let omxType: TeamEvent['type'];
  switch (pe.type) {
    case 'task_completed':
    case 'worker_idle':
    case 'worker_stopped':
    case 'message_received':
    case 'shutdown_ack':
    case 'approval_decision':
      omxType = pe.type;
      break;
    case 'task_failed':
      omxType = 'worker_stopped';
      break;
    case 'task_claimed':
      omxType = 'task_completed'; // closest available
      break;
    case 'worker_ready':
      omxType = 'worker_idle';
      break;
    default:
      omxType = 'worker_idle';
  }
  return {
    event_id: pe.event_id,
    team: pe.team,
    type: omxType,
    worker: pe.worker,
    task_id: pe.task_id,
    message_id: pe.message_id,
    reason: pe.reason,
    created_at: pe.created_at,
  };
}

/**
 * Convert a ProtocolHeartbeat to OMX WorkerHeartbeat.
 * Protocol uses last_active_at/status; OMX uses last_turn_at/turn_count/alive.
 */
function protocolHeartbeatToOmx(ph: ProtocolHeartbeat): WorkerHeartbeat {
  return {
    pid: ph.pid,
    last_turn_at: ph.last_active_at,
    turn_count: 0, // protocol doesn't track turn_count; callers that need it use state.ts
    alive: ph.status !== 'shutdown',
  };
}

/**
 * Convert OMX WorkerHeartbeat to ProtocolHeartbeat for writing.
 */
function omxHeartbeatToProtocol(hb: WorkerHeartbeat): ProtocolHeartbeat {
  return {
    pid: hb.pid,
    last_active_at: hb.last_turn_at,
    status: hb.alive ? 'executing' : 'shutdown',
    metadata: { turn_count: hb.turn_count },
  };
}

/**
 * Convert ProtocolWorkerStatus to OMX WorkerStatus.
 */
function protocolWorkerStatusToOmx(ps: ProtocolWorkerStatus): WorkerStatus {
  return {
    state: ps.state,
    current_task_id: ps.current_task_id,
    reason: ps.reason,
    updated_at: ps.updated_at,
  };
}

/**
 * Convert CamClaimResult to OMX ClaimTaskResult.
 */
function camClaimToOmx(cr: CamClaimResult): ClaimTaskResult {
  if (cr.ok) {
    return { ok: true, task: protocolTaskToOmx(cr.task), claimToken: cr.claimToken };
  }
  return cr as ClaimTaskResult;
}

/**
 * Convert CamTransitionResult to OMX TransitionTaskResult.
 */
function camTransitionToOmx(tr: CamTransitionResult): TransitionTaskResult {
  if (tr.ok) {
    return { ok: true, task: protocolTaskToOmx(tr.task) };
  }
  return tr as TransitionTaskResult;
}

/**
 * Convert CamReleaseResult to OMX ReleaseTaskClaimResult.
 */
function camReleaseToOmx(rr: CamReleaseResult): ReleaseTaskClaimResult {
  if (rr.ok) {
    return { ok: true, task: protocolTaskToOmx(rr.task) };
  }
  return rr as ReleaseTaskClaimResult;
}

/**
 * Convert CamTaskReadiness to OMX TaskReadiness.
 */
function camReadinessToOmx(tr: CamTaskReadiness): TaskReadiness {
  return tr as TaskReadiness;
}

/**
 * Convert CamTeamSummary to OMX TeamSummary.
 * Protocol uses lastActiveAt; OMX uses lastTurnAt.
 */
function camSummaryToOmx(s: CamTeamSummary): TeamSummary {
  return {
    teamName: s.teamName,
    workerCount: s.workerCount,
    tasks: s.tasks,
    workers: s.workers.map((w) => ({
      name: w.name,
      alive: w.alive,
      lastTurnAt: w.lastActiveAt,
      turnsWithoutProgress: w.turnsWithoutProgress,
    })),
    nonReportingWorkers: s.nonReportingWorkers,
  };
}

// === Team lifecycle ===

export async function initTeamState(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  cwd: string,
  maxWorkers: number = DEFAULT_MAX_WORKERS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TeamConfig> {
  const sr = stateRoot(cwd);

  // Resolve env-based leader/policy/permissions the same way state.ts does
  const sessionId = env.OMX_SESSION_ID || env.CODEX_SESSION_ID || env.SESSION_ID || '';
  const leaderWorkerId = env.OMX_TEAM_WORKER || 'leader-fixed';

  const rawDisplayMode = env.OMX_TEAM_DISPLAY_MODE || env.OMX_TEAM_MODE || '';
  let displayMode: TeamPolicy['display_mode'] = 'auto';
  if (rawDisplayMode === 'split_pane' || rawDisplayMode === 'tmux' || rawDisplayMode === 'in_process' || rawDisplayMode === 'in-process') {
    displayMode = 'split_pane';
  }

  const manifest = camInitTeam({
    teamName,
    task,
    agentType,
    workerCount,
    stateRoot: sr,
    sessionHandle: `omx-team-${teamName}`,
    maxWorkers,
    leader: {
      session_id: sessionId,
      worker_id: leaderWorkerId,
      role: 'coordinator',
    },
    policy: {
      delegation_only: false,
      plan_approval_required: false,
      cleanup_requires_all_workers_inactive: true,
    },
    metadata: {
      display_mode: displayMode,
      nested_teams_allowed: false,
      one_team_per_leader_session: true,
      permissions_snapshot: resolvePermissionsSnapshot(env),
    },
  });

  const omxManifest = protocolManifestToOmx(manifest);
  return manifestToConfig(omxManifest, agentType);
}

function resolvePermissionsSnapshot(env: NodeJS.ProcessEnv): PermissionsSnapshot {
  const approvalMode = env.OMX_APPROVAL_MODE || env.CODEX_APPROVAL_MODE || env.CODEX_APPROVAL_POLICY || env.CLAUDE_CODE_APPROVAL_MODE || 'unknown';
  const sandboxMode = env.OMX_SANDBOX_MODE || env.CODEX_SANDBOX_MODE || env.SANDBOX_MODE || 'unknown';
  let networkAccess = true;
  const rawNetwork = env.OMX_NETWORK_ACCESS || env.CODEX_NETWORK_ACCESS || env.NETWORK_ACCESS || '';
  if (['0', 'false', 'no', 'off', 'disabled', 'deny', 'denied'].includes(rawNetwork.trim().toLowerCase())) {
    networkAccess = false;
  } else if (sandboxMode.toLowerCase().includes('offline')) {
    networkAccess = false;
  }
  return { approval_mode: approvalMode, sandbox_mode: sandboxMode, network_access: networkAccess };
}

function manifestToConfig(m: TeamManifestV2, agentType?: string): TeamConfig {
  return {
    name: m.name,
    task: m.task,
    agent_type: agentType ?? m.workers[0]?.role ?? 'executor',
    worker_count: m.worker_count,
    max_workers: DEFAULT_MAX_WORKERS,
    workers: m.workers,
    created_at: m.created_at,
    tmux_session: m.tmux_session,
    next_task_id: m.next_task_id,
  };
}

export async function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null> {
  const manifest = camReadManifest(stateRoot(cwd), teamName);
  if (!manifest) return null;
  return manifestToConfig(protocolManifestToOmx(manifest));
}

export async function readTeamManifestV2(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  const manifest = camReadManifest(stateRoot(cwd), teamName);
  if (!manifest) return null;
  return protocolManifestToOmx(manifest);
}

export async function writeTeamManifestV2(manifest: TeamManifestV2, cwd: string): Promise<void> {
  camWriteManifest(stateRoot(cwd), manifest.name, omxManifestToProtocol(manifest));
}

export async function saveTeamConfig(config: TeamConfig, cwd: string): Promise<void> {
  // Read existing manifest to preserve leader/policy/permissions fields
  const existing = camReadManifest(stateRoot(cwd), config.name);
  if (existing) {
    const updated: ProtocolManifest = {
      ...existing,
      task: config.task,
      session_handle: config.tmux_session,
      worker_count: config.worker_count,
      workers: config.workers as ProtocolWorkerInfo[],
      next_task_id: config.next_task_id,
    };
    camWriteManifest(stateRoot(cwd), config.name, updated);
  } else {
    // No manifest yet — build one from config
    const omxManifest: TeamManifestV2 = {
      schema_version: 2,
      name: config.name,
      task: config.task,
      leader: { session_id: '', worker_id: 'leader-fixed', role: 'coordinator' },
      policy: {
        display_mode: 'auto',
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
      },
      permissions_snapshot: { approval_mode: 'unknown', sandbox_mode: 'unknown', network_access: true },
      tmux_session: config.tmux_session,
      worker_count: config.worker_count,
      workers: config.workers,
      next_task_id: config.next_task_id,
      created_at: config.created_at,
    };
    camWriteManifest(stateRoot(cwd), config.name, omxManifestToProtocol(omxManifest));
  }
}

export async function cleanupTeamState(teamName: string, cwd: string): Promise<void> {
  camCleanupTeam(stateRoot(cwd), teamName);
}

export async function migrateV1ToV2(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  // cli-agent-mail only has v2 manifests; if one exists, return it
  const manifest = camReadManifest(stateRoot(cwd), teamName);
  if (!manifest) return null;
  return protocolManifestToOmx(manifest);
}

// === Worker operations ===

export async function writeWorkerIdentity(
  teamName: string,
  workerName: string,
  identity: WorkerInfo,
  cwd: string,
): Promise<void> {
  camWriteWorkerIdentity(stateRoot(cwd), teamName, workerName, identity as unknown as Record<string, unknown>);
}

export async function readWorkerHeartbeat(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerHeartbeat | null> {
  const hb = camReadHeartbeat(stateRoot(cwd), teamName, workerName);
  if (!hb) return null;
  // Recover turn_count from protocol metadata if available
  const turnCount = typeof hb.metadata?.turn_count === 'number' ? hb.metadata.turn_count : 0;
  const result = protocolHeartbeatToOmx(hb);
  result.turn_count = turnCount;
  return result;
}

export async function updateWorkerHeartbeat(
  teamName: string,
  workerName: string,
  heartbeat: WorkerHeartbeat,
  cwd: string,
): Promise<void> {
  camWriteHeartbeat(stateRoot(cwd), teamName, workerName, omxHeartbeatToProtocol(heartbeat));
}

export async function readWorkerStatus(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerStatus> {
  const status = camReadWorkerStatus(stateRoot(cwd), teamName, workerName);
  if (!status) {
    return { state: 'unknown', updated_at: new Date().toISOString() };
  }
  return protocolWorkerStatusToOmx(status);
}

export async function writeWorkerInbox(
  teamName: string,
  workerName: string,
  prompt: string,
  cwd: string,
): Promise<void> {
  // cli-agent-mail exposes the path but no dedicated write function for inbox.md
  const sr = stateRoot(cwd);
  const p = camWorkerInboxPath(sr, teamName, workerName);
  await writeAtomic(p, prompt);
}

// === Task operations ===

export async function createTask(
  teamName: string,
  task: Omit<TeamTask, 'id' | 'created_at'>,
  cwd: string,
): Promise<TeamTaskV2> {
  const pt = camCreateTask(
    stateRoot(cwd),
    teamName,
    task.subject,
    task.description,
    {
      dependsOn: task.depends_on ?? task.blocked_by,
      requiresCodeChange: task.requires_code_change,
    },
  );
  return protocolTaskToOmx(pt);
}

export async function readTask(
  teamName: string,
  taskId: string,
  cwd: string,
): Promise<TeamTask | null> {
  const pt = camReadTask(stateRoot(cwd), teamName, taskId);
  if (!pt) return null;
  return protocolTaskToOmx(pt);
}

export async function listTasks(teamName: string, cwd: string): Promise<TeamTask[]> {
  const tasks = camListTasks(stateRoot(cwd), teamName);
  return tasks.map(protocolTaskToOmx);
}

export async function updateTask(
  teamName: string,
  taskId: string,
  updates: Partial<TeamTask>,
  cwd: string,
): Promise<TeamTask | null> {
  try {
    const pt = camUpdateTask(stateRoot(cwd), teamName, taskId, {
      subject: updates.subject,
      description: updates.description,
      status: updates.status,
      owner: updates.owner,
      result: updates.result,
      error: updates.error,
      depends_on: updates.depends_on ?? updates.blocked_by,
    });
    return protocolTaskToOmx(pt);
  } catch {
    return null;
  }
}

export async function claimTask(
  teamName: string,
  taskId: string,
  workerName: string,
  _expectedVersion: number | null,
  cwd: string,
): Promise<ClaimTaskResult> {
  const result = camClaimTask(stateRoot(cwd), teamName, taskId, workerName);
  return camClaimToOmx(result);
}

export async function releaseTaskClaim(
  teamName: string,
  taskId: string,
  claimToken: string,
  _workerName: string,
  cwd: string,
): Promise<ReleaseTaskClaimResult> {
  const result = camReleaseTaskClaim(stateRoot(cwd), teamName, taskId, claimToken);
  return camReleaseToOmx(result);
}

export async function transitionTaskStatus(
  teamName: string,
  taskId: string,
  _from: TeamTask['status'],
  to: TeamTask['status'],
  claimToken: string,
  cwd: string,
): Promise<TransitionTaskResult> {
  if (to !== 'completed' && to !== 'failed') {
    // cli-agent-mail transitionTask only supports completed/failed
    // For other transitions, use updateTask
    const task = camReadTask(stateRoot(cwd), teamName, taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.claim?.token !== claimToken) return { ok: false, error: 'claim_conflict' };
    const updated = camUpdateTask(stateRoot(cwd), teamName, taskId, { status: to });
    return { ok: true, task: protocolTaskToOmx(updated) };
  }
  const result = camTransitionTask(stateRoot(cwd), teamName, taskId, claimToken, to);
  return camTransitionToOmx(result);
}

export async function computeTaskReadiness(
  teamName: string,
  taskId: string,
  cwd: string,
): Promise<TaskReadiness> {
  const task = camReadTask(stateRoot(cwd), teamName, taskId);
  if (!task) return { ready: false, reason: 'blocked_dependency', dependencies: [] };
  const result = camComputeTaskReadiness(stateRoot(cwd), teamName, task);
  return camReadinessToOmx(result);
}

// === Messaging ===

export async function sendDirectMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string,
): Promise<TeamMailboxMessage> {
  const pm = camSendMessage(stateRoot(cwd), teamName, {
    from: fromWorker,
    to: toWorker,
    type: 'chat',
    body,
  });
  // Also emit event (state.ts did this inline)
  camAppendEvent(stateRoot(cwd), teamName, {
    team: teamName,
    type: 'message_received',
    worker: toWorker,
    task_id: undefined,
    message_id: pm.message_id,
    reason: undefined,
  });
  return protocolMessageToOmx(pm);
}

export async function broadcastMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string,
): Promise<TeamMailboxMessage[]> {
  const cfg = await readTeamConfig(teamName, cwd);
  if (!cfg) throw new Error(`Team ${teamName} not found`);
  const targets = cfg.workers.map((w) => w.name).filter((n) => n !== fromWorker);
  const msgs = camBroadcastMessage(stateRoot(cwd), teamName, fromWorker, 'chat', body, targets);
  // Emit events for each
  for (const pm of msgs) {
    camAppendEvent(stateRoot(cwd), teamName, {
      team: teamName,
      type: 'message_received',
      worker: pm.to,
      task_id: undefined,
      message_id: pm.message_id,
      reason: undefined,
    });
  }
  return msgs.map(protocolMessageToOmx);
}

export async function listMailboxMessages(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<TeamMailboxMessage[]> {
  const msgs = camListMessages(stateRoot(cwd), teamName, workerName);
  return msgs.map(protocolMessageToOmx);
}

export async function markMessageDelivered(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<boolean> {
  return camMarkDelivered(stateRoot(cwd), teamName, workerName, messageId);
}

export async function markMessageNotified(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string,
): Promise<boolean> {
  return camMarkNotified(stateRoot(cwd), teamName, workerName, messageId);
}

// === Events ===

export async function appendTeamEvent(
  teamName: string,
  event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>,
  cwd: string,
): Promise<TeamEvent> {
  // Map OMX event type 'team_leader_nudge' to closest protocol type
  let protocolType: ProtocolEvent['type'];
  switch (event.type) {
    case 'team_leader_nudge':
      protocolType = 'worker_idle';
      break;
    default:
      protocolType = event.type as ProtocolEvent['type'];
  }

  const pe = camAppendEvent(stateRoot(cwd), teamName, {
    team: teamName,
    type: protocolType,
    worker: event.worker,
    task_id: event.task_id,
    message_id: event.message_id,
    reason: event.reason,
  });
  return protocolEventToOmx(pe);
}

// === Approvals ===
// cli-agent-mail exposes approvalFilePath but no dedicated read/write functions.
// We implement them using atomic-write helpers.

export async function readTaskApproval(
  teamName: string,
  taskId: string,
  cwd: string,
): Promise<TaskApprovalRecord | null> {
  const p = camApprovalFilePath(stateRoot(cwd), teamName, taskId);
  const record = readJsonSync<TaskApprovalRecord>(p);
  if (!record) return null;
  if (record.task_id !== taskId) return null;
  if (!['pending', 'approved', 'rejected'].includes(record.status)) return null;
  return record;
}

export async function writeTaskApproval(
  teamName: string,
  approval: TaskApprovalRecord,
  cwd: string,
): Promise<void> {
  const p = camApprovalFilePath(stateRoot(cwd), teamName, approval.task_id);
  const dir = join(p, '..');
  ensureDir(dir);
  atomicWriteJsonSync(p, approval);
  await appendTeamEvent(
    teamName,
    {
      type: 'approval_decision',
      worker: approval.reviewer,
      task_id: approval.task_id,
      message_id: null,
      reason: `${approval.status}:${approval.decision_reason}`,
    },
    cwd,
  );
}

// === Summary ===

export async function getTeamSummary(teamName: string, cwd: string): Promise<TeamSummary | null> {
  try {
    const summary = camBuildTeamSummary(stateRoot(cwd), teamName);
    return camSummaryToOmx(summary);
  } catch {
    return null;
  }
}

// === Shutdown control ===

export async function writeShutdownRequest(
  teamName: string,
  workerName: string,
  requestedBy: string,
  cwd: string,
): Promise<void> {
  camRequestShutdown(stateRoot(cwd), teamName, workerName, requestedBy);
}

export async function readShutdownAck(
  teamName: string,
  workerName: string,
  cwd: string,
  minUpdatedAt?: string,
): Promise<ShutdownAck | null> {
  // cli-agent-mail has ackShutdown (write) but reading the ack uses the signal path
  // The ack is written TO the shutdown signal file. Read it back.
  const { readJsonSync: readJson } = await import('cli-agent-mail');
  const { shutdownSignalPath } = await import('cli-agent-mail');
  const p = shutdownSignalPath(stateRoot(cwd), teamName, workerName);
  const parsed = readJson<CamShutdownAck>(p);
  if (!parsed) return null;
  if (parsed.status !== 'accept' && parsed.status !== 'reject') return null;
  if (typeof minUpdatedAt === 'string' && minUpdatedAt.trim() !== '') {
    const minTs = Date.parse(minUpdatedAt);
    const ackTs = Date.parse(parsed.updated_at ?? '');
    if (!Number.isFinite(minTs) || !Number.isFinite(ackTs) || ackTs < minTs) return null;
  }
  return parsed as ShutdownAck;
}

// === Monitor snapshot ===

export async function readMonitorSnapshot(
  teamName: string,
  cwd: string,
): Promise<TeamMonitorSnapshotState | null> {
  const snapshot = camReadMonitorSnapshot(stateRoot(cwd), teamName);
  if (!snapshot) return null;
  return snapshot as TeamMonitorSnapshotState;
}

export async function writeMonitorSnapshot(
  teamName: string,
  snapshot: TeamMonitorSnapshotState,
  cwd: string,
): Promise<void> {
  camWriteMonitorSnapshot(stateRoot(cwd), teamName, snapshot as TeamMonitorSnapshot);
}
