import { delimiter, isAbsolute, join, relative, resolve as resolvePath } from 'path';
import { existsSync, realpathSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import {
  isSessionStateUsable,
  readUsableSessionState,
  type SessionState,
} from '../hooks/session.js';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const STATE_MODE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STATE_FILE_SUFFIX = '-state.json';
const STATE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const WORKDIR_ALLOWLIST_ENV = 'OMX_MCP_WORKDIR_ROOTS';
const OMX_ROOT_ENV = 'OMX_ROOT';
const OMX_STATE_ROOT_ENV = 'OMX_STATE_ROOT';

export type StateFileScope = 'root' | 'session';

export interface ModeStateFileRef {
  mode: string;
  path: string;
  scope: StateFileScope;
}

export function validateSessionId(sessionId: unknown): string | undefined {
  if (sessionId == null) return undefined;
  if (typeof sessionId !== 'string') {
    throw new Error('session_id must be a string');
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('session_id must match ^[A-Za-z0-9_-]{1,64}$');
  }
  return sessionId;
}

export function validateStateModeSegment(mode: unknown): string {
  if (typeof mode !== 'string') {
    throw new Error('mode must be a string');
  }
  const normalized = mode.trim();
  if (!normalized) {
    throw new Error('mode must be a non-empty string');
  }
  if (normalized.includes('..')) {
    throw new Error('mode must not contain ".."');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('mode must not contain path separators');
  }
  if (!STATE_MODE_SEGMENT_PATTERN.test(normalized)) {
    throw new Error('mode must match ^[A-Za-z0-9_-]{1,64}$');
  }
  return normalized;
}

function getStateFilename(mode: string): string {
  return `${validateStateModeSegment(mode)}${STATE_FILE_SUFFIX}`;
}

export function validateStateFileName(fileName: unknown): string {
  if (typeof fileName !== 'string') {
    throw new Error('fileName must be a string');
  }
  const normalized = fileName.trim();
  if (!normalized) {
    throw new Error('fileName must be a non-empty string');
  }
  if (normalized.includes('..')) {
    throw new Error('fileName must not contain ".."');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('fileName must not contain path separators');
  }
  if (!STATE_FILE_NAME_PATTERN.test(normalized)) {
    throw new Error('fileName must match ^[A-Za-z0-9._-]{1,128}$');
  }
  return normalized;
}

function convertWindowsToWslPath(raw: string): string {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(raw);
  if (!m) return raw;
  const drive = m[1].toLowerCase();
  const rest = String(m[2] || '').replace(/\\/g, '/');
  const mountRoot = `/mnt/${drive}`;
  if (!existsSync(mountRoot)) return raw;
  return rest ? `${mountRoot}/${rest}` : mountRoot;
}

function convertWslToWindowsPath(raw: string): string {
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(raw);
  if (!m) return raw;
  const drive = m[1].toUpperCase();
  const rest = String(m[2] || '').replace(/\//g, '\\');
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

export function resolveWorkingDirectoryForState(workingDirectory?: string): string {
  const raw = typeof workingDirectory === 'string' ? workingDirectory.trim() : '';
  if (raw.includes('\0')) {
    throw new Error('workingDirectory contains a NUL byte');
  }
  if (!raw) {
    const cwd = resolvePath(process.cwd());
    return enforceWorkingDirectoryPolicy(cwd);
  }

  let normalized = raw;

  if (process.platform === 'win32') {
    if (normalized.startsWith('/mnt/')) {
      normalized = convertWslToWindowsPath(normalized);
    }
  } else if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
    const converted = convertWindowsToWslPath(normalized);
    if (converted === normalized) {
      throw new Error('workingDirectory Windows path is not available on this host');
    }
    normalized = converted;
  }

  if (normalized.includes('\0')) {
    throw new Error('workingDirectory contains a NUL byte');
  }

  const resolved = resolvePath(normalized);
  return enforceWorkingDirectoryPolicy(resolved);
}

function canonicalizeExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let current = path;
  const suffixes: string[] = [];
  while (true) {
    const parent = resolvePath(current, '..');
    if (parent === current) break;
    suffixes.unshift(current.substring(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
    try {
      const realParent = realpathSync.native(current);
      return suffixes.reduce((acc, segment) => resolvePath(acc, segment), realParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return path;
}

function parseAllowedWorkingDirectoryRoots(): string[] {
  const raw = process.env[WORKDIR_ALLOWLIST_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  const roots = raw
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.includes('\0')) {
        throw new Error(`${WORKDIR_ALLOWLIST_ENV} contains an invalid root with a NUL byte`);
      }
      const resolvedRoot = resolvePath(part);
      const realRoot = canonicalizeExistingPath(resolvedRoot);
      if (realRoot !== resolvedRoot) {
        throw new Error(`${WORKDIR_ALLOWLIST_ENV} root "${resolvedRoot}" resolves through a symlink to "${realRoot}"`);
      }
      return realRoot;
    });

  return [...new Set(roots)];
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function enforceWorkingDirectoryPolicy(resolvedWorkingDirectory: string): string {
  const roots = parseAllowedWorkingDirectoryRoots();
  if (roots.length === 0) return resolvedWorkingDirectory;

  const canonicalWorkingDirectory = canonicalizeExistingPath(resolvedWorkingDirectory);
  const allowed = roots.some((root) => isWithinRoot(canonicalWorkingDirectory, root));
  if (!allowed) {
    throw new Error(
      `workingDirectory "${canonicalWorkingDirectory}" is outside allowed roots (${WORKDIR_ALLOWLIST_ENV})`,
    );
  }
  return canonicalWorkingDirectory;
}

export function getBaseStateDir(workingDirectory?: string): string {
  const teamStateRootOverride = process.env.OMX_TEAM_STATE_ROOT?.trim();
  if (typeof teamStateRootOverride === 'string' && teamStateRootOverride !== '') {
    try {
      return resolveWorkingDirectoryForState(teamStateRootOverride);
    } catch {}
  }

  const omxRootOverride = process.env[OMX_ROOT_ENV]?.trim() || process.env[OMX_STATE_ROOT_ENV]?.trim();
  if (typeof omxRootOverride === 'string' && omxRootOverride !== '') {
    try {
      return join(resolveWorkingDirectoryForState(omxRootOverride), '.omx', 'state');
    } catch {}
  }

  return join(resolveWorkingDirectoryForState(workingDirectory), '.omx', 'state');
}

export function getStateDir(workingDirectory?: string, sessionId?: string): string {
  const base = getBaseStateDir(workingDirectory);
  return sessionId ? join(base, 'sessions', sessionId) : base;
}

export function getStatePath(mode: string, workingDirectory?: string, sessionId?: string): string {
  return join(getStateDir(workingDirectory, sessionId), getStateFilename(mode));
}

export function getStateFilePath(fileName: string, workingDirectory?: string, sessionId?: string): string {
  return join(getStateDir(workingDirectory, sessionId), validateStateFileName(fileName));
}

export type StateScopeSource = 'explicit' | 'session' | 'root';

export interface ResolvedStateScope {
  source: StateScopeSource;
  sessionId?: string;
  stateDir: string;
}

function readSessionIdFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.OMX_SESSION_ID, env.CODEX_SESSION_ID, env.SESSION_ID];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    return validateSessionId(trimmed);
  }
  return undefined;
}

async function readUsableSessionStateFromBaseStateDir(
  cwd: string,
  baseStateDir = getBaseStateDir(cwd),
): Promise<SessionState | null> {
  const sessionPath = join(baseStateDir, 'session.json');
  if (!existsSync(sessionPath)) return null;

  try {
    const content = await readFile(sessionPath, 'utf-8');
    const state = JSON.parse(content) as SessionState;
    return isSessionStateUsable(state, cwd) ? state : null;
  } catch {
    return null;
  }
}

export async function readCurrentSessionId(workingDirectory?: string): Promise<string | undefined> {
  const cwd = resolveWorkingDirectoryForState(workingDirectory);
  const baseStateDir = getBaseStateDir(cwd);
  const envSessionId = readSessionIdFromEnvironment();
  if (envSessionId) {
    const envScopedDir = getStateDir(cwd, envSessionId);
    if (existsSync(envScopedDir)) return envSessionId;
  }

  const baseSession = await readUsableSessionStateFromBaseStateDir(cwd, baseStateDir);
  if (baseSession) return baseSession.session_id;

  const localStateDir = join(cwd, '.omx', 'state');
  if (resolvePath(baseStateDir) !== resolvePath(localStateDir)) {
    return undefined;
  }

  return (await readUsableSessionState(cwd))?.session_id;
}

export async function resolveStateScope(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<ResolvedStateScope> {
  const validatedExplicit = validateSessionId(explicitSessionId);
  if (validatedExplicit) {
    return {
      source: 'explicit',
      sessionId: validatedExplicit,
      stateDir: getStateDir(workingDirectory, validatedExplicit),
    };
  }

  const currentSessionId = await readCurrentSessionId(workingDirectory);
  if (currentSessionId) {
    return {
      source: 'session',
      sessionId: currentSessionId,
      stateDir: getStateDir(workingDirectory, currentSessionId),
    };
  }

  return {
    source: 'root',
    stateDir: getStateDir(workingDirectory),
  };
}

/**
 * Read scope precedence:
 * - explicit session_id => session path only
 * - implicit current session => session path first, root as compatibility fallback
 * - no session => root path only
 *
 * This is a compatibility read surface. Do not use it for active-mode
 * decisions that drive Stop hooks or runtime continuation; use
 * getAuthoritativeActiveStateDirs instead so stale root state cannot
 * reactivate an explicitly session-scoped turn.
 */
export async function getReadScopedStateDirs(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const scope = await resolveStateScope(workingDirectory, explicitSessionId);
  if (scope.source === 'root') return [scope.stateDir];
  if (scope.source === 'explicit') {
    if (existsSync(scope.stateDir)) return [scope.stateDir];
    return [scope.stateDir, getBaseStateDir(workingDirectory)];
  }
  return [scope.stateDir, getBaseStateDir(workingDirectory)];
}

/**
 * Active-decision scope precedence:
 * - explicit/current session => that session path only, even if it is missing
 * - no session => root path only
 *
 * Stop hooks, list-active, and other continuation gates should use this path
 * instead of compatibility reads. A missing session directory means no active
 * state for that session; root fallback remains available only to explicit
 * read/status compatibility surfaces.
 */
export async function getAuthoritativeActiveStateDirs(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const scope = await resolveStateScope(workingDirectory, explicitSessionId);
  return [scope.stateDir];
}

export async function getAuthoritativeActiveStatePaths(
  mode: string,
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const dirs = await getAuthoritativeActiveStateDirs(workingDirectory, explicitSessionId);
  const fileName = getStateFilename(mode);
  return dirs.map((dir) => join(dir, fileName));
}

export async function getReadScopedStatePaths(
  mode: string,
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const dirs = await getReadScopedStateDirs(workingDirectory, explicitSessionId);
  const fileName = getStateFilename(mode);
  return dirs.map((dir) => join(dir, fileName));
}

export async function getReadScopedStateFilePaths(
  fileName: string,
  workingDirectory?: string,
  explicitSessionId?: string,
  options: { rootFallback?: boolean } = {},
): Promise<string[]> {
  const normalizedFileName = validateStateFileName(fileName);
  const scope = await resolveStateScope(workingDirectory, explicitSessionId);
  if (scope.source === 'root') {
    return [join(scope.stateDir, normalizedFileName)];
  }
  if (options.rootFallback === false) {
    return [join(scope.stateDir, normalizedFileName)];
  }
  return [
    join(scope.stateDir, normalizedFileName),
    join(getBaseStateDir(workingDirectory), normalizedFileName),
  ];
}

export async function getAllSessionScopedStatePaths(
  mode: string,
  workingDirectory?: string,
): Promise<string[]> {
  const sessionDirs = await getAllSessionScopedStateDirs(workingDirectory);
  const fileName = getStateFilename(mode);
  return sessionDirs.map((dir) => join(dir, fileName));
}

export async function getAllScopedStatePaths(
  mode: string,
  workingDirectory?: string,
): Promise<string[]> {
  return [
    getStatePath(mode, workingDirectory),
    ...(await getAllSessionScopedStatePaths(mode, workingDirectory)),
  ];
}

export async function getAllSessionScopedStateDirs(workingDirectory?: string): Promise<string[]> {
  const sessionsRoot = join(getBaseStateDir(workingDirectory), 'sessions');
  if (!existsSync(sessionsRoot)) return [];

  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
    .map((entry) => join(sessionsRoot, entry.name));
}

export async function getAllScopedStateDirs(workingDirectory?: string): Promise<string[]> {
  return [getBaseStateDir(workingDirectory), ...(await getAllSessionScopedStateDirs(workingDirectory))];
}

export function isModeStateFilename(filename: string): boolean {
  return filename.endsWith(STATE_FILE_SUFFIX) && filename !== 'session.json';
}

async function listModeStateFilesInDir(dir: string, scope: StateFileScope): Promise<ModeStateFileRef[]> {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir).catch(() => [] as string[]);
  return files
    .filter((file) => isModeStateFilename(file))
    .map((file) => ({
      mode: file.slice(0, -STATE_FILE_SUFFIX.length),
      path: join(dir, file),
      scope,
    }));
}

export async function listModeStateFilesWithScopePreference(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<ModeStateFileRef[]> {
  const readDirs = await getReadScopedStateDirs(workingDirectory, explicitSessionId);
  const rootDir = getBaseStateDir(workingDirectory);
  const preferred = new Map<string, ModeStateFileRef>();

  // Compatibility fallback: root first, then higher-precedence scope overrides.
  for (const dir of [...readDirs].reverse()) {
    const scope: StateFileScope = dir === rootDir ? 'root' : 'session';
    for (const ref of await listModeStateFilesInDir(dir, scope)) {
      preferred.set(ref.mode, ref);
    }
  }

  return [...preferred.values()].sort((a, b) => a.mode.localeCompare(b.mode));
}
