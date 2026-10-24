import { execFile as execFileCb, execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, promises as fsPromises } from 'fs';
import { basename, dirname, join, posix, resolve, win32 } from 'path';
import { promisify } from 'util';
import {
  assertCurrentTaskBranchAvailable,
  upsertCurrentTaskBaseline,
} from './current-task-baseline.js';

const execFilePromise = promisify(execFileCb);

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
  scope: 'launch' | 'team' | 'autoresearch';
  mode: WorktreeMode;
  teamName?: string;
  workerName?: string;
  worktreeTag?: string;
}

export interface PlannedWorktreeTarget {
  enabled: true;
  scope: 'launch' | 'team' | 'autoresearch';
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
  /** True when the worktree had uncommitted changes at launch time. */
  dirty?: boolean;
}

export interface EnsureWorktreeOptions {
  allowDirtyReuse?: boolean;
}

interface GitWorktreeEntry {
  path: string;
  head: string;
  branchRef: string | null;
  detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

export function isGitRepository(cwd: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  return result.status === 0;
}

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
      windowsHide: true,
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
      windowsHide: true,
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

export function isWorktreeDirty(worktreePath: string): boolean {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `worktree_status_failed:${worktreePath}`);
  }
  return (result.stdout || '').trim() !== '';
}

export function readWorkspaceStatusLines(cwd: string): string[] {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `workspace_status_failed:${cwd}`);
  }
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function assertCleanLeaderWorkspaceForWorkerWorktrees(cwd: string): void {
  const lines = readWorkspaceStatusLines(cwd);
  if (lines.length === 0) return;
  const preview = lines.slice(0, 8).join(' | ');
  throw new Error(
    `leader_workspace_dirty_for_worktrees:${resolve(cwd)}:${preview}:commit_or_stash_before_omx_team`,
  );
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

function pruneStaleWorktreePath(repoRoot: string, worktreePath: string): void {
  const result = spawnSync('git', ['worktree', 'prune'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  throw new Error(stderr || `worktree_prune_failed:${worktreePath}`);
}

function resolveBranchName(input: WorktreePlanInput): string | null {
  if (!input.mode.enabled || input.mode.detached) return null;

  if (input.scope === 'launch') {
    return input.mode.name;
  }

  if (input.scope === 'autoresearch') {
    const runTag = sanitizePathToken(input.worktreeTag || 'run');
    return `autoresearch/${sanitizePathToken(input.mode.name)}/${runTag}`;
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

  if (input.scope === 'autoresearch') {
    if (!input.mode.enabled || input.mode.detached) {
      throw new Error('autoresearch_worktree_requires_named_mode');
    }
    const runTag = sanitizePathToken(input.worktreeTag || 'run');
    return join(repoRoot, '.omx', 'worktrees', `autoresearch-${sanitizePathToken(input.mode.name)}-${runTag}`);
  }

  const teamName = sanitizePathToken(input.teamName || 'team');
  const workerName = sanitizePathToken(input.workerName || 'worker');
  return join(repoRoot, '.omx', 'team', teamName, 'worktrees', workerName);
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

function resolveGitCommonDir(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  if (!value) return null;
  return resolve(cwd, value);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
  if (!existsSync(worktreePath)) return null;

  const repoCommonDir = resolveGitCommonDir(repoRoot);
  const worktreeCommonDir = resolveGitCommonDir(worktreePath);
  if (!repoCommonDir || !worktreeCommonDir || repoCommonDir !== worktreeCommonDir) {
    return null;
  }

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (headResult.status !== 0) return null;
  const head = (headResult.stdout || '').trim();
  if (!head) return null;

  const branchResult = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  const branchRef = branchResult.status === 0 ? (branchResult.stdout || '').trim() : null;

  return {
    path: resolve(worktreePath),
    head,
    branchRef: branchRef || null,
    detached: !branchRef,
  };
}

export function parseWorktreeMode(args: string[]): ParsedWorktreeMode {
  let mode: WorktreeMode = { enabled: false };
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const rawArg = args[i];
    const arg = String(rawArg || '');

    if (arg === '--') {
      remaining.push(...args.slice(i));
      break;
    }
    if (arg === '--worktree' || arg === '-w') {
      // Peek at the next argument: if it looks like a git branch name (not a
      // flag and not a team worker spec like "3:debugger"), consume it as the
      // branch name. Colons are not valid in git branch names, so we use that
      // to distinguish branch names from other positional args.
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-') && !next.includes(':')) {
        mode = { enabled: true, detached: false, name: next };
        i += 1;
      } else {
        mode = { enabled: true, detached: true, name: null };
      }
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

export function ensureWorktree(
  plan: PlannedWorktreeTarget | { enabled: false },
  options: EnsureWorktreeOptions = {},
): EnsureWorktreeResult | { enabled: false } {
  if (!plan.enabled) return { enabled: false };

  let allWorktrees = listWorktrees(plan.repoRoot);
  const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
  if (staleAtPath && !existsSync(staleAtPath.path)) {
    pruneStaleWorktreePath(plan.repoRoot, staleAtPath.path);
    allWorktrees = listWorktrees(plan.repoRoot);
  }
  const existingAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath)
    ?? readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
  const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

  if (existingAtPath) {
    if (plan.detached) {
      if (!existingAtPath.detached || existingAtPath.head !== plan.baseRef) {
        throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
      }
    } else if (existingAtPath.branchRef !== expectedBranchRef) {
      throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
    }

    const dirty = isWorktreeDirty(plan.worktreePath);
    if (dirty && !options.allowDirtyReuse) {
      throw new Error(`worktree_dirty:${plan.worktreePath}`);
    }

    const reused = {
      enabled: true,
      repoRoot: plan.repoRoot,
      worktreePath: resolve(plan.worktreePath),
      detached: plan.detached,
      branchName: plan.branchName,
      created: false,
      reused: true,
      createdBranch: false,
      ...(dirty ? { dirty: true } : {}),
    } satisfies EnsureWorktreeResult;

    if (plan.branchName) {
      upsertCurrentTaskBaseline(plan.repoRoot, {
        branch_name: plan.branchName,
        worktree_path: reused.worktreePath,
        base_ref: plan.baseRef,
        status: 'active',
      });
    }

    return reused;
  }

  if (existsSync(plan.worktreePath)) {
    throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
  }

  if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
    throw new Error(`branch_in_use:${plan.branchName}`);
  }

  if (plan.branchName) {
    assertCurrentTaskBranchAvailable(plan.repoRoot, plan.branchName, plan.worktreePath);
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
      windowsHide: true,
    });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) {
      throw new Error(`branch_in_use:${plan.branchName}`);
    }
    throw new Error(stderr || `worktree_add_failed:${addArgs.join(' ')}`);
  }

  const ensured = {
    enabled: true,
    repoRoot: plan.repoRoot,
    worktreePath: resolve(plan.worktreePath),
    detached: plan.detached,
    branchName: plan.branchName,
    created: true,
    reused: false,
    createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
  } satisfies EnsureWorktreeResult;

  if (plan.branchName) {
    upsertCurrentTaskBaseline(plan.repoRoot, {
      branch_name: plan.branchName,
      worktree_path: ensured.worktreePath,
      base_ref: plan.baseRef,
      status: 'active',
    });
  }

  return ensured;
}

export interface RollbackWorktreeOptions {
  /** Shutdown requires a clean checkout; provisioning and approved cleanup may discard it. */
  force?: boolean;
  /** When true, skip `git branch -D` for branches created during provisioning (ralph policy). */
  skipBranchDeletion?: boolean;
}

interface SubmoduleRecovery {
  directory?: string;
  moved: Array<{ original: string; saved: string; checkout: boolean }>;
  originalCheckouts?: string[];
}

async function prepareSubmodulesForWorktreeRemoval(worktreePath: string, recovery: SubmoduleRecovery): Promise<void> {
  const git = async (args: string[]): Promise<string> => (await execFilePromise('git', args, {
    cwd: worktreePath, encoding: 'utf8',
  })).stdout;
  const mkdir = fsPromises.mkdir;
  const rm = fsPromises.rm;
  
  // Only remove untracked OMX evidence files. If .omx/evidence is tracked or staged,
  // preserve it to avoid destroying work that git add would checkpoint.
  const evidencePath = join(worktreePath, '.omx/evidence');
  const headStatus = await git(['status', '--porcelain', '--', '.omx/evidence']).catch(() => '');
  const isTracked = (await git(['ls-files', '--cached', '.omx/evidence']).catch(() => '')).trim().length > 0;
  if (!headStatus.trim() && !isTracked) {
    // Only remove if it's not tracked or staged
    await rm(evidencePath, { recursive: true, force: true }).catch(() => {});
  }
  
  const status = await git(['status', '--porcelain', '--untracked-files=all', '--ignored', '--ignore-submodules=none']);
  if (status.trim()) throw new Error(`worktree_has_unpreserved_files:${worktreePath}`);
  await git(['submodule', 'foreach', '--recursive',
    'status=$(git status --porcelain --untracked-files=all --ignored --ignore-submodules=none) && test -z "$status" || exit 1']);
  const checkouts = (await git(['submodule', 'foreach', '--quiet', 'printf "%s\\0" "$sm_path"'])).split('\0').filter(Boolean);
  // Save the original checkouts for recheck before removal
  recovery.originalCheckouts = checkouts;
  const modules = resolve(worktreePath, (await git(['rev-parse', '--git-path', 'modules'])).trim());
  if (!existsSync(modules) && checkouts.length === 0) return;
  const commonDir = resolve(worktreePath, (await git(['rev-parse', '--git-common-dir'])).trim());
  const recoveryRoot = join(commonDir, 'omx-submodule-recovery');
  await mkdir(recoveryRoot, { recursive: true });
  recovery.directory = await fsPromises.mkdtemp(join(recoveryRoot, 'worktree-'));
  // Moving whole checkouts retains local data without deinit's writes to shared repository config.
  const moves = checkouts.map(path => ({ original: join(worktreePath, path), saved: join(recovery.directory!, 'checkouts', path), checkout: true }));
  if (existsSync(modules)) moves.push({ original: modules, saved: join(recovery.directory, 'modules'), checkout: false });
  // Include worktreePath to bind recovery journal to this worktree (P2 #4364260549)
  const recoveryMetadata = { worktreePath, moves };
  await fsPromises.writeFile(join(recovery.directory, 'recovery.json'), JSON.stringify(recoveryMetadata));
  for (const move of moves) {
    await fsPromises.mkdir(dirname(move.saved), { recursive: true });
    await fsPromises.rename(move.original, move.saved);
    recovery.moved.push(move);
    // Git treats a missing gitlink as a deletion, but an empty checkout as uninitialized.
    if (move.checkout) await fsPromises.mkdir(move.original);
  }
}

async function restoreSubmodules(recovery: SubmoduleRecovery): Promise<void> {
  const errors: string[] = [];
  for (const move of [...recovery.moved].reverse()) {
    try {
      if (move.checkout) await fsPromises.rmdir(move.original).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (existsSync(move.original)) throw new Error(`recovery_destination_exists:${move.original}`);
      await fsPromises.rename(move.saved, move.original);
    } catch (error) {
      errors.push(`${move.saved}:${String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' | '));
  if (recovery.directory) await fsPromises.rm(recovery.directory, { recursive: true });
}

/**
 * True when `candidate` is `root` or a descendant of it. Uses the platform's
 * path rules, so Windows separators, drive letters, and case are handled and a
 * sibling such as `/repo/wt2` is not treated as inside `/repo/wt`.
 */
export function isPathWithin(candidate: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  const relation = paths.relative(paths.resolve(root), paths.resolve(candidate));
  if (relation === '') return true;
  if (paths.isAbsolute(relation)) return false;
  return relation !== '..' && !relation.startsWith(`..${paths.sep}`);
}

/**
 * Replay any pending submodule recovery journals at the start of shutdown.
 * If the process was killed after moving submodules but before creating placeholders,
 * the recovery.json file persists in the .git/omx-submodule-recovery directory.
 * Replaying it ensures submodules are restored before any git status/add operations.
 * Completed archives are skipped (marked with .completed) to avoid destroying
 * worker-local commits that were moved from a removed worktree.
 * Returns true if all recovery journals were successfully replayed or didn't exist;
 * returns false if any recovery remained unresolved, indicating shutdown should abort.
 */
export async function replaySubmoduleRecovery(worktreePath: string, repoRoot: string): Promise<boolean> {
  const commonDir = resolve(repoRoot, (await execFilePromise('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreePath, encoding: 'utf-8',
  })).stdout.trim());
  const recoveryRoot = join(commonDir, 'omx-submodule-recovery');
  if (!existsSync(recoveryRoot)) return true; // No recovery needed
  
  // Legacy journals also archive the worktree's private Git modules directory,
  // which lives outside the checkout for linked worktrees.
  const worktreeModulesPath = resolve(worktreePath, (await execFilePromise('git', ['rev-parse', '--git-path', 'modules'], {
    cwd: worktreePath, encoding: 'utf-8',
  })).stdout.trim());

  let anyRecoveryUnresolved = false;
  
  const archives = await fsPromises.readdir(recoveryRoot).catch(() => []);
  for (const archive of archives) {
    const recoveryDir = join(recoveryRoot, archive);
    const recoveryJsonPath = join(recoveryDir, 'recovery.json');
    const completedMarkerPath = join(recoveryDir, '.completed');
    
    // Skip archives that were already completed (removed worktree with successful moves)
    if (existsSync(completedMarkerPath)) continue;
    if (!existsSync(recoveryJsonPath)) continue;
    
    try {
      const content = await fsPromises.readFile(recoveryJsonPath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      
      // Handle both old format (array) and new format (object with metadata)
      const moves = (Array.isArray(parsed) 
        ? parsed 
        : (parsed as { worktreePath?: string; moves?: unknown[] }).moves || []
      ) as Array<{ original: string; saved: string; checkout: boolean }>;
      const storedWorktreePath = !Array.isArray(parsed) && (parsed as { worktreePath?: string }).worktreePath;
      
      // P2 #4364260549: Only replay journals for the current worktree
      if (storedWorktreePath && storedWorktreePath !== worktreePath) {
        continue; // Skip journals from other worktrees
      }
      
      // For legacy journals (array format without worktreePath), infer ownership from move destinations
      if (!storedWorktreePath && Array.isArray(parsed)) {
        const destinationInWorktree = moves.some(move =>
          isPathWithin(move.original, worktreePath) || isPathWithin(move.original, worktreeModulesPath));
        if (!destinationInWorktree) {
          continue; // Legacy journal belongs to another worktree
        }
      }
      
      let anyMovesFailed = false;
      // Restore all submodules from this recovery directory
      for (const move of [...moves].reverse()) {
        try {
          // P2 #4364260546: Check if saved path still exists; if not, move was already restored
          if (!existsSync(move.saved)) {
            continue; // This move was already successfully restored in a prior replay
          }
          
          if (move.checkout) await fsPromises.rmdir(move.original).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          if (existsSync(move.original)) {
            // Destination exists but move was skipped; preserve recovery for retry
            anyMovesFailed = true;
            continue;
          }
          await fsPromises.rename(move.saved, move.original);
        } catch (error) {
          // Log but continue - we want to restore as much as possible
          anyMovesFailed = true;
          process.stderr.write(`[team/worktree] submodule recovery failed for ${move.original}: ${String(error)}\n`);
        }
      }
      
      // Only delete the recovery directory if all moves were successfully restored
      // Otherwise preserve it for the next shutdown attempt
      if (!anyMovesFailed) {
        await fsPromises.rm(recoveryDir, { recursive: true }).catch(() => {});
      } else {
        anyRecoveryUnresolved = true;
      }
    } catch (error) {
      process.stderr.write(`[team/worktree] failed to replay recovery journal: ${String(error)}\n`);
      anyRecoveryUnresolved = true;
    }
  }
  return !anyRecoveryUnresolved;
}

/**
 * Mark a recovery directory as completed so it won't be replayed.
 * Called after a worktree removal succeeds to indicate the checkouts were
 * successfully moved but we're destroying the worktree anyway.
 */
export async function markSubmoduleRecoveryCompleted(recoveryDir: string): Promise<void> {
  const completedMarkerPath = join(recoveryDir, '.completed');
  await fsPromises.writeFile(completedMarkerPath, 'completed').catch(() => {});
}

/**
 * Recheck all submodule placeholders immediately before worktree removal.
 * A watcher may have repopulated a submodule path after the placeholder was created,
 * and those writes may not be detected as dirty by git status. Verify all placeholders
 * are still empty to prevent silent data loss.
 * Uses the pre-move checkout list because after moves, `git submodule foreach`
 * returns no paths (the checkouts are now in the recovery archive).
 */
export async function recheckSubmodulePlaceholdersBeforeRemoval(
  worktreePath: string,
  originalCheckouts: string[],
): Promise<void> {
  try {
    for (const submodule of originalCheckouts) {
      const placeholderPath = join(worktreePath, submodule);
      if (!existsSync(placeholderPath)) continue;
      
      // Check if the placeholder directory is still empty
      const entries = await fsPromises.readdir(placeholderPath).catch(() => []);
      if (entries.length > 0) {
        throw new Error(`submodule_placeholder_repopulated:${submodule}:${entries.join(',')}`);
      }
    }
  } catch (error) {
    // Re-throw to abort the removal if placeholders are not safe
    throw error;
  }
}

export async function rollbackProvisionedWorktrees(
  results: Array<EnsureWorktreeResult | { enabled: false }>,
  options: RollbackWorktreeOptions = {},
): Promise<void> {
  const created = results
    .filter((result): result is EnsureWorktreeResult => result.enabled === true && result.created)
    .reverse();

  const errors: string[] = [];

  for (const result of created) {
    const submodules: SubmoduleRecovery = { moved: [] };
    try {
      if (options.force === false) await prepareSubmodulesForWorktreeRemoval(result.worktreePath, submodules);
      // Recheck all submodule placeholders immediately before removal.
      // A watcher may have repopulated a submodule path after the placeholder was created.
      // Pass the original checkouts list because after moves, git submodule foreach returns no paths.
      if (options.force === false && submodules.originalCheckouts) {
        await recheckSubmodulePlaceholdersBeforeRemoval(result.worktreePath, submodules.originalCheckouts);
      }
      await execFilePromise('git', ['worktree', 'remove', ...(options.force === false ? [] : ['--force']), result.worktreePath], {
        cwd: result.repoRoot,
        encoding: 'utf-8',
      });
      // Mark the recovery directory as completed so it won't be replayed
      if (submodules.directory) {
        await markSubmoduleRecoveryCompleted(submodules.directory);
        console.warn(`[team worktree] Submodule data retained at ${submodules.directory}`);
      }
    } catch (err: unknown) {
      if (submodules.directory) {
        try {
          await restoreSubmodules(submodules);
        } catch (restoreError) {
          errors.push(`submodule_recovery:${submodules.directory}:${String(restoreError)}`);
        }
      }
      const stderr = ((err as Record<string, unknown>).stderr as string ?? '').trim();
      const exitCode = (err as Record<string, unknown>).code;
      errors.push(`remove:${result.worktreePath}:${stderr || (err instanceof Error ? err.message : `exit_${exitCode}`)}`);
      continue;
    }

    if (options.skipBranchDeletion) continue;
    if (!result.createdBranch || !result.branchName) continue;

    const entriesAfterRemove = listWorktrees(result.repoRoot);
    const stillCheckedOut = hasBranchInUse(entriesAfterRemove, result.branchName, result.worktreePath);
    if (stillCheckedOut) continue;

    try {
      await execFilePromise('git', ['branch', '-D', result.branchName], {
        cwd: result.repoRoot,
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      if (branchExists(result.repoRoot, result.branchName)) {
        const stderr = ((err as Record<string, unknown>).stderr as string ?? '').trim();
        const exitCode = (err as Record<string, unknown>).code;
        errors.push(`delete_branch:${result.branchName}:${stderr || `exit_${exitCode}`}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`worktree_rollback_failed:${errors.join(' | ')}`);
  }
}

export async function removeWorktreeForce(repoRoot: string, worktreePath: string): Promise<void> {
  await execFilePromise('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}
