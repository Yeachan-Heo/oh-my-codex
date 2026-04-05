/**
 * Idle Notification Cooldown
 *
 * Prevents flooding users with session-idle notifications by enforcing a
 * minimum interval between dispatches. Ported from OMC persistent-mode hook.
 *
 * Config key : notifications.idleCooldownSeconds in ~/.codex/.omx-config.json
 * Env var    : OMX_IDLE_COOLDOWN_SECONDS  (overrides config)
 * State file : .omx/state/idle-notif-cooldown.json
 *              (session-scoped when sessionId is available)
 *
 * A cooldown value of 0 disables throttling entirely.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { codexHome } from '../utils/paths.js';

const DEFAULT_COOLDOWN_SECONDS = 60;
const SESSION_ID_SAFE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const MAX_IDLE_FINGERPRINT_LENGTH = 512;
const IDLE_NOTIFICATION_STATE_FILE = 'idle-notif-cooldown.json';
const SESSION_IDLE_HOOK_STATE_FILE = 'session-idle-hook-state.json';

interface IdleNotificationState {
  lastSentAt?: string;
  fingerprint?: string;
}

/**
 * Read the idle notification cooldown in seconds.
 *
 * Resolution order:
 *   1. OMX_IDLE_COOLDOWN_SECONDS env var
 *   2. notifications.idleCooldownSeconds in ~/.codex/.omx-config.json
 *   3. Default: 60 seconds
 */
export function getIdleNotificationCooldownSeconds(): number {
  // 1. Environment variable override
  const envVal = process.env.OMX_IDLE_COOLDOWN_SECONDS;
  if (envVal !== undefined) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  // 2. Config file
  try {
    const configPath = join(codexHome(), '.omx-config.json');
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const notifications = raw?.notifications as Record<string, unknown> | undefined;
      const val = notifications?.idleCooldownSeconds;
      if (typeof val === 'number' && Number.isFinite(val)) {
        return Math.max(0, Math.floor(val));
      }
    }
  } catch {
    // ignore parse errors — fall through to default
  }

  return DEFAULT_COOLDOWN_SECONDS;
}

/**
 * Resolve the path to the cooldown state file.
 * Uses a session-scoped path when sessionId is provided and safe.
 */
function getScopedStatePath(stateDir: string, fileName: string, sessionId?: string): string {
  if (sessionId && SESSION_ID_SAFE_PATTERN.test(sessionId)) {
    return join(stateDir, 'sessions', sessionId, fileName);
  }
  return join(stateDir, fileName);
}

function getCooldownStatePath(stateDir: string, sessionId?: string): string {
  return getScopedStatePath(stateDir, IDLE_NOTIFICATION_STATE_FILE, sessionId);
}

function getSessionIdleHookStatePath(stateDir: string, sessionId?: string): string {
  return getScopedStatePath(stateDir, SESSION_IDLE_HOOK_STATE_FILE, sessionId);
}

function normalizeIdleFingerprint(fingerprint: string | null | undefined): string {
  if (typeof fingerprint !== 'string') return '';
  const normalized = fingerprint.trim();
  if (!normalized) return '';
  return normalized.length > MAX_IDLE_FINGERPRINT_LENGTH
    ? normalized.slice(0, MAX_IDLE_FINGERPRINT_LENGTH)
    : normalized;
}

function readIdleNotificationState(cooldownPath: string): IdleNotificationState | null {
  try {
    if (!existsSync(cooldownPath)) return null;
    const data = JSON.parse(readFileSync(cooldownPath, 'utf-8')) as Record<string, unknown>;
    return {
      lastSentAt: typeof data?.lastSentAt === 'string' ? data.lastSentAt : undefined,
      fingerprint: normalizeIdleFingerprint(typeof data?.fingerprint === 'string' ? data.fingerprint : ''),
    };
  } catch {
    return null;
  }
}

function writeIdleNotificationState(cooldownPath: string, fingerprint?: string): void {
  try {
    const dir = dirname(cooldownPath);
    mkdirSync(dir, { recursive: true });
    const normalizedFingerprint = normalizeIdleFingerprint(fingerprint);
    const state: IdleNotificationState = { lastSentAt: new Date().toISOString() };
    if (normalizedFingerprint) {
      state.fingerprint = normalizedFingerprint;
    }
    writeFileSync(cooldownPath, JSON.stringify(state, null, 2));
  } catch {
    // ignore write errors — best effort
  }
}

/**
 * Check whether an idle notification should be sent.
 *
 * Without a fingerprint this preserves the legacy cooldown-only behavior.
 * With a fingerprint it suppresses unchanged idle-state repeats until the
 * fingerprint meaningfully changes.
 */
export function shouldSendIdleNotification(stateDir: string, sessionId?: string, fingerprint?: string): boolean {
  const cooldownSecs = getIdleNotificationCooldownSeconds();
  const normalizedFingerprint = normalizeIdleFingerprint(fingerprint);

  // Cooldown of 0 means disabled — always send, including fingerprinted repeats
  if (cooldownSecs === 0) return true;

  const cooldownPath = getCooldownStatePath(stateDir, sessionId);
  const state = readIdleNotificationState(cooldownPath);
  if (!state) return true;

  if (normalizedFingerprint) {
    return state.fingerprint !== normalizedFingerprint;
  }

  if (state.lastSentAt) {
    const lastSentMs = new Date(state.lastSentAt).getTime();
    if (Number.isFinite(lastSentMs)) {
      const elapsedSecs = (Date.now() - lastSentMs) / 1000;
      if (elapsedSecs < cooldownSecs) return false;
    }
  }

  return true;
}

/**
 * Record that an idle notification was sent at the current timestamp.
 * Call this after a successful dispatch to arm the cooldown and optionally
 * persist the current idle-state fingerprint.
 */
export function recordIdleNotificationSent(stateDir: string, sessionId?: string, fingerprint?: string): void {
  const cooldownPath = getCooldownStatePath(stateDir, sessionId);
  writeIdleNotificationState(cooldownPath, fingerprint);
}

/**
 * Check whether the coarse session-idle hook event should be dispatched.
 *
 * This path intentionally stays transition-based even when the lifecycle
 * notification cooldown is set to 0, because downstream hook consumers only
 * see the coarse `post_turn_idle_notification` reason and otherwise cannot
 * distinguish unchanged repeats from new blocked states.
 */
export function shouldSendSessionIdleHookEvent(stateDir: string, sessionId?: string, fingerprint?: string): boolean {
  const normalizedFingerprint = normalizeIdleFingerprint(fingerprint);
  if (!normalizedFingerprint) return true;

  const state = readIdleNotificationState(getSessionIdleHookStatePath(stateDir, sessionId));
  if (!state) return true;

  return state.fingerprint !== normalizedFingerprint;
}

/**
 * Record that the coarse session-idle hook event was dispatched.
 */
export function recordSessionIdleHookEventSent(stateDir: string, sessionId?: string, fingerprint?: string): void {
  writeIdleNotificationState(getSessionIdleHookStatePath(stateDir, sessionId), fingerprint);
}
