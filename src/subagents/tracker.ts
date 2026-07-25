import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AGENT_DEFINITIONS } from '../agents/definitions.js';
import { getBaseStateDir } from '../state/paths.js';


import { codexAgentsDir, projectCodexAgentsDir } from '../utils/paths.js';

export const SUBAGENT_TRACKING_SCHEMA_VERSION = 1;
export const DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS = 120_000;

export const NATIVE_SUBAGENT_PROVENANCE = 'native_subagent';
// Legacy descriptive provenance written by pre-authority releases. Tolerated as
// descriptive-only evidence: it never grants reopen authority and never blocks a
// newly attested valid direct child, but it is preserved so authority-consistency
// checks can distinguish recognized legacy data from unknown descriptive views.
export const DESCRIPTIVE_ADAPTED_PROVENANCE = 'adapted';

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
  provenance_kind?: string;
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
  // Reopen authority is explicit direct-child attestation, never inferred from lifecycle metadata.
  direct_child_root_id?: string;
  direct_child_parent_id?: string;
  reopen_authority_revoked?: boolean;
  reopen_authority_conflict_reason?: string;
  reopen_authority_conflict_at?: string;
}

export interface TrackedSubagentSession {
  session_id: string;
  // Native lifecycle observations are descriptive only and must not grant authority.
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
  provenanceKind?: string;
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

export interface NativeSubagentAuthorityObservation {
  sessionIds: string[];
  childThreadId: string;
  parentThreadId: string;
  rootNativeSessionId?: string;
  authorityEvidence?: 'valid' | 'untrusted' | 'absent';
  implicatedChildThreadIds?: string[];
  mode?: string;
  timestamp?: string;
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

const KNOWN_TYPED_AGENT_ROLES = new Set(Object.keys(AGENT_DEFINITIONS).map((role) => role.toLowerCase()));

export function subagentTrackingPath(cwd: string): string {
  return join(getBaseStateDir(cwd), 'subagent-tracking.json');
}


export function resolveInstalledRoleName(role: string, codexHomeOverride?: string, projectRootOverride?: string): string | null {
  const normalizedRole = role.trim().toLowerCase();
  if (!normalizedRole) return null;
  if (KNOWN_TYPED_AGENT_ROLES.has(normalizedRole)) return normalizedRole;

  for (const agentsDir of [codexAgentsDir(codexHomeOverride), projectCodexAgentsDir(projectRootOverride)]) {
    try {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
        const installedRole = entry.name.slice(0, -'.toml'.length).trim().toLowerCase();
        if (installedRole === normalizedRole) return installedRole;
      }
    } catch {
      // Missing or unreadable agent directories do not invalidate built-in roles.
    }
  }

  return null;
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

function normalizeLedgerEntry(thread: TrackedSubagentThread, status: SubagentAvailabilityStatus): SubagentLedgerEntry {
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

export function isTrustedSubagentThread(session: TrackedSubagentSession | null | undefined, threadId: string): boolean {
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
      const normalizedThreadId =
        typeof candidate.thread_id === 'string' && candidate.thread_id.trim().length > 0 ? candidate.thread_id.trim() : threadId.trim();
      if (!normalizedThreadId) continue;
      const kind = candidate.kind === 'leader' ? 'leader' : 'subagent';
      const firstSeenAt =
        typeof candidate.first_seen_at === 'string' && candidate.first_seen_at.trim().length > 0
          ? candidate.first_seen_at
          : typeof candidate.last_seen_at === 'string' && candidate.last_seen_at.trim().length > 0
            ? candidate.last_seen_at
            : new Date(0).toISOString();
      const lastSeenAt =
        typeof candidate.last_seen_at === 'string' && candidate.last_seen_at.trim().length > 0 ? candidate.last_seen_at : firstSeenAt;
      threads[normalizedThreadId] = {
        thread_id: normalizedThreadId,
        kind,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        ...(typeof candidate.last_turn_id === 'string' && candidate.last_turn_id.trim().length > 0 ? { last_turn_id: candidate.last_turn_id } : {}),
        ...(typeof candidate.completed_at === 'string' && candidate.completed_at.trim().length > 0 ? { completed_at: candidate.completed_at } : {}),
        ...(typeof candidate.last_completed_turn_id === 'string' && candidate.last_completed_turn_id.trim().length > 0
          ? { last_completed_turn_id: candidate.last_completed_turn_id }
          : {}),
        turn_count:
          typeof candidate.turn_count === 'number' && Number.isFinite(candidate.turn_count) && candidate.turn_count > 0 ? candidate.turn_count : 1,
        ...(typeof candidate.mode === 'string' && candidate.mode.trim().length > 0 ? { mode: candidate.mode } : {}),
        ...(typeof candidate.role === 'string' && candidate.role.trim().length > 0 ? { role: candidate.role.trim() } : {}),
        ...(candidate.provenance_kind === NATIVE_SUBAGENT_PROVENANCE
          ? { provenance_kind: NATIVE_SUBAGENT_PROVENANCE }
          : candidate.provenance_kind === DESCRIPTIVE_ADAPTED_PROVENANCE
            ? { provenance_kind: DESCRIPTIVE_ADAPTED_PROVENANCE }
            : {}),
        ...(typeof candidate.lane_id === 'string' && candidate.lane_id.trim().length > 0 ? { lane_id: candidate.lane_id.trim() } : {}),
        ...(typeof candidate.scope === 'string' && candidate.scope.trim().length > 0 ? { scope: candidate.scope.trim() } : {}),
        ...(typeof candidate.agent_nickname === 'string' && candidate.agent_nickname.trim().length > 0
          ? { agent_nickname: candidate.agent_nickname.trim() }
          : {}),
        ...(typeof candidate.completion_source === 'string' && candidate.completion_source.trim().length > 0
          ? { completion_source: candidate.completion_source }
          : {}),
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
        ...(typeof candidate.direct_child_root_id === 'string' && candidate.direct_child_root_id.trim().length > 0
          ? { direct_child_root_id: candidate.direct_child_root_id.trim() }
          : {}),
        ...(typeof candidate.direct_child_parent_id === 'string' && candidate.direct_child_parent_id.trim().length > 0
          ? { direct_child_parent_id: candidate.direct_child_parent_id.trim() }
          : {}),
        ...(candidate.reopen_authority_revoked === true ? { reopen_authority_revoked: true } : {}),
        ...(typeof candidate.reopen_authority_conflict_reason === 'string' && candidate.reopen_authority_conflict_reason.trim()
          ? { reopen_authority_conflict_reason: candidate.reopen_authority_conflict_reason.trim() }
          : {}),
        ...(typeof candidate.reopen_authority_conflict_at === 'string' && candidate.reopen_authority_conflict_at.trim()
          ? { reopen_authority_conflict_at: candidate.reopen_authority_conflict_at.trim() }
          : {}),
      };
    }

    const sessionCandidate = rawSession as TrackedSubagentSession;
    const leaderThreadId = typeof sessionCandidate.leader_thread_id === 'string' ? sessionCandidate.leader_thread_id.trim() || undefined : undefined;
    const updatedAt =
      typeof sessionCandidate.updated_at === 'string' && sessionCandidate.updated_at.trim().length > 0
        ? sessionCandidate.updated_at
        : new Date(0).toISOString();

    sessions[sessionId] = {
      session_id: sessionId,
      ...(leaderThreadId ? { leader_thread_id: leaderThreadId } : {}),
      updated_at: updatedAt,
      threads,
    };
  }

  return {
    schemaVersion: SUBAGENT_TRACKING_SCHEMA_VERSION,
    sessions,
  };
}

function parseStrictSubagentTrackingState(raw: string): SubagentTrackingState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as { schemaVersion?: unknown; sessions?: unknown };
  if (candidate.schemaVersion !== SUBAGENT_TRACKING_SCHEMA_VERSION || !candidate.sessions || typeof candidate.sessions !== 'object' || Array.isArray(candidate.sessions)) return null;
  const normalizedSessionIds = new Set<string>();
  for (const [sessionId, sessionValue] of Object.entries(candidate.sessions as Record<string, unknown>)) {
    if (!sessionId || sessionId.trim() !== sessionId || normalizedSessionIds.has(sessionId.trim())) return null;
    normalizedSessionIds.add(sessionId.trim());
    if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) return null;
    const session = sessionValue as Record<string, unknown>;
    if (session.session_id !== sessionId || typeof session.updated_at !== 'string' || !session.updated_at.trim()) return null;
    if (!session.threads || typeof session.threads !== 'object' || Array.isArray(session.threads)) return null;
    if (session.leader_thread_id !== undefined && (typeof session.leader_thread_id !== 'string' || !session.leader_thread_id.trim() || session.leader_thread_id.trim() !== session.leader_thread_id)) return null;
    const normalizedThreadIds = new Set<string>();
    for (const [threadId, threadValue] of Object.entries(session.threads as Record<string, unknown>)) {
      if (!threadId || threadId.trim() !== threadId || normalizedThreadIds.has(threadId.trim())) return null;
      normalizedThreadIds.add(threadId.trim());
      if (!threadValue || typeof threadValue !== 'object' || Array.isArray(threadValue)) return null;
      const thread = threadValue as Record<string, unknown>;
      if (thread.thread_id !== threadId || (thread.kind !== 'leader' && thread.kind !== 'subagent')) return null;
      if (typeof thread.first_seen_at !== 'string' || !thread.first_seen_at.trim()) return null;
      if (typeof thread.last_seen_at !== 'string' || !thread.last_seen_at.trim()) return null;
      if (typeof thread.turn_count !== 'number' || !Number.isFinite(thread.turn_count) || thread.turn_count < 1) return null;
      const hasAuthorityEvidence = thread.provenance_kind === NATIVE_SUBAGENT_PROVENANCE
        || thread.direct_child_root_id !== undefined
        || thread.direct_child_parent_id !== undefined
        || thread.reopen_authority_revoked !== undefined
        || thread.reopen_authority_conflict_reason !== undefined
        || thread.reopen_authority_conflict_at !== undefined;
      if (hasAuthorityEvidence && thread.status !== undefined && normalizeSubagentStatus(thread.status) === undefined) return null;
      if (hasAuthorityEvidence && thread.provenance_kind !== undefined && thread.provenance_kind !== NATIVE_SUBAGENT_PROVENANCE) return null;
      for (const field of ['direct_child_root_id', 'direct_child_parent_id', 'reopen_authority_conflict_reason', 'reopen_authority_conflict_at'] as const) {
        if (thread[field] !== undefined && (typeof thread[field] !== 'string' || !(thread[field] as string).trim() || (thread[field] as string).trim() !== thread[field])) return null;
      }
      if (thread.reopen_authority_revoked !== undefined && typeof thread.reopen_authority_revoked !== 'boolean') return null;
      if ((thread.direct_child_root_id === undefined) !== (thread.direct_child_parent_id === undefined)) return null;
      if ((thread.reopen_authority_conflict_reason !== undefined || thread.reopen_authority_conflict_at !== undefined) && thread.reopen_authority_revoked !== true) return null;
    }
  }
  return normalizeSubagentTrackingState(parsed);
}

function readSubagentTrackingStateStrictSync(cwd: string): { ok: true; state: SubagentTrackingState } | { ok: false } {
  const path = subagentTrackingPath(cwd);
  if (!existsSync(path)) return { ok: true, state: createSubagentTrackingState() };
  try {
    const state = parseStrictSubagentTrackingState(readFileSync(path, 'utf-8'));
    return state ? { ok: true, state } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function atomicTrackingTempPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

export const DEFAULT_CROSS_PROCESS_LOCK_MAX_ATTEMPTS = 80;
export const DEFAULT_CROSS_PROCESS_LOCK_RETRY_MS = 2;
export const CROSS_PROCESS_LOCK_LEASE_MS = 60_000;

const crossProcessLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

type CrossProcessLockClaim = {
  token: string;
  pid: number;
  host: string;
  acquiredAtMs: number;
  pidStartId?: string;
};

type CrossProcessLockState =
  | { kind: 'missing' }
  | { kind: 'claim'; claim: CrossProcessLockClaim }
  | { kind: 'malformed' };

export type CrossProcessFileLockContext = {
  assertOwnership(): void;
  publish(contents: string): void;
};

export class CrossProcessLockLostError extends Error {
  constructor(lockPath: string) {
    super(`Lost cross-process lock ownership at ${lockPath}`);
    this.name = 'CrossProcessLockLostError';
  }
}

export function crossProcessLockPath(resourcePath: string): string {
  return `${resourcePath}.lock`;
}

function sleepForCrossProcessLockSync(durationMs: number): void {
  Atomics.wait(crossProcessLockWaitArray, 0, 0, durationMs);
}

export function readProcessStartIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closingParenthesis = stat.lastIndexOf(')');
    const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/);
    const starttime = fields[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    if (closingParenthesis < 0 || !starttime || !/^\d+$/.test(starttime) || !bootId) return undefined;
    return `${bootId}:${starttime}`;
  } catch {
    return undefined;
  }
}

function createCrossProcessLockClaim(token: string): CrossProcessLockClaim {
  const pidStartId = readProcessStartIdentity(process.pid);
  return {
    token,
    pid: process.pid,
    host: hostname(),
    acquiredAtMs: Date.now(),
    ...(pidStartId ? { pidStartId } : {}),
  };
}

function serializeCrossProcessLockClaim(claim: CrossProcessLockClaim): string {
  return `${JSON.stringify({
    token: claim.token,
    pid: claim.pid,
    host: claim.host,
    acquired_at: new Date(claim.acquiredAtMs).toISOString(),
    ...(claim.pidStartId ? { pid_start_id: claim.pidStartId } : {}),
  })}\n`;
}

function readCrossProcessLockState(lockPath: string): CrossProcessLockState {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      token?: unknown;
      pid?: unknown;
      host?: unknown;
      acquired_at?: unknown;
      pid_start_id?: unknown;
    };
    const token = typeof parsed.token === 'string' && parsed.token === parsed.token.trim() && parsed.token ? parsed.token : undefined;
    const pid = typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
    const host = typeof parsed.host === 'string' && parsed.host.trim() ? parsed.host : undefined;
    const acquiredAtMs = typeof parsed.acquired_at === 'string' ? Date.parse(parsed.acquired_at) : Number.NaN;
    const pidStartId = parsed.pid_start_id === undefined
      ? undefined
      : typeof parsed.pid_start_id === 'string' && parsed.pid_start_id.trim()
        ? parsed.pid_start_id
        : null;
    if (!token || !pid || !host || !Number.isFinite(acquiredAtMs) || pidStartId === null) return { kind: 'malformed' };
    return {
      kind: 'claim',
      claim: { token, pid, host, acquiredAtMs, ...(pidStartId ? { pidStartId } : {}) },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'malformed' };
  }
}

function isCrossProcessLockOwnerDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isCrossProcessLockOlderThanLease(acquiredAtMs: number, nowMs: number): boolean {
  return acquiredAtMs < nowMs - CROSS_PROCESS_LOCK_LEASE_MS;
}

function isCrossProcessLockReclaimable(claim: CrossProcessLockClaim): boolean {
  if (claim.host !== hostname()) return isCrossProcessLockOlderThanLease(claim.acquiredAtMs, Date.now());
  if (isCrossProcessLockOwnerDead(claim.pid)) return true;

  const currentPidStartId = readProcessStartIdentity(claim.pid);
  if (claim.pidStartId && currentPidStartId) return currentPidStartId !== claim.pidStartId;
  return isCrossProcessLockOlderThanLease(claim.acquiredAtMs, Date.now());
}

function removeCrossProcessLockFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function tryAcquireCrossProcessFileLock(lockPath: string, token: string): boolean {
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let acquired = false;
  try {
    writeFileSync(temporaryPath, serializeCrossProcessLockClaim(createCrossProcessLockClaim(token)));
    try {
      linkSync(temporaryPath, lockPath);
      acquired = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try {
      removeCrossProcessLockFile(temporaryPath);
    } catch (error) {
      if (!acquired) throw error;
    }
  }
}

function restoreQuarantinedCrossProcessLock(lockPath: string, quarantinedPath: string): void {
  try {
    linkSync(quarantinedPath, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST: a replacement claim already holds the lock; the displaced copy is redundant.
    // ENOENT: the displaced artifact was already removed (e.g. by a concurrent bounded
    // sweep) — a fenced clean terminal outcome, never a cleanup failure to throw on.
    if (code === 'EEXIST') {
      removeCrossProcessLockFile(quarantinedPath);
      return;
    }
    if (code === 'ENOENT') return;
    throw error;
  }
  removeCrossProcessLockFile(quarantinedPath);
}

function recoverCrossProcessFileLock(lockPath: string, observed: CrossProcessLockState): boolean {
  if (observed.kind === 'missing') return true;
  if (observed.kind === 'claim' && !isCrossProcessLockReclaimable(observed.claim)) return false;

  const quarantinedPath = `${lockPath}.${Date.now()}.${randomUUID()}.quarantine`;
  try {
    renameSync(lockPath, quarantinedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const barrier = crossProcessQuarantineBarrier;
  crossProcessQuarantineBarrier = null;
  barrier?.(lockPath, quarantinedPath);

  const captured = readCrossProcessLockState(quarantinedPath);
  const capturedExpectedClaim = observed.kind === 'claim'
    && captured.kind === 'claim'
    && captured.claim.token === observed.claim.token;
  const capturedRecoverable = captured.kind === 'malformed'
    || (capturedExpectedClaim && captured.kind === 'claim' && isCrossProcessLockReclaimable(captured.claim));
  if (!capturedRecoverable) {
    restoreQuarantinedCrossProcessLock(lockPath, quarantinedPath);
    return true;
  }

  removeCrossProcessLockFile(quarantinedPath);
  return true;
}

function assertCrossProcessFileLockOwnership(lockPath: string, token: string): void {
  const state = readCrossProcessLockState(lockPath);
  if (state.kind === 'claim' && state.claim.token === token) return;
  throw new CrossProcessLockLostError(lockPath);
}

function releaseCrossProcessFileLock(lockPath: string, token: string): void {
  const observed = readCrossProcessLockState(lockPath);
  if (observed.kind !== 'claim' || observed.claim.token !== token) return;

  const quarantinedPath = `${lockPath}.${Date.now()}.${randomUUID()}.release`;
  try {
    renameSync(lockPath, quarantinedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const barrier = crossProcessQuarantineBarrier;
  crossProcessQuarantineBarrier = null;
  barrier?.(lockPath, quarantinedPath);

  const captured = readCrossProcessLockState(quarantinedPath);
  if (captured.kind === 'claim' && captured.claim.token === token) {
    removeCrossProcessLockFile(quarantinedPath);
    return;
  }

  restoreQuarantinedCrossProcessLock(lockPath, quarantinedPath);
}

function crossProcessLockStagePath(resourcePath: string, token: string): string {
  return `${resourcePath}.stage.${token}`;
}

function createCrossProcessLockStage(stagePath: string): void {
  const descriptor = openSync(stagePath, 'wx');
  closeSync(descriptor);
}

function sweepForeignCrossProcessLockStages(resourcePath: string, token: string): void {
  const directory = dirname(resourcePath);
  const stagePrefix = `${basename(resourcePath)}.stage.`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(stagePrefix) || entry.slice(stagePrefix.length) === token) continue;
    removeCrossProcessLockFile(join(directory, entry));
  }
}

export const CROSS_PROCESS_LOCK_ARTIFACT_SWEEP_CAP = 64;

function sweepAbandonedCrossProcessLockArtifacts(resourcePath: string): void {
  const directory = dirname(resourcePath);
  const lockName = basename(crossProcessLockPath(resourcePath));
  const escapedLockName = lockName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const artifactPattern = new RegExp(`^${escapedLockName}\\.([^.]+)\\.[^.]+\\.(?:quarantine|release)$`);
  const nowMs = Date.now();
  const aged: Array<{ displacedAtMs: number; entry: string }> = [];
  for (const entry of readdirSync(directory)) {
    const match = artifactPattern.exec(entry);
    if (!match) continue;
    const displacedAtMs = Number(match[1]);
    // Only lease-aged, parseable-timestamp artifacts are eligible; fresh/live/malformed-ts
    // artifacts are always preserved (never delete a live successor's in-flight evidence).
    if (!Number.isFinite(displacedAtMs) || nowMs - displacedAtMs <= CROSS_PROCESS_LOCK_LEASE_MS) continue;
    aged.push({ displacedAtMs, entry });
  }
  // Bounded, deterministic cleanup: process oldest-first (tie-break by name) and remove at
  // most CROSS_PROCESS_LOCK_ARTIFACT_SWEEP_CAP per acquisition, so a large backlog drains
  // predictably across acquisitions instead of doing unbounded work in a single lock take.
  aged.sort((a, b) => a.displacedAtMs - b.displacedAtMs || (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  for (const { entry } of aged.slice(0, CROSS_PROCESS_LOCK_ARTIFACT_SWEEP_CAP)) {
    removeCrossProcessLockFile(join(directory, entry));
  }
}

let crossProcessPublishBarrier: (() => void) | null = null;
let crossProcessQuarantineBarrier: ((lockPath: string, quarantinedPath: string) => void) | null = null;

export function __setCrossProcessPublishBarrierForTest(barrier: (() => void) | null): void {
  crossProcessPublishBarrier = barrier;
}

export function __setCrossProcessQuarantineBarrierForTest(
  barrier: ((lockPath: string, quarantinedPath: string) => void) | null,
): void {
  crossProcessQuarantineBarrier = barrier;
}

export function withCrossProcessFileLockSync<T>(
  resourcePath: string,
  operation: (context: CrossProcessFileLockContext) => T,
  options: { maxAttempts?: number; retryMs?: number } = {},
): T {
  const lockPath = crossProcessLockPath(resourcePath);
  const maxAttempts =
    typeof options.maxAttempts === 'number' && Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.floor(options.maxAttempts))
      : DEFAULT_CROSS_PROCESS_LOCK_MAX_ATTEMPTS;
  const retryMs =
    typeof options.retryMs === 'number' && Number.isFinite(options.retryMs)
      ? Math.max(1, Math.floor(options.retryMs))
      : DEFAULT_CROSS_PROCESS_LOCK_RETRY_MS;

  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const stagePath = crossProcessLockStagePath(resourcePath, token);
  let acquired = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (tryAcquireCrossProcessFileLock(lockPath, token)) {
      acquired = true;
      break;
    }

    const recovered = recoverCrossProcessFileLock(lockPath, readCrossProcessLockState(lockPath));
    if (recovered && tryAcquireCrossProcessFileLock(lockPath, token)) {
      acquired = true;
      break;
    }
    if (attempt === maxAttempts - 1) {
      throw new Error(`Timed out waiting for cross-process lock at ${lockPath}`);
    }
    sleepForCrossProcessLockSync(Math.min(25, retryMs * 2 ** Math.min(attempt, 4)));
  }

  if (!acquired) {
    throw new Error(`Timed out waiting for cross-process lock at ${lockPath}`);
  }

  try {
    sweepForeignCrossProcessLockStages(resourcePath, token);
    sweepAbandonedCrossProcessLockArtifacts(resourcePath);
    createCrossProcessLockStage(stagePath);
    return operation({
      assertOwnership: () => assertCrossProcessFileLockOwnership(lockPath, token),
      publish: (contents: string) => {
        let descriptor: number;
        try {
          descriptor = openSync(stagePath, 'r+');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CrossProcessLockLostError(lockPath);
          throw error;
        }
        try {
          ftruncateSync(descriptor, 0);
          writeSync(descriptor, contents);
        } finally {
          closeSync(descriptor);
        }

        const barrier = crossProcessPublishBarrier;
        crossProcessPublishBarrier = null;
        barrier?.();
        try {
          renameSync(stagePath, resourcePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CrossProcessLockLostError(lockPath);
          throw error;
        }
        createCrossProcessLockStage(stagePath);
      },
    });
  } finally {
    removeCrossProcessLockFile(stagePath);
    releaseCrossProcessFileLock(lockPath, token);
  }
}


function threadIsTrackedAsSubagent(state: SubagentTrackingState, threadId: string): boolean {
  const id = threadId.trim();
  return Boolean(id) && Object.values(state.sessions).some((session) => isTrustedSubagentThread(session, id));
}

export function hasLeaderSubagentCollision(state: SubagentTrackingState, leaderThreadId: string): boolean {
  return threadIsTrackedAsSubagent(state, leaderThreadId);
}

// Strict reads preserve fail-closed behavior for security-sensitive tracker decisions.

export async function readSubagentTrackingStateStrict(cwd: string): Promise<{ ok: true; state: SubagentTrackingState } | { ok: false }> {
  const path = subagentTrackingPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, state: createSubagentTrackingState() };
    return { ok: false };
  }
  const state = parseStrictSubagentTrackingState(raw);
  return state ? { ok: true, state } : { ok: false };
}


function writeSubagentTrackingStateSync(
  cwd: string,
  state: SubagentTrackingState,
  publish?: (contents: string) => void,
): string {
  const normalized = normalizeSubagentTrackingState(state);
  const path = subagentTrackingPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  if (publish) {
    publish(contents);
    return path;
  }
  const temporaryPath = atomicTrackingTempPath(path);
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
  return path;
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
  const path = subagentTrackingPath(cwd);
  // Fail closed on both sides of the write: the proposed state must survive
  // strict authority validation (tolerant inputs must not launder malformed
  // authority into a valid-looking attestation), and existing on-disk bytes
  // must not be overwritten when they fail strict parsing. The whole
  // read/validate/publish transaction is serialized under the tracker lock.
  const proposedRaw = JSON.stringify(state);
  if (!parseStrictSubagentTrackingState(proposedRaw)) throw new Error('Malformed subagent tracker authority state');
  const normalized = normalizeSubagentTrackingState(state);
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  return withCrossProcessFileLockSync(path, (lock) => {
    if (existsSync(path)) {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        throw new Error('Malformed subagent tracker authority state');
      }
      if (!parseStrictSubagentTrackingState(raw)) throw new Error('Malformed subagent tracker authority state');
    }
    mkdirSync(dirname(path), { recursive: true });
    lock.assertOwnership();
    lock.publish(contents);
    return path;
  });
}


export function recordSubagentTurn(state: SubagentTrackingState, input: RecordSubagentTurnInput): SubagentTrackingState {
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
  const existingKind = existingThread?.kind === 'leader' || existingThread?.kind === 'subagent' ? existingThread.kind : undefined;
  const existingLeaderThreadId = existingSession.leader_thread_id?.trim();
  // `leader_thread_id` is the session's top-level leader boundary.  A native
  // subagent can itself be the immediate parent of a nested native role, but
  // that must not reclassify known subagent evidence as the session leader.
  const requestedLeaderThread = requestedLeaderThreadId ? existingSession.threads[requestedLeaderThreadId] : undefined;
  const requestedLeaderWouldReclassifySubagent = requestedLeaderThread?.kind === 'subagent';
  const requestedSessionLeaderThreadId = requestedLeaderWouldReclassifySubagent ? undefined : requestedLeaderThreadId;
  const preserveExistingSubagent = existingKind === 'subagent' && requestedKind !== 'subagent';
  const preserveKnownLeader = requestedKind === 'subagent' && (existingKind === 'leader' || existingLeaderThreadId === threadId);
  const leaderThreadId = preserveKnownLeader
    ? existingLeaderThreadId || threadId
    : existingLeaderThreadId || requestedSessionLeaderThreadId || (requestedKind === 'subagent' || preserveExistingSubagent ? undefined : threadId);
  const kind = preserveKnownLeader
    ? 'leader'
    : requestedKind === 'leader' && existingKind === 'subagent'
      ? 'subagent'
      : (requestedKind ?? (threadId === leaderThreadId ? 'leader' : (existingKind ?? 'subagent')));
  const requestedStatus = normalizeSubagentStatus(input.status);
  const preservedStatus = normalizeSubagentStatus(existingThread?.status);
  const preserveCompletionEvidence = input.preserveCompletionEvidence === true;
  const clearsPriorCompletion = input.completed !== true && preserveCompletionEvidence !== true && Boolean(existingThread?.completed_at);
  const status = requestedStatus ?? (input.completed ? 'closed' : undefined) ?? (clearsPriorCompletion ? undefined : preservedStatus);
  const preservedCompletion =
    preserveCompletionEvidence && existingThread?.completed_at
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
    ...(input.turnId?.trim()
      ? { last_turn_id: input.turnId.trim() }
      : existingThread?.last_turn_id
        ? { last_turn_id: existingThread.last_turn_id }
        : {}),
    ...(input.completed
      ? {
          completed_at: timestamp,
          ...(input.turnId?.trim() ? { last_completed_turn_id: input.turnId.trim() } : {}),
          ...(input.completionSource?.trim() ? { completion_source: input.completionSource.trim() } : {}),
        }
      : preservedCompletion),
    ...(input.mode?.trim() ? { mode: input.mode.trim() } : existingThread?.mode ? { mode: existingThread.mode } : {}),
    ...(input.role?.trim() ? { role: input.role.trim() } : existingThread?.role ? { role: existingThread.role } : {}),
    ...(input.provenanceKind === NATIVE_SUBAGENT_PROVENANCE
      ? { provenance_kind: NATIVE_SUBAGENT_PROVENANCE }
      : existingThread?.provenance_kind === NATIVE_SUBAGENT_PROVENANCE
        ? { provenance_kind: NATIVE_SUBAGENT_PROVENANCE }
        : existingThread?.provenance_kind === DESCRIPTIVE_ADAPTED_PROVENANCE
          ? { provenance_kind: DESCRIPTIVE_ADAPTED_PROVENANCE }
          : {}),
    ...(input.laneId?.trim() ? { lane_id: input.laneId.trim() } : existingThread?.lane_id ? { lane_id: existingThread.lane_id } : {}),
    ...(input.scope?.trim() ? { scope: input.scope.trim() } : existingThread?.scope ? { scope: existingThread.scope } : {}),
    ...(input.agentNickname?.trim()
      ? { agent_nickname: input.agentNickname.trim() }
      : existingThread?.agent_nickname
        ? { agent_nickname: existingThread.agent_nickname }
        : {}),
    ...(status ? { status } : {}),
    ...(input.lastHandoffSummary?.trim()
      ? { last_handoff_summary: input.lastHandoffSummary.trim() }
      : existingThread?.last_handoff_summary
        ? { last_handoff_summary: existingThread.last_handoff_summary }
        : {}),
    ...(input.resumeRequestedAt?.trim()
      ? { resume_requested_at: input.resumeRequestedAt.trim() }
      : existingThread?.resume_requested_at
        ? { resume_requested_at: existingThread.resume_requested_at }
        : {}),
    ...(input.resumeCompletedAt?.trim()
      ? { resume_completed_at: input.resumeCompletedAt.trim() }
      : existingThread?.resume_completed_at
        ? { resume_completed_at: existingThread.resume_completed_at }
        : {}),
    ...(input.resumeFailedAt?.trim()
      ? { resume_failed_at: input.resumeFailedAt.trim() }
      : existingThread?.resume_failed_at
        ? { resume_failed_at: existingThread.resume_failed_at }
        : {}),
    ...(input.resumeFailureReason?.trim()
      ? { resume_failure_reason: input.resumeFailureReason.trim() }
      : existingThread?.resume_failure_reason
        ? { resume_failure_reason: existingThread.resume_failure_reason }
        : {}),
    ...(existingThread?.direct_child_root_id ? { direct_child_root_id: existingThread.direct_child_root_id } : {}),
    ...(existingThread?.direct_child_parent_id ? { direct_child_parent_id: existingThread.direct_child_parent_id } : {}),
    ...(existingThread?.reopen_authority_revoked ? { reopen_authority_revoked: true } : {}),
    ...(existingThread?.reopen_authority_conflict_reason ? { reopen_authority_conflict_reason: existingThread.reopen_authority_conflict_reason } : {}),
    ...(existingThread?.reopen_authority_conflict_at ? { reopen_authority_conflict_at: existingThread.reopen_authority_conflict_at } : {}),
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
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const strict = readSubagentTrackingStateStrictSync(cwd);
    if (!strict.ok) throw new Error('Malformed subagent tracker authority state');
    const next = recordSubagentTurn(strict.state, input);
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, next, context.publish);
    return next;
  });
}
export function recordNativeSubagentAuthorityObservation(
  cwd: string,
  observation: NativeSubagentAuthorityObservation,
): SubagentTrackingState {
  const requestedSessionIds = [...new Set(observation.sessionIds.map((value) => value.trim()).filter(Boolean))];
  const childThreadId = observation.childThreadId.trim();
  const parentThreadId = observation.parentThreadId.trim();
  const rootNativeSessionId = observation.rootNativeSessionId?.trim() ?? '';
  const implicatedChildThreadIds = [...new Set([
    childThreadId,
    ...(observation.implicatedChildThreadIds ?? []).map((value) => value.trim()),
  ].filter(Boolean))];
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const strict = readSubagentTrackingStateStrictSync(cwd);
    if (!strict.ok) throw new Error('Malformed subagent tracker authority state');
    let next = strict.state;
    const existingSessionIds = Object.entries(next.sessions)
      .filter(([, session]) => implicatedChildThreadIds.some((id) => Boolean(session.threads[id]?.direct_child_root_id || session.threads[id]?.reopen_authority_revoked)))
      .map(([sessionId]) => sessionId);
    const sessionIds = [...new Set([...requestedSessionIds, ...existingSessionIds])];
    const existingBindings = Object.values(next.sessions)
      .map((session) => session.threads[childThreadId])
      .filter((thread): thread is TrackedSubagentThread => Boolean(thread?.direct_child_root_id));
    const authorityEvidence = observation.authorityEvidence ?? (rootNativeSessionId ? 'valid' : 'absent');
    const globalConflict = authorityEvidence === 'untrusted' && existingBindings.length > 0
      || authorityEvidence === 'valid' && existingBindings.some((thread) =>
        thread.direct_child_root_id !== rootNativeSessionId || thread.direct_child_parent_id !== parentThreadId,
      );
    const timestamp = observation.timestamp ?? new Date().toISOString();
    if (authorityEvidence === 'untrusted') {
      for (const session of Object.values(next.sessions)) {
        for (const implicatedId of implicatedChildThreadIds) {
          const implicatedThread = session.threads[implicatedId];
          if (!implicatedThread?.direct_child_root_id && !implicatedThread?.reopen_authority_revoked) continue;
          implicatedThread.reopen_authority_revoked = true;
          implicatedThread.reopen_authority_conflict_reason = 'identity_untrusted';
          implicatedThread.reopen_authority_conflict_at = timestamp;
        }
      }
    }
    for (const sessionId of sessionIds) {
      if (parentThreadId && parentThreadId !== childThreadId) {
        next = recordSubagentTurn(next, { sessionId, threadId: parentThreadId, kind: 'leader', timestamp });
      }
      next = recordSubagentTurn(next, {
        sessionId,
        threadId: childThreadId,
        kind: 'subagent',
        ...(parentThreadId && parentThreadId !== childThreadId ? { leaderThreadId: parentThreadId } : {}),
        mode: observation.mode,
        timestamp,
      });
      const thread = next.sessions[sessionId]?.threads[childThreadId];
      if (!thread) continue;
      const mayAttest = authorityEvidence === 'valid'
        && Boolean(rootNativeSessionId)
        && childThreadId !== rootNativeSessionId
        && parentThreadId === rootNativeSessionId;
      if (globalConflict) {
        thread.reopen_authority_revoked = true;
        thread.reopen_authority_conflict_reason = 'root_or_parent_mismatch';
        thread.reopen_authority_conflict_at = timestamp;
      } else if (mayAttest) {
        thread.direct_child_root_id = rootNativeSessionId;
        thread.direct_child_parent_id = parentThreadId;
        thread.provenance_kind = NATIVE_SUBAGENT_PROVENANCE;
        delete thread.reopen_authority_revoked;
        delete thread.reopen_authority_conflict_reason;
        delete thread.reopen_authority_conflict_at;
      }
    }
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, next, context.publish);
    return next;
  });
}

export function revokeNativeSubagentAuthorities(
  cwd: string,
  childThreadIds: string[],
  reason = 'identity_untrusted',
): SubagentTrackingState {
  const ids = [...new Set(childThreadIds.map((value) => value.trim()).filter(Boolean))];
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const strict = readSubagentTrackingStateStrictSync(cwd);
    if (!strict.ok) throw new Error('Malformed subagent tracker authority state');
    const next = strict.state;
    const timestamp = new Date().toISOString();
    let changed = false;
    for (const session of Object.values(next.sessions)) {
      for (const id of ids) {
        const thread = session.threads[id];
        if (!thread?.direct_child_root_id && !thread?.reopen_authority_revoked) continue;
        thread.reopen_authority_revoked = true;
        thread.reopen_authority_conflict_reason = reason;
        thread.reopen_authority_conflict_at = timestamp;
        changed = true;
      }
    }
    if (changed) {
      context.assertOwnership();
      writeSubagentTrackingStateSync(cwd, next, context.publish);
    }
    return next;
  });
}

export interface DirectChildReopenContext {
  sessionId: string;
  rootNativeSessionId: string;
  source: string;
}

function formatReopenMetadata(entry: SubagentLedgerEntry): string {
  const values = [
    entry.role ? `role: ${entry.role}` : null,
    entry.laneId ? `lane: ${entry.laneId}` : null,
    entry.scope ? `scope: ${entry.scope}` : null,
    `status: ${entry.status}`,
    entry.lastHandoffSummary ? `handoff: ${entry.lastHandoffSummary.slice(0, 120)}` : null,
    entry.resumeFailureReason ? `last failure: ${entry.resumeFailureReason.slice(0, 120)}` : null,
  ].filter((value): value is string => Boolean(value));
  return values.length ? ` (${values.join('; ')})` : '';
}

function persistedReopenAuthorityWarning(reason: string): string {
  return [
    '[Persisted subagent reopen]',
    `- Warning: persisted subagent authority was excluded (${reason}); no resume authority or bookkeeping was granted.`,
    '- Silver rule: do not spawn a same-role/same-lane replacement solely because persisted reopen authority was unavailable; continue in the root or another compatible existing lane.',
  ].join('\n');
}

function persistedReopenLegacyNotice(excludedCount: number, source: string): string {
  return [
    '[Persisted subagent reopen]',
    `- SessionStart source: ${source}; saved subagent ids found: 0.`,
    `- Notice: ${excludedCount} persisted subagent record(s) were excluded as non-authoritative or legacy; no resume authority or bookkeeping was granted.`,
    '- Silver rule: do not spawn a same-role/same-lane replacement solely because persisted reopen authority was unavailable; continue in the root or another compatible existing lane.',
  ].join('\n');
}

/**
 * Repair persisted root-as-subagent identity inversion inside an already-parsed
 * state. Only a thread whose id equals the exact native root id is conclusively
 * the root and is reclassified as leader. A thread whose id equals only the
 * canonical session key is always ambiguous — the storage key is not identity
 * proof — so it is never destructively reclassified: authority-bearing records
 * are revoked (fail closed) and every ambiguous record loses resume bookkeeping.
 * Returns true when any record changed.
 */
function repairPersistedRootIdentityInState(
  state: SubagentTrackingState,
  sessionId: string,
  rootNativeSessionId: string,
  repairTimestamp: string,
): boolean {
  let changed = false;
  for (const correlatedSession of Object.values(state.sessions)) {
    let sessionChanged = false;
    for (const rootId of new Set([sessionId, rootNativeSessionId])) {
      const rootThread = correlatedSession.threads[rootId];
      if (!rootThread || rootThread.kind !== 'subagent') continue;
      const ambiguousCanonicalCollision = rootId === sessionId && sessionId !== rootNativeSessionId;
      if (ambiguousCanonicalCollision) {
        const carriesAuthority =
          rootThread.provenance_kind === NATIVE_SUBAGENT_PROVENANCE
          || rootThread.direct_child_root_id !== undefined
          || rootThread.direct_child_parent_id !== undefined;
        if (carriesAuthority && rootThread.reopen_authority_revoked !== true) {
          // Fail closed without rewriting identity: the id collides with the
          // canonical root key but carries child-shaped authority evidence, so
          // it stays a subagent whose reopen authority is revoked until root
          // identity is independently established.
          rootThread.reopen_authority_revoked = true;
          rootThread.reopen_authority_conflict_reason = 'canonical_root_collision';
          rootThread.reopen_authority_conflict_at = repairTimestamp;
          sessionChanged = true;
        }
        if (rootThread.resume_requested_at !== undefined
          || rootThread.resume_completed_at !== undefined
          || rootThread.resume_failed_at !== undefined
          || rootThread.resume_failure_reason !== undefined) {
          delete rootThread.resume_requested_at;
          delete rootThread.resume_completed_at;
          delete rootThread.resume_failed_at;
          delete rootThread.resume_failure_reason;
          sessionChanged = true;
        }
        continue;
      }
      if (rootId !== rootNativeSessionId) continue;
      rootThread.kind = 'leader';
      delete rootThread.direct_child_root_id;
      delete rootThread.direct_child_parent_id;
      delete rootThread.reopen_authority_revoked;
      delete rootThread.reopen_authority_conflict_reason;
      delete rootThread.reopen_authority_conflict_at;
      delete rootThread.resume_requested_at;
      delete rootThread.resume_completed_at;
      delete rootThread.resume_failed_at;
      delete rootThread.resume_failure_reason;
      sessionChanged = true;
    }
    if (correlatedSession.threads[rootNativeSessionId] && correlatedSession.leader_thread_id !== rootNativeSessionId) {
      correlatedSession.leader_thread_id = rootNativeSessionId;
      sessionChanged = true;
    }
    if (sessionChanged) {
      correlatedSession.updated_at = repairTimestamp;
      changed = true;
    }
  }
  return changed;
}

/**
 * Pointer-authoritative root identity repair, decoupled from reopen candidate
 * output. Runs under the tracker lock and fails closed on malformed bytes.
 */
export function repairPersistedRootIdentity(
  cwd: string,
  context: { sessionId: string; rootNativeSessionId: string },
): boolean {
  const sessionId = context.sessionId.trim();
  const rootNativeSessionId = context.rootNativeSessionId.trim();
  if (!sessionId || !rootNativeSessionId) return false;
  const path = subagentTrackingPath(cwd);
  return withCrossProcessFileLockSync(path, (lock) => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return false;
    }
    const state = parseStrictSubagentTrackingState(raw);
    if (!state) return false;
    const changed = repairPersistedRootIdentityInState(state, sessionId, rootNativeSessionId, new Date().toISOString());
    if (changed) {
      lock.assertOwnership();
      writeSubagentTrackingStateSync(cwd, state, lock.publish);
    }
    return changed;
  });
}

/** Strict, lock-serialized authority consumption for SessionStart persisted reopen output. */
export function consumeDirectChildReopenContext(
  cwd: string,
  context: DirectChildReopenContext,
): string | null {
  const sessionId = context.sessionId.trim();
  const rootNativeSessionId = context.rootNativeSessionId.trim();
  if (!sessionId || !rootNativeSessionId) return null;
  const path = subagentTrackingPath(cwd);
  return withCrossProcessFileLockSync(path, (lock) => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return persistedReopenAuthorityWarning('tracker_read_failed');
    }
    const state = parseStrictSubagentTrackingState(raw);
    if (!state) return persistedReopenAuthorityWarning('malformed_tracker_state');
    const repairTimestamp = new Date().toISOString();
    // Root identity repair runs before candidate eligibility so a missing
    // canonical partition cannot leave a known root inversion unrepaired.
    const changed = repairPersistedRootIdentityInState(state, sessionId, rootNativeSessionId, repairTimestamp);
    const session = state.sessions[sessionId];
    if (!session) {
      if (changed) {
        lock.assertOwnership();
        writeSubagentTrackingStateSync(cwd, state, lock.publish);
      }
      return null;
    }
    const savedSubagents = Object.values(session.threads)
      .filter((thread) => {
        if (thread.kind !== 'subagent'
          || thread.thread_id === sessionId
          || thread.thread_id === rootNativeSessionId
          || session.leader_thread_id === thread.thread_id
          || thread.provenance_kind !== NATIVE_SUBAGENT_PROVENANCE
          || thread.direct_child_root_id !== rootNativeSessionId
          || thread.direct_child_parent_id !== rootNativeSessionId
          || thread.reopen_authority_revoked === true) return false;
        return Object.values(state.sessions).every((correlationSession) => {
          const view = correlationSession.threads[thread.thread_id];
          if (!view) return true;
          // Recognized legacy adapted records are descriptive-only: they never
          // grant authority and never block a newly attested valid child. The
          // tolerance is shape-constrained: an adapted view may only waive
          // missing attestation for a non-leader subagent view and never waives
          // leader-kind or leader_thread_id contradictions.
          if (view.provenance_kind === DESCRIPTIVE_ADAPTED_PROVENANCE
            && view.kind === 'subagent'
            && correlationSession.leader_thread_id !== thread.thread_id) return true;
          return correlationSession.leader_thread_id !== thread.thread_id
            && view.kind === 'subagent'
            && view.provenance_kind === NATIVE_SUBAGENT_PROVENANCE
            && view.direct_child_root_id === rootNativeSessionId
            && view.direct_child_parent_id === rootNativeSessionId
            && view.reopen_authority_revoked !== true;
        });
      })
      .map((thread) => normalizeLedgerEntry(thread, thread.status ?? 'closed'))
      .sort(compareResumeEntries);
    if (!savedSubagents.length) {
      if (changed) {
        session.updated_at = new Date().toISOString();
        lock.assertOwnership();
        writeSubagentTrackingStateSync(cwd, state, lock.publish);
      }
      // Surface intentional exclusion of legacy/non-authoritative records instead
      // of silently returning no context. The notice fires only when every
      // relevant view across every correlation partition is genuinely
      // descriptive/legacy: any authority-bearing, leader-kind, or
      // leader_thread_id-colliding view keeps the denial fail-closed null.
      const excludedIds = new Set(
        Object.values(session.threads)
          .filter((thread) => thread.kind === 'subagent')
          .map((thread) => thread.thread_id),
      );
      const everyRelevantViewIsLegacy = excludedIds.size > 0
        && Object.values(state.sessions).every((correlationSession) => {
          if (correlationSession.leader_thread_id && excludedIds.has(correlationSession.leader_thread_id)) return false;
          return [...excludedIds].every((threadId) => {
            const view = correlationSession.threads[threadId];
            if (!view) return true;
            return view.kind === 'subagent'
              && view.provenance_kind !== NATIVE_SUBAGENT_PROVENANCE
              && view.direct_child_root_id === undefined
              && view.direct_child_parent_id === undefined
              && view.reopen_authority_revoked !== true;
          });
        });
      if (everyRelevantViewIsLegacy) {
        return persistedReopenLegacyNotice(excludedIds.size, context.source);
      }
      return null;
    }
    const reopenTargets = savedSubagents.filter((entry) => entry.status !== 'unavailable');
    const unavailableTargets = savedSubagents.filter((entry) => entry.status === 'unavailable');
    const failedTargets = savedSubagents.filter((entry) => entry.resumeFailedAt || entry.resumeFailureReason);
    const now = new Date().toISOString();
    for (const target of reopenTargets) {
      session.threads[target.threadId] = { ...session.threads[target.threadId]!, resume_requested_at: now };
    }
    if (reopenTargets.length || changed) {
      session.updated_at = now;
      lock.assertOwnership();
      writeSubagentTrackingStateSync(cwd, state, lock.publish);
    }
    const lines = [
      '[Persisted subagent reopen]',
      `- SessionStart source: ${context.source}; saved subagent ids found: ${savedSubagents.length}.`,
    ];
    if (reopenTargets.length) {
      lines.push('- Reopen these persisted subagents by id before continuing work or spawning any same-role/same-lane replacement:');
      lines.push(...reopenTargets.slice(0, 12).map((entry) => `  - resume_agent(${JSON.stringify(entry.agentId)})${formatReopenMetadata(entry)}`));
      if (reopenTargets.length > 12) lines.push(`  - ... ${reopenTargets.length - 12} more saved subagent id(s) omitted from this compact SessionStart context; consult .omx/state/subagent-tracking.json before spawning replacements.`);
    } else {
      lines.push('- No compatible saved subagent id is currently marked reopenable; do not spawn a replacement merely because reopen was unavailable.');
    }
    lines.push('- Silver rule: when follow-up work targets an existing role/lane, reuse the matching reopened id; avoid duplicate same-type subagent spawns.');
    lines.push('- If resume_agent fails, surface a clear warning with the id and reason, then continue in the root or another compatible existing lane; do not spawn a new agent solely because reopen failed.');
    const warnings = [...new Map([...unavailableTargets, ...failedTargets].map((entry) => [entry.agentId, entry])).values()];
    if (warnings.length) {
      lines.push('- Reopen warnings:');
      lines.push(...warnings.slice(0, 8).map((entry) => `  - ${entry.agentId}${formatReopenMetadata(entry)}`));
      if (warnings.length > 8) lines.push(`  - ... ${warnings.length - 8} more warning(s) omitted from this compact SessionStart context.`);
    }
    return lines.join('\n');
  });
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
  const nowMs = typeof options.now === 'string' ? Date.parse(options.now) : options.now instanceof Date ? options.now.getTime() : Date.now();

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
