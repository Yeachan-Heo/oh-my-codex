import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
  rollbackProvisionedWorktrees,
} from '../worktree.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-worktree-test-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('worktree parser', () => {
  it('parses detached mode from --worktree', () => {
    const parsed = parseWorktreeMode(['--worktree', '--yolo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['--yolo']);
  });

  it('parses named mode from --worktree=name', () => {
    const parsed = parseWorktreeMode(['--worktree=feature/foo', 'task']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feature/foo' });
    assert.deepEqual(parsed.remainingArgs, ['task']);
  });

  it('keeps args unchanged when worktree flag is absent', () => {
    const parsed = parseWorktreeMode(['team', '2:executor', 'task']);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, ['team', '2:executor', 'task']);
  });

  // Regression tests for issue #203: branch name passed as separate arg must not
  // leak into the Codex shell as input.
  it('parses named branch from --worktree <name> (space-separated)', () => {
    const parsed = parseWorktreeMode(['--worktree', 'my-branch']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'my-branch' });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('parses named branch from -w <name> (space-separated)', () => {
    const parsed = parseWorktreeMode(['-w', 'my-branch']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'my-branch' });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('does not leak branch name into remainingArgs when --worktree <name> is used with trailing args', () => {
    const parsed = parseWorktreeMode(['--worktree', 'feat/issue-203', '--yolo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feat/issue-203' });
    assert.deepEqual(parsed.remainingArgs, ['--yolo']);
  });

  it('treats --worktree at end of args as detached', () => {
    const parsed = parseWorktreeMode(['--worktree']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('treats -w at end of args as detached', () => {
    const parsed = parseWorktreeMode(['-w']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, []);
  });
});

describe('worktree ensure + rollback', () => {
  it('creates and reuses detached worktree idempotently', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);
      assert.equal(existsSync(created.worktreePath), true);

      const reused = ensureWorktree(planned);
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
      assert.equal(reused.created, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('creates per-worker named branch and blocks branch-in-use collisions', async () => {
    const repo = await initRepo();
    try {
      const workerPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      assert.equal(workerPlan.enabled, true);
      if (!workerPlan.enabled) return;

      const created = ensureWorktree(workerPlan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);
      assert.equal(created.createdBranch, true);
      assert.equal(branchExists(repo, 'feat/worker-1'), true);

      const conflictingLaunchPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feat/worker-1' },
      });
      assert.equal(conflictingLaunchPlan.enabled, true);
      if (!conflictingLaunchPlan.enabled) return;

      assert.throws(() => ensureWorktree(conflictingLaunchPlan), /branch_in_use/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rollback removes newly created worktree and branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/rollback' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(branchExists(repo, 'feature/rollback'), true);

      rollbackProvisionedWorktrees([ensured]);
      assert.equal(existsSync(ensured.worktreePath), false);
      assert.equal(branchExists(repo, 'feature/rollback'), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
