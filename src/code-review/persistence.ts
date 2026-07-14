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
import { sanitizeForPersistence, validateReviewFinding } from './redaction.js';
import { renderFinalReviewMarkdown, validateFinalReviewArtifact } from './render.js';

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
  status: string;
  [key: string]: unknown;
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

function validateActivePointer(value: unknown): ActiveReviewPointer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review pointer is malformed');
  }
  const pointer = value as Record<string, unknown>;
  if (pointer.schema_version !== 1 || typeof pointer.review_id !== 'string' || typeof pointer.status !== 'string') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active review pointer is malformed');
  }
  return pointer as ActiveReviewPointer;
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
  | 'lane'
  | 'review'
  | 'report'
  | 'active-overlay'
  | 'approval'
  | 'stop-marker'
  | 'committed'
  | 'locator-cleanup';
export type DurableTransactionBoundary = `before:${DurableTransactionStage}` | `after:${DurableTransactionStage}`;
export type DurableEffectName = Exclude<
  DurableTransactionStage,
  'prepared' | 'locator' | 'committed' | 'locator-cleanup'
>;

export interface DurableTransactionEffect {
  name: DurableEffectName;
  mode: 'CREATE_ONCE_JSON' | 'APPLY_REVIEW_REVISION' | 'REMOVE_MATCHING_ACTIVE';
  target: {
    area: 'REVIEW_STATE' | 'FINAL_REVIEWS';
    path: string;
  };
  payload?: unknown;
  review_id?: string;
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

const DURABLE_EFFECT_ORDER: readonly DurableEffectName[] = [
  'proposal',
  'post-tool',
  'consume',
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
  const allowedNames: readonly DurableEffectName[] = DURABLE_EFFECT_ORDER;
  if (!allowedNames.includes(value.name as DurableEffectName)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effect name is invalid');
  }
  if (!['CREATE_ONCE_JSON', 'APPLY_REVIEW_REVISION', 'REMOVE_MATCHING_ACTIVE'].includes(String(value.mode))) {
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
  };
  if (effect.mode === 'APPLY_REVIEW_REVISION' && (effect.name !== 'review' || !isPlainObject(effect.payload))) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review revision effect is invalid');
  }
  if (effect.mode === 'REMOVE_MATCHING_ACTIVE' && !effect.review_id) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active removal requires a review id');
  }
  if (effect.mode === 'CREATE_ONCE_JSON' && effect.payload === undefined) {
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
    if (!['CLEAR', 'WATCH', 'BLOCK'].includes(String(base.architectural_status)) || base.batch_id !== 'global') {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'architect lane result is invalid');
    }
  } else if (!['APPROVE', 'COMMENT', 'REQUEST CHANGES'].includes(String(base.recommendation))
    || !Array.isArray(base.diagnostics)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'reviewer lane result is invalid');
  }
}

function validateTypedEffectPayload(
  effect: DurableTransactionEffect,
  reviewId: string,
  idempotencyKey: string,
): void {
  if (effect.name === 'proposal') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== `${reviewId}/submissions/${idempotencyKey}/proposal`) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'proposal effect target is invalid');
    }
    const proposal = requireExactPayload(effect.payload, [
      'schema_version', 'state', 'review_id', 'attempt', 'lane_id', 'scope_hash',
      'idempotency_key', 'payload_digest', 'result', 'proposed_at',
    ], 'proposal');
    const attempt = requirePositiveInteger(proposal.attempt, 'proposal attempt');
    const laneId = requirePayloadString(proposal.lane_id, 'proposal lane_id', 160);
    const scopeHash = requirePayloadHash(proposal.scope_hash, 'proposal scope_hash');
    if (proposal.schema_version !== 1 || proposal.state !== 'PENDING_HOST_ATTESTATION'
      || validateUuid(proposal.review_id, 'proposal review_id') !== reviewId
      || validateUuid(proposal.idempotency_key, 'proposal idempotency_key') !== idempotencyKey) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'proposal identity conflicts');
    }
    requirePayloadHash(proposal.payload_digest, 'proposal payload_digest');
    requirePayloadTimestamp(proposal.proposed_at, 'proposal proposed_at');
    validateLaneResultPayload(proposal.result, { reviewId, laneId, attempt, scopeHash });
    return;
  }
  if (effect.name === 'post-tool') {
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== `${reviewId}/submissions/${idempotencyKey}/post-tool`) {
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
    if (publication.schema_version !== 1 || activity.schema_version !== 1 || attestation.schema_version !== 1
      || activity.event_kind !== 'RESULT_POST_TOOL'
      || validateUuid(activity.review_id, 'activity review_id') !== reviewId
      || validateUuid(attestation.review_id, 'attestation review_id') !== reviewId
      || activity.attempt !== attestation.attempt || activity.lane_id !== attestation.lane_id
      || activity.child_thread_id !== attestation.child_thread_id
      || activity.event_ref !== attestation.tool_event_ref) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'post-tool identity conflicts');
    }
    requirePayloadString(publication.publication_id, 'publication_id', 160);
    requirePayloadTimestamp(publication.published_at, 'published_at');
    requirePositiveInteger(activity.attempt, 'activity attempt');
    requirePayloadString(activity.lane_id, 'activity lane_id', 160);
    requirePayloadTimestamp(activity.observed_at, 'activity observed_at');
    requirePayloadHash(attestation.scope_hash, 'attestation scope_hash');
    requirePayloadHash(attestation.payload_digest, 'attestation payload_digest');
    requirePayloadTimestamp(attestation.published_at, 'attestation published_at');
    return;
  }
  if (effect.name === 'consume' || effect.name === 'approval') {
    const expectedPath = effect.name === 'consume'
      ? `${reviewId}/submissions/${idempotencyKey}/consumed`
      : `approvals/${idempotencyKey}/consumed`;
    if (effect.mode !== 'CREATE_ONCE_JSON' || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== expectedPath) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${effect.name} effect target is invalid`);
    }
    const consumed = requireExactPayload(effect.payload, [
      'schema_version', 'state', 'review_id', 'idempotency_key', 'consumed_at',
    ], effect.name);
    if (consumed.schema_version !== 1 || consumed.state !== 'CONSUMED'
      || validateUuid(consumed.review_id, `${effect.name} review_id`) !== reviewId
      || validateUuid(consumed.idempotency_key, `${effect.name} idempotency_key`) !== idempotencyKey) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', `${effect.name} identity conflicts`);
    }
    requirePayloadTimestamp(consumed.consumed_at, `${effect.name} consumed_at`);
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
  if (!Array.isArray(value.effects) || value.effects.length > 64) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction effects are invalid');
  }
  const effects = value.effects.map(validateDurableEffect);
  for (const effect of effects) {
    validateTypedEffectPayload(effect, reviewId, idempotencyKey);
    if (effect.mode === 'REMOVE_MATCHING_ACTIVE' && (
      effect.name !== 'active-overlay'
      || effect.target.area !== 'REVIEW_STATE'
      || effect.target.path !== 'active.json'
      || effect.review_id !== reviewId
    )) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active cleanup must match the transaction review identity');
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
    expected_revision: value.expected_revision as number,
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
  if (options.crashAt === boundary) throw new Error(`injected crash at ${boundary}`);
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

async function applyReviewRevision(
  path: string,
  payload: unknown,
  prepared: PreparedDurableTransaction,
): Promise<void> {
  if (!isPlainObject(payload)) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review payload is malformed');
  const current = await readJsonIfPresent(path);
  if (current === undefined && prepared.expected_revision === 0) {
    await atomicCreatePrivateJson(path, {
      ...payload,
      revision: 1,
      last_applied_transaction_id: prepared.transaction_id,
    });
    return;
  }
  if (!isPlainObject(current) || !Number.isSafeInteger(current.revision)) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review record is missing or malformed');
  }
  if (
    current.revision === prepared.expected_revision + 1
    && current.last_applied_transaction_id === prepared.transaction_id
  ) return;
  if (current.revision !== prepared.expected_revision) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'review revision is ambiguous');
  }
  await atomicWritePrivateJson(path, {
    ...payload,
    revision: prepared.expected_revision + 1,
    last_applied_transaction_id: prepared.transaction_id,
  });
}

async function removeMatchingActive(path: string, reviewId: string): Promise<void> {
  const value = await readJsonIfPresent(path);
  if (value === undefined) return;
  if (!isPlainObject(value) || typeof value.review_id !== 'string') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'active pointer is malformed');
  }
  if (value.review_id === reviewId) await rm(path, { force: true });
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
  if (effect.mode === 'CREATE_ONCE_JSON') {
    await createOnceMatching(path, effect.payload);
    return;
  }
  if (effect.mode === 'APPLY_REVIEW_REVISION') {
    await applyReviewRevision(path, effect.payload, prepared);
    return;
  }
  await removeMatchingActive(path, effect.review_id!);
}

async function cleanupLocator(paths: ReviewPersistencePaths, prepared: PreparedDurableTransaction): Promise<void> {
  if (prepared.journal_scope === 'START') return;
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
  const files = transactionPaths(paths, prepared.review_id, prepared.idempotency_key, prepared.journal_scope);
  const committedValue = await readJsonIfPresent(files.committed);
  if (committedValue !== undefined) {
    const committed = parseCommitted(committedValue);
    if (committed.input_digest !== prepared.input_digest || committed.transaction_id !== prepared.transaction_id) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'committed transaction conflicts with its intent');
    }
    await cleanupLocator(paths, prepared);
    return { state: 'COMMITTED', response: committed.response };
  }

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
  const files = transactionPaths(paths, plan.review_id, plan.idempotency_key, journalScope);
  const existingCommitted = await readJsonIfPresent(files.committed);
  if (existingCommitted !== undefined) {
    const committed = parseCommitted(existingCommitted);
    if (committed.input_digest !== digest) {
      throw new ReviewPersistenceError('IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different input');
    }
    const preparedValue = await readJsonIfPresent(files.prepared);
    if (preparedValue === undefined) throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'committed transaction has no intent');
    const prepared = parsePrepared(preparedValue);
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
    maybeCrash('before:prepared', options);
    await atomicCreatePrivateJson(files.prepared, prepared);
    await publishLocator(paths, prepared);
    maybeCrash('after:prepared', options);
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
    journalScope === 'START' ? ['start'] : ['journal', 'mutation'],
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

async function recoverPendingReviewTransactionsLocked(
  paths: ReviewPersistencePaths,
  heldReviewId?: string,
): Promise<DurableTransactionResult[]> {
  await readActiveReview(paths);
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
    if (await readJsonIfPresent(files.committed) !== undefined) continue;
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
