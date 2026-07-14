import { createHash, randomUUID } from 'node:crypto';
import { constants, watch } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveStateScope } from '../state/paths.js';
import { sanitizeForPersistence } from './redaction.js';
import { renderFinalReviewMarkdown, validateFinalReviewArtifact } from './render.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOCK_WAIT_MS = 5_000;
const PROCESS_START_MARKER = `${process.pid}:${Math.round(Date.now() - process.uptime() * 1_000)}`;

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
  journalLockPath: string;
  mutationLockPath: string;
  startTransactionsRoot: string;
  pendingReviewTransactionsRoot: string;
  approvalsRoot: string;
  stopTerminalBriefPath: string;
  stopTerminalBriefConsumedPath: string;
  reviewsRoot: string;
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
    journalLockPath: join(reviewRoot, 'journal.lock'),
    mutationLockPath: join(reviewRoot, 'mutation.lock'),
    startTransactionsRoot: join(reviewRoot, 'start-transactions'),
    pendingReviewTransactionsRoot: join(reviewRoot, 'pending-review-transactions'),
    approvalsRoot: join(reviewRoot, 'approvals'),
    stopTerminalBriefPath: join(reviewRoot, 'stop-terminal-brief.json'),
    stopTerminalBriefConsumedPath: join(reviewRoot, 'stop-terminal-brief-consumed.json'),
    reviewsRoot: join(workingDirectory, '.omx', 'reviews'),
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

function lockPath(paths: ReviewPersistencePaths, name: ReviewLockName): string {
  if (name === 'start') return paths.startLockPath;
  if (name === 'journal') return paths.journalLockPath;
  return paths.mutationLockPath;
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

async function defaultOwnerProbe(owner: ReviewLockOwner): Promise<ReviewLockOwnerStatus> {
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'absent' : 'unknown';
  }
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
  name: ReviewLockName,
  options: AcquireReviewLocksOptions,
  deadline: number,
  now: () => number,
): Promise<ReviewLockHandle> {
  const path = lockPath(paths, name);
  const ownerProbe = options.ownerProbe ?? defaultOwnerProbe;
  const waitForChange = options.waitForChange ?? defaultWaitForLockChange;
  while (true) {
    const nonce = randomUUID();
    const owner: ReviewLockOwner = {
      pid: process.pid,
      hostname: hostname(),
      process_start_marker: PROCESS_START_MARKER,
      nonce,
      acquired_at: new Date().toISOString(),
    };
    if (await publishLock(path, owner)) return { name, path, nonce };

    const currentOwner = await readLockOwner(path);
    if (currentOwner?.hostname === hostname()) {
      const status = await ownerProbe(currentOwner);
      if (status === 'absent' && await reclaimAbsentOwner(path, currentOwner.nonce)) continue;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new ReviewPersistenceError('PERSISTENCE_LOCKED', `review ${name} lock is held`);
    }
    await waitForChange(path, remaining);
  }
}

export async function acquireReviewLocks(
  paths: ReviewPersistencePaths,
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
      const handle = await acquireSingleLock(paths, name, options, deadline, now);
      acquired.push(handle);
      options.onAcquired?.(name);
    }
    return acquired;
  } catch (error) {
    await releaseReviewLocks(acquired);
    throw error;
  }
}

async function releaseReviewLock(handle: ReviewLockHandle): Promise<boolean> {
  const owner = await readLockOwner(handle.path);
  if (owner?.nonce !== handle.nonce) return false;
  try {
    await rm(handle.path);
    return true;
  } catch {
    return false;
  }
}

export async function releaseReviewLocks(handles: readonly ReviewLockHandle[]): Promise<boolean[]> {
  const results = Array.from({ length: handles.length }, () => false);
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    results[index] = await releaseReviewLock(handles[index]!);
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

function parsePrepared(value: unknown): PreparedDurableTransaction {
  if (!isPlainObject(value)
    || value.schema_version !== 1
    || value.state !== 'PREPARED'
    || typeof value.transaction_id !== 'string'
    || (value.journal_scope !== 'START' && value.journal_scope !== 'REVIEW')
    || typeof value.idempotency_key !== 'string'
    || typeof value.input_digest !== 'string'
    || typeof value.operation !== 'string'
    || typeof value.review_id !== 'string'
    || !Number.isSafeInteger(value.expected_revision)
    || !Array.isArray(value.effects)
    || typeof value.prepared_at !== 'string') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'prepared transaction is malformed');
  }
  return value as unknown as PreparedDurableTransaction;
}

function parseCommitted(value: unknown): CommittedDurableTransaction {
  if (!isPlainObject(value)
    || value.schema_version !== 1
    || value.state !== 'COMMITTED'
    || typeof value.transaction_id !== 'string'
    || typeof value.idempotency_key !== 'string'
    || typeof value.input_digest !== 'string'
    || typeof value.committed_at !== 'string') {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'committed transaction is malformed');
  }
  return value as unknown as CommittedDurableTransaction;
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

async function applyEffect(
  paths: ReviewPersistencePaths,
  effect: DurableTransactionEffect,
  prepared: PreparedDurableTransaction,
): Promise<void> {
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
  if (!isPlainObject(locator) || locator.transaction_id !== prepared.transaction_id) {
    throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction recovery locator conflicts');
  }
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
    const locatorPath = join(paths.pendingReviewTransactionsRoot, prepared.transaction_id);
    await createOnceMatching(locatorPath, {
      schema_version: 1,
      transaction_id: prepared.transaction_id,
      review_id: prepared.review_id,
      idempotency_key: prepared.idempotency_key,
      input_digest: prepared.input_digest,
    });
  }
  maybeCrash('after:locator', options);

  for (const name of DURABLE_EFFECT_ORDER) {
    const effects = prepared.effects.filter((effect) => effect.name === name);
    if (effects.length === 0) continue;
    maybeCrash(`before:${name}`, options);
    for (const effect of effects) await applyEffect(paths, effect, prepared);
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
      expected_revision: plan.expected_revision,
      effects: plan.effects,
      response: plan.response,
      prepared_at: new Date().toISOString(),
    };
    maybeCrash('before:prepared', options);
    await atomicCreatePrivateJson(files.prepared, prepared);
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
  const locks = await acquireReviewLocks(paths, journalScope === 'START'
    ? ['start', 'journal', 'mutation']
    : ['journal', 'mutation']);
  try {
    return await runDurableTransactionLocked(paths, plan, options);
  } finally {
    await releaseReviewLocks(locks);
  }
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
  const locks = await acquireReviewLocks(paths, journalScope === 'START'
    ? ['start', 'journal', 'mutation']
    : ['journal', 'mutation']);
  try {
    const files = transactionPaths(paths, reviewId, key, journalScope);
    const preparedValue = await readJsonIfPresent(files.prepared);
    if (preparedValue === undefined) return null;
    const prepared = parsePrepared(preparedValue);
    if (prepared.journal_scope !== journalScope) {
      throw new ReviewPersistenceError('PERSISTENCE_FAILED', 'transaction journal scope conflicts');
    }
    return await executePrepared(paths, prepared, {});
  } finally {
    await releaseReviewLocks(locks);
  }
}

export async function writeFinalReviewArtifacts(
  paths: ReviewPersistencePaths,
  value: unknown,
): Promise<{ jsonPath: string; markdownPath: string; artifact_sha256: string }> {
  const artifact = validateFinalReviewArtifact(sanitizeForPersistence(value, {
    repositoryRoot: paths.workingDirectory,
  }));
  const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;
  const markdown = renderFinalReviewMarkdown(artifact);
  const jsonPath = join(paths.reviewsRoot, `${artifact.review_id}.json`);
  const markdownPath = join(paths.reviewsRoot, `${artifact.review_id}.md`);
  await atomicWritePrivateText(jsonPath, jsonText);
  await atomicWritePrivateText(markdownPath, markdown);
  return {
    jsonPath,
    markdownPath,
    artifact_sha256: createHash('sha256').update(jsonText, 'utf8').digest('hex'),
  };
}
