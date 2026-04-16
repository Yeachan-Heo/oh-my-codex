import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { omxStateDir } from '../utils/paths.js';
import { findGitLayout, readGitLayoutFile } from '../utils/git-layout.js';

const MIN_GIT_ACTIVITY_CACHE_TTL_MS = 1000;
const MAX_GIT_ACTIVITY_CACHE_TTL_MS = 5000;
const gitActivityCache = new Map<string, { value: number; expiresAt: number }>();

interface LeaderRuntimeActivityDoc {
  last_activity_at?: string;
  last_team_status_at?: string;
  last_source?: string;
  last_team_name?: string;
}

interface LeaderRuntimeSignalStatus {
  source: 'hud' | 'leader_runtime_activity' | 'leader_branch_git_activity';
  at: string | null;
  ms: number;
  valid: boolean;
  fresh: boolean;
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseIsoMs(value: unknown): number {
  if (typeof value !== 'string' || value.trim().length === 0) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseEpochSecondsMs(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) ? seconds * 1000 : Number.NaN;
}

function resolveGitOutputPath(cwd: string, gitPath: string | null): string | null {
  if (!gitPath) return null;
  if (posix.isAbsolute(gitPath) || win32.isAbsolute(gitPath)) return gitPath;
  return resolve(cwd, gitPath);
}

/**
 * On Windows, read git info from .git/ files directly to avoid spawning
 * console windows (conhost.exe flicker on every poll cycle).
 *
 * See: https://github.com/Yeachan-Heo/oh-my-codex/issues/1100
 */
function tryReadGitValue(cwd: string, args: string[]): string | null {
  if (process.platform === 'win32') {
    try {
      const gitLayout = findGitLayout(cwd);
      if (gitLayout) {
        const cmd = args.join(' ');

        if (cmd === 'rev-parse --git-dir') return gitLayout.gitDir;

        if (cmd === 'symbolic-ref --quiet --short HEAD') {
          const head = readGitLayoutFile(gitLayout.gitDir, 'HEAD');
          if (head?.startsWith('ref: refs/heads/'))
            return head.slice('ref: refs/heads/'.length);
          return null; // detached HEAD
        }

        if (cmd === 'rev-parse --git-path logs/HEAD') {
          return join(gitLayout.gitDir, 'logs', 'HEAD');
        }

        if (cmd.startsWith('rev-parse --git-path logs/refs/heads/')) {
          const branch = args[args.length - 1].replace('logs/', '');
          return join(gitLayout.commonDir, 'logs', branch);
        }

        if (cmd === 'show -s --format=%ct HEAD') {
          // Use HEAD file mtime as a proxy for last-commit timestamp.
          try {
            const headMs = statSync(join(gitLayout.gitDir, 'HEAD')).mtimeMs;
            return String(Math.floor(headMs / 1000));
          } catch { return null; }
        }
      }
    } catch { /* fall through */ }
  }

  return tryReadGitValueExec(cwd, args);
}

function tryReadGitValueExec(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function statMsIfExists(path: string | null): Promise<number> {
  if (!path || !existsSync(path)) return Number.NaN;
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

function stateDirToProjectRoot(stateDir: string): string {
  return dirname(dirname(stateDir));
}

export async function readBranchGitActivityMsForPath(cwd: string): Promise<number> {
  const gitDir = tryReadGitValue(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir) return Number.NaN;

  const branch = tryReadGitValue(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const headLogPath = tryReadGitValue(cwd, ['rev-parse', '--git-path', 'logs/HEAD']);
  const branchLogPath = branch
    ? tryReadGitValue(cwd, ['rev-parse', '--git-path', `logs/refs/heads/${branch}`])
    : null;
  const headCommitEpoch = tryReadGitValue(cwd, ['show', '-s', '--format=%ct', 'HEAD']);

  const [headLogMs, branchLogMs] = await Promise.all([
    statMsIfExists(resolveGitOutputPath(cwd, headLogPath)),
    statMsIfExists(resolveGitOutputPath(cwd, branchLogPath)),
  ]);
  const headCommitMs = headCommitEpoch ? parseEpochSecondsMs(headCommitEpoch) : Number.NaN;

  const candidates = [headLogMs, branchLogMs, headCommitMs].filter((ms) => Number.isFinite(ms));
  return candidates.length > 0 ? Math.max(...candidates) : Number.NaN;
}

async function readLeaderBranchGitActivityMs(stateDir: string): Promise<number> {
  return await readBranchGitActivityMsForPath(stateDirToProjectRoot(stateDir));
}

function resolveLeaderGitActivityCacheTtlMs(thresholdMs: number): number {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return MAX_GIT_ACTIVITY_CACHE_TTL_MS;
  }

  return Math.max(
    MIN_GIT_ACTIVITY_CACHE_TTL_MS,
    Math.min(MAX_GIT_ACTIVITY_CACHE_TTL_MS, Math.floor(thresholdMs / 4)),
  );
}

async function readLeaderBranchGitActivityMsCached(
  stateDir: string,
  thresholdMs: number,
  nowMs: number,
): Promise<number> {
  const cacheKey = stateDirToProjectRoot(stateDir);
  const cached = gitActivityCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const value = await readLeaderBranchGitActivityMs(stateDir);
  gitActivityCache.set(cacheKey, {
    value,
    expiresAt: nowMs + resolveLeaderGitActivityCacheTtlMs(thresholdMs),
  });
  return value;
}

export function leaderRuntimeActivityPath(cwd: string): string {
  return join(omxStateDir(cwd), 'leader-runtime-activity.json');
}

export async function recordLeaderRuntimeActivity(
  cwd: string,
  source: string,
  teamName?: string,
  nowIso = new Date().toISOString(),
): Promise<void> {
  const stateDir = omxStateDir(cwd);
  await mkdir(stateDir, { recursive: true });
  const path = leaderRuntimeActivityPath(cwd);
  const existingRaw = await readJsonIfExists(path);
  const existing: LeaderRuntimeActivityDoc = existingRaw && typeof existingRaw === 'object'
    ? existingRaw as LeaderRuntimeActivityDoc
    : {};
  const next: LeaderRuntimeActivityDoc = {
    ...existing,
    last_activity_at: nowIso,
    last_source: source,
  };
  if (source === 'team_status') next.last_team_status_at = nowIso;
  if (teamName) next.last_team_name = teamName;
  await writeFile(path, JSON.stringify(next, null, 2));
}

export async function readLeaderRuntimeSignalStatuses(
  stateDir: string,
  thresholdMs: number,
  nowMs: number,
): Promise<LeaderRuntimeSignalStatus[]> {
  const hudPath = join(stateDir, 'hud-state.json');
  const leaderActivityPath = join(stateDir, 'leader-runtime-activity.json');

  const [hudState, leaderActivity, leaderGitActivityMs] = await Promise.all([
    existsSync(hudPath) ? readJsonIfExists(hudPath) : Promise.resolve(null),
    existsSync(leaderActivityPath) ? readJsonIfExists(leaderActivityPath) : Promise.resolve(null),
    readLeaderBranchGitActivityMsCached(stateDir, thresholdMs, nowMs),
  ]);

  const signals: Array<{ source: LeaderRuntimeSignalStatus['source']; at: unknown; ms?: number }> = [
    { source: 'hud', at: hudState?.last_turn_at },
    { source: 'leader_runtime_activity', at: leaderActivity?.last_activity_at },
    {
      source: 'leader_branch_git_activity',
      at: Number.isFinite(leaderGitActivityMs) ? new Date(leaderGitActivityMs).toISOString() : null,
      ms: leaderGitActivityMs,
    },
  ];

  return signals.map(({ source, at, ms: providedMs }) => {
    const ms = Number.isFinite(providedMs) ? Number(providedMs) : parseIsoMs(at);
    const valid = Number.isFinite(ms);
    const fresh = valid && (nowMs - ms) < thresholdMs;
    return {
      source,
      at: typeof at === 'string' && at.trim().length > 0 ? at : null,
      ms,
      valid,
      fresh,
    };
  });
}

export async function readLatestLeaderActivityMsFromStateDir(stateDir: string): Promise<number> {
  const statuses = await readLeaderRuntimeSignalStatuses(stateDir, Number.MAX_SAFE_INTEGER, Date.now());
  const validMs = statuses.filter((status) => status.valid).map((status) => status.ms);
  return validMs.length > 0 ? Math.max(...validMs) : Number.NaN;
}

export async function isLeaderRuntimeStale(stateDir: string, thresholdMs: number, nowMs: number): Promise<boolean> {
  const statuses = await readLeaderRuntimeSignalStatuses(stateDir, thresholdMs, nowMs);
  const validStatuses = statuses.filter((status) => status.valid);
  if (validStatuses.length === 0) return false;
  return validStatuses.every((status) => !status.fresh);
}
