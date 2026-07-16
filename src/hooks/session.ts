/**
 * Session lifecycle management.
 *
 * The selected state root owns one canonical session pointer. Pointer writes are
 * serialized by an adjacent lock directory and become visible only after an
 * atomic rename of a transaction-owned temporary file.
 */
import {
  appendFile,
  mkdir as nodeMkdir,
  open,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  rmdir as nodeRmdir,
  rm,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'fs/promises';
import { readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { omxRoot, omxLogsDir, sameFilePath } from '../utils/paths.js';
import {
  getBaseStateDirWithSource,
  resolveWorkingDirectoryForState,
  type StateRootSource,
} from '../mcp/state-paths.js';
import type { PromptDiagnosticDescriptor } from './prompt-session-provenance.js';

export interface SessionState {
  session_id: string;
  native_session_id?: string;
  previous_native_session_id?: string;
  native_session_switched_at?: string;
  owner_omx_session_id?: string;
  owner_codex_session_id?: string;
  codex_session_id?: string;
  started_at: string;
  cwd: string;
  pid: number;
  platform?: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline?: string;
  tmux_session_name?: string;
  tmux_pane_id?: string;
}

export interface SessionPointerContext {
  cwd: string;
  baseStateDir: string;
  rootSource: StateRootSource;
  sessionPath: string;
  lockPath: string;
}

export type SessionPointerStatus =
  | 'absent'
  | 'usable'
  | 'stale-dead'
  | 'identity-indeterminate'
  | 'malformed'
  | 'foreign-cwd';

export interface SessionPointerReadResult {
  status: SessionPointerStatus;
  state?: SessionState;
  raw?: string;
}

export type SessionPointerTransactionOperation =
  | 'pointer-context-resolve'
  | 'state-dir-create'
  | 'lock-acquire'
  | 'lock-owner-publish'
  | 'pointer-read'
  | 'pointer-classify'
  | 'pointer-temp-write'
  | 'pointer-fsync'
  | 'pointer-rename'
  | 'owner-conflict'
  | 'precommit-cleanup'
  | 'lock-release';

type AttemptedStateRootSource = StateRootSource | 'unresolved';
type UnusableSessionPointerStatus = 'malformed' | 'foreign-cwd' | 'identity-indeterminate';

export type SessionPointerCleanupPhase =
  | 'remove-owner-temp'
  | 'inspect-unpublished-lock'
  | 'remove-unpublished-lock'
  | 'remove-pointer-temp'
  | 'token-check'
  | 'rename'
  | 'remove-release-dir';

export interface SessionPointerSecondaryFailure {
  operation: 'precommit-cleanup' | 'lock-release';
  phase: SessionPointerCleanupPhase;
  ownership: 'held' | 'released' | 'uncertain';
  message: string;
  cause?: unknown;
  evidencePath?: string;
}

export interface SessionPointerAbortBase extends Error {
  name: 'SessionPointerLaunchAbort';
  committed: false;
  cwd: string;
  candidateSessionId?: string;
  canonicalSessionId?: string;
  reason: string;
  cause?: unknown;
}

export interface SessionPointerContextAbort extends SessionPointerAbortBase {
  code: 'session_pointer_context_failure';
  operation: 'pointer-context-resolve';
  attemptedRootSource: AttemptedStateRootSource;
  pointerPath?: never;
  lockPath?: never;
  rootSource?: never;
}

export interface ResolvedSessionPointerAbort extends SessionPointerAbortBase {
  code:
    | 'session_pointer_lock_timeout'
    | 'session_pointer_lock_recovery_required'
    | 'session_pointer_unusable'
    | 'session_pointer_owner_conflict'
    | 'session_pointer_io_failure';
  operation: Exclude<SessionPointerTransactionOperation, 'pointer-context-resolve'>;
  pointerPath: string;
  lockPath?: string;
  rootSource: StateRootSource;
  pointerStatus?: UnusableSessionPointerStatus;
  lockOwnerStatus?: 'live' | 'dead' | 'reused' | 'identity-indeterminate' | 'missing' | 'malformed';
  primaryOperation?: Exclude<
    SessionPointerTransactionOperation,
    'pointer-context-resolve' | 'precommit-cleanup' | 'lock-release'
  >;
  secondaryFailures?: readonly SessionPointerSecondaryFailure[];
}

export type SessionPointerLaunchAbort =
  | SessionPointerContextAbort
  | ResolvedSessionPointerAbort;

const SESSION_FILE = 'session.json';
const HISTORY_FILE = 'session-history.jsonl';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_POINTER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_RETRY_DELAYS_MS = [25, 50, 100] as const;
const DEFAULT_POINTER_TIMEOUT_MS = 5_000;
const NATIVE_POINTER_TIMEOUT_MS = 2_000;

/**
 * Convert arbitrary input into a valid session ID without exposing validator
 * exceptions to lifecycle or hook inputs.
 */
export function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Resolve the one exact pointer path used by an operation. */
export function resolveSessionPointerContext(cwd: string): SessionPointerContext {
  const normalizedCwd = resolveWorkingDirectoryForState(cwd);
  const { baseStateDir, rootSource } = getBaseStateDirWithSource(normalizedCwd);
  const pointerPath = join(baseStateDir, SESSION_FILE);
  return {
    cwd: normalizedCwd,
    baseStateDir,
    rootSource,
    sessionPath: pointerPath,
    lockPath: `${pointerPath}.lock`,
  };
}

function attemptedStateRootSource(): AttemptedStateRootSource {
  try {
    if (process.env.OMX_TEAM_STATE_ROOT?.trim()) return 'team-env';
    if (process.env.OMX_ROOT?.trim()) return 'omx-root-env';
    if (process.env.OMX_STATE_ROOT?.trim()) return 'omx-state-root-env';
    return 'cwd-default';
  } catch {
    return 'unresolved';
  }
}

function contextAbort(cwd: string, candidateSessionId: string | undefined, cause: unknown): SessionPointerContextAbort {
  return new SessionPointerLaunchAbortError({
    code: 'session_pointer_context_failure',
    operation: 'pointer-context-resolve',
    cwd,
    ...(candidateSessionId ? { candidateSessionId } : {}),
    attemptedRootSource: attemptedStateRootSource(),
    reason: `Unable to resolve the selected session pointer root: ${errorMessage(cause)}`,
    cause,
  }) as SessionPointerContextAbort;
}

function resolvedAbort(
  context: SessionPointerContext,
  input: Omit<ResolvedSessionPointerAbort, 'name' | 'committed' | 'cwd' | 'pointerPath' | 'rootSource' | 'message'>,
): ResolvedSessionPointerAbort {
  return new SessionPointerLaunchAbortError({
    ...input,
    cwd: context.cwd,
    pointerPath: context.sessionPath,
    rootSource: context.rootSource,
  }) as ResolvedSessionPointerAbort;
}

class SessionPointerLaunchAbortError extends Error {
  readonly name = 'SessionPointerLaunchAbort' as const;
  readonly committed = false as const;

  constructor(fields: Record<string, unknown> & { reason: string; cause?: unknown }) {
    super(fields.reason);
    Object.assign(this, fields);
  }
}

export function isSessionPointerLaunchAbort(error: unknown): error is SessionPointerLaunchAbort {
  if (!(error instanceof Error) || error.name !== 'SessionPointerLaunchAbort') return false;
  const candidate = error as Partial<SessionPointerLaunchAbort>;
  if (candidate.committed !== false || typeof candidate.cwd !== 'string' || typeof candidate.operation !== 'string') {
    return false;
  }
  return candidate.code === 'session_pointer_context_failure'
    || candidate.code === 'session_pointer_lock_timeout'
    || candidate.code === 'session_pointer_lock_recovery_required'
    || candidate.code === 'session_pointer_unusable'
    || candidate.code === 'session_pointer_owner_conflict'
    || candidate.code === 'session_pointer_io_failure';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function hashCmdline(cmdline: string | null | undefined): string | undefined {
  const normalized = normalizeCmdline(cmdline);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : undefined;
}

interface LinuxProcessIdentity {
  startTicks: number;
  cmdline: string | null;
}

export interface SessionStaleCheckOptions {
  platform?: NodeJS.Platform;
  isPidAlive?: (pid: number) => boolean;
  readLinuxIdentity?: (pid: number) => LinuxProcessIdentity | null;
}

export interface SessionStartOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  nativeSessionId?: string;
  previousNativeSessionId?: string;
  nativeSessionSwitchedAt?: string;
  /**
   * Compatibility-only metadata. Alias candidacy always comes from
   * process.env.OMX_SESSION_ID, never from this option.
   */
  ownerOmxSessionId?: string;
  /** The caller proved the env candidate with actual tmux pane/session tags. */
  ownerAliasVerified?: boolean;
  tmuxSessionName?: string;
  tmuxPaneId?: string;
  context?: SessionPointerContext;
}

/** @internal Test-only deterministic transaction seam; do not use outside session tests. */
export type PidProbeResult = 'alive' | 'dead' | 'indeterminate';

/** @internal Test-only deterministic transaction seam; do not use outside session tests. */
export interface SessionPointerFsDependencies {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number; flag?: string }): Promise<void>;
  openAndSync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

/** @internal Test-only deterministic transaction seam; do not use outside session tests. */
export interface SessionPointerTransactionDependencies {
  fs: SessionPointerFsDependencies;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  token(): string;
  probePid(pid: number): PidProbeResult;
  readProcessIdentity(pid: number, platform: NodeJS.Platform): {
    status: 'matching' | 'reused' | 'indeterminate';
    startTicks?: number;
    cmdlineHash?: string;
  };
}

const defaultFsDependencies: SessionPointerFsDependencies = {
  mkdir: async (path, options) => {
    await nodeMkdir(path, options);
  },
  readdir: async (path) => await nodeReaddir(path),
  readFile: async (path, encoding) => await nodeReadFile(path, encoding),
  writeFile: async (path, data, options) => {
    await nodeWriteFile(path, data, options);
  },
  openAndSync: async (path) => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: async (from, to) => {
    await nodeRename(from, to);
  },
  unlink: async (path) => {
    await nodeUnlink(path);
  },
  rmdir: async (path) => {
    await nodeRmdir(path);
  },
};

/** @internal Exposed only so source-module tests can verify default ESRCH handling. */
export function __createDefaultPidProbeForTests(
  killZero: (pid: number) => void,
): (pid: number) => PidProbeResult {
  return (pid: number): PidProbeResult => {
    try {
      killZero(pid);
      return 'alive';
    } catch (error) {
      return errorCode(error) === 'ESRCH' ? 'dead' : 'indeterminate';
    }
  };
}

function defaultProbePid(pid: number): PidProbeResult {
  return __createDefaultPidProbeForTests((targetPid) => {
    process.kill(targetPid, 0);
  })(pid);
}

function defaultReadProcessIdentity(pid: number, platform: NodeJS.Platform): {
  status: 'matching' | 'reused' | 'indeterminate';
  startTicks?: number;
  cmdlineHash?: string;
} {
  if (platform !== 'linux') return { status: 'indeterminate' };
  const identity = readLinuxProcessIdentity(pid);
  if (!identity) return { status: 'indeterminate' };
  const cmdlineHash = hashCmdline(identity.cmdline);
  return {
    status: 'matching',
    startTicks: identity.startTicks,
    ...(cmdlineHash ? { cmdlineHash } : {}),
  };
}

const defaultTransactionDependencies: SessionPointerTransactionDependencies = {
  fs: defaultFsDependencies,
  nowMs: () => Date.now(),
  sleep: async (ms) => await new Promise<void>((resolve) => setTimeout(resolve, ms)),
  token: () => randomUUID(),
  probePid: defaultProbePid,
  readProcessIdentity: defaultReadProcessIdentity,
};

let transactionDependencies: SessionPointerTransactionDependencies = defaultTransactionDependencies;

/** @internal Source-module test harness. Always reset after a test. */
export function __setSessionPointerTransactionDependenciesForTests(
  overrides: Omit<Partial<SessionPointerTransactionDependencies>, 'fs'> & {
    fs?: Partial<SessionPointerFsDependencies>;
  },
): void {
  transactionDependencies = {
    ...defaultTransactionDependencies,
    ...overrides,
    fs: {
      ...defaultFsDependencies,
      ...overrides.fs,
    },
  };
}

/** @internal Source-module test harness. */
export function __resetSessionPointerTransactionDependenciesForTests(): void {
  transactionDependencies = defaultTransactionDependencies;
}

function parseLinuxProcStartTicks(statContent: string): number | null {
  const commandEnd = statContent.lastIndexOf(')');
  if (commandEnd === -1) return null;
  const fields = statContent.slice(commandEnd + 1).trim().split(/\s+/);
  if (fields.length <= 19) return null;
  const startTicks = Number(fields[19]);
  return Number.isInteger(startTicks) && startTicks >= 0 ? startTicks : null;
}

function normalizeCmdline(cmdline: string | null | undefined): string | null {
  if (!cmdline) return null;
  const normalized = cmdline.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  try {
    const startTicks = parseLinuxProcStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf-8'));
    if (startTicks == null) return null;
    let cmdline: string | null = null;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\u0000+/g, ' ').trim();
    } catch {
      // The start tick is still useful when cmdline access is unavailable.
    }
    return { startTicks, cmdline: normalizeCmdline(cmdline) };
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Legacy boolean stale check retained for read compatibility. The pointer
 * classifier below keeps indeterminate liveness distinct from definitely dead.
 */
export function isSessionStale(
  state: SessionState,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!Number.isInteger(state.pid) || state.pid <= 0) return true;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!isPidAlive(state.pid)) return true;

  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return false;

  const liveIdentity = (options.readLinuxIdentity ?? readLinuxProcessIdentity)(state.pid);
  if (!liveIdentity || typeof state.pid_start_ticks !== 'number') return true;
  if (state.pid_start_ticks !== liveIdentity.startTicks) return true;

  const expectedCmdline = normalizeCmdline(state.pid_cmdline);
  if (!expectedCmdline) return false;
  const liveCmdline = normalizeCmdline(liveIdentity.cmdline);
  return !liveCmdline || liveCmdline !== expectedCmdline;
}

export function isSessionStateAuthoritativeForCwd(state: SessionState, cwd: string): boolean {
  if (!normalizeSessionId(state.session_id)) return false;
  if (typeof state.cwd !== 'string' || !state.cwd.trim()) return false;
  try {
    return sameFilePath(state.cwd, cwd);
  } catch {
    return false;
  }
}

export function isSessionStateUsable(
  state: SessionState,
  cwd: string,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!normalizeSessionId(state.session_id)) return false;
  if (typeof state.cwd === 'string' && state.cwd.trim() && !isSessionStateAuthoritativeForCwd(state, cwd)) return false;
  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  const hasLinuxIdentityMetadata = typeof state.pid_start_ticks === 'number'
    || typeof state.pid_cmdline === 'string';
  return !hasPidMetadata && !hasLinuxIdentityMetadata || !isSessionStale(state, options);
}

function isValidStartTicks(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function classifySessionProcess(
  state: SessionState,
  dependencies: SessionPointerTransactionDependencies,
): 'usable' | 'stale-dead' | 'identity-indeterminate' {
  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  const hasIdentityMetadata = typeof state.pid_start_ticks === 'number' || typeof state.pid_cmdline === 'string';
  if (!hasPidMetadata && !hasIdentityMetadata) return 'usable';
  if (!hasPidMetadata) return 'identity-indeterminate';

  let pidStatus: PidProbeResult;
  try {
    pidStatus = dependencies.probePid(state.pid);
  } catch {
    return 'identity-indeterminate';
  }
  if (pidStatus === 'dead') return 'stale-dead';
  if (pidStatus !== 'alive') return 'identity-indeterminate';

  const platform = state.platform ?? process.platform;
  if (platform !== 'linux') return 'usable';
  if (!isValidStartTicks(state.pid_start_ticks)) return 'identity-indeterminate';

  let liveIdentity: ReturnType<SessionPointerTransactionDependencies['readProcessIdentity']>;
  try {
    liveIdentity = dependencies.readProcessIdentity(state.pid, platform);
  } catch {
    return 'identity-indeterminate';
  }
  if (!liveIdentity || !isValidStartTicks(liveIdentity.startTicks)) return 'identity-indeterminate';
  if (liveIdentity.startTicks !== state.pid_start_ticks) return 'stale-dead';
  if (liveIdentity.status !== 'matching') return 'identity-indeterminate';

  const expectedCmdlineHash = hashCmdline(state.pid_cmdline);
  if (expectedCmdlineHash && liveIdentity.cmdlineHash !== expectedCmdlineHash) {
    return 'identity-indeterminate';
  }
  return 'usable';
}

function classifyParsedSessionPointer(
  context: SessionPointerContext,
  value: unknown,
  raw: string,
): SessionPointerReadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'malformed', raw };
  }
  const state = value as SessionState;
  if (!normalizeSessionId(state.session_id)) return { status: 'malformed', raw };
  if (typeof state.cwd === 'string' && state.cwd.trim() && !isSessionStateAuthoritativeForCwd(state, context.cwd)) {
    return { status: 'foreign-cwd', raw, state };
  }

  const processStatus = classifySessionProcess(state, transactionDependencies);
  return { status: processStatus, state, raw };
}

/** Read and classify only context.sessionPath; no alternate root is consulted. */
export async function readSessionPointer(context: SessionPointerContext): Promise<SessionPointerReadResult> {
  let raw: string;
  try {
    raw = await transactionDependencies.fs.readFile(context.sessionPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { status: 'absent' };
    throw error;
  }

  try {
    return classifyParsedSessionPointer(context, JSON.parse(raw), raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'malformed', raw };
    throw error;
  }
}

export async function readSessionStateFromContext(context: SessionPointerContext): Promise<SessionState | null> {
  try {
    const raw = await transactionDependencies.fs.readFile(context.sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SessionState : null;
  } catch {
    return null;
  }
}

export async function readUsableSessionStateFromContext(context: SessionPointerContext): Promise<SessionState | null> {
  const state = await readSessionStateFromContext(context);
  return state && isSessionStateUsable(state, context.cwd) ? state : null;
}

/** Read current session state from the exact selected root. */
export async function readSessionState(cwd: string): Promise<SessionState | null> {
  try {
    return await readSessionStateFromContext(resolveSessionPointerContext(cwd));
  } catch {
    return null;
  }
}

export async function readUsableSessionState(
  cwd: string,
  options: SessionStaleCheckOptions = {},
): Promise<SessionState | null> {
  try {
    const context = resolveSessionPointerContext(cwd);
    const state = await readSessionStateFromContext(context);
    return state && isSessionStateUsable(state, context.cwd, options) ? state : null;
  } catch {
    return null;
  }
}

function createSessionState(
  cwd: string,
  sessionId: string,
  pid: number,
  platform: NodeJS.Platform,
  linuxIdentity: LinuxProcessIdentity | null,
  options: {
    nowIso?: string;
    nativeSessionId?: string;
    previousNativeSessionId?: string;
    nativeSessionSwitchedAt?: string;
    ownerOmxSessionId?: string;
    startedAt?: string;
    tmuxSessionName?: string;
    tmuxPaneId?: string;
  } = {},
): SessionState {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nativeSessionId = normalizeNonempty(options.nativeSessionId);
  const previousNativeSessionId = normalizeNonempty(options.previousNativeSessionId);
  const nativeSessionSwitchedAt = normalizeNonempty(options.nativeSessionSwitchedAt);
  const ownerOmxSessionId = normalizeSessionId(options.ownerOmxSessionId);
  const tmuxSessionName = normalizeNonempty(options.tmuxSessionName);
  const tmuxPaneId = normalizeNonempty(options.tmuxPaneId);
  return {
    session_id: sessionId,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    ...(previousNativeSessionId ? { previous_native_session_id: previousNativeSessionId } : {}),
    ...(nativeSessionSwitchedAt ? { native_session_switched_at: nativeSessionSwitchedAt } : {}),
    ...(ownerOmxSessionId ? { owner_omx_session_id: ownerOmxSessionId } : {}),
    started_at: options.startedAt ?? nowIso,
    cwd,
    pid,
    platform,
    ...(linuxIdentity ? { pid_start_ticks: linuxIdentity.startTicks } : {}),
    ...(linuxIdentity?.cmdline ? { pid_cmdline: linuxIdentity.cmdline } : {}),
    ...(tmuxSessionName ? { tmux_session_name: tmuxSessionName } : {}),
    ...(tmuxPaneId ? { tmux_pane_id: tmuxPaneId } : {}),
  };
}

function normalizeNonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolvePid(options: SessionStartOptions): number {
  return Number.isInteger(options.pid) && options.pid && options.pid > 0 ? options.pid : process.pid;
}

function sessionIdentityFor(pid: number, platform: NodeJS.Platform): LinuxProcessIdentity | null {
  return platform === 'linux' ? readLinuxProcessIdentity(pid) : null;
}

function currentOwnerAlias(state: SessionState): string | undefined {
  return normalizeSessionId(state.owner_omx_session_id);
}

function verifiedOwnerCandidate(
  context: SessionPointerContext,
  options: SessionStartOptions,
): string | undefined {
  if (context.rootSource === 'team-env' || options.ownerAliasVerified !== true) return undefined;
  return normalizeSessionId(process.env.OMX_SESSION_ID);
}

function mergeOwnerAlias(
  existing: SessionState | undefined,
  candidate: string | undefined,
  verified: boolean,
): string | undefined {
  const current = existing && currentOwnerAlias(existing);
  if (current) {
    if (candidate && candidate !== current) {
      throw new Error(`Session pointer is already bound to owner ${current}`);
    }
    return current;
  }
  if (!candidate || !verified || candidate === existing?.session_id) return undefined;
  return candidate;
}

function isStartCompatible(existing: SessionState, requestedSessionId: string): boolean {
  return existing.session_id === requestedSessionId
    || existing.native_session_id === requestedSessionId
    || currentOwnerAlias(existing) === requestedSessionId;
}

function getOmxLaunchSessionId(state: SessionState): string | undefined {
  if (state.session_id.startsWith('omx-')) return state.session_id;
  const owner = currentOwnerAlias(state);
  return owner?.startsWith('omx-') ? owner : undefined;
}

interface SessionPointerLockOwnerV1 {
  version: 1;
  token: string;
  pid: number;
  platform: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline_hash?: string;
  created_at: string;
}

type LockOwnerStatus = 'live' | 'dead' | 'reused' | 'identity-indeterminate' | 'missing' | 'malformed';

function parseLockOwner(raw: string): SessionPointerLockOwnerV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<SessionPointerLockOwnerV1>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.version !== 1 || !isValidToken(value.token) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    if (typeof value.platform !== 'string' || !value.platform || typeof value.created_at !== 'string' || !value.created_at) {
      return null;
    }
    if (value.pid_start_ticks !== undefined && !isValidStartTicks(value.pid_start_ticks)) return null;
    if (value.pid_cmdline_hash !== undefined
      && (typeof value.pid_cmdline_hash !== 'string' || !SHA256_PATTERN.test(value.pid_cmdline_hash))) {
      return null;
    }
    return value as SessionPointerLockOwnerV1;
  } catch {
    return null;
  }
}

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_POINTER_TOKEN_PATTERN.test(value);
}

async function inspectLockOwner(lockPath: string): Promise<{
  status: LockOwnerStatus;
  owner?: SessionPointerLockOwnerV1;
}> {
  let raw: string;
  try {
    raw = await transactionDependencies.fs.readFile(join(lockPath, 'owner.json'), 'utf8');
  } catch (error) {
    return isNotFound(error) ? { status: 'missing' } : { status: 'identity-indeterminate' };
  }

  const owner = parseLockOwner(raw);
  if (!owner) return { status: 'malformed' };

  let pidStatus: PidProbeResult;
  try {
    pidStatus = transactionDependencies.probePid(owner.pid);
  } catch {
    return { status: 'identity-indeterminate', owner };
  }
  if (pidStatus === 'dead') return { status: 'dead', owner };
  if (pidStatus !== 'alive') return { status: 'identity-indeterminate', owner };

  // Without Linux immutable start metadata, a live PID cannot be proved to be
  // the same process. Preserve the lock instead of guessing.
  if (owner.platform !== 'linux' || !isValidStartTicks(owner.pid_start_ticks)) {
    return { status: 'identity-indeterminate', owner };
  }

  let liveIdentity: ReturnType<SessionPointerTransactionDependencies['readProcessIdentity']>;
  try {
    liveIdentity = transactionDependencies.readProcessIdentity(owner.pid, owner.platform);
  } catch {
    return { status: 'identity-indeterminate', owner };
  }
  if (!liveIdentity || !isValidStartTicks(liveIdentity.startTicks)) {
    return { status: 'identity-indeterminate', owner };
  }
  if (liveIdentity.startTicks !== owner.pid_start_ticks) return { status: 'reused', owner };
  if (liveIdentity.status !== 'matching') return { status: 'identity-indeterminate', owner };
  if (owner.pid_cmdline_hash && owner.pid_cmdline_hash !== liveIdentity.cmdlineHash) {
    return { status: 'identity-indeterminate', owner };
  }
  return { status: 'live', owner };
}

interface HeldPointerLock {
  context: SessionPointerContext;
  token: string;
}

function buildLockOwner(token: string): SessionPointerLockOwnerV1 {
  let identity: ReturnType<SessionPointerTransactionDependencies['readProcessIdentity']> | undefined;
  try {
    identity = transactionDependencies.readProcessIdentity(process.pid, process.platform);
  } catch {
    // Publication remains valid with optional identity metadata omitted.
  }
  return {
    version: 1,
    token,
    pid: process.pid,
    platform: process.platform,
    ...(identity?.status === 'matching' && isValidStartTicks(identity.startTicks)
      ? { pid_start_ticks: identity.startTicks }
      : {}),
    ...(identity?.status === 'matching' && identity.cmdlineHash && SHA256_PATTERN.test(identity.cmdlineHash)
      ? { pid_cmdline_hash: identity.cmdlineHash }
      : {}),
    created_at: new Date(transactionDependencies.nowMs()).toISOString(),
  };
}

async function removeOwnedPath(path: string): Promise<SessionPointerSecondaryFailure | undefined> {
  try {
    await transactionDependencies.fs.unlink(path);
    return undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    try {
      await transactionDependencies.fs.readFile(path, 'utf8');
    } catch (readError) {
      if (isNotFound(readError)) return undefined;
    }
    return {
      operation: 'precommit-cleanup',
      phase: 'remove-pointer-temp',
      ownership: 'held',
      message: `Unable to remove transaction-owned pointer temporary file: ${errorMessage(error)}`,
      cause: error,
      evidencePath: path,
    };
  }
}

async function rollbackUnpublishedLock(
  context: SessionPointerContext,
  ownerTempPath?: string,
): Promise<SessionPointerSecondaryFailure[]> {
  const failures: SessionPointerSecondaryFailure[] = [];
  if (ownerTempPath) {
    try {
      await transactionDependencies.fs.unlink(ownerTempPath);
    } catch (error) {
      if (!isNotFound(error)) {
        failures.push({
          operation: 'precommit-cleanup',
          phase: 'remove-owner-temp',
          ownership: 'held',
          message: `Unable to remove transaction-owned lock owner temporary file: ${errorMessage(error)}`,
          cause: error,
          evidencePath: ownerTempPath,
        });
      }
    }
  }

  let entries: string[];
  try {
    entries = await transactionDependencies.fs.readdir(context.lockPath);
  } catch (error) {
    failures.push({
      operation: 'precommit-cleanup',
      phase: 'inspect-unpublished-lock',
      ownership: 'uncertain',
      message: `Unable to inspect unpublished session pointer lock: ${errorMessage(error)}`,
      cause: error,
      evidencePath: context.lockPath,
    });
    return failures;
  }

  if (entries.length > 0) {
    failures.push({
      operation: 'precommit-cleanup',
      phase: 'inspect-unpublished-lock',
      ownership: 'uncertain',
      message: 'Unpublished session pointer lock contains unexpected evidence.',
      evidencePath: context.lockPath,
    });
    return failures;
  }

  try {
    await transactionDependencies.fs.rmdir(context.lockPath);
  } catch (error) {
    failures.push({
      operation: 'precommit-cleanup',
      phase: 'remove-unpublished-lock',
      ownership: 'held',
      message: `Unable to remove empty unpublished session pointer lock: ${errorMessage(error)}`,
      cause: error,
      evidencePath: context.lockPath,
    });
  }
  return failures;
}

async function acquirePointerLock(
  context: SessionPointerContext,
  candidateSessionId: string | undefined,
  timeoutMs: number,
): Promise<HeldPointerLock> {
  const deadline = transactionDependencies.nowMs() + timeoutMs;
  let attempt = 0;

  while (true) {
    try {
      await transactionDependencies.fs.mkdir(context.lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw resolvedAbort(context, {
          code: 'session_pointer_io_failure',
          operation: 'lock-acquire',
          ...(candidateSessionId ? { candidateSessionId } : {}),
          lockPath: context.lockPath,
          reason: `Unable to acquire session pointer lock: ${errorMessage(error)}`,
          cause: error,
        });
      }

      const owner = await inspectLockOwner(context.lockPath);
      if (owner.status !== 'live') {
        throw resolvedAbort(context, {
          code: 'session_pointer_lock_recovery_required',
          operation: 'lock-acquire',
          ...(candidateSessionId ? { candidateSessionId } : {}),
          lockPath: context.lockPath,
          lockOwnerStatus: owner.status,
          reason: `Session pointer lock requires explicit recovery (${owner.status}).`,
        });
      }

      const remaining = deadline - transactionDependencies.nowMs();
      if (remaining <= 0) {
        throw resolvedAbort(context, {
          code: 'session_pointer_lock_timeout',
          operation: 'lock-acquire',
          ...(candidateSessionId ? { candidateSessionId } : {}),
          lockPath: context.lockPath,
          lockOwnerStatus: 'live',
          reason: 'Timed out waiting for the live session pointer lock owner.',
        });
      }
      const delay = Math.min(LOCK_RETRY_DELAYS_MS[Math.min(attempt, LOCK_RETRY_DELAYS_MS.length - 1)], remaining);
      attempt += 1;
      try {
        await transactionDependencies.sleep(delay);
      } catch (sleepError) {
        throw resolvedAbort(context, {
          code: 'session_pointer_io_failure',
          operation: 'lock-acquire',
          ...(candidateSessionId ? { candidateSessionId } : {}),
          lockPath: context.lockPath,
          reason: `Unable to wait for session pointer lock: ${errorMessage(sleepError)}`,
          cause: sleepError,
        });
      }
    }
  }

  let token: string;
  try {
    token = transactionDependencies.token();
  } catch (error) {
    const primary = resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'lock-owner-publish',
      ...(candidateSessionId ? { candidateSessionId } : {}),
      lockPath: context.lockPath,
      reason: `Unable to create session pointer lock token: ${errorMessage(error)}`,
      cause: error,
    });
    const failures = await rollbackUnpublishedLock(context);
    if (failures.length === 0) throw primary;
    throw recoveryAbort(context, primary, failures, 'precommit-cleanup');
  }

  if (!isValidToken(token)) {
    const cause = new Error('Session pointer transaction token is invalid.');
    const primary = resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'lock-owner-publish',
      ...(candidateSessionId ? { candidateSessionId } : {}),
      lockPath: context.lockPath,
      reason: cause.message,
      cause,
    });
    const failures = await rollbackUnpublishedLock(context);
    if (failures.length === 0) throw primary;
    throw recoveryAbort(context, primary, failures, 'precommit-cleanup');
  }

  const ownerTempPath = join(context.lockPath, `owner.${token}.tmp`);
  const ownerPath = join(context.lockPath, 'owner.json');
  try {
    await transactionDependencies.fs.writeFile(ownerTempPath, JSON.stringify(buildLockOwner(token)), { mode: 0o600 });
    await transactionDependencies.fs.openAndSync(ownerTempPath);
    await transactionDependencies.fs.rename(ownerTempPath, ownerPath);
  } catch (error) {
    const primary = resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'lock-owner-publish',
      ...(candidateSessionId ? { candidateSessionId } : {}),
      lockPath: context.lockPath,
      reason: `Unable to publish session pointer lock owner: ${errorMessage(error)}`,
      cause: error,
    });
    const failures = await rollbackUnpublishedLock(context, ownerTempPath);
    if (failures.length === 0) throw primary;
    throw recoveryAbort(context, primary, failures, 'precommit-cleanup');
  }

  return { context, token };
}

async function releasePointerLock(lock: HeldPointerLock): Promise<SessionPointerSecondaryFailure[]> {
  const ownerPath = join(lock.context.lockPath, 'owner.json');
  let owner: SessionPointerLockOwnerV1 | null = null;
  try {
    owner = parseLockOwner(await transactionDependencies.fs.readFile(ownerPath, 'utf8'));
  } catch {
    // The error is represented as a token-check uncertainty below.
  }

  if (!owner || owner.token !== lock.token) {
    return [{
      operation: 'lock-release',
      phase: 'token-check',
      ownership: 'uncertain',
      message: 'Unable to prove ownership of the canonical session pointer lock.',
      evidencePath: lock.context.lockPath,
    }];
  }

  const releasePath = `${lock.context.lockPath}.release-${lock.token}`;
  try {
    await transactionDependencies.fs.rename(lock.context.lockPath, releasePath);
  } catch (error) {
    return [{
      operation: 'lock-release',
      phase: 'rename',
      ownership: 'held',
      message: `Unable to release the canonical session pointer lock: ${errorMessage(error)}`,
      cause: error,
      evidencePath: lock.context.lockPath,
    }];
  }
  try {
    await transactionDependencies.fs.unlink(join(releasePath, 'owner.json'));
  } catch (error) {
    if (!isNotFound(error)) {
      return [{
        operation: 'lock-release',
        phase: 'remove-release-dir',
        ownership: 'released',
        message: `Unable to remove released session pointer lock owner: ${errorMessage(error)}`,
        cause: error,
        evidencePath: releasePath,
      }];
    }
  }

  try {
    await transactionDependencies.fs.rmdir(releasePath);
    return [];
  } catch (error) {
    return [{
      operation: 'lock-release',
      phase: 'remove-release-dir',
      ownership: 'released',
      message: `Unable to remove released session pointer lock evidence: ${errorMessage(error)}`,
      cause: error,
      evidencePath: releasePath,
    }];
  }
}

function recoveryAbort(
  context: SessionPointerContext,
  primary: ResolvedSessionPointerAbort,
  failures: readonly SessionPointerSecondaryFailure[],
  operation: 'precommit-cleanup' | 'lock-release',
): ResolvedSessionPointerAbort {
  return resolvedAbort(context, {
    code: 'session_pointer_lock_recovery_required',
    operation,
    ...(primary.candidateSessionId ? { candidateSessionId: primary.candidateSessionId } : {}),
    ...(primary.canonicalSessionId ? { canonicalSessionId: primary.canonicalSessionId } : {}),
    lockPath: context.lockPath,
    ...(primary.pointerStatus ? { pointerStatus: primary.pointerStatus } : {}),
    reason: `Session pointer cleanup requires explicit recovery after ${primary.operation}.`,
    cause: primary.cause,
    primaryOperation: primary.operation as ResolvedSessionPointerAbort['primaryOperation'],
    secondaryFailures: failures,
  });
}

function releaseFailureError(failures: readonly SessionPointerSecondaryFailure[]): Error {
  const error = new Error('Session pointer committed, but lock release left recovery evidence.');
  Object.assign(error, { secondaryFailures: failures });
  return error;
}

async function finalizePrecommitAbort(
  lock: HeldPointerLock,
  primary: ResolvedSessionPointerAbort,
  pointerTempPath?: string,
): Promise<ResolvedSessionPointerAbort> {
  const failures: SessionPointerSecondaryFailure[] = [];
  if (pointerTempPath) {
    const pointerTempFailure = await removeOwnedPath(pointerTempPath);
    if (pointerTempFailure) failures.push(pointerTempFailure);
  }
  failures.push(...await releasePointerLock(lock));
  if (failures.length === 0) return primary;
  return recoveryAbort(
    lock.context,
    primary,
    failures,
    pointerTempPath && failures[0]?.phase === 'remove-pointer-temp' ? 'precommit-cleanup' : 'lock-release',
  );
}

function unusablePointerAbort(
  context: SessionPointerContext,
  candidateSessionId: string | undefined,
  pointer: SessionPointerReadResult,
): ResolvedSessionPointerAbort {
  const pointerStatus = pointer.status === 'malformed'
    || pointer.status === 'foreign-cwd'
    || pointer.status === 'identity-indeterminate'
    ? pointer.status
    : undefined;
  return resolvedAbort(context, {
    code: 'session_pointer_unusable',
    operation: 'pointer-classify',
    ...(candidateSessionId ? { candidateSessionId } : {}),
    ...(pointer.state?.session_id ? { canonicalSessionId: pointer.state.session_id } : {}),
    lockPath: context.lockPath,
    ...(pointerStatus ? { pointerStatus } : {}),
    reason: `Selected session pointer is ${pointer.status} and is preserved.`,
  });
}

function ownerConflictAbort(
  context: SessionPointerContext,
  candidateSessionId: string,
  state: SessionState,
  cause?: unknown,
): ResolvedSessionPointerAbort {
  return resolvedAbort(context, {
    code: 'session_pointer_owner_conflict',
    operation: 'owner-conflict',
    candidateSessionId,
    canonicalSessionId: state.session_id,
    lockPath: context.lockPath,
    reason: `Session pointer ${state.session_id} conflicts with requested session ${candidateSessionId}.`,
    ...(cause ? { cause } : {}),
  });
}

interface PointerTransactionResult<T> {
  context: SessionPointerContext;
  value: T;
}

async function writePointerTransaction<T>(
  cwd: string,
  candidateSessionId: string | undefined,
  options: Pick<SessionStartOptions, 'context'>,
  timeoutMs: number,
  transition: (pointer: SessionPointerReadResult, context: SessionPointerContext) => T,
  pointerState: (value: T) => SessionState,
): Promise<PointerTransactionResult<T>> {
  let context: SessionPointerContext;
  try {
    context = options.context ?? resolveSessionPointerContext(cwd);
  } catch (error) {
    throw contextAbort(cwd, candidateSessionId, error);
  }

  if (!candidateSessionId) {
    const cause = new Error('A valid session ID is required for pointer mutation.');
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'pointer-classify',
      lockPath: context.lockPath,
      reason: cause.message,
      cause,
    });
  }

  try {
    await transactionDependencies.fs.mkdir(context.baseStateDir, { recursive: true });
  } catch (error) {
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'state-dir-create',
      candidateSessionId,
      lockPath: context.lockPath,
      reason: `Unable to create selected session state directory: ${errorMessage(error)}`,
      cause: error,
    });
  }

  const lock = await acquirePointerLock(
    context,
    candidateSessionId,
    timeoutMs,
  );
  const pointerTempPath = `${context.sessionPath}.tmp-${lock.token}`;
  let pointerCommitted = false;

  try {
    let pointer: SessionPointerReadResult;
    try {
      pointer = await readSessionPointer(context);
    } catch (error) {
      throw resolvedAbort(context, {
        code: 'session_pointer_io_failure',
        operation: 'pointer-read',
        candidateSessionId,
        lockPath: context.lockPath,
        reason: `Unable to read selected session pointer: ${errorMessage(error)}`,
        cause: error,
      });
    }

    let next: T;
    try {
      next = transition(pointer, context);
    } catch (error) {
      if (isSessionPointerLaunchAbort(error)) throw error;
      const state = pointer.state;
      throw ownerConflictAbort(context, candidateSessionId, state ?? {
        session_id: candidateSessionId,
        started_at: '',
        cwd: context.cwd,
        pid: 0,
      }, error);
    }

    const serialized = JSON.stringify(pointerState(next), null, 2);
    try {
      await transactionDependencies.fs.writeFile(pointerTempPath, serialized, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      throw resolvedAbort(context, {
        code: 'session_pointer_io_failure',
        operation: 'pointer-temp-write',
        candidateSessionId,
        lockPath: context.lockPath,
        reason: `Unable to write session pointer temporary file: ${errorMessage(error)}`,
        cause: error,
      });
    }
    try {
      await transactionDependencies.fs.openAndSync(pointerTempPath);
    } catch (error) {
      throw resolvedAbort(context, {
        code: 'session_pointer_io_failure',
        operation: 'pointer-fsync',
        candidateSessionId,
        lockPath: context.lockPath,
        reason: `Unable to sync session pointer temporary file: ${errorMessage(error)}`,
        cause: error,
      });
    }
    try {
      await transactionDependencies.fs.rename(pointerTempPath, context.sessionPath);
      pointerCommitted = true;
    } catch (error) {
      throw resolvedAbort(context, {
        code: 'session_pointer_io_failure',
        operation: 'pointer-rename',
        candidateSessionId,
        lockPath: context.lockPath,
        reason: `Unable to atomically publish session pointer: ${errorMessage(error)}`,
        cause: error,
      });
    }

    const releaseFailures = await releasePointerLock(lock);
    if (releaseFailures.length > 0) throw releaseFailureError(releaseFailures);
    return { context, value: next };
  } catch (error) {
    if (pointerCommitted) throw error;
    const primary = isSessionPointerLaunchAbort(error)
      ? error as ResolvedSessionPointerAbort
      : resolvedAbort(context, {
        code: 'session_pointer_io_failure',
        operation: 'pointer-classify',
        candidateSessionId,
        lockPath: context.lockPath,
        reason: `Session pointer transition failed before commit: ${errorMessage(error)}`,
        cause: error,
      });
    const ownsPointerTemp = primary.operation === 'pointer-temp-write'
      || primary.operation === 'pointer-fsync'
      || primary.operation === 'pointer-rename';
    throw await finalizePrecommitAbort(lock, primary, ownsPointerTemp ? pointerTempPath : undefined);
  }
}

function startPointerTransition(
  requestedSessionId: string,
  options: SessionStartOptions,
): (pointer: SessionPointerReadResult, context: SessionPointerContext) => SessionState {
  return (pointer, context) => {
    if (pointer.status !== 'absent' && pointer.status !== 'stale-dead' && pointer.status !== 'usable') {
      throw unusablePointerAbort(context, requestedSessionId, pointer);
    }

    const existing = pointer.status === 'usable' ? pointer.state : undefined;
    if (existing && !isStartCompatible(existing, requestedSessionId)) {
      throw ownerConflictAbort(context, requestedSessionId, existing);
    }

    const canonicalSessionId = existing?.session_id ?? requestedSessionId;
    const pid = resolvePid(options);
    const platform = options.platform ?? process.platform;
    const ownerCandidate = verifiedOwnerCandidate(context, options);
    let ownerOmxSessionId: string | undefined;
    try {
      ownerOmxSessionId = mergeOwnerAlias(
        existing,
        ownerCandidate,
        ownerCandidate !== undefined,
      );
    } catch (error) {
      throw ownerConflictAbort(context, requestedSessionId, existing ?? {
        session_id: canonicalSessionId,
        started_at: '',
        cwd: context.cwd,
        pid,
      }, error);
    }

    return createSessionState(context.cwd, canonicalSessionId, pid, platform, sessionIdentityFor(pid, platform), {
      nativeSessionId: options.nativeSessionId ?? existing?.native_session_id,
      previousNativeSessionId: options.previousNativeSessionId ?? existing?.previous_native_session_id,
      nativeSessionSwitchedAt: options.nativeSessionSwitchedAt ?? existing?.native_session_switched_at,
      ...(ownerOmxSessionId ? { ownerOmxSessionId } : {}),
      tmuxSessionName: options.tmuxSessionName ?? existing?.tmux_session_name,
      tmuxPaneId: options.tmuxPaneId ?? existing?.tmux_pane_id,
    });
  };
}

/** Write or merge a wrapper-owned canonical pointer through the exact-root transaction. */
export async function writeSessionStart(
  cwd: string,
  sessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const requestedSessionId = normalizeSessionId(sessionId);
  const result = await writePointerTransaction(
    cwd,
    requestedSessionId,
    options,
    DEFAULT_POINTER_TIMEOUT_MS,
    startPointerTransition(requestedSessionId ?? sessionId, options),
    (state) => state,
  );
  await appendToLogAtContext(result.context, {
    event: 'session_start',
    session_id: result.value.session_id,
    ...(result.value.native_session_id ? { native_session_id: result.value.native_session_id } : {}),
    pid: result.value.pid,
    timestamp: result.value.started_at,
  }).catch(() => {});
  return result.value;
}

interface NativeReconcileTransition {
  state: SessionState;
  replacementLog?: Record<string, unknown>;
}

function reconcileNativeTransition(
  nativeSessionId: string,
  options: SessionStartOptions,
): (pointer: SessionPointerReadResult, context: SessionPointerContext) => NativeReconcileTransition {
  return (pointer, context) => {
    if (pointer.status !== 'absent' && pointer.status !== 'stale-dead' && pointer.status !== 'usable') {
      throw unusablePointerAbort(context, nativeSessionId, pointer);
    }

    const pid = resolvePid(options);
    const platform = options.platform ?? process.platform;
    const linuxIdentity = sessionIdentityFor(pid, platform);
    const existing = pointer.status === 'usable' ? pointer.state : undefined;
    const nowIso = new Date().toISOString();

    if (!existing) {
      const ownerCandidate = verifiedOwnerCandidate(context, options);
      const ownerOmxSessionId = ownerCandidate;
      return {
        state: createSessionState(context.cwd, nativeSessionId, pid, platform, linuxIdentity, {
          nativeSessionId,
          ...(ownerOmxSessionId ? { ownerOmxSessionId } : {}),
        }),
      };
    }

    const existingNativeSessionId = normalizeSessionId(existing.native_session_id);
    if (existingNativeSessionId && existingNativeSessionId !== nativeSessionId) {
      const ownerOmxSessionId = getOmxLaunchSessionId(existing);
      return {
        state: createSessionState(context.cwd, nativeSessionId, pid, platform, linuxIdentity, {
          nativeSessionId,
          ...(ownerOmxSessionId ? {
            previousNativeSessionId: existingNativeSessionId,
            nativeSessionSwitchedAt: nowIso,
            ownerOmxSessionId,
          } : {}),
        }),
        ...(ownerOmxSessionId ? {
          replacementLog: {
            event: 'native_session_replaced',
            session_id: ownerOmxSessionId,
            ...(existing.session_id !== ownerOmxSessionId ? { active_session_id: existing.session_id } : {}),
            previous_native_session_id: existingNativeSessionId,
            replaced_by_native_session_id: nativeSessionId,
            pid,
            timestamp: nowIso,
          },
        } : {}),
      };
    }

    const ownerCandidate = verifiedOwnerCandidate(context, options);
    let ownerOmxSessionId: string | undefined;
    try {
      ownerOmxSessionId = mergeOwnerAlias(
        existing,
        ownerCandidate,
        ownerCandidate !== undefined,
      );
    } catch (error) {
      throw ownerConflictAbort(context, nativeSessionId, existing, error);
    }

    return {
      state: createSessionState(context.cwd, existing.session_id, pid, platform, linuxIdentity, {
        nowIso,
        nativeSessionId,
        previousNativeSessionId: existing.previous_native_session_id,
        nativeSessionSwitchedAt: existing.native_session_switched_at,
        ...(ownerOmxSessionId ? { ownerOmxSessionId } : {}),
        startedAt: existing.started_at,
        tmuxSessionName: existing.tmux_session_name,
        tmuxPaneId: existing.tmux_pane_id,
      }),
    };
  };
}

/**
 * Reconcile a native SessionStart without borrowing another root's pointer.
 * A different native ID retains the existing OMX owner chain, but never binds a
 * new owner alias during that replacement transition.
 */
export async function reconcileNativeSessionStart(
  cwd: string,
  nativeSessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const normalizedNativeSessionId = normalizeSessionId(nativeSessionId);
  const result = await writePointerTransaction(
    cwd,
    normalizedNativeSessionId,
    options,
    NATIVE_POINTER_TIMEOUT_MS,
    reconcileNativeTransition(normalizedNativeSessionId ?? nativeSessionId, options),
    (transition) => transition.state,
  );
  if (result.value.replacementLog) {
    await appendToLogAtContext(result.context, result.value.replacementLog).catch(() => {});
  }
  await appendToLogAtContext(result.context, {
    event: result.value.replacementLog ? 'session_start' : 'session_start_reconciled',
    session_id: result.value.state.session_id,
    native_session_id: normalizedNativeSessionId ?? nativeSessionId,
    pid: result.value.state.pid,
    timestamp: result.value.state.native_session_switched_at ?? new Date().toISOString(),
  }).catch(() => {});
  return result.value.state;
}

function historyDirectory(context: SessionPointerContext): string {
  return join(dirname(context.baseStateDir), 'logs');
}

function historyPath(context: SessionPointerContext): string {
  return join(historyDirectory(context), HISTORY_FILE);
}

async function removeDeadSessionHudState(
  context: SessionPointerContext,
  sessionIds: Array<string | undefined>,
): Promise<void> {
  const uniqueSessionIds = [...new Set(sessionIds.filter((value): value is string => Boolean(normalizeSessionId(value))))];
  const candidatePaths = [
    join(context.baseStateDir, 'hud-state.json'),
    ...uniqueSessionIds.map((sessionId) => join(context.baseStateDir, 'sessions', sessionId, 'hud-state.json')),
  ];
  await Promise.all(candidatePaths.map(async (path) => {
    try {
      await rm(path, { force: true });
    } catch {
      // HUD cleanup remains best effort after history has been recorded.
    }
  }));
}

/**
 * Archive first and remove an owned pointer only after that history write
 * succeeds. Present unusable pointer evidence is never repaired or archived.
 */
export async function writeSessionEnd(
  cwd: string,
  sessionId: string,
  options: Pick<SessionStartOptions, 'context'> = {},
): Promise<void> {
  const candidateSessionId = normalizeSessionId(sessionId);
  let context: SessionPointerContext;
  try {
    context = options.context ?? resolveSessionPointerContext(cwd);
  } catch (error) {
    throw contextAbort(cwd, candidateSessionId, error);
  }
  if (!candidateSessionId) {
    const cause = new Error('A valid session ID is required to end a session pointer.');
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'pointer-classify',
      lockPath: context.lockPath,
      reason: cause.message,
      cause,
    });
  }

  try {
    await transactionDependencies.fs.mkdir(context.baseStateDir, { recursive: true });
  } catch (error) {
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure',
      operation: 'state-dir-create',
      candidateSessionId,
      lockPath: context.lockPath,
      reason: `Unable to create selected session state directory: ${errorMessage(error)}`,
      cause: error,
    });
  }

  const lock = await acquirePointerLock(
    context,
    candidateSessionId,
    DEFAULT_POINTER_TIMEOUT_MS,
  );
  let primary: unknown;
  try {
    let pointer: SessionPointerReadResult;
    try {
      pointer = await readSessionPointer(context);
    } catch (error) {
      throw resolvedAbort(context, {
        code: 'session_pointer_io_failure',
        operation: 'pointer-read',
        candidateSessionId,
        lockPath: context.lockPath,
        reason: `Unable to read selected session pointer: ${errorMessage(error)}`,
        cause: error,
      });
    }
    if (pointer.status !== 'absent' && pointer.status !== 'usable') {
      throw unusablePointerAbort(context, candidateSessionId, pointer);
    }

    const state = pointer.state;
    const ownsCurrentSessionFile = state == null
      || state.session_id === candidateSessionId
      || state.native_session_id === candidateSessionId
      || state.owner_omx_session_id === candidateSessionId;
    const endTime = new Date().toISOString();
    const historyEntry = {
      session_id: ownsCurrentSessionFile
        ? (state?.owner_omx_session_id === candidateSessionId ? candidateSessionId : state?.session_id || candidateSessionId)
        : candidateSessionId,
      ...(ownsCurrentSessionFile && state?.native_session_id ? { native_session_id: state.native_session_id } : {}),
      started_at: ownsCurrentSessionFile ? state?.started_at || 'unknown' : 'unknown',
      ended_at: endTime,
      cwd: context.cwd,
      pid: ownsCurrentSessionFile ? state?.pid || process.pid : process.pid,
      ...(ownsCurrentSessionFile && state?.owner_omx_session_id === candidateSessionId && state?.session_id
        ? { active_session_id: state.session_id }
        : {}),
      ...(!ownsCurrentSessionFile && state?.session_id ? { preserved_active_session_id: state.session_id } : {}),
    };

    await nodeMkdir(historyDirectory(context), { recursive: true });
    await appendFile(historyPath(context), `${JSON.stringify(historyEntry)}\n`);
    await removeDeadSessionHudState(context, [
      ...(ownsCurrentSessionFile ? [state?.session_id, state?.native_session_id] : []),
      candidateSessionId,
    ]);
    if (ownsCurrentSessionFile) {
      try {
        await transactionDependencies.fs.unlink(context.sessionPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    await appendToLogAtContext(context, {
      event: 'session_end',
      session_id: historyEntry.session_id,
      ...(historyEntry.native_session_id ? { native_session_id: historyEntry.native_session_id } : {}),
      ...(historyEntry.active_session_id ? { active_session_id: historyEntry.active_session_id } : {}),
      ...(historyEntry.preserved_active_session_id ? { preserved_active_session_id: historyEntry.preserved_active_session_id } : {}),
      timestamp: endTime,
    }).catch(() => {});
  } catch (error) {
    primary = error;
  }

  const releaseFailures = await releasePointerLock(lock);
  if (primary) {
    if (isSessionPointerLaunchAbort(primary) && releaseFailures.length > 0) {
      throw recoveryAbort(context, primary as ResolvedSessionPointerAbort, releaseFailures, 'lock-release');
    }
    throw primary;
  }
  if (releaseFailures.length > 0) throw releaseFailureError(releaseFailures);
}

/** Reset session-scoped HUD/metrics files at launch. */
export async function resetSessionMetrics(cwd: string, sessionId?: string): Promise<void> {
  const context = resolveSessionPointerContext(cwd);
  const omxDir = omxRoot(context.cwd);
  await nodeMkdir(omxDir, { recursive: true });
  await transactionDependencies.fs.mkdir(context.baseStateDir, { recursive: true });

  const now = new Date().toISOString();
  await nodeWriteFile(join(omxDir, 'metrics.json'), JSON.stringify({
    total_turns: 0,
    session_turns: 0,
    last_activity: now,
    session_input_tokens: 0,
    session_output_tokens: 0,
    session_total_tokens: 0,
    five_hour_limit_pct: 0,
    weekly_limit_pct: 0,
  }, null, 2));

  const normalizedSessionId = normalizeSessionId(sessionId);
  const hudStatePath = normalizedSessionId
    ? join(context.baseStateDir, 'sessions', normalizedSessionId, 'hud-state.json')
    : join(context.baseStateDir, 'hud-state.json');
  await nodeMkdir(dirname(hudStatePath), { recursive: true });
  await nodeWriteFile(hudStatePath, JSON.stringify({
    last_turn_at: now,
    last_progress_at: now,
    turn_count: 0,
    last_agent_output: '',
  }, null, 2));
}

async function appendToLogAtContext(
  context: SessionPointerContext,
  entry: Record<string, unknown>,
): Promise<void> {
  const logsDir = historyDirectory(context);
  await nodeMkdir(logsDir, { recursive: true });
  const logFile = join(logsDir, `omx-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await appendFile(logFile, `${JSON.stringify({ ...entry, _ts: new Date().toISOString() })}\n`);
}

/**
 * Append one redacted provenance rejection to the already-selected state root.
 * This deliberately accepts a resolved context rather than cwd, and never falls
 * back to the ambient root when that exact write fails.
 */
export async function appendPromptSessionProvenanceRejection(
  context: SessionPointerContext,
  descriptor: PromptDiagnosticDescriptor,
): Promise<void> {
  await appendToLogAtContext(context, {
    event: 'prompt_session_provenance_rejected',
    reason: descriptor.reason,
    producer: descriptor.producer,
    selected_root_status: descriptor.selectedRootStatus,
    ...(descriptor.relation ? { relation: descriptor.relation } : {}),
    timestamp: descriptor.timestamp,
  });
}

/**
 * Append a root log entry for callers that do not already own a pointer
 * context. Lifecycle transitions use appendToLogAtContext instead.
 */
export async function appendToLog(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const logsDir = omxLogsDir(cwd);
  await nodeMkdir(logsDir, { recursive: true });
  const logFile = join(logsDir, `omx-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await appendFile(logFile, `${JSON.stringify({ ...entry, _ts: new Date().toISOString() })}\n`);
}