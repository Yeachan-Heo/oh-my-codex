import { createHash, randomBytes } from 'crypto';
import { constants } from 'fs';
import { mkdir, open, readFile, readdir, rename, rm, lstat, link, unlink } from 'fs/promises';
import { dirname, join } from 'path';

export const NOTIFY_FALLBACK_SCHEMA_VERSION = 1;
export const NOTIFY_FALLBACK_LEASE_MS = 30_000;
export const NOTIFY_FALLBACK_RETRY_DELAY_MS = 250;
export const NOTIFY_FALLBACK_RETENTION_MS = 26 * 60 * 60 * 1000;
export const NOTIFY_FALLBACK_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const MAX_ERROR_MESSAGE_LENGTH = 240;

type WatcherMode = 'persistent' | 'once';
type DecisionKind = 'effect_started' | 'retry_authorized';

interface Identity {
  schema_version: 1;
  key_hash: string;
  thread_id: string;
  turn_id: string;
}
interface Claim extends Identity {
  attempt: 1 | 2;
  owner_token: string;
  watcher_mode: WatcherMode;
  claimed_at_ms: number;
  lease_expires_at_ms: number;
  event_timestamp_ms: number;
  rollout_path_hash: string;
}
interface Decision extends Identity {
  attempt: 1 | 2;
  owner_token: string;
  publisher_token: string;
  published_at_ms: number;
  kind: DecisionKind;
  reason?: 'pre_effect_lease_expired';
  observed_lease_expires_at_ms?: number;
}
interface Delivered extends Identity {
  attempt: 1 | 2;
  owner_token: string;
  published_at_ms: number;
  kind: 'delivered';
  child_pid: number;
  exit_code: 0;
}
interface FailedPrestart extends Identity {
  attempt: 1 | 2;
  owner_token: string;
  published_at_ms: number;
  kind: 'failed_prestart';
  retry_after_ms: number;
  error_code: string;
  error_message: string;
  terminal: boolean;
}
interface Ambiguous extends Identity {
  attempt: 1 | 2;
  owner_token: string;
  published_at_ms: number;
  kind: 'ambiguous';
  reason: 'nonzero' | 'signal' | 'hook_timeout' | 'authority_deadline' | 'termination_unconfirmed' | 'parent_exit' | 'unknown';
  child_pid: number | null;
  status: number | null;
  signal: string | null;
  non_compactable: boolean;
}
type Outcome = Delivered | FailedPrestart | Ambiguous;

export type FallbackDeliveryResult =
  | { kind: 'acquired_effect'; attempt: 1 | 2 }
  | { kind: 'active_skip'; reason: string }
  | { kind: 'retry_eligible'; reason: string }
  | { kind: 'terminal_delivered' | 'terminal_ambiguous' | 'terminal_failed'; attempt: 1 | 2 }
  | { kind: 'invalid_skip' | 'io_skip' | 'deadline_skip'; reason: string };

export interface HookSpawnResult {
  spawned: boolean;
  childPid?: number | null;
  status?: number | null;
  signal?: string | null;
  error?: unknown;
  timedOut?: boolean;
  terminationUnconfirmed?: boolean;
  authorityDeadline?: boolean;
}
export interface FallbackDeliveryOptions {
  stateDir: string;
  threadId: string;
  turnId: string;
  eventTimestampMs: number;
  rolloutPath: string;
  watcherMode: WatcherMode;
  deadlineAtMs: number;
  now?: () => number;
  stopping?: () => boolean;
  spawnHook: () => Promise<HookSpawnResult>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isSafeMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
function validIdentity(value: Record<string, unknown>, identity: Identity): boolean {
  return value.schema_version === 1 && value.key_hash === identity.key_hash && value.thread_id === identity.thread_id && value.turn_id === identity.turn_id;
}
function validAttempt(value: unknown): value is 1 | 2 { return value === 1 || value === 2; }
function keyHash(threadId: string, turnId: string): string {
  const part = (value: string) => { const data = Buffer.from(value, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, data]); };
  return createHash('sha256').update(Buffer.from('omx-notify-fallback-delivery-v1\0')).update(part(threadId)).update(part(turnId)).digest('hex');
}
function randomToken(): string { return randomBytes(32).toString('hex'); }
function isDeadlineOpen(now: number, deadline: number, stopping?: () => boolean): boolean { return now < deadline && !stopping?.(); }
function identityFor(threadId: string, turnId: string): Identity { return { schema_version: 1, key_hash: keyHash(threadId, turnId), thread_id: threadId, turn_id: turnId }; }
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error || 'unknown')).slice(0, MAX_ERROR_MESSAGE_LENGTH); }

async function syncFile(file: Awaited<ReturnType<typeof open>>): Promise<void> { await file.sync(); }
async function syncDir(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try { handle = await open(path, constants.O_RDONLY); await handle.sync(); }
  catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' && process.platform === 'win32') return;
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(code || '')) throw error;
  } finally { await handle?.close().catch(() => {}); }
}

async function safeDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe_directory_path');
}

async function privateJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await syncFile(handle); } finally { await handle.close(); }
}
async function publishJson(path: string, value: unknown): Promise<boolean> {
  const candidate = `${path}.${randomToken()}.candidate`;
  try {
    await privateJson(candidate, value);
    await link(candidate, path);
    await unlink(candidate);
    await syncDir(dirname(path));
    return true;
  } catch (error: unknown) {
    await unlink(candidate).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe_record_path');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!isObject(parsed)) throw new Error('invalid_record');
  return parsed;
}
function validateClaim(value: Record<string, unknown>, identity: Identity): boolean {
  return exactKeys(value, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'attempt', 'owner_token', 'watcher_mode', 'claimed_at_ms', 'lease_expires_at_ms', 'event_timestamp_ms', 'rollout_path_hash'])
    && validIdentity(value, identity) && validAttempt(value.attempt) && typeof value.owner_token === 'string' && TOKEN_RE.test(value.owner_token)
    && (value.watcher_mode === 'persistent' || value.watcher_mode === 'once') && isSafeMs(value.claimed_at_ms) && isSafeMs(value.lease_expires_at_ms)
    && value.lease_expires_at_ms === value.claimed_at_ms + NOTIFY_FALLBACK_LEASE_MS && isSafeMs(value.event_timestamp_ms)
    && typeof value.rollout_path_hash === 'string' && TOKEN_RE.test(value.rollout_path_hash);
}
function validateDecision(value: Record<string, unknown>, identity: Identity): boolean {
  const effect = exactKeys(value, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'attempt', 'owner_token', 'publisher_token', 'published_at_ms', 'kind']);
  const retry = exactKeys(value, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'attempt', 'owner_token', 'publisher_token', 'published_at_ms', 'kind', 'reason', 'observed_lease_expires_at_ms']);
  return (effect || retry) && validIdentity(value, identity) && validAttempt(value.attempt) && typeof value.owner_token === 'string' && TOKEN_RE.test(value.owner_token)
    && typeof value.publisher_token === 'string' && TOKEN_RE.test(value.publisher_token) && isSafeMs(value.published_at_ms)
    && ((value.kind === 'effect_started' && effect && value.publisher_token === value.owner_token) || (value.kind === 'retry_authorized' && retry && value.reason === 'pre_effect_lease_expired' && isSafeMs(value.observed_lease_expires_at_ms)));
}
function validateOutcome(value: Record<string, unknown>, identity: Identity): boolean {
  if (!validIdentity(value, identity) || !validAttempt(value.attempt) || typeof value.owner_token !== 'string' || !TOKEN_RE.test(value.owner_token) || !isSafeMs(value.published_at_ms)) return false;
  if (value.kind === 'delivered') return exactKeys(value, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'attempt', 'owner_token', 'published_at_ms', 'kind', 'child_pid', 'exit_code']) && typeof value.child_pid === 'number' && Number.isSafeInteger(value.child_pid) && value.child_pid > 0 && value.exit_code === 0;
  if (value.kind === 'failed_prestart') return exactKeys(value, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'attempt', 'owner_token', 'published_at_ms', 'kind', 'retry_after_ms', 'error_code', 'error_message', 'terminal']) && isSafeMs(value.retry_after_ms) && typeof value.error_code === 'string' && typeof value.error_message === 'string' && value.error_message.length <= MAX_ERROR_MESSAGE_LENGTH && typeof value.terminal === 'boolean' && value.terminal === (value.attempt === 2);
  return value.kind === 'ambiguous' && exactKeys(value, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'attempt', 'owner_token', 'published_at_ms', 'kind', 'reason', 'child_pid', 'status', 'signal', 'non_compactable']) && ['nonzero', 'signal', 'hook_timeout', 'authority_deadline', 'termination_unconfirmed', 'parent_exit', 'unknown'].includes(String(value.reason)) && (value.child_pid === null || (typeof value.child_pid === 'number' && Number.isSafeInteger(value.child_pid) && value.child_pid > 0)) && (value.status === null || (typeof value.status === 'number' && Number.isSafeInteger(value.status))) && (value.signal === null || typeof value.signal === 'string') && typeof value.non_compactable === 'boolean' && value.non_compactable === (value.reason === 'termination_unconfirmed');
}
async function createKey(root: string, keyDir: string, identity: Identity, now: number): Promise<boolean> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const privateDir = `${keyDir}.${randomToken()}.new`;
  try {
    await mkdir(privateDir, { mode: 0o700 });
    await privateJson(join(privateDir, 'key.json'), { ...identity, created_at_ms: now });
    await syncDir(privateDir);
    await rename(privateDir, keyDir);
    await syncDir(dirname(keyDir));
    return true;
  } catch (error: unknown) {
    await rm(privateDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
    throw error;
  }
}
async function createClaim(attemptDir: string, claim: Claim): Promise<boolean> {
  const privateDir = `${attemptDir}.init.${claim.owner_token}`;
  const ownerDir = join(privateDir, `owner-${claim.owner_token}`);
  try {
    await mkdir(privateDir, { mode: 0o700 });
    await mkdir(ownerDir, { mode: 0o700 });
    await privateJson(join(ownerDir, 'claim.json'), claim);
    await syncDir(ownerDir);
    await syncDir(privateDir);
    await rename(privateDir, attemptDir);
    await syncDir(dirname(attemptDir));
    return true;
  } catch (error: unknown) {
    await rm(privateDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
    throw error;
  }
}
async function loadClaim(attemptDir: string, identity: Identity): Promise<Claim | null> {
  const entry = await lstat(attemptDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe_directory_path');
  const names = await readdir(attemptDir);
  const owners = names.filter((name) => /^owner-[a-f0-9]{64}$/.test(name));
  if (owners.length !== 1) { if (owners.length > 1) throw new Error('multiple_claims'); return null; }
  const ownerDir = join(attemptDir, owners[0]);
  await safeDirectory(ownerDir);
  const value = await readJson(join(ownerDir, 'claim.json'));
  if (!value || !validateClaim(value, identity) || owners[0] !== `owner-${value.owner_token}`) throw new Error('invalid_claim');
  return value as unknown as Claim;
}
function attemptPaths(keyDir: string, attempt: 1 | 2) { const dir = join(keyDir, `attempt-${attempt}`); return { dir, decision: join(dir, 'decision'), outcome: join(dir, 'outcome') }; }
function isClaimBound(value: Decision | Outcome, claim: Claim): boolean { return value.attempt === claim.attempt && value.owner_token === claim.owner_token; }
function terminalResult(outcome: Outcome): FallbackDeliveryResult { return outcome.kind === 'delivered' ? { kind: 'terminal_delivered', attempt: outcome.attempt } : outcome.kind === 'ambiguous' ? { kind: 'terminal_ambiguous', attempt: outcome.attempt } : { kind: 'terminal_failed', attempt: outcome.attempt }; }

export async function deliverNotifyFallback(options: FallbackDeliveryOptions): Promise<FallbackDeliveryResult> {
  const now = options.now ?? Date.now;
  const timestampNow = now();
  if (!options.threadId || !options.turnId || !isSafeMs(options.eventTimestampMs) || options.eventTimestampMs > timestampNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS) return { kind: 'invalid_skip', reason: 'invalid_event_timestamp' };
  if (!isDeadlineOpen(timestampNow, options.deadlineAtMs, options.stopping)) return { kind: 'deadline_skip', reason: 'authority_deadline' };
  const identity = identityFor(options.threadId, options.turnId);
  const storeRoot = join(options.stateDir, 'notify-fallback-delivery-v1');
  const root = join(storeRoot, identity.key_hash.slice(0, 2));
  const keyDir = join(root, `${identity.key_hash}.key`);
  try {
    await mkdir(storeRoot, { recursive: true, mode: 0o700 });
    await safeDirectory(storeRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await safeDirectory(root);
    let names = await readdir(root);
    if (names.some((name) => name.startsWith(`${identity.key_hash}.gc.`))) return { kind: 'active_skip', reason: 'gc_suppression' };
    await createKey(root, keyDir, identity, timestampNow);
    names = await readdir(root);
    if (names.some((name) => name.startsWith(`${identity.key_hash}.gc.`))) return { kind: 'active_skip', reason: 'gc_suppression' };
    await safeDirectory(keyDir);
    const key = await readJson(join(keyDir, 'key.json'));
    if (!key || !exactKeys(key, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'created_at_ms']) || !validIdentity(key, identity) || !isSafeMs(key.created_at_ms)) return { kind: 'invalid_skip', reason: 'invalid_key' };

    let attempt: 1 | 2 = 1;
    const first = attemptPaths(keyDir, 1);
    const firstOutcomeRaw = await readJson(first.outcome);
    const firstDecisionRaw = await readJson(first.decision);
    const firstClaim = await loadClaim(first.dir, identity);
    if ((firstOutcomeRaw || firstDecisionRaw) && !firstClaim) return { kind: 'invalid_skip', reason: 'missing_claim' };
    if (firstDecisionRaw && (!validateDecision(firstDecisionRaw, identity) || !isClaimBound(firstDecisionRaw as unknown as Decision, firstClaim!))) return { kind: 'invalid_skip', reason: 'invalid_decision' };
    if (firstOutcomeRaw) {
      if (!validateOutcome(firstOutcomeRaw, identity) || !isClaimBound(firstOutcomeRaw as unknown as Outcome, firstClaim!)) return { kind: 'invalid_skip', reason: 'invalid_outcome' };
      const firstOutcome = firstOutcomeRaw as unknown as Outcome;
      if (firstOutcome.kind !== 'failed_prestart') return terminalResult(firstOutcome);
      if (firstOutcome.terminal) return { kind: 'terminal_failed', attempt: firstOutcome.attempt };
      const firstDecision = firstDecisionRaw as unknown as Decision | null;
      if (!firstDecision || (firstDecision.kind !== 'retry_authorized' && firstDecision.kind !== 'effect_started')) return { kind: 'invalid_skip', reason: 'invalid_retry_proof' };
      if (firstDecision.kind === 'retry_authorized') {
        const retryNow = now();
        if (firstDecision.observed_lease_expires_at_ms !== firstClaim!.lease_expires_at_ms || firstDecision.published_at_ms < firstClaim!.lease_expires_at_ms || retryNow < firstClaim!.lease_expires_at_ms || firstClaim!.claimed_at_ms > retryNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS || firstClaim!.lease_expires_at_ms > retryNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS) return { kind: 'invalid_skip', reason: 'invalid_retry_proof' };
      }
      if (now() < firstOutcome.retry_after_ms) return { kind: 'retry_eligible', reason: 'retry_delay' };
      attempt = 2;
    } else if ((firstDecisionRaw as unknown as Decision | null)?.kind === 'retry_authorized') {
      const retryDecision = firstDecisionRaw as unknown as Decision;
      const retryNow = now();
      if (retryDecision.observed_lease_expires_at_ms !== firstClaim!.lease_expires_at_ms || retryDecision.published_at_ms < firstClaim!.lease_expires_at_ms || retryNow < firstClaim!.lease_expires_at_ms || firstClaim!.claimed_at_ms > retryNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS || firstClaim!.lease_expires_at_ms > retryNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS) return { kind: 'invalid_skip', reason: 'invalid_retry_proof' };
      attempt = 2;
    } else if ((firstDecisionRaw as unknown as Decision | null)?.kind === 'effect_started') {
      return { kind: 'active_skip', reason: 'effect_started' };
    }
    const paths = attemptPaths(keyDir, attempt);
    if (!isDeadlineOpen(now(), options.deadlineAtMs, options.stopping)) return { kind: 'deadline_skip', reason: 'authority_deadline' };
    let claim = await loadClaim(paths.dir, identity);
    let ownsClaim = false;
    if (!claim) {
      const token = randomToken();
      const claimNow = now();
      claim = { ...identity, attempt, owner_token: token, watcher_mode: options.watcherMode, claimed_at_ms: claimNow, lease_expires_at_ms: claimNow + NOTIFY_FALLBACK_LEASE_MS, event_timestamp_ms: options.eventTimestampMs, rollout_path_hash: createHash('sha256').update(options.rolloutPath).digest('hex') };
      if (!await createClaim(paths.dir, claim)) return { kind: 'active_skip', reason: 'claim_race' };
      ownsClaim = true;
    }
    if (claim.attempt !== attempt) return { kind: 'invalid_skip', reason: 'invalid_claim' };
    const outcomeRaw = await readJson(paths.outcome);
    if (outcomeRaw) {
      if (!validateOutcome(outcomeRaw, identity) || !isClaimBound(outcomeRaw as unknown as Outcome, claim)) return { kind: 'invalid_skip', reason: 'invalid_outcome' };
      return terminalResult(outcomeRaw as unknown as Outcome);
    }
    const decisionRaw = await readJson(paths.decision);
    if (decisionRaw) {
      if (!validateDecision(decisionRaw, identity) || !isClaimBound(decisionRaw as unknown as Decision, claim)) return { kind: 'invalid_skip', reason: 'invalid_decision' };
      const decision = decisionRaw as unknown as Decision;
      if (decision.kind === 'retry_authorized' && decision.observed_lease_expires_at_ms !== claim.lease_expires_at_ms) return { kind: 'invalid_skip', reason: 'invalid_retry_proof' };
      return { kind: 'active_skip', reason: decision.kind };
    }
    const decisionNow = now();
    if (claim.claimed_at_ms > decisionNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS || claim.lease_expires_at_ms > decisionNow + NOTIFY_FALLBACK_FUTURE_SKEW_MS) return { kind: 'invalid_skip', reason: 'invalid_lease' };
    if (decisionNow >= claim.lease_expires_at_ms) {
      if (attempt === 2) {
        await publishJson(paths.outcome, { ...identity, attempt, owner_token: claim.owner_token, published_at_ms: decisionNow, kind: 'failed_prestart', retry_after_ms: decisionNow, error_code: 'pre_effect_lease_expired', error_message: 'attempt 2 lease expired before effect start', terminal: true } satisfies FailedPrestart);
        return { kind: 'terminal_failed', attempt };
      }
      const retry: Decision = { ...identity, attempt, owner_token: claim.owner_token, publisher_token: randomToken(), published_at_ms: decisionNow, kind: 'retry_authorized', reason: 'pre_effect_lease_expired', observed_lease_expires_at_ms: claim.lease_expires_at_ms };
      return await publishJson(paths.decision, retry) ? { kind: 'retry_eligible', reason: 'pre_effect_lease_expired' } : { kind: 'active_skip', reason: 'decision_race' };
    }
    if (!ownsClaim) return { kind: 'active_skip', reason: 'active_lease' };
    if (!isDeadlineOpen(decisionNow, options.deadlineAtMs, options.stopping)) return { kind: 'deadline_skip', reason: 'authority_deadline' };
    const effect: Decision = { ...identity, attempt, owner_token: claim.owner_token, publisher_token: claim.owner_token, published_at_ms: decisionNow, kind: 'effect_started' };
    if (!await publishJson(paths.decision, effect)) return { kind: 'active_skip', reason: 'decision_race' };
    if (!isDeadlineOpen(now(), options.deadlineAtMs, options.stopping)) {
      await publishJson(paths.outcome, { ...identity, attempt, owner_token: claim.owner_token, published_at_ms: now(), kind: 'ambiguous', reason: 'authority_deadline', child_pid: null, status: null, signal: null, non_compactable: false } satisfies Ambiguous);
      return { kind: 'deadline_skip', reason: 'authority_deadline' };
    }
    const result = await options.spawnHook();
    const publishedAt = now();
    if (!result.spawned) {
      const failed: FailedPrestart = { ...identity, attempt, owner_token: claim.owner_token, published_at_ms: publishedAt, kind: 'failed_prestart', retry_after_ms: publishedAt + NOTIFY_FALLBACK_RETRY_DELAY_MS, error_code: (result.error as NodeJS.ErrnoException | undefined)?.code || 'spawn_error', error_message: errorText(result.error), terminal: attempt === 2 };
      await publishJson(paths.outcome, failed);
      return attempt === 2 ? { kind: 'terminal_failed', attempt } : { kind: 'retry_eligible', reason: 'failed_prestart' };
    }
    if (result.status === 0 && typeof result.childPid === 'number' && Number.isSafeInteger(result.childPid) && result.childPid > 0) await publishJson(paths.outcome, { ...identity, attempt, owner_token: claim.owner_token, published_at_ms: publishedAt, kind: 'delivered', child_pid: result.childPid, exit_code: 0 } satisfies Delivered);
    else {
      const reason: Ambiguous['reason'] = result.terminationUnconfirmed ? 'termination_unconfirmed' : result.authorityDeadline ? 'authority_deadline' : result.timedOut ? 'hook_timeout' : result.signal ? 'signal' : result.status === 0 ? 'unknown' : result.status === null ? 'unknown' : 'nonzero';
      await publishJson(paths.outcome, { ...identity, attempt, owner_token: claim.owner_token, published_at_ms: publishedAt, kind: 'ambiguous', reason, child_pid: result.childPid || null, status: result.status ?? null, signal: result.signal ?? null, non_compactable: reason === 'termination_unconfirmed' } satisfies Ambiguous);
    }
    return { kind: 'acquired_effect', attempt };
  } catch (error) { return { kind: 'io_skip', reason: errorText(error) }; }
}

async function latestMtime(path: string): Promise<number> {
  const entry = await lstat(path); if (entry.isSymbolicLink()) throw new Error('symlink');
  let latest = entry.mtimeMs;
  if (entry.isDirectory()) for (const name of await readdir(path)) latest = Math.max(latest, await latestMtime(join(path, name)));
  return latest;
}

async function terminalGraph(keyPath: string): Promise<{ terminal: boolean; nonCompactable: boolean; newestRecordMs: number }> {
  await safeDirectory(keyPath);
  const key = await readJson(join(keyPath, 'key.json'));
  if (!key || !exactKeys(key, ['schema_version', 'key_hash', 'thread_id', 'turn_id', 'created_at_ms']) || !isSafeMs(key.created_at_ms)) throw new Error('invalid_key');
  const identity = key as unknown as Identity;
  if (!validIdentity(key, identity)) throw new Error('invalid_key');
  let newestRecordMs = key.created_at_ms;
  const firstClaim = await loadClaim(join(keyPath, 'attempt-1'), identity);
  if (!firstClaim || firstClaim.attempt !== 1) return { terminal: false, nonCompactable: false, newestRecordMs };
  newestRecordMs = Math.max(newestRecordMs, firstClaim.claimed_at_ms);
  const firstOutcomeRaw = await readJson(join(keyPath, 'attempt-1', 'outcome'));
  const firstDecisionRaw = await readJson(join(keyPath, 'attempt-1', 'decision'));
  if (!firstDecisionRaw || !validateDecision(firstDecisionRaw, identity) || !isClaimBound(firstDecisionRaw as unknown as Decision, firstClaim)) throw new Error('invalid_decision');
  const firstDecision = firstDecisionRaw as unknown as Decision;
  newestRecordMs = Math.max(newestRecordMs, firstDecision.published_at_ms);
  if (firstDecision.kind === 'effect_started') {
    if (!firstOutcomeRaw || !validateOutcome(firstOutcomeRaw, identity) || !isClaimBound(firstOutcomeRaw as unknown as Outcome, firstClaim)) return { terminal: false, nonCompactable: false, newestRecordMs };
    const firstOutcome = firstOutcomeRaw as unknown as Outcome;
    newestRecordMs = Math.max(newestRecordMs, firstOutcome.published_at_ms);
    if (firstOutcome.kind === 'ambiguous') return { terminal: true, nonCompactable: firstOutcome.non_compactable, newestRecordMs };
    if (firstOutcome.kind === 'delivered' || firstOutcome.terminal) return { terminal: true, nonCompactable: false, newestRecordMs };
    if (firstOutcome.kind !== 'failed_prestart') return { terminal: false, nonCompactable: false, newestRecordMs };
  } else {
    if (firstDecision.observed_lease_expires_at_ms !== firstClaim.lease_expires_at_ms || firstDecision.published_at_ms < firstClaim.lease_expires_at_ms) return { terminal: false, nonCompactable: false, newestRecordMs };
    if (firstOutcomeRaw) return { terminal: false, nonCompactable: false, newestRecordMs };
  }
  const secondClaim = await loadClaim(join(keyPath, 'attempt-2'), identity);
  if (!secondClaim || secondClaim.attempt !== 2) return { terminal: false, nonCompactable: false, newestRecordMs };
  const secondOutcomeRaw = await readJson(join(keyPath, 'attempt-2', 'outcome'));
  if (!secondOutcomeRaw || !validateOutcome(secondOutcomeRaw, identity) || !isClaimBound(secondOutcomeRaw as unknown as Outcome, secondClaim)) return { terminal: false, nonCompactable: false, newestRecordMs };
  const secondOutcome = secondOutcomeRaw as unknown as Outcome;
  return { terminal: secondOutcome.kind !== 'failed_prestart' || secondOutcome.terminal, nonCompactable: secondOutcome.kind === 'ambiguous' && secondOutcome.non_compactable, newestRecordMs: Math.max(newestRecordMs, secondClaim.claimed_at_ms, secondOutcome.published_at_ms) };
}
export async function compactNotifyFallbackDeliveries(stateDir: string, now = Date.now()): Promise<void> {
  const root = join(stateDir, 'notify-fallback-delivery-v1');
  const rootEntry = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!rootEntry) return;
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('unsafe_directory_path');
  for (const shard of await readdir(root)) {
    const shardPath = join(root, shard);
    await safeDirectory(shardPath);
    for (const name of await readdir(shardPath).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}\.key$/.test(name) && !/^[a-f0-9]{64}\.gc\.[a-f0-9]{64}$/.test(name)) continue;
      const path = join(shardPath, name.includes('.gc.') ? `${name.slice(0, name.indexOf('.gc.'))}.key` : name); const keyPath = name.includes('.gc.') ? join(shardPath, name) : `${path}.gc.${randomToken()}`;
      if (!name.includes('.gc.')) { try { await rename(path, keyPath); } catch { continue; } }
      try {
        const graph = await terminalGraph(keyPath);
        const ageAnchor = Math.max(graph.newestRecordMs, await latestMtime(keyPath));
        if (!graph.terminal || graph.nonCompactable || now - ageAnchor < NOTIFY_FALLBACK_RETENTION_MS) { await rename(keyPath, path).catch(() => {}); continue; }
        await rm(keyPath, { recursive: true });
      } catch { /* retain GC tombstone as suppression authority when validation fails */ }
    }
  }
}
