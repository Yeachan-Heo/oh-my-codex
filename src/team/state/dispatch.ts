import { randomUUID } from 'crypto';
import { getDefaultBridge, isBridgeEnabled, resolveBridgeStateDir, type DispatchRecord, type RuntimeCommand } from '../../runtime/bridge.js';
import { appendTeamDeliveryLogForCwd } from '../delivery-log.js';
import { isTeamReminderIntent, type TeamReminderIntent } from '../reminder-intents.js';
import {
  canTransitionTeamDispatchRequestStatus,
  isTeamDispatchRequestStatus,
  type TeamDispatchRequestStatus,
} from '../contracts.js';

export type TeamDispatchRequestKind = 'inbox' | 'mailbox' | 'nudge';
export type TeamDispatchTransportPreference = 'hook_preferred_with_fallback' | 'transport_direct' | 'prompt_stdin';

export interface TeamDispatchRequest {
  request_id: string;
  kind: TeamDispatchRequestKind;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  intent?: TeamReminderIntent;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference: TeamDispatchTransportPreference;
  fallback_allowed: boolean;
  status: TeamDispatchRequestStatus;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  last_reason?: string;
}

export interface TeamDispatchRequestInput {
  kind: TeamDispatchRequestKind;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  intent?: TeamReminderIntent;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference?: TeamDispatchTransportPreference;
  fallback_allowed?: boolean;
  last_reason?: string;
}

interface DispatchDeps {
  teamName: string;
  cwd: string;
  validateWorkerName: (name: string) => void;
  withDispatchLock: <T>(teamName: string, cwd: string, fn: () => Promise<T>) => Promise<T>;
  readDispatchRequests: (teamName: string, cwd: string) => Promise<TeamDispatchRequest[]>;
  writeDispatchRequests: (teamName: string, requests: TeamDispatchRequest[], cwd: string) => Promise<void>;
}

function isDispatchKind(value: unknown): value is TeamDispatchRequestKind {
  return value === 'inbox' || value === 'mailbox' || value === 'nudge';
}

function sanitizeDispatchRequestForStatus(record: TeamDispatchRequest): TeamDispatchRequest {
  if (record.status === 'pending') {
    return {
      ...record,
      notified_at: undefined,
      delivered_at: undefined,
      failed_at: undefined,
    };
  }
  if (record.status === 'notified') {
    return {
      ...record,
      delivered_at: undefined,
      failed_at: undefined,
    };
  }
  if (record.status === 'delivered') {
    return {
      ...record,
      failed_at: undefined,
    };
  }
  return {
    ...record,
    delivered_at: undefined,
  };
}

export function normalizeDispatchRequest(
  teamName: string,
  raw: Partial<TeamDispatchRequest>,
  nowIso: string = new Date().toISOString(),
): TeamDispatchRequest | null {
  if (!isDispatchKind(raw.kind)) return null;
  if (typeof raw.to_worker !== 'string' || raw.to_worker.trim() === '') return null;
  if (typeof raw.trigger_message !== 'string' || raw.trigger_message.trim() === '') return null;

  const status = isTeamDispatchRequestStatus(raw.status) ? raw.status : 'pending';
  return sanitizeDispatchRequestForStatus({
    request_id: typeof raw.request_id === 'string' && raw.request_id.trim() !== '' ? raw.request_id : randomUUID(),
    kind: raw.kind,
    team_name: teamName,
    to_worker: raw.to_worker,
    worker_index: typeof raw.worker_index === 'number' ? raw.worker_index : undefined,
    pane_id: typeof raw.pane_id === 'string' && raw.pane_id !== '' ? raw.pane_id : undefined,
    trigger_message: raw.trigger_message,
    intent: isTeamReminderIntent(raw.intent) ? raw.intent : undefined,
    message_id: typeof raw.message_id === 'string' && raw.message_id !== '' ? raw.message_id : undefined,
    inbox_correlation_key:
      typeof raw.inbox_correlation_key === 'string' && raw.inbox_correlation_key !== '' ? raw.inbox_correlation_key : undefined,
    transport_preference:
      raw.transport_preference === 'transport_direct' || raw.transport_preference === 'prompt_stdin'
        ? raw.transport_preference
        : 'hook_preferred_with_fallback',
    fallback_allowed: raw.fallback_allowed !== false,
    status,
    attempt_count: Number.isFinite(raw.attempt_count) ? Math.max(0, Math.floor(raw.attempt_count as number)) : 0,
    created_at: typeof raw.created_at === 'string' && raw.created_at !== '' ? raw.created_at : nowIso,
    updated_at: typeof raw.updated_at === 'string' && raw.updated_at !== '' ? raw.updated_at : nowIso,
    notified_at: typeof raw.notified_at === 'string' && raw.notified_at !== '' ? raw.notified_at : undefined,
    delivered_at: typeof raw.delivered_at === 'string' && raw.delivered_at !== '' ? raw.delivered_at : undefined,
    failed_at: typeof raw.failed_at === 'string' && raw.failed_at !== '' ? raw.failed_at : undefined,
    last_reason: typeof raw.last_reason === 'string' && raw.last_reason !== '' ? raw.last_reason : undefined,
  });
}

function equivalentPendingDispatch(existing: TeamDispatchRequest, input: TeamDispatchRequestInput): boolean {
  if (existing.status !== 'pending') return false;
  if (existing.kind !== input.kind) return false;
  if (existing.to_worker !== input.to_worker) return false;

  if (input.kind === 'mailbox') {
    return Boolean(input.message_id) && existing.message_id === input.message_id;
  }

  if (input.kind === 'inbox' && input.inbox_correlation_key) {
    return existing.inbox_correlation_key === input.inbox_correlation_key;
  }

  return existing.trigger_message === input.trigger_message;
}

function canTransitionDispatchStatus(from: TeamDispatchRequestStatus, to: TeamDispatchRequestStatus): boolean {
  if (from === to) return true;
  return canTransitionTeamDispatchRequestStatus(from, to);
}

function buildDispatchMetadata(teamName: string, requestInput: TeamDispatchRequestInput): Record<string, unknown> {
  return {
    kind: requestInput.kind,
    team_name: teamName,
    worker_index: requestInput.worker_index,
    pane_id: requestInput.pane_id,
    trigger_message: requestInput.trigger_message,
    intent: requestInput.intent,
    message_id: requestInput.message_id,
    inbox_correlation_key: requestInput.inbox_correlation_key,
    transport_preference: requestInput.transport_preference,
    fallback_allowed: requestInput.fallback_allowed,
  };
}

function executeBridgeCommand(cwd: string, command: RuntimeCommand): boolean {
  if (!isBridgeEnabled()) return false;
  try {
    getDefaultBridge(resolveBridgeStateDir(cwd)).execCommand(command);
    return true;
  } catch {
    return false;
  }
}

function coerceMetadataValue<T extends string | number | boolean>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): T | undefined {
  return predicate(value) ? value : undefined;
}

export function normalizeBridgeDispatchRecord(
  teamName: string,
  record: DispatchRecord,
  nowIso: string = new Date().toISOString(),
): TeamDispatchRequest | null {
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? (record.metadata as Record<string, unknown>)
    : {};
  const metadataTeamName = typeof metadata.team_name === 'string' && metadata.team_name.trim() !== ''
    ? metadata.team_name.trim()
    : null;
  if (metadataTeamName !== null && metadataTeamName !== teamName) return null;

  return normalizeDispatchRequest(
    teamName,
    {
      request_id: record.request_id,
      kind: coerceMetadataValue(metadata.kind, isDispatchKind) ?? 'inbox',
      to_worker: record.target,
      worker_index: typeof metadata.worker_index === 'number' ? metadata.worker_index : undefined,
      pane_id: typeof metadata.pane_id === 'string' && metadata.pane_id !== '' ? metadata.pane_id : undefined,
      trigger_message:
        typeof metadata.trigger_message === 'string' && metadata.trigger_message.trim() !== ''
          ? metadata.trigger_message
          : record.reason ?? record.request_id,
      intent: isTeamReminderIntent(metadata.intent) ? metadata.intent : undefined,
      message_id: typeof metadata.message_id === 'string' && metadata.message_id !== '' ? metadata.message_id : undefined,
      inbox_correlation_key:
        typeof metadata.inbox_correlation_key === 'string' && metadata.inbox_correlation_key !== ''
          ? metadata.inbox_correlation_key
          : undefined,
      transport_preference: coerceMetadataValue(
        metadata.transport_preference,
        (candidate): candidate is TeamDispatchTransportPreference =>
          candidate === 'hook_preferred_with_fallback' || candidate === 'transport_direct' || candidate === 'prompt_stdin',
      ),
      fallback_allowed:
        typeof metadata.fallback_allowed === 'boolean'
          ? metadata.fallback_allowed
          : undefined,
      status: record.status,
      attempt_count: typeof metadata.attempt_count === 'number' ? metadata.attempt_count : 0,
      created_at: record.created_at,
      updated_at: record.delivered_at ?? record.failed_at ?? record.notified_at ?? record.created_at ?? nowIso,
      notified_at: record.notified_at ?? undefined,
      delivered_at: record.delivered_at ?? undefined,
      failed_at: record.failed_at ?? undefined,
      last_reason: record.reason ?? undefined,
    },
    nowIso,
  );
}

export async function enqueueDispatchRequest(
  requestInput: TeamDispatchRequestInput,
  deps: DispatchDeps,
): Promise<{ request: TeamDispatchRequest; deduped: boolean }> {
  if (!isDispatchKind(requestInput.kind)) throw new Error(`Invalid dispatch request kind: ${String(requestInput.kind)}`);
  if (requestInput.kind === 'mailbox' && (!requestInput.message_id || requestInput.message_id.trim() === '')) {
    throw new Error('mailbox dispatch requests require message_id');
  }
  deps.validateWorkerName(requestInput.to_worker);

  const queued = await deps.withDispatchLock(deps.teamName, deps.cwd, async () => {
    const requests = await deps.readDispatchRequests(deps.teamName, deps.cwd);
    const existing = requests.find((req) => equivalentPendingDispatch(req, requestInput));
    if (existing) return { request: existing, deduped: true };

    const nowIso = new Date().toISOString();
    const request = normalizeDispatchRequest(
      deps.teamName,
      {
        request_id: randomUUID(),
        ...requestInput,
        status: 'pending',
        attempt_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
      },
      nowIso,
    );
    if (!request) throw new Error('failed_to_normalize_dispatch_request');

    if (executeBridgeCommand(deps.cwd, {
      command: 'QueueDispatch',
      request_id: request.request_id,
      target: requestInput.to_worker,
      metadata: buildDispatchMetadata(deps.teamName, requestInput),
    })) {
      const bridgeRequest = await readDispatchRequest(request.request_id, deps);
      if (bridgeRequest) {
        return { request: bridgeRequest, deduped: false, queuedTransport: 'bridge' as const };
      }
    }

    requests.push(request);
    await deps.writeDispatchRequests(deps.teamName, requests, deps.cwd);
    return { request, deduped: false, queuedTransport: 'legacy-json' as const };
  });
  if (!queued.deduped) {
    await appendTeamDeliveryLogForCwd(deps.cwd, {
      event: 'dispatch_attempted',
      source: 'team.state.dispatch',
      team: deps.teamName,
      request_id: queued.request.request_id,
      message_id: queued.request.message_id,
      to_worker: queued.request.to_worker,
      dispatch_kind: queued.request.kind,
      intent: queued.request.intent,
      transport: queued.request.transport_preference,
      result: 'queued',
      storage: queued.queuedTransport,
    });
  }
  return { request: queued.request, deduped: queued.deduped };
}

export async function listDispatchRequests(
  opts: { status?: TeamDispatchRequestStatus; kind?: TeamDispatchRequestKind; to_worker?: string; limit?: number } = {},
  deps: DispatchDeps,
): Promise<TeamDispatchRequest[]> {
  const requests = await deps.readDispatchRequests(deps.teamName, deps.cwd);
  let filtered = requests;
  if (opts.status) filtered = filtered.filter((req) => req.status === opts.status);
  if (opts.kind) filtered = filtered.filter((req) => req.kind === opts.kind);
  if (opts.to_worker) filtered = filtered.filter((req) => req.to_worker === opts.to_worker);
  if (typeof opts.limit === 'number' && opts.limit > 0) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

export async function readDispatchRequest(requestId: string, deps: DispatchDeps): Promise<TeamDispatchRequest | null> {
  const requests = await deps.readDispatchRequests(deps.teamName, deps.cwd);
  return requests.find((req) => req.request_id === requestId) ?? null;
}

export async function transitionDispatchRequest(
  requestId: string,
  from: TeamDispatchRequestStatus,
  to: TeamDispatchRequestStatus,
  patch: Partial<TeamDispatchRequest> = {},
  deps: DispatchDeps,
): Promise<TeamDispatchRequest | null> {
  return await deps.withDispatchLock(deps.teamName, deps.cwd, async () => {
    const requests = await deps.readDispatchRequests(deps.teamName, deps.cwd);
    const index = requests.findIndex((req) => req.request_id === requestId);
    if (index < 0) return null;

    const existing = requests[index]!;
    if (existing.status !== from && existing.status !== to) return null;
    if (!canTransitionDispatchStatus(existing.status, to)) return null;

    const nowIso = new Date().toISOString();
    const nextAttemptCount = Math.max(
      existing.attempt_count,
      Number.isFinite(patch.attempt_count)
        ? Math.floor(patch.attempt_count as number)
        : (existing.status === to ? existing.attempt_count : existing.attempt_count + 1),
    );

    const next = sanitizeDispatchRequestForStatus({
      ...existing,
      ...patch,
      status: to,
      attempt_count: Math.max(0, nextAttemptCount),
      updated_at: nowIso,
    });
    if (to === 'notified') {
      next.notified_at = patch.notified_at ?? nowIso;
      next.failed_at = patch.failed_at;
    }
    if (to === 'delivered') next.delivered_at = patch.delivered_at ?? nowIso;
    if (to === 'failed') next.failed_at = patch.failed_at ?? nowIso;

    requests[index] = next;
    await deps.writeDispatchRequests(deps.teamName, requests, deps.cwd);
    return next;
  });
}

export async function markDispatchRequestNotified(
  requestId: string,
  patch: Partial<TeamDispatchRequest> = {},
  deps: DispatchDeps,
): Promise<TeamDispatchRequest | null> {
  const current = await readDispatchRequest(requestId, deps);
  if (!current) return null;
  if (current.status === 'notified' || current.status === 'delivered') return current;
  // `failed` is a terminal state per TEAM_DISPATCH_REQUEST_STATUS_TRANSITIONS —
  // return null so callers can fall through to an explicit failed→failed
  // reason patch instead of silently promoting via the bridge side-channel.
  if (current.status === 'failed') return null;
  if (executeBridgeCommand(deps.cwd, {
    command: 'MarkNotified',
    request_id: requestId,
    channel: patch.last_reason ?? patch.message_id ?? 'tmux',
  })) {
    return await readDispatchRequest(requestId, deps) ?? current;
  }
  return await transitionDispatchRequest(requestId, current.status, 'notified', patch, deps);
}

export async function markDispatchRequestDelivered(
  requestId: string,
  patch: Partial<TeamDispatchRequest> = {},
  deps: DispatchDeps,
): Promise<TeamDispatchRequest | null> {
  const current = await readDispatchRequest(requestId, deps);
  if (!current) return null;
  if (current.status === 'delivered') return current;
  // Mirror the terminal-state guard from markDispatchRequestNotified: failed
  // dispatches cannot be promoted to delivered via the bridge side-channel.
  if (current.status === 'failed') return null;
  if (executeBridgeCommand(deps.cwd, { command: 'MarkDelivered', request_id: requestId })) {
    return await readDispatchRequest(requestId, deps) ?? current;
  }
  return await transitionDispatchRequest(requestId, current.status, 'delivered', patch, deps);
}

export async function markDispatchRequestFailed(
  requestId: string,
  reason: string,
  deps: DispatchDeps,
): Promise<void> {
  if (executeBridgeCommand(deps.cwd, { command: 'MarkFailed', request_id: requestId, reason })) {
    return;
  }
  await transitionDispatchRequest(requestId, 'pending', 'failed', { last_reason: reason }, deps);
}
