import { readdir, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface VscodeLogSummary {
  path: string;
  name: string;
  updated_at: string;
  size: number;
}

export async function listVscodeLogs(cwd: string, limit = 8): Promise<VscodeLogSummary[]> {
  const dir = path.join(cwd, '.omx', 'logs', 'vscode');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return [];
    throw error;
  }

  const logs: VscodeLogSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const filePath = path.join(dir, name);
    const info = await stat(filePath);
    if (!info.isFile()) continue;
    logs.push({ path: filePath, name, updated_at: info.mtime.toISOString(), size: info.size });
  }
  return logs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.max(0, limit));
}

export function pathInsideWorkspace(cwd: string, candidate: string): boolean {
  const root = path.resolve(cwd);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export async function realPathInsideWorkspace(cwd: string, candidate: string): Promise<boolean> {
  try {
    const root = await realpath(cwd);
    const resolved = await realpath(candidate);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
