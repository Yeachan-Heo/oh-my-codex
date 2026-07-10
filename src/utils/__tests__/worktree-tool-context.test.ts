import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderCodeGraphInstructions,
  resolveWorktreeToolContext,
  worktreeToolContextEnv,
} from '../worktree-tool-context.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-codegraph-context-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function writeCodeGraphDb(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, '.codegraph'), { recursive: true });
  await writeFile(join(projectPath, '.codegraph', 'codegraph.db'), 'fixture\n', 'utf-8');
}

function addWorktree(repo: string, path: string, branch: string): void {
  execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd: repo, stdio: 'ignore' });
}

function siblingWorktreePath(repo: string, name: string): string {
  return join(repo, '..', `${basename(repo)}-${name}`);
}

describe('resolveWorktreeToolContext', () => {
  it('uses sibling launch worktree with shared leader CodeGraph in auto mode', async () => {
    const repo = await initRepo();
    try {
      await writeCodeGraphDb(repo);
      const worktree = siblingWorktreePath(repo, 'sibling-launch');
      addWorktree(repo, worktree, 'feat/sibling-launch');

      const context = resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: {} });
      assert.equal(context.repoRoot, repo);
      assert.equal(context.worktreeRoot, worktree);
      assert.equal(context.codeGraphMode, 'shared');
      assert.equal(context.codeGraphProjectPath, repo);
      assert.equal(worktreeToolContextEnv(context).OMX_WORKTREE_SCOPE, 'launch');
      assert.match(renderCodeGraphInstructions(context), /shared leader index/);
      assert.match(renderCodeGraphInstructions(context), /not branch-accurate for worktree-only changes/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('uses nested team leader CodeGraph as shared context', async () => {
    const repo = await initRepo();
    try {
      const leaderWorktree = join(repo, '.omx', 'team', 'parent', 'worktrees', 'worker-1');
      addWorktree(repo, leaderWorktree, 'parent/worker-1');
      await writeCodeGraphDb(leaderWorktree);
      const nestedWorker = join(repo, '.omx', 'team', 'nested', 'worktrees', 'worker-1');
      addWorktree(repo, nestedWorker, 'nested/worker-1');

      const context = resolveWorktreeToolContext({
        cwd: nestedWorker,
        scope: 'team',
        repoRoot: leaderWorktree,
        worktreeRoot: nestedWorker,
        env: {},
      });
      assert.equal(context.codeGraphMode, 'shared');
      assert.equal(context.codeGraphProjectPath, leaderWorktree);
      assert.equal(worktreeToolContextEnv(context).OMX_REPO_ROOT, leaderWorktree);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('prefers worktree-local CodeGraph over shared leader CodeGraph', async () => {
    const repo = await initRepo();
    try {
      await writeCodeGraphDb(repo);
      const worktree = siblingWorktreePath(repo, 'local-precedence');
      addWorktree(repo, worktree, 'feat/local-precedence');
      await writeCodeGraphDb(worktree);

      const context = resolveWorktreeToolContext({ cwd: worktree, scope: 'team', repoRoot: repo, worktreeRoot: worktree, env: {} });
      assert.equal(context.codeGraphMode, 'local');
      assert.equal(context.codeGraphProjectPath, worktree);
      assert.doesNotMatch(renderCodeGraphInstructions(context), /not branch-accurate/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('turns auto mode off when no CodeGraph database exists', async () => {
    const repo = await initRepo();
    try {
      const worktree = siblingWorktreePath(repo, 'no-codegraph');
      addWorktree(repo, worktree, 'feat/no-codegraph');

      const context = resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: {} });
      assert.equal(context.codeGraphMode, 'off');
      assert.equal(context.codeGraphProjectPath, '');
      assert.equal(renderCodeGraphInstructions(context), '');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('honors explicit shared local auto and off modes', async () => {
    const repo = await initRepo();
    try {
      await writeCodeGraphDb(repo);
      const worktree = siblingWorktreePath(repo, 'explicit-modes');
      addWorktree(repo, worktree, 'feat/explicit-modes');

      assert.equal(resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: { OMX_CODEGRAPH_MODE: 'shared' } }).codeGraphMode, 'shared');
      assert.equal(resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: { OMX_CODEGRAPH_MODE: 'local' } }).codeGraphMode, 'local');
      assert.equal(resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: { OMX_CODEGRAPH_MODE: 'auto' } }).codeGraphMode, 'shared');
      assert.equal(resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: { OMX_CODEGRAPH_MODE: 'off' } }).codeGraphMode, 'off');
      assert.equal(resolveWorktreeToolContext({ cwd: worktree, scope: 'launch', repoRoot: repo, worktreeRoot: worktree, env: { OMX_CODEGRAPH_MODE: 'shared', OMX_CODEGRAPH_REQUESTED_MODE: 'auto' } }).codeGraphMode, 'shared');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
