import { randomUUID } from 'crypto';

export type TeamDispatchRequestKind = 'inbox' | 'mailbox' | 'nudge';
export type TeamDispatchRequestStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export type TeamDispatchTransportPreference = 'hook_preferred_with_fallback' | 'transport_direct' | 'prompt_stdin';

export interface TeamDispatchRequest {
  request_id: string;
  kind: TeamDispatchRequestKind;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
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
  readDispatchRequest: (teamName: string, requestId: string, cwd: string) => Promise<TeamDispatchRequest | null>;
  writeDispatchRequest: (teamName: string, request: TeamDispatchRequest, cwd: string) => Promise<void>;
}

function isDispatchKind(value: unknown): value is TeamDispatchRequestKind {
  return value === 'inbox' || value === 'mailbox' || value === 'nudge';
}

function isDispatchStatus(value: unknown): value is TeamDispatchRequestStatus {
  return value === 'pending' || value === 'notified' || value === 'delivered' || value === 'failed';
}

export function normalizeDispatchRequest(
  teamName: string,
  raw: Partial<TeamDispatchRequest>,
  nowIso: string = new Date().toISOString(),
): TeamDispatchRequest | null {
  if (!isDispatchKind(raw.kind)) return null;
  if (typeof raw.to_worker !== 'string' || raw.to_worker.trim() === '') return null;
  if (typeof raw.trigger_message !== 'string' || raw.trigger_message.trim() === '') return null;

  const status = isDispatchStatus(raw.status) ? raw.status : 'pending';
  return {
    request_id: typeof raw.request_id === 'string' && raw.request_id.trim() !== '' ? raw.request_id : randomUUID(),
    kind: raw.kind,
    team_name: teamName,
    to_worker: raw.to_worker,
    worker_index: typeof raw.worker_index === 'number' ? raw.worker_index : undefined,
    pane_id: typeof raw.pane_id === 'string' && raw.pane_id !== '' ? raw.pane_id : undefined,
    trigger_message: raw.trigger_message,
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
  };
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
  if (from === 'pending' && (to === 'notified' || to === 'failed')) return true;
  if (from === 'notified' && (to === 'delivered' || to === 'failed')) return true;
  return false;
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

  return await deps.withDispatchLock(deps.teamName, deps.cwd, async () => {
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

    await deps.writeDispatchRequest(deps.teamName, request, deps.cwd);
    return { request, deduped: false };
  });
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
  return await deps.readDispatchRequest(deps.teamName, requestId, deps.cwd);
}

export async function transitionDispatchRequest(
  requestId: string,
  from: TeamDispatchRequestStatus,
  to: TeamDispatchRequestStatus,
  patch: Partial<TeamDispatchRequest> = {},
  deps: DispatchDeps,
): Promise<TeamDispatchRequest | null> {
  return await deps.withDispatchLock(deps.teamName, deps.cwd, async () => {
    const existing = await deps.readDispatchRequest(deps.teamName, requestId, deps.cwd);
    if (!existing) return null;
    if (existing.status !== from && existing.status !== to) return null;
    if (!canTransitionDispatchStatus(existing.status, to)) return null;

    const nowIso = new Date().toISOString();
    const nextAttemptCount = Math.max(
      existing.attempt_count,
      Number.isFinite(patch.attempt_count)
        ? Math.floor(patch.attempt_count as number)
        : (existing.status === to ? existing.attempt_count : existing.attempt_count + 1),
    );

    const next: TeamDispatchRequest = {
      ...existing,
      ...patch,
      status: to,
      attempt_count: Math.max(0, nextAttemptCount),
      updated_at: nowIso,
    };
    if (to === 'notified') next.notified_at = patch.notified_at ?? nowIso;
    if (to === 'delivered') next.delivered_at = patch.delivered_at ?? nowIso;
    if (to === 'failed') next.failed_at = patch.failed_at ?? nowIso;

    await deps.writeDispatchRequest(deps.teamName, next, deps.cwd);
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
  return await transitionDispatchRequest(requestId, current.status, 'delivered', patch, deps);
}
