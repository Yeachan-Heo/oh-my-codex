import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { sendWorkerMessage, shutdownTeam } from './runtime.js';
import {
  TEAM_NAME_SAFE_PATTERN,
  WORKER_NAME_SAFE_PATTERN,
  TASK_ID_SAFE_PATTERN,
  TEAM_TASK_STATUSES,
  TEAM_EVENT_TYPES,
  TEAM_TASK_APPROVAL_STATUSES,
  type TeamTaskStatus,
  type TeamEventType,
  type TeamTaskApprovalStatus,
} from './contracts.js';
import { readTeamEvents, waitForTeamEvent } from './state/events.js';
import { queueDirectMailboxMessage } from './mcp-comm.js';
import { generateLeaderMailboxTriggerMessage, generateMailboxTriggerMessage } from './worker-bootstrap.js';
import {
  teamBroadcast as broadcastMessage,
  teamListMailbox as listMailboxMessages,
  teamMarkMessageDelivered as markMessageDelivered,
  teamMarkMessageNotified as markMessageNotified,
  teamListDispatchRequests,
  teamMarkDispatchRequestNotified,
  teamMarkDispatchRequestDelivered,
  teamCreateTask,
  teamReadTask,
  teamListTasks,
  teamUpdateTask,
  teamClaimTask,
  teamTransitionTaskStatus,
  teamReleaseTaskClaim,
  teamCleanup,
  teamReadConfig,
  teamReadManifest,
  teamReadWorkerStatus,
  teamReadWorkerHeartbeat,
  teamUpdateWorkerHeartbeat,
  teamWriteWorkerInbox,
  teamWriteWorkerIdentity,
  teamAppendEvent,
  teamGetSummary,
  teamWriteShutdownRequest,
  teamReadShutdownAck,
  teamReadMonitorSnapshot,
  teamWriteMonitorSnapshot,
  teamReadTaskApproval,
  teamWriteTaskApproval,
  type TeamEvent,
  type TeamMonitorSnapshotState,
  type TeamSummary,
} from './team-ops.js';

const TEAM_UPDATE_TASK_MUTABLE_FIELDS = new Set(['subject', 'description', 'blocked_by', 'requires_code_change']);
const TEAM_UPDATE_TASK_REQUEST_FIELDS = new Set(['team_name', 'task_id', 'workingDirectory', ...TEAM_UPDATE_TASK_MUTABLE_FIELDS]);

export const LEGACY_TEAM_MCP_TOOLS = [
  'team_send_message',
  'team_broadcast',
  'team_mailbox_list',
  'team_mailbox_mark_delivered',
  'team_mailbox_mark_notified',
  'team_create_task',
  'team_read_task',
  'team_list_tasks',
  'team_update_task',
  'team_claim_task',
  'team_transition_task_status',
  'team_release_task_claim',
  'team_read_config',
  'team_read_manifest',
  'team_read_worker_status',
  'team_read_worker_heartbeat',
  'team_update_worker_heartbeat',
  'team_write_worker_inbox',
  'team_write_worker_identity',
  'team_append_event',
  'team_get_summary',
  'team_cleanup',
  'team_orphan_cleanup',
  'team_write_shutdown_request',
  'team_read_shutdown_ack',
  'team_read_monitor_snapshot',
  'team_write_monitor_snapshot',
  'team_read_task_approval',
  'team_write_task_approval',
] as const;

export const TEAM_API_OPERATIONS = [
  'send-message',
  'broadcast',
  'mailbox-list',
  'mailbox-mark-delivered',
  'mailbox-mark-notified',
  'create-task',
  'read-task',
  'list-tasks',
  'update-task',
  'claim-task',
  'transition-task-status',
  'release-task-claim',
  'read-config',
  'read-manifest',
  'read-worker-status',
  'read-worker-heartbeat',
  'update-worker-heartbeat',
  'write-worker-inbox',
  'write-worker-identity',
  'append-event',
  'read-events',
  'await-event',
  'read-idle-state',
  'read-stall-state',
  'get-summary',
  'cleanup',
  'orphan-cleanup',
  'write-shutdown-request',
  'read-shutdown-ack',
  'read-monitor-snapshot',
  'write-monitor-snapshot',
  'read-task-approval',
  'write-task-approval',
] as const;

export type TeamApiOperation = typeof TEAM_API_OPERATIONS[number];

export type TeamApiEnvelope =
  | { ok: true; operation: TeamApiOperation; data: Record<string, unknown> }
  | { ok: false; operation: TeamApiOperation | 'unknown'; error: { code: string; message: string } };

const TEAM_STATE_EVENT_WINDOW = 50;

async function markLatestMailboxDispatchDelivered(
  teamName: string,
  worker: string,
  messageId: string,
  cwd: string,
): Promise<{ matched_request_id: string | null; dispatch_updated: boolean }> {
  const requests = await teamListDispatchRequests(teamName, cwd, { kind: 'mailbox', to_worker: worker });
  const matching = requests
    .filter((request) => request.message_id === messageId)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));

  const latest = matching[0];
  if (!latest) {
    return { matched_request_id: null, dispatch_updated: false };
  }

  if (latest.status === 'pending') {
    await teamMarkDispatchRequestNotified(teamName, latest.request_id, { message_id: messageId }, cwd);
  }

  const delivered = await teamMarkDispatchRequestDelivered(teamName, latest.request_id, { message_id: messageId }, cwd);
  return {
    matched_request_id: latest.request_id,
    dispatch_updated: delivered?.status === 'delivered',
  };
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

function parseOptionalNonNegativeInteger(value: unknown, fieldName: string): number | null {
  if (value === undefined) return null;
  if (!isFiniteInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer when provided`);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean when provided`);
  }
  return value;
}

function parseOptionalEventType(value: unknown): TeamEventType | 'worker_idle' | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error('type must be a string when provided');
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('type cannot be empty when provided');
  }
  if (!TEAM_EVENT_TYPES.includes(normalized as TeamEventType)) {
    throw new Error(`type must be one of: ${TEAM_EVENT_TYPES.join(', ')}`);
  }
  return normalized as TeamEventType | 'worker_idle';
}

function parseOptionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object when provided');
  }
  return { ...(value as Record<string, unknown>) };
}

function selectRecentEvents(events: TeamEvent[]): TeamEvent[] {
  return events.slice(Math.max(0, events.length - TEAM_STATE_EVENT_WINDOW));
}

function listTeamWorkerNames(summary: TeamSummary | null, snapshot: TeamMonitorSnapshotState | null): string[] {
  const names = new Set<string>();
  for (const worker of summary?.workers ?? []) {
    names.add(worker.name);
  }
  for (const workerName of Object.keys(snapshot?.workerStateByName ?? {})) {
    names.add(workerName);
  }
  return [...names].sort();
}

function findLatestEventByType(events: TeamEvent[], types: TeamEvent['type'][]): TeamEvent | null {
  const allowed = new Set(types);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && allowed.has(event.type)) {
      return event;
    }
  }
  return null;
}

function findLatestWorkerIdleEvent(events: TeamEvent[], workerName: string): TeamEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.worker !== workerName) continue;
    if (event.type === 'worker_state_changed' && event.state === 'idle') {
      return event;
    }
  }
  return null;
}

function summarizeEvent(event: TeamEvent | null): Record<string, unknown> | null {
  if (!event) return null;
  return {
    event_id: event.event_id,
    type: event.type,
    worker: event.worker,
    task_id: event.task_id ?? null,
    created_at: event.created_at,
    reason: event.reason ?? null,
    state: event.state ?? null,
    prev_state: event.prev_state ?? null,
    source_type: event.source_type ?? null,
    worker_count: event.worker_count ?? null,
  };
}

function buildIdleState(
  teamName: string,
  summary: TeamSummary | null,
  snapshot: TeamMonitorSnapshotState | null,
  recentEvents: TeamEvent[],
): Record<string, unknown> {
  const workerNames = listTeamWorkerNames(summary, snapshot);
  const idleWorkers = workerNames.filter((workerName) => snapshot?.workerStateByName[workerName] === 'idle');
  const nonIdleWorkers = workerNames.filter((workerName) => !idleWorkers.includes(workerName));
  const lastIdleTransitionByWorker = Object.fromEntries(
    workerNames.map((workerName) => [workerName, summarizeEvent(findLatestWorkerIdleEvent(recentEvents, workerName))]),
  );
  const lastAllWorkersIdleEvent = findLatestEventByType(recentEvents, ['all_workers_idle']);

  return {
    team_name: teamName,
    worker_count: summary?.workerCount ?? workerNames.length,
    idle_worker_count: idleWorkers.length,
    idle_workers: idleWorkers,
    non_idle_workers: nonIdleWorkers,
    all_workers_idle: workerNames.length > 0 && idleWorkers.length === workerNames.length,
    last_idle_transition_by_worker: lastIdleTransitionByWorker,
    last_all_workers_idle_event: summarizeEvent(lastAllWorkersIdleEvent),
    source: {
      summary_available: summary !== null,
      snapshot_available: snapshot !== null,
      recent_event_count: recentEvents.length,
    },
  };
}

function buildStallState(
  teamName: string,
  summary: TeamSummary | null,
  snapshot: TeamMonitorSnapshotState | null,
  recentEvents: TeamEvent[],
): Record<string, unknown> {
  const idleState = buildIdleState(teamName, summary, snapshot, recentEvents);
  const workerNames = listTeamWorkerNames(summary, snapshot);
  const deadWorkers = workerNames.filter((workerName) => summary?.workers.find((worker) => worker.name === workerName)?.alive === false);
  const stalledWorkers = [...(summary?.nonReportingWorkers ?? [])].sort();
  const latestAllWorkersIdleEvent = findLatestEventByType(recentEvents, ['all_workers_idle']);
  const latestLeaderNudgeEvent = findLatestEventByType(recentEvents, ['team_leader_nudge']);
  const latestDeferredEvent = findLatestEventByType(recentEvents, ['leader_notification_deferred']);
  const pendingCount = summary?.tasks.pending ?? 0;
  const blockedCount = summary?.tasks.blocked ?? 0;
  const inProgressCount = summary?.tasks.in_progress ?? 0;
  const pendingTaskCount = pendingCount + blockedCount + inProgressCount;
  const liveWorkers = workerNames.filter(
    (workerName) => summary?.workers.find((worker) => worker.name === workerName)?.alive !== false,
  );
  const latestLeaderReason = typeof latestLeaderNudgeEvent?.reason === 'string' ? latestLeaderNudgeEvent.reason : '';
  const terminalLeaderDecisionPending =
    pendingTaskCount === 0
    && idleState.all_workers_idle === true
    && liveWorkers.length > 0;
  const stuckLeaderDecisionPending =
    (blockedCount > 0 && pendingCount === 0 && inProgressCount === 0 && idleState.all_workers_idle === true)
    || latestLeaderReason === 'stuck_waiting_on_leader';
  const leaderDecisionState = terminalLeaderDecisionPending
    ? 'done_waiting_on_leader'
    : stuckLeaderDecisionPending
      ? 'stuck_waiting_on_leader'
      : 'still_actionable';
  const leaderStale = pendingTaskCount > 0 && idleState.all_workers_idle === true && (
    latestLeaderNudgeEvent !== null
    || latestDeferredEvent !== null
    || latestAllWorkersIdleEvent !== null
  );
  const leaderAttentionPending = leaderDecisionState !== 'still_actionable' || leaderStale;
  const teamStalled =
    stalledWorkers.length > 0
    || leaderAttentionPending
    || (deadWorkers.length > 0 && pendingTaskCount > 0);
  const reasons: string[] = [];

  if (stalledWorkers.length > 0) {
    reasons.push(`workers_non_reporting:${stalledWorkers.join(',')}`);
  }
  if (deadWorkers.length > 0 && pendingTaskCount > 0) {
    reasons.push(`dead_workers_with_pending_work:${deadWorkers.join(',')}`);
  }
  if (leaderDecisionState !== 'still_actionable') {
    reasons.push(`leader_decision_pending:${leaderDecisionState}`);
  }
  if (leaderStale) {
    const leaderSignal = latestLeaderNudgeEvent ?? latestDeferredEvent ?? latestAllWorkersIdleEvent;
    reasons.push(`leader_attention_pending:${leaderSignal?.type ?? 'all_workers_idle'}`);
  }

  return {
    team_name: teamName,
    team_stalled: teamStalled,
    leader_stale: leaderStale,
    leader_attention_pending: leaderAttentionPending,
    leader_decision_state: leaderDecisionState,
    stalled_workers: stalledWorkers,
    dead_workers: deadWorkers,
    live_workers: liveWorkers,
    pending_task_count: pendingTaskCount,
    all_workers_idle: idleState.all_workers_idle,
    idle_workers: idleState.idle_workers,
    reasons,
    last_all_workers_idle_event: summarizeEvent(latestAllWorkersIdleEvent),
    last_team_leader_nudge_event: summarizeEvent(latestLeaderNudgeEvent),
    last_leader_notification_deferred_event: summarizeEvent(latestDeferredEvent),
    source: {
      summary_available: summary !== null,
      snapshot_available: snapshot !== null,
      recent_event_count: recentEvents.length,
    },
  };
}

function parseValidatedTaskIdArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of task IDs (strings)`);
  }
  const taskIds: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName} entries must be strings`);
    }
    const normalized = item.trim();
    if (!TASK_ID_SAFE_PATTERN.test(normalized)) {
      throw new Error(`${fieldName} contains invalid task ID: "${item}"`);
    }
    taskIds.push(normalized);
  }
  return taskIds;
}

function teamStateExists(teamName: string, candidateCwd: string): boolean {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) return false;
  const teamRoot = join(candidateCwd, '.omx', 'state', 'team', teamName);
  return existsSync(join(teamRoot, 'config.json')) || existsSync(join(teamRoot, 'tasks')) || existsSync(teamRoot);
}

function readTeamStateRootFromManifest(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { team_state_root?: unknown };
    return typeof parsed.team_state_root === 'string' && parsed.team_state_root.trim() !== ''
      ? parsed.team_state_root.trim()
      : null;
  } catch {
    return null;
  }
}

function stateRootToWorkingDirectory(stateRoot: string): string {
  const absolute = resolvePath(stateRoot);
  return dirname(dirname(absolute));
}

function resolveTeamWorkingDirectoryFromMetadata(teamName: string, candidateCwd: string): string | null {
  const teamRoot = join(candidateCwd, '.omx', 'state', 'team', teamName);
  if (!existsSync(teamRoot)) return null;

  const fromManifest = readTeamStateRootFromManifest(join(teamRoot, 'manifest.v2.json'));
  if (!fromManifest) return null;

  return stateRootToWorkingDirectory(fromManifest);
}

function resolveTeamWorkingDirectory(teamName: string, preferredCwd: string): string {
  const normalizedTeamName = String(teamName || '').trim();
  if (!normalizedTeamName) return preferredCwd;
  const envTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  if (typeof envTeamStateRoot === 'string' && envTeamStateRoot.trim() !== '') {
    return stateRootToWorkingDirectory(envTeamStateRoot.trim());
  }

  const seeds: string[] = [];
  for (const seed of [preferredCwd, process.cwd()]) {
    if (typeof seed !== 'string' || seed.trim() === '') continue;
    if (!seeds.includes(seed)) seeds.push(seed);
  }

  for (const seed of seeds) {
    let cursor = seed;
    while (cursor) {
      if (teamStateExists(normalizedTeamName, cursor)) {
        return resolveTeamWorkingDirectoryFromMetadata(normalizedTeamName, cursor) ?? cursor;
      }
      const parent = dirname(cursor);
      if (!parent || parent === cursor) break;
      cursor = parent;
    }
  }
  return preferredCwd;
}

function normalizeTeamName(toolOrOperationName: string): string {
  const normalized = toolOrOperationName.trim().toLowerCase();
  const withoutPrefix = normalized.startsWith('team_') ? normalized.slice('team_'.length) : normalized;
  return withoutPrefix.replaceAll('_', '-');
}

export function resolveTeamApiOperation(name: string): TeamApiOperation | null {
  const normalized = normalizeTeamName(name);
  return TEAM_API_OPERATIONS.includes(normalized as TeamApiOperation) ? (normalized as TeamApiOperation) : null;
}

export function buildLegacyTeamDeprecationHint(legacyName: string, originalArgs?: Record<string, unknown>): string {
  const operation = resolveTeamApiOperation(legacyName);
  const payload = JSON.stringify(originalArgs ?? {});
  if (!operation) {
    return `Use CLI interop: omx team api <operation> --input '${payload}' --json`;
  }
  return `Use CLI interop: omx team api ${operation} --input '${payload}' --json`;
}

function validateCommonFields(args: Record<string, unknown>): void {
  const teamName = String(args.team_name || '').trim();
  if (teamName && !TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`Invalid team_name: "${teamName}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase alphanumeric + hyphens, max 30 chars).`);
  }

  for (const workerField of ['worker', 'from_worker', 'to_worker']) {
    const workerVal = String(args[workerField] || '').trim();
    if (workerVal && !WORKER_NAME_SAFE_PATTERN.test(workerVal)) {
      throw new Error(`Invalid ${workerField}: "${workerVal}". Must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase alphanumeric + hyphens, max 64 chars).`);
    }
  }

  const rawTaskId = String(args.task_id || '').trim();
  if (rawTaskId && !TASK_ID_SAFE_PATTERN.test(rawTaskId)) {
    throw new Error(`Invalid task_id: "${rawTaskId}". Must be a positive integer (digits only, max 20 digits).`);
  }
}

export async function executeTeamApiOperation(
  operation: TeamApiOperation,
  args: Record<string, unknown>,
  fallbackCwd: string,
): Promise<TeamApiEnvelope> {
  try {
    validateCommonFields(args);
    const teamNameForCwd = String(args.team_name || '').trim();
    const cwd = teamNameForCwd ? resolveTeamWorkingDirectory(teamNameForCwd, fallbackCwd) : fallbackCwd;

    switch (operation) {
      case 'send-message': {
        const teamName = String(args.team_name || '').trim();
        const fromWorker = String(args.from_worker || '').trim();
        const toWorker = String(args.to_worker || '').trim();
        const body = String(args.body || '').trim();
        if (!fromWorker) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'from_worker is required. You must identify yourself.' } };
        }
        if (!teamName || !toWorker || !body) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, to_worker, body are required' } };
        }

        const config = await teamReadConfig(teamName, cwd);
        if (!config) {
          return { ok: false, operation, error: { code: 'team_not_found', message: `Team ${teamName} not found` } };
        }

        const recipient = toWorker === 'leader-fixed'
          ? null
          : config.workers.find((worker) => worker.name === toWorker) ?? null;
        if (toWorker !== 'leader-fixed' && !recipient) {
          return { ok: false, operation, error: { code: 'worker_not_found', message: `Worker ${toWorker} not found in team ${teamName}` } };
        }

        const triggerMessage = toWorker === 'leader-fixed'
          ? generateLeaderMailboxTriggerMessage(teamName, fromWorker)
          : generateMailboxTriggerMessage(toWorker, teamName, 1);

        const livePaneId = toWorker === 'leader-fixed'
          ? config.leader_pane_id ?? undefined
          : recipient?.pane_id;
        const hasLiveTmuxTarget = typeof livePaneId === 'string' && livePaneId.trim().length > 0;

        const beforeMessages = await listMailboxMessages(teamName, toWorker, cwd);
        const beforeIds = new Set(beforeMessages.map((message) => message.message_id));

        const outcome = hasLiveTmuxTarget
          ? (await (async () => {
            await sendWorkerMessage(teamName, fromWorker, toWorker, body, cwd);
            return { ok: true, transport: 'hook', reason: 'api_send_message_via_runtime', message_id: '' };
          })())
          : await queueDirectMailboxMessage({
            teamName,
            fromWorker,
            toWorker,
            toWorkerIndex: recipient?.index,
            toPaneId: livePaneId,
            body,
            triggerMessage,
            cwd,
            transportPreference: 'hook_preferred_with_fallback',
            fallbackAllowed: true,
            notify: async () => ({ ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }),
          });

        const messages = await listMailboxMessages(teamName, toWorker, cwd);
        const matching = outcome.message_id
          ? messages.find((message) => message.message_id === outcome.message_id)
          : [...messages].reverse().find((message) => !beforeIds.has(message.message_id) && message.from_worker === fromWorker && message.body === body);
        if (!matching) {
          throw new Error(`send-message could not locate persisted mailbox message for ${fromWorker} -> ${toWorker}`);
        }
        return { ok: true, operation, data: { message: matching, dispatch: outcome } };
      }
      case 'broadcast': {
        const teamName = String(args.team_name || '').trim();
        const fromWorker = String(args.from_worker || '').trim();
        const body = String(args.body || '').trim();
        if (!teamName || !fromWorker || !body) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, from_worker, body are required' } };
        }
        const messages = await broadcastMessage(teamName, fromWorker, body, cwd);
        return { ok: true, operation, data: { count: messages.length, messages } };
      }
      case 'mailbox-list': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const includeDelivered = args.include_delivered !== false;
        if (!teamName || !worker) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
        }
        const all = await listMailboxMessages(teamName, worker, cwd);
        const messages = includeDelivered ? all : all.filter((m) => !m.delivered_at);
        return { ok: true, operation, data: { worker, count: messages.length, messages } };
      }
      case 'mailbox-mark-delivered': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const messageId = String(args.message_id || '').trim();
        if (!teamName || !worker || !messageId) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, message_id are required' } };
        }
        const updated = await markMessageDelivered(teamName, worker, messageId, cwd);
        const dispatch = await markLatestMailboxDispatchDelivered(teamName, worker, messageId, cwd);
        return {
          ok: true,
          operation,
          data: {
            worker,
            message_id: messageId,
            updated,
            dispatch_request_id: dispatch.matched_request_id,
            dispatch_updated: dispatch.dispatch_updated,
          },
        };
      }
      case 'mailbox-mark-notified': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const messageId = String(args.message_id || '').trim();
        if (!teamName || !worker || !messageId) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, message_id are required' } };
        }
        const notified = await markMessageNotified(teamName, worker, messageId, cwd);
        return { ok: true, operation, data: { worker, message_id: messageId, notified } };
      }
      case 'create-task': {
        const teamName = String(args.team_name || '').trim();
        const subject = String(args.subject || '').trim();
        const description = String(args.description || '').trim();
        if (!teamName || !subject || !description) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, subject, description are required' } };
        }
        const owner = args.owner as string | undefined;
        const blockedBy = args.blocked_by as string[] | undefined;
        const requiresCodeChange = args.requires_code_change as boolean | undefined;
        const task = await teamCreateTask(teamName, {
          subject, description, status: 'pending', owner: owner || undefined, blocked_by: blockedBy, requires_code_change: requiresCodeChange,
        }, cwd);
        return { ok: true, operation, data: { task } };
      }
      case 'read-task': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        if (!teamName || !taskId) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
        }
        const task = await teamReadTask(teamName, taskId, cwd);
        return task
          ? { ok: true, operation, data: { task } }
          : { ok: false, operation, error: { code: 'task_not_found', message: 'task_not_found' } };
      }
      case 'list-tasks': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        }
        const tasks = await teamListTasks(teamName, cwd);
        return { ok: true, operation, data: { count: tasks.length, tasks } };
      }
      case 'update-task': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        if (!teamName || !taskId) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
        }
        const lifecycleFields = ['status', 'owner', 'result', 'error'] as const;
        const presentLifecycleFields = lifecycleFields.filter((f) => f in args);
        if (presentLifecycleFields.length > 0) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `team_update_task cannot mutate lifecycle fields: ${presentLifecycleFields.join(', ')}` } };
        }
        const unexpectedFields = Object.keys(args).filter((field) => !TEAM_UPDATE_TASK_REQUEST_FIELDS.has(field));
        if (unexpectedFields.length > 0) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `team_update_task received unsupported fields: ${unexpectedFields.join(', ')}` } };
        }
        const updates: Record<string, unknown> = {};
        if ('subject' in args) {
          if (typeof args.subject !== 'string') {
            return { ok: false, operation, error: { code: 'invalid_input', message: 'subject must be a string when provided' } };
          }
          updates.subject = args.subject.trim();
        }
        if ('description' in args) {
          if (typeof args.description !== 'string') {
            return { ok: false, operation, error: { code: 'invalid_input', message: 'description must be a string when provided' } };
          }
          updates.description = args.description.trim();
        }
        if ('requires_code_change' in args) {
          if (typeof args.requires_code_change !== 'boolean') {
            return { ok: false, operation, error: { code: 'invalid_input', message: 'requires_code_change must be a boolean when provided' } };
          }
          updates.requires_code_change = args.requires_code_change;
        }
        if ('blocked_by' in args) {
          try {
            updates.blocked_by = parseValidatedTaskIdArray(args.blocked_by, 'blocked_by');
          } catch (error) {
            return { ok: false, operation, error: { code: 'invalid_input', message: (error as Error).message } };
          }
        }
        const task = await teamUpdateTask(teamName, taskId, updates, cwd);
        return task
          ? { ok: true, operation, data: { task } }
          : { ok: false, operation, error: { code: 'task_not_found', message: 'task_not_found' } };
      }
      case 'claim-task': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !taskId || !worker) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, worker are required' } };
        }
        const rawExpectedVersion = args.expected_version;
        if (rawExpectedVersion !== undefined && (!isFiniteInteger(rawExpectedVersion) || rawExpectedVersion < 1)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'expected_version must be a positive integer when provided' } };
        }
        const result = await teamClaimTask(teamName, taskId, worker, (rawExpectedVersion as number | undefined) ?? null, cwd);
        return { ok: true, operation, data: result as unknown as Record<string, unknown> };
      }
      case 'transition-task-status': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        const from = String(args.from || '').trim();
        const to = String(args.to || '').trim();
        const claimToken = String(args.claim_token || '').trim();
        const transitionResult = args.result;
        const transitionError = args.error;
        if (!teamName || !taskId || !from || !to || !claimToken) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, from, to, claim_token are required' } };
        }
        const allowed = new Set<string>(TEAM_TASK_STATUSES);
        if (!allowed.has(from) || !allowed.has(to)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'from and to must be valid task statuses' } };
        }
        if (transitionResult !== undefined && typeof transitionResult !== 'string') {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'result must be a string when provided' } };
        }
        if (transitionError !== undefined && typeof transitionError !== 'string') {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'error must be a string when provided' } };
        }
        const result = await teamTransitionTaskStatus(
          teamName,
          taskId,
          from as TeamTaskStatus,
          to as TeamTaskStatus,
          claimToken,
          cwd,
          {
            result: typeof transitionResult === 'string' ? transitionResult : undefined,
            error: typeof transitionError === 'string' ? transitionError : undefined,
          },
        );
        return { ok: true, operation, data: result as unknown as Record<string, unknown> };
      }
      case 'release-task-claim': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        const claimToken = String(args.claim_token || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !taskId || !claimToken || !worker) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, claim_token, worker are required' } };
        }
        const result = await teamReleaseTaskClaim(teamName, taskId, claimToken, worker, cwd);
        return { ok: true, operation, data: result as unknown as Record<string, unknown> };
      }
      case 'read-config': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const config = await teamReadConfig(teamName, cwd);
        return config
          ? { ok: true, operation, data: { config } }
          : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
      }
      case 'read-manifest': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const manifest = await teamReadManifest(teamName, cwd);
        return manifest
          ? { ok: true, operation, data: { manifest } }
          : { ok: false, operation, error: { code: 'manifest_not_found', message: 'manifest_not_found' } };
      }
      case 'read-worker-status': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !worker) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
        const status = await teamReadWorkerStatus(teamName, worker, cwd);
        return { ok: true, operation, data: { worker, status } };
      }
      case 'read-worker-heartbeat': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !worker) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
        const heartbeat = await teamReadWorkerHeartbeat(teamName, worker, cwd);
        return { ok: true, operation, data: { worker, heartbeat } };
      }
      case 'update-worker-heartbeat': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const pid = args.pid as number;
        const turnCount = args.turn_count as number;
        const alive = args.alive as boolean;
        if (!teamName || !worker || typeof pid !== 'number' || typeof turnCount !== 'number' || typeof alive !== 'boolean') {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, pid, turn_count, alive are required' } };
        }
        await teamUpdateWorkerHeartbeat(teamName, worker, { pid, turn_count: turnCount, alive, last_turn_at: new Date().toISOString() }, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case 'write-worker-inbox': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const content = String(args.content || '').trim();
        if (!teamName || !worker || !content) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, content are required' } };
        }
        await teamWriteWorkerInbox(teamName, worker, content, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case 'write-worker-identity': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const index = args.index as number;
        const role = String(args.role || '').trim();
        if (!teamName || !worker || typeof index !== 'number' || !role) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, index, role are required' } };
        }
        await teamWriteWorkerIdentity(teamName, worker, {
          name: worker,
          index,
          role,
          assigned_tasks: (args.assigned_tasks as string[] | undefined) ?? [],
          pid: args.pid as number | undefined,
          pane_id: args.pane_id as string | undefined,
          working_dir: args.working_dir as string | undefined,
          worktree_path: args.worktree_path as string | undefined,
          worktree_branch: args.worktree_branch as string | undefined,
          worktree_detached: args.worktree_detached as boolean | undefined,
          team_state_root: args.team_state_root as string | undefined,
        }, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case 'append-event': {
        const teamName = String(args.team_name || '').trim();
        const eventType = String(args.type || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !eventType || !worker) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, type, worker are required' } };
        }
        if (!TEAM_EVENT_TYPES.includes(eventType as TeamEventType)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `type must be one of: ${TEAM_EVENT_TYPES.join(', ')}` } };
        }
        const event = await teamAppendEvent(teamName, {
          type: eventType as TeamEventType,
          worker,
          task_id: args.task_id as string | undefined,
          message_id: (args.message_id as string | undefined) ?? null,
          reason: args.reason as string | undefined,
          state: args.state as string | undefined,
          prev_state: args.prev_state as string | undefined,
          to_worker: args.to_worker as string | undefined,
          worker_count: typeof args.worker_count === 'number' ? args.worker_count : undefined,
          source_type: args.source_type as string | undefined,
          metadata: parseOptionalMetadata(args.metadata),
        }, cwd);
        return { ok: true, operation, data: { event } };
      }
      case 'read-events': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        }
        const wakeableOnly = parseOptionalBoolean(args.wakeable_only, 'wakeable_only');
        const eventType = parseOptionalEventType(args.type);
        const worker = typeof args.worker === 'string' ? args.worker.trim() : '';
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
        const events = await readTeamEvents(teamName, cwd, {
          afterEventId: typeof args.after_event_id === 'string' ? args.after_event_id.trim() || undefined : undefined,
          wakeableOnly: wakeableOnly ?? false,
          type: eventType ?? undefined,
          worker: worker || undefined,
          taskId: taskId || undefined,
        });
        return {
          ok: true,
          operation,
          data: {
            count: events.length,
            cursor: events.at(-1)?.event_id ?? (typeof args.after_event_id === 'string' ? args.after_event_id.trim() : ''),
            events,
          },
        };
      }
      case 'await-event': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        }
        const timeoutMs = parseOptionalNonNegativeInteger(args.timeout_ms, 'timeout_ms') ?? 30_000;
        const pollMs = parseOptionalNonNegativeInteger(args.poll_ms, 'poll_ms');
        const wakeableOnly = parseOptionalBoolean(args.wakeable_only, 'wakeable_only');
        const eventType = parseOptionalEventType(args.type);
        const worker = typeof args.worker === 'string' ? args.worker.trim() : '';
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
        const result = await waitForTeamEvent(teamName, cwd, {
          afterEventId: typeof args.after_event_id === 'string' ? args.after_event_id.trim() || undefined : undefined,
          timeoutMs,
          pollMs: pollMs ?? undefined,
          wakeableOnly: wakeableOnly ?? false,
          type: eventType ?? undefined,
          worker: worker || undefined,
          taskId: taskId || undefined,
        });
        return {
          ok: true,
          operation,
          data: {
            status: result.status,
            cursor: result.cursor,
            event: result.event ?? null,
          },
        };
      }
      case 'read-idle-state': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        }
        const [summary, snapshot, events] = await Promise.all([
          teamGetSummary(teamName, cwd),
          teamReadMonitorSnapshot(teamName, cwd),
          readTeamEvents(teamName, cwd),
        ]);
        if (!summary) {
          return { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
        }
        const recentEvents = selectRecentEvents(events);
        return {
          ok: true,
          operation,
          data: buildIdleState(teamName, summary, snapshot, recentEvents),
        };
      }
      case 'read-stall-state': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        }
        const [summary, snapshot, events] = await Promise.all([
          teamGetSummary(teamName, cwd),
          teamReadMonitorSnapshot(teamName, cwd),
          readTeamEvents(teamName, cwd),
        ]);
        if (!summary) {
          return { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
        }
        const recentEvents = selectRecentEvents(events);
        return {
          ok: true,
          operation,
          data: buildStallState(teamName, summary, snapshot, recentEvents),
        };
      }
      case 'get-summary': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const summary = await teamGetSummary(teamName, cwd);
        return summary
          ? { ok: true, operation, data: { summary } }
          : { ok: false, operation, error: { code: 'team_not_found', message: 'team_not_found' } };
      }
      case 'cleanup': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const force = args.force === true;
        await shutdownTeam(teamName, cwd, { force });
        return { ok: true, operation, data: { team_name: teamName, cleanup_mode: 'shutdown' } };
      }
      case 'orphan-cleanup': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        await teamCleanup(teamName, cwd);
        return { ok: true, operation, data: { team_name: teamName, cleanup_mode: 'orphan_cleanup' } };
      }
      case 'write-shutdown-request': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        const requestedBy = String(args.requested_by || '').trim();
        if (!teamName || !worker || !requestedBy) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, worker, requested_by are required' } };
        }
        await teamWriteShutdownRequest(teamName, worker, requestedBy, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case 'read-shutdown-ack': {
        const teamName = String(args.team_name || '').trim();
        const worker = String(args.worker || '').trim();
        if (!teamName || !worker) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and worker are required' } };
        }
        const ack = await teamReadShutdownAck(teamName, worker, cwd, args.min_updated_at as string | undefined);
        return { ok: true, operation, data: { worker, ack } };
      }
      case 'read-monitor-snapshot': {
        const teamName = String(args.team_name || '').trim();
        if (!teamName) return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name is required' } };
        const snapshot = await teamReadMonitorSnapshot(teamName, cwd);
        return { ok: true, operation, data: { snapshot } };
      }
      case 'write-monitor-snapshot': {
        const teamName = String(args.team_name || '').trim();
        const snapshot = args.snapshot as TeamMonitorSnapshotState | undefined;
        if (!teamName || !snapshot) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and snapshot are required' } };
        }
        await teamWriteMonitorSnapshot(teamName, snapshot, cwd);
        return { ok: true, operation, data: {} };
      }
      case 'read-task-approval': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        if (!teamName || !taskId) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name and task_id are required' } };
        }
        const approval = await teamReadTaskApproval(teamName, taskId, cwd);
        return { ok: true, operation, data: { approval } };
      }
      case 'write-task-approval': {
        const teamName = String(args.team_name || '').trim();
        const taskId = String(args.task_id || '').trim();
        const status = String(args.status || '').trim();
        const reviewer = String(args.reviewer || '').trim();
        const decisionReason = String(args.decision_reason || '').trim();
        if (!teamName || !taskId || !status || !reviewer || !decisionReason) {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'team_name, task_id, status, reviewer, decision_reason are required' } };
        }
        if (!TEAM_TASK_APPROVAL_STATUSES.includes(status as TeamTaskApprovalStatus)) {
          return { ok: false, operation, error: { code: 'invalid_input', message: `status must be one of: ${TEAM_TASK_APPROVAL_STATUSES.join(', ')}` } };
        }
        const rawRequired = args.required;
        if (rawRequired !== undefined && typeof rawRequired !== 'boolean') {
          return { ok: false, operation, error: { code: 'invalid_input', message: 'required must be a boolean when provided' } };
        }
        await teamWriteTaskApproval(teamName, {
          task_id: taskId,
          required: rawRequired !== false,
          status: status as TeamTaskApprovalStatus,
          reviewer,
          decision_reason: decisionReason,
          decided_at: new Date().toISOString(),
        }, cwd);
        return { ok: true, operation, data: { task_id: taskId, status } };
      }
    }
  } catch (error) {
    return {
      ok: false,
      operation,
      error: {
        code: 'operation_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
