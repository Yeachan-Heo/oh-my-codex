import { existsSync, lstatSync, realpathSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute, join, relative } from 'path';
import type {
  HookPluginOmxHudState,
  HookPluginOmxNotifyFallbackState,
  HookPluginOmxSessionState,
  HookPluginOmxUpdateCheckState,
  HookPluginSdk,
} from '../types.js';
import { omxRootStateFilePath } from './paths.js';
import { getReadScopedStateFilePaths, normalizeSessionId, readSessionMetadataFromBaseStateDir } from '../../../mcp/state-paths.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOmxStateFile<T extends Record<string, unknown>>(
  path: string,
  normalize?: (value: Record<string, unknown>) => T | null,
): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (!isRecord(parsed)) return null;
    return normalize ? normalize(parsed) : parsed as T;
  } catch {
    return null;
  }
}

function normalizeSessionState(value: Record<string, unknown>): HookPluginOmxSessionState | null {
  const sessionId = normalizeSessionId(value.session_id);
  return sessionId ? { ...value, session_id: sessionId } as HookPluginOmxSessionState : null;
}

function isContainedPath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function readHudState(cwd: string, stateRoot?: string, requestedSessionId?: string): Promise<HookPluginOmxHudState | null> {
  if (stateRoot) {
    try {
      const canonicalStateRoot = realpathSync.native(stateRoot);
      const metadata = await readSessionMetadataFromBaseStateDir(cwd, canonicalStateRoot);
      if (!metadata) return null;
      const requestedSessionText = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
      const normalizedRequestedSessionId = normalizeSessionId(requestedSessionText);
      if (requestedSessionText && !normalizedRequestedSessionId) return null;
      const requestedIsBound = !normalizedRequestedSessionId
        || normalizedRequestedSessionId === metadata.sessionId
        || metadata.nativeSessionAliases.includes(normalizedRequestedSessionId)
        || normalizedRequestedSessionId === metadata.ownerOmxSessionId
        || normalizedRequestedSessionId === metadata.ownerCodexSessionId;
      if (!requestedIsBound) return null;
      const sessionDir = join(canonicalStateRoot, 'sessions', metadata.sessionId);
      const sessionsDir = join(canonicalStateRoot, 'sessions');
      if (lstatSync(sessionsDir).isSymbolicLink() || lstatSync(sessionDir).isSymbolicLink()) return null;
      const hudStatePath = join(sessionDir, 'hud-state.json');
      if (!existsSync(hudStatePath)) return null;
      const canonicalSessionDir = realpathSync.native(sessionDir);
      const canonicalHudStatePath = realpathSync.native(hudStatePath);
      if (!isContainedPath(canonicalSessionDir, canonicalStateRoot)
        || !isContainedPath(canonicalHudStatePath, canonicalSessionDir)) return null;
      return readOmxStateFile<HookPluginOmxHudState>(canonicalHudStatePath);
    } catch {
      return null;
    }
  }
  const [hudStatePath] = await getReadScopedStateFilePaths('hud-state.json', cwd, undefined, {
    rootFallback: false,
  });
  return readOmxStateFile<HookPluginOmxHudState>(hudStatePath);
}

export function createHookPluginOmxApi(cwd: string, stateRoot?: string, requestedSessionId?: string): HookPluginSdk['omx'] {
  return {
    session: {
      read: () => readOmxStateFile<HookPluginOmxSessionState>(
        omxRootStateFilePath(cwd, 'session.json', stateRoot),
        normalizeSessionState,
      ),
    },
    hud: {
      read: () => readHudState(cwd, stateRoot, requestedSessionId),
    },
    notifyFallback: {
      read: () => readOmxStateFile<HookPluginOmxNotifyFallbackState>(
        omxRootStateFilePath(cwd, 'notify-fallback-state.json', stateRoot),
      ),
    },
    updateCheck: {
      read: () => readOmxStateFile<HookPluginOmxUpdateCheckState>(
        omxRootStateFilePath(cwd, 'update-check.json', stateRoot),
      ),
    },
  };
}
