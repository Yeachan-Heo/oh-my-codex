/**
 * State file I/O helpers for notify-hook modules.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString } from './utils.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export { readdir };

export function readJsonIfExists(path, fallback) {
  return readFile(path, 'utf-8')
    .then(content => JSON.parse(content))
    .catch(() => fallback);
}

export async function getScopedStateDirsForCurrentSession(baseStateDir, payloadSessionId) {
  const explicitSessionId = safeString(payloadSessionId || '');
  if (SESSION_ID_PATTERN.test(explicitSessionId)) {
    const sessionDir = join(baseStateDir, 'sessions', explicitSessionId);
    return [sessionDir];
  }

  const sessionPath = join(baseStateDir, 'session.json');
  try {
    const session = JSON.parse(await readFile(sessionPath, 'utf-8'));
    const sessionId = safeString(session && session.session_id ? session.session_id : '');
    if (SESSION_ID_PATTERN.test(sessionId)) {
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      if (existsSync(sessionDir)) return [sessionDir];
    }
  } catch {
    // No session file or malformed - fall back to global only
  }
  return [baseStateDir];
}

export function normalizeTmuxState(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      total_injections: 0,
      pane_counts: {},
      session_counts: {},
      recent_keys: {},
      last_injection_ts: 0,
      last_reason: 'init',
      last_event_at: '',
    };
  }
  return {
    total_injections: asNumber(raw.total_injections) ?? 0,
    pane_counts: raw.pane_counts && typeof raw.pane_counts === 'object' ? raw.pane_counts : {},
    session_counts: raw.session_counts && typeof raw.session_counts === 'object' ? raw.session_counts : {},
    recent_keys: raw.recent_keys && typeof raw.recent_keys === 'object' ? raw.recent_keys : {},
    last_injection_ts: asNumber(raw.last_injection_ts) ?? 0,
    last_reason: safeString(raw.last_reason),
    last_event_at: safeString(raw.last_event_at),
  };
}

export function normalizeNotifyState(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      recent_turns: {},
      last_event_at: '',
    };
  }
  return {
    recent_turns: raw.recent_turns && typeof raw.recent_turns === 'object' ? raw.recent_turns : {},
    last_event_at: safeString(raw.last_event_at),
  };
}

export function pruneRecentTurns(recentTurns, now) {
  const pruned = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentTurns || {}).slice(-2000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

export function pruneRecentKeys(recentKeys, now) {
  const pruned = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentKeys || {}).slice(-1000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}
