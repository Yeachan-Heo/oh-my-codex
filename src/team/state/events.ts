import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { TeamEvent } from './types.js';
import { isWakeableTeamEventType } from '../contracts.js';
import { teamEventLogPath, appendTeamEvent } from '../state.js';

interface TeamEventReadOptions {
  afterEventId?: string;
  wakeableOnly?: boolean;
  type?: TeamEvent['type'] | 'worker_idle';
  worker?: string;
  taskId?: string;
}

function asWorkerState(value: unknown): TeamEvent['state'] | undefined {
  return typeof value === 'string'
    && ['idle', 'working', 'blocked', 'done', 'failed', 'draining', 'unknown'].includes(value)
    ? value as TeamEvent['state']
    : undefined;
}

function normalizeRawTeamEvent(raw: unknown): TeamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const eventId = typeof value.event_id === 'string' ? value.event_id.trim() : '';
  const team = typeof value.team === 'string' ? value.team.trim() : '';
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  const worker = typeof value.worker === 'string' ? value.worker.trim() : '';
  const createdAt = typeof value.created_at === 'string' ? value.created_at.trim() : '';
  if (!eventId || !team || !type || !worker || !createdAt) return null;

  if (type === 'worker_idle') {
    return {
      ...(value as TeamEvent),
      event_id: eventId,
      team,
      type: 'worker_state_changed',
      source_type: 'worker_idle',
      worker,
      state: 'idle',
      prev_state: asWorkerState(value.prev_state),
      created_at: createdAt,
    };
  }

  return {
    ...(value as TeamEvent),
    event_id: eventId,
    team,
    type: type as TeamEvent['type'],
    worker,
    task_id: typeof value.task_id === 'string' ? value.task_id : undefined,
    message_id: typeof value.message_id === 'string' || value.message_id === null ? value.message_id as string | null : undefined,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    state: asWorkerState(value.state),
    prev_state: asWorkerState(value.prev_state),
    worker_count: typeof value.worker_count === 'number' ? value.worker_count : undefined,
    to_worker: typeof value.to_worker === 'string' ? value.to_worker : undefined,
    source_type: typeof value.source_type === 'string' ? value.source_type : undefined,
    created_at: createdAt,
  };
}

function isDuplicateNormalizedEvent(previous: TeamEvent | null, current: TeamEvent): boolean {
  if (!previous) return false;
  if (previous.type !== 'worker_state_changed' || current.type !== 'worker_state_changed') return false;
  return previous.team === current.team
    && previous.worker === current.worker
    && previous.task_id === current.task_id
    && previous.state === current.state
    && previous.prev_state === current.prev_state
    && current.source_type === 'worker_idle';
}

function matchesEventType(event: TeamEvent, type: TeamEventReadOptions['type']): boolean {
  if (!type) return true;
  if (event.type === type) return true;
  return type === 'worker_idle' && event.source_type === 'worker_idle';
}

function matchesEventQuery(event: TeamEvent, opts: TeamEventReadOptions): boolean {
  if (!matchesEventType(event, opts.type)) return false;
  if (opts.worker && event.worker !== opts.worker) return false;
  if (opts.taskId && event.task_id !== opts.taskId) return false;
  return true;
}

export async function readTeamEvents(
  teamName: string,
  cwd: string,
  opts: TeamEventReadOptions = {},
): Promise<TeamEvent[]> {
  const path = teamEventLogPath(teamName, cwd);
  if (!existsSync(path)) return [];

  const raw = await readFile(path, 'utf-8').catch(() => '');
  if (!raw.trim()) return [];

  const events: TeamEvent[] = [];
  let started = !opts.afterEventId;
  let previous: TeamEvent | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const normalized = normalizeRawTeamEvent(parsed);
    if (!normalized) continue;
    if (!started) {
      if (normalized.event_id === opts.afterEventId) started = true;
      continue;
    }
    if (isDuplicateNormalizedEvent(previous, normalized)) continue;
    previous = normalized;
    if (opts.wakeableOnly && !isWakeableTeamEventType(normalized.type)) continue;
    if (!matchesEventQuery(normalized, opts)) continue;
    events.push(normalized);
  }

  return events;
}

export async function getLatestTeamEventCursor(teamName: string, cwd: string): Promise<string> {
  const events = await readTeamEvents(teamName, cwd);
  return events.at(-1)?.event_id ?? '';
}

export async function waitForTeamEvent(
  teamName: string,
  cwd: string,
  opts: {
    afterEventId?: string;
    timeoutMs: number;
    pollMs?: number;
    wakeableOnly?: boolean;
    type?: TeamEvent['type'] | 'worker_idle';
    worker?: string;
    taskId?: string;
  },
): Promise<{ status: 'event' | 'timeout'; event?: TeamEvent; cursor: string }> {
  const deadline = Date.now() + Math.max(0, Math.floor(opts.timeoutMs));
  let pollMs = Math.max(25, Math.floor(opts.pollMs ?? 100));
  const baseline = opts.afterEventId ?? await getLatestTeamEventCursor(teamName, cwd);

  while (Date.now() <= deadline) {
    const events = await readTeamEvents(teamName, cwd, {
      afterEventId: baseline,
      wakeableOnly: opts.wakeableOnly !== false,
      type: opts.type,
      worker: opts.worker,
      taskId: opts.taskId,
    });
    const event = events[0];
    if (event) {
      return { status: 'event', event, cursor: event.event_id };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(Math.floor(pollMs * 1.5), 500);
  }

  return { status: 'timeout', cursor: baseline };
}

export { appendTeamEvent };
