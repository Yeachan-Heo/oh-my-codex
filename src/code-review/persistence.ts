import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, watch, type Dirent } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveStateScope } from '../state/paths.js';
import type {
  ReviewConsumptionGroup,
  ReviewConsumptionKind,
  ReviewConsumptionManifest,
  ReviewConsumptionManifestMarkerRef,
  ReviewConsumptionManifestPublication,
  ReviewConsumptionMarker,
  ReviewRecord,
  ReviewRunStatus,
} from './contract.js';
import {
  sanitizeForPersistence,
  validateReviewDiagnostics,
  validateReviewFinding,
  validateReviewReason,
} from './redaction.js';
import {
  renderFinalReviewMarkdown,
  validateFinalReviewArtifact,
  validateReviewTopology,
} from './render.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOCK_WAIT_MS = 5_000;
const PROCESS_IDENTITY_TIMEOUT_MS = 1_000;
const PROCESS_IDENTITY_MAX_BUFFER = 4_096;

export type ReviewPersistenceErrorCode =
  | 'REVIEW_ALREADY_ACTIVE'
  | 'PERSISTENCE_LOCKED'
  | 'PERSISTENCE_FAILED'
  | 'IDEMPOTENCY_CONFLICT';

export class ReviewPersistenceError extends Error {
  readonly code: ReviewPersistenceErrorCode;
  readonly details?: unknown;

  constructor(code: ReviewPersistenceErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ReviewPersistenceError';
    this.code = code;
    this.details = details;
  }
}

export interface ReviewPersistenceContext {
  workingDirectory: string;
  session_id?: string;
}

export interface ReviewPersistencePaths {
  workingDirectory: string;
  session_id?: string;
  stateScopeRoot: string;
  reviewRoot: string;
  activePath: string;
  startLockPath: string;
  startTransactionsRoot: string;
  startReceiptsRoot: string;
  pendingReviewTransactionsRoot: string;
  approvalsRoot: string;
  stopTerminalBriefPath: string;
  stopTerminalBriefConsumedPath: string;
  reviewsRoot: string;
}

export interface ReviewScopedLockPaths {
  journalLockPath: string;
  mutationLockPath: string;
}

export interface ActiveReviewPointer {
  schema_version: 1;
  review_id: string;
  status: ReviewRunStatus;
}

export interface AtomicWriteOptions {
  beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

export interface AtomicCreateOptions {
  beforePublish?: (temporaryPath: string) => void | Promise<void>;
}

export type ReviewLockName = 'start' | 'journal' | 'mutation';
export type ReviewLockOwnerStatus = 'live' | 'absent' | 'reused' | 'unknown';

export interface ReviewLockOwner {
  pid: number;
  hostname: string;
  process_start_marker: string;
  nonce: string;
  acquired_at: string;
}

export interface ReviewLockHandle {
  name: ReviewLockName;
  path: string;
  nonce: string;
}

export interface AcquireReviewLocksOptions {
  timeoutMs?: number;
  now?: () => number;
  ownerProbe?: (owner: ReviewLockOwner) => ReviewLockOwnerStatus | Promise<ReviewLockOwnerStatus>;
  waitForChange?: (lockPath: string, remainingMs: number) => void | Promise<void>;
  onAcquired?: (name: ReviewLockName) => void;
}

export interface ReleaseReviewLocksOptions {
  afterOwnerRead?: (handle: ReviewLockHandle) => void | Promise<void>;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory()) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', `persistence path is not a directory: ${cursor}`);
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }

  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const info = await lstat(directory);
      if (!info.isDirectory()) throw error;
    }
    if (process.platform !== 'win32') await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
  if (process.platform !== 'win32') await chmod(path, PRIVATE_DIRECTORY_MODE);
}

function privateJson(value: unknown): string {
  return `${JSON.stringify(sanitizeForPersistence(value), null, 2)}\n`;
}

export function generateReviewId(): string {
  return randomUUID();
}

export async function resolveReviewPersistencePaths(
  context: ReviewPersistenceContext,
): Promise<ReviewPersistencePaths> {
  const workingDirectory = resolve(context.workingDirectory);
  const scope = await resolveStateScope(workingDirectory, context.session_id);
  const reviewRoot = join(scope.stateDir, 'code-review');
  return {
    workingDirectory,
    ...(scope.sessionId ? { session_id: scope.sessionId } : {}),
    stateScopeRoot: scope.stateDir,
    reviewRoot,
    activePath: join(reviewRoot, 'active.json'),
    startLockPath: join(reviewRoot, 'start.lock'),
    startTransactionsRoot: join(reviewRoot, 'start-transactions'),
    startReceiptsRoot: join(reviewRoot, 'start-receipts'),
    pendingReviewTransactionsRoot: join(reviewRoot, 'pending-review-transactions'),
    approvalsRoot: join(reviewRoot, 'approvals'),
    stopTerminalBriefPath: join(reviewRoot, 'stop-terminal-brief.json'),
    stopTerminalBriefConsumedPath: join(reviewRoot, 'stop-terminal-brief-consumed.json'),
    reviewsRoot: join(workingDirectory, '.omx', 'reviews'),
  };
}

export function resolveReviewLockPaths(
  paths: ReviewPersistencePaths,
  reviewIdValue: string,
): ReviewScopedLockPaths {
  const reviewId = validateUuid(reviewIdValue, 'review_id');
  return {
    journalLockPath: join(paths.reviewRoot, reviewId, 'journal.lock'),
    mutationLockPath: join(paths.reviewRoot, reviewId, 'mutation.lock'),
  };
}

export async function atomicWritePrivateJson(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(targetPath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(directory, `.${targetPath.slice(directory.length + 1)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
    await handle.writeFile(privateJson(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.(temporaryPath);
    await rename(temporaryPath, targetPath);
    if (process.platform !== 'win32') await chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWritePrivateText(targetPath: string, value: string): Promise<void> {
  const directory = dirname(targetPath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(directory, `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    if (process.platform !== 'win32') await chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicCreatePrivateJson(
  targetPath: string,
  value: unknown,
  options: AtomicCreateOptions = {},
): Promise<void> {
  const directory = dirname(targetPath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(directory, `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
    await handle.writeFile(privateJson(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforePublish?.(temporaryPath);
    await link(temporaryPath, targetPath);
    if (process.platform !== 'win32') await chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

const REVIEW_RUN_STATUSES: readonly ReviewRunStatus[] = [
  'CREATED', 'SCOPE_FROZEN', 'REVIEWING', 'READY_TO_SYNTHESIZE', 'FINALIZED', 'BLOCKED',
];
const TERMINAL_REVIEW_STATUSES: readonly ReviewRunStatus[] = ['FINALIZED', 'BLOCKED'];
const ACTIVE_UPDATE_TRANSITIONS: Readonly<Partial<Record<ReviewRunStatus, ReviewRunStatus>>> = {
  CREATED: 'SCOPE_FROZEN',
  SCOPE_FROZEN: 'REVIEWING',
  REVIEWING: 'READY_TO_SYNTHESIZE',
};
const RESUMABLE_REASONS = [
  'LANE_FAILED', 'LANE_TIMED_OUT', 'LANE_EVIDENCE_INVALID', 'MISSING_LANE', 'MCP_TRANSPORT_DEAD',
] as const;
const REVIEW_CONSUMPTION_KINDS: readonly ReviewConsumptionKind[] = [
  'PROPOSAL_KEY', 'TOOL_EVENT_REF', 'NONCE',
];
const REVIEW_CONSUMPTION_DIRECTORIES: Readonly<Record<ReviewConsumptionKind, string>> = {
  PROPOSAL_KEY: 'proposal-key',
  TOOL_EVENT_REF: 'tool-event-ref',
  NONCE: 'nonce',
};

function validateActivePointer(value: unknown): ActiveReviewPointer {
  if (!isPlainObject(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'schema_version')
    || !Object.hasOwn(value, 'review_id')
    || !Object.hasOwn(value, 'status')
    || value.schema_version !== 1
    || !REVIEW_RUN_STATUSES.includes(value.status as ReviewRunStatus)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review pointer is malformed');
  }
  return {
    schema_version: 1,
    review_id: validateUuid(value.review_id, 'active review_id'),
    status: value.status as ReviewRunStatus,
  };
}

export async function readActiveReview(paths: ReviewPersistencePaths): Promise<ActiveReviewPointer | null> {
  try {
    const content = await readFile(paths.activePath, 'utf8');
    return validateActivePointer(JSON.parse(content) as unknown);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof ReviewPersistenceError) throw error;
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'could not read active review pointer');
  }
}

export async function claimActiveReview(
  paths: ReviewPersistencePaths,
  pointer: ActiveReviewPointer,
): Promise<void> {
  try {
    await atomicCreatePrivateJson(paths.activePath, validateActivePointer(pointer));
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const active = await readActiveReview(paths);
    throw new ReviewPersistenceError(
      'REVIEW_ALREADY_ACTIVE',
      `review ${active?.review_id ?? 'unknown'} is already active`,
      active,
    );
  }
}

function lockPath(
  paths: ReviewPersistencePaths,
  reviewId: string | undefined,
  name: ReviewLockName,
): string {
  if (name === 'start') return paths.startLockPath;
  if (reviewId === undefined) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} lock requires a review_id`);
  }
  const scoped = resolveReviewLockPaths(paths, reviewId);
  return name === 'journal' ? scoped.journalLockPath : scoped.mutationLockPath;
}

function parseLockOwner(value: unknown): ReviewLockOwner | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(owner.pid)
    || (owner.pid as number) <= 0
    || typeof owner.hostname !== 'string'
    || owner.hostname.length === 0
    || typeof owner.process_start_marker !== 'string'
    || owner.process_start_marker.length === 0
    || typeof owner.nonce !== 'string'
    || owner.nonce.length === 0
    || typeof owner.acquired_at !== 'string'
    || !Number.isFinite(Date.parse(owner.acquired_at))
  ) return null;
  return owner as unknown as ReviewLockOwner;
}

async function readLockOwner(path: string): Promise<ReviewLockOwner | null> {
  try {
    return parseLockOwner(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function boundedExecFile(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolveOutput) => {
    execFile(file, [...args], {
      encoding: 'utf8',
      maxBuffer: PROCESS_IDENTITY_MAX_BUFFER,
      timeout: PROCESS_IDENTITY_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error || typeof stdout !== 'string') {
        resolveOutput(null);
        return;
      }
      const output = stdout.trim();
      resolveOutput(output.length === 0 || output.length > PROCESS_IDENTITY_MAX_BUFFER ? null : output);
    });
  });
}

async function readProcessStartMarker(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const [statText, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const closeParen = statText.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
      const startTicks = fields[19];
      const boot = bootId.trim();
      return startTicks && boot ? `linux:${boot}:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'openbsd') {
    const output = await boundedExecFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    return output === null ? null : `ps:${output.replace(/\s+/gu, ' ')}`;
  }
  if (process.platform === 'win32') {
    const output = await boundedExecFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]);
    return output === null || !/^\d+$/u.test(output) ? null : `windows:${output}`;
  }
  return null;
}

export async function probeReviewLockOwner(
  owner: ReviewLockOwner,
  readMarker: (pid: number) => Promise<string | null> = readProcessStartMarker,
): Promise<ReviewLockOwnerStatus> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code !== 'EPERM') return 'unknown';
  }
  const actualMarker = await readMarker(owner.pid);
  if (actualMarker === null) return 'unknown';
  return actualMarker === owner.process_start_marker ? 'live' : 'reused';
}

async function defaultWaitForLockChange(path: string, remainingMs: number): Promise<void> {
  if (remainingMs <= 0) return;
  await new Promise<void>((resolveWait) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      resolveWait();
    };
    const timer = setTimeout(finish, remainingMs);
    try {
      watcher = watch(dirname(path), (_event, fileName) => {
        if (fileName === null || fileName.toString() === basename(path)) finish();
      });
      watcher.on('error', finish);
    } catch {
      finish();
    }
  });
}

async function publishLock(path: string, owner: ReviewLockOwner): Promise<boolean> {
  await ensurePrivateDirectory(dirname(path));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
    await handle.writeFile(privateJson(owner), 'utf8');
    await handle.sync();
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `could not publish lock ${path}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function reclaimAbsentOwner(path: string, expectedNonce: string): Promise<boolean> {
  const quarantinePath = `${path}.reap-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isMissing(error)) return true;
    return false;
  }
  const movedOwner = await readLockOwner(quarantinePath);
  if (movedOwner?.nonce === expectedNonce) {
    await rm(quarantinePath, { force: true });
    return true;
  }

  try {
    await link(quarantinePath, path);
  } catch {
    // A new owner won the empty path. Leaving the quarantined evidence is safer than replacing it.
  }
  return false;
}

async function acquireSingleLock(
  paths: ReviewPersistencePaths,
  reviewId: string | undefined,
  name: ReviewLockName,
  options: AcquireReviewLocksOptions,
  deadline: number,
  now: () => number,
): Promise<ReviewLockHandle> {
  const path = lockPath(paths, reviewId, name);
  const ownerProbe = options.ownerProbe ?? probeReviewLockOwner;
  const waitForChange = options.waitForChange ?? defaultWaitForLockChange;
  const processStartMarker = await readProcessStartMarker(process.pid);
  if (processStartMarker === null) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'current process start identity is unavailable');
  }
  let observedStatus: ReviewLockOwnerStatus | undefined;
  while (true) {
    const nonce = randomUUID();
    const owner: ReviewLockOwner = {
      pid: process.pid,
      hostname: hostname(),
      process_start_marker: processStartMarker,
      nonce,
      acquired_at: new Date().toISOString(),
    };
    if (await publishLock(path, owner)) return { name, path, nonce };

    const currentOwner = await readLockOwner(path);
    if (currentOwner?.hostname === hostname()) {
      const status = await ownerProbe(currentOwner);
      observedStatus = status;
      if (status === 'absent' && await reclaimAbsentOwner(path, currentOwner.nonce)) continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new ReviewPersistenceError(
        'PERSISTENCE_LOCKED',
        `review ${name} lock is held`,
        { owner_status: observedStatus ?? 'unknown' },
      );
    }
    await waitForChange(path, remaining);
  }
}

export async function acquireReviewLocks(
  paths: ReviewPersistencePaths,
  reviewId: string | undefined,
  requested: readonly ReviewLockName[],
  options: AcquireReviewLocksOptions = {},
): Promise<ReviewLockHandle[]> {
  const rank: Record<ReviewLockName, number> = { start: 0, journal: 1, mutation: 2 };
  if (new Set(requested).size !== requested.length) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'a review lock was requested twice');
  }
  const ordered = [...requested].sort((left, right) => rank[left] - rank[right]);
  const now = options.now ?? (() => performance.now());
  const timeoutMs = Math.min(MAX_LOCK_WAIT_MS, Math.max(0, options.timeoutMs ?? MAX_LOCK_WAIT_MS));
  const deadline = now() + timeoutMs;
  const acquired: ReviewLockHandle[] = [];
  try {
    for (const name of ordered) {
      const handle = await acquireSingleLock(paths, reviewId, name, options, deadline, now);
      acquired.push(handle);
      options.onAcquired?.(name);
    }
    return acquired;
  } catch (error) {
    await releaseReviewLocks(acquired);
    throw error;
  }
}

async function releaseReviewLock(
  handle: ReviewLockHandle,
  options: ReleaseReviewLocksOptions,
): Promise<boolean> {
  const owner = await readLockOwner(handle.path);
  if (owner?.nonce !== handle.nonce) return false;
  await options.afterOwnerRead?.(handle);
  const quarantinePath = `${handle.path}.release-${process.pid}-${randomUUID()}`;
  try {
    await rename(handle.path, quarantinePath);
  } catch {
    return false;
  }
  const movedOwner = await readLockOwner(quarantinePath);
  if (movedOwner?.nonce === handle.nonce) {
    await rm(quarantinePath, { force: true });
    return true;
  }
  try {
    await link(quarantinePath, handle.path);
    await rm(quarantinePath, { force: true });
  } catch {
    // A new owner already occupies the path; retain the quarantined replacement as evidence.
  }
  return false;
}

export async function releaseReviewLocks(
  handles: readonly ReviewLockHandle[],
  options: ReleaseReviewLocksOptions = {},
): Promise<boolean[]> {
  const results = Array.from({ length: handles.length }, () => false);
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    results[index] = await releaseReviewLock(handles[index]!, options);
  }
  return results;
}

export type DurableTransactionStage =
  | 'prepared'
  | 'locator'
  | 'proposal'
  | 'post-tool'
  | 'consume'
  | 'manifest'
  | 'lane'
  | 'review'
  | 'report'
  | 'active-overlay'
  | 'approval'
  | 'stop-marker'
  | 'committed'
  | 'receipt'
  | 'locator-cleanup';
export type DurableTransactionBoundary = `before:${DurableTransactionStage}` | `after:${DurableTransactionStage}`;
export type DurableEffectName = Exclude<
  DurableTransactionStage,
  'prepared' | 'locator' | 'committed' | 'receipt' | 'locator-cleanup'
>;

export interface DurableTransactionEffect {
  name: DurableEffectName;
  mode:
    | 'CREATE_ONCE_JSON'
    | 'APPLY_REVIEW_REVISION'
    | 'UPDATE_MATCHING_ACTIVE'
    | 'RESTORE_MISSING_ACTIVE'
    | 'REMOVE_MATCHING_ACTIVE';
  target: {
    area: 'REVIEW_STATE' | 'FINAL_REVIEWS';
    path: string;
  };
  payload?: unknown;
  review_id?: string;
  expected_status?: ReviewRunStatus;
  expected_revision?: number;
}

export interface CreateReviewConsumptionEffectInput {
  review_id: string;
  idempotency_key: string;
  kind: ReviewConsumptionKind;
  value: string;
  consumed_at: string;
}

export interface DurableTransactionPlan {
  journal_scope?: 'START' | 'REVIEW';
  idempotency_key: string;
  review_id: string;
  operation: string;
  input: unknown;
  expected_revision: number;
  effects: DurableTransactionEffect[];
  response: unknown;
}

export interface DurableTransactionResult {
  state: 'COMMITTED';
  response: unknown;
}

export interface RunDurableTransactionOptions {
  crashAt?: DurableTransactionBoundary;
  crashMode?: 'THROW' | 'SIGKILL';
}

interface PreparedDurableTransaction {
  schema_version: 1;
  state: 'PREPARED';
  transaction_id: string;
  journal_scope: 'START' | 'REVIEW';
  idempotency_key: string;
  input_digest: string;
  operation: string;
  review_id: string;
  input: unknown;
  expected_revision: number;
  effects: DurableTransactionEffect[];
  response: unknown;
  prepared_at: string;
}

interface CommittedDurableTransaction {
  schema_version: 1;
  state: 'COMMITTED';
  transaction_id: string;
  idempotency_key: string;
  input_digest: string;
  response: unknown;
  committed_at: string;
}

interface DurableTransactionLocator {
  schema_version: 1;
  transaction_id: string;
  review_id: string;
  idempotency_key: string;
  input_digest: string;
}

interface CommittedStartReceipt {
  schema_version: 1;
  state: 'COMMITTED';
  transaction_id: string;
  idempotency_key: string;
  request_digest: string;
  review_id: string;
  session_id: string | null;
  response: unknown;
  result_revision: number;
  result_digest: string;
  committed_at: string;
}

interface ReviewConsumptionManifestIntent {
  schema_version: 1;
  review_id: string;
  idempotency_key: string;
  publication_count: number;
  marker_count: number;
  publications: ReviewConsumptionManifestPublication[];
  committed_at: string;
}

const DURABLE_EFFECT_ORDER: readonly DurableEffectName[] = [
  'proposal',
  'post-tool',
  'consume',
  'manifest',
  'lane',
  'review',
  'report',
  'stop-marker',
  'active-overlay',
  'approval',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${field} must be a cryptographic UUID`);
  }
  return value.toLowerCase();
}

function validateRelativePersistencePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction target must be a bounded relative path');
  }
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction target contains an invalid character');
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction target escapes its persistence root');
  }
  return normalized;
}

function validateDurableEffect(value: unknown): DurableTransactionEffect {
  if (!isPlainObject(value) || !isPlainObject(value.target)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effect is malformed');
  }
  const allowedKeys = new Set([
    'name', 'mode', 'target', 'payload', 'review_id', 'expected_status', 'expected_revision',
  ]);
  if (!['name', 'mode', 'target'].every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !hasExactKeys(value.target, ['area', 'path'])) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effect fields are malformed');
  }
  const allowedNames: readonly DurableEffectName[] = DURABLE_EFFECT_ORDER;
  if (!allowedNames.includes(value.name as DurableEffectName)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effect name is invalid');
  }
  if (typeof value.mode !== 'string'
    || !([
      'CREATE_ONCE_JSON',
      'APPLY_REVIEW_REVISION',
      'UPDATE_MATCHING_ACTIVE',
      'RESTORE_MISSING_ACTIVE',
      'REMOVE_MATCHING_ACTIVE',
    ] as const)
      .includes(value.mode as DurableTransactionEffect['mode'])) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effect mode is invalid');
  }
  if (value.target.area !== 'REVIEW_STATE' && value.target.area !== 'FINAL_REVIEWS') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effect area is invalid');
  }
  const effect: DurableTransactionEffect = {
    name: value.name as DurableEffectName,
    mode: value.mode as DurableTransactionEffect['mode'],
    target: {
      area: value.target.area,
      path: validateRelativePersistencePath(value.target.path),
    },
    ...(value.payload === undefined ? {} : { payload: sanitizeForPersistence(value.payload) }),
    ...(value.review_id === undefined ? {} : { review_id: validateUuid(value.review_id, 'effect review_id') }),
    ...(value.expected_status === undefined ? {} : {
      expected_status: requirePayloadEnum(
        value.expected_status,
        'effect expected_status',
        REVIEW_RUN_STATUSES,
      ),
    }),
    ...(value.expected_revision === undefined ? {} : {
      expected_revision: requireNonNegativeInteger(value.expected_revision, 'effect expected_revision'),
    }),
  };
  if (effect.mode === 'APPLY_REVIEW_REVISION' && (
    effect.name !== 'review'
    || !isPlainObject(effect.payload)
    || effect.review_id !== undefined
    || effect.expected_status !== undefined
    || effect.expected_revision !== undefined
  )) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review revision effect is invalid');
  }
  if ((effect.mode === 'UPDATE_MATCHING_ACTIVE'
      || effect.mode === 'RESTORE_MISSING_ACTIVE'
      || effect.mode === 'REMOVE_MATCHING_ACTIVE') && (
    effect.name !== 'active-overlay'
    || !effect.review_id
    || effect.expected_status === undefined
    || effect.expected_revision === undefined
    || ((effect.mode === 'UPDATE_MATCHING_ACTIVE' || effect.mode === 'RESTORE_MISSING_ACTIVE')
      && !isPlainObject(effect.payload))
    || (effect.mode === 'REMOVE_MATCHING_ACTIVE' && effect.payload !== undefined)
  )) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active transition requires an exact expected state');
  }
  if (effect.mode === 'CREATE_ONCE_JSON' && (
    effect.payload === undefined
    || effect.review_id !== undefined
    || effect.expected_status !== undefined
    || effect.expected_revision !== undefined
  )) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'create-once effect requires a payload');
  }
  return effect;
}

function requireExactPayload(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} payload is malformed`);
  }
  return value;
}

function requirePayloadString(value: unknown, name: string, maximum = 1_024): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maximum || value.includes('\0')) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return value;
}

function requirePayloadTimestamp(value: unknown, name: string): string {
  const timestamp = requirePayloadString(value, name, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return timestamp;
}

function requirePayloadHash(value: unknown, name: string): string {
  const digest = requirePayloadString(value, name, 64);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return digest;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return value as number;
}

function requirePayloadBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return value;
}

function requirePayloadEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return value as T;
}

function reviewConsumptionDigest(kind: ReviewConsumptionKind, value: string): string {
  return createHash('sha256')
    .update('omx-code-review-consumption\0', 'utf8')
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

export function createReviewConsumptionEffect(
  input: CreateReviewConsumptionEffectInput,
): DurableTransactionEffect {
  if (!isPlainObject(input) || !hasExactKeys(input, [
    'review_id', 'idempotency_key', 'kind', 'value', 'consumed_at',
  ])) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption input is malformed');
  }
  const reviewId = validateUuid(input.review_id, 'consumption review_id');
  const idempotencyKey = validateUuid(input.idempotency_key, 'consumption idempotency_key');
  const kind = requirePayloadEnum(input.kind, 'consumption kind', REVIEW_CONSUMPTION_KINDS);
  const value = requirePayloadString(input.value, 'consumption value');
  if (/[\r\n]/u.test(value)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption value is invalid');
  }
  const consumedAt = requirePayloadTimestamp(input.consumed_at, 'consumption consumed_at');
  const valueSha256 = reviewConsumptionDigest(kind, value);
  return {
    name: 'consume',
    mode: 'CREATE_ONCE_JSON',
    target: {
      area: 'REVIEW_STATE',
      path: `${reviewId}/consumptions/${REVIEW_CONSUMPTION_DIRECTORIES[kind]}/${valueSha256}.json`,
    },
    payload: {
      schema_version: 1,
      state: 'CONSUMED',
      review_id: reviewId,
      kind,
      value_sha256: valueSha256,
      idempotency_key: idempotencyKey,
      consumed_at: consumedAt,
    } satisfies ReviewConsumptionMarker,
  };
}

function validateReviewConsumptionMarker(
  value: unknown,
  expectedReviewId?: string,
  expectedIdempotencyKey?: string,
): ReviewConsumptionMarker {
  const marker = requireExactPayload(value, [
    'schema_version', 'state', 'review_id', 'kind', 'value_sha256',
    'idempotency_key', 'consumed_at',
  ], 'review consumption');
  const reviewId = validateUuid(marker.review_id, 'consumption review_id');
  const idempotencyKey = validateUuid(marker.idempotency_key, 'consumption idempotency_key');
  const kind = requirePayloadEnum(marker.kind, 'consumption kind', REVIEW_CONSUMPTION_KINDS);
  const valueSha256 = requirePayloadHash(marker.value_sha256, 'consumption value_sha256');
  const consumedAt = requirePayloadTimestamp(marker.consumed_at, 'consumption consumed_at');
  if (marker.schema_version !== 1 || marker.state !== 'CONSUMED'
    || (expectedReviewId !== undefined && reviewId !== expectedReviewId)
    || (expectedIdempotencyKey !== undefined && idempotencyKey !== expectedIdempotencyKey)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption identity conflicts');
  }
  return {
    schema_version: 1,
    state: 'CONSUMED',
    review_id: reviewId,
    kind,
    value_sha256: valueSha256,
    idempotency_key: idempotencyKey,
    consumed_at: consumedAt,
  };
}

function validateConsumptionMarkerRef(value: unknown): ReviewConsumptionManifestMarkerRef {
  const ref = requireExactPayload(value, ['kind', 'value_sha256', 'path'], 'consumption manifest marker ref');
  const kind = requirePayloadEnum(ref.kind, 'manifest marker kind', REVIEW_CONSUMPTION_KINDS);
  const valueSha256 = requirePayloadHash(ref.value_sha256, 'manifest marker digest');
  const path = validateRelativePersistencePath(ref.path);
  return { kind, value_sha256: valueSha256, path };
}

function validateConsumptionManifestPublications(value: unknown): ReviewConsumptionManifestPublication[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest publications are invalid');
  }
  const publications = value.map((item) => {
    const publication = requireExactPayload(item, ['publication_id', 'markers'], 'consumption manifest publication');
    const publicationId = validateUuid(publication.publication_id, 'manifest publication_id');
    if (!Array.isArray(publication.markers) || publication.markers.length !== REVIEW_CONSUMPTION_KINDS.length) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest marker refs are invalid');
    }
    const markers = publication.markers.map(validateConsumptionMarkerRef);
    if (markers.some((marker, index) => marker.kind !== REVIEW_CONSUMPTION_KINDS[index])) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest marker refs are reordered');
    }
    return {
      publication_id: publicationId,
      markers: markers as ReviewConsumptionManifestPublication['markers'],
    };
  });
  if (new Set(publications.map((publication) => publication.publication_id)).size !== publications.length) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest publication is duplicated');
  }
  return publications;
}

function validateConsumptionManifestIntent(
  value: unknown,
  reviewId: string,
  idempotencyKey: string,
): ReviewConsumptionManifestIntent {
  const manifest = requireExactPayload(value, [
    'schema_version', 'review_id', 'idempotency_key', 'publication_count', 'marker_count',
    'publications', 'committed_at',
  ], 'consumption manifest');
  const publications = validateConsumptionManifestPublications(manifest.publications);
  if (manifest.schema_version !== 1
    || validateUuid(manifest.review_id, 'manifest review_id') !== reviewId
    || validateUuid(manifest.idempotency_key, 'manifest idempotency_key') !== idempotencyKey
    || requirePositiveInteger(manifest.publication_count, 'manifest publication_count') !== publications.length
    || requirePositiveInteger(manifest.marker_count, 'manifest marker_count')
      !== publications.length * REVIEW_CONSUMPTION_KINDS.length) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest identity conflicts');
  }
  return {
    schema_version: 1,
    review_id: reviewId,
    idempotency_key: idempotencyKey,
    publication_count: publications.length,
    marker_count: publications.length * REVIEW_CONSUMPTION_KINDS.length,
    publications,
    committed_at: requirePayloadTimestamp(manifest.committed_at, 'manifest committed_at'),
  };
}

function validateConsumptionManifest(value: unknown): ReviewConsumptionManifest {
  const manifest = requireExactPayload(value, [
    'schema_version', 'state', 'review_id', 'transaction_id', 'idempotency_key',
    'publication_count', 'marker_count', 'publications', 'committed_at',
  ], 'committed consumption manifest');
  const intent = validateConsumptionManifestIntent({
    schema_version: manifest.schema_version,
    review_id: manifest.review_id,
    idempotency_key: manifest.idempotency_key,
    publication_count: manifest.publication_count,
    marker_count: manifest.marker_count,
    publications: manifest.publications,
    committed_at: manifest.committed_at,
  }, validateUuid(manifest.review_id, 'manifest review_id'), validateUuid(manifest.idempotency_key, 'manifest idempotency_key'));
  if (manifest.state !== 'COMMITTED') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest is not committed');
  }
  return {
    ...intent,
    state: 'COMMITTED',
    transaction_id: validateUuid(manifest.transaction_id, 'manifest transaction_id'),
  };
}

function requireStructuredPayload(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!isPlainObject(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} payload is malformed`);
  }
  return value;
}

function requirePayloadStringArray(value: unknown, name: string, maximum = 5_000): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  return value.map((item) => requirePayloadString(item, name));
}

function validateReasonArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 5_000) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
  try {
    return value.map(validateReviewReason);
  } catch {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${name} is invalid`);
  }
}

function validateReviewVerdictPayload(value: unknown): void {
  const verdict = requireExactPayload(value, [
    'recommendation', 'architectural_status', 'scope_status', 'evidence_status',
    'rule_id', 'reasons', 'clean',
  ], 'review verdict');
  requirePayloadEnum(verdict.recommendation, 'review verdict recommendation', ['APPROVE', 'COMMENT', 'REQUEST CHANGES'] as const);
  requirePayloadEnum(verdict.architectural_status, 'review verdict architecture', ['CLEAR', 'WATCH', 'BLOCK'] as const);
  requirePayloadEnum(verdict.scope_status, 'review verdict scope', ['FULL_SCOPE', 'PARTIAL_SCOPE'] as const);
  requirePayloadEnum(verdict.evidence_status, 'review verdict evidence', ['FULL_EVIDENCE', 'DEGRADED_EVIDENCE'] as const);
  requirePayloadString(verdict.rule_id, 'review verdict rule_id', 160);
  validateReasonArray(verdict.reasons, 'review verdict reasons');
  requirePayloadBoolean(verdict.clean, 'review verdict clean');
}

function validateScopePayload(value: unknown): void {
  const scope = requireStructuredPayload(value, [
    'selector', 'status', 'scope_hash', 'files', 'changed_lines', 'reasons',
  ], ['base_ref', 'base_sha', 'head_sha'], 'review scope');
  const selector = requireStructuredPayload(scope.selector, ['explicit_paths'], ['requested_base'], 'scope selector');
  requirePayloadStringArray(selector.explicit_paths, 'scope explicit paths');
  if (selector.requested_base !== undefined) requirePayloadString(selector.requested_base, 'scope requested_base');
  requirePayloadEnum(scope.status, 'scope status', ['FULL_SCOPE', 'PARTIAL_SCOPE'] as const);
  requirePayloadHash(scope.scope_hash, 'scope hash');
  if (!Array.isArray(scope.files) || scope.files.length > 5_000) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'scope files are invalid');
  }
  for (const item of scope.files) {
    const file = requireStructuredPayload(item, ['path', 'change', 'sources', 'binary'], [
      'previous_path', 'additions', 'deletions',
    ], 'scope file');
    requirePayloadString(file.path, 'scope file path');
    if (file.previous_path !== undefined) requirePayloadString(file.previous_path, 'scope previous path');
    requirePayloadEnum(file.change, 'scope file change', [
      'ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED',
      'UNMERGED', 'SUBMODULE', 'SYMLINK',
    ] as const);
    const sources = requirePayloadStringArray(file.sources, 'scope file sources', 4);
    if (sources.length === 0 || sources.some((source) => !['BASE', 'INDEX', 'WORKTREE', 'UNTRACKED'].includes(source))) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'scope file sources are invalid');
    }
    requirePayloadBoolean(file.binary, 'scope file binary');
    if (file.additions !== undefined) requireNonNegativeInteger(file.additions, 'scope additions');
    if (file.deletions !== undefined) requireNonNegativeInteger(file.deletions, 'scope deletions');
  }
  requireNonNegativeInteger(scope.changed_lines, 'scope changed_lines');
  validateReasonArray(scope.reasons, 'scope reasons');
  for (const key of ['base_ref', 'base_sha', 'head_sha'] as const) {
    if (scope[key] !== undefined) requirePayloadString(scope[key], `scope ${key}`);
  }
}

function validateBatchPayload(value: unknown): void {
  const batch = requireExactPayload(value, [
    'batch_id', 'module_root', 'files', 'changed_lines', 'oversized_single_file',
  ], 'review batch');
  requirePayloadString(batch.batch_id, 'review batch_id', 160);
  requirePayloadString(batch.module_root, 'review batch module_root');
  requirePayloadStringArray(batch.files, 'review batch files');
  requireNonNegativeInteger(batch.changed_lines, 'review batch changed_lines');
  requirePayloadBoolean(batch.oversized_single_file, 'review batch oversized_single_file');
}

function validateLanePayload(value: unknown): void {
  const lane = requireStructuredPayload(value, [
    'lane_id', 'role', 'batch_id', 'scope_hash', 'status', 'attempt', 'timeout_ms',
    'idle_deadline_at', 'findings', 'diagnostic_ids',
  ], [
    'last_heartbeat_at', 'last_processed_activity_ref', 'last_processed_activity_at',
    'provenance', 'recommendation', 'architectural_status', 'failure_code',
  ], 'review lane');
  const role = requirePayloadEnum(lane.role, 'lane role', ['code-reviewer', 'architect'] as const);
  requirePayloadString(lane.lane_id, 'lane_id', 160);
  const batchId = requirePayloadString(lane.batch_id, 'lane batch_id', 160);
  requirePayloadHash(lane.scope_hash, 'lane scope_hash');
  requirePayloadEnum(lane.status, 'lane status', ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'TIMED_OUT', 'INVALID'] as const);
  requirePositiveInteger(lane.attempt, 'lane attempt');
  requirePositiveInteger(lane.timeout_ms, 'lane timeout_ms');
  requirePayloadTimestamp(lane.idle_deadline_at, 'lane idle_deadline_at');
  for (const key of ['last_heartbeat_at', 'last_processed_activity_at'] as const) {
    if (lane[key] !== undefined) requirePayloadTimestamp(lane[key], `lane ${key}`);
  }
  if (lane.last_processed_activity_ref !== undefined) {
    requirePayloadString(lane.last_processed_activity_ref, 'lane last_processed_activity_ref');
  }
  if (!Array.isArray(lane.findings) || lane.findings.length > 200) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane findings are invalid');
  }
  try {
    lane.findings.forEach(validateReviewFinding);
  } catch {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane finding is invalid');
  }
  requirePayloadStringArray(lane.diagnostic_ids, 'lane diagnostic_ids', 256);
  if (role === 'architect') {
    if (batchId !== 'global' || lane.recommendation !== undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'architect lane role fields are invalid');
    }
    if (lane.architectural_status !== undefined) {
      requirePayloadEnum(lane.architectural_status, 'lane architectural_status', ['CLEAR', 'WATCH', 'BLOCK'] as const);
    }
  } else {
    if (lane.architectural_status !== undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'reviewer lane role fields are invalid');
    }
    if (lane.recommendation !== undefined) {
      requirePayloadEnum(lane.recommendation, 'lane recommendation', ['APPROVE', 'COMMENT', 'REQUEST CHANGES'] as const);
    }
  }
  if (lane.failure_code !== undefined) requirePayloadString(lane.failure_code, 'lane failure_code', 160);
  if (lane.provenance !== undefined) {
    const provenance = requireStructuredPayload(lane.provenance, [
      'session_id', 'thread_id', 'tracker_lane_id', 'tracker_path', 'first_seen_at',
    ], ['last_seen_at', 'completed_at', 'agent_id'], 'lane provenance');
    for (const key of ['session_id', 'thread_id', 'tracker_lane_id', 'tracker_path'] as const) {
      requirePayloadString(provenance[key], `provenance ${key}`);
    }
    requirePayloadTimestamp(provenance.first_seen_at, 'provenance first_seen_at');
    for (const key of ['last_seen_at', 'completed_at'] as const) {
      if (provenance[key] !== undefined) requirePayloadTimestamp(provenance[key], `provenance ${key}`);
    }
    if (provenance.agent_id !== undefined) requirePayloadString(provenance.agent_id, 'provenance agent_id');
  }
}

function validateAttemptPayload(value: unknown): void {
  const attempt = requireStructuredPayload(value, [
    'attempt', 'status', 'bindings', 'lane_ids', 'started_at', 'updated_at', 'resumable',
  ], ['finalized_at', 'verdict', 'resumable_reason'], 'review attempt');
  requirePositiveInteger(attempt.attempt, 'attempt number');
  requirePayloadEnum(attempt.status, 'attempt status', REVIEW_RUN_STATUSES);
  if (!Array.isArray(attempt.bindings) || attempt.bindings.length > 5_000) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'attempt bindings are invalid');
  }
  for (const item of attempt.bindings) {
    const binding = requireStructuredPayload(item, [
      'lane_id', 'attempt', 'role', 'batch_id',
    ], ['thread_id'], 'lane binding');
    requirePayloadString(binding.lane_id, 'binding lane_id', 160);
    requirePositiveInteger(binding.attempt, 'binding attempt');
    requirePayloadEnum(binding.role, 'binding role', ['code-reviewer', 'architect'] as const);
    requirePayloadString(binding.batch_id, 'binding batch_id', 160);
    if (binding.thread_id !== undefined) requirePayloadString(binding.thread_id, 'binding thread_id', 160);
  }
  requirePayloadStringArray(attempt.lane_ids, 'attempt lane_ids');
  requirePayloadTimestamp(attempt.started_at, 'attempt started_at');
  requirePayloadTimestamp(attempt.updated_at, 'attempt updated_at');
  if (attempt.finalized_at !== undefined) requirePayloadTimestamp(attempt.finalized_at, 'attempt finalized_at');
  if (attempt.verdict !== undefined) validateReviewVerdictPayload(attempt.verdict);
  requirePayloadBoolean(attempt.resumable, 'attempt resumable');
  if (attempt.resumable_reason !== undefined) {
    requirePayloadEnum(attempt.resumable_reason, 'attempt resumable_reason', [
      'LANE_FAILED', 'LANE_TIMED_OUT', 'LANE_EVIDENCE_INVALID', 'MISSING_LANE', 'MCP_TRANSPORT_DEAD',
    ] as const);
  }
}

function validateReviewRecordPayload(
  value: unknown,
  reviewId: string,
  revision: number,
): ReviewRecord {
  const record = requireStructuredPayload(value, [
    'schema_version', 'revision', 'review_id', 'status', 'current_attempt',
    'effective_config', 'review_flags', 'batches', 'lanes', 'attempt_history',
    'diagnostics', 'resumable', 'created_at', 'updated_at',
  ], [
    'last_applied_transaction_id', 'session_id', 'root_thread_id', 'invocation_turn_id',
    'scope', 'verdict', 'resumable_reason', 'finalized_at', 'supersedes_review_id',
  ], 'review record');
  if (record.schema_version !== 1
    || validateUuid(record.review_id, 'review record review_id') !== reviewId
    || requirePositiveInteger(record.revision, 'review record revision') !== revision) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review record identity or revision conflicts');
  }
  requirePayloadEnum(record.status, 'review record status', REVIEW_RUN_STATUSES);
  requirePositiveInteger(record.current_attempt, 'review current_attempt');
  const config = requireExactPayload(record.effective_config, [
    'lane_timeout_ms', 'max_files_per_review', 'max_changed_lines_per_review', 'accepted_equivalents',
  ], 'effective review config');
  requirePositiveInteger(config.lane_timeout_ms, 'config lane_timeout_ms');
  requirePositiveInteger(config.max_files_per_review, 'config max_files_per_review');
  requirePositiveInteger(config.max_changed_lines_per_review, 'config max_changed_lines_per_review');
  if (!Array.isArray(config.accepted_equivalents) || config.accepted_equivalents.length > 128) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'accepted equivalents are invalid');
  }
  for (const item of config.accepted_equivalents) {
    const equivalent = requireExactPayload(item, [
      'capability', 'program', 'args', 'source', 'source_ref',
    ], 'accepted equivalent');
    requirePayloadEnum(equivalent.capability, 'equivalent capability', ['LSP', 'AST'] as const);
    requirePayloadString(equivalent.program, 'equivalent program');
    requirePayloadStringArray(equivalent.args, 'equivalent args', 128);
    requirePayloadEnum(equivalent.source, 'equivalent source', ['EXPLICIT_USER', 'REPO_CONTRACT'] as const);
    requirePayloadString(equivalent.source_ref, 'equivalent source_ref');
  }
  if (!Array.isArray(record.review_flags)
    || record.review_flags.some((flag) => flag !== 'BATCHED_REVIEW')
    || new Set(record.review_flags).size !== record.review_flags.length) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review flags are invalid');
  }
  if (!Array.isArray(record.batches) || !Array.isArray(record.lanes)
    || !Array.isArray(record.attempt_history) || !Array.isArray(record.diagnostics)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review record collections are invalid');
  }
  record.batches.forEach(validateBatchPayload);
  record.lanes.forEach(validateLanePayload);
  record.attempt_history.forEach(validateAttemptPayload);
  try {
    record.diagnostics = validateReviewDiagnostics(record.diagnostics, { includeThreadId: true });
  } catch {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review diagnostics are invalid');
  }
  if (record.scope !== undefined) validateScopePayload(record.scope);
  if (record.verdict !== undefined) validateReviewVerdictPayload(record.verdict);
  requirePayloadBoolean(record.resumable, 'review resumable');
  if (record.resumable_reason !== undefined) {
    requirePayloadEnum(record.resumable_reason, 'review resumable_reason', [
      'LANE_FAILED', 'LANE_TIMED_OUT', 'LANE_EVIDENCE_INVALID', 'MISSING_LANE', 'MCP_TRANSPORT_DEAD',
    ] as const);
  }
  requirePayloadTimestamp(record.created_at, 'review created_at');
  requirePayloadTimestamp(record.updated_at, 'review updated_at');
  if (record.finalized_at !== undefined) requirePayloadTimestamp(record.finalized_at, 'review finalized_at');
  for (const key of ['session_id', 'root_thread_id', 'invocation_turn_id'] as const) {
    if (record[key] !== undefined) requirePayloadString(record[key], `review ${key}`);
  }
  for (const key of ['last_applied_transaction_id', 'supersedes_review_id'] as const) {
    if (record[key] !== undefined) validateUuid(record[key], `review ${key}`);
  }
  const validated = record as unknown as ReviewRecord;
  try {
    validateReviewTopology({
      scope: validated.scope,
      batches: validated.batches,
      lanes: validated.lanes,
      diagnostics: validated.diagnostics,
    });
  } catch {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review topology is invalid');
  }
  return validated;
}

function validateLaneResultPayload(
  value: unknown,
  expected: { reviewId: string; laneId: string; attempt: number; scopeHash?: string },
): void {
  const base = requireExactPayload(value, (isPlainObject(value) && value.role === 'architect')
    ? ['role', 'review_id', 'attempt', 'lane_id', 'batch_id', 'scope_hash', 'architectural_status', 'findings']
    : ['role', 'review_id', 'attempt', 'lane_id', 'batch_id', 'scope_hash', 'recommendation', 'findings', 'diagnostics'], 'lane result');
  if ((base.role !== 'code-reviewer' && base.role !== 'architect')
    || validateUuid(base.review_id, 'lane result review_id') !== expected.reviewId
    || requirePositiveInteger(base.attempt, 'lane result attempt') !== expected.attempt
    || requirePayloadString(base.lane_id, 'lane result lane_id', 160) !== expected.laneId
    || (expected.scopeHash !== undefined
      && requirePayloadHash(base.scope_hash, 'lane result scope_hash') !== expected.scopeHash)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane result identity conflicts');
  }
  requirePayloadHash(base.scope_hash, 'lane result scope_hash');
  requirePayloadString(base.batch_id, 'lane result batch_id', 160);
  if (!Array.isArray(base.findings) || base.findings.length > 200) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane result findings are invalid');
  }
  try {
    base.findings.forEach(validateReviewFinding);
  } catch {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane result finding is invalid');
  }
  if (base.role === 'architect') {
    if (base.batch_id !== 'global') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'architect lane result is invalid');
    }
    requirePayloadEnum(
      base.architectural_status,
      'architectural_status',
      ['CLEAR', 'WATCH', 'BLOCK'] as const,
    );
  } else {
    requirePayloadEnum(
      base.recommendation,
      'recommendation',
      ['APPROVE', 'COMMENT', 'REQUEST CHANGES'] as const,
    );
    try {
      base.diagnostics = validateReviewDiagnostics(base.diagnostics, { includeThreadId: false });
    } catch {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'reviewer lane diagnostics are invalid');
    }
  }
}

function validateTypedEffectPayload(
  effect: DurableTransactionEffect,
  reviewId: string,
  idempotencyKey: string,
  expectedRevision: number,
): void {
  if (effect.name === 'review') {
    if (effect.mode !== 'APPLY_REVIEW_REVISION'
      || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== `${reviewId}/review.json`
      || effect.review_id !== undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review effect target is invalid');
    }
    effect.payload = validateReviewRecordPayload(effect.payload, reviewId, expectedRevision + 1);
    return;
  }
  if (effect.name === 'active-overlay') {
    if (effect.target.area !== 'REVIEW_STATE' || effect.target.path !== 'active.json') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay target is invalid');
    }
    if (effect.mode === 'REMOVE_MATCHING_ACTIVE') {
      if (effect.payload !== undefined || effect.review_id !== reviewId
        || effect.expected_revision !== expectedRevision) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active cleanup identity conflicts');
      }
      return;
    }
    if (effect.mode !== 'CREATE_ONCE_JSON'
      && effect.mode !== 'UPDATE_MATCHING_ACTIVE'
      && effect.mode !== 'RESTORE_MISSING_ACTIVE') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay effect is invalid');
    }
    if ((effect.mode === 'UPDATE_MATCHING_ACTIVE' || effect.mode === 'RESTORE_MISSING_ACTIVE') && (
      effect.review_id !== reviewId || effect.expected_revision !== expectedRevision
    )) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active update identity conflicts');
    }
    const pointer = validateActivePointer(effect.payload);
    if (pointer.review_id !== reviewId) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay review identity conflicts');
    }
    effect.payload = pointer;
    return;
  }
  if (effect.name === 'proposal') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'proposal effect target is invalid');
    }
    const proposal = requireExactPayload(effect.payload, [
      'schema_version', 'state', 'review_id', 'attempt', 'lane_id', 'scope_hash',
      'idempotency_key', 'payload_digest', 'result', 'proposed_at',
    ], 'proposal');
    const attempt = requirePositiveInteger(proposal.attempt, 'proposal attempt');
    const laneId = requirePayloadString(proposal.lane_id, 'proposal lane_id', 160);
    const scopeHash = requirePayloadHash(proposal.scope_hash, 'proposal scope_hash');
    const proposalId = validateUuid(proposal.idempotency_key, 'proposal idempotency_key');
    if (proposal.schema_version !== 1 || proposal.state !== 'PENDING_HOST_ATTESTATION'
      || validateUuid(proposal.review_id, 'proposal review_id') !== reviewId
      || effect.target.path !== `${reviewId}/submissions/${proposalId}/proposal`) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'proposal identity conflicts');
    }
    requirePayloadHash(proposal.payload_digest, 'proposal payload_digest');
    requirePayloadTimestamp(proposal.proposed_at, 'proposal proposed_at');
    validateLaneResultPayload(proposal.result, { reviewId, laneId, attempt, scopeHash });
    return;
  }
  if (effect.name === 'post-tool') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool effect target is invalid');
    }
    const publication = requireExactPayload(effect.payload, [
      'schema_version', 'publication_id', 'published_at', 'activity', 'attestation',
    ], 'post-tool');
    const activity = requireExactPayload(publication.activity, [
      'schema_version', 'session_id', 'review_id', 'attempt', 'lane_id', 'child_thread_id',
      'event_ref', 'event_kind', 'observed_at',
    ], 'post-tool activity');
    const attestation = requireExactPayload(publication.attestation, [
      'schema_version', 'session_id', 'root_thread_id', 'review_id', 'attempt', 'lane_id',
      'child_thread_id', 'scope_hash', 'payload_digest', 'tool_event_ref', 'nonce', 'published_at',
    ], 'post-tool attestation');
    const publicationId = validateUuid(publication.publication_id, 'publication_id');
    const activitySessionId = requirePayloadString(activity.session_id, 'activity session_id', 160);
    const attestationSessionId = requirePayloadString(attestation.session_id, 'attestation session_id', 160);
    const attempt = requirePositiveInteger(activity.attempt, 'activity attempt');
    const attestationAttempt = requirePositiveInteger(attestation.attempt, 'attestation attempt');
    const laneId = requirePayloadString(activity.lane_id, 'activity lane_id', 160);
    const attestationLaneId = requirePayloadString(attestation.lane_id, 'attestation lane_id', 160);
    const childThreadId = requirePayloadString(activity.child_thread_id, 'activity child_thread_id', 160);
    const attestationChildThreadId = requirePayloadString(
      attestation.child_thread_id,
      'attestation child_thread_id',
      160,
    );
    const eventRef = requirePayloadString(activity.event_ref, 'activity event_ref');
    const toolEventRef = requirePayloadString(attestation.tool_event_ref, 'attestation tool_event_ref');
    requirePayloadString(attestation.root_thread_id, 'attestation root_thread_id', 160);
    requirePayloadString(attestation.nonce, 'attestation nonce', 160);
    if (publication.schema_version !== 1 || activity.schema_version !== 1 || attestation.schema_version !== 1
      || activity.event_kind !== 'RESULT_POST_TOOL'
      || effect.target.path !== `${reviewId}/submissions/${publicationId}/post-tool`
      || validateUuid(activity.review_id, 'activity review_id') !== reviewId
      || validateUuid(attestation.review_id, 'attestation review_id') !== reviewId
      || activitySessionId !== attestationSessionId
      || attempt !== attestationAttempt || laneId !== attestationLaneId
      || childThreadId !== attestationChildThreadId
      || eventRef !== toolEventRef) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool identity conflicts');
    }
    requirePayloadTimestamp(publication.published_at, 'published_at');
    requirePayloadTimestamp(activity.observed_at, 'activity observed_at');
    requirePayloadHash(attestation.scope_hash, 'attestation scope_hash');
    requirePayloadHash(attestation.payload_digest, 'attestation payload_digest');
    requirePayloadTimestamp(attestation.published_at, 'attestation published_at');
    return;
  }
  if (effect.name === 'consume') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consume effect target is invalid');
    }
    if (effect.target.path === `${reviewId}/submissions/${idempotencyKey}/consumed`) {
      const consumed = requireExactPayload(effect.payload, [
        'schema_version', 'state', 'review_id', 'idempotency_key', 'consumed_at',
      ], effect.name);
      if (consumed.schema_version !== 1 || consumed.state !== 'CONSUMED'
        || validateUuid(consumed.review_id, 'consume review_id') !== reviewId
        || validateUuid(consumed.idempotency_key, 'consume idempotency_key') !== idempotencyKey) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consume identity conflicts');
      }
      requirePayloadTimestamp(consumed.consumed_at, 'consume consumed_at');
      return;
    }
    const marker = validateReviewConsumptionMarker(effect.payload, reviewId, idempotencyKey);
    const expectedPath = `${reviewId}/consumptions/${REVIEW_CONSUMPTION_DIRECTORIES[marker.kind]}/${marker.value_sha256}.json`;
    if (effect.target.path !== expectedPath) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption target conflicts');
    }
    effect.payload = marker;
    return;
  }
  if (effect.name === 'manifest') {
    if (effect.mode !== 'CREATE_ONCE_JSON'
      || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== `${reviewId}/consumptions/manifests/${idempotencyKey}.json`) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest target conflicts');
    }
    effect.payload = validateConsumptionManifestIntent(effect.payload, reviewId, idempotencyKey);
    return;
  }
  if (effect.name === 'approval') {
    const expectedPath = `approvals/${idempotencyKey}/consumed`;
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== expectedPath) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'approval effect target is invalid');
    }
    const consumed = requireExactPayload(effect.payload, [
      'schema_version', 'state', 'review_id', 'idempotency_key', 'consumed_at',
    ], 'approval');
    if (consumed.schema_version !== 1 || consumed.state !== 'CONSUMED'
      || validateUuid(consumed.review_id, 'approval review_id') !== reviewId
      || validateUuid(consumed.idempotency_key, 'approval idempotency_key') !== idempotencyKey) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'approval identity conflicts');
    }
    requirePayloadTimestamp(consumed.consumed_at, 'approval consumed_at');
    return;
  }
  if (effect.name === 'lane') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE'
      || !effect.target.path.startsWith(`${reviewId}/lanes/`)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane effect target is invalid');
    }
    if (!isPlainObject(effect.payload) || (effect.payload.event !== 'START' && effect.payload.event !== 'RESULT')) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane event is malformed');
    }
    const isStart = effect.payload.event === 'START';
    const event = requireExactPayload(effect.payload, isStart
      ? ['event', 'review_id', 'attempt', 'lane_id', 'thread_id', 'idempotency_key']
      : ['event', 'review_id', 'attempt', 'lane_id', 'scope_hash', 'result', 'idempotency_key'], 'lane event');
    const attempt = requirePositiveInteger(event.attempt, 'lane event attempt');
    const laneId = requirePayloadString(event.lane_id, 'lane event lane_id', 160);
    const expectedPath = `${reviewId}/lanes/${laneId}-attempt-${attempt}/${isStart ? 'start' : 'terminal'}`;
    if (validateUuid(event.review_id, 'lane event review_id') !== reviewId
      || validateUuid(event.idempotency_key, 'lane event idempotency_key') !== idempotencyKey
      || effect.target.path !== expectedPath) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'lane event identity conflicts');
    }
    if (isStart) requirePayloadString(event.thread_id, 'lane event thread_id', 160);
    else {
      const scopeHash = requirePayloadHash(event.scope_hash, 'lane event scope_hash');
      validateLaneResultPayload(event.result, { reviewId, laneId, attempt, scopeHash });
    }
    return;
  }
  if (effect.name === 'stop-marker') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== 'stop-terminal-brief.json') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'Stop marker target is invalid');
    }
    const marker = requireExactPayload(effect.payload, [
      'schema_version', 'state', 'review_id', 'created_at',
    ], 'Stop marker');
    if (marker.schema_version !== 1 || marker.state !== 'PENDING_BRIEF'
      || validateUuid(marker.review_id, 'Stop marker review_id') !== reviewId) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'Stop marker identity conflicts');
    }
    requirePayloadTimestamp(marker.created_at, 'Stop marker created_at');
  }
}

function validatePostToolProposalBinding(
  effects: DurableTransactionEffect[],
  transactionIdempotencyKey: string,
): void {
  const postTools = effects.filter((effect) => effect.name === 'post-tool');
  const proposals = effects.filter((effect) => effect.name === 'proposal');
  if (postTools.length === 0) {
    if (proposals.length > 1
      || (proposals.length === 1
        && (proposals[0]!.payload as { idempotency_key?: unknown }).idempotency_key !== transactionIdempotencyKey)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'proposal-only transaction identity conflicts');
    }
    return;
  }
  if (postTools.length > 16 || proposals.length !== postTools.length) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool proposal topology is invalid');
  }
  const proposalsById = new Map<string, DurableTransactionEffect>();
  for (const proposal of proposals) {
    if (!isPlainObject(proposal.payload) || typeof proposal.payload.idempotency_key !== 'string'
      || proposalsById.has(proposal.payload.idempotency_key)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool proposal identity is duplicated');
    }
    proposalsById.set(proposal.payload.idempotency_key, proposal);
  }
  const seenPublications = new Set<string>();
  for (const postTool of postTools) {
    if (!isPlainObject(postTool.payload) || typeof postTool.payload.publication_id !== 'string'
      || seenPublications.has(postTool.payload.publication_id)
      || !isPlainObject(postTool.payload.activity)
      || !isPlainObject(postTool.payload.attestation)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool publication has no unique proposal binding');
    }
    seenPublications.add(postTool.payload.publication_id);
    const proposal = proposalsById.get(postTool.payload.publication_id);
    if (!proposal || !isPlainObject(proposal.payload)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool publication has no proposal binding');
    }
    const activity = postTool.payload.activity;
    const attestation = postTool.payload.attestation;
    if (activity.attempt !== proposal.payload.attempt
      || activity.lane_id !== proposal.payload.lane_id
      || attestation.scope_hash !== proposal.payload.scope_hash
      || attestation.payload_digest !== proposal.payload.payload_digest) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool publication conflicts with its proposal');
    }
  }
}

function validateActiveOverlayBinding(
  effects: DurableTransactionEffect[],
  journalScope: 'START' | 'REVIEW',
  expectedRevision: number,
): void {
  const activeEffects = effects.filter((effect) => effect.name === 'active-overlay');
  if (activeEffects.length === 0) return;
  if (activeEffects.length !== 1) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction has multiple active overlay effects');
  }
  const reviewEffects = effects.filter((effect) => effect.name === 'review');
  if (reviewEffects.length !== 1) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay transition requires one review effect');
  }
  const activeEffect = activeEffects[0]!;
  const review = reviewEffects[0]!.payload as ReviewRecord;
  if (activeEffect.mode === 'CREATE_ONCE_JSON') {
    const pointer = activeEffect.payload as ActiveReviewPointer;
    if (journalScope !== 'START' || expectedRevision !== 0
      || pointer.status !== review.status
      || TERMINAL_REVIEW_STATUSES.includes(review.status)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'initial active overlay does not match its review');
    }
    return;
  }
  if (journalScope !== 'REVIEW'
    || activeEffect.expected_revision !== expectedRevision
    || activeEffect.expected_status === undefined) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay expected state is invalid');
  }
  if (activeEffect.mode === 'RESTORE_MISSING_ACTIVE') {
    const pointer = activeEffect.payload as ActiveReviewPointer;
    if (activeEffect.expected_status !== 'BLOCKED'
      || pointer.status !== review.status
      || pointer.status !== 'REVIEWING'
      || review.resumable
      || review.resumable_reason !== undefined
      || review.attempt_history.length === 0
      || review.attempt_history.at(-1)?.attempt !== review.current_attempt
      || review.attempt_history.at(-1)?.status !== 'REVIEWING'
      || review.attempt_history.at(-1)?.resumable !== false) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay restoration does not match its review');
    }
    return;
  }
  if (TERMINAL_REVIEW_STATUSES.includes(activeEffect.expected_status)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay expected state is terminal');
  }
  if (activeEffect.mode === 'UPDATE_MATCHING_ACTIVE') {
    const pointer = activeEffect.payload as ActiveReviewPointer;
    if (pointer.status !== review.status
      || ACTIVE_UPDATE_TRANSITIONS[activeEffect.expected_status] !== pointer.status) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay update does not match its review');
    }
    return;
  }
  const validRemoval = activeEffect.mode === 'REMOVE_MATCHING_ACTIVE'
    && ((review.status === 'FINALIZED' && activeEffect.expected_status === 'READY_TO_SYNTHESIZE')
      || (review.status === 'BLOCKED' && !TERMINAL_REVIEW_STATUSES.includes(activeEffect.expected_status)));
  if (!validRemoval) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay removal requires a terminal review');
  }
}

function validateConsumedResultInReview(
  review: ReviewRecord,
  proposalEffect: DurableTransactionEffect,
  postToolEffect: DurableTransactionEffect,
): void {
  const proposal = proposalEffect.payload as Record<string, unknown>;
  const publication = postToolEffect.payload as Record<string, unknown>;
  const activity = publication.activity as Record<string, unknown>;
  const result = proposal.result as Record<string, unknown>;
  const lane = review.lanes.find((candidate) => (
    candidate.lane_id === proposal.lane_id && candidate.attempt === proposal.attempt
  ));
  if (lane === undefined || lane.status !== 'COMPLETE'
    || lane.role !== result.role
    || lane.batch_id !== result.batch_id
    || canonicalDigest(lane.findings) !== canonicalDigest(result.findings)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumed result is not incorporated in its review lane');
  }
  if (result.role === 'architect') {
    if (lane.architectural_status !== result.architectural_status || lane.diagnostic_ids.length !== 0) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumed architect result is not incorporated exactly');
    }
    return;
  }
  if (!Array.isArray(result.diagnostics)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumed reviewer diagnostics are malformed');
  }
  const expectedRecommendation = lane.failure_code === 'DIAGNOSTIC_DEGRADED'
    && result.recommendation === 'APPROVE' ? 'COMMENT' : result.recommendation;
  const expectedDiagnostics = result.diagnostics.map((diagnostic) => ({
    ...(diagnostic as Record<string, unknown>),
    thread_id: activity.child_thread_id,
  }));
  const actualDiagnostics = lane.diagnostic_ids.map((id) => (
    review.diagnostics.find((diagnostic) => diagnostic.diagnostic_id === id)
  ));
  if (lane.recommendation !== expectedRecommendation
    || lane.diagnostic_ids.length !== expectedDiagnostics.length
    || actualDiagnostics.some((diagnostic) => diagnostic === undefined)
    || canonicalDigest(actualDiagnostics) !== canonicalDigest(expectedDiagnostics)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumed reviewer evidence is not incorporated exactly');
  }
}

function validateConsumptionTopology(
  effects: DurableTransactionEffect[],
  reviewId: string,
  idempotencyKey: string,
): void {
  const typedMarkers = effects
    .filter((effect) => effect.name === 'consume')
    .map((effect) => effect.payload)
    .filter((payload): payload is ReviewConsumptionMarker => (
      isPlainObject(payload) && Object.hasOwn(payload, 'kind')
    ));
  const postTools = effects.filter((effect) => effect.name === 'post-tool');
  const manifests = effects.filter((effect) => effect.name === 'manifest');
  if (postTools.length === 0) {
    if (typedMarkers.length !== 0 || manifests.length !== 0) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption has no publication pair');
    }
    return;
  }
  const reviewEffects = effects.filter((effect) => effect.name === 'review');
  if (postTools.length > 16
    || typedMarkers.length !== postTools.length * REVIEW_CONSUMPTION_KINDS.length
    || reviewEffects.length !== 1
    || manifests.length > 1) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption topology is invalid');
  }
  const proposals = new Map(effects.filter((effect) => effect.name === 'proposal').map((effect) => [
    (effect.payload as { idempotency_key: string }).idempotency_key,
    effect,
  ]));
  const markerByIdentity = new Map<string, ReviewConsumptionMarker>();
  let consumedAt: string | undefined;
  for (const marker of typedMarkers) {
    if (marker.review_id !== reviewId || marker.idempotency_key !== idempotencyKey
      || (consumedAt !== undefined && marker.consumed_at !== consumedAt)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption transaction binding conflicts');
    }
    consumedAt ??= marker.consumed_at;
    const identity = `${marker.kind}:${marker.value_sha256}`;
    if (markerByIdentity.has(identity)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption marker is duplicated');
    }
    markerByIdentity.set(identity, marker);
  }
  const publications: ReviewConsumptionManifestPublication[] = [];
  const referencedMarkers = new Set<string>();
  const consumedLaneAttempts = new Set<string>();
  const review = reviewEffects[0]!.payload as ReviewRecord;
  for (const postTool of postTools) {
    const publication = postTool.payload as Record<string, unknown>;
    const publicationId = publication.publication_id as string;
    const proposal = proposals.get(publicationId);
    const attestation = publication.attestation as Record<string, unknown>;
    if (proposal === undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption publication has no proposal');
    }
    const proposalPayload = proposal.payload as Record<string, unknown>;
    const laneAttempt = `${proposalPayload.lane_id as string}:${proposalPayload.attempt as number}`;
    if (consumedLaneAttempts.has(laneAttempt)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review lane has multiple consumption publications');
    }
    consumedLaneAttempts.add(laneAttempt);
    const values: Record<ReviewConsumptionKind, string> = {
      PROPOSAL_KEY: publicationId,
      TOOL_EVENT_REF: attestation.tool_event_ref as string,
      NONCE: attestation.nonce as string,
    };
    const refs = REVIEW_CONSUMPTION_KINDS.map((kind) => {
      const digest = reviewConsumptionDigest(kind, values[kind]);
      const markerIdentity = `${kind}:${digest}`;
      const marker = markerByIdentity.get(markerIdentity);
      if (marker === undefined || referencedMarkers.has(markerIdentity)) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption marker does not bind its publication');
      }
      referencedMarkers.add(markerIdentity);
      return {
        kind,
        value_sha256: digest,
        path: `${reviewId}/consumptions/${REVIEW_CONSUMPTION_DIRECTORIES[kind]}/${digest}.json`,
      };
    }) as ReviewConsumptionManifestPublication['markers'];
    validateConsumedResultInReview(review, proposal, postTool);
    publications.push({ publication_id: publicationId, markers: refs });
  }
  if (referencedMarkers.size !== typedMarkers.length || consumedAt === undefined) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption transaction has extra markers');
  }
  const expected: ReviewConsumptionManifestIntent = {
    schema_version: 1,
    review_id: reviewId,
    idempotency_key: idempotencyKey,
    publication_count: publications.length,
    marker_count: publications.length * REVIEW_CONSUMPTION_KINDS.length,
    publications,
    committed_at: consumedAt,
  };
  if (manifests.length === 0) {
    effects.push({
      name: 'manifest',
      mode: 'CREATE_ONCE_JSON',
      target: {
        area: 'REVIEW_STATE',
        path: `${reviewId}/consumptions/manifests/${idempotencyKey}.json`,
      },
      payload: expected,
    });
  } else if (canonicalDigest(manifests[0]!.payload) !== canonicalDigest(expected)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'consumption manifest conflicts with publication bindings');
  }
}

function validateDurablePlan(value: unknown): DurableTransactionPlan {
  if (!isPlainObject(value)) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction plan is malformed');
  const idempotencyKey = validateUuid(value.idempotency_key, 'idempotency_key');
  const reviewId = validateUuid(value.review_id, 'review_id');
  const journalScope = value.journal_scope === undefined ? 'REVIEW' : value.journal_scope;
  if (journalScope !== 'START' && journalScope !== 'REVIEW') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction journal scope is invalid');
  }
  if (typeof value.operation !== 'string' || value.operation.length === 0 || value.operation.length > 160) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction operation is invalid');
  }
  if (!Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 0) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction expected revision is invalid');
  }
  const expectedRevision = value.expected_revision as number;
  if (!Array.isArray(value.effects) || value.effects.length > 64) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effects are invalid');
  }
  const effects = value.effects.map(validateDurableEffect);
  for (const effect of effects) {
    validateTypedEffectPayload(effect, reviewId, idempotencyKey, expectedRevision);
    if ((effect.mode === 'UPDATE_MATCHING_ACTIVE'
        || effect.mode === 'RESTORE_MISSING_ACTIVE'
        || effect.mode === 'REMOVE_MATCHING_ACTIVE') && (
      effect.name !== 'active-overlay'
      || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== 'active.json'
      || effect.review_id !== reviewId
    )) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active transition must match the transaction review identity');
    }
    if (effect.mode === 'APPLY_REVIEW_REVISION' && (
      effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== `${reviewId}/review.json`
    )) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review revision target does not match the transaction review');
    }
    if (effect.name === 'report') {
      if (effect.mode !== 'CREATE_ONCE_JSON'
        || effect.target.area !== 'FINAL_REVIEWS'
        || effect.target.path !== `${reviewId}.json`
        || effect.payload === undefined) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'final report effect is malformed');
      }
      const artifact = validateFinalReviewArtifact(effect.payload);
      if (artifact.review_id !== reviewId) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'final report review identity conflicts');
      }
      effect.payload = artifact;
    }
  }
  validatePostToolProposalBinding(effects, idempotencyKey);
  validateActiveOverlayBinding(effects, journalScope, expectedRevision);
  validateConsumptionTopology(effects, reviewId, idempotencyKey);
  if (effects.length > 64) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effects are invalid');
  }
  const targets = effects.map((effect) => `${effect.target.area}:${effect.target.path}`);
  if (new Set(targets).size !== targets.length) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction targets must be unique');
  }
  return {
    journal_scope: journalScope,
    idempotency_key: idempotencyKey,
    review_id: reviewId,
    operation: value.operation,
    input: sanitizeForPersistence(value.input),
    expected_revision: expectedRevision,
    effects,
    response: sanitizeForPersistence(value.response),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function planDigest(plan: DurableTransactionPlan): string {
  return canonicalDigest({
    journal_scope: plan.journal_scope ?? 'REVIEW',
    review_id: plan.review_id,
    operation: plan.operation,
    input: plan.input,
    expected_revision: plan.expected_revision,
    effects: plan.effects,
    response: plan.response,
  });
}

function transactionDirectory(
  paths: ReviewPersistencePaths,
  reviewId: string,
  key: string,
  journalScope: 'START' | 'REVIEW',
): string {
  return journalScope === 'START'
    ? join(paths.startTransactionsRoot, key)
    : join(paths.reviewRoot, reviewId, 'transactions', key);
}

function transactionPaths(
  paths: ReviewPersistencePaths,
  reviewId: string,
  key: string,
  journalScope: 'START' | 'REVIEW',
): {
  prepared: string;
  committed: string;
} {
  const directory = transactionDirectory(paths, reviewId, key, journalScope);
  return { prepared: join(directory, 'prepared'), committed: join(directory, 'committed') };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `persisted JSON is malformed: ${path}`);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function parsePrepared(value: unknown): PreparedDurableTransaction {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'state', 'transaction_id', 'journal_scope', 'idempotency_key',
    'input_digest', 'operation', 'review_id', 'input', 'expected_revision', 'effects',
    'response', 'prepared_at',
  ]) || value.schema_version !== 1 || value.state !== 'PREPARED'
    || (value.journal_scope !== 'START' && value.journal_scope !== 'REVIEW')
    || typeof value.input_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.input_digest)
    || typeof value.prepared_at !== 'string' || !Number.isFinite(Date.parse(value.prepared_at))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'prepared transaction is malformed');
  }
  const transactionId = validateUuid(value.transaction_id, 'transaction_id');
  const plan = validateDurablePlan({
    journal_scope: value.journal_scope,
    idempotency_key: value.idempotency_key,
    review_id: value.review_id,
    operation: value.operation,
    input: value.input,
    expected_revision: value.expected_revision,
    effects: value.effects,
    response: value.response,
  });
  if (planDigest(plan) !== value.input_digest) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'prepared transaction digest does not match its canonical intent');
  }
  return {
    schema_version: 1,
    state: 'PREPARED',
    transaction_id: transactionId,
    journal_scope: plan.journal_scope ?? 'REVIEW',
    idempotency_key: plan.idempotency_key,
    input_digest: value.input_digest,
    operation: plan.operation,
    review_id: plan.review_id,
    input: plan.input,
    expected_revision: plan.expected_revision,
    effects: plan.effects,
    response: plan.response,
    prepared_at: value.prepared_at,
  };
}

function parseCommitted(value: unknown): CommittedDurableTransaction {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'state', 'transaction_id', 'idempotency_key', 'input_digest', 'response', 'committed_at',
  ]) || value.schema_version !== 1
    || value.state !== 'COMMITTED'
    || typeof value.input_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.input_digest)
    || typeof value.committed_at !== 'string' || !Number.isFinite(Date.parse(value.committed_at))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'committed transaction is malformed');
  }
  return {
    schema_version: 1,
    state: 'COMMITTED',
    transaction_id: validateUuid(value.transaction_id, 'committed transaction_id'),
    idempotency_key: validateUuid(value.idempotency_key, 'committed idempotency_key'),
    input_digest: value.input_digest,
    response: sanitizeForPersistence(value.response),
    committed_at: value.committed_at,
  };
}

function validateCommittedAgainstPrepared(
  value: unknown,
  prepared: PreparedDurableTransaction,
): CommittedDurableTransaction {
  const committed = parseCommitted(value);
  if (committed.transaction_id !== prepared.transaction_id
    || committed.idempotency_key !== prepared.idempotency_key
    || committed.input_digest !== prepared.input_digest
    || canonicalDigest(committed.response) !== canonicalDigest(prepared.response)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'committed transaction conflicts with its intent');
  }
  return committed;
}

function parseStartReceipt(value: unknown): CommittedStartReceipt {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'state', 'transaction_id', 'idempotency_key', 'request_digest',
    'review_id', 'session_id', 'response', 'result_revision', 'result_digest', 'committed_at',
  ]) || value.schema_version !== 1 || value.state !== 'COMMITTED'
    || (value.session_id !== null && typeof value.session_id !== 'string')) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt is malformed');
  }
  return {
    schema_version: 1,
    state: 'COMMITTED',
    transaction_id: validateUuid(value.transaction_id, 'START receipt transaction_id'),
    idempotency_key: validateUuid(value.idempotency_key, 'START receipt idempotency_key'),
    request_digest: requirePayloadHash(value.request_digest, 'START receipt request_digest'),
    review_id: validateUuid(value.review_id, 'START receipt review_id'),
    session_id: value.session_id === null
      ? null
      : requirePayloadString(value.session_id, 'START receipt session_id', 160),
    response: sanitizeForPersistence(value.response),
    result_revision: requirePositiveInteger(value.result_revision, 'START receipt result_revision'),
    result_digest: requirePayloadHash(value.result_digest, 'START receipt result_digest'),
    committed_at: requirePayloadTimestamp(value.committed_at, 'START receipt committed_at'),
  };
}

async function scanStartReceipts(paths: ReviewPersistencePaths): Promise<Map<string, CommittedStartReceipt>> {
  const receipts = new Map<string, CommittedStartReceipt>();
  for (const entry of await readDirectoryEntries(paths.startReceiptsRoot)) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt index contains an unknown entry');
    }
    const filenameKey = validateUuid(match[1], 'START receipt filename');
    const raw = await readJsonIfPresent(join(paths.startReceiptsRoot, entry.name));
    if (raw === undefined) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt disappeared');
    const receipt = parseStartReceipt(raw);
    if (receipt.idempotency_key !== filenameKey || receipts.has(receipt.idempotency_key)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt identity is duplicated');
    }
    const reviewRaw = await readJsonIfPresent(join(paths.reviewRoot, receipt.review_id, 'review.json'));
    if (!isPlainObject(reviewRaw) || !Number.isSafeInteger(reviewRaw.revision)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt review is missing');
    }
    const review = validateReviewRecordPayload(reviewRaw, receipt.review_id, reviewRaw.revision as number);
    if ((review.session_id ?? null) !== receipt.session_id
      || review.revision < receipt.result_revision
      || (review.revision === receipt.result_revision && (
        canonicalDigest(review) !== receipt.result_digest
        || review.last_applied_transaction_id !== receipt.transaction_id
      ))) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt result conflicts');
    }
    receipts.set(receipt.idempotency_key, receipt);
  }
  return receipts;
}

async function validateStartReceiptResult(
  paths: ReviewPersistencePaths,
  receipt: CommittedStartReceipt,
  plan: DurableTransactionPlan,
): Promise<DurableTransactionResult> {
  if (receipt.request_digest !== planDigest(plan)) {
    throw new ReviewPersistenceError('IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different input');
  }
  if (receipt.review_id !== plan.review_id
    || receipt.result_revision !== plan.expected_revision + 1
    || (paths.session_id ?? null) !== receipt.session_id) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt session identity conflicts');
  }
  const raw = await readJsonIfPresent(join(paths.reviewRoot, receipt.review_id, 'review.json'));
  if (!isPlainObject(raw) || !Number.isSafeInteger(raw.revision)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt review is missing');
  }
  const review = validateReviewRecordPayload(raw, receipt.review_id, raw.revision as number);
  if ((review.session_id ?? null) !== receipt.session_id || review.revision < receipt.result_revision) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt result was rolled back or replaced');
  }
  if (review.revision === receipt.result_revision && canonicalDigest(review) !== receipt.result_digest) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'START receipt result digest conflicts');
  }
  return { state: 'COMMITTED', response: receipt.response };
}

async function publishStartReceipt(
  paths: ReviewPersistencePaths,
  prepared: PreparedDurableTransaction,
  committed: CommittedDurableTransaction,
): Promise<void> {
  if (prepared.journal_scope !== 'START') return;
  const raw = await readJsonIfPresent(join(paths.reviewRoot, prepared.review_id, 'review.json'));
  if (!isPlainObject(raw) || !Number.isSafeInteger(raw.revision)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'cannot receipt a missing START result');
  }
  const review = validateReviewRecordPayload(raw, prepared.review_id, raw.revision as number);
  if (review.revision !== prepared.expected_revision + 1
    || review.last_applied_transaction_id !== prepared.transaction_id
    || (review.session_id ?? null) !== (paths.session_id ?? null)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'cannot receipt an ambiguous START result');
  }
  const receipt: CommittedStartReceipt = {
    schema_version: 1,
    state: 'COMMITTED',
    transaction_id: prepared.transaction_id,
    idempotency_key: prepared.idempotency_key,
    request_digest: prepared.input_digest,
    review_id: prepared.review_id,
    session_id: paths.session_id ?? null,
    response: committed.response,
    result_revision: review.revision,
    result_digest: canonicalDigest(review),
    committed_at: committed.committed_at,
  };
  await createOnceMatching(join(paths.startReceiptsRoot, `${prepared.idempotency_key}.json`), receipt);
}

function parseLocator(value: unknown): DurableTransactionLocator {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'transaction_id', 'review_id', 'idempotency_key', 'input_digest',
  ]) || value.schema_version !== 1 || typeof value.input_digest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.input_digest)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator is malformed');
  }
  return {
    schema_version: 1,
    transaction_id: validateUuid(value.transaction_id, 'locator transaction_id'),
    review_id: validateUuid(value.review_id, 'locator review_id'),
    idempotency_key: validateUuid(value.idempotency_key, 'locator idempotency_key'),
    input_digest: value.input_digest,
  };
}

function assertLocatorMatchesPrepared(
  locator: DurableTransactionLocator,
  prepared: PreparedDurableTransaction,
): void {
  if (locator.transaction_id !== prepared.transaction_id
    || locator.review_id !== prepared.review_id
    || locator.idempotency_key !== prepared.idempotency_key
    || locator.input_digest !== prepared.input_digest) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator conflicts with its intent');
  }
}

function maybeCrash(boundary: DurableTransactionBoundary, options: RunDurableTransactionOptions): void {
  if (options.crashAt !== boundary) return;
  if (options.crashMode === 'SIGKILL' && process.platform !== 'win32') {
    process.kill(process.pid, 'SIGKILL');
  }
  throw new Error(`injected crash at ${boundary}`);
}

function targetPath(paths: ReviewPersistencePaths, effect: DurableTransactionEffect): string {
  const root = effect.target.area === 'FINAL_REVIEWS' ? paths.reviewsRoot : paths.reviewRoot;
  const target = resolve(root, effect.target.path);
  const relativePath = relative(resolve(root), target);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction target escaped its root');
  }
  return target;
}

async function createOnceMatching(path: string, payload: unknown): Promise<void> {
  try {
    await atomicCreatePrivateJson(path, payload);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readJsonIfPresent(path);
    if (canonicalDigest(existing) !== canonicalDigest(sanitizeForPersistence(payload))) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'create-once effect conflicts with published evidence');
    }
  }
}

async function validateCurrentReviewState(
  path: string,
  reviewId: string,
  expectedRevision: number,
  options: { appliedTransactionId?: string; requireApplied: boolean },
): Promise<ReviewRecord | undefined> {
  const current = await readJsonIfPresent(path);
  if (current === undefined) {
    if (options.requireApplied || expectedRevision !== 0) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review record is missing');
    }
    return undefined;
  }
  if (!isPlainObject(current) || !Number.isSafeInteger(current.revision)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review record is malformed');
  }
  const revision = current.revision as number;
  const validated = validateReviewRecordPayload(current, reviewId, revision);
  if (!options.requireApplied && revision === expectedRevision) return validated;
  if (options.appliedTransactionId !== undefined
    && revision === expectedRevision + 1
    && validated.last_applied_transaction_id === options.appliedTransactionId) {
    return validated;
  }
  throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review revision is ambiguous');
}

async function validateReviewEffectCurrentState(
  paths: ReviewPersistencePaths,
  intent: Pick<DurableTransactionPlan, 'review_id' | 'expected_revision' | 'effects'>,
  options: { appliedTransactionId?: string; requireApplied: boolean },
): Promise<void> {
  const effect = intent.effects.find((candidate) => candidate.mode === 'APPLY_REVIEW_REVISION');
  if (!effect) return;
  const current = await validateCurrentReviewState(
    targetPath(paths, effect),
    intent.review_id,
    intent.expected_revision,
    options,
  );
  const proposed = effect.payload as ReviewRecord;
  if ((paths.session_id !== undefined && proposed.session_id !== paths.session_id)
    || (current !== undefined && (
      proposed.session_id !== current.session_id
      || proposed.root_thread_id !== current.root_thread_id
      || proposed.invocation_turn_id !== current.invocation_turn_id
    ))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review ownership conflicts');
  }
  for (const postTool of intent.effects.filter((candidate) => candidate.name === 'post-tool')) {
    if (isPlainObject(postTool.payload)
      && isPlainObject(postTool.payload.activity) && isPlainObject(postTool.payload.attestation)
      && (proposed.session_id !== postTool.payload.activity.session_id
        || proposed.session_id !== postTool.payload.attestation.session_id
        || proposed.root_thread_id !== postTool.payload.attestation.root_thread_id)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review ownership conflicts with post-tool publication');
    }
  }
}

function validateRestoreTransition(current: ReviewRecord, proposed: ReviewRecord): void {
  const nextAttempt = current.current_attempt + 1;
  const priorAttempt = current.attempt_history.at(-1);
  const resumedAttempt = proposed.attempt_history.at(-1);
  if (current.status !== 'BLOCKED'
    || current.resumable !== true
    || current.resumable_reason === undefined
    || !RESUMABLE_REASONS.includes(current.resumable_reason)
    || priorAttempt?.attempt !== current.current_attempt
    || priorAttempt.status !== 'BLOCKED'
    || priorAttempt.resumable !== true
    || priorAttempt.resumable_reason !== current.resumable_reason
    || proposed.status !== 'REVIEWING'
    || proposed.current_attempt !== nextAttempt
    || proposed.resumable !== false
    || proposed.resumable_reason !== undefined
    || proposed.attempt_history.length !== current.attempt_history.length + 1
    || canonicalDigest(proposed.attempt_history.slice(0, -1)) !== canonicalDigest(current.attempt_history)
    || resumedAttempt?.attempt !== nextAttempt
    || resumedAttempt.status !== 'REVIEWING'
    || resumedAttempt.resumable !== false
    || resumedAttempt.resumable_reason !== undefined
    || resumedAttempt.finalized_at !== undefined
    || resumedAttempt.verdict !== undefined
    || proposed.lanes.length < current.lanes.length
    || canonicalDigest(proposed.lanes.slice(0, current.lanes.length)) !== canonicalDigest(current.lanes)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review is not an exact resumable transition');
  }
  const lanesById = new Map(proposed.lanes.map((lane) => [lane.lane_id, lane] as const));
  if (new Set(resumedAttempt.lane_ids).size !== resumedAttempt.lane_ids.length
    || resumedAttempt.bindings.length !== resumedAttempt.lane_ids.length
    || resumedAttempt.bindings.some((binding, index) => {
      const lane = lanesById.get(binding.lane_id);
      return binding.lane_id !== resumedAttempt.lane_ids[index]
        || lane === undefined
        || lane.attempt !== binding.attempt
        || lane.role !== binding.role
        || lane.batch_id !== binding.batch_id
        || (binding.attempt === nextAttempt && lane.status !== 'PENDING');
    })
    || proposed.lanes.slice(current.lanes.length).some((lane) => (
      lane.attempt !== nextAttempt || lane.status !== 'PENDING'
    ))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'resumed review lane topology conflicts');
  }
}

async function validateActiveEffectCurrentState(
  paths: ReviewPersistencePaths,
  intent: Pick<DurableTransactionPlan, 'review_id' | 'expected_revision' | 'effects'>,
  options: { appliedTransactionId?: string; requireApplied: boolean },
): Promise<ActiveReviewPointer | null> {
  const effect = intent.effects.find((candidate) => candidate.name === 'active-overlay');
  if (!effect) return null;
  const reviewEffect = intent.effects.find((candidate) => candidate.name === 'review')!;
  const review = await validateCurrentReviewState(
    targetPath(paths, reviewEffect),
    intent.review_id,
    intent.expected_revision,
    { appliedTransactionId: options.appliedTransactionId, requireApplied: options.requireApplied },
  );
  const reviewApplied = review !== undefined
    && options.appliedTransactionId !== undefined
    && review.revision === intent.expected_revision + 1
    && review.last_applied_transaction_id === options.appliedTransactionId;
  const active = await readActiveReview(paths);
  const matches = (pointer: ActiveReviewPointer | null, expected: ActiveReviewPointer): boolean => (
    pointer?.schema_version === expected.schema_version
    && pointer.review_id === expected.review_id
    && pointer.status === expected.status
  );

  if (effect.mode === 'CREATE_ONCE_JSON') {
    const next = effect.payload as ActiveReviewPointer;
    if ((!reviewApplied && active !== null)
      || (reviewApplied && options.requireApplied && !matches(active, next))
      || (reviewApplied && !options.requireApplied && active !== null && !matches(active, next))) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'initial active overlay conflicts with durable state');
    }
    return active;
  }

  if (effect.mode === 'RESTORE_MISSING_ACTIVE') {
    const next = effect.payload as ActiveReviewPointer;
    const matchesNext = matches(active, next);
    if (!reviewApplied) {
      if (active !== null || review === undefined
        || review.status !== effect.expected_status
        || review.revision !== effect.expected_revision) {
        throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay restoration precondition conflicts');
      }
      validateRestoreTransition(review, reviewEffect.payload as ReviewRecord);
      return active;
    }
    if ((options.requireApplied && !matchesNext)
      || (!options.requireApplied && active !== null && !matchesNext)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay restoration is ambiguous');
    }
    return active;
  }

  const matchesExpected = active !== null
    && active.review_id === effect.review_id
    && active.status === effect.expected_status;
  if (!reviewApplied) {
    if (!matchesExpected) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay expected state conflicts');
    }
    if (review === undefined
      || review.status !== effect.expected_status
      || review.revision !== effect.expected_revision) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay revision binding conflicts');
    }
    return active;
  }

  if (effect.mode === 'UPDATE_MATCHING_ACTIVE') {
    const next = effect.payload as ActiveReviewPointer;
    const matchesNext = matches(active, next);
    if ((options.requireApplied && !matchesNext)
      || (!options.requireApplied && !matchesExpected && !matchesNext)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay update is ambiguous');
    }
    return active;
  }
  if ((options.requireApplied && active !== null)
    || (!options.requireApplied && active !== null && !matchesExpected)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active overlay removal is ambiguous');
  }
  return active;
}

async function validatePostToolTrustContext(
  paths: ReviewPersistencePaths,
  intent: Pick<DurableTransactionPlan, 'review_id' | 'expected_revision' | 'effects'>,
  appliedTransactionId?: string,
): Promise<void> {
  const effects = intent.effects.filter((candidate) => candidate.name === 'post-tool');
  if (effects.length === 0) return;
  const current = await validateCurrentReviewState(
    join(paths.reviewRoot, intent.review_id, 'review.json'),
    intent.review_id,
    intent.expected_revision,
    { appliedTransactionId, requireApplied: false },
  );
  for (const effect of effects) {
    if (!isPlainObject(effect.payload)
      || !isPlainObject(effect.payload.activity)
      || !isPlainObject(effect.payload.attestation)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool trust context is malformed');
    }
    const activity = effect.payload.activity;
    const attestation = effect.payload.attestation;
    const activitySessionId = activity.session_id as string;
    const attestationSessionId = attestation.session_id as string;
    if ((paths.session_id !== undefined
        && (activitySessionId !== paths.session_id || attestationSessionId !== paths.session_id))
      || (current?.session_id !== undefined
        && (activitySessionId !== current.session_id || attestationSessionId !== current.session_id))
      || (current?.root_thread_id !== undefined
        && attestation.root_thread_id !== current.root_thread_id)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool trust context conflicts');
    }
  }
}

async function applyReviewRevision(
  path: string,
  payload: unknown,
  prepared: PreparedDurableTransaction,
): Promise<void> {
  if (!isPlainObject(payload)) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review payload is malformed');
  const current = await validateCurrentReviewState(
    path,
    prepared.review_id,
    prepared.expected_revision,
    { appliedTransactionId: prepared.transaction_id, requireApplied: false },
  );
  if (current === undefined) {
    await atomicCreatePrivateJson(path, {
      ...payload,
      revision: 1,
      last_applied_transaction_id: prepared.transaction_id,
    });
    return;
  }
  if (
    current.revision === prepared.expected_revision + 1
    && current.last_applied_transaction_id === prepared.transaction_id
  ) return;
  await atomicWritePrivateJson(path, {
    ...payload,
    revision: prepared.expected_revision + 1,
    last_applied_transaction_id: prepared.transaction_id,
  });
}

function locatorValue(prepared: PreparedDurableTransaction): DurableTransactionLocator {
  return {
    schema_version: 1,
    transaction_id: prepared.transaction_id,
    review_id: prepared.review_id,
    idempotency_key: prepared.idempotency_key,
    input_digest: prepared.input_digest,
  };
}

async function publishLocator(
  paths: ReviewPersistencePaths,
  prepared: PreparedDurableTransaction,
): Promise<void> {
  if (prepared.journal_scope !== 'REVIEW') return;
  await createOnceMatching(
    join(paths.pendingReviewTransactionsRoot, prepared.transaction_id),
    locatorValue(prepared),
  );
}

async function applyEffect(
  paths: ReviewPersistencePaths,
  effect: DurableTransactionEffect,
  prepared: PreparedDurableTransaction,
  options: RunDurableTransactionOptions,
): Promise<void> {
  if (effect.name === 'report') {
    await writeFinalReviewArtifacts(paths, effect.payload, {
      ...(options.crashAt === 'after:report'
        ? { afterJsonPublished: () => maybeCrash('after:report', options) }
        : {}),
    });
    return;
  }
  const path = targetPath(paths, effect);
  if (effect.name === 'manifest') {
    const intent = effect.payload as ReviewConsumptionManifestIntent;
    await createOnceMatching(path, {
      ...intent,
      state: 'COMMITTED',
      transaction_id: prepared.transaction_id,
    } satisfies ReviewConsumptionManifest);
    return;
  }
  if (effect.mode === 'CREATE_ONCE_JSON') {
    await createOnceMatching(path, effect.payload);
    return;
  }
  if (effect.mode === 'APPLY_REVIEW_REVISION') {
    await applyReviewRevision(path, effect.payload, prepared);
    return;
  }
  const active = await validateActiveEffectCurrentState(paths, prepared, {
    appliedTransactionId: prepared.transaction_id,
    requireApplied: false,
  });
  if (effect.mode === 'UPDATE_MATCHING_ACTIVE' || effect.mode === 'RESTORE_MISSING_ACTIVE') {
    const next = effect.payload as ActiveReviewPointer;
    if (active?.review_id === next.review_id && active.status === next.status) return;
    await atomicWritePrivateJson(path, next);
    return;
  }
  if (active !== null) await rm(path, { force: true });
}

async function cleanupLocator(paths: ReviewPersistencePaths, prepared: PreparedDurableTransaction): Promise<void> {
  if (prepared.journal_scope === 'START') {
    const files = transactionPaths(
      paths,
      prepared.review_id,
      prepared.idempotency_key,
      prepared.journal_scope,
    );
    await rm(dirname(files.prepared), { recursive: true, force: true });
    return;
  }
  const path = join(paths.pendingReviewTransactionsRoot, prepared.transaction_id);
  const locator = await readJsonIfPresent(path);
  if (locator === undefined) return;
  assertLocatorMatchesPrepared(parseLocator(locator), prepared);
  await rm(path, { force: true });
}

async function executePrepared(
  paths: ReviewPersistencePaths,
  prepared: PreparedDurableTransaction,
  options: RunDurableTransactionOptions,
): Promise<DurableTransactionResult> {
  await validatePostToolTrustContext(paths, prepared, prepared.transaction_id);
  const files = transactionPaths(paths, prepared.review_id, prepared.idempotency_key, prepared.journal_scope);
  const committedValue = await readJsonIfPresent(files.committed);
  if (committedValue !== undefined) {
    const committed = validateCommittedAgainstPrepared(committedValue, prepared);
    await validateReviewEffectCurrentState(paths, prepared, {
      appliedTransactionId: prepared.transaction_id,
      requireApplied: true,
    });
    await validateActiveEffectCurrentState(paths, prepared, {
      appliedTransactionId: prepared.transaction_id,
      requireApplied: true,
    });
    if (prepared.journal_scope === 'START') {
      maybeCrash('before:receipt', options);
      await publishStartReceipt(paths, prepared, committed);
      maybeCrash('after:receipt', options);
    }
    await cleanupLocator(paths, prepared);
    return { state: 'COMMITTED', response: committed.response };
  }
  await validateReviewEffectCurrentState(paths, prepared, {
    appliedTransactionId: prepared.transaction_id,
    requireApplied: false,
  });
  await validateActiveEffectCurrentState(paths, prepared, {
    appliedTransactionId: prepared.transaction_id,
    requireApplied: false,
  });

  maybeCrash('before:locator', options);
  if (prepared.journal_scope === 'REVIEW') {
    await publishLocator(paths, prepared);
    const locator = await readJsonIfPresent(join(paths.pendingReviewTransactionsRoot, prepared.transaction_id));
    if (locator === undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator is missing');
    }
    assertLocatorMatchesPrepared(parseLocator(locator), prepared);
  }
  maybeCrash('after:locator', options);

  for (const name of DURABLE_EFFECT_ORDER) {
    const effects = prepared.effects.filter((effect) => effect.name === name);
    if (effects.length === 0) continue;
    maybeCrash(`before:${name}`, options);
    for (const effect of effects) await applyEffect(paths, effect, prepared, options);
    maybeCrash(`after:${name}`, options);
  }

  const committed: CommittedDurableTransaction = {
    schema_version: 1,
    state: 'COMMITTED',
    transaction_id: prepared.transaction_id,
    idempotency_key: prepared.idempotency_key,
    input_digest: prepared.input_digest,
    response: prepared.response,
    committed_at: new Date().toISOString(),
  };
  maybeCrash('before:committed', options);
  await createOnceMatching(files.committed, committed);
  maybeCrash('after:committed', options);
  if (prepared.journal_scope === 'START') {
    maybeCrash('before:receipt', options);
    await publishStartReceipt(paths, prepared, committed);
    maybeCrash('after:receipt', options);
  }
  maybeCrash('before:locator-cleanup', options);
  await cleanupLocator(paths, prepared);
  maybeCrash('after:locator-cleanup', options);
  return { state: 'COMMITTED', response: committed.response };
}

async function runDurableTransactionLocked(
  paths: ReviewPersistencePaths,
  planValue: unknown,
  options: RunDurableTransactionOptions,
): Promise<DurableTransactionResult> {
  const plan = validateDurablePlan(planValue);
  const digest = planDigest(plan);
  const journalScope = plan.journal_scope ?? 'REVIEW';
  if (journalScope === 'START') {
    const receipt = (await scanStartReceipts(paths)).get(plan.idempotency_key);
    if (receipt !== undefined) return await validateStartReceiptResult(paths, receipt, plan);
  }
  const files = transactionPaths(paths, plan.review_id, plan.idempotency_key, journalScope);
  const existingCommitted = await readJsonIfPresent(files.committed);
  if (existingCommitted !== undefined) {
    const preparedValue = await readJsonIfPresent(files.prepared);
    if (preparedValue === undefined) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'committed transaction has no intent');
    const prepared = parsePrepared(preparedValue);
    const committed = validateCommittedAgainstPrepared(existingCommitted, prepared);
    if (prepared.input_digest !== digest) {
      throw new ReviewPersistenceError('IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different input');
    }
    await validatePostToolTrustContext(paths, prepared, prepared.transaction_id);
    await validateReviewEffectCurrentState(paths, prepared, {
      appliedTransactionId: prepared.transaction_id,
      requireApplied: true,
    });
    await validateActiveEffectCurrentState(paths, prepared, {
      appliedTransactionId: prepared.transaction_id,
      requireApplied: true,
    });
    await publishStartReceipt(paths, prepared, committed);
    await cleanupLocator(paths, prepared);
    return { state: 'COMMITTED', response: committed.response };
  }

  const existingPrepared = await readJsonIfPresent(files.prepared);
  let prepared: PreparedDurableTransaction;
  if (existingPrepared !== undefined) {
    prepared = parsePrepared(existingPrepared);
    if (prepared.input_digest !== digest) {
      throw new ReviewPersistenceError('IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different input');
    }
  } else {
    prepared = {
      schema_version: 1,
      state: 'PREPARED',
      transaction_id: randomUUID(),
      journal_scope: journalScope,
      idempotency_key: plan.idempotency_key,
      input_digest: digest,
      operation: plan.operation,
      review_id: plan.review_id,
      input: plan.input,
      expected_revision: plan.expected_revision,
      effects: plan.effects,
      response: plan.response,
      prepared_at: new Date().toISOString(),
    };
    await validatePostToolTrustContext(paths, plan);
    await validateReviewEffectCurrentState(paths, plan, { requireApplied: false });
    await validateActiveEffectCurrentState(paths, plan, { requireApplied: false });
    maybeCrash('before:prepared', options);
    await atomicCreatePrivateJson(files.prepared, prepared);
    maybeCrash('after:prepared', options);
    await publishLocator(paths, prepared);
  }
  return await executePrepared(paths, prepared, options);
}

export async function runDurableTransaction(
  paths: ReviewPersistencePaths,
  plan: unknown,
  options: RunDurableTransactionOptions = {},
): Promise<DurableTransactionResult> {
  const journalScope = isPlainObject(plan) && plan.journal_scope === 'START' ? 'START' : 'REVIEW';
  const reviewId = isPlainObject(plan) && typeof plan.review_id === 'string'
    ? validateUuid(plan.review_id, 'review_id')
    : undefined;
  const locks = await acquireReviewLocks(
    paths,
    journalScope === 'START' ? undefined : reviewId,
    journalScope === 'START' ? ['start'] : ['start', 'journal', 'mutation'],
  );
  try {
    await recoverPendingReviewTransactionsLocked(
      paths,
      journalScope === 'REVIEW' ? reviewId : undefined,
    );
    return await runDurableTransactionLocked(paths, plan, options);
  } finally {
    await releaseReviewLocks(locks);
  }
}

async function recoverDurableTransactionLocked(
  paths: ReviewPersistencePaths,
  reviewId: string,
  key: string,
  journalScope: 'START' | 'REVIEW',
): Promise<DurableTransactionResult | null> {
  const files = transactionPaths(paths, reviewId, key, journalScope);
  const preparedValue = await readJsonIfPresent(files.prepared);
  if (preparedValue === undefined) return null;
  const prepared = parsePrepared(preparedValue);
  if (prepared.journal_scope !== journalScope
    || prepared.review_id !== reviewId
    || prepared.idempotency_key !== key) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery identity conflicts');
  }
  if (journalScope === 'REVIEW') {
    const locatorValue = await readJsonIfPresent(join(paths.pendingReviewTransactionsRoot, prepared.transaction_id));
    if (locatorValue === undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator is missing');
    }
    assertLocatorMatchesPrepared(parseLocator(locatorValue), prepared);
  }
  return await executePrepared(paths, prepared, {});
}

export async function recoverDurableTransactions(
  paths: ReviewPersistencePaths,
  input: { review_id: string; idempotency_key: string; journal_scope?: 'START' | 'REVIEW' },
): Promise<DurableTransactionResult | null> {
  const reviewId = validateUuid(input.review_id, 'review_id');
  const key = validateUuid(input.idempotency_key, 'idempotency_key');
  const journalScope = input.journal_scope ?? 'REVIEW';
  if (journalScope !== 'START' && journalScope !== 'REVIEW') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction journal scope is invalid');
  }
  const locks = await acquireReviewLocks(
    paths,
    journalScope === 'START' ? undefined : reviewId,
    journalScope === 'START' ? ['start'] : ['start', 'journal', 'mutation'],
  );
  try {
    return await recoverDurableTransactionLocked(paths, reviewId, key, journalScope);
  } finally {
    await releaseReviewLocks(locks);
  }
}

async function readDirectoryEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', `could not scan transaction recovery root: ${path}`);
  }
}

export async function readReviewConsumptionGroups(
  paths: ReviewPersistencePaths,
  reviewIdValue: string,
): Promise<ReviewConsumptionGroup[]> {
  const reviewId = validateUuid(reviewIdValue, 'review_id');
  const root = join(paths.reviewRoot, reviewId, 'consumptions');
  const directoryToKind = new Map(
    REVIEW_CONSUMPTION_KINDS.map((kind) => [REVIEW_CONSUMPTION_DIRECTORIES[kind], kind] as const),
  );
  const rootEntries = await readDirectoryEntries(root);
  const allowedDirectories = new Set([...directoryToKind.keys(), 'manifests']);
  const markers = new Map<string, ReviewConsumptionMarker>();
  const manifests: ReviewConsumptionManifest[] = [];
  for (const directory of [...rootEntries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!directory.isDirectory() || !allowedDirectories.has(directory.name)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption directory is invalid');
    }
    const kind = directoryToKind.get(directory.name);
    const entries = await readDirectoryEntries(join(root, directory.name));
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption entry is invalid');
      const path = join(root, directory.name, entry.name);
      const value = await readJsonIfPresent(path);
      if (value === undefined) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption entry disappeared');
      if (directory.name === 'manifests') {
        const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu.exec(entry.name);
        if (match === null) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest entry is invalid');
        const manifest = validateConsumptionManifest(value);
        if (manifest.review_id !== reviewId || manifest.idempotency_key !== validateUuid(match[1], 'manifest filename')) {
          throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest path conflicts');
        }
        manifests.push(manifest);
      } else {
        const match = /^([0-9a-f]{64})\.json$/u.exec(entry.name);
        if (kind === undefined || match === null) {
          throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption entry is invalid');
        }
        const marker = validateReviewConsumptionMarker(value, reviewId);
        const identity = `${marker.kind}:${marker.value_sha256}`;
        if (marker.kind !== kind || marker.value_sha256 !== match[1] || markers.has(identity)) {
          throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption path conflicts with its marker');
        }
        markers.set(identity, marker);
      }
    }
  }
  if (markers.size === 0 && manifests.length === 0) return [];
  if (markers.size === 0 || manifests.length === 0) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption state is partial');
  }
  const seenManifestKeys = new Set<string>();
  const consumedMarkers = new Set<string>();
  const groups: ReviewConsumptionGroup[] = [];
  for (const manifest of manifests.sort((left, right) => left.idempotency_key.localeCompare(right.idempotency_key))) {
    if (seenManifestKeys.has(manifest.idempotency_key)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest is duplicated');
    }
    seenManifestKeys.add(manifest.idempotency_key);
    const files = transactionPaths(paths, reviewId, manifest.idempotency_key, 'REVIEW');
    const preparedValue = await readJsonIfPresent(files.prepared);
    const committedValue = await readJsonIfPresent(files.committed);
    if (preparedValue === undefined || committedValue === undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest transaction is incomplete');
    }
    const prepared = parsePrepared(preparedValue);
    const committed = validateCommittedAgainstPrepared(committedValue, prepared);
    if (prepared.transaction_id !== manifest.transaction_id
      || committed.transaction_id !== manifest.transaction_id
      || prepared.review_id !== reviewId
      || prepared.idempotency_key !== manifest.idempotency_key) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest transaction conflicts');
    }
    const intent = prepared.effects.find((effect) => effect.name === 'manifest');
    const persistedIntent = {
      schema_version: manifest.schema_version,
      review_id: manifest.review_id,
      idempotency_key: manifest.idempotency_key,
      publication_count: manifest.publication_count,
      marker_count: manifest.marker_count,
      publications: manifest.publications,
      committed_at: manifest.committed_at,
    } satisfies ReviewConsumptionManifestIntent;
    if (intent === undefined || canonicalDigest(intent.payload) !== canonicalDigest(persistedIntent)) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest conflicts with its intent');
    }
    const groupMarkers: ReviewConsumptionMarker[] = [];
    for (const publication of manifest.publications) {
      for (const ref of publication.markers) {
        const identity = `${ref.kind}:${ref.value_sha256}`;
        const marker = markers.get(identity);
        const expectedPath = `${reviewId}/consumptions/${REVIEW_CONSUMPTION_DIRECTORIES[ref.kind]}/${ref.value_sha256}.json`;
        if (marker === undefined
          || marker.idempotency_key !== manifest.idempotency_key
          || ref.path !== expectedPath
          || consumedMarkers.has(identity)) {
          throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest marker conflicts');
        }
        consumedMarkers.add(identity);
        groupMarkers.push(marker);
      }
    }
    if (groupMarkers.length !== manifest.publication_count * REVIEW_CONSUMPTION_KINDS.length) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption manifest count conflicts');
    }
    groups.push({ manifest, markers: groupMarkers });
  }
  if (consumedMarkers.size !== markers.size) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review consumption state contains an uncommitted marker');
  }
  return groups;
}

export async function readReviewConsumptionMarkers(
  paths: ReviewPersistencePaths,
  reviewIdValue: string,
): Promise<ReviewConsumptionMarker[]> {
  return (await readReviewConsumptionGroups(paths, reviewIdValue)).flatMap((group) => group.markers);
}

async function recoverActiveReviewWithoutLocators(
  paths: ReviewPersistencePaths,
  active: ActiveReviewPointer,
  heldReviewId: string | undefined,
): Promise<DurableTransactionResult[]> {
  const entries = await readDirectoryEntries(join(paths.reviewRoot, active.review_id, 'transactions'));
  const candidates: Array<{ key: string; prepared: PreparedDurableTransaction }> = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review transaction entry is not a directory');
    }
    const key = validateUuid(entry.name, 'active review transaction idempotency_key');
    const files = transactionPaths(paths, active.review_id, key, 'REVIEW');
    if (await readJsonIfPresent(files.committed) !== undefined) continue;
    const preparedValue = await readJsonIfPresent(files.prepared);
    if (preparedValue === undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review transaction has no intent');
    }
    const prepared = parsePrepared(preparedValue);
    if (prepared.journal_scope !== 'REVIEW'
      || prepared.review_id !== active.review_id
      || prepared.idempotency_key !== key) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review transaction identity conflicts');
    }
    candidates.push({ key, prepared });
  }
  if (candidates.length === 0) return [];
  if (candidates.length > 1) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review has ambiguous unlocated transactions');
  }

  const reviewValue = await readJsonIfPresent(join(paths.reviewRoot, active.review_id, 'review.json'));
  if (!isPlainObject(reviewValue) || !Number.isSafeInteger(reviewValue.revision)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review pointer is dangling');
  }
  const review = validateReviewRecordPayload(reviewValue, active.review_id, reviewValue.revision as number);
  if (review.status !== active.status) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review pointer conflicts with its review record');
  }

  const recover = async (): Promise<DurableTransactionResult[]> => {
    const [{ key, prepared }] = candidates;
    await publishLocator(paths, prepared);
    const result = await recoverDurableTransactionLocked(paths, active.review_id, key, 'REVIEW');
    if (result === null) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review transaction disappeared during recovery');
    }
    return [result];
  };
  if (active.review_id === heldReviewId) return await recover();
  const locks = await acquireReviewLocks(paths, active.review_id, ['journal', 'mutation']);
  try {
    return await recover();
  } finally {
    await releaseReviewLocks(locks);
  }
}

async function recoverPendingReviewTransactionsLocked(
  paths: ReviewPersistencePaths,
  heldReviewId?: string,
): Promise<DurableTransactionResult[]> {
  await readActiveReview(paths);
  await scanStartReceipts(paths);
  const recovered: DurableTransactionResult[] = [];

  const startEntries = await readDirectoryEntries(paths.startTransactionsRoot);
  for (const entry of [...startEntries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'start transaction recovery entry is not a directory');
    }
    const key = validateUuid(entry.name, 'start transaction idempotency_key');
    const files = transactionPaths(paths, '', key, 'START');
    const preparedValue = await readJsonIfPresent(files.prepared);
    if (preparedValue === undefined) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'start transaction recovery entry has no intent');
    }
    const prepared = parsePrepared(preparedValue);
    if (prepared.journal_scope !== 'START' || prepared.idempotency_key !== key) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'start transaction recovery identity conflicts');
    }
    const committedValue = await readJsonIfPresent(files.committed);
    if (committedValue !== undefined) {
      const committed = validateCommittedAgainstPrepared(committedValue, prepared);
      await validatePostToolTrustContext(paths, prepared, prepared.transaction_id);
      await validateReviewEffectCurrentState(paths, prepared, {
        appliedTransactionId: prepared.transaction_id,
        requireApplied: true,
      });
      await validateActiveEffectCurrentState(paths, prepared, {
        appliedTransactionId: prepared.transaction_id,
        requireApplied: true,
      });
      await publishStartReceipt(paths, prepared, committed);
      await cleanupLocator(paths, prepared);
      continue;
    }
    const result = await recoverDurableTransactionLocked(paths, prepared.review_id, key, 'START');
    if (result === null) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'start transaction intent disappeared during recovery');
    }
    recovered.push(result);
  }

  const locatorEntries = await readDirectoryEntries(paths.pendingReviewTransactionsRoot);
  for (const entry of [...locatorEntries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isFile()) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator is not a file');
    }
    const transactionId = validateUuid(entry.name, 'locator filename');
    const value = await readJsonIfPresent(join(paths.pendingReviewTransactionsRoot, entry.name));
    if (value === undefined) continue;
    const locator = parseLocator(value);
    if (locator.transaction_id !== transactionId) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator filename conflicts');
    }
    let result: DurableTransactionResult | null;
    if (locator.review_id === heldReviewId) {
      result = await recoverDurableTransactionLocked(
        paths, locator.review_id, locator.idempotency_key, 'REVIEW',
      );
    } else {
      const locks = await acquireReviewLocks(
        paths, locator.review_id, ['journal', 'mutation'],
      );
      try {
        result = await recoverDurableTransactionLocked(
          paths, locator.review_id, locator.idempotency_key, 'REVIEW',
        );
      } finally {
        await releaseReviewLocks(locks);
      }
    }
    if (result === null) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator references missing intent');
    }
    recovered.push(result);
  }
  const active = await readActiveReview(paths);
  if (active !== null) {
    recovered.push(...await recoverActiveReviewWithoutLocators(paths, active, heldReviewId));
  }
  return recovered;
}

export async function recoverPendingReviewTransactions(
  paths: ReviewPersistencePaths,
): Promise<DurableTransactionResult[]> {
  const locks = await acquireReviewLocks(paths, undefined, ['start']);
  try {
    return await recoverPendingReviewTransactionsLocked(paths);
  } finally {
    await releaseReviewLocks(locks);
  }
}

export async function writeFinalReviewArtifacts(
  paths: ReviewPersistencePaths,
  value: unknown,
  options: { afterJsonPublished?: (jsonPath: string) => void | Promise<void> } = {},
): Promise<{ jsonPath: string; markdownPath: string; artifact_sha256: string }> {
  const artifact = validateFinalReviewArtifact(sanitizeForPersistence(value, {
    repositoryRoot: paths.workingDirectory,
  }));
  const jsonPath = join(paths.reviewsRoot, `${artifact.review_id}.json`);
  const markdownPath = join(paths.reviewsRoot, `${artifact.review_id}.md`);
  let jsonPublished = false;
  try {
    await atomicCreatePrivateJson(jsonPath, artifact);
    jsonPublished = true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  if (jsonPublished) await options.afterJsonPublished?.(jsonPath);
  const publishedJsonText = await readFile(jsonPath, 'utf8');
  let publishedValue: unknown;
  try {
    publishedValue = JSON.parse(publishedJsonText) as unknown;
  } catch {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'published final review JSON is malformed');
  }
  const publishedArtifact = validateFinalReviewArtifact(publishedValue);
  if (canonicalDigest(publishedArtifact) !== canonicalDigest(artifact)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'published final review JSON conflicts with the requested artifact');
  }
  const markdown = renderFinalReviewMarkdown(publishedArtifact);
  await atomicWritePrivateText(markdownPath, markdown);
  return {
    jsonPath,
    markdownPath,
    artifact_sha256: createHash('sha256').update(publishedJsonText, 'utf8').digest('hex'),
  };
}
