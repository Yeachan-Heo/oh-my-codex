/**
 * State file I/O helpers for notify-hook modules.
 */

import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { readUsableSessionState } from '../../hooks/session.js';
import { asNumber, safeString } from './utils.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export { readdir };

export function readJsonIfExists(path: string, fallback: any): Promise<any> {
  return readFile(path, 'utf-8')
    .then(content => JSON.parse(content))
    .catch(() => fallback);
}

function isSafeStateFileName(fileName: string): boolean {
  return fileName.length > 0
    && !fileName.includes('..')
    && !fileName.includes('/')
    && !fileName.includes('\\');
}

function readSessionIdFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.OMX_SESSION_ID, env.CODEX_SESSION_ID, env.SESSION_ID];
  for (const candidate of candidates) {
    const sessionId = safeString(candidate).trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    return sessionId;
  }
  return undefined;
}

export async function readCurrentSessionId(baseStateDir: string): Promise<string | undefined> {
  const envSessionId = readSessionIdFromEnvironment();
  if (envSessionId) {
    const envScopedDir = join(baseStateDir, 'sessions', envSessionId);
    if (existsSync(envScopedDir)) return envSessionId;
  }

  const cwd = resolve(baseStateDir, '..', '..');
  const session = await readUsableSessionState(cwd);
  const sessionId = safeString(session?.session_id);
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}

export async function resolveScopedStateDir(
  baseStateDir: string,
  explicitSessionId?: string,
): Promise<string> {
  const normalizedExplicit = safeString(explicitSessionId).trim();
  if (SESSION_ID_PATTERN.test(normalizedExplicit)) {
    return join(baseStateDir, 'sessions', normalizedExplicit);
  }

  const currentSessionId = await readCurrentSessionId(baseStateDir);
  if (currentSessionId) {
    return join(baseStateDir, 'sessions', currentSessionId);
  }

  return baseStateDir;
}

export async function getScopedStateDirsForCurrentSession(
  baseStateDir: string,
  explicitSessionId?: string,
  options: { includeRootFallback?: boolean } = {},
): Promise<string[]> {
  const scopedDir = await resolveScopedStateDir(baseStateDir, explicitSessionId);
  if (scopedDir === baseStateDir || options.includeRootFallback !== true) {
    return [scopedDir];
  }
  return [scopedDir, baseStateDir];
}

export async function getScopedStatePath(
  baseStateDir: string,
  fileName: string,
  explicitSessionId?: string,
): Promise<string> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  return join(await resolveScopedStateDir(baseStateDir, explicitSessionId), fileName);
}

export async function readScopedJsonIfExists(
  baseStateDir: string,
  fileName: string,
  explicitSessionId: string | undefined,
  fallback: any,
  options: { includeRootFallback?: boolean } = {},
): Promise<any> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  const candidateDirs = await getScopedStateDirsForCurrentSession(
    baseStateDir,
    explicitSessionId,
    options,
  );
  for (const dir of candidateDirs) {
    const value = await readJsonIfExists(join(dir, fileName), fallback);
    if (value !== fallback) return value;
  }
  return fallback;
}

export async function writeScopedJson(
  baseStateDir: string,
  fileName: string,
  explicitSessionId: string | undefined,
  value: unknown,
): Promise<void> {
  const targetPath = await getScopedStatePath(baseStateDir, fileName, explicitSessionId);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2));
}

export function normalizeTmuxState(raw: any): any {
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

export function normalizeNotifyState(raw: any): any {
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

export function pruneRecentTurns(recentTurns: any, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentTurns || {}).slice(-2000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

export function pruneRecentKeys(recentKeys: any, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentKeys || {}).slice(-1000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}
