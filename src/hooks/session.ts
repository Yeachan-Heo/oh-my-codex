/**
 * Session lifecycle management.
 *
 * The selected state root owns one canonical session pointer. Pointer writes are
 * serialized by an adjacent lock directory and become visible only after an
 * atomic rename of a transaction-owned temporary file.
 */
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import {
  appendFile,
  link as nodeLink,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath,
  rename as nodeRename,
  rmdir as nodeRmdir,
  rm,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'fs/promises';
import { appendFileSync, closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { omxRoot, omxLogsDir, sameFilePath } from '../utils/paths.js';
import { resolveRuntimeBinaryPath } from '../runtime/bridge.js';
import {
  getBaseStateDirWithSource,
  resolveWorkingDirectoryForState,
  type StateRootSource,
} from '../mcp/state-paths.js';
import type { PromptDiagnosticDescriptor } from './prompt-session-provenance.js';
import {
  emitDegradedDurabilityWarning,
  recordRegularFileSyncOutcome,
  syncRegularFile,
  type RegularFileDurabilityTracker,
  type RegularFileSyncOutcome,
} from '../utils/file-durability.js';

/** Cross-platform process birth identity. `birth` is an exact decimal string. */
export interface ProcessIdentity {
  platform: NodeJS.Platform;
  birth: string;
  cmdline_hash?: string;
}

/** Raw observation from a native process-identity provider. No comparison logic. */
export type ProcessObservation =
  | { kind: 'identity'; identity: ProcessIdentity }
  | { kind: 'gone' }
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'error' };

/** Classification of a recorded identity against a live observation. */
export type IdentityClassification =
  | { status: 'match' }
  | { status: 'birth-mismatch' }
  | { status: 'identity-unavailable' }
  | { status: 'gone' };

/** Provider interface for observing process identity. */
export interface ProcessInspectionProvider {
  probePid(pid: number): PidProbeResult;
  observeProcess(pid: number, platform: NodeJS.Platform): ProcessObservation;
}

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
  state_root?: string;
  pid: number;
  platform?: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline?: string;
  /** Versioned process identity schema; absent means legacy v1. */
  identity_schema_version?: 2;
  /** Cross-platform process identity (v2 schema). */
  process_identity?: ProcessIdentity;
  tmux_session_name?: string;
  tmux_pane_id?: string;
  /** Private wrapper lineage evidence; native reconciliation never creates or repairs it. */
  launch_lineage_token?: string;
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

/** Classified native session-owner sidecar evidence for fail-closed consumers. */
export interface NativeSessionOwnerEvidence extends SessionPointerReadResult {}

interface SessionOwnerFileIdentity {
  dev: number;
  ino: number;
}

export function sessionOwnerFileIdentityMatches(
  frozenPath: SessionOwnerFileIdentity,
  openedHandle: SessionOwnerFileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (frozenPath.ino <= 0 || openedHandle.ino !== frozenPath.ino) return false;
  if (openedHandle.dev === frozenPath.dev) return true;
  return platform === 'win32'
    && frozenPath.dev === 0
    && openedHandle.dev > 0;
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
  | 'remove-release-owner'
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

export type UnsupportedDirectoryCapabilityReason = 'platform' | 'inadequate-identity' | 'stat-feature';
export type CapabilityCloseEvidence = Readonly<{
  role: 'acquisition' | 'fresh-comparison' | 'original-retained';
  phase: 'before-authorization' | 'post-finalization' | 'detached-pre-release';
  status: 'not-needed' | 'closed' | 'failed';
  error?: Readonly<{ name: string; message: string; code?: string }>;
}>;
export interface EstablishmentCleanupEvidence {
  readonly capability: readonly CapabilityCloseEvidence[];
}
export interface LifecycleCleanupEvidence extends EstablishmentCleanupEvidence {
  readonly comparison?: Readonly<{ status: 'not-run' | 'matched' | 'denied'; reason?: string }>;
}
export interface LaunchSessionBinding {
  readonly context: Readonly<SessionPointerContext>;
  readonly canonicalRealpath: string;
  readonly directoryIdentity: Readonly<
    | { kind: 'supported'; dev: bigint; ino: bigint }
    | { kind: 'unsupported'; reason: UnsupportedDirectoryCapabilityReason }
  >;
  readonly canonicalSessionId: string;
  readonly ownerOmxSessionId?: string;
  readonly nativeSessionId?: string;
  readonly startedAt: string;
  readonly launchLineageToken: string;
}
export interface CommittedLaunchEvidence {
  readonly context: Readonly<SessionPointerContext>;
  readonly canonicalSessionId: string;
}
export class CommittedLaunchBlockedError extends Error {
  readonly name = 'CommittedLaunchBlockedError';
  constructor(readonly secondaryFailures: readonly SessionPointerSecondaryFailure[]) {
    super('Session pointer committed, but lock release left recovery evidence.');
  }
}
export type LaunchEstablishment =
  | { kind: 'precommit-aborted'; abort: SessionPointerLaunchAbort; cleanup: EstablishmentCleanupEvidence }
  | { kind: 'committed-released'; binding: LaunchSessionBinding; cleanup: EstablishmentCleanupEvidence }
  | {
      kind: 'committed-release-failed'; evidence: CommittedLaunchEvidence; error: CommittedLaunchBlockedError;
      lockDisposition: 'held' | 'released-with-residue' | 'uncertain';
      secondaryFailures: readonly SessionPointerSecondaryFailure[]; cleanup: EstablishmentCleanupEvidence;
    };
export type DetachedMetadataUpdate =
  | { kind: 'precommit-aborted'; abort: SessionPointerLaunchAbort; cleanup: EstablishmentCleanupEvidence }
  | { kind: 'committed-released'; evidence: CommittedLaunchEvidence; cleanup: EstablishmentCleanupEvidence }
  | {
      kind: 'committed-release-failed'; evidence: CommittedLaunchEvidence; error: CommittedLaunchBlockedError;
      lockDisposition: 'held' | 'released-with-residue' | 'uncertain';
      secondaryFailures: readonly SessionPointerSecondaryFailure[]; cleanup: EstablishmentCleanupEvidence;
    };
export interface BoundFinalizationReport {
  readonly cleanup: LifecycleCleanupEvidence;
  readonly finalized: boolean;
}

const SESSION_FILE = 'session.json';
const SESSION_OWNER_FILE = 'session-owner.json';
const HISTORY_FILE = 'session-history.jsonl';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_POINTER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_RETRY_DELAYS_MS = [25, 50, 100] as const;
const DEFAULT_POINTER_TIMEOUT_MS = 5_000;
const NATIVE_POINTER_TIMEOUT_MS = 2_000;


function traceSessionFinalizationOperation(operation: string): void {
  if (process.env.OMX_TEST_DETACHED_TRACE !== '1') return;
  const tracePath = process.env.OMX_TEST_DETACHED_TRACE_PATH;
  if (!tracePath) return;
  appendFileSync(tracePath, `[omx-test-session-finalization] ${operation}\n`);
}
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
export function resolveSessionPointerContext(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionPointerContext {
  const normalizedCwd = resolveWorkingDirectoryForState(cwd, env);
  const { baseStateDir, rootSource } = getBaseStateDirWithSource(normalizedCwd, env);
  const pointerPath = join(baseStateDir, SESSION_FILE);
  return {
    cwd: normalizedCwd,
    baseStateDir,
    rootSource,
    sessionPath: pointerPath,
    lockPath: `${pointerPath}.lock`,
  };
}

function resolveNativeSessionOwnerContext(
  cwd: string,
  nativeSessionId: string,
): SessionPointerContext {
  const root = resolveSessionPointerContext(cwd);
  const normalized = normalizeSessionId(nativeSessionId);
  if (!normalized) {
    throw resolvedAbort(root, {
      code: 'session_pointer_io_failure',
      operation: 'pointer-classify',
      lockPath: root.lockPath,
      reason: 'A valid native session ID is required for owner evidence.',
    });
  }
  const baseStateDir = join(root.baseStateDir, 'sessions', normalized);
  const sessionPath = join(baseStateDir, SESSION_OWNER_FILE);
  return {
    ...root,
    baseStateDir,
    sessionPath,
    lockPath: `${sessionPath}.lock`,
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
  probePid?: (pid: number) => PidProbeResult;
  observeProcess?: (pid: number, platform: NodeJS.Platform) => ProcessObservation;
  readLinuxIdentity?: (pid: number) => LinuxProcessIdentity | null;
}

export interface SessionStartOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  /** @internal Scoped deterministic regular-file fsync seam. */
  regularFileSync?: (platform: NodeJS.Platform) => Promise<void>;
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
  lstat(path: string): Promise<{
    dev: number;
    ino: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  writeFile(path: string, data: string, options?: { mode?: number; flag?: string }): Promise<void>;
  openAndSync(
    path: string,
    platform: NodeJS.Platform,
    regularFileSync?: SessionStartOptions['regularFileSync'],
  ): Promise<RegularFileSyncOutcome>;
  rename(from: string, to: string): Promise<void>;
  link(path: string, dest: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}


export interface SessionPointerLockInspection {
  status: 'absent' | 'live' | 'dead' | 'reused' | 'identity-indeterminate' | 'missing-owner' | 'malformed' | 'ambiguous' | 'unexpected' | 'symlink' | 'io-error';
  lockPath: string;
  evidenceSource: 'none' | 'owner.json' | 'owner-temp';
  safeToRecover: boolean;
}

export interface SessionPointerLockRecovery extends SessionPointerLockInspection {
  action: 'none' | 'quarantined';
  recovered: boolean;
  reason: string;
  quarantinePath?: string;
}

export type SessionPointerRecoveryStatus =
  | 'absent'
  | 'recovered'
  | 'usable'
  | 'reused'
  | 'identity-indeterminate'
  | 'malformed'
  | 'foreign-cwd'
  | 'foreign-root'
  | 'lock-unavailable'
  | 'race'
  | 'collision'
  | 'recovery-required'
  | 'io-error';

export interface SessionPointerRecovery {
  status: SessionPointerRecoveryStatus;
  pointerPath: string;
  action: 'none' | 'quarantined';
  recovered: boolean;
  reason: string;
  sessionId?: string;
  quarantinePath?: string;
}

/** @internal Test-only deterministic transaction seam; do not use outside session tests. */
export interface SessionPointerTransactionDependencies {
  fs: SessionPointerFsDependencies;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  token(): string;
  runtimePlatform: NodeJS.Platform;
  probePid(pid: number): PidProbeResult;
  observeProcess(pid: number, platform: NodeJS.Platform): ProcessObservation;
  atomicRenameNoReplace(from: string, to: string): Promise<RecoveryRenameNoReplaceResult>;
}

/** Recovery-only no-clobber rename seam. Normal lock lifecycle never uses it. */
export type RecoveryRenameNoReplaceResult = 'moved' | 'not-moved' | 'unsupported';

const defaultFsDependencies: SessionPointerFsDependencies = {
  mkdir: async (path, options) => {
    await nodeMkdir(path, options);
  },
  readdir: async (path) => await nodeReaddir(path),
  readFile: async (path, encoding) => await nodeReadFile(path, encoding),
  readBytes: async (path) => await nodeReadFile(path),
  lstat: async (path) => await nodeLstat(path),
  writeFile: async (path, data, options) => {
    await nodeWriteFile(path, data, options);
  },
  openAndSync: async (path, platform, regularFileSync) => {
    const handle = await open(path, 'r');
    try {
      return await syncRegularFile(
        regularFileSync ? { sync: () => regularFileSync(platform) } : handle,
        platform,
      );
    } finally {
      await handle.close();
    }
  },
  rename: async (from, to) => {
    await nodeRename(from, to);
  },
  link: async (path, dest) => {
    await nodeLink(path, dest);
  },
  unlink: async (path) => {
    await nodeUnlink(path);
  },
  rmdir: async (path) => {
    await nodeRmdir(path);
  },
};

async function defaultRecoveryRenameNoReplace(from: string, to: string): Promise<RecoveryRenameNoReplaceResult> {
  if (!from.trim() || !to.trim() || !isAbsolute(from) || !isAbsolute(to)) return 'unsupported';

  try {
    const stdout = nodeExecFileSync(
      resolveRuntimeBinaryPath(),
      ['fs-rename-no-replace', from, to],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
    const parsed = JSON.parse(String(stdout)) as { outcome?: unknown };
    if (parsed.outcome === 'moved' || parsed.outcome === 'not-moved' || parsed.outcome === 'unsupported') {
      return parsed.outcome;
    }
  } catch {
    // Missing binaries, spawn failures, hard runtime errors, and malformed output
    // all fail closed; recovery must never fall back to an overwriting rename.
  }
  return 'unsupported';
}

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

function defaultObserveProcess(pid: number, platform: NodeJS.Platform): ProcessObservation {
  if (platform === 'linux') {
    return observeLinuxProcess(pid);
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    return { kind: 'unsupported' };
  }
  try {
    const stdout = nodeExecFileSync(resolveRuntimeBinaryPath(), ['process-identity', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseProcessIdentityOutput(stdout);
  } catch {
    return { kind: 'unsupported' };
  }
}

const defaultTransactionDependencies: SessionPointerTransactionDependencies = {
  fs: defaultFsDependencies,
  nowMs: () => Date.now(),
  sleep: async (ms) => await new Promise<void>((resolve) => setTimeout(resolve, ms)),
  token: () => randomUUID(),
  runtimePlatform: process.platform,
  probePid: defaultProbePid,
  observeProcess: defaultObserveProcess,
  atomicRenameNoReplace: defaultRecoveryRenameNoReplace,
};

export const defaultProcessInspectionProvider: ProcessInspectionProvider = {
  probePid: defaultProbePid,
  observeProcess: defaultObserveProcess,
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

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
]);
const PROCESS_BIRTH_PATTERN = /^\d+(?:\.\d+)?$/;

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === 'string' && NODE_PLATFORMS.has(value as NodeJS.Platform);
}

function isValidBirth(value: unknown): value is string {
  return typeof value === 'string' && PROCESS_BIRTH_PATTERN.test(value);
}

export function isValidProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<ProcessIdentity>;
  if (Object.keys(identity).some((key) => key !== 'platform' && key !== 'birth' && key !== 'cmdline_hash')) return false;
  return isNodePlatform(identity.platform)
    && isValidBirth(identity.birth)
    && (identity.cmdline_hash === undefined
      || typeof identity.cmdline_hash === 'string' && SHA256_PATTERN.test(identity.cmdline_hash));
}

function isComparableProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<ProcessIdentity>;
  return isNodePlatform(identity.platform)
    && typeof identity.birth === 'string'
    && identity.birth.length > 0
    && (identity.cmdline_hash === undefined
      || typeof identity.cmdline_hash === 'string' && SHA256_PATTERN.test(identity.cmdline_hash));
}

function observeLinuxProcess(pid: number): ProcessObservation {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'error' };
  const identity = readLinuxProcessIdentity(pid);
  if (identity) {
    const cmdlineHash = hashCmdline(identity.cmdline);
    return {
      kind: 'identity',
      identity: {
        platform: 'linux',
        birth: String(identity.startTicks),
        ...(cmdlineHash ? { cmdline_hash: cmdlineHash } : {}),
      },
    };
  }

  let statContent: string;
  try {
    statContent = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' };
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'denied' };
    return { kind: 'error' };
  }
  if (!statContent) return { kind: 'error' };
  const probe = defaultProbePid(pid);
  if (probe === 'dead') return { kind: 'gone' };
  if (probe === 'indeterminate') return { kind: 'denied' };
  return { kind: 'error' };
}

function parseProcessIdentityOutput(stdout: string): ProcessObservation {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'error' };
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value);
    const outcome = value.outcome;
    if (outcome !== undefined) {
      if (typeof outcome !== 'string') return { kind: 'error' };
      if (outcome === 'gone' || outcome === 'denied' || outcome === 'unsupported') {
        if (keys.length !== 1) return { kind: 'error' };
        if (outcome === 'gone') return { kind: 'gone' };
        if (outcome === 'denied') return { kind: 'denied' };
        return { kind: 'unsupported' };
      }
      if (outcome === 'error') return { kind: 'error' };
      return { kind: 'error' };
    }

    if (keys.some((key) => key !== 'platform' && key !== 'birth' && key !== 'cmdline')) {
      return { kind: 'error' };
    }
    const platform = value.platform;
    const birth = value.birth;
    if (!isNodePlatform(platform) || !isValidBirth(birth)) return { kind: 'error' };
    if (value.cmdline !== undefined && typeof value.cmdline !== 'string') return { kind: 'error' };
    const cmdlineHash = hashCmdline(value.cmdline as string | undefined);
    return {
      kind: 'identity',
      identity: {
        platform,
        birth,
        ...(cmdlineHash ? { cmdline_hash: cmdlineHash } : {}),
      },
    };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Legacy boolean stale check retained for read compatibility. The pointer
 * classifier below keeps indeterminate liveness distinct from definitely dead.
 *
 * KNOWN GAP (darwin): `identity-indeterminate` is treated as stale here, which is fail-closed and
 * correct on platforms that DO record process-birth evidence but cannot read it. On darwin no
 * identity source exists at all, so a live session also classifies indeterminate and reads as
 * stale. Two suite cases pin that gap (`treats symlinked cwd aliases as authoritative`,
 * `writes session start/end lifecycle artifacts`), while `returns true on Linux when identity
 * metadata is missing` / `... cannot be read` pin the fail-closed behavior, so the two cannot be
 * reconciled by changing this mapping. Fixing it requires distinguishing "no identity source on
 * this platform" from "identity expected but unavailable" in `classifySessionProcess` itself.
 * Callers needing a safe live-session answer today use `classifySessionStateLiveness(...) !==
 * 'stale-dead'` (see src/cli/setup.ts overwrite guard).
 */
function sessionClassificationDependencies(options: SessionStaleCheckOptions): {
  runtimePlatform: NodeJS.Platform;
  probePid: (pid: number) => PidProbeResult;
  observeProcess: (pid: number, platform: NodeJS.Platform) => ProcessObservation;
} {
  const runtimePlatform = options.platform ?? transactionDependencies.runtimePlatform ?? process.platform;
  const probePid = options.probePid ?? (options.isPidAlive
    ? (pid: number): PidProbeResult => options.isPidAlive!(pid) ? 'alive' : 'dead'
    : transactionDependencies.probePid);
  const observeProcess = options.observeProcess ?? (options.readLinuxIdentity
    ? (pid: number, platform: NodeJS.Platform): ProcessObservation => {
      if (platform !== 'linux') return { kind: 'unsupported' };
      const identity = options.readLinuxIdentity!(pid);
      if (!identity) return { kind: 'error' };
      const cmdlineHash = hashCmdline(identity.cmdline);
      return {
        kind: 'identity',
        identity: {
          platform: 'linux',
          birth: String(identity.startTicks),
          ...(cmdlineHash ? { cmdline_hash: cmdlineHash } : {}),
        },
      };
    }
    : transactionDependencies.observeProcess);
  return { runtimePlatform, probePid, observeProcess };
}

export function isSessionStale(
  state: SessionState,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!Number.isInteger(state.pid) || state.pid <= 0) return true;

  const { runtimePlatform, probePid, observeProcess } = sessionClassificationDependencies(options);
  const dependencies = {
    ...transactionDependencies,
    runtimePlatform,
    probePid,
    observeProcess,
  };
  const classification = classifySessionProcess(state, dependencies);
  if (classification === 'usable') return false;
  if (classification === 'stale-dead') return true;

  // `identity-indeterminate` means two different things and only one of them is stale.
  //
  // Where the platform CAN record process-birth evidence (linux) but it is missing or unreadable,
  // fail closed: that is the case `returns true on Linux when identity metadata is missing` and
  // `... when live identity cannot be read` pin deliberately.
  //
  // Where no identity source exists at all, every live session classifies indeterminate, so failing
  // closed reported a running session as dead. There a positively alive pid is the strongest
  // evidence available, and this is a READ predicate, not an authority grant: the classifier still
  // returns identity-indeterminate (pinned by `classifies identity-less live non-Linux pointers as
  // identity-indeterminate`), and authority-granting paths keep requiring `usable`.
  return !isUnobservableLivePointerState(state, runtimePlatform, probePid);
}

type ProcessClassificationStatus = 'usable' | 'stale-dead' | 'identity-indeterminate';
type ObservationComparison = 'match' | 'birth-mismatch' | 'birth-mismatch-retryable' | 'identity-unavailable';

function safeObserve(
  provider: ProcessInspectionProvider,
  pid: number,
  runtimePlatform: NodeJS.Platform,
): ProcessObservation {
  try {
    return provider.observeProcess(pid, runtimePlatform);
  } catch {
    return { kind: 'error' };
  }
}

function compareObservation(
  recorded: ProcessIdentity,
  observation: ProcessObservation | unknown,
  runtimePlatform: NodeJS.Platform,
): ObservationComparison {
  if (!observation || typeof observation !== 'object' || (observation as ProcessObservation).kind !== 'identity') {
    return 'identity-unavailable';
  }
  const identity = (observation as Extract<ProcessObservation, { kind: 'identity' }>).identity;
  if (!isComparableProcessIdentity(identity) || identity.platform !== runtimePlatform) {
    return 'identity-unavailable';
  }
  if (identity.birth !== recorded.birth) return 'birth-mismatch-retryable';
  if (recorded.cmdline_hash !== undefined && identity.cmdline_hash !== recorded.cmdline_hash) {
    return 'identity-unavailable';
  }
  return 'match';
}

/** Compare recorded process birth evidence with a fresh provider observation. */
export function classifyRecordedIdentity(
  recorded: Pick<ProcessIdentity, 'platform' | 'birth' | 'cmdline_hash'>,
  runtimePlatform: NodeJS.Platform,
  provider: ProcessInspectionProvider,
  pid: number,
): IdentityClassification {
  if (!isComparableProcessIdentity(recorded) || recorded.platform !== runtimePlatform || !Number.isInteger(pid) || pid <= 0) {
    return { status: 'identity-unavailable' };
  }

  let probe: PidProbeResult;
  try {
    probe = provider.probePid(pid);
  } catch {
    return { status: 'identity-unavailable' };
  }
  if (probe === 'dead') return { status: 'gone' };
  if (probe !== 'alive') return { status: 'identity-unavailable' };

  const first = compareObservation(recorded, safeObserve(provider, pid, runtimePlatform), runtimePlatform);
  if (first === 'birth-mismatch-retryable') {
    const second = compareObservation(recorded, safeObserve(provider, pid, runtimePlatform), runtimePlatform);
    if (second === 'match') return { status: 'match' };
    if (second === 'birth-mismatch-retryable' || second === 'birth-mismatch') return { status: 'birth-mismatch' };
    return { status: 'identity-unavailable' };
  }
  if (first === 'match') return { status: 'match' };
  if (first === 'birth-mismatch') return { status: 'birth-mismatch' };
  return { status: 'identity-unavailable' };
}

function recordedIdentityForState(
  state: SessionState,
  runtimePlatform: NodeJS.Platform,
): ProcessIdentity | null | 'invalid' {
  if (state.identity_schema_version !== undefined && state.identity_schema_version !== 2) return 'invalid';
  if (state.process_identity !== undefined) {
    if (state.identity_schema_version !== 2 || !isValidProcessIdentity(state.process_identity)) return 'invalid';
    if (state.platform !== undefined && state.platform !== state.process_identity.platform) return 'invalid';
    return state.process_identity;
  }
  if (state.identity_schema_version === 2) return 'invalid';

  const recordedPlatform = state.platform ?? runtimePlatform;
  if (recordedPlatform === 'linux' && isValidStartTicks(state.pid_start_ticks)) {
    const cmdlineHash = hashCmdline(state.pid_cmdline);
    return {
      platform: 'linux',
      birth: String(state.pid_start_ticks),
      ...(cmdlineHash ? { cmdline_hash: cmdlineHash } : {}),
    };
  }
  return null;
}

/**
 * A state with no recorded identity is indeterminate unless the pid is positively dead.
 *
 * Do NOT relax this to "alive + non-linux => usable": `classifies identity-less live non-Linux
 * pointers as identity-indeterminate` pins it deliberately, because without birth evidence an
 * alive pid cannot be distinguished from a REUSED pid, and granting `usable` there would let a
 * foreign process inherit session authority. Read paths that only need "is anyone alive here"
 * must ask `classifySessionStateLiveness(...) !== 'stale-dead'` instead (see the overwrite guard
 * in src/cli/setup.ts); authority-granting paths keep requiring `usable`.
 */
function probeIdentitylessProcess(
  pid: number,
  dependencies: SessionPointerTransactionDependencies,
): ProcessClassificationStatus {
  let probe: PidProbeResult;
  try {
    probe = dependencies.probePid(pid);
  } catch {
    return 'identity-indeterminate';
  }
  return probe === 'dead' ? 'stale-dead' : 'identity-indeterminate';
}

/**
 * Is an `identity-indeterminate` pointer merely UNOBSERVABLE on this platform, rather than
 * untrustworthy?
 *
 * Three distinct situations collapse into `identity-indeterminate`, and only the first one describes
 * a pointer that may legitimately be live:
 *  - the platform records no process-birth evidence at all (every live pointer lands here);
 *  - linux, which does record it, is missing or cannot read it (fail closed: the metadata should
 *    exist);
 *  - the evidence claims a DIFFERENT platform, which is forged or foreign (fail closed).
 *
 * Read predicates and preservation/refusal decisions may treat the first case as occupied. Authority
 * to own writes still requires `usable`, and the classifier itself is unchanged.
 */
function isUnobservableLivePointerState(
  state: { pid?: unknown; platform?: unknown; process_identity?: { platform?: unknown } } | undefined,
  // Explicit rather than read from transactionDependencies: isSessionStale accepts injected platform
  // and probe overrides, and silently using the host values there evaluated the linux fail-closed
  // cases against the wrong runtime.
  runtimePlatform: NodeJS.Platform = transactionDependencies.runtimePlatform,
  probe: (pid: number) => PidProbeResult = transactionDependencies.probePid,
): boolean {
  if (!state) return false;
  const recordedPlatform = state.process_identity?.platform ?? state.platform ?? runtimePlatform;
  if (recordedPlatform !== runtimePlatform) return false;
  if (recordedPlatform === 'linux') return false;
  if (typeof state.pid !== 'number' || !Number.isInteger(state.pid) || state.pid <= 0) return false;
  // POSITIVE liveness is required, not merely a plausible shape. A pid that cannot be probed at all
  // (for example an out-of-range one) is not evidence of a live session, and admitting it would let
  // a stale pointer survive a relaunch instead of failing closed.
  try {
    return probe(state.pid) === 'alive';
  } catch {
    return false;
  }
}

/**
 * May an existing pointer whose liveness could NOT be proven be reconciled in place?
 *
 * `isUnobservableLivePointerState` answers "someone may be here", which is enough to REFUSE a foreign
 * claim or to preserve lineage, but it is not proof of WHO is here, so reconciling it is an adoption
 * and needs its own justification.
 *
 * Neither pid NOR platform equality can be required here, and both were measured rather than assumed:
 * native SessionStart reconciliation exists so a native Codex process can adopt a pointer an OMX
 * launch wrote, so the pid legitimately differs, and `preserves canonical session id while
 * reconciling native SessionStart metadata` also reconciles with a different announced platform.
 * Requiring either refused legitimate reconciliation (that test fails), which is the defect this
 * change set fixes.
 *
 * What bounds the adoption is therefore: this cwd-authority check, asserted locally so the invariant
 * is visible at the mutation site instead of only implied by the classifier's foreign-cwd rejection;
 * plus native-id compatibility and owner-alias merge in the caller. A pointer for another working
 * directory or another session can never be adopted.
 */
function mayAdoptUnprovenPointer(existing: SessionState, cwd: string): boolean {
  return isSessionStateAuthoritativeForCwd(existing, cwd);
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
  const { runtimePlatform, probePid, observeProcess } = sessionClassificationDependencies(options);
  return classifySessionProcess(state, {
    ...transactionDependencies,
    runtimePlatform,
    probePid,
    observeProcess,
  }) === 'usable';
}

function isValidStartTicks(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function classifySessionProcess(
  state: SessionState,
  dependencies: SessionPointerTransactionDependencies,
): ProcessClassificationStatus {
  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  const hasIdentityMetadata = typeof state.pid_start_ticks === 'number'
    || typeof state.pid_cmdline === 'string'
    || state.identity_schema_version !== undefined
    || state.process_identity !== undefined;
  if (!hasPidMetadata && !hasIdentityMetadata) return 'usable';
  if (!hasPidMetadata) return 'identity-indeterminate';

  const runtimePlatform = dependencies.runtimePlatform;
  const recorded = recordedIdentityForState(state, runtimePlatform);
  if (recorded === 'invalid') return 'identity-indeterminate';
  if (!recorded) return probeIdentitylessProcess(state.pid, dependencies);

  const classification = classifyRecordedIdentity(recorded, runtimePlatform, dependencies, state.pid);
  switch (classification.status) {
    case 'match': return 'usable';
    case 'gone':
    case 'birth-mismatch': return 'stale-dead';
    case 'identity-unavailable': return 'identity-indeterminate';
  }
}

/**
 * Classify process liveness for an already-parsed selected session pointer.
 * Callers that need cwd/state_root authority must validate those against the
 * SAME snapshot themselves; this evaluates only pid/start-tick evidence so a
 * single immutable snapshot can drive both decisions.
 */
export function classifySessionStateLiveness(
  state: SessionState,
): 'usable' | 'stale-dead' | 'identity-indeterminate' {
  return classifySessionProcess(state, transactionDependencies);
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
  if (state.identity_schema_version !== undefined && state.identity_schema_version !== 2) return { status: 'identity-indeterminate', raw, state };
  if (state.process_identity !== undefined
    && (state.identity_schema_version !== 2
      || !isValidProcessIdentity(state.process_identity)
      || state.platform !== undefined && state.platform !== state.process_identity.platform)) {
    return { status: 'malformed', raw, state };
  }
  if (state.identity_schema_version === 2 && state.process_identity === undefined) return { status: 'malformed', raw, state };

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
export async function readSessionState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionState | null> {
  try {
    return await readSessionStateFromContext(resolveSessionPointerContext(cwd, env));
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
  stateRoot: string,
  sessionId: string,
  pid: number,
  platform: NodeJS.Platform,
  identity: ProcessIdentity | LinuxProcessIdentity | null,
  options: {
    nowIso?: string;
    nativeSessionId?: string;
    launchLineageToken?: string;
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
  const processIdentity = identity && 'birth' in identity
    ? identity
    : identity
      ? {
          platform: 'linux' as const,
          birth: String(identity.startTicks),
          ...(hashCmdline(identity.cmdline) ? { cmdline_hash: hashCmdline(identity.cmdline) } : {}),
        }
      : undefined;
  const publishIdentity = processIdentity && isValidProcessIdentity(processIdentity) && processIdentity.platform === platform
    ? processIdentity
    : undefined;
  const legacyStartTicks = identity && 'startTicks' in identity
    ? identity.startTicks
    : publishIdentity?.platform === 'linux' && Number.isSafeInteger(Number(publishIdentity.birth))
      ? Number(publishIdentity.birth)
      : undefined;
  const legacyLinuxIdentity = publishIdentity?.platform === 'linux' && publishIdentity.birth === String(legacyStartTicks)
    ? readLinuxProcessIdentity(pid)
    : null;
  const legacyCmdline = identity && 'cmdline' in identity ? identity.cmdline : legacyLinuxIdentity?.cmdline;
  return {
    session_id: sessionId,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    ...(previousNativeSessionId ? { previous_native_session_id: previousNativeSessionId } : {}),
    ...(nativeSessionSwitchedAt ? { native_session_switched_at: nativeSessionSwitchedAt } : {}),
    ...(ownerOmxSessionId ? { owner_omx_session_id: ownerOmxSessionId } : {}),
    started_at: options.startedAt ?? nowIso,
    ...(isValidToken(options.launchLineageToken) ? { launch_lineage_token: options.launchLineageToken } : {}),
    cwd,
    state_root: stateRoot,
    pid,
    platform,
    ...(publishIdentity ? { identity_schema_version: 2 as const, process_identity: publishIdentity } : {}),
    ...(legacyStartTicks !== undefined ? { pid_start_ticks: legacyStartTicks } : {}),
    ...(legacyCmdline ? { pid_cmdline: legacyCmdline } : {}),
    ...(tmuxSessionName ? { tmux_session_name: tmuxSessionName } : {}),
    ...(tmuxPaneId ? { tmux_pane_id: tmuxPaneId } : {}),
  };
}

function preserveExistingLaunchLineageToken(existing: SessionState | undefined, state: SessionState): SessionState {
  return existing && Object.hasOwn(existing, 'launch_lineage_token')
    ? { ...state, launch_lineage_token: existing.launch_lineage_token }
    : state;
}

function normalizeNonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolvePid(options: SessionStartOptions): number {
  return Number.isInteger(options.pid) && options.pid && options.pid > 0 ? options.pid : process.pid;
}

function sessionIdentityFor(pid: number, platform: NodeJS.Platform): ProcessIdentity | null {
  try {
    const observation = transactionDependencies.observeProcess(pid, platform);
    return observation.kind === 'identity' && isValidProcessIdentity(observation.identity) && observation.identity.platform === platform
      ? observation.identity
      : null;
  } catch {
    return null;
  }
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


interface SessionPointerLockOwnerV1 {
  version: 1;
  token: string;
  pid: number;
  platform: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline_hash?: string;
  created_at: string;
}

interface SessionPointerLockOwnerV2 {
  version: 2;
  token: string;
  pid: number;
  platform: NodeJS.Platform;
  process_identity: ProcessIdentity;
  pid_start_ticks?: number;
  pid_cmdline_hash?: string;
  created_at: string;
}

type SessionPointerLockOwner = SessionPointerLockOwnerV1 | SessionPointerLockOwnerV2;
type LockOwnerStatus = 'live' | 'dead' | 'reused' | 'identity-indeterminate' | 'missing' | 'malformed';

function parseLockOwner(raw: string): SessionPointerLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (!isValidToken(value.token) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    if (!isNodePlatform(value.platform) || typeof value.created_at !== 'string' || !value.created_at) return null;

    if (value.version === 1) {
      if (value.pid_start_ticks !== undefined && !isValidStartTicks(value.pid_start_ticks)) return null;
      if (value.pid_cmdline_hash !== undefined
        && (typeof value.pid_cmdline_hash !== 'string' || !SHA256_PATTERN.test(value.pid_cmdline_hash))) {
        return null;
      }
      return value as unknown as SessionPointerLockOwnerV1;
    }
    if (value.version === 2) {
      const processIdentity = value.process_identity;
      if (!isValidProcessIdentity(processIdentity) || processIdentity.platform !== value.platform) return null;
      if (value.pid_start_ticks !== undefined && !isValidStartTicks(value.pid_start_ticks)) return null;
      if (value.pid_cmdline_hash !== undefined
        && (typeof value.pid_cmdline_hash !== 'string' || !SHA256_PATTERN.test(value.pid_cmdline_hash))) {
        return null;
      }
      return value as unknown as SessionPointerLockOwnerV2;
    }
    return null;
  } catch {
    return null;
  }
}

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_POINTER_TOKEN_PATTERN.test(value);
}

function recordedIdentityForLockOwner(owner: SessionPointerLockOwner): ProcessIdentity | null {
  if (owner.version === 2) return owner.process_identity;
  if (owner.platform !== 'linux' || !isValidStartTicks(owner.pid_start_ticks)) return null;
  return {
    platform: 'linux',
    birth: String(owner.pid_start_ticks),
    ...(owner.pid_cmdline_hash ? { cmdline_hash: owner.pid_cmdline_hash } : {}),
  };
}

async function inspectLockOwnerFile(ownerPath: string, missingStatus: LockOwnerStatus = 'missing'): Promise<{
  status: LockOwnerStatus;
  owner?: SessionPointerLockOwner;
}> {
  let raw: string;
  try {
    raw = await transactionDependencies.fs.readFile(ownerPath, 'utf8');
  } catch (error) {
    return isNotFound(error) ? { status: missingStatus } : { status: 'identity-indeterminate' };
  }

  const owner = parseLockOwner(raw);
  if (!owner) return { status: 'malformed' };

  const recorded = recordedIdentityForLockOwner(owner);
  if (!recorded) {
    let probe: PidProbeResult;
    try {
      probe = transactionDependencies.probePid(owner.pid);
    } catch {
      return { status: 'identity-indeterminate', owner };
    }
    if (probe === 'dead') return { status: 'dead', owner };
    // Same read-vs-authority split as the pointer path: where the platform records no process-birth
    // evidence, an alive pid is the strongest signal available and the lock is occupied. Reaping
    // still requires a positively 'dead' owner (safeToRecover === 'dead'), so nothing becomes
    // reclaimable here; only "is this lock held" answers correctly.
    if (probe === 'alive' && isUnobservableLivePointerState(owner)) return { status: 'live', owner };
    return { status: 'identity-indeterminate', owner };
  }

  const classification = classifyRecordedIdentity(
    recorded,
    transactionDependencies.runtimePlatform,
    transactionDependencies,
    owner.pid,
  );
  switch (classification.status) {
    case 'match': return { status: 'live', owner };
    case 'gone': return { status: 'dead', owner };
    case 'birth-mismatch': return { status: 'reused', owner };
    case 'identity-unavailable': return { status: 'identity-indeterminate', owner };
  }
}

async function inspectLockOwner(lockPath: string): Promise<{
  status: LockOwnerStatus;
  owner?: SessionPointerLockOwner;
}> {
  return await inspectLockOwnerFile(join(lockPath, 'owner.json'));
}

async function inspectSessionPointerLockAtContext(context: SessionPointerContext): Promise<SessionPointerLockInspection> {
  const absent = (): SessionPointerLockInspection => ({ status: 'absent', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false });
  let lockStat: Awaited<ReturnType<SessionPointerFsDependencies['lstat']>>;
  try {
    lockStat = await transactionDependencies.fs.lstat(context.lockPath);
  } catch (error) {
    return isNotFound(error) ? absent() : { status: 'io-error', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false };
  }
  if (lockStat.isSymbolicLink()) return { status: 'symlink', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false };
  if (!lockStat.isDirectory()) return { status: 'unexpected', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false };

  let entries: string[];
  try {
    entries = await transactionDependencies.fs.readdir(context.lockPath);
  } catch {
    return { status: 'io-error', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false };
  }
  const tempEntries = entries.filter((entry) => /^owner\.([A-Za-z0-9_-]{16,128})\.tmp$/.test(entry));
  const hasCanonical = entries.includes('owner.json');
  if (entries.length === 0) return { status: 'missing-owner', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false };
  if ((hasCanonical && entries.length !== 1) || (!hasCanonical && tempEntries.length !== 1) || entries.length !== 1) {
    return { status: entries.length > 1 && (hasCanonical || tempEntries.length > 0) ? 'ambiguous' : 'unexpected', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false };
  }

  const evidenceName = hasCanonical ? 'owner.json' : tempEntries[0];
  const evidenceSource = hasCanonical ? 'owner.json' as const : 'owner-temp' as const;
  const evidencePath = join(context.lockPath, evidenceName);
  let evidenceStat: Awaited<ReturnType<SessionPointerFsDependencies['lstat']>>;
  try {
    evidenceStat = await transactionDependencies.fs.lstat(evidencePath);
  } catch {
    return { status: 'io-error', lockPath: context.lockPath, evidenceSource, safeToRecover: false };
  }
  if (evidenceStat.isSymbolicLink()) return { status: 'symlink', lockPath: context.lockPath, evidenceSource, safeToRecover: false };
  if (!evidenceStat.isFile()) return { status: 'unexpected', lockPath: context.lockPath, evidenceSource, safeToRecover: false };

  const owner = await inspectLockOwnerFile(evidencePath, 'missing');
  if (evidenceSource === 'owner-temp' && owner.owner?.token !== /^owner\.([A-Za-z0-9_-]{16,128})\.tmp$/.exec(evidenceName)?.[1]) {
    return { status: 'malformed', lockPath: context.lockPath, evidenceSource, safeToRecover: false };
  }
  const status = owner.status === 'missing' ? 'io-error' : owner.status;
  return {
    status,
    lockPath: context.lockPath,
    evidenceSource,
    // Recoverable only on positively dead evidence (ESRCH), for canonical
    // owner.json and pre-rename temp evidence alike; the atomic
    // claim/quarantine protocol revalidates the exact entry, still-dead
    // status, and owner token before quarantining. Live, reused,
    // identity-indeterminate, ambiguous, symlink, malformed, unexpected,
    // and io-error states stay fail-closed.
    safeToRecover: status === 'dead',
  };
}

/** Inspect only exact, regular owner evidence in the selected pointer lock. */
export async function inspectSessionPointerLock(cwd: string): Promise<SessionPointerLockInspection> {
  return await inspectSessionPointerLockAtContext(resolveSessionPointerContext(cwd));
}

interface RecoveryIdentity { dev: number; ino: number }
interface RecoveryCheckpoint {
  version: number;
  sourcePath: string;
  identity: RecoveryIdentity;
  evidenceIdentity?: RecoveryIdentity;
  evidenceBytes?: string;
  lockIdentity?: RecoveryIdentity;
  lockParkPath?: string;
  phase: string;
}

function sameRecoveryIdentity(stat: Awaited<ReturnType<SessionPointerFsDependencies['lstat']>>, identity: RecoveryIdentity, kind: 'file' | 'directory'): boolean {
  return !stat.isSymbolicLink() && (kind === 'file' ? stat.isFile() : stat.isDirectory()) && stat.dev === identity.dev && stat.ino === identity.ino;
}

async function lstatRecoveryPath(path: string): Promise<Awaited<ReturnType<SessionPointerFsDependencies['lstat']>> | undefined> {
  try { return await transactionDependencies.fs.lstat(path); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

/**
 * Portable no-clobber move for recovery quarantine: hard-link the captured
 * object to its token-bound destination, then unlink the source. `link()`
 * fails with EEXIST when the destination exists, giving the same no-clobber
 * guarantee as renameat2(RENAME_NOREPLACE)/renamex_np(RENAME_EXCL) without
 * needing the native runtime. Identity checks before and after bound the
 * non-atomic window; callers verify the captured object landed intact.
 */
async function moveRecoveryPathPortableNoReplace(
  from: string,
  to: string,
  identity: RecoveryIdentity,
  kind: 'file' | 'directory',
): Promise<{ moved: boolean; reason?: string }> {
  if (kind !== 'file') {
    return { moved: false, reason: 'Portable no-clobber recovery move supports regular files only.' };
  }
  try {
    await transactionDependencies.fs.link(from, to);
  } catch (error) {
    if (isAlreadyExists(error)) return { moved: false, reason: 'The selected pointer quarantine destination already exists.' };
    return { moved: false, reason: `Portable no-clobber recovery move failed (${errorCode(error) ?? 'unknown'}).` };
  }
  const destination = await lstatRecoveryPath(to);
  if (!destination || !sameRecoveryIdentity(destination, identity, kind)) {
    try { await transactionDependencies.fs.unlink(to); } catch { /* durable residue is safer than cleanup */ }
    return { moved: false, reason: 'Portable no-clobber recovery move did not leave the captured object at its token-bound destination.' };
  }
  try {
    await transactionDependencies.fs.unlink(from);
  } catch (error) {
    if (!isNotFound(error)) {
      // The captured bytes are safely linked at quarantine; the stale source
      // pathname remains and needs explicit recovery, same as an ambiguous move.
      return { moved: false, reason: `Portable no-clobber recovery move linked quarantine but could not release the source pathname (${errorCode(error) ?? 'unknown'}).` };
    }
  }
  const source = await lstatRecoveryPath(from);
  const finalDestination = await lstatRecoveryPath(to);
  if (finalDestination && sameRecoveryIdentity(finalDestination, identity, kind) && !source) return { moved: true };
  return { moved: false, reason: 'Portable no-clobber recovery move did not leave the captured object at its token-bound destination.' };
}

async function moveRecoveryPathNoReplace(
  from: string,
  to: string,
  identity: RecoveryIdentity,
  kind: 'file' | 'directory',
  onAtomicMove?: () => void,
): Promise<{ moved: boolean; reason?: string }> {
  try {
    const outcome = await transactionDependencies.atomicRenameNoReplace(from, to);
    if (outcome === 'unsupported') {
      // Native no-replace rename unavailable (e.g. unhydrated omx-runtime on
      // macOS arm64, issue #3636): fall back to link()+unlink(), which gives the
      // same no-clobber guarantee for regular files without the native runtime.
      const portable = await moveRecoveryPathPortableNoReplace(from, to, identity, kind);
      if (portable.moved) onAtomicMove?.();
      return portable;
    }
    if (outcome === 'not-moved') return { moved: false, reason: 'Atomic recovery move left its source pathname in place.' };
    onAtomicMove?.();
  } catch (error) {
    return { moved: false, reason: `Atomic no-replace recovery rename failed (${errorCode(error) ?? 'unknown'}).` };
  }
  const destination = await lstatRecoveryPath(to);
  const source = await lstatRecoveryPath(from);
  if (destination && sameRecoveryIdentity(destination, identity, kind) && !source) return { moved: true };
  // A successor may have appeared at the canonical pathname after our move.
  // Attempt a no-replace rollback only for the captured object; an occupied or
  // foreign destination makes the rollback fail closed and leaves both residues.
  if (destination && sameRecoveryIdentity(destination, identity, kind)) {
    try { await transactionDependencies.atomicRenameNoReplace(to, from); } catch { /* durable residue is safer than cleanup */ }
  }
  return { moved: false, reason: 'Atomic recovery move did not leave the captured object at its token-bound destination.' };
}

async function completeRecoveryCheckpoint(
  checkpointPath: string,
  checkpointBytes: string,
  checkpointIdentity: RecoveryIdentity,
): Promise<{ completed: boolean; reason?: string }> {
  const completedPath = checkpointPath.replace(/\.json$/, '.completed');
  const current = await lstatRecoveryPath(checkpointPath);
  if (!current || !sameRecoveryIdentity(current, checkpointIdentity, 'file') || await transactionDependencies.fs.readFile(checkpointPath, 'utf8') !== checkpointBytes) {
    return { completed: false, reason: 'Recovery checkpoint was replaced before completion; it was preserved as residue.' };
  }
  const moved = await moveRecoveryPathNoReplace(checkpointPath, completedPath, checkpointIdentity, 'file');
  if (!moved.moved) return { completed: false, reason: moved.reason };
  const completedBytes = await transactionDependencies.fs.readFile(completedPath, 'utf8');
  return completedBytes === checkpointBytes ? { completed: true } : { completed: false, reason: 'Completed recovery receipt bytes changed and were preserved as residue.' };
}

async function resumeRecoveryCheckpoint(
  context: SessionPointerContext,
  checkpointPath: string,
  checkpointName: string,
): Promise<SessionPointerLockRecovery> {
  const match = new RegExp(`^${basename(context.lockPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.recovery\\.([A-Za-z0-9_-]{16,128})\\.([A-Za-z0-9_-]{16,128})\\.json$`).exec(checkpointName);
  try {
    const checkpointBytes = await transactionDependencies.fs.readFile(checkpointPath, 'utf8');
    const checkpointStat = await transactionDependencies.fs.lstat(checkpointPath);
    const checkpoint = JSON.parse(checkpointBytes) as RecoveryCheckpoint;
    const ownerToken = match?.[1];
    const recoveryToken = match?.[2];
    const expectedSource = ownerToken && (checkpoint.sourcePath === join(context.lockPath, 'owner.json') || checkpoint.sourcePath === join(context.lockPath, `owner.${ownerToken}.tmp`));
    const expectedPark = `${context.lockPath}.parked-lock-${recoveryToken}`;
    const isLegacyV1 = checkpoint.version === 1 && checkpoint.lockIdentity === undefined && checkpoint.lockParkPath === undefined;
    if (!match || !expectedSource || !checkpoint.identity || !['evidence-pending', 'evidence-quarantined', 'directory-pending'].includes(checkpoint.phase) || ![1, 2, 3].includes(checkpoint.version) || !isLegacyV1 && checkpoint.lockParkPath !== expectedPark || !sameRecoveryIdentity(checkpointStat, { dev: checkpointStat.dev, ino: checkpointStat.ino }, 'file')) throw new Error('invalid checkpoint');
    const lockParkPath = checkpoint.lockParkPath ?? expectedPark;
    const evidenceIdentity = checkpoint.evidenceIdentity ?? checkpoint.identity;
    const claimPath = join(context.lockPath, `owner.${ownerToken}.${recoveryToken}.recovery`);
    const lock = await lstatRecoveryPath(context.lockPath);
    const parkedLock = await lstatRecoveryPath(lockParkPath);
    if (lock && parkedLock) throw new Error('checkpoint lock paths are both present');
    if (parkedLock) {
      if (!checkpoint.lockIdentity || !sameRecoveryIdentity(parkedLock, checkpoint.lockIdentity, 'directory')) throw new Error('checkpoint parked lock identity mismatch');
      const quarantinePath = `${context.lockPath}.quarantine.${ownerToken}.${recoveryToken}`;
      const completed = await completeRecoveryCheckpoint(checkpointPath, checkpointBytes, { dev: checkpointStat.dev, ino: checkpointStat.ino });
      if (!completed.completed) throw new Error(completed.reason);
      return { status: 'dead', lockPath: context.lockPath, evidenceSource: 'owner.json', safeToRecover: true, action: 'quarantined', recovered: true, reason: 'Dead session pointer lock recovery checkpoint resumed.', quarantinePath };
    }
    if (!lock || lock.isSymbolicLink() || !lock.isDirectory()) throw new Error('checkpoint lock is missing or foreign');
    const source = await lstatRecoveryPath(checkpoint.sourcePath);
    const claim = await lstatRecoveryPath(claimPath);
    const evidencePath = source && sameRecoveryIdentity(source, evidenceIdentity, 'file') ? checkpoint.sourcePath
      : claim && sameRecoveryIdentity(claim, evidenceIdentity, 'file') ? claimPath : undefined;
    if (!evidencePath) throw new Error('checkpoint evidence is missing or foreign');
    if (claim && !sameRecoveryIdentity(claim, evidenceIdentity, 'file')) throw new Error('checkpoint claim is foreign');
    // v1/v2 did not persist the directory identity. It is safe to derive only
    // while the original directory still contains the exact recorded evidence.
    const lockIdentity = checkpoint.lockIdentity ?? { dev: lock.dev, ino: lock.ino };
    if (!sameRecoveryIdentity(lock, lockIdentity, 'directory')) throw new Error('checkpoint lock identity mismatch');
    const ownerBytes = await transactionDependencies.fs.readFile(evidencePath, 'utf8');
    const owner = await inspectLockOwnerFile(evidencePath);
    if (owner.status !== 'dead' || owner.owner?.token !== ownerToken || checkpoint.evidenceBytes !== undefined && checkpoint.evidenceBytes !== ownerBytes) throw new Error('checkpoint owner evidence changed');
    const quarantinePath = `${context.lockPath}.quarantine.${ownerToken}.${recoveryToken}`;
    const quarantine = await lstatRecoveryPath(quarantinePath);
    if (quarantine) {
      if (!sameRecoveryIdentity(quarantine, evidenceIdentity, 'file')) throw new Error('checkpoint quarantine is foreign');
    } else {
      await transactionDependencies.fs.link(evidencePath, quarantinePath);
      const linked = await lstatRecoveryPath(quarantinePath);
      if (!linked || !sameRecoveryIdentity(linked, evidenceIdentity, 'file')) throw new Error('checkpoint quarantine link mismatch');
    }
    // Revalidate the bytes, dead owner and identities immediately before moving
    // the entire directory incarnation out of the canonical lock pathname.
    const currentLock = await lstatRecoveryPath(context.lockPath);
    const currentEvidence = await lstatRecoveryPath(evidencePath);
    const currentBytes = currentEvidence && sameRecoveryIdentity(currentEvidence, evidenceIdentity, 'file') ? await transactionDependencies.fs.readFile(evidencePath, 'utf8') : undefined;
    const currentOwner = currentBytes === undefined ? undefined : await inspectLockOwnerFile(evidencePath);
    if (!currentLock || !sameRecoveryIdentity(currentLock, lockIdentity, 'directory') || currentBytes !== ownerBytes || currentOwner?.status !== 'dead' || currentOwner.owner?.token !== ownerToken) throw new Error('checkpoint owner evidence changed before directory quarantine');
    const lockEntries = await transactionDependencies.fs.readdir(context.lockPath);
    const allowedEntries = new Set([basename(checkpoint.sourcePath), basename(claimPath)]);
    if (lockEntries.some((entry) => !allowedEntries.has(entry))) throw new Error('checkpoint lock contains foreign recovery evidence');
    const moved = await moveRecoveryPathNoReplace(context.lockPath, lockParkPath, lockIdentity, 'directory');
    if (!moved.moved) throw new Error(moved.reason);
    const completed = await completeRecoveryCheckpoint(checkpointPath, checkpointBytes, { dev: checkpointStat.dev, ino: checkpointStat.ino });
    if (!completed.completed) throw new Error(completed.reason);
    return { status: 'dead', lockPath: context.lockPath, evidenceSource: 'owner.json', safeToRecover: true, action: 'quarantined', recovered: true, reason: 'Dead session pointer lock recovered into durable quarantine residues.', quarantinePath };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown';
    return { status: 'unexpected', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false, action: 'none', recovered: false, reason: `Recovery checkpoint is malformed or no longer identifies its recorded recovery state (${detail}).` };
  }
}

/** Explicitly quarantine only a dead lock by moving its entire directory incarnation. */
export async function recoverSessionPointerLock(cwd: string): Promise<SessionPointerLockRecovery> {
  const context = resolveSessionPointerContext(cwd);
  const checkpointPrefix = `${basename(context.lockPath)}.recovery.`;
  let checkpointNames: string[];
  try {
    checkpointNames = (await transactionDependencies.fs.readdir(dirname(context.lockPath))).filter((name) => name.startsWith(checkpointPrefix) && name.endsWith('.json'));
  } catch (error) {
    if (!isNotFound(error)) return { status: 'io-error', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false, action: 'none', recovered: false, reason: 'Unable to enumerate session pointer recovery checkpoints.' };
    checkpointNames = [];
  }
  if (checkpointNames.length > 1) return { status: 'unexpected', lockPath: context.lockPath, evidenceSource: 'none', safeToRecover: false, action: 'none', recovered: false, reason: 'Multiple recovery checkpoints exist.' };
  if (checkpointNames.length === 1) return await resumeRecoveryCheckpoint(context, join(dirname(context.lockPath), checkpointNames[0]!), checkpointNames[0]!);

  const inspection = await inspectSessionPointerLockAtContext(context);
  if (!inspection.safeToRecover) return { ...inspection, action: 'none', recovered: false, reason: inspection.status === 'absent' ? 'No session pointer lock exists.' : `Session pointer lock is not safe to recover (${inspection.status}).` };
  try {
    const evidenceName = inspection.evidenceSource === 'owner.json'
      ? 'owner.json'
      : (await transactionDependencies.fs.readdir(context.lockPath)).find((entry) => /^owner\.([A-Za-z0-9_-]{16,128})\.tmp$/.test(entry));
    if (!evidenceName) return { ...inspection, action: 'none', recovered: false, reason: 'Session pointer lock evidence changed before recovery claim.' };
    const evidencePath = join(context.lockPath, evidenceName);
    const evidence = await lstatRecoveryPath(evidencePath);
    const lock = await lstatRecoveryPath(context.lockPath);
    const ownerBytes = evidence && sameRecoveryIdentity(evidence, { dev: evidence.dev, ino: evidence.ino }, 'file')
      ? await transactionDependencies.fs.readFile(evidencePath, 'utf8')
      : undefined;
    const owner = ownerBytes === undefined ? undefined : await inspectLockOwnerFile(evidencePath);
    if (!lock || lock.isSymbolicLink() || !lock.isDirectory() || !evidence
      || !sameRecoveryIdentity(evidence, { dev: evidence.dev, ino: evidence.ino }, 'file')
      || owner?.status !== 'dead' || !owner.owner) {
      return { ...inspection, action: 'none', recovered: false, reason: 'Session pointer lock evidence changed before recovery claim.' };
    }

    // Existing checkpoints are resumed independently and may remain as durable
    // recovery residue. The no-replace move helper falls back to a portable
    // link()+unlink() quarantine for regular files when the native atomic
    // rename is unavailable — but a lock directory incarnation cannot use that
    // file fallback. Probe the native capability with temp files inside the
    // lock directory before writing any checkpoint so an unsupported host
    // leaves no residue at all. Probe paths sort outside the allowed recovery
    // entries, so resume treats a crashed probe as foreign evidence fail-closed.
    const probeFrom = join(context.lockPath, '.omx-recovery-probe-from');
    const probeTo = join(context.lockPath, '.omx-recovery-probe-to');
    let directoryCapability: RecoveryRenameNoReplaceResult;
    try {
      try {
        await transactionDependencies.fs.writeFile(probeFrom, 'omx-recovery-capability-probe', { flag: 'wx' });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      directoryCapability = await transactionDependencies.atomicRenameNoReplace(probeFrom, probeTo);
    } catch {
      directoryCapability = 'unsupported';
    } finally {
      try { await transactionDependencies.fs.unlink(probeFrom); } catch { /* best effort */ }
      try { await transactionDependencies.fs.unlink(probeTo); } catch { /* best effort */ }
    }
    if (directoryCapability === 'unsupported') {
      return {
        ...inspection,
        action: 'none',
        recovered: false,
        reason: 'Atomic no-replace lock directory quarantine is unsupported on this platform; portable recovery applies to regular files only.',
      };
    }

    const recoveryToken = transactionDependencies.token();
    if (!isValidToken(recoveryToken)) return { ...inspection, action: 'none', recovered: false, reason: 'Recovery claim token is invalid.' };
    const checkpointPath = `${context.lockPath}.recovery.${owner.owner.token}.${recoveryToken}.json`;
    const checkpoint: RecoveryCheckpoint = {
      version: 3,
      sourcePath: evidencePath,
      identity: { dev: evidence.dev, ino: evidence.ino },
      evidenceIdentity: { dev: evidence.dev, ino: evidence.ino },
      evidenceBytes: ownerBytes,
      lockIdentity: { dev: lock.dev, ino: lock.ino },
      lockParkPath: `${context.lockPath}.parked-lock-${recoveryToken}`,
      phase: 'evidence-pending',
    };
    try {
      await transactionDependencies.fs.writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx' });
    } catch (error) {
      return { ...inspection, action: 'none', recovered: false, reason: `Unable to create recovery checkpoint (${errorCode(error) ?? 'unknown'}).` };
    }
    return await resumeRecoveryCheckpoint(context, checkpointPath, basename(checkpointPath));
  } catch (error) {
    return {
      ...inspection,
      status: 'io-error',
      safeToRecover: false,
      action: 'none',
      recovered: false,
      reason: `Unable to inspect session pointer lock recovery state (${errorCode(error) ?? errorMessage(error)}).`,
    };
  }
}

function selectedRootAuthorityFailure(
  context: SessionPointerContext,
  state: SessionState,
): 'foreign-cwd' | 'foreign-root' | undefined {
  let recordedCwd: string;
  let observedCwd: string;
  try {
    if (typeof state.cwd !== 'string' || !state.cwd.trim()) return 'foreign-cwd';
    recordedCwd = realpathSync(resolve(state.cwd));
    observedCwd = realpathSync(resolve(context.cwd));
    const cwdRelative = relative(recordedCwd, observedCwd);
    if (cwdRelative === '..' || cwdRelative.startsWith(`..${sep}`) || isAbsolute(cwdRelative)) return 'foreign-cwd';
  } catch {
    return 'foreign-cwd';
  }
  try {
    const recordedRoot = typeof state.state_root === 'string' && state.state_root.trim()
      ? state.state_root
      : join(recordedCwd, '.omx', 'state');
    return sameFilePath(recordedRoot, context.baseStateDir) ? undefined : 'foreign-root';
  } catch {
    return 'foreign-root';
  }
}

function classifyParsedSessionPointerForRecovery(value: unknown, raw: string): SessionPointerReadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'malformed', raw };
  const state = value as SessionState;
  if (!normalizeSessionId(state.session_id)) return { status: 'malformed', raw };
  if (state.identity_schema_version !== undefined && state.identity_schema_version !== 2) {
    return { status: 'identity-indeterminate', raw, state };
  }
  if (state.process_identity !== undefined
    && (state.identity_schema_version !== 2
      || !isValidProcessIdentity(state.process_identity)
      || state.platform !== undefined && state.platform !== state.process_identity.platform)) {
    return { status: 'malformed', raw, state };
  }
  if (state.identity_schema_version === 2 && state.process_identity === undefined) return { status: 'malformed', raw, state };
  return { status: classifySessionProcess(state, transactionDependencies), raw, state };
}

type SessionPointerRecoveryReadResult = SessionPointerReadResult & { bytes?: Buffer };

async function readSessionPointerForRecovery(context: SessionPointerContext): Promise<SessionPointerRecoveryReadResult> {
  let sourceStat: Awaited<ReturnType<SessionPointerFsDependencies['lstat']>>;
  try {
    sourceStat = await transactionDependencies.fs.lstat(context.sessionPath);
  } catch (error) {
    if (isNotFound(error)) return { status: 'absent' };
    throw error;
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) return { status: 'malformed' };
  const bytes = await transactionDependencies.fs.readBytes(context.sessionPath);
  const sourceAfterRead = await transactionDependencies.fs.lstat(context.sessionPath);
  if (!sameRecoveryIdentity(sourceAfterRead, { dev: sourceStat.dev, ino: sourceStat.ino }, 'file')) {
    throw new Error('Selected session pointer changed while its recovery snapshot was read.');
  }
  const raw = bytes.toString('utf8');
  try {
    return { ...classifyParsedSessionPointerForRecovery(JSON.parse(raw), raw), bytes };
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'malformed', raw, bytes };
    throw error;
  }
}

function malformedRecoveryPointerReason(state: SessionState): string | undefined {
  if (!normalizeSessionId(state.session_id)) return 'session_id is missing or invalid';
  if (typeof state.started_at !== 'string' || !state.started_at.trim() || !Number.isFinite(Date.parse(state.started_at))) {
    return 'started_at is missing or invalid';
  }
  if (typeof state.cwd !== 'string' || !state.cwd.trim()) return 'cwd is missing or invalid';
  if (!Number.isInteger(state.pid) || state.pid <= 0) return 'pid is missing or invalid';
  if (Object.prototype.hasOwnProperty.call(state, 'state_root')
    && (typeof state.state_root !== 'string' || !state.state_root.trim())) return 'state_root is invalid';
  if (state.platform !== undefined && !['linux', 'darwin', 'win32'].includes(state.platform)) return 'platform is invalid';
  if (state.pid_start_ticks !== undefined && !isValidStartTicks(state.pid_start_ticks)) return 'pid_start_ticks is invalid';
  if (state.pid_cmdline !== undefined && typeof state.pid_cmdline !== 'string') return 'pid_cmdline is invalid';
  const optionalStrings: Array<keyof SessionState> = [
    'native_session_id',
    'previous_native_session_id',
    'native_session_switched_at',
    'owner_omx_session_id',
    'owner_codex_session_id',
    'codex_session_id',
    'tmux_session_name',
    'tmux_pane_id',
  ];
  for (const field of optionalStrings) {
    const value = state[field];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) return `${field} is invalid`;
  }
  if (state.launch_lineage_token !== undefined && !isValidToken(state.launch_lineage_token)) {
    return 'launch_lineage_token is invalid';
  }
  if (recordedIdentityForState(state, transactionDependencies.runtimePlatform) === 'invalid') return 'process identity metadata is invalid';
  return undefined;
}

function classifySessionProcessForRecovery(state: SessionState): 'usable' | 'dead' | 'reused' | 'identity-indeterminate' {
  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  const hasIdentityMetadata = typeof state.pid_start_ticks === 'number'
    || typeof state.pid_cmdline === 'string'
    || state.identity_schema_version !== undefined
    || state.process_identity !== undefined;
  if (!hasPidMetadata && !hasIdentityMetadata) return 'usable';
  if (!hasPidMetadata) return 'identity-indeterminate';
  const recordedPlatform = state.process_identity?.platform ?? state.platform;
  if (recordedPlatform !== undefined && recordedPlatform !== transactionDependencies.runtimePlatform) {
    return 'identity-indeterminate';
  }
  const recorded = recordedIdentityForState(state, transactionDependencies.runtimePlatform);
  if (recorded === 'invalid') return 'identity-indeterminate';
  if (!recorded) {
    let probe: PidProbeResult;
    try { probe = transactionDependencies.probePid(state.pid); } catch { return 'identity-indeterminate'; }
    return probe === 'dead' ? 'dead' : 'identity-indeterminate';
  }
  const classification = classifyRecordedIdentity(recorded, transactionDependencies.runtimePlatform, transactionDependencies, state.pid);
  if (classification.status === 'gone') return 'dead';
  if (classification.status === 'birth-mismatch') return 'reused';
  if (classification.status === 'match') return 'usable';
  return 'identity-indeterminate';
}

function pointerRecoveryRefusal(
  context: SessionPointerContext,
  status: SessionPointerRecoveryStatus,
  reason: string,
  sessionId?: string,
): SessionPointerRecovery {
  return {
    status,
    pointerPath: context.sessionPath,
    action: 'none',
    recovered: false,
    reason,
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * Explicitly quarantine one authoritative, positively dead selected pointer.
 * The canonical pointer lock serializes the final classification and move with
 * SessionStart/SessionEnd, while the no-replace archive preserves exact bytes.
 */
export async function recoverDeadSessionPointer(cwd: string): Promise<SessionPointerRecovery> {
  const context = resolveSessionPointerContext(cwd);
  try {
    if ((await readSessionPointerForRecovery(context)).status === 'absent') {
      return pointerRecoveryRefusal(context, 'absent', 'No selected session pointer exists.');
    }
  } catch (error) {
    return pointerRecoveryRefusal(context, 'io-error', `Unable to read the selected session pointer (${errorCode(error) ?? errorMessage(error)}).`);
  }
  const tracker: RegularFileDurabilityTracker = { degraded: false };
  let lock: HeldPointerLock;
  try {
    lock = await acquirePointerLock(context, undefined, DEFAULT_POINTER_TIMEOUT_MS, process.platform, tracker);
  } catch (error) {
    const reason = isSessionPointerLaunchAbort(error) ? error.reason : errorMessage(error);
    return pointerRecoveryRefusal(context, 'lock-unavailable', `Unable to acquire the selected pointer transaction lock (${reason}).`);
  }

  let result: SessionPointerRecovery | undefined;
  try {
    let pointer: SessionPointerRecoveryReadResult;
    try {
      pointer = await readSessionPointerForRecovery(context);
    } catch (error) {
      result = pointerRecoveryRefusal(context, 'io-error', `Unable to read the selected session pointer (${errorCode(error) ?? errorMessage(error)}).`);
      return result;
    }

    if (pointer.status === 'absent') {
      result = pointerRecoveryRefusal(context, 'absent', 'No selected session pointer exists.');
      return result;
    }
    const sessionId = normalizeSessionId(pointer.state?.session_id);
    if (pointer.status !== 'stale-dead' || !pointer.state || !pointer.raw || !pointer.bytes || !sessionId) {
      const reason = pointer.status === 'usable'
        ? 'The selected session pointer owner is usable or live.'
        : pointer.status === 'identity-indeterminate'
          ? 'The selected session pointer owner identity is indeterminate.'
          : pointer.status === 'foreign-cwd'
            ? 'The selected session pointer belongs to a different working directory.'
            : 'The selected session pointer is malformed.';
      const status: SessionPointerRecoveryStatus = pointer.status === 'stale-dead' ? 'malformed' : pointer.status;
      result = pointerRecoveryRefusal(context, status, reason, sessionId);
      return result;
    }
    const malformedReason = malformedRecoveryPointerReason(pointer.state);
    if (malformedReason) {
      result = pointerRecoveryRefusal(context, 'malformed', `The selected session pointer is malformed (${malformedReason}).`, sessionId);
      return result;
    }
    const authorityFailure = selectedRootAuthorityFailure(context, pointer.state);
    if (authorityFailure) {
      const reason = authorityFailure === 'foreign-cwd'
        ? 'The selected session pointer belongs to a different working-directory lineage.'
        : 'The selected session pointer does not have exact state_root authority for the selected root.';
      result = pointerRecoveryRefusal(context, authorityFailure, reason, sessionId);
      return result;
    }
    const recoveryLiveness = classifySessionProcessForRecovery(pointer.state);
    if (recoveryLiveness !== 'dead') {
      const status: SessionPointerRecoveryStatus = recoveryLiveness === 'reused' ? 'reused' : recoveryLiveness;
      const reason = recoveryLiveness === 'reused'
        ? 'The selected session pointer PID was reused or its recorded birth identity mismatched.'
        : recoveryLiveness === 'usable'
          ? 'The selected session pointer owner is usable or live.'
          : 'The selected session pointer owner identity is indeterminate.';
      result = pointerRecoveryRefusal(context, status, reason, sessionId);
      return result;
    }

    let sourceStat: Awaited<ReturnType<SessionPointerFsDependencies['lstat']>>;
    try {
      sourceStat = await transactionDependencies.fs.lstat(context.sessionPath);
    } catch (error) {
      result = pointerRecoveryRefusal(context, 'io-error', `Unable to inspect the selected session pointer (${errorCode(error) ?? errorMessage(error)}).`, sessionId);
      return result;
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      result = pointerRecoveryRefusal(context, 'malformed', 'The selected session pointer is not a regular file.', sessionId);
      return result;
    }

    const recoveryToken = transactionDependencies.token();
    if (!isValidToken(recoveryToken)) {
      result = pointerRecoveryRefusal(context, 'io-error', 'Unable to create a valid selected pointer quarantine token.', sessionId);
      return result;
    }
    const quarantinePath = `${context.sessionPath}.quarantine.${sessionId}.${recoveryToken}`;
    let quarantineMoveCommitted = false;
    try {
      const collision = await lstatRecoveryPath(quarantinePath);
      if (collision) {
        result = pointerRecoveryRefusal(context, 'collision', 'The selected pointer quarantine destination already exists.', sessionId);
        return result;
      }
      const currentStat = await transactionDependencies.fs.lstat(context.sessionPath);
      const currentBytes = await transactionDependencies.fs.readBytes(context.sessionPath);
      const currentAfterRead = await transactionDependencies.fs.lstat(context.sessionPath);
      const currentRaw = currentBytes.toString('utf8');
      let current: SessionPointerReadResult;
      try {
        current = classifyParsedSessionPointerForRecovery(JSON.parse(currentRaw), currentRaw);
      } catch {
        result = pointerRecoveryRefusal(context, 'race', 'The selected session pointer changed before quarantine.', sessionId);
        return result;
      }
      if (!sameRecoveryIdentity(currentStat, { dev: sourceStat.dev, ino: sourceStat.ino }, 'file')
        || !sameRecoveryIdentity(currentAfterRead, { dev: sourceStat.dev, ino: sourceStat.ino }, 'file')
        || !currentBytes.equals(pointer.bytes)
        || current.status !== 'stale-dead'
        || !current.state
        || selectedRootAuthorityFailure(context, current.state) !== undefined
        || classifySessionProcessForRecovery(current.state) !== 'dead') {
        result = pointerRecoveryRefusal(context, 'race', 'The selected session pointer changed before quarantine.', sessionId);
        return result;
      }
      const moved = await moveRecoveryPathNoReplace(
        context.sessionPath,
        quarantinePath,
        { dev: sourceStat.dev, ino: sourceStat.ino },
        'file',
        () => { quarantineMoveCommitted = true; },
      );
      if (!moved.moved) {
        const destinationExists = await lstatRecoveryPath(quarantinePath);
        const sourceExists = await lstatRecoveryPath(context.sessionPath);
        const capturedDestination = destinationExists
          && sameRecoveryIdentity(destinationExists, { dev: sourceStat.dev, ino: sourceStat.ino }, 'file');
        if (capturedDestination) {
          result = {
            status: 'recovery-required',
            pointerPath: context.sessionPath,
            action: 'quarantined',
            recovered: false,
            reason: sourceExists
              ? 'The atomic move outcome was ambiguous; the captured selected pointer is present at quarantine and a successor occupies the canonical path, so both were preserved for explicit recovery.'
              : 'The atomic move outcome was ambiguous, but the captured selected pointer is present at quarantine; forensic residue was preserved for explicit recovery.',
            sessionId,
            quarantinePath,
          };
          return result;
        }
        const foreignDestination = destinationExists
          && !capturedDestination;
        result = pointerRecoveryRefusal(
          context,
          foreignDestination && !sourceExists ? 'race' : destinationExists ? 'collision' : 'race',
          moved.reason ?? 'The selected session pointer could not be quarantined atomically.',
          sessionId,
        );
        return result;
      }
      const archivedStat = await lstatRecoveryPath(quarantinePath);
      const sourceAfterMove = await lstatRecoveryPath(context.sessionPath);
      const archivedBytes = archivedStat && sameRecoveryIdentity(archivedStat, { dev: sourceStat.dev, ino: sourceStat.ino }, 'file')
        ? await transactionDependencies.fs.readBytes(quarantinePath)
        : undefined;
      const archivedRaw = archivedBytes?.toString('utf8');
      let archivedPointer: SessionPointerReadResult | undefined;
      if (archivedRaw !== undefined) {
        try { archivedPointer = classifyParsedSessionPointerForRecovery(JSON.parse(archivedRaw), archivedRaw); } catch { /* handled below */ }
      }
      if (sourceAfterMove
        || !archivedBytes?.equals(pointer.bytes)
        || archivedPointer?.status !== 'stale-dead'
        || !archivedPointer.state
        || selectedRootAuthorityFailure(context, archivedPointer.state) !== undefined
        || classifySessionProcessForRecovery(archivedPointer.state) !== 'dead') {
        if (!sourceAfterMove && archivedBytes?.equals(pointer.bytes) && archivedStat
          && sameRecoveryIdentity(archivedStat, { dev: sourceStat.dev, ino: sourceStat.ino }, 'file')) {
          const rollback = await moveRecoveryPathNoReplace(
            quarantinePath,
            context.sessionPath,
            { dev: sourceStat.dev, ino: sourceStat.ino },
            'file',
          );
          if (rollback.moved) {
            quarantineMoveCommitted = false;
            result = pointerRecoveryRefusal(
              context,
              'race',
              'The selected pointer became uncertain after quarantine and was restored without losing forensic bytes.',
              sessionId,
            );
            return result;
          }
        }
        result = {
          status: 'recovery-required',
          pointerPath: context.sessionPath,
          action: 'quarantined',
          recovered: false,
          reason: 'The selected pointer changed or became uncertain after quarantine; forensic residue was preserved for explicit recovery.',
          sessionId,
          quarantinePath,
        };
        return result;
      }
      result = {
        status: 'recovered',
        pointerPath: context.sessionPath,
        action: 'quarantined',
        recovered: true,
        reason: 'Verified-dead selected session pointer quarantined with exact forensic bytes preserved.',
        sessionId,
        quarantinePath,
      };
      return result;
    } catch (error) {
      if (quarantineMoveCommitted) {
        result = {
          status: 'recovery-required',
          pointerPath: context.sessionPath,
          action: 'quarantined',
          recovered: false,
          reason: `The selected pointer was quarantined, but post-move verification failed (${errorCode(error) ?? errorMessage(error)}); forensic residue was preserved for explicit recovery.`,
          sessionId,
          quarantinePath,
        };
        return result;
      }
      result = pointerRecoveryRefusal(context, 'io-error', `Unable to quarantine the selected session pointer (${errorCode(error) ?? errorMessage(error)}).`, sessionId);
      return result;
    }
  } finally {
    const failures = await releasePointerLock(lock);
    if (failures.length > 0 && result) {
      result.status = 'recovery-required';
      result.recovered = false;
      result.reason = `${result.reason} Pointer lock release requires explicit lock recovery.`;
    }
  }
}

interface HeldPointerLock {
  context: SessionPointerContext;
  token: string;
}

function buildLockOwner(token: string): SessionPointerLockOwner {
  const runtimePlatform = transactionDependencies.runtimePlatform;
  let observation: ProcessObservation | undefined;
  try {
    observation = transactionDependencies.observeProcess(process.pid, runtimePlatform);
  } catch {
    // Publication remains valid with optional identity metadata omitted.
  }
  const identity = observation?.kind === 'identity' && isValidProcessIdentity(observation.identity)
    && observation.identity.platform === runtimePlatform
    ? observation.identity
    : undefined;
  const legacyStartTicks = identity?.platform === 'linux' && Number.isSafeInteger(Number(identity.birth))
    ? Number(identity.birth)
    : undefined;
  const legacyHash = identity?.cmdline_hash && SHA256_PATTERN.test(identity.cmdline_hash)
    ? identity.cmdline_hash
    : undefined;
  const common = {
    token,
    pid: process.pid,
    platform: runtimePlatform,
    ...(legacyStartTicks !== undefined ? { pid_start_ticks: legacyStartTicks } : {}),
    ...(legacyHash ? { pid_cmdline_hash: legacyHash } : {}),
    created_at: new Date(transactionDependencies.nowMs()).toISOString(),
  };
  return identity
    ? { version: 2, ...common, process_identity: identity }
    : { version: 1, ...common };
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
  platform: NodeJS.Platform,
  tracker: RegularFileDurabilityTracker,
  regularFileSync?: SessionStartOptions['regularFileSync'],
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
    recordRegularFileSyncOutcome(tracker, await transactionDependencies.fs.openAndSync(ownerTempPath, platform, regularFileSync));
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
  let owner: SessionPointerLockOwner | null = null;
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
        phase: 'remove-release-owner',
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

/** @internal Test-only release of a held pointer lock; do not use outside session tests. */
export async function __releasePointerLockForTests(cwd: string, token: string): Promise<SessionPointerSecondaryFailure[]> {
  return await releasePointerLock({ context: resolveSessionPointerContext(cwd), token });
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

function releaseFailureError<T>(
  failures: readonly SessionPointerSecondaryFailure[],
  context?: SessionPointerContext,
  value?: T,
): CommittedLaunchBlockedError & { context?: SessionPointerContext; value?: T } {
  const error = new CommittedLaunchBlockedError(failures) as CommittedLaunchBlockedError & {
    context?: SessionPointerContext; value?: T;
  };
  if (context) error.context = context;
  if (value !== undefined) error.value = value;
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
  options: Pick<SessionStartOptions, 'context' | 'platform' | 'regularFileSync'>,
  timeoutMs: number,
  transition: (pointer: SessionPointerReadResult, context: SessionPointerContext) => T | Promise<T>,
  pointerState: (value: T) => SessionState,
  beforeCommit?: (context: SessionPointerContext) => Promise<void>,
  afterCommit?: (context: SessionPointerContext) => Promise<void>,
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

  const platform = options.platform ?? process.platform;
  const tracker: RegularFileDurabilityTracker = { degraded: false };
  const lock = await acquirePointerLock(
    context,
    candidateSessionId,
    timeoutMs,
    platform,
    tracker,
    options.regularFileSync,
  );
  const pointerTempPath = `${context.sessionPath}.tmp-${lock.token}`;
  let pointerCommitted = false;
  let pointerTempWritten = false;

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
      next = await transition(pointer, context);
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
      pointerTempWritten = true;
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
      recordRegularFileSyncOutcome(
        tracker,
        await transactionDependencies.fs.openAndSync(pointerTempPath, platform, options.regularFileSync),
      );
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
    if (beforeCommit) await beforeCommit(context);
    try {
      await transactionDependencies.fs.rename(pointerTempPath, context.sessionPath);
      pointerCommitted = true;
      if (afterCommit) {
        try {
          await afterCommit(context);
        } catch (error) {
          const releaseFailures = await releasePointerLock(lock);
          throw releaseFailureError([
            {
              operation: 'lock-release', phase: 'rename', ownership: 'uncertain',
              message: `Selected state root identity changed after pointer publication: ${errorMessage(error)}`,
              cause: error, evidencePath: context.sessionPath,
            },
            ...releaseFailures,
          ], context, next);
        }
      }
    } catch (error) {
      if (error instanceof CommittedLaunchBlockedError) throw error;
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
    if (releaseFailures.length > 0) throw releaseFailureError(releaseFailures, context, next);
    emitDegradedDurabilityWarning('session pointer start/reconcile', tracker);
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
    const ownsPointerTemp = pointerTempWritten;
    throw await finalizePrecommitAbort(lock, primary, ownsPointerTemp ? pointerTempPath : undefined);
  }
}

function startPointerTransition(
  requestedSessionId: string,
  options: SessionStartOptions,
  requireLaunchLineageToken = false,
  requireAbsent = false,
): (pointer: SessionPointerReadResult, context: SessionPointerContext) => SessionState {
  return (pointer, context) => {
    if (requireAbsent && pointer.status !== 'absent') {
      // Same read-vs-authority split: an occupied pointer is an owner conflict even when its
      // liveness is indeterminate, which is the only classification a live pointer can get on a
      // platform without process-birth evidence.
      if (pointer.state && (pointer.status === 'usable' || isUnobservableLivePointerState(pointer.state))) {
        throw ownerConflictAbort(context, requestedSessionId, pointer.state);
      }
      throw unusablePointerAbort(context, requestedSessionId, pointer);
    }
    // Read semantics, not authority: `identity-indeterminate` means "someone may still be here",
    // and on platforms that record no process-birth evidence EVERY live pointer classifies that way
    // (see probeIdentitylessProcess). Rejecting it outright refused legitimate sessions with a
    // generic unusable-pointer abort and skipped lineage/metadata preservation. It is admitted as
    // existing evidence; the ownership/compatibility checks below still refuse any pointer that does
    // not match, so a foreign claim gets the exact owner-conflict abort. Genuinely unusable evidence
    // (malformed, foreign-cwd) is still refused, and authority to own writes still requires 'usable'.
    if (
      pointer.status !== 'absent'
      && pointer.status !== 'stale-dead'
      && pointer.status !== 'usable'
      && !(pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
    ) {
      throw unusablePointerAbort(context, requestedSessionId, pointer);
    }

    const existing = pointer.status === 'usable'
      || (pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
      ? pointer.state
      : undefined;
    if (existing && !isStartCompatible(existing, requestedSessionId)) {
      throw ownerConflictAbort(context, requestedSessionId, existing);
    }
    if (requireLaunchLineageToken && existing && !isValidToken(existing.launch_lineage_token)) {
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

    const state = createSessionState(context.cwd, context.baseStateDir, canonicalSessionId, pid, platform, sessionIdentityFor(pid, platform), {
      nativeSessionId: options.nativeSessionId ?? existing?.native_session_id,
      previousNativeSessionId: options.previousNativeSessionId ?? existing?.previous_native_session_id,
      nativeSessionSwitchedAt: options.nativeSessionSwitchedAt ?? existing?.native_session_switched_at,
      ...(ownerOmxSessionId ? { ownerOmxSessionId } : {}),
      launchLineageToken: existing
        ? (isValidToken(existing.launch_lineage_token) ? existing.launch_lineage_token : undefined)
        : transactionDependencies.token(),
      tmuxSessionName: options.tmuxSessionName ?? existing?.tmux_session_name,
      tmuxPaneId: options.tmuxPaneId ?? existing?.tmux_pane_id,
    });
    return preserveExistingLaunchLineageToken(existing, state);
  };
}

/** Create a wrapper-owned canonical pointer only when the selected pointer is absent. */
export async function writeSessionStart(
  cwd: string,
  sessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const candidateSessionId = normalizeSessionId(sessionId);
  let context: SessionPointerContext;
  try {
    context = options.context ?? resolveSessionPointerContext(cwd);
  } catch (error) {
    throw contextAbort(cwd, candidateSessionId, error);
  }
  let pointer: SessionPointerReadResult;
  try {
    pointer = await readSessionPointer(context);
  } catch (error) {
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure', operation: 'pointer-read', candidateSessionId,
      lockPath: context.lockPath, reason: `Unable to read selected session pointer: ${errorMessage(error)}`, cause: error,
    });
  }
  if (pointer.status !== 'absent') {
    if (pointer.status === 'usable' && pointer.state) {
      throw ownerConflictAbort(context, candidateSessionId ?? sessionId, pointer.state);
    }
    throw unusablePointerAbort(context, candidateSessionId ?? sessionId, pointer);
  }
  return await writeSessionStartTransition(cwd, sessionId, { ...options, context });
}

async function writeSessionStartTransition(
  cwd: string,
  sessionId: string,
  options: SessionStartOptions,
  requireLaunchLineageToken = false,
  requireAbsent = false,
  beforeCommit?: (context: SessionPointerContext) => Promise<void>,
  afterCommit?: (context: SessionPointerContext) => Promise<void>,
): Promise<SessionState> {
  const requestedSessionId = normalizeSessionId(sessionId);
  const result = await writePointerTransaction(
    cwd,
    requestedSessionId,
    options,
    DEFAULT_POINTER_TIMEOUT_MS,
    startPointerTransition(requestedSessionId ?? sessionId, options, requireLaunchLineageToken, requireAbsent),
    (state) => state,
    beforeCommit,
    afterCommit,
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

const DIRECTORY_CAPABILITY_PLATFORMS = new Set<NodeJS.Platform>([
  'linux', 'darwin', 'freebsd', 'openbsd', 'netbsd', 'sunos',
]);

export class LaunchContextResolutionError extends Error {
  readonly name = 'LaunchContextResolutionError';
  constructor(readonly cleanup: EstablishmentCleanupEvidence, cause: unknown) {
    super(`Unable to establish launch directory capability: ${errorMessage(cause)}`, { cause });
  }
}

interface BindingLease {
  handle?: FileHandle;
  closed: boolean;
  closeEvidence?: CapabilityCloseEvidence;
}
const bindingLeases = new WeakMap<LaunchSessionBinding, BindingLease>();
const bindingFinalizations = new WeakMap<LaunchSessionBinding, Promise<BoundFinalizationReport>>();

function safeError(error: unknown): Readonly<{ name: string; message: string; code?: string }> {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    ...(errorCode(error) ? { code: errorCode(error) } : {}),
  };
}

function lockDisposition(failures: readonly SessionPointerSecondaryFailure[]): 'held' | 'released-with-residue' | 'uncertain' {
  if (failures.some((failure) => failure.ownership === 'uncertain')) return 'uncertain';
  return failures.some((failure) => failure.ownership === 'held') ? 'held' : 'released-with-residue';
}

async function acquireDirectoryCapability(
  cwd: string,
  platform: NodeJS.Platform,
): Promise<{ canonicalRealpath: string; identity: LaunchSessionBinding['directoryIdentity']; lease: BindingLease; cleanup: CapabilityCloseEvidence[] }> {
  const cleanup: CapabilityCloseEvidence[] = [];
  let canonicalRealpath: string;
  try {
    canonicalRealpath = await realpath(cwd);
  } catch (error) {
    throw new LaunchContextResolutionError({ capability: cleanup }, error);
  }
  if (!DIRECTORY_CAPABILITY_PLATFORMS.has(platform)) {
    return { canonicalRealpath, identity: { kind: 'unsupported', reason: 'platform' }, lease: { closed: false }, cleanup };
  }
  let handle: FileHandle;
  try {
    handle = await open(canonicalRealpath, 'r');
  } catch (error) {
    throw new LaunchContextResolutionError({ capability: cleanup }, error);
  }
  let statFailure: unknown;
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory() || typeof stats.dev !== 'bigint' || typeof stats.ino !== 'bigint' || stats.dev <= 0n || stats.ino <= 0n) {
      try {
        await handle.close();
        cleanup.push({ role: 'acquisition', phase: 'before-authorization', status: 'closed' });
      } catch (closeError) {
        cleanup.push({ role: 'acquisition', phase: 'before-authorization', status: 'failed', error: safeError(closeError) });
        throw new LaunchContextResolutionError({ capability: cleanup }, closeError);
      }
      return { canonicalRealpath, identity: { kind: 'unsupported', reason: 'inadequate-identity' }, lease: { closed: false }, cleanup };
    }
    return { canonicalRealpath, identity: { kind: 'supported', dev: stats.dev, ino: stats.ino }, lease: { handle, closed: false }, cleanup };
  } catch (error) {
    if (error instanceof LaunchContextResolutionError) throw error;
    statFailure = error;
  }
  try {
    await handle.close();
    cleanup.push({ role: 'acquisition', phase: 'before-authorization', status: 'closed' });
  } catch (closeError) {
    cleanup.push({ role: 'acquisition', phase: 'before-authorization', status: 'failed', error: safeError(closeError) });
    throw new LaunchContextResolutionError({ capability: cleanup }, closeError);
  }
  const code = errorCode(statFailure);
  if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EINVAL') {
    return { canonicalRealpath, identity: { kind: 'unsupported', reason: 'stat-feature' }, lease: { closed: false }, cleanup };
  }
  throw new LaunchContextResolutionError({ capability: cleanup }, statFailure);
}

export async function closeLaunchSessionBindingOnce(
  binding: LaunchSessionBinding,
  phase: CapabilityCloseEvidence['phase'] = 'post-finalization',
): Promise<CapabilityCloseEvidence> {
  const lease = bindingLeases.get(binding);
  if (!lease || lease.closed) return lease?.closeEvidence ?? { role: 'original-retained', phase, status: 'not-needed' };
  lease.closed = true;
  try {
    await lease.handle?.close();
    return lease.closeEvidence = { role: 'original-retained', phase, status: 'closed' };
  } catch (error) {
    return lease.closeEvidence = { role: 'original-retained', phase, status: 'failed', error: safeError(error) };
  }
}

export async function establishLaunchSessionBinding(
  cwd: string,
  requestedSessionId: string,
  options: SessionStartOptions = {},
): Promise<LaunchEstablishment> {
  const platform = options.platform ?? process.platform;
  let context: SessionPointerContext;
  try {
    context = options.context ?? resolveSessionPointerContext(cwd);
    await transactionDependencies.fs.mkdir(context.baseStateDir, { recursive: true });
  } catch (error) {
    throw new LaunchContextResolutionError({ capability: [] }, error);
  }
  const acquired = await acquireDirectoryCapability(context.baseStateDir, platform);
  const cleanup = (): EstablishmentCleanupEvidence => ({ capability: acquired.cleanup });
  const revalidateSelectedRoot = async (lockedContext: SessionPointerContext): Promise<void> => {
    if (acquired.identity.kind !== 'supported') return;
    const retained = await acquired.lease.handle?.stat({ bigint: true });
    if (!retained || !retained.isDirectory() || retained.dev !== acquired.identity.dev || retained.ino !== acquired.identity.ino) {
      throw resolvedAbort(lockedContext, {
        code: 'session_pointer_io_failure', operation: 'pointer-classify', candidateSessionId: normalizeSessionId(requestedSessionId),
        lockPath: lockedContext.lockPath, reason: 'Selected state root identity changed during pointer publication.',
      });
    }
    const canonical = await realpath(lockedContext.baseStateDir);
    const fresh = await open(canonical, 'r');
    try {
      const stats = await fresh.stat({ bigint: true });
      if (canonical !== acquired.canonicalRealpath || !stats.isDirectory() || stats.dev !== acquired.identity.dev || stats.ino !== acquired.identity.ino) {
        throw resolvedAbort(lockedContext, {
          code: 'session_pointer_io_failure', operation: 'pointer-classify', candidateSessionId: normalizeSessionId(requestedSessionId),
          lockPath: lockedContext.lockPath, reason: 'Selected state root was replaced during pointer publication.',
        });
      }
    } finally {
      await fresh.close();
    }
  };
  try {
    const state = await writeSessionStartTransition(
      context.cwd, requestedSessionId, { ...options, context }, true, true,
      revalidateSelectedRoot, revalidateSelectedRoot,
    );
    const token = state.launch_lineage_token;
    if (!isValidToken(token)) {
      const close = await closeLease(acquired.lease, 'before-authorization');
      if (close) acquired.cleanup.push(close);
      throw new LaunchContextResolutionError(cleanup(), new Error('Committed session pointer lacks a valid lineage token.'));
    }
    const binding: LaunchSessionBinding = Object.freeze({
      context: Object.freeze({ ...context }), canonicalRealpath: acquired.canonicalRealpath,
      directoryIdentity: acquired.identity, canonicalSessionId: state.session_id,
      ...(state.owner_omx_session_id ? { ownerOmxSessionId: state.owner_omx_session_id } : {}),
      ...(state.native_session_id ? { nativeSessionId: state.native_session_id } : {}),
      startedAt: state.started_at, launchLineageToken: token,
    });
    bindingLeases.set(binding, acquired.lease);
    return { kind: 'committed-released', binding, cleanup: cleanup() };
  } catch (error) {
    if (error instanceof CommittedLaunchBlockedError) {
      const state = (error as CommittedLaunchBlockedError & { value?: SessionState }).value;
      const errorContext = (error as CommittedLaunchBlockedError & { context?: SessionPointerContext }).context ?? context;
      const close = await closeLease(acquired.lease, 'before-authorization');
      if (close) acquired.cleanup.push(close);
      return {
        kind: 'committed-release-failed', evidence: { context: errorContext, canonicalSessionId: state?.session_id ?? requestedSessionId },
        error, lockDisposition: lockDisposition(error.secondaryFailures), secondaryFailures: error.secondaryFailures, cleanup: cleanup(),
      };
    }
    const close = await closeLease(acquired.lease, 'before-authorization');
    if (close) acquired.cleanup.push(close);
    if (isSessionPointerLaunchAbort(error)) return { kind: 'precommit-aborted', abort: error, cleanup: cleanup() };
    throw error;
  }
}

async function closeLease(lease: BindingLease, phase: CapabilityCloseEvidence['phase']): Promise<CapabilityCloseEvidence | undefined> {
  if (lease.closed) return undefined;
  lease.closed = true;
  try {
    await lease.handle?.close();
    return { role: 'acquisition', phase, status: 'closed' };
  } catch (error) {
    return { role: 'acquisition', phase, status: 'failed', error: safeError(error) };
  }
}

export async function updateDetachedSessionMetadata(
  binding: LaunchSessionBinding,
  patch: { tmuxSessionName?: string; tmuxPaneId?: string },
): Promise<DetachedMetadataUpdate> {
  const capability: CapabilityCloseEvidence[] = [];
  const cleanup: EstablishmentCleanupEvidence = { capability };
  try {
    let pointerBeforeTransaction: SessionPointerReadResult;
    try {
      pointerBeforeTransaction = await readSessionPointer(binding.context);
    } catch (error) {
      throw resolvedAbort(binding.context, {
        code: 'session_pointer_io_failure', operation: 'pointer-read', candidateSessionId: binding.canonicalSessionId,
        lockPath: binding.context.lockPath, reason: `Unable to read selected session pointer: ${errorMessage(error)}`, cause: error,
      });
    }
    // Read against an ALREADY-authorized binding: isAuthorizedBoundPointer verifies the pointer
    // belongs to this binding (canonical session id + launch lineage token), which is a stricter
    // check than liveness. Admitting an unobservable-live pointer here only stops a running session
    // on a platform without process-birth evidence from reading as absent; it grants no new
    // authority, because the binding authorization still has to match.
    if ((pointerBeforeTransaction.status !== 'usable'
      && !(pointerBeforeTransaction.status === 'identity-indeterminate'
        && isUnobservableLivePointerState(pointerBeforeTransaction.state)))
      || !isAuthorizedBoundPointer(binding, binding.context, binding.canonicalSessionId, pointerBeforeTransaction.state)) {
      throw unusablePointerAbort(binding.context, binding.canonicalSessionId, pointerBeforeTransaction);
    }
    const authorization = await authorizeBoundDirectoryBeforeTransaction(
      binding,
      pointerBeforeTransaction,
      binding.context.cwd,
    );
    capability.push(...authorization.capability);

    const result = await writePointerTransaction(
      binding.context.cwd,
      binding.canonicalSessionId,
      { context: binding.context },
      DEFAULT_POINTER_TIMEOUT_MS,
      async (pointer, context) => {
        const state = pointer.status === 'usable'
          || (pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
          ? pointer.state
          : undefined;
        if (!state || !isAuthorizedBoundPointer(binding, context, binding.canonicalSessionId, state)) {
          throw unusablePointerAbort(context, binding.canonicalSessionId, pointer);
        }
        await consumeBoundDirectoryAuthorizationUnderLock(binding, authorization, pointer);
        return {
          ...state,
          ...(patch.tmuxSessionName !== undefined ? { tmux_session_name: patch.tmuxSessionName } : {}),
          ...(patch.tmuxPaneId !== undefined ? { tmux_pane_id: patch.tmuxPaneId } : {}),
        };
      },
      (state) => state,
    );
    return { kind: 'committed-released', evidence: { context: result.context, canonicalSessionId: binding.canonicalSessionId }, cleanup };
  } catch (error) {
    if (error instanceof CommittedLaunchBlockedError) {
      const context = (error as CommittedLaunchBlockedError & { context?: SessionPointerContext }).context ?? binding.context;
      return { kind: 'committed-release-failed', evidence: { context, canonicalSessionId: binding.canonicalSessionId }, error,
        lockDisposition: lockDisposition(error.secondaryFailures), secondaryFailures: error.secondaryFailures, cleanup };
    }
    if (isSessionPointerLaunchAbort(error)) return { kind: 'precommit-aborted', abort: error, cleanup };
    throw error;
  }
}

function isAuthorizedBoundPointer(
  binding: LaunchSessionBinding,
  context: SessionPointerContext,
  candidateSessionId: string,
  state: SessionState | undefined,
): boolean {
  traceSessionFinalizationOperation('auth-function-enter');
  traceSessionFinalizationOperation('lease-lookup-start');
  const lease = bindingLeases.get(binding);
  traceSessionFinalizationOperation('lease-lookup-done');
  traceSessionFinalizationOperation(`state-present:${state ? 'true' : 'false'}`);
  if (!lease || (binding.directoryIdentity.kind === 'supported' && lease.closed) || !state) {
    traceSessionFinalizationOperation('bound-auth-fail:lease-or-state');
    return false;
  }
  if (!isValidToken(binding.launchLineageToken) || !isValidToken(state.launch_lineage_token)) {
    traceSessionFinalizationOperation('bound-auth-fail:token-shape');
    return false;
  }
  if (candidateSessionId !== binding.canonicalSessionId) {
    traceSessionFinalizationOperation('bound-auth-fail:candidate-session');
    return false;
  }
  if (state.launch_lineage_token !== binding.launchLineageToken) {
    traceSessionFinalizationOperation('bound-auth-fail:lineage-token');
    return false;
  }
  if (state.started_at !== binding.startedAt) {
    traceSessionFinalizationOperation('bound-auth-fail:started-at');
    return false;
  }
  const directCanonicalIdentity = state.session_id === binding.canonicalSessionId
    && ((state.owner_omx_session_id ?? undefined) === binding.ownerOmxSessionId
      || (binding.ownerOmxSessionId === undefined && state.owner_omx_session_id === binding.canonicalSessionId))
    && (binding.nativeSessionId === undefined || state.native_session_id === binding.nativeSessionId);
  const replacedNativeIdentity = state.owner_omx_session_id === binding.canonicalSessionId
    && normalizeSessionId(state.session_id) !== undefined
    && state.native_session_id === state.session_id;
  if (!directCanonicalIdentity && !replacedNativeIdentity) {
    traceSessionFinalizationOperation('bound-auth-fail:session-identity');
    return false;
  }
  if (context.rootSource !== binding.context.rootSource) traceSessionFinalizationOperation('bound-auth-fail:root-source');
  else if (context.baseStateDir !== binding.context.baseStateDir) traceSessionFinalizationOperation('bound-auth-fail:base-state-dir');
  else if (context.sessionPath !== binding.context.sessionPath) traceSessionFinalizationOperation('bound-auth-fail:session-path');
  else if (context.cwd !== binding.context.cwd) traceSessionFinalizationOperation('bound-auth-fail:context-cwd');
  else if (state.cwd !== binding.context.cwd) traceSessionFinalizationOperation('bound-auth-fail:state-cwd');
  else {
    traceSessionFinalizationOperation('bound-auth-success');
    return true;
  }
  return false;
}

function isAuthorizedBoundStaleDeadPointer(
  binding: LaunchSessionBinding,
  context: SessionPointerContext,
  candidateSessionId: string,
  state: SessionState | undefined,
): boolean {
  return isAuthorizedBoundPointer(binding, context, candidateSessionId, state)
    && Boolean(normalizeSessionId(state?.native_session_id));
}

interface BoundDirectoryAuthorization {
  readonly comparison: LifecycleCleanupEvidence['comparison'];
  readonly capability: CapabilityCloseEvidence[];
  readonly pointerStatus: SessionPointerStatus;
  readonly pointerRaw?: string;
}

class BoundDirectoryComparisonDenied extends Error {
  constructor(readonly comparison: NonNullable<LifecycleCleanupEvidence['comparison']>, readonly capability: CapabilityCloseEvidence[]) {
    super(comparison.reason);
  }
}

function isAuthorizedBoundPointerForFinalization(
  binding: LaunchSessionBinding,
  context: SessionPointerContext,
  candidateSessionId: string,
  pointer: SessionPointerReadResult,
  phase: 'preLock' | 'under-lock',
): boolean {
  traceSessionFinalizationOperation(`${phase}-status:${pointer.status}`);
  if (pointer.status === 'usable') {
    traceSessionFinalizationOperation(`${phase}-usable-branch-enter`);
    return isAuthorizedBoundPointer(binding, context, candidateSessionId, pointer.state);
  }
  if (pointer.status === 'stale-dead') {
    traceSessionFinalizationOperation(`${phase}-stale-dead-branch-enter`);
    return isAuthorizedBoundStaleDeadPointer(binding, context, candidateSessionId, pointer.state);
  }
  if (pointer.status === 'identity-indeterminate') {
    traceSessionFinalizationOperation(`${phase}-identity-indeterminate-branch-enter`);
    const sameProcess = pointer.state?.pid === process.pid;
    traceSessionFinalizationOperation(`${phase}-identity-indeterminate-current-pid:${sameProcess ? 'true' : 'false'}`);
    return sameProcess && isAuthorizedBoundPointer(binding, context, candidateSessionId, pointer.state);
  }
  traceSessionFinalizationOperation(`${phase}-unsupported-status`);
  return false;
}

async function authorizeBoundDirectoryBeforeTransaction(
  binding: LaunchSessionBinding,
  pointer: SessionPointerReadResult,
  postLaunchCwd: string,
): Promise<BoundDirectoryAuthorization> {
  const capability: CapabilityCloseEvidence[] = [];
  const lease = bindingLeases.get(binding);
  if (!lease || lease.closed) {
    throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'binding-lease-closed' }, capability);
  }
  try {
    if (!sameFilePath(binding.context.cwd, postLaunchCwd)
      || !pointer.state?.cwd
      || !sameFilePath(binding.context.cwd, pointer.state.cwd)) {
      throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'cwd-identity-mismatch' }, capability);
    }
    if (binding.directoryIdentity.kind !== 'supported') {
      return {
        comparison: { status: 'matched', reason: `unsupported-directory-capability:${binding.directoryIdentity.reason}` },
        capability,
        pointerStatus: pointer.status,
        pointerRaw: pointer.raw,
      };
    }
    const retained = fstatSync(lease.handle!.fd, { bigint: true });
    if (!retained || !retained.isDirectory() || retained.dev !== binding.directoryIdentity.dev || retained.ino !== binding.directoryIdentity.ino) {
      throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'retained-directory-identity-mismatch' }, capability);
    }
    const canonical = await realpath(binding.context.baseStateDir);
    const fd = openSync(canonical, 'r');
    let matched = false;
    try {
      const stats = fstatSync(fd, { bigint: true });
      matched = canonical === binding.canonicalRealpath
        && stats.isDirectory()
        && stats.dev === binding.directoryIdentity.dev
        && stats.ino === binding.directoryIdentity.ino;
    } finally {
      try {
        closeSync(fd);
        capability.push({ role: 'fresh-comparison', phase: 'before-authorization', status: 'closed' });
      } catch (error) {
        capability.push({ role: 'fresh-comparison', phase: 'before-authorization', status: 'failed', error: safeError(error) });
        throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'fresh-comparison-close-failed' }, capability);
      }
    }
    if (!matched) throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'directory-identity-mismatch' }, capability);
    return { comparison: { status: 'matched' }, capability, pointerStatus: pointer.status, pointerRaw: pointer.raw };
  } catch (error) {
    if (error instanceof BoundDirectoryComparisonDenied) throw error;
    throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: errorMessage(error) }, capability);
  }
}

async function consumeBoundDirectoryAuthorizationUnderLock(
  binding: LaunchSessionBinding,
  authorization: BoundDirectoryAuthorization,
  pointer: SessionPointerReadResult,
): Promise<{ comparison: LifecycleCleanupEvidence['comparison']; capability: CapabilityCloseEvidence[] }> {
  if (authorization.comparison?.status !== 'matched' || binding.directoryIdentity.kind !== 'supported') return authorization;
  const lease = bindingLeases.get(binding);
  try {
    const retained = lease?.handle ? fstatSync(lease.handle.fd, { bigint: true }) : undefined;
    if (!retained || !retained.isDirectory() || retained.dev !== binding.directoryIdentity.dev || retained.ino !== binding.directoryIdentity.ino) {
      throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'retained-directory-identity-mismatch' }, authorization.capability);
    }
    if (!pointer.state?.cwd || !sameFilePath(binding.context.cwd, pointer.state.cwd)) {
      throw new BoundDirectoryComparisonDenied(
        { status: 'denied', reason: 'cwd-identity-mismatch-under-lock' },
        authorization.capability,
      );
    }
    const canonical = await realpath(binding.context.baseStateDir);
    const fd = openSync(canonical, 'r');
    let matched = false;
    try {
      const stats = fstatSync(fd, { bigint: true });
      matched = canonical === binding.canonicalRealpath
        && stats.isDirectory()
        && stats.dev === binding.directoryIdentity.dev
        && stats.ino === binding.directoryIdentity.ino;
    } finally {
      try {
        closeSync(fd);
        authorization.capability.push({ role: 'fresh-comparison', phase: 'before-authorization', status: 'closed' });
      } catch (error) {
        authorization.capability.push({ role: 'fresh-comparison', phase: 'before-authorization', status: 'failed', error: safeError(error) });
        throw new BoundDirectoryComparisonDenied(
          { status: 'denied', reason: 'fresh-comparison-close-failed-under-lock' },
          authorization.capability,
        );
      }
    }
    if (!matched) throw new BoundDirectoryComparisonDenied(
      { status: 'denied', reason: 'directory-identity-mismatch-under-lock' },
      authorization.capability,
    );
    if (pointer.status !== authorization.pointerStatus || pointer.raw !== authorization.pointerRaw) {
      throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: 'pointer-changed-before-consume' }, authorization.capability);
    }
    return authorization;
  } catch (error) {
    if (error instanceof BoundDirectoryComparisonDenied) throw error;
    throw new BoundDirectoryComparisonDenied({ status: 'denied', reason: errorMessage(error) }, authorization.capability);
  }
}

export function finalizeBoundOnce(
  binding: LaunchSessionBinding,
  _reason: string,
  postLaunchCwd = binding.context.cwd,
): Promise<BoundFinalizationReport> {
  const existing = bindingFinalizations.get(binding);
  if (existing) return existing;
  const finalization = (async (): Promise<BoundFinalizationReport> => {
    try {
      const revalidation = await writeSessionEnd(binding.context.cwd, binding.canonicalSessionId, {
        context: binding.context, binding, postLaunchCwd,
      });
      return { finalized: true, cleanup: { capability: revalidation.capability, comparison: revalidation.comparison } };
    } catch (error) {
      if (error instanceof BoundDirectoryComparisonDenied) {
        return { finalized: false, cleanup: { capability: error.capability, comparison: error.comparison } };
      }
      if (isSessionPointerLaunchAbort(error)) {
        return { finalized: false, cleanup: { capability: [], comparison: { status: 'denied', reason: error.code } } };
      }
      throw error;
    }
  })();
  bindingFinalizations.set(binding, finalization);
  return finalization;
}


function nativeSessionOwnerTransition(
  nativeSessionId: string,
  options: SessionStartOptions,
): (pointer: SessionPointerReadResult, context: SessionPointerContext) => SessionState {
  return (pointer, context) => {
    // Read semantics, not authority: `identity-indeterminate` means "someone may still be here",
    // and on platforms that record no process-birth evidence EVERY live pointer classifies that way
    // (see probeIdentitylessProcess). Rejecting it outright refused legitimate sessions with a
    // generic unusable-pointer abort and skipped lineage/metadata preservation. It is admitted as
    // existing evidence; the ownership/compatibility checks below still refuse any pointer that does
    // not match, so a foreign claim gets the exact owner-conflict abort. Genuinely unusable evidence
    // (malformed, foreign-cwd) is still refused, and authority to own writes still requires 'usable'.
    if (
      pointer.status !== 'absent'
      && pointer.status !== 'stale-dead'
      && pointer.status !== 'usable'
      && !(pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
    ) {
      throw unusablePointerAbort(context, nativeSessionId, pointer);
    }
    const pid = resolvePid(options);
    const platform = options.platform ?? process.platform;
    const linuxIdentity = sessionIdentityFor(pid, platform);
    const existing = pointer.status === 'usable'
      || (pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
      ? pointer.state
      : undefined;
    if (existing && (
      normalizeSessionId(existing.session_id) !== nativeSessionId
      || normalizeSessionId(existing.native_session_id) !== nativeSessionId
      || existing.platform !== platform
      || !isSessionStateAuthoritativeForCwd(existing, context.cwd)
      || existing.pid !== pid
    )) {
      throw ownerConflictAbort(context, nativeSessionId, existing);
    }
    return createSessionState(context.cwd, context.baseStateDir, nativeSessionId, pid, platform, linuxIdentity, {
      nativeSessionId,
      startedAt: existing?.started_at,
      tmuxSessionName: options.tmuxSessionName ?? existing?.tmux_session_name,
      tmuxPaneId: options.tmuxPaneId ?? existing?.tmux_pane_id,
    });
  };
}

export async function writeNativeSessionOwner(
  cwd: string,
  nativeSessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const normalized = normalizeSessionId(nativeSessionId);
  const context = resolveNativeSessionOwnerContext(cwd, nativeSessionId);
  const result = await writePointerTransaction(
    cwd,
    normalized,
    { context },
    NATIVE_POINTER_TIMEOUT_MS,
    nativeSessionOwnerTransition(normalized ?? nativeSessionId, options),
    (state) => state,
  );
  return result.value;
}

/** Read and classify the exact native session-owner sidecar without consulting alternate roots. */
export async function readNativeSessionOwnerEvidence(
  cwd: string,
  nativeSessionId: string,
): Promise<NativeSessionOwnerEvidence> {
  const normalized = normalizeSessionId(nativeSessionId);
  if (!normalized) return { status: 'malformed' };
  const context = resolveNativeSessionOwnerContext(cwd, normalized);
  const nativeOwnerDir = dirname(context.sessionPath);
  const sessionsDir = dirname(nativeOwnerDir);
  const stateRootDir = dirname(sessionsDir);
  const directoryPaths = [stateRootDir, sessionsDir, nativeOwnerDir];
  const directoryIdentities: Array<{ path: string; dev: number; ino: number }> = [];
  let frozenFileIdentity: SessionOwnerFileIdentity | undefined;
  try {
    for (const directoryPath of directoryPaths) {
      const stat = await transactionDependencies.fs.lstat(directoryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: 'malformed' };
      directoryIdentities.push({ path: directoryPath, dev: stat.dev, ino: stat.ino });
    }
    const pathStat = await transactionDependencies.fs.lstat(context.sessionPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { status: 'malformed' };
    frozenFileIdentity = { dev: pathStat.dev, ino: pathStat.ino };
  } catch (error) {
    if (isNotFound(error)) return { status: 'absent' };
    throw error;
  }

  const handle = await open(context.sessionPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) return { status: 'malformed' };
    raw = await handle.readFile({ encoding: 'utf8' });
    const finalPathStat = await transactionDependencies.fs.lstat(context.sessionPath);
    if (!frozenFileIdentity
      || finalPathStat.isSymbolicLink()
      || !finalPathStat.isFile()
      || finalPathStat.dev !== frozenFileIdentity.dev
      || finalPathStat.ino !== frozenFileIdentity.ino
      || !sessionOwnerFileIdentityMatches(frozenFileIdentity, openedStat, transactionDependencies.runtimePlatform)) {
      return { status: 'malformed', raw };
    }
    for (const identity of directoryIdentities) {
      const finalDirectoryStat = await transactionDependencies.fs.lstat(identity.path);
      if (finalDirectoryStat.isSymbolicLink()
        || !finalDirectoryStat.isDirectory()
        || finalDirectoryStat.dev !== identity.dev
        || finalDirectoryStat.ino !== identity.ino) {
        return { status: 'malformed', raw };
      }
    }
  } finally {
    await handle.close();
  }

  let pointer: SessionPointerReadResult;
  try {
    pointer = classifyParsedSessionPointer(context, JSON.parse(raw), raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'malformed', raw };
    throw error;
  }
  if (pointer.status === 'absent' || pointer.status === 'foreign-cwd' || pointer.status === 'malformed' || pointer.status === 'identity-indeterminate') {
    return pointer;
  }
  const state = pointer.state;
  return state?.session_id === normalized
    && state.native_session_id === normalized
    && state.platform === transactionDependencies.runtimePlatform
    && isSessionStateAuthoritativeForCwd(state, context.cwd)
    ? pointer
    : { status: 'malformed', state, raw: pointer.raw };
}

export async function readNativeSessionOwner(
  cwd: string,
  nativeSessionId: string,
): Promise<SessionState | null> {
  try {
    const evidence = await readNativeSessionOwnerEvidence(cwd, nativeSessionId);
    return evidence.status === 'usable' ? evidence.state ?? null : null;
  } catch {
    return null;
  }
}

function reconcileNativeTransition(
  nativeSessionId: string,
  options: SessionStartOptions,
): (pointer: SessionPointerReadResult, context: SessionPointerContext) => SessionState {
  return (pointer, context) => {
    // Read semantics, not authority: `identity-indeterminate` means "someone may still be here",
    // and on platforms that record no process-birth evidence EVERY live pointer classifies that way
    // (see probeIdentitylessProcess). Rejecting it outright refused legitimate sessions with a
    // generic unusable-pointer abort and skipped lineage/metadata preservation. It is admitted as
    // existing evidence; the ownership/compatibility checks below still refuse any pointer that does
    // not match, so a foreign claim gets the exact owner-conflict abort. Genuinely unusable evidence
    // (malformed, foreign-cwd) is still refused, and authority to own writes still requires 'usable'.
    if (
      pointer.status !== 'absent'
      && pointer.status !== 'stale-dead'
      && pointer.status !== 'usable'
      && !(pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
    ) {
      throw unusablePointerAbort(context, nativeSessionId, pointer);
    }

    const pid = resolvePid(options);
    const platform = options.platform ?? process.platform;
    const linuxIdentity = sessionIdentityFor(pid, platform);
    const livenessProven = pointer.status === 'usable';
    const existing = livenessProven
      || (pointer.status === 'identity-indeterminate' && isUnobservableLivePointerState(pointer.state))
      ? pointer.state
      : undefined;

    if (existing && !livenessProven && !mayAdoptUnprovenPointer(existing, context.cwd)) {
      throw ownerConflictAbort(context, nativeSessionId, existing);
    }

    if (!existing) {
      const ownerCandidate = verifiedOwnerCandidate(context, options);
      const ownerOmxSessionId = ownerCandidate;
      return createSessionState(context.cwd, context.baseStateDir, nativeSessionId, pid, platform, linuxIdentity, {
        nativeSessionId,
        ...(ownerOmxSessionId ? { ownerOmxSessionId } : {}),
      });
    }

    const existingNativeSessionId = normalizeSessionId(existing.native_session_id);
    if (existingNativeSessionId && existingNativeSessionId !== nativeSessionId) {
      throw ownerConflictAbort(context, nativeSessionId, existing);
    }

    const nowIso = new Date().toISOString();

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

    return preserveExistingLaunchLineageToken(existing, createSessionState(context.cwd, context.baseStateDir, existing.session_id, pid, platform, linuxIdentity, {
      nowIso,
      nativeSessionId,
      previousNativeSessionId: existing.previous_native_session_id,
      nativeSessionSwitchedAt: existing.native_session_switched_at,
      ...(ownerOmxSessionId ? { ownerOmxSessionId } : {}),
      startedAt: existing.started_at,
      tmuxSessionName: existing.tmux_session_name,
      tmuxPaneId: existing.tmux_pane_id,
      launchLineageToken: isValidToken(existing.launch_lineage_token)
        ? existing.launch_lineage_token
        : undefined,
    }));
  };
}

/**
 * Reconcile native SessionStart only when the selected pointer is absent, stale,
 * or already belongs to that native session. A different live native ID is
 * authoritative owner evidence and must never be replaced.
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
    (state) => state,
  );
  await appendToLogAtContext(result.context, {
    event: 'session_start_reconciled',
    session_id: result.value.session_id,
    native_session_id: normalizedNativeSessionId ?? nativeSessionId,
    pid: result.value.pid,
    timestamp: new Date().toISOString(),
  }).catch(() => {});
  return result.value;
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
  options: Pick<SessionStartOptions, 'context' | 'platform' | 'regularFileSync'> & {
    binding?: LaunchSessionBinding;
    postLaunchCwd?: string;
  } = {},
): Promise<{ comparison: LifecycleCleanupEvidence['comparison']; capability: CapabilityCloseEvidence[] }> {
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

  if (!options.binding) {
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure', operation: 'pointer-classify', candidateSessionId,
      lockPath: context.lockPath, reason: 'A live launch binding is required to end a session pointer.',
    });
  }

  let preLockPointer: SessionPointerReadResult;
  traceSessionFinalizationOperation('preLock-read-start');
  try {
    preLockPointer = await readSessionPointer(context);
    traceSessionFinalizationOperation(`preLock-read-done:${preLockPointer.status}`);
  } catch (error) {
    throw resolvedAbort(context, {
      code: 'session_pointer_io_failure', operation: 'pointer-read', candidateSessionId,
      lockPath: context.lockPath, reason: `Unable to read selected session pointer: ${errorMessage(error)}`, cause: error,
    });
  }
  const preLockAuthorized = isAuthorizedBoundPointerForFinalization(
    options.binding, context, candidateSessionId, preLockPointer, 'preLock',
  );
  if (!preLockAuthorized) throw unusablePointerAbort(context, candidateSessionId, preLockPointer);
  traceSessionFinalizationOperation('pre-transaction-auth-start');
  await authorizeBoundDirectoryBeforeTransaction(
    options.binding,
    preLockPointer,
    options.postLaunchCwd ?? options.binding.context.cwd,
  );
  traceSessionFinalizationOperation('pre-transaction-auth-done');

  const platform = options.platform ?? process.platform;
  const tracker: RegularFileDurabilityTracker = { degraded: false };
  traceSessionFinalizationOperation('acquirePointerLock-start');
  const lock = await acquirePointerLock(
    context,
    candidateSessionId,
    DEFAULT_POINTER_TIMEOUT_MS,
    platform,
    tracker,
    options.regularFileSync,
  );
  traceSessionFinalizationOperation('acquirePointerLock-done');
  let primary: unknown;
  let revalidation: { comparison: LifecycleCleanupEvidence['comparison']; capability: CapabilityCloseEvidence[] } = {
    comparison: { status: 'not-run' }, capability: [],
  };
  try {
    let pointer: SessionPointerReadResult;
    traceSessionFinalizationOperation('under-lock-read-start');
    try {
      pointer = await readSessionPointer(context);
      traceSessionFinalizationOperation(`under-lock-read-done:${pointer.status}`);
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
    const authorized = isAuthorizedBoundPointerForFinalization(
      options.binding, context, candidateSessionId, pointer, 'under-lock',
    );
    if (!authorized) throw unusablePointerAbort(context, candidateSessionId, pointer);
    traceSessionFinalizationOperation('under-lock-auth-start');
    const authorization = await authorizeBoundDirectoryBeforeTransaction(
      options.binding,
      pointer,
      options.postLaunchCwd ?? options.binding.context.cwd,
    );
    traceSessionFinalizationOperation('under-lock-auth-done');
    traceSessionFinalizationOperation('under-lock-consume-start');
    revalidation = await consumeBoundDirectoryAuthorizationUnderLock(options.binding, authorization, pointer);
    traceSessionFinalizationOperation('under-lock-consume-done');

    const state = pointer.state!;
    const ownsCurrentSessionFile = true;
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

    traceSessionFinalizationOperation('history-mkdir-start');
    await nodeMkdir(historyDirectory(context), { recursive: true });
    traceSessionFinalizationOperation('history-mkdir-done');
    traceSessionFinalizationOperation('history-append-start');
    await appendFile(historyPath(context), `${JSON.stringify(historyEntry)}\n`);
    traceSessionFinalizationOperation('history-append-done');
    traceSessionFinalizationOperation('hud-cleanup-start');
    await removeDeadSessionHudState(context, [
      ...(ownsCurrentSessionFile ? [state?.session_id, state?.native_session_id] : []),
      candidateSessionId,
    ]);
    traceSessionFinalizationOperation('hud-cleanup-done');
    traceSessionFinalizationOperation('session-unlink-start');
    if (ownsCurrentSessionFile) {
      try {
        await transactionDependencies.fs.unlink(context.sessionPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    traceSessionFinalizationOperation('session-unlink-done');
    traceSessionFinalizationOperation('session-end-log-start');
    await appendToLogAtContext(context, {
      event: 'session_end',
      session_id: historyEntry.session_id,
      ...(historyEntry.native_session_id ? { native_session_id: historyEntry.native_session_id } : {}),
      ...(historyEntry.active_session_id ? { active_session_id: historyEntry.active_session_id } : {}),
      ...(historyEntry.preserved_active_session_id ? { preserved_active_session_id: historyEntry.preserved_active_session_id } : {}),
      timestamp: endTime,
    }).catch(() => {});
    traceSessionFinalizationOperation('session-end-log-done');
  } catch (error) {
    primary = error;
  }

  traceSessionFinalizationOperation('lock-release-start');
  const releaseFailures = await releasePointerLock(lock);
  traceSessionFinalizationOperation('lock-release-done');
  if (primary) {
    if (isSessionPointerLaunchAbort(primary) && releaseFailures.length > 0) {
      throw recoveryAbort(context, primary as ResolvedSessionPointerAbort, releaseFailures, 'lock-release');
    }
    throw primary;
  }
  if (releaseFailures.length > 0) throw releaseFailureError(releaseFailures);
  emitDegradedDurabilityWarning('session pointer end', tracker);
  return revalidation;
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
