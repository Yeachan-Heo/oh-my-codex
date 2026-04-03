import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface GitLayout {
  gitDir: string;
  commonDir: string;
  worktreeRoot: string;
}

function readTrimmedFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function resolveGitDirPointer(path: string): string | null {
  const raw = readTrimmedFile(path);
  if (!raw) return null;

  const match = raw.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;

  return resolve(dirname(path), match[1].trim());
}

function resolveGitCommonDir(gitDir: string): string {
  const commonDir = readTrimmedFile(join(gitDir, 'commondir'));
  return commonDir ? resolve(gitDir, commonDir) : gitDir;
}

export function findGitLayout(startCwd: string): GitLayout | null {
  let dir = startCwd;

  for (;;) {
    const candidate = join(dir, '.git');
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) {
        return {
          gitDir: candidate,
          commonDir: resolveGitCommonDir(candidate),
          worktreeRoot: dir,
        };
      }
      if (stat.isFile()) {
        const gitDir = resolveGitDirPointer(candidate);
        if (gitDir) {
          return {
            gitDir,
            commonDir: resolveGitCommonDir(gitDir),
            worktreeRoot: dir,
          };
        }
      }
    } catch { /* not found, walk up */ }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readGitLayoutFile(baseDir: string, ...parts: string[]): string | null {
  return readTrimmedFile(join(baseDir, ...parts));
}
