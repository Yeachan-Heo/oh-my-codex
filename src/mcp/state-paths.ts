import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STATE_FILE_SUFFIX = '-state.json';

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
  if (!raw) return process.cwd();

  if (process.platform === 'win32') {
    if (raw.startsWith('/mnt/')) return convertWslToWindowsPath(raw);
    return raw;
  }

  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    return convertWindowsToWslPath(raw);
  }

  return raw;
}

export function getBaseStateDir(workingDirectory?: string): string {
  if ((workingDirectory == null || workingDirectory === '') && typeof process.env.OMX_TEAM_STATE_ROOT === 'string' && process.env.OMX_TEAM_STATE_ROOT.trim() !== '') {
    return resolveWorkingDirectoryForState(process.env.OMX_TEAM_STATE_ROOT.trim());
  }
  return join(resolveWorkingDirectoryForState(workingDirectory), '.omx', 'state');
}

export function getStateDir(workingDirectory?: string, sessionId?: string): string {
  const base = getBaseStateDir(workingDirectory);
  return sessionId ? join(base, 'sessions', sessionId) : base;
}

export function getStatePath(mode: string, workingDirectory?: string, sessionId?: string): string {
  return join(getStateDir(workingDirectory, sessionId), `${mode}-state.json`);
}

export type StateScopeSource = 'explicit' | 'session' | 'root';

export interface ResolvedStateScope {
  source: StateScopeSource;
  sessionId?: string;
  stateDir: string;
}

export async function readCurrentSessionId(workingDirectory?: string): Promise<string | undefined> {
  const sessionPath = join(getBaseStateDir(workingDirectory), 'session.json');
  if (!existsSync(sessionPath)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(sessionPath, 'utf-8')) as { session_id?: unknown };
    return validateSessionId(parsed.session_id);
  } catch {
    return undefined;
  }
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

export async function getReadScopedStatePaths(
  mode: string,
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const dirs = await getReadScopedStateDirs(workingDirectory, explicitSessionId);
  return dirs.map((dir) => join(dir, `${mode}-state.json`));
}

export async function getAllSessionScopedStatePaths(
  mode: string,
  workingDirectory?: string,
): Promise<string[]> {
  const sessionDirs = await getAllSessionScopedStateDirs(workingDirectory);
  return sessionDirs.map((dir) => join(dir, `${mode}-state.json`));
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
