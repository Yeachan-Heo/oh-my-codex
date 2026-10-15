import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withCrossProcessFileLockSync } from '../subagents/tracker.js';
import type { NotificationEvent, FullNotificationPayload } from './types.js';

const SESSION_ID_SAFE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const LIFECYCLE_DEDUPE_FILE = 'lifecycle-notif-state.json';
const LIFECYCLE_DEDUPE_WINDOW_MS = 5_000;
const LIFECYCLE_HOOK_CLAIM_WINDOW_MS = 120_000;
const DEDUPED_EVENTS = new Set<NotificationEvent>(['session-start', 'session-stop', 'session-end']);

interface LifecycleDedupeEntry {
  fingerprint?: string;
  sentAt?: string;
  claimId?: string;
  claimedAt?: string;
}

interface LifecycleDedupeState {
  events?: Record<string, LifecycleDedupeEntry>;
  hookEvents?: Record<string, LifecycleDedupeEntry>;
}

function normalizeFingerprint(payload: FullNotificationPayload): string {
  return JSON.stringify({
    event: payload.event,
    reason: payload.reason || '',
    activeMode: payload.activeMode || '',
    question: payload.question || '',
    incompleteTasks: payload.incompleteTasks || 0,
  });
}

function getStatePath(stateDir: string, sessionId: string): string {
  if (SESSION_ID_SAFE_PATTERN.test(sessionId)) {
    return join(stateDir, 'sessions', sessionId, LIFECYCLE_DEDUPE_FILE);
  }
  return join(stateDir, LIFECYCLE_DEDUPE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStateFromDisk(path: string): LifecycleDedupeState | null {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(parsed)
      || (parsed.events !== undefined && !isRecord(parsed.events))
      || (parsed.hookEvents !== undefined && !isRecord(parsed.hookEvents))) return null;
    return parsed as LifecycleDedupeState;
  } catch {
    return null;
  }
}

function readState(path: string): LifecycleDedupeState {
  return readStateFromDisk(path) ?? {};
}

function readBucketState(
  state: LifecycleDedupeState,
  bucket: 'events' | 'hookEvents',
): Record<string, LifecycleDedupeEntry> {
  const bucketState = state[bucket];
  return isRecord(bucketState) ? bucketState as Record<string, LifecycleDedupeEntry> : {};
}

function writeState(
  path: string,
  state: LifecycleDedupeState,
  publish: (contents: string) => void,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    publish(JSON.stringify(state, null, 2));
    return true;
  } catch {
    // best effort
    return false;
  }
}

export function shouldDedupeLifecycleNotification(event: NotificationEvent): boolean {
  return DEDUPED_EVENTS.has(event);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nestedValue]) => nestedValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`);
  return `{${entries.join(',')}}`;
}

function shouldSendFingerprint(
  previous: LifecycleDedupeEntry | undefined,
  fingerprint: string,
  nowMs: number,
): boolean {
  if (!previous || previous.fingerprint !== fingerprint) return true;
  if (!previous.sentAt) return false;

  const previousMs = Date.parse(previous.sentAt);
  if (!Number.isFinite(previousMs)) return false;
  return nowMs - previousMs >= LIFECYCLE_DEDUPE_WINDOW_MS;
}

function pruneExpiredChildTurnEntries(
  hookEvents: Record<string, LifecycleDedupeEntry>,
  nowMs: number,
): void {
  for (const [key, entry] of Object.entries(hookEvents)) {
    if (!key.startsWith('subagent-stop:')) continue;
    if (entry?.claimId) {
      const claimedAtMs = Date.parse(entry.claimedAt ?? '');
      if (!Number.isFinite(claimedAtMs) || nowMs - claimedAtMs >= LIFECYCLE_HOOK_CLAIM_WINDOW_MS) delete hookEvents[key];
      continue;
    }
    const sentAtMs = Date.parse(entry?.sentAt ?? '');
    if (!Number.isFinite(sentAtMs) || nowMs - sentAtMs >= LIFECYCLE_DEDUPE_WINDOW_MS) delete hookEvents[key];
  }
}

function shouldSendScopedLifecycleBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  bucket: 'events' | 'hookEvents',
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): boolean {
  if (!sessionId || !stateDir) return true;

  const path = getStatePath(stateDir, sessionId);
  const state = readState(path);
  const bucketState = readBucketState(state, bucket);
  return shouldSendFingerprint(bucketState?.[eventKey], fingerprint, nowMs);
}

function recordScopedLifecycleBroadcastSent(
  stateDir: string,
  sessionId: string | undefined,
  bucket: 'events' | 'hookEvents',
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !stateDir) return;

  const path = getStatePath(stateDir, sessionId);
  try {
    withCrossProcessFileLockSync(path, (lock) => {
      const state = readState(path);
      const bucketState = readBucketState(state, bucket);
      if (bucket === 'hookEvents') {
        pruneExpiredChildTurnEntries(bucketState, nowMs);
      }
      bucketState[eventKey] = {
        fingerprint,
        sentAt: new Date(nowMs).toISOString(),
      };
      state[bucket] = bucketState;
      lock.assertOwnership();
      writeState(path, state, lock.publish);
    });
  } catch {
    // Lifecycle receipts are best effort; lock failure must not break hook dispatch.
  }
}

export function createLifecycleBroadcastFingerprint(value: unknown): string {
  return stableSerialize(value);
}

export function shouldSendLifecycleNotification(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
): boolean {
  if (!shouldDedupeLifecycleNotification(payload.event)) return true;
  return shouldSendScopedLifecycleBroadcast(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    nowMs,
  );
}

export function recordLifecycleNotificationSent(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
): void {
  if (!shouldDedupeLifecycleNotification(payload.event)) return;
  recordScopedLifecycleBroadcastSent(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    nowMs,
  );
}

export function shouldSendLifecycleHookBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): boolean {
  return shouldSendScopedLifecycleBroadcast(
    stateDir,
    sessionId,
    'hookEvents',
    eventKey,
    fingerprint,
    nowMs,
  );
}

export function claimLifecycleHookBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): { acquired: true; claimId?: string } | { acquired: false; reason: 'duplicate' | 'unavailable' } {
  if (!sessionId || !stateDir) return { acquired: true };

  const path = getStatePath(stateDir, sessionId);
  const claimId = randomUUID();
  try {
    return withCrossProcessFileLockSync(path, (lock) => {
      const state = readStateFromDisk(path);
      if (!state) return { acquired: false, reason: 'unavailable' };
      const hookEvents = readBucketState(state, 'hookEvents');
      pruneExpiredChildTurnEntries(hookEvents, nowMs);
      const previous = hookEvents[eventKey];
      if (previous?.claimId) {
        const claimedAtMs = Date.parse(previous.claimedAt ?? '');
        if (Number.isFinite(claimedAtMs) && nowMs - claimedAtMs < LIFECYCLE_HOOK_CLAIM_WINDOW_MS) {
          return { acquired: false, reason: 'duplicate' };
        }
      } else if (!shouldSendFingerprint(previous, fingerprint, nowMs)) {
        return { acquired: false, reason: 'duplicate' };
      }

      hookEvents[eventKey] = {
        fingerprint,
        claimId,
        claimedAt: new Date(nowMs).toISOString(),
      };
      state.hookEvents = hookEvents;
      lock.assertOwnership();
      if (!writeState(path, state, lock.publish)) return { acquired: false, reason: 'unavailable' };
      return { acquired: true, claimId };
    });
  } catch {
    // Do not run side-effecting hooks without an atomic child-completion claim.
    return { acquired: false, reason: 'unavailable' };
  }
}

export function renewLifecycleHookBroadcastClaim(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  claimId: string,
  nowMs: number = Date.now(),
): boolean {
  if (!sessionId || !stateDir || !claimId) return false;

  const path = getStatePath(stateDir, sessionId);
  try {
    return withCrossProcessFileLockSync(path, (lock) => {
      const state = readStateFromDisk(path);
      if (!state) return false;
      const hookEvents = readBucketState(state, 'hookEvents');
      const previous = hookEvents[eventKey];
      if (previous?.claimId !== claimId || previous.fingerprint !== fingerprint) return false;
      hookEvents[eventKey] = {
        ...previous,
        claimedAt: new Date(nowMs).toISOString(),
      };
      state.hookEvents = hookEvents;
      lock.assertOwnership();
      return writeState(path, state, lock.publish);
    });
  } catch {
    return false;
  }
}

export function completeLifecycleHookBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  claimId: string,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !stateDir || !claimId) return;

  const path = getStatePath(stateDir, sessionId);
  try {
    withCrossProcessFileLockSync(path, (lock) => {
      const state = readState(path);
      const hookEvents = readBucketState(state, 'hookEvents');
      const previous = hookEvents[eventKey];
      if (previous?.claimId !== claimId || previous.fingerprint !== fingerprint) return;
      hookEvents[eventKey] = {
        fingerprint,
        sentAt: new Date(nowMs).toISOString(),
      };
      state.hookEvents = hookEvents;
      pruneExpiredChildTurnEntries(hookEvents, nowMs);
      lock.assertOwnership();
      writeState(path, state, lock.publish);
    });
  } catch {
    // Lifecycle receipts are best effort; lock failure must not break hook dispatch.
  }
}

export function releaseLifecycleHookBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  claimId: string,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !stateDir || !claimId) return;

  const path = getStatePath(stateDir, sessionId);
  try {
    withCrossProcessFileLockSync(path, (lock) => {
      const state = readState(path);
      const hookEvents = readBucketState(state, 'hookEvents');
      const previous = hookEvents[eventKey];
      if (previous?.claimId !== claimId || previous.fingerprint !== fingerprint) return;
      delete hookEvents[eventKey];
      if (Object.keys(hookEvents).length > 0) state.hookEvents = hookEvents;
      else delete state.hookEvents;
      pruneExpiredChildTurnEntries(hookEvents, nowMs);
      lock.assertOwnership();
      writeState(path, state, lock.publish);
    });
  } catch {
    // Lifecycle receipts are best effort; lock failure must not break hook dispatch.
  }
}

export function recordLifecycleHookBroadcastSent(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): void {
  recordScopedLifecycleBroadcastSent(
    stateDir,
    sessionId,
    'hookEvents',
    eventKey,
    fingerprint,
    nowMs,
  );
}
