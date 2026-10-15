import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NotificationEvent, FullNotificationPayload } from './types.js';

const SESSION_ID_SAFE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const LIFECYCLE_DEDUPE_FILE = 'lifecycle-notif-state.json';
const LIFECYCLE_DEDUPE_WINDOW_MS = 5_000;
const DEDUPED_EVENTS = new Set<NotificationEvent>(['session-start', 'session-stop', 'session-end']);

interface LifecycleDedupeEntry {
  fingerprint?: string;
  sentAt?: string;
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

function readState(path: string): LifecycleDedupeState {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LifecycleDedupeState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: LifecycleDedupeState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // best effort
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
  const bucketState = state[bucket] && typeof state[bucket] === 'object'
    ? state[bucket]
    : {};
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
  const state = readState(path);
  const bucketState = state[bucket] && typeof state[bucket] === 'object'
    ? state[bucket]
    : {};
  if (bucket === 'hookEvents') {
    for (const [key, entry] of Object.entries(bucketState)) {
      if (!key.startsWith('subagent-stop:')) continue;
      const sentAtMs = Date.parse(entry?.sentAt ?? '');
      if (!Number.isFinite(sentAtMs) || nowMs - sentAtMs >= LIFECYCLE_DEDUPE_WINDOW_MS) delete bucketState[key];
    }
  }
  bucketState[eventKey] = {
    fingerprint,
    sentAt: new Date(nowMs).toISOString(),
  };
  state[bucket] = bucketState;
  writeState(path, state);
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
