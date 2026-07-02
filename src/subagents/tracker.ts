import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getBaseStateDir } from '../state/paths.js';

export const SUBAGENT_TRACKING_SCHEMA_VERSION = 1;
export const DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS = 120_000;

export type SubagentAvailabilityStatus = 'available' | 'closed' | 'unavailable';

export interface TrackedSubagentThread {
  thread_id: string;
  kind: 'leader' | 'subagent';
  first_seen_at: string;
  last_seen_at: string;
  completed_at?: string;
  last_turn_id?: string;
  last_completed_turn_id?: string;
  turn_count: number;
  mode?: string;
  role?: string;
  lane_id?: string;
  scope?: string;
  agent_nickname?: string;
  completion_source?: string;
  status?: SubagentAvailabilityStatus;
  last_handoff_summary?: string;
  resume_requested_at?: string;
  resume_completed_at?: string;
  resume_failed_at?: string;
  resume_failure_reason?: string;
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
  role?: string;
  laneId?: string;
  scope?: string;
  agentNickname?: string;
  kind?: 'leader' | 'subagent';
  leaderThreadId?: string;
  completed?: boolean;
  completionSource?: string;
  status?: SubagentAvailabilityStatus;
  lastHandoffSummary?: string;
  resumeRequestedAt?: string;
  resumeCompletedAt?: string;
  resumeFailedAt?: string;
  resumeFailureReason?: string;
  preserveCompletionEvidence?: boolean;
}

export interface SubagentSessionSummary {
  sessionId: string;
  leaderThreadId?: string;
  allThreadIds: string[];
  allSubagentThreadIds: string[];
  activeSubagentThreadIds: string[];
  savedSubagents: SubagentResumeEntry[];
  updatedAt?: string;
}

export interface SubagentResumeEntry {
  agentId: string;
  threadId: string;
  role?: string;
  laneId?: string;
  scope?: string;
  agentNickname?: string;
  status: SubagentAvailabilityStatus;
}

export interface SubagentLedgerEntry extends SubagentResumeEntry {
  lastSeenAt?: string;
  completedAt?: string;
  lastHandoffSummary?: string;
  resumeRequestedAt?: string;
  resumeCompletedAt?: string;
  resumeFailedAt?: string;
  resumeFailureReason?: string;
}

export interface SubagentResumeLedger extends SubagentSessionSummary {
  savedSubagents: SubagentLedgerEntry[];
  resumeTargets: SubagentLedgerEntry[];
  unavailableSubagents: SubagentLedgerEntry[];
}

export function subagentTrackingPath(cwd: string): string {
  return join(getBaseStateDir(cwd), 'subagent-tracking.json');
}

export function createSubagentTrackingState(): SubagentTrackingState {
  return {
    schemaVersion: SUBAGENT_TRACKING_SCHEMA_VERSION,
    sessions: {},
  };
}

function normalizeSubagentStatus(value: unknown): SubagentAvailabilityStatus | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'available' || normalized === 'closed' || normalized === 'unavailable') {
    return normalized;
  }
  return undefined;
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : undefined;
}

function rankSubagentStatus(status: SubagentAvailabilityStatus): number {
  if (status === 'available') return 0;
  if (status === 'closed') return 1;
  return 2;
}

function compareOptionalTimestampDesc(left?: string, right?: string): number {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);
  if (leftValid && rightValid && leftMs !== rightMs) return rightMs - leftMs;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return 0;
}

function compareResumeEntries(left: SubagentLedgerEntry, right: SubagentLedgerEntry): number {
  const leftStatusRank = rankSubagentStatus(left.status);
  const rightStatusRank = rankSubagentStatus(right.status);
  if (leftStatusRank !== rightStatusRank) return leftStatusRank - rightStatusRank;

  const leftActivityRank = left.lastSeenAt ? 0 : 1;
  const rightActivityRank = right.lastSeenAt ? 0 : 1;
  if (leftActivityRank !== rightActivityRank) return leftActivityRank - rightActivityRank;

  const lastSeenComparison = compareOptionalTimestampDesc(left.lastSeenAt, right.lastSeenAt);
  if (lastSeenComparison !== 0) return lastSeenComparison;

  const leftCompletedComparison = compareOptionalTimestampDesc(left.completedAt, right.completedAt);
  if (leftCompletedComparison !== 0) return leftCompletedComparison;

  return left.agentId.localeCompare(right.agentId);
}

function normalizeLedgerEntry(
  thread: TrackedSubagentThread,
  status: SubagentAvailabilityStatus,
): SubagentLedgerEntry {
  const role = thread.role ?? thread.mode;
  const laneId = thread.lane_id ?? thread.agent_nickname ?? role;
  return {
    agentId: thread.thread_id,
    threadId: thread.thread_id,
    ...(role ? { role } : {}),
    ...(laneId ? { laneId } : {}),
    ...(thread.scope ? { scope: thread.scope } : {}),
    ...(thread.agent_nickname ? { agentNickname: thread.agent_nickname } : {}),
    status,
    ...(thread.last_seen_at ? { lastSeenAt: thread.last_seen_at } : {}),
    ...(thread.completed_at ? { completedAt: thread.completed_at } : {}),
    ...(thread.last_handoff_summary ? { lastHandoffSummary: thread.last_handoff_summary } : {}),
    ...(thread.resume_requested_at ? { resumeRequestedAt: thread.resume_requested_at } : {}),
    ...(thread.resume_completed_at ? { resumeCompletedAt: thread.resume_completed_at } : {}),
    ...(thread.resume_failed_at ? { resumeFailedAt: thread.resume_failed_at } : {}),
    ...(thread.resume_failure_reason ? { resumeFailureReason: thread.resume_failure_reason } : {}),
  };
}

export function isTrustedSubagentThread(
  session: TrackedSubagentSession | null | undefined,
  threadId: string,
): boolean {
  const normalizedThreadId = threadId.trim();
  if (!session || !normalizedThreadId) return false;
  const leaderThreadId = session.leader_thread_id?.trim();
  if (leaderThreadId && leaderThreadId === normalizedThreadId) return false;
  return session.threads[normalizedThreadId]?.kind === 'subagent';
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
        ...(typeof candidate.completed_at === 'string' && candidate.completed_at.trim().length > 0
          ? { completed_at: candidate.completed_at }
          : {}),
        ...(typeof candidate.last_completed_turn_id === 'string' && candidate.last_completed_turn_id.trim().length > 0
          ? { last_completed_turn_id: candidate.last_completed_turn_id }
          : {}),
        turn_count: typeof candidate.turn_count === 'number' && Number.isFinite(candidate.turn_count) && candidate.turn_count > 0
          ? candidate.turn_count
          : 1,
        ...(typeof candidate.mode === 'string' && candidate.mode.trim().length > 0 ? { mode: candidate.mode } : {}),
        ...(typeof candidate.role === 'string' && candidate.role.trim().length > 0 ? { role: candidate.role.trim() } : {}),
        ...(typeof candidate.lane_id === 'string' && candidate.lane_id.trim().length > 0 ? { lane_id: candidate.lane_id.trim() } : {}),
        ...(typeof candidate.scope === 'string' && candidate.scope.trim().length > 0 ? { scope: candidate.scope.trim() } : {}),
        ...(typeof candidate.agent_nickname === 'string' && candidate.agent_nickname.trim().length > 0 ? { agent_nickname: candidate.agent_nickname.trim() } : {}),
        ...(typeof candidate.completion_source === 'string' && candidate.completion_source.trim().length > 0 ? { completion_source: candidate.completion_source } : {}),
        ...(normalizeSubagentStatus(candidate.status) ? { status: normalizeSubagentStatus(candidate.status) } : {}),
        ...(typeof candidate.last_handoff_summary === 'string' && candidate.last_handoff_summary.trim().length > 0
          ? { last_handoff_summary: candidate.last_handoff_summary.trim() }
          : {}),
        ...(typeof candidate.resume_requested_at === 'string' && candidate.resume_requested_at.trim().length > 0
          ? { resume_requested_at: candidate.resume_requested_at.trim() }
          : {}),
        ...(typeof candidate.resume_completed_at === 'string' && candidate.resume_completed_at.trim().length > 0
          ? { resume_completed_at: candidate.resume_completed_at.trim() }
          : {}),
        ...(typeof candidate.resume_failed_at === 'string' && candidate.resume_failed_at.trim().length > 0
          ? { resume_failed_at: candidate.resume_failed_at.trim() }
          : {}),
        ...(typeof candidate.resume_failure_reason === 'string' && candidate.resume_failure_reason.trim().length > 0
          ? { resume_failure_reason: candidate.resume_failure_reason.trim() }
          : {}),
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
  await mkdir(dirname(path), { recursive: true });
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

  const requestedKind = input.kind === 'leader' || input.kind === 'subagent' ? input.kind : undefined;
  const requestedLeaderThreadId = input.leaderThreadId?.trim();
  const existingThread = existingSession.threads[threadId];
  const existingKind = existingThread?.kind === 'leader' || existingThread?.kind === 'subagent'
    ? existingThread.kind
    : undefined;
  const existingLeaderThreadId = existingSession.leader_thread_id?.trim();
  // `leader_thread_id` is the session's top-level leader boundary.  A native
  // subagent can itself be the immediate parent of a nested native role, but
  // that must not reclassify known subagent evidence as the session leader.
  const requestedLeaderThread = requestedLeaderThreadId
    ? existingSession.threads[requestedLeaderThreadId]
    : undefined;
  const requestedLeaderWouldReclassifySubagent = requestedLeaderThread?.kind === 'subagent';
  const requestedSessionLeaderThreadId = requestedLeaderWouldReclassifySubagent
    ? undefined
    : requestedLeaderThreadId;
  const preserveExistingSubagent = existingKind === 'subagent' && requestedKind !== 'subagent';
  const preserveKnownLeader = requestedKind === 'subagent'
    && (existingKind === 'leader' || existingLeaderThreadId === threadId);
  const leaderThreadId = preserveKnownLeader
    ? existingLeaderThreadId || threadId
    : existingLeaderThreadId
      || requestedSessionLeaderThreadId
      || (requestedKind === 'subagent' || preserveExistingSubagent ? undefined : threadId);
  const kind = preserveKnownLeader
    ? 'leader'
    : requestedKind === 'leader' && existingKind === 'subagent'
      ? 'subagent'
      : requestedKind ?? (threadId === leaderThreadId ? 'leader' : existingKind ?? 'subagent');
  const requestedStatus = normalizeSubagentStatus(input.status);
  const preservedStatus = normalizeSubagentStatus(existingThread?.status);
  const preserveCompletionEvidence = input.preserveCompletionEvidence === true;
  const clearsPriorCompletion = input.completed !== true
    && preserveCompletionEvidence !== true
    && Boolean(existingThread?.completed_at);
  const status = requestedStatus
    ?? (input.completed ? 'closed' : undefined)
    ?? (clearsPriorCompletion ? undefined : preservedStatus);
  const preservedCompletion = preserveCompletionEvidence && existingThread?.completed_at
    ? {
        completed_at: existingThread.completed_at,
        ...(existingThread.last_completed_turn_id ? { last_completed_turn_id: existingThread.last_completed_turn_id } : {}),
        ...(existingThread.completion_source ? { completion_source: existingThread.completion_source } : {}),
      }
    : {};
  const nextThread: TrackedSubagentThread = {
    thread_id: threadId,
    kind,
    first_seen_at: existingThread?.first_seen_at ?? timestamp,
    last_seen_at: timestamp,
    turn_count: (existingThread?.turn_count ?? 0) + 1,
    ...(input.turnId?.trim() ? { last_turn_id: input.turnId.trim() } : existingThread?.last_turn_id ? { last_turn_id: existingThread.last_turn_id } : {}),
    ...(input.completed
      ? {
          completed_at: timestamp,
          ...(input.turnId?.trim() ? { last_completed_turn_id: input.turnId.trim() } : {}),
          ...(input.completionSource?.trim() ? { completion_source: input.completionSource.trim() } : {}),
        }
      : preservedCompletion),
    ...(input.mode?.trim() ? { mode: input.mode.trim() } : existingThread?.mode ? { mode: existingThread.mode } : {}),
    ...(input.role?.trim() ? { role: input.role.trim() } : existingThread?.role ? { role: existingThread.role } : {}),
    ...(input.laneId?.trim() ? { lane_id: input.laneId.trim() } : existingThread?.lane_id ? { lane_id: existingThread.lane_id } : {}),
    ...(input.scope?.trim() ? { scope: input.scope.trim() } : existingThread?.scope ? { scope: existingThread.scope } : {}),
    ...(input.agentNickname?.trim()
      ? { agent_nickname: input.agentNickname.trim() }
      : existingThread?.agent_nickname ? { agent_nickname: existingThread.agent_nickname } : {}),
    ...(status ? { status } : {}),
    ...(input.lastHandoffSummary?.trim()
      ? { last_handoff_summary: input.lastHandoffSummary.trim() }
      : existingThread?.last_handoff_summary ? { last_handoff_summary: existingThread.last_handoff_summary } : {}),
    ...(input.resumeRequestedAt?.trim()
      ? { resume_requested_at: input.resumeRequestedAt.trim() }
      : existingThread?.resume_requested_at ? { resume_requested_at: existingThread.resume_requested_at } : {}),
    ...(input.resumeCompletedAt?.trim()
      ? { resume_completed_at: input.resumeCompletedAt.trim() }
      : existingThread?.resume_completed_at ? { resume_completed_at: existingThread.resume_completed_at } : {}),
    ...(input.resumeFailedAt?.trim()
      ? { resume_failed_at: input.resumeFailedAt.trim() }
      : existingThread?.resume_failed_at ? { resume_failed_at: existingThread.resume_failed_at } : {}),
    ...(input.resumeFailureReason?.trim()
      ? { resume_failure_reason: input.resumeFailureReason.trim() }
      : existingThread?.resume_failure_reason ? { resume_failure_reason: existingThread.resume_failure_reason } : {}),
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
    ...(leaderThreadId ? { leader_thread_id: leaderThreadId } : {}),
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
  const allSubagentThreadIds = allThreadIds.filter((threadId) => isTrustedSubagentThread(session, threadId));
  const activeSubagentThreadIds = allSubagentThreadIds.filter((threadId) => {
    const thread = session.threads[threadId];
    if (!thread) return false;
    if (thread.completed_at) return false;
    const status = normalizeSubagentStatus(thread.status);
    if (status === 'closed' || status === 'unavailable') return false;
    const seenAt = Date.parse(thread.last_seen_at);
    if (!Number.isFinite(seenAt)) return false;
    return nowMs - seenAt <= activeWindowMs;
  });
  const activeSubagentThreadIdSet = new Set(activeSubagentThreadIds);
  const savedSubagents = allSubagentThreadIds.map((threadId): SubagentResumeEntry => {
    const thread = session.threads[threadId]!;
    const role = thread.role ?? thread.mode;
    const laneId = thread.lane_id ?? thread.agent_nickname ?? role;
    return {
      agentId: thread.thread_id,
      threadId: thread.thread_id,
      ...(role ? { role } : {}),
      ...(laneId ? { laneId } : {}),
      ...(thread.scope ? { scope: thread.scope } : {}),
      ...(thread.agent_nickname ? { agentNickname: thread.agent_nickname } : {}),
      status: thread.status ?? (activeSubagentThreadIdSet.has(threadId) ? 'available' : 'closed'),
    };
  });

  return {
    sessionId,
    leaderThreadId: session.leader_thread_id,
    allThreadIds,
    allSubagentThreadIds,
    activeSubagentThreadIds,
    savedSubagents,
    updatedAt: session.updated_at,
  };
}

export function buildSubagentResumeLedger(
  state: SubagentTrackingState,
  sessionId: string,
  options: { now?: string | Date; activeWindowMs?: number } = {},
): SubagentResumeLedger | null {
  const summary = summarizeSubagentSession(state, sessionId, options);
  if (!summary) return null;

  const normalized = normalizeSubagentTrackingState(state);
  const session = normalized.sessions[sessionId];
  if (!session) return null;

  const savedSubagents = summary.savedSubagents.map((entry): SubagentLedgerEntry => {
    const thread = session.threads[entry.threadId];
    if (!thread) return { ...entry } as SubagentLedgerEntry;
    const computedStatus = thread.status ?? entry.status;
    return normalizeLedgerEntry(thread, computedStatus);
  });

  const resumeTargets = [...savedSubagents].sort(compareResumeEntries);
  const unavailableSubagents = savedSubagents.filter((entry) => entry.status === 'unavailable');

  return {
    ...summary,
    savedSubagents,
    resumeTargets,
    unavailableSubagents,
  };
}

export async function readSubagentSessionLedger(
  cwd: string,
  sessionId: string,
  options: { now?: string | Date; activeWindowMs?: number } = {},
): Promise<SubagentResumeLedger | null> {
  return buildSubagentResumeLedger(await readSubagentTrackingState(cwd), sessionId, options);
}

export function selectReusableSubagentEntry(
  entries: readonly SubagentLedgerEntry[],
  criteria: {
    role?: string;
    laneId?: string;
    scope?: string;
    agentNickname?: string;
  } = {},
): SubagentLedgerEntry | null {
  const normalizedRole = readOptionalTrimmedString(criteria.role);
  const normalizedLaneId = readOptionalTrimmedString(criteria.laneId);
  const normalizedScope = readOptionalTrimmedString(criteria.scope);
  const normalizedAgentNickname = readOptionalTrimmedString(criteria.agentNickname);

  const matchingEntries = entries.filter((entry) => {
    if (entry.status === 'unavailable') return false;
    if (normalizedRole && entry.role !== normalizedRole) return false;
    if (normalizedLaneId && entry.laneId !== normalizedLaneId) return false;
    if (normalizedScope && entry.scope !== normalizedScope) return false;
    if (normalizedAgentNickname && entry.agentNickname !== normalizedAgentNickname) return false;
    return true;
  });

  const scoredEntries = matchingEntries
    .map((entry, index) => {
      const statusRank = rankSubagentStatus(entry.status);
      let score = 0;
      if (entry.status === 'available') score += 100;
      else if (entry.status === 'closed') score += 60;
      else score -= 100;

      if (normalizedRole && entry.role === normalizedRole) score += 30;
      if (normalizedLaneId && entry.laneId === normalizedLaneId) score += 24;
      if (normalizedScope && entry.scope === normalizedScope) score += 18;
      if (normalizedAgentNickname && entry.agentNickname === normalizedAgentNickname) score += 12;
      if (entry.lastSeenAt) score += 6;
      if (entry.lastHandoffSummary) score += 4;

      return { entry, index, score, statusRank };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.statusRank !== right.statusRank) return left.statusRank - right.statusRank;
      const leftActivity = compareOptionalTimestampDesc(left.entry.lastSeenAt, right.entry.lastSeenAt);
      if (leftActivity !== 0) return leftActivity;
      return left.index - right.index;
    });

  return scoredEntries[0]?.entry ?? null;
}

export async function readSubagentSessionSummary(
  cwd: string,
  sessionId: string,
  options: { now?: string | Date; activeWindowMs?: number } = {},
): Promise<SubagentSessionSummary | null> {
  return summarizeSubagentSession(await readSubagentTrackingState(cwd), sessionId, options);
}
