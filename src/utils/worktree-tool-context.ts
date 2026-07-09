import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type WorktreeToolScope = 'launch' | 'team' | 'autoresearch' | 'repo';
export type RequestedCodeGraphMode = 'auto' | 'shared' | 'local' | 'off';
export type ResolvedCodeGraphMode = 'shared' | 'local' | 'off';

export interface WorktreeToolContext {
  repoRoot: string;
  worktreeRoot: string;
  gitCommonDir: string;
  worktreeScope: WorktreeToolScope;
  codeGraphMode: ResolvedCodeGraphMode;
  codeGraphProjectPath: string;
  codeGraphDbPath: string;
  codeGraphSource: 'worktree-local' | 'leader-shared' | 'none';
  requestedCodeGraphMode: RequestedCodeGraphMode;
}

export interface ResolveWorktreeToolContextOptions {
  cwd: string;
  scope: WorktreeToolScope;
  repoRoot?: string | null;
  worktreeRoot?: string | null;
  env?: NodeJS.ProcessEnv;
}

function readGit(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

function resolveGitRoot(cwd: string): string | null {
  const value = readGit(cwd, ['rev-parse', '--show-toplevel']);
  return value ? resolve(value) : null;
}

function resolveGitCommonDir(cwd: string, fallbackRoot: string): string {
  const value = readGit(cwd, ['rev-parse', '--git-common-dir']);
  return value ? resolve(cwd, value) : join(fallbackRoot, '.git');
}

function normalizeRequestedCodeGraphMode(env: NodeJS.ProcessEnv): RequestedCodeGraphMode {
  const raw = String(env.OMX_CODEGRAPH_REQUESTED_MODE ?? env.OMX_CODEGRAPH_MODE ?? 'auto').trim().toLowerCase();
  if (raw === '' || raw === 'auto') return 'auto';
  if (raw === 'shared' || raw === 'local' || raw === 'off') return raw;
  return 'auto';
}

function resolveCodeGraphDbPath(projectPath: string): string {
  return join(projectPath, '.codegraph', 'codegraph.db');
}

export function resolveWorktreeToolContext(options: ResolveWorktreeToolContextOptions): WorktreeToolContext {
  const env = options.env ?? process.env;
  const worktreeRoot = resolve(options.worktreeRoot?.trim() || resolveGitRoot(options.cwd) || options.cwd);
  const repoRoot = resolve(options.repoRoot?.trim() || resolveGitRoot(options.cwd) || worktreeRoot);
  const gitCommonDir = resolveGitCommonDir(worktreeRoot, repoRoot);
  const requestedCodeGraphMode = normalizeRequestedCodeGraphMode(env);
  const localDbPath = resolveCodeGraphDbPath(worktreeRoot);
  const sharedDbPath = resolveCodeGraphDbPath(repoRoot);
  const hasLocalDb = existsSync(localDbPath);
  const hasSharedDb = existsSync(sharedDbPath);

  let codeGraphMode: ResolvedCodeGraphMode = 'off';
  let codeGraphProjectPath = '';
  let codeGraphDbPath = '';
  let codeGraphSource: WorktreeToolContext['codeGraphSource'] = 'none';

  if (requestedCodeGraphMode === 'local') {
    codeGraphMode = 'local';
    codeGraphProjectPath = worktreeRoot;
    codeGraphDbPath = localDbPath;
    codeGraphSource = 'worktree-local';
  } else if (requestedCodeGraphMode === 'shared') {
    codeGraphMode = 'shared';
    codeGraphProjectPath = repoRoot;
    codeGraphDbPath = sharedDbPath;
    codeGraphSource = 'leader-shared';
  } else if (requestedCodeGraphMode === 'auto') {
    if (hasLocalDb) {
      codeGraphMode = 'local';
      codeGraphProjectPath = worktreeRoot;
      codeGraphDbPath = localDbPath;
      codeGraphSource = 'worktree-local';
    } else if (hasSharedDb) {
      codeGraphMode = 'shared';
      codeGraphProjectPath = repoRoot;
      codeGraphDbPath = sharedDbPath;
      codeGraphSource = 'leader-shared';
    }
  }

  return {
    repoRoot,
    worktreeRoot,
    gitCommonDir,
    worktreeScope: options.scope,
    codeGraphMode,
    codeGraphProjectPath,
    codeGraphDbPath,
    codeGraphSource,
    requestedCodeGraphMode,
  };
}

export function worktreeToolContextEnv(context: WorktreeToolContext): Record<string, string> {
  return {
    OMX_REPO_ROOT: context.repoRoot,
    OMX_WORKTREE_ROOT: context.worktreeRoot,
    OMX_GIT_COMMON_DIR: context.gitCommonDir,
    OMX_WORKTREE_SCOPE: context.worktreeScope,
    OMX_CODEGRAPH_MODE: context.codeGraphMode,
    OMX_CODEGRAPH_PROJECT_PATH: context.codeGraphProjectPath,
    OMX_CODEGRAPH_REQUESTED_MODE: context.requestedCodeGraphMode,
  };
}

export function renderCodeGraphInstructions(context: WorktreeToolContext): string {
  if (context.codeGraphMode === 'off') return '';
  const modeLine = context.codeGraphMode === 'local'
    ? `- Mode: local worktree index (${context.codeGraphProjectPath})`
    : `- Mode: shared leader index (${context.codeGraphProjectPath})`;
  const warning = context.codeGraphMode === 'shared'
    ? '\n- Warning: the shared leader CodeGraph index is not branch-accurate for worktree-only changes; verify changed files directly in this worktree.'
    : '';
  return [
    '## CodeGraph',
    modeLine,
    `- Project path: ${context.codeGraphProjectPath}`,
    `- Database: ${context.codeGraphDbPath || '(not found yet)'}`,
    '- OMX does not install CodeGraph, auto-index worktrees, or copy/symlink `.codegraph` for this run.',
    warning.trim(),
  ].filter(Boolean).join('\n');
}
