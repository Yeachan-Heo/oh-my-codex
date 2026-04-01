import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface GitLayout {
  workTree: string;
  gitDir: string;
  commonDir: string;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function statMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

function resolveCommonDir(gitDir: string): string {
  const commonDir = readText(join(gitDir, 'commondir'));
  return commonDir ? resolve(gitDir, commonDir) : gitDir;
}

function resolveGitLayout(startCwd: string): GitLayout | null {
  let dir = resolve(startCwd);
  for (;;) {
    const gitEntry = join(dir, '.git');

    try {
      if (statSync(gitEntry).isDirectory()) {
        return { workTree: dir, gitDir: gitEntry, commonDir: resolveCommonDir(gitEntry) };
      }
    } catch {
      // Fall through to gitdir-file handling.
    }

    const raw = readText(gitEntry);
    const match = raw ? /^gitdir:\s*(.+)$/i.exec(raw) : null;
    if (match?.[1]) {
      const gitDir = resolve(dirname(gitEntry), match[1].trim());
      return { workTree: dir, gitDir, commonDir: resolveCommonDir(gitDir) };
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readBranch(layout: GitLayout): string | null {
  const head = readText(join(layout.gitDir, 'HEAD'));
  if (!head?.startsWith('ref: refs/heads/')) return null;
  return head.slice('ref: refs/heads/'.length) || null;
}

function readRemoteConfig(layout: GitLayout): { names: string[]; urls: Map<string, string> } {
  const config = readText(join(layout.commonDir, 'config'));
  const names: string[] = [];
  const urls = new Map<string, string>();
  if (!config) return { names, urls };

  let currentRemote: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const remoteMatch = /^\s*\[remote "([^"]+)"\]\s*$/.exec(line);
    if (remoteMatch?.[1]) {
      currentRemote = remoteMatch[1];
      if (!names.includes(currentRemote)) names.push(currentRemote);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentRemote = null;
      continue;
    }
    if (!currentRemote) continue;
    const urlMatch = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (urlMatch?.[1] && !urls.has(currentRemote)) {
      urls.set(currentRemote, urlMatch[1].trim());
    }
  }

  return { names, urls };
}

function readLatestReflogTimestampMs(path: string): number {
  const reflog = readText(path);
  if (!reflog) return Number.NaN;

  for (const line of reflog.split(/\r?\n/).reverse()) {
    const match = / (\d+) [+-]\d{4}(?:\t|$)/.exec(line.trim());
    if (!match?.[1]) continue;
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }

  return Number.NaN;
}

export function tryReadGitValueFromFiles(cwd: string, args: string[]): string | null {
  if (process.platform !== 'win32') return null;

  const layout = resolveGitLayout(cwd);
  if (!layout) return null;

  const command = args.join(' ');
  if (command === 'rev-parse --abbrev-ref HEAD') {
    return readBranch(layout) ?? (readText(join(layout.gitDir, 'HEAD')) ? 'HEAD' : null);
  }
  if (command === 'remote') {
    const names = readRemoteConfig(layout).names;
    return names.length > 0 ? names.join('\n') : null;
  }
  if (command === 'rev-parse --show-toplevel') {
    return layout.workTree;
  }
  if (args.length === 3 && args[0] === 'remote' && args[1] === 'get-url') {
    return readRemoteConfig(layout).urls.get(args[2] || '') ?? null;
  }

  return null;
}

export function tryReadGitBranchActivityMsFromFiles(cwd: string): number {
  if (process.platform !== 'win32') return Number.NaN;

  const layout = resolveGitLayout(cwd);
  if (!layout) return Number.NaN;

  const branch = readBranch(layout);
  const headLogPath = join(layout.gitDir, 'logs', 'HEAD');
  const branchLogPath = branch
    ? join(layout.commonDir, 'logs', 'refs', 'heads', ...branch.split('/'))
    : null;
  const branchRefPath = branch
    ? join(layout.commonDir, 'refs', 'heads', ...branch.split('/'))
    : null;

  const timestampCandidates = [
    readLatestReflogTimestampMs(headLogPath),
    branchLogPath ? readLatestReflogTimestampMs(branchLogPath) : Number.NaN,
  ].filter((value) => Number.isFinite(value));
  if (timestampCandidates.length > 0) return Math.max(...timestampCandidates);

  const mtimeCandidates = [
    statMs(headLogPath),
    statMs(join(layout.gitDir, 'HEAD')),
    branchLogPath ? statMs(branchLogPath) : Number.NaN,
    branchRefPath ? statMs(branchRefPath) : Number.NaN,
  ].filter((value) => Number.isFinite(value));
  return mtimeCandidates.length > 0 ? Math.max(...mtimeCandidates) : Number.NaN;
}
