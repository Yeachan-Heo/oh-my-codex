import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AGENT_DEFINITIONS } from '../agents/definitions.js';
import { getBaseStateDir, getBaseStateDirWithSource } from '../state/paths.js';
import { canonicalizeOriginCwd } from '../leader/contract.js';

import { codexAgentsDir, projectCodexAgentsDir } from '../utils/paths.js';

export const SUBAGENT_TRACKING_SCHEMA_VERSION = 1;
export const DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS = 120_000;
export const OMX_ADAPTED_PROVENANCE = 'omx_adapted';
export const NATIVE_SUBAGENT_PROVENANCE = 'native_subagent';

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
  pending_role_intents: PendingRoleIntent[];
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

export interface PendingRoleIntent {
  role: string;
  session_id: string;
  parent_thread_id: string;
  correlation_token: string;
  created_at: string;
  expires_at: string;
  binding_state?: 'bound';
  binding_claimant_token?: string;
  bound_at?: string;

  origin_cwd?: string;
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
    pending_role_intents: [],
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

function normalizePendingRoleIntent(value: unknown): PendingRoleIntent | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingRoleIntent>;
  const role = readOptionalTrimmedString(candidate.role);
  const sessionId = readOptionalTrimmedString(candidate.session_id);
  const parentThreadId = readOptionalTrimmedString(candidate.parent_thread_id);
  const createdAt = readOptionalTrimmedString(candidate.created_at);
  const expiresAt = readOptionalTrimmedString(candidate.expires_at);
  if (!role || !sessionId || !parentThreadId || !Object.hasOwn(candidate, 'correlation_token') || !createdAt || !expiresAt) return null;
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(expiresAt))) return null;

  const bindingState = candidate.binding_state === 'bound' ? 'bound' : undefined;
  const boundAt = readOptionalTrimmedString(candidate.bound_at);
  const hasValidBoundAt = Boolean(boundAt && Number.isFinite(Date.parse(boundAt)));
  const originCwd = readOptionalTrimmedString(candidate.origin_cwd);
  return {
    role,
    session_id: sessionId,
    parent_thread_id: parentThreadId,
    // Bound journals are durable security records. Retain malformed credentials verbatim so
    // completion can reject them rather than silently converting them into claimant-less data.
    correlation_token: candidate.correlation_token as string,
    created_at: createdAt,
    expires_at: expiresAt,
    ...(bindingState ? { binding_state: bindingState } : {}),
    ...(bindingState && Object.hasOwn(candidate, 'binding_claimant_token')
      ? { binding_claimant_token: candidate.binding_claimant_token }
      : {}),
    ...(bindingState && hasValidBoundAt ? { bound_at: boundAt } : {}),
    ...(originCwd ? { origin_cwd: originCwd } : {}),
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
        ...(typeof candidate.provenance_kind === 'string' && candidate.provenance_kind.trim().length > 0
          ? { provenance_kind: candidate.provenance_kind.trim() }
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
      leader_thread_id: leaderThreadId,
      updated_at: updatedAt,
      threads,
    };
  }

  const pendingRoleIntents = Array.isArray(parsed.pending_role_intents)
    ? parsed.pending_role_intents.map((intent) => normalizePendingRoleIntent(intent)).filter((intent): intent is PendingRoleIntent => intent !== null)
    : [];

  return {
    schemaVersion: SUBAGENT_TRACKING_SCHEMA_VERSION,
    sessions,
    pending_role_intents: pendingRoleIntents,
  };
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

function readSubagentTrackingStateSync(cwd: string): SubagentTrackingState {
  const path = subagentTrackingPath(cwd);
  if (!existsSync(path)) return createSubagentTrackingState();
  try {
    return normalizeSubagentTrackingState(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return createSubagentTrackingState();
  }
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
  try {
    return { ok: true, state: normalizeSubagentTrackingState(JSON.parse(raw)) };
  } catch {
    return { ok: false };
  }
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
  const normalized = normalizeSubagentTrackingState(state);
  const path = subagentTrackingPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = atomicTrackingTempPath(path);
  await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`);
  await rename(temporaryPath, path);
  return path;
}

function normalizeNowMs(nowMs: number | undefined): number {
  return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
}

function isExpiredPendingRoleIntent(intent: PendingRoleIntent, nowMs: number): boolean {
  if (intent.binding_state === 'bound') return false;
  const expiresAtMs = Date.parse(intent.expires_at);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function pendingRoleIntentPredicates(cwd: string, canonicalOrigin: string | null, nowMs: number) {
  const isCwdPartitionedStateRoot = getBaseStateDirWithSource(cwd).rootSource === 'cwd-default';
  const isOwn = (intent: PendingRoleIntent) => (
    intent.origin_cwd
      ? canonicalizeOriginCwd(intent.origin_cwd) === canonicalOrigin
      : isCwdPartitionedStateRoot
  );
  const shouldPruneExpired = (intent: PendingRoleIntent) => (
    isOwn(intent)
    && intent.binding_state !== 'bound'
    && isExpiredPendingRoleIntent(intent, nowMs)
  );
  return { isOwn, shouldPruneExpired };
}

export function isRoleIntentOwnedByCwd(cwd: string, intent: PendingRoleIntent): boolean {
  return pendingRoleIntentPredicates(cwd, canonicalizeOriginCwd(cwd), Date.now()).isOwn(intent);
}

function sameLogicalRoleIntent(
  intent: PendingRoleIntent,
  sessionId: string,
  parentThreadId: string,
  correlationToken?: string,
): boolean {
  return (
    intent.session_id === sessionId
    && intent.parent_thread_id === parentThreadId
    && (correlationToken === undefined || intent.correlation_token === correlationToken)
  );
}

export function isCanonicalCorrelationToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

export function isCanonicalClaimantToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function hasOwnBoundLogicalIntent(
  all: PendingRoleIntent[],
  isOwn: (intent: PendingRoleIntent) => boolean,
  sessionId: string,
  parentThreadId: string,
  correlationToken?: string,
): boolean {
  return all.some((intent) => (
    isOwn(intent)
    && intent.binding_state === 'bound'
    && sameLogicalRoleIntent(intent, sessionId, parentThreadId, correlationToken)
  ));
}

function selectDominantRoleIntent(
  candidates: PendingRoleIntent[],
  canonicalOrigin: string,
): PendingRoleIntent | null {
  return [...candidates].sort((left, right) => {
    const leftIsBound = left.binding_state === 'bound';
    const rightIsBound = right.binding_state === 'bound';
    if (leftIsBound !== rightIsBound) return leftIsBound ? -1 : 1;

    const leftIsExactOrigin = left.origin_cwd !== undefined
      && canonicalizeOriginCwd(left.origin_cwd) === canonicalOrigin;
    const rightIsExactOrigin = right.origin_cwd !== undefined
      && canonicalizeOriginCwd(right.origin_cwd) === canonicalOrigin;
    if (leftIsExactOrigin !== rightIsExactOrigin) return leftIsExactOrigin ? -1 : 1;

    const leftStableKey = [
      left.role,
      left.correlation_token,
      left.created_at,
      left.expires_at,
      left.binding_state ?? '',
      left.binding_claimant_token ?? '',
      left.bound_at ?? '',
      left.origin_cwd ?? '',
    ].join('\u0000');
    const rightStableKey = [
      right.role,
      right.correlation_token,
      right.created_at,
      right.expires_at,
      right.binding_state ?? '',
      right.binding_claimant_token ?? '',
      right.bound_at ?? '',
      right.origin_cwd ?? '',
    ].join('\u0000');
    return leftStableKey.localeCompare(rightStableKey);
  })[0] ?? null;
}

export function recordPendingRoleIntent(
  cwd: string,
  input: {
    role: string;
    sessionId: string;
    parentThreadId: string;
    correlationToken: string;
    ttlMs?: number;
    nowMs?: number;
  },
): { ok: true; intent: PendingRoleIntent } | { ok: false; reason: 'unknown_role' | 'invalid_correlation_token' | 'invalid_origin' | 'single_flight_conflict' } {
  const role = resolveInstalledRoleName(input.role);
  if (!role) return { ok: false, reason: 'unknown_role' };
  const correlationToken = input.correlationToken;
  if (!isCanonicalCorrelationToken(correlationToken)) {
    return { ok: false, reason: 'invalid_correlation_token' };
  }

  const nowMs = normalizeNowMs(input.nowMs);
  const sessionId = input.sessionId.trim();
  const parentThreadId = input.parentThreadId.trim();
  const canonicalOrigin = canonicalizeOriginCwd(cwd);
  if (canonicalOrigin === null) return { ok: false, reason: 'invalid_origin' };
  const { isOwn, shouldPruneExpired } = pendingRoleIntentPredicates(cwd, canonicalOrigin, nowMs);
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const state = readSubagentTrackingStateSync(cwd);
    const all = state.pending_role_intents;
    if (all.some((intent) => (
      isOwn(intent)
      && intent.session_id === sessionId
      && intent.parent_thread_id === parentThreadId
      && (intent.binding_state === 'bound' || !isExpiredPendingRoleIntent(intent, nowMs))
    ))) {
      return { ok: false, reason: 'single_flight_conflict' };
    }

    const ttlMs = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) ? input.ttlMs : 10 * 60_000;
    const intent: PendingRoleIntent = {
      role,
      session_id: sessionId,
      parent_thread_id: parentThreadId,
      correlation_token: correlationToken,
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      // Store the canonical origin workspace so it authenticates future bind/complete/recover.
      ...(canonicalOrigin ? { origin_cwd: canonicalOrigin } : {}),
    };
    state.pending_role_intents = [...all.filter((candidate) => !shouldPruneExpired(candidate)), intent];
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, state, context.publish);
    return { ok: true, intent };
  });
}


export function bindPendingRoleIntentUnderLock(
  cwd: string,
  input: { sessionId: string; parentThreadId: string; correlationToken?: string; nowMs?: number },
  bind: (state: SubagentTrackingState, intent: { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE }) => SubagentTrackingState,
): { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE; claimantToken: string | undefined; alreadyBound: boolean } | null {
  const nowMs = normalizeNowMs(input.nowMs);
  const sessionId = input.sessionId.trim();
  const parentThreadId = input.parentThreadId.trim();
  const correlationToken = input.correlationToken;
  if (!isCanonicalCorrelationToken(correlationToken)) return null;
  // Fail-closed origin authentication: establish the caller's canonical origin workspace up
  // front. A malformed/unavailable origin can never disclose role/claimant, run the bind
  // callback, mutate pending->bound, or acquire the lock.
  const canonicalOrigin = canonicalizeOriginCwd(cwd);
  if (canonicalOrigin === null) return null;
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const state = readSubagentTrackingStateSync(cwd);
    const all = state.pending_role_intents;
    const { isOwn, shouldPruneExpired } = pendingRoleIntentPredicates(cwd, canonicalOrigin, nowMs);
    const matchedIntent = selectDominantRoleIntent(
      all.filter((intent) => (
        isOwn(intent)
        && correlationToken !== undefined
        && sameLogicalRoleIntent(intent, sessionId, parentThreadId, correlationToken)
        && (intent.binding_state === 'bound' || !isExpiredPendingRoleIntent(intent, nowMs))
      )),
      canonicalOrigin,
    );

    if (!matchedIntent) {
      const retained = all.filter((intent) => !shouldPruneExpired(intent));
      if (retained.length !== all.length) {
        state.pending_role_intents = retained;
        context.assertOwnership();
        writeSubagentTrackingStateSync(cwd, state, context.publish);
      }
      return null;
    }

    const adaptedIntent = {
      role: matchedIntent.role,
      provenanceKind: OMX_ADAPTED_PROVENANCE,
    } as const;
    if (matchedIntent.binding_state === 'bound') {
      const next = all
        .filter((intent) => (
          intent.binding_state === 'bound'
          || !(isOwn(intent) && sameLogicalRoleIntent(intent, sessionId, parentThreadId, correlationToken))
        ))
        .map((intent) => (
          intent === matchedIntent && !intent.origin_cwd
            ? { ...intent, origin_cwd: canonicalOrigin }
            : intent
        ));
      if (next.length !== all.length || !matchedIntent.origin_cwd) {
        state.pending_role_intents = next;
        context.assertOwnership();
        writeSubagentTrackingStateSync(cwd, state, context.publish);
      }
      return {
        ...adaptedIntent,
        claimantToken: undefined,
        alreadyBound: true,
      };
    }

    const claimantToken = randomUUID();
    const boundState = bind(state, adaptedIntent);
    boundState.pending_role_intents = all
      .filter((intent) => !shouldPruneExpired(intent))
      .filter((intent) => (
        intent === matchedIntent
        || !(isOwn(intent) && sameLogicalRoleIntent(intent, sessionId, parentThreadId, correlationToken))
      ))
      .map((intent) => (
        intent === matchedIntent
          ? {
            ...matchedIntent,
            binding_state: 'bound',
            binding_claimant_token: claimantToken,
            bound_at: new Date(nowMs).toISOString(),
            origin_cwd: matchedIntent.origin_cwd ?? canonicalOrigin,
          }
          : intent
      ));
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, boundState, context.publish);
    return { ...adaptedIntent, claimantToken, alreadyBound: false };
  });
}

export function consumePendingRoleIntent(
  cwd: string,
  input: { sessionId: string; parentThreadId: string; correlationToken?: string; nowMs?: number },
): { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE } | null {
  const nowMs = normalizeNowMs(input.nowMs);
  const sessionId = input.sessionId.trim();
  const parentThreadId = input.parentThreadId.trim();
  const correlationToken = input.correlationToken;
  if (!isCanonicalCorrelationToken(correlationToken)) return null;
  const canonicalOrigin = canonicalizeOriginCwd(cwd);
  if (canonicalOrigin === null) return null;
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const state = readSubagentTrackingStateSync(cwd);
    const all = state.pending_role_intents;
    const { isOwn, shouldPruneExpired } = pendingRoleIntentPredicates(cwd, canonicalOrigin, nowMs);
    if (hasOwnBoundLogicalIntent(all, isOwn, sessionId, parentThreadId, correlationToken)) return null;

    const consumed = selectDominantRoleIntent(
      all.filter((intent) => (
        isOwn(intent)
        && intent.binding_state !== 'bound'
        && !isExpiredPendingRoleIntent(intent, nowMs)
        && correlationToken !== undefined
        && sameLogicalRoleIntent(intent, sessionId, parentThreadId, correlationToken)
      )),
      canonicalOrigin,
    );

    if (!consumed) {
      const retained = all.filter((intent) => !shouldPruneExpired(intent));
      if (retained.length !== all.length) {
        state.pending_role_intents = retained;
        context.assertOwnership();
        writeSubagentTrackingStateSync(cwd, state, context.publish);
      }
      return null;
    }

    state.pending_role_intents = all
      .filter((intent) => !shouldPruneExpired(intent))
      .filter((intent) => (
        intent.binding_state === 'bound'
        || !(isOwn(intent) && sameLogicalRoleIntent(intent, sessionId, parentThreadId, correlationToken))
      ));
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, state, context.publish);
    return { role: consumed.role, provenanceKind: OMX_ADAPTED_PROVENANCE };
  });
}

export function completeAdaptedRoleBinding(
  cwd: string,
  input: { sessionId: string; parentThreadId: string; correlationToken?: string; claimantToken?: string; nowMs?: number },
): 'completed' | 'not_found' | 'claimant_mismatch' {
  const nowMs = normalizeNowMs(input.nowMs);
  const sessionId = input.sessionId.trim();
  const parentThreadId = input.parentThreadId.trim();
  const correlationToken = input.correlationToken;
  const claimantToken = input.claimantToken;
  const canonicalOrigin = canonicalizeOriginCwd(cwd);
  if (canonicalOrigin === null) return 'not_found';
  return withCrossProcessFileLockSync(subagentTrackingPath(cwd), (context) => {
    const state = readSubagentTrackingStateSync(cwd);
    const all = state.pending_role_intents;
    const { isOwn, shouldPruneExpired } = pendingRoleIntentPredicates(cwd, canonicalOrigin, nowMs);
    // Select the owned bound scope before authenticating it. Credentials are not a lookup key:
    // otherwise an invalid dominant duplicate could be bypassed by a lower valid duplicate.
    const boundIntent = selectDominantRoleIntent(
      all.filter((intent) => (
        isOwn(intent)
        && intent.binding_state === 'bound'
        && sameLogicalRoleIntent(intent, sessionId, parentThreadId)
      )),
      canonicalOrigin,
    );
    if (!boundIntent) {
      const retained = all.filter((intent) => !shouldPruneExpired(intent));
      if (retained.length !== all.length) {
        state.pending_role_intents = retained;
        context.assertOwnership();
        writeSubagentTrackingStateSync(cwd, state, context.publish);
      }
      return 'not_found';
    }
    const hasClaimant = Object.hasOwn(boundIntent, 'binding_claimant_token');
    if (
      !isCanonicalCorrelationToken(boundIntent.correlation_token)
      || !isCanonicalCorrelationToken(correlationToken)
      || boundIntent.correlation_token !== correlationToken
      || (hasClaimant && (
        !isCanonicalClaimantToken(boundIntent.binding_claimant_token)
        || !isCanonicalClaimantToken(claimantToken)
        || boundIntent.binding_claimant_token !== claimantToken
      ))
    ) return 'claimant_mismatch';

    state.pending_role_intents = all
      .filter((intent) => !shouldPruneExpired(intent))
      .filter((intent) => !(isOwn(intent) && sameLogicalRoleIntent(intent, sessionId, parentThreadId, boundIntent.correlation_token as string)));
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, state, context.publish);
    return 'completed';
  });
}

export function listBoundAdaptedRoleIntents(cwd: string, _nowMs?: number, ownedDominant = false): PendingRoleIntent[] {
  const allBound = readSubagentTrackingStateSync(cwd).pending_role_intents.filter((intent) => intent.binding_state === 'bound');
  if (!ownedDominant) return allBound;
  const canonicalOrigin = canonicalizeOriginCwd(cwd);
  if (canonicalOrigin === null) return [];
  const { isOwn } = pendingRoleIntentPredicates(cwd, canonicalOrigin, Date.now());
  const scopes = new Map<string, PendingRoleIntent[]>();
  for (const intent of allBound) {
    if (!isOwn(intent)) continue;
    const key = `${intent.session_id}\u0000${intent.parent_thread_id}`;
    scopes.set(key, [...(scopes.get(key) ?? []), intent]);
  }
  return [...scopes.values()].flatMap((candidates) => {
    const dominant = selectDominantRoleIntent(candidates, canonicalOrigin);
    return dominant ? [dominant] : [];
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
    ...(input.provenanceKind?.trim()
      ? { provenance_kind: input.provenanceKind.trim() }
      : existingThread?.provenance_kind
        ? { provenance_kind: existingThread.provenance_kind }
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
    const current = readSubagentTrackingStateSync(cwd);
    const next = recordSubagentTurn(current, input);
    context.assertOwnership();
    writeSubagentTrackingStateSync(cwd, next, context.publish);
    return next;
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
