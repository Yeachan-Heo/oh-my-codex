import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

export type WorktreeMode =
  | { enabled: false }
  | { enabled: true; detached: true; name: null }
  | { enabled: true; detached: false; name: string };

export interface ParsedWorktreeMode {
  mode: WorktreeMode;
  remainingArgs: string[];
}

export interface WorktreePlanInput {
  cwd: string;
  scope: 'launch' | 'team';
  mode: WorktreeMode;
  teamName?: string;
  workerName?: string;
}

export interface PlannedWorktreeTarget {
  enabled: true;
  scope: 'launch' | 'team';
  repoRoot: string;
  worktreePath: string;
  detached: boolean;
  baseRef: string;
  branchName: string | null;
}

export interface EnsureWorktreeResult {
  enabled: true;
  repoRoot: string;
  worktreePath: string;
  detached: boolean;
  branchName: string | null;
  created: boolean;
  reused: boolean;
  createdBranch: boolean;
}

interface GitWorktreeEntry {
  path: string;
  head: string;
  branchRef: string | null;
  detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

function sanitizePathToken(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'default';
}

function readGit(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : err.stderr instanceof Buffer
        ? err.stderr.toString('utf-8').trim()
        : '';
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

function validateBranchName(repoRoot: string, branchName: string): void {
  const result = spawnSync('git', ['check-ref-format', '--branch', branchName], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}

function branchExists(repoRoot: string, branchName: string): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

function listWorktrees(repoRoot: string): GitWorktreeEntry[] {
  const raw = readGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: GitWorktreeEntry[] = [];
  const chunks = raw
    .split(/\n\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    const headLine = lines.find((line) => line.startsWith('HEAD '));
    const branchLine = lines.find((line) => line.startsWith('branch '));
    if (!worktreeLine || !headLine) continue;

    entries.push({
      path: resolve(worktreeLine.slice('worktree '.length)),
      head: headLine.slice('HEAD '.length).trim(),
      branchRef: branchLine ? branchLine.slice('branch '.length).trim() : null,
      detached: lines.includes('detached') || !branchLine,
    });
  }

  return entries;
}

function resolveBranchName(input: WorktreePlanInput): string | null {
  if (!input.mode.enabled || input.mode.detached) return null;

  if (input.scope === 'launch') {
    return input.mode.name;
  }

  const workerName = (input.workerName || '').trim();
  if (!workerName) {
    throw new Error('team_worktree_worker_name_required');
  }

  return `${input.mode.name}/${workerName}`;
}

function resolveWorktreePath(input: WorktreePlanInput, repoRoot: string): string {
  const parent = dirname(repoRoot);
  const bucket = `${basename(repoRoot)}.omx-worktrees`;

  if (input.scope === 'launch') {
    if (!input.mode.enabled || input.mode.detached) {
      return join(parent, bucket, 'launch-detached');
    }
    return join(parent, bucket, `launch-${sanitizePathToken(input.mode.name)}`);
  }

  const teamName = sanitizePathToken(input.teamName || 'team');
  const workerName = sanitizePathToken(input.workerName || 'worker');
  return join(parent, bucket, `team-${teamName}-${workerName}`);
}

function findWorktreeByPath(entries: GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | null {
  const resolved = resolve(worktreePath);
  return entries.find((entry) => resolve(entry.path) === resolved) || null;
}

function hasBranchInUse(entries: GitWorktreeEntry[], branchName: string, worktreePath: string): boolean {
  const expectedRef = `refs/heads/${branchName}`;
  const resolvedPath = resolve(worktreePath);
  return entries.some((entry) => entry.branchRef === expectedRef && resolve(entry.path) !== resolvedPath);
}

export function parseWorktreeMode(args: string[]): ParsedWorktreeMode {
  let mode: WorktreeMode = { enabled: false };
  const remaining: string[] = [];

  for (const rawArg of args) {
    const arg = String(rawArg || '');

    if (arg === '--worktree' || arg === '-w') {
      mode = { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('--worktree=')) {
      const value = arg.slice('--worktree='.length).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('-w=')) {
      const value = arg.slice('-w='.length).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('-w') && arg.length > 2) {
      const value = arg.slice(2).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    remaining.push(rawArg);
  }

  return { mode, remainingArgs: remaining };
}

export function planWorktreeTarget(input: WorktreePlanInput): PlannedWorktreeTarget | { enabled: false } {
  if (!input.mode.enabled) return { enabled: false };

  const repoRoot = readGit(input.cwd, ['rev-parse', '--show-toplevel']);
  const baseRef = readGit(repoRoot, ['rev-parse', 'HEAD']);
  const branchName = resolveBranchName(input);

  if (branchName) {
    validateBranchName(repoRoot, branchName);
  }

  return {
    enabled: true,
    scope: input.scope,
    repoRoot,
    worktreePath: resolveWorktreePath(input, repoRoot),
    detached: input.mode.detached,
    baseRef,
    branchName,
  };
}

export function ensureWorktree(plan: PlannedWorktreeTarget | { enabled: false }): EnsureWorktreeResult | { enabled: false } {
  if (!plan.enabled) return { enabled: false };

  const allWorktrees = listWorktrees(plan.repoRoot);
  const existingAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
  const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

  if (existingAtPath) {
    if (plan.detached) {
      if (!existingAtPath.detached || existingAtPath.head !== plan.baseRef) {
        throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
      }
    } else if (existingAtPath.branchRef !== expectedBranchRef) {
      throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
    }

    return {
      enabled: true,
      repoRoot: plan.repoRoot,
      worktreePath: resolve(plan.worktreePath),
      detached: plan.detached,
      branchName: plan.branchName,
      created: false,
      reused: true,
      createdBranch: false,
    };
  }

  if (existsSync(plan.worktreePath)) {
    throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
  }

  if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
    throw new Error(`branch_in_use:${plan.branchName}`);
  }

  mkdirSync(dirname(plan.worktreePath), { recursive: true });
  const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;

  const addArgs = ['worktree', 'add'];
  if (plan.detached) {
    addArgs.push('--detach', plan.worktreePath, plan.baseRef);
  } else if (branchAlreadyExisted) {
    addArgs.push(plan.worktreePath, plan.branchName as string);
  } else {
    addArgs.push('-b', plan.branchName as string, plan.worktreePath, plan.baseRef);
  }

  const result = spawnSync('git', addArgs, {
    cwd: plan.repoRoot,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) {
      throw new Error(`branch_in_use:${plan.branchName}`);
    }
    throw new Error(stderr || `worktree_add_failed:${addArgs.join(' ')}`);
  }

  return {
    enabled: true,
    repoRoot: plan.repoRoot,
    worktreePath: resolve(plan.worktreePath),
    detached: plan.detached,
    branchName: plan.branchName,
    created: true,
    reused: false,
    createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
  };
}

export function rollbackProvisionedWorktrees(results: Array<EnsureWorktreeResult | { enabled: false }>): void {
  const created = results
    .filter((result): result is EnsureWorktreeResult => result.enabled === true && result.created)
    .reverse();

  const errors: string[] = [];

  for (const result of created) {
    const removeResult = spawnSync('git', ['worktree', 'remove', '--force', result.worktreePath], {
      cwd: result.repoRoot,
      encoding: 'utf-8',
    });

    if (removeResult.status !== 0) {
      const stderr = (removeResult.stderr || '').trim();
      errors.push(`remove:${result.worktreePath}:${stderr || `exit_${removeResult.status}`}`);
      continue;
    }

    if (!result.createdBranch || !result.branchName) continue;

    const entriesAfterRemove = listWorktrees(result.repoRoot);
    const stillCheckedOut = hasBranchInUse(entriesAfterRemove, result.branchName, result.worktreePath);
    if (stillCheckedOut) continue;

    const deleteBranchResult = spawnSync('git', ['branch', '-D', result.branchName], {
      cwd: result.repoRoot,
      encoding: 'utf-8',
    });

    if (deleteBranchResult.status !== 0 && branchExists(result.repoRoot, result.branchName)) {
      const stderr = (deleteBranchResult.stderr || '').trim();
      errors.push(`delete_branch:${result.branchName}:${stderr || `exit_${deleteBranchResult.status}`}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`worktree_rollback_failed:${errors.join(' | ')}`);
  }
}
