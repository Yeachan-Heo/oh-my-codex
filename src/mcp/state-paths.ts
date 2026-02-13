import { join } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

export function getBaseStateDir(workingDirectory?: string): string {
  return join(workingDirectory || process.cwd(), '.omx', 'state');
}

export function getStateDir(workingDirectory?: string, sessionId?: string): string {
  const base = getBaseStateDir(workingDirectory);
  return sessionId ? join(base, 'sessions', sessionId) : base;
}

export function getStatePath(mode: string, workingDirectory?: string, sessionId?: string): string {
  return join(getStateDir(workingDirectory, sessionId), `${mode}-state.json`);
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
