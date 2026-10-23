import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, promises as fsPromises } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
  rollbackProvisionedWorktrees,
  removeWorktreeForce,
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

  it('does not parse worktree flags after -- and preserves the suffix', () => {
    const args = ['--', '--worktree', 'post-marker-branch'];
    const parsed = parseWorktreeMode(args);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, args);
  });

  it('keeps team args flag-free so the CLI can apply automatic default worktrees', () => {
    const parsed = parseWorktreeMode(['ralph', '2:executor', 'task']);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, ['ralph', '2:executor', 'task']);
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

describe('worktree planning', () => {
  it('plans dedicated autoresearch branch and path naming', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'autoresearch' as never,
        mode: { enabled: true, detached: false, name: 'demo-mission' },
        worktreeTag: '20260314T000000Z',
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      assert.equal(planned.branchName, 'autoresearch/demo-mission/20260314t000000z');
      assert.match(planned.worktreePath.replace(/\\/g, '/'), /\.omx\/worktrees\/autoresearch-demo-mission-20260314t000000z$/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
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

  it('rejects reusing a dirty worktree', async () => {
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

      await writeFile(join(created.worktreePath, 'DIRTY.txt'), 'dirty\n', 'utf-8');
      assert.throws(() => ensureWorktree(planned), /worktree_dirty/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('recreates a detached worktree when git worktree list still contains a missing stale path', async () => {
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

      await rm(created.worktreePath, { recursive: true, force: true });
      assert.equal(existsSync(created.worktreePath), false);

      const recreated = ensureWorktree(planned);
      assert.equal(recreated.enabled, true);
      if (!recreated.enabled) return;
      assert.equal(recreated.created, true);
      assert.equal(recreated.reused, false);
      assert.equal(existsSync(recreated.worktreePath), true);
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

  it('reuses existing worktree when target path already exists as a valid alias', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/reuse-alias' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      const reused = ensureWorktree({ ...plan, worktreePath: aliasPath });
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
      assert.equal(reused.created, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves mismatch safety when existing alias points to a different branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/mismatch-source' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      assert.throws(
        () => ensureWorktree({ ...plan, worktreePath: aliasPath, branchName: 'feature/other-branch' }),
        /worktree_target_mismatch/,
      );
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

      await rollbackProvisionedWorktrees([ensured]);
      assert.equal(existsSync(ensured.worktreePath), false);
      assert.equal(branchExists(repo, 'feature/rollback'), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rollbackProvisionedWorktrees with skipBranchDeletion preserves branches', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/ralph-keep' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(branchExists(repo, 'feature/ralph-keep'), true);

      await rollbackProvisionedWorktrees([ensured], { skipBranchDeletion: true });
      assert.equal(existsSync(ensured.worktreePath), false);
      // Branch is preserved when skipBranchDeletion is true (ralph policy)
      assert.equal(branchExists(repo, 'feature/ralph-keep'), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('shutdown removal versus authorized rollback', () => {
  for (const cleanup of ['rollback', 'stale']) {
    it(`keeps forced cleanup for ${cleanup} while guarded removal rejects dirty files`, async () => {
      const repo = await initRepo();
      try {
        const plan = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: true, name: null } });
        assert.ok(plan.enabled);
        const tree = ensureWorktree(plan);
        assert.ok(tree.enabled);
        await writeFile(join(tree.worktreePath, 'unsaved.txt'), 'unsaved');
        await assert.rejects(rollbackProvisionedWorktrees([tree], { force: false }), /worktree_rollback_failed/);
        assert.equal(await readFile(join(tree.worktreePath, 'unsaved.txt'), 'utf8'), 'unsaved');
        if (cleanup === 'stale') await removeWorktreeForce(repo, tree.worktreePath);
        else await rollbackProvisionedWorktrees([tree], { force: true });
        assert.equal(existsSync(tree.worktreePath), false);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  }

  it('removes clean initialized submodules without force and keeps their Git objects', async (t) => {
    const repo = await initRepo();
    const sub = await initRepo();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'module');
      git(repo, 'commit', '-am', 'add submodule');
      const plan = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: true, name: null } });
      assert.ok(plan.enabled);
      const tree = ensureWorktree(plan);
      assert.ok(tree.enabled);
      git(tree.worktreePath, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
      git(repo, 'config', 'submodule.module.url', 'https://example.invalid/leader-custom.git');
      const sharedConfig = await readFile(join(repo, '.git', 'config'), 'utf8');
      const modulePath = join(tree.worktreePath, 'module');
      git(modulePath, 'config', 'user.name', 'Module Test');
      git(modulePath, 'config', 'user.email', 'module@example.invalid');
      git(modulePath, 'config', 'commit.gpgsign', 'false');
      await writeFile(join(modulePath, '.gitignore'), '.env\n');
      git(modulePath, 'add', '.gitignore');
      git(modulePath, 'commit', '-m', 'local-only submodule commit');
      const localCommit = git(modulePath, 'rev-parse', 'HEAD');
      git(tree.worktreePath, 'add', 'module');
      git(tree.worktreePath, 'commit', '-m', 'save submodule head');
      git(repo, 'merge', '--ff-only', git(tree.worktreePath, 'rev-parse', 'HEAD'));
      await writeFile(join(modulePath, '.env'), 'module secret');
      await assert.rejects(rollbackProvisionedWorktrees([tree], { force: false }), /worktree_rollback_failed/);
      assert.equal(await readFile(join(modulePath, '.env'), 'utf8'), 'module secret');
      await rm(join(modulePath, '.env'));
      const modulesPath = git(tree.worktreePath, 'rev-parse', '--git-path', 'modules');
      const originalRename = fsPromises.rename;
      t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof fsPromises.rename>) => {
        if (args[0] === modulesPath) throw new Error('injected module archive failure');
        return originalRename(...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(rollbackProvisionedWorktrees([tree], { force: false }), /injected module archive failure/);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(git(modulePath, 'rev-parse', 'HEAD'), localCommit, 'partial preparation restores moved checkouts');
      assert.equal(await readFile(join(modulePath, '.gitignore'), 'utf8'), '.env\n');
      assert.equal(await readFile(join(repo, '.git', 'config'), 'utf8'), sharedConfig);
      if (process.platform !== 'win32') {
        const originalModules = git(tree.worktreePath, 'rev-parse', '--git-path', 'modules');
        const bin = await mkdtemp(join(tmpdir(), 'omx-submodule-late-write-'));
        const previousPath = process.env.PATH;
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        try {
          await writeFile(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'worktree' && args[1] === 'remove') require('fs').writeFileSync(${JSON.stringify(join(tree.worktreePath, 'late.txt'))}, 'late write');
const r = require('child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
          process.env.PATH = `${bin}:${previousPath ?? ''}`;
          await assert.rejects(rollbackProvisionedWorktrees([tree], { force: false }), /worktree_rollback_failed/);
          assert.equal(await readFile(join(tree.worktreePath, 'late.txt'), 'utf8'), 'late write');
          assert.equal(git(repo, '--git-dir', join(originalModules, 'module'), 'rev-parse', 'HEAD'), localCommit);
          assert.equal(git(modulePath, 'rev-parse', 'HEAD'), localCommit);
          assert.equal(await readFile(join(modulePath, '.gitignore'), 'utf8'), '.env\n');
          assert.equal(await readFile(join(repo, '.git', 'config'), 'utf8'), sharedConfig);
          assert.ok(existsSync(join(repo, 'module', '.git')));
        } finally {
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
          await rm(bin, { recursive: true, force: true });
        }
        await rm(join(tree.worktreePath, 'late.txt'));
      }
      await rollbackProvisionedWorktrees([tree], { force: false });
      assert.equal(existsSync(tree.worktreePath), false);
      assert.equal(await readFile(join(repo, '.git', 'config'), 'utf8'), sharedConfig);
      assert.ok(existsSync(join(repo, 'module', '.git')));
      const recoveryRoot = join(repo, '.git', 'omx-submodule-recovery');
      const archives = await readdir(recoveryRoot);
      assert.equal(archives.length, 1);
      assert.equal(await readFile(join(recoveryRoot, archives[0]!, 'checkouts', 'module', '.gitignore'), 'utf8'), '.env\n');
      assert.equal(git(repo, '--git-dir', join(recoveryRoot, archives[0]!, 'modules', 'module'), '--work-tree', join(recoveryRoot, archives[0]!, 'checkouts', 'module'), 'rev-parse', 'HEAD'), localCommit);
      assert.equal(git(repo, '--git-dir', join(recoveryRoot, archives[0]!, 'modules', 'module'), '--work-tree', join(recoveryRoot, archives[0]!, 'checkouts', 'module'), 'show', `${localCommit}:.gitignore`), '.env');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(sub, { recursive: true, force: true });
    }
  });
});
