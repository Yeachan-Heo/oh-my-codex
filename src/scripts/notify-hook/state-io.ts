/**
 * State file I/O helpers for notify-hook modules.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { validateSessionId } from '../../mcp/state-paths.js';
import { asNumber, safeString } from './utils.js';


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

export interface SessionMetadata {
  sessionId?: string;
  aliases: string[];
  status: 'missing' | 'unusable' | 'usable';
}

async function readSessionMetadataFromBaseStateDir(baseStateDir: string): Promise<SessionMetadata> {
  let session: any;
  try {
    session = JSON.parse(await readFile(join(baseStateDir, 'session.json'), 'utf-8'));
  } catch (error: any) {
    return { aliases: [], status: error?.code === 'ENOENT' ? 'missing' : 'unusable' };
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { aliases: [], status: 'unusable' };
  }

  let sessionId: string | undefined;
  try {
    sessionId = validateSessionId(session.session_id);
  } catch {
    return { aliases: [], status: 'unusable' };
  }
  if (!sessionId) return { aliases: [], status: 'unusable' };

  const aliases = [
    session.native_session_id,
    session.codex_session_id,
    session.previous_native_session_id,
    session.owner_omx_session_id,
  ]
    .map((value) => safeString(value).trim())
    .filter((value) => {
      try {
        return Boolean(validateSessionId(value));
      } catch {
        return false;
      }
    });
  return { sessionId, aliases: [...new Set(aliases)], status: 'usable' };
}

export async function readNotifySessionMetadata(baseStateDir: string): Promise<SessionMetadata> {
  return readSessionMetadataFromBaseStateDir(baseStateDir);
}

function readOmxSessionIdFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate = safeString(env.OMX_SESSION_ID).trim();
  if (!candidate) return undefined;
  try {
    return validateSessionId(candidate);
  } catch {
    return undefined;
  }
}

/** Neutral fact for the provenance evaluator; it never interprets fork policy. */

export async function hasExistingScopedSessionDir(baseStateDir: string, sessionId: string): Promise<boolean> {
  try {
    return (await stat(join(baseStateDir, 'sessions', sessionId))).isDirectory();
  } catch {
    return false;
  }
}

export function getOmxSessionIdFromEnvironment(): string | undefined {
  return readOmxSessionIdFromEnvironment();
}

function readSessionIdFromEnvironment(): string | undefined {
  for (const candidate of [process.env.OMX_SESSION_ID, process.env.CODEX_SESSION_ID, process.env.SESSION_ID]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const sessionId = validateSessionId(trimmed);
      if (sessionId) return sessionId;
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveCanonicalSessionId(candidate: string | undefined, metadata: SessionMetadata): string | undefined {
  if (!candidate) return undefined;
  return metadata.sessionId && metadata.aliases.includes(candidate)
    ? metadata.sessionId
    : candidate;
}

async function resolveBaseScopedStateDir(
  baseStateDir: string,
  explicitSessionId?: string,
): Promise<string> {
  const normalizedExplicit = typeof explicitSessionId === 'string' && explicitSessionId.trim()
    ? explicitSessionId.trim()
    : undefined;
  const validatedExplicit = validateSessionId(normalizedExplicit);
  const metadata = await readSessionMetadataFromBaseStateDir(baseStateDir);
  const sessionId = resolveCanonicalSessionId(validatedExplicit, metadata)
    ?? resolveCanonicalSessionId(readSessionIdFromEnvironment(), metadata)
    ?? metadata.sessionId;
  return sessionId ? join(baseStateDir, 'sessions', sessionId) : baseStateDir;
}

async function resolveBaseScopedStateDirs(
  baseStateDir: string,
  explicitSessionId?: string,
  options: { includeRootFallback?: boolean } = {},
): Promise<string[]> {
  const scopedDir = await resolveBaseScopedStateDir(baseStateDir, explicitSessionId);
  return options.includeRootFallback === true && scopedDir !== baseStateDir
    ? [scopedDir, baseStateDir]
    : [scopedDir];
}




export async function readCurrentSessionId(baseStateDir: string): Promise<string | undefined> {
  const metadata = await readSessionMetadataFromBaseStateDir(baseStateDir);
  return resolveCanonicalSessionId(readSessionIdFromEnvironment(), metadata) ?? metadata.sessionId;
}

export async function resolveScopedStateDir(
  baseStateDir: string,
  explicitSessionId?: string,
): Promise<string> {
  return resolveBaseScopedStateDir(baseStateDir, explicitSessionId);
}

export async function getScopedStateDirsForCurrentSession(
  baseStateDir: string,
  explicitSessionId?: string,
  options: { includeRootFallback?: boolean } = {},
): Promise<string[]> {
  return resolveBaseScopedStateDirs(baseStateDir, explicitSessionId, options);
}

export interface NotifyStateScope {
  readonly targetSessionId: string;
  readonly ownerCodexSessionId: string;
  readonly allowedStorageSessionIds: readonly string[];
}

export async function getScopedStatePathAtScope(
  baseStateDir: string,
  fileName: string,
  scope: NotifyStateScope,
): Promise<string> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  if (!scope.allowedStorageSessionIds.includes(scope.targetSessionId)) {
    throw new Error('notify state scope target is unauthorized');
  }
  return join(baseStateDir, 'sessions', scope.targetSessionId, fileName);
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

export async function readScopedJsonAtScope(
  baseStateDir: string,
  fileName: string,
  scope: NotifyStateScope,
  fallback: any,
): Promise<any> {
  return readJsonIfExists(await getScopedStatePathAtScope(baseStateDir, fileName, scope), fallback);
}

export async function writeScopedJsonAtScope(
  baseStateDir: string,
  fileName: string,
  scope: NotifyStateScope,
  value: unknown,
): Promise<void> {
  const targetPath = await getScopedStatePathAtScope(baseStateDir, fileName, scope);
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
