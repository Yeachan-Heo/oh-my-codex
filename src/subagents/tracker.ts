import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SUBAGENT_TRACKING_SCHEMA_VERSION = 1;
export const DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS = 120_000;

export interface TrackedSubagentThread {
  thread_id: string;
  kind: 'leader' | 'subagent';
  first_seen_at: string;
  last_seen_at: string;
  last_turn_id?: string;
  turn_count: number;
  mode?: string;
}

export interface TrackedSubagentSession {
  session_id: string;
  leader_thread_id?: string;
  updated_at: string;
  threads: Record<string, TrackedSubagentThread>;
}

export interface SubagentTrackingState {
  schemaVersion: 1;
  sessions: Record<string, TrackedSubagentSession>;
}

export interface RecordSubagentTurnInput {
  sessionId: string;
  threadId: string;
  turnId?: string;
  timestamp?: string;
  mode?: string;
}

export interface SubagentSessionSummary {
  sessionId: string;
  leaderThreadId?: string;
  allThreadIds: string[];
  allSubagentThreadIds: string[];
  activeSubagentThreadIds: string[];
  updatedAt?: string;
}

export function subagentTrackingPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'subagent-tracking.json');
}

export function createSubagentTrackingState(): SubagentTrackingState {
  return {
    schemaVersion: SUBAGENT_TRACKING_SCHEMA_VERSION,
    sessions: {},
  };
}

export function normalizeSubagentTrackingState(input: unknown): SubagentTrackingState {
  const base = createSubagentTrackingState();
  if (!input || typeof input !== 'object') return base;

  const parsed = input as Partial<SubagentTrackingState>;
  const sessions: Record<string, TrackedSubagentSession> = {};
  for (const [sessionId, rawSession] of Object.entries(parsed.sessions ?? {})) {
    if (!rawSession || typeof rawSession !== 'object') continue;
    const threads: Record<string, TrackedSubagentThread> = {};
    for (const [threadId, rawThread] of Object.entries((rawSession as TrackedSubagentSession).threads ?? {})) {
      if (!rawThread || typeof rawThread !== 'object') continue;
      const candidate = rawThread as Partial<TrackedSubagentThread>;
      const normalizedThreadId = typeof candidate.thread_id === 'string' && candidate.thread_id.trim().length > 0
        ? candidate.thread_id.trim()
        : threadId.trim();
      if (!normalizedThreadId) continue;
      const kind = candidate.kind === 'leader' ? 'leader' : 'subagent';
      const firstSeenAt = typeof candidate.first_seen_at === 'string' && candidate.first_seen_at.trim().length > 0
        ? candidate.first_seen_at
        : typeof candidate.last_seen_at === 'string' && candidate.last_seen_at.trim().length > 0
          ? candidate.last_seen_at
          : new Date(0).toISOString();
      const lastSeenAt = typeof candidate.last_seen_at === 'string' && candidate.last_seen_at.trim().length > 0
        ? candidate.last_seen_at
        : firstSeenAt;
      threads[normalizedThreadId] = {
        thread_id: normalizedThreadId,
        kind,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        ...(typeof candidate.last_turn_id === 'string' && candidate.last_turn_id.trim().length > 0
          ? { last_turn_id: candidate.last_turn_id }
          : {}),
        turn_count: typeof candidate.turn_count === 'number' && Number.isFinite(candidate.turn_count) && candidate.turn_count > 0
          ? candidate.turn_count
          : 1,
        ...(typeof candidate.mode === 'string' && candidate.mode.trim().length > 0 ? { mode: candidate.mode } : {}),
      };
    }

    const sessionCandidate = rawSession as TrackedSubagentSession;
    const leaderThreadId = typeof sessionCandidate.leader_thread_id === 'string'
      ? sessionCandidate.leader_thread_id.trim() || undefined
      : undefined;
    const updatedAt = typeof sessionCandidate.updated_at === 'string' && sessionCandidate.updated_at.trim().length > 0
      ? sessionCandidate.updated_at
      : new Date(0).toISOString();

    sessions[sessionId] = {
      session_id: sessionId,
      leader_thread_id: leaderThreadId,
      updated_at: updatedAt,
      threads,
    };
  }

  return {
    schemaVersion: SUBAGENT_TRACKING_SCHEMA_VERSION,
    sessions,
  };
}

export async function readSubagentTrackingState(cwd: string): Promise<SubagentTrackingState> {
  const path = subagentTrackingPath(cwd);
  if (!existsSync(path)) return createSubagentTrackingState();
  try {
    return normalizeSubagentTrackingState(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return createSubagentTrackingState();
  }
}

export async function writeSubagentTrackingState(cwd: string, state: SubagentTrackingState): Promise<string> {
  const normalized = normalizeSubagentTrackingState(state);
  const path = subagentTrackingPath(cwd);
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return path;
}

export function recordSubagentTurn(
  state: SubagentTrackingState,
  input: RecordSubagentTurnInput,
): SubagentTrackingState {
  const sessionId = input.sessionId.trim();
  const threadId = input.threadId.trim();
  if (!sessionId || !threadId) return normalizeSubagentTrackingState(state);

  const timestamp = input.timestamp ?? new Date().toISOString();
  const normalized = normalizeSubagentTrackingState(state);
  const existingSession = normalized.sessions[sessionId] ?? {
    session_id: sessionId,
    updated_at: timestamp,
    threads: {},
  };

  const leaderThreadId = existingSession.leader_thread_id || threadId;
  const existingThread = existingSession.threads[threadId];
  const nextThread: TrackedSubagentThread = {
    thread_id: threadId,
    kind: threadId === leaderThreadId ? 'leader' : 'subagent',
    first_seen_at: existingThread?.first_seen_at ?? timestamp,
    last_seen_at: timestamp,
    turn_count: (existingThread?.turn_count ?? 0) + 1,
    ...(input.turnId?.trim() ? { last_turn_id: input.turnId.trim() } : existingThread?.last_turn_id ? { last_turn_id: existingThread.last_turn_id } : {}),
    ...(input.mode?.trim() ? { mode: input.mode.trim() } : existingThread?.mode ? { mode: existingThread.mode } : {}),
  };

  const threads = {
    ...existingSession.threads,
    [threadId]: nextThread,
  };
  if (leaderThreadId && threadId !== leaderThreadId && threads[leaderThreadId]) {
    threads[leaderThreadId] = {
      ...threads[leaderThreadId],
      kind: 'leader',
    };
  }

  normalized.sessions[sessionId] = {
    session_id: sessionId,
    leader_thread_id: leaderThreadId,
    updated_at: timestamp,
    threads,
  };
  return normalized;
}

export async function recordSubagentTurnForSession(cwd: string, input: RecordSubagentTurnInput): Promise<SubagentTrackingState> {
  const current = await readSubagentTrackingState(cwd);
  const next = recordSubagentTurn(current, input);
  await writeSubagentTrackingState(cwd, next);
  return next;
}

export function summarizeSubagentSession(
  state: SubagentTrackingState,
  sessionId: string,
  options: { now?: string | Date; activeWindowMs?: number } = {},
): SubagentSessionSummary | null {
  const normalized = normalizeSubagentTrackingState(state);
  const session = normalized.sessions[sessionId];
  if (!session) return null;

  const activeWindowMs = options.activeWindowMs ?? DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS;
  const nowMs = typeof options.now === 'string'
    ? Date.parse(options.now)
    : options.now instanceof Date
      ? options.now.getTime()
      : Date.now();

  const allThreadIds = Object.keys(session.threads).sort();
  const allSubagentThreadIds = allThreadIds.filter((threadId) => session.threads[threadId]?.kind === 'subagent');
  const activeSubagentThreadIds = allSubagentThreadIds.filter((threadId) => {
    const thread = session.threads[threadId];
    if (!thread) return false;
    const seenAt = Date.parse(thread.last_seen_at);
    if (!Number.isFinite(seenAt)) return false;
    return nowMs - seenAt <= activeWindowMs;
  });

  return {
    sessionId,
    leaderThreadId: session.leader_thread_id,
    allThreadIds,
    allSubagentThreadIds,
    activeSubagentThreadIds,
    updatedAt: session.updated_at,
  };
}

export async function readSubagentSessionSummary(
  cwd: string,
  sessionId: string,
  options: { now?: string | Date; activeWindowMs?: number } = {},
): Promise<SubagentSessionSummary | null> {
  return summarizeSubagentSession(await readSubagentTrackingState(cwd), sessionId, options);
}
