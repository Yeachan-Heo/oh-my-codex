import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTeamState,
  createTask,
  claimTask,
  transitionTaskStatus,
  listMailboxMessages,
  readMonitorSnapshot,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  writeWorkerStatus,
} from '../state.js';
import { monitorTeam } from '../runtime.js';
import { readTeamEvents } from '../state/events.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-cross-rebase-smoke-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, '.git/info/exclude'), '.omx/\n');
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function addWorktree(repo: string, branchName: string, prefix: string): Promise<string> {
  const worktreePath = await mkdtemp(join(tmpdir(), prefix));
  execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repo, stdio: 'ignore' });
  return worktreePath;
}

async function configureWorkers(
  teamName: string,
  repo: string,
  workers: Array<{ path: string; branch: string }>,
): Promise<void> {
  await initTeamState(teamName, 'cross rebase smoke', 'executor', workers.length, repo);
  const cfg = await readTeamConfig(teamName, repo);
  assert.ok(cfg);
  if (!cfg) throw new Error('missing team config');
  cfg.leader_pane_id = '';
  workers.forEach((worker, index) => {
    cfg.workers[index] = {
      ...cfg.workers[index],
      assigned_tasks: [String(index + 1)],
      worktree_repo_root: repo,
      worktree_path: worker.path,
      worktree_branch: worker.branch,
      worktree_detached: false,
      worktree_created: false,
    };
  });
  await saveTeamConfig(cfg, repo);
  for (const worker of cfg.workers) {
    const task = await createTask(teamName, {
      subject: `Verified output from ${worker.name}`, description: 'Ready for integration',
      status: 'pending', owner: worker.name, requires_code_change: true,
    }, repo);
    assert.deepEqual(worker.assigned_tasks, [task.id]);
    const claim = await claimTask(teamName, task.id, worker.name, null, repo);
    assert.ok(claim.ok);
    const workerCwd = worker.worktree_path!;
    await mkdir(join(workerCwd, '.omx/evidence'), { recursive: true });
    await writeFile(join(workerCwd, '.omx/evidence/handoff.json'), JSON.stringify({
      teamName, taskId: task.id, claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
      verifiedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workerCwd, encoding: 'utf8' }).trim(),
      summary: 'Verified worker output', verification: [{ command: 'npm test', result: 'passed', output: 'Tests passed' }], unverified: [],
    }));
    const completed = await transitionTaskStatus(teamName, task.id, 'in_progress', 'completed', claim.claimToken, repo, {
      result: 'Verification: PASS `npm test` for worker output.\nEVIDENCE_RECORDED: .omx/evidence/handoff.json',
    });
    assert.ok(completed.ok, JSON.stringify(completed));
    await writeWorkerStatus(teamName, worker.name, { state: 'done', updated_at: new Date().toISOString() }, repo);
  }
}

describe('cross-rebase smoke regression', () => {
  it('surfaces cross-rebase applied as an audit event without making it wakeable', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'wk1-cross-applied', 'omx-cross-applied-w1-');
      worker2Path = await addWorktree(repo, 'wk2-cross-applied', 'omx-cross-applied-w2-');

      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n', 'utf-8');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 change'], { cwd: worker1Path, stdio: 'ignore' });

      await writeFile(join(worker2Path, 'w2.txt'), 'from worker 2\n', 'utf-8');
      execFileSync('git', ['add', 'w2.txt'], { cwd: worker2Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-2 change'], { cwd: worker2Path, stdio: 'ignore' });

      await configureWorkers('cross-rebase-applied', repo, [
        { path: worker1Path, branch: 'wk1-cross-applied' },
        { path: worker2Path, branch: 'wk2-cross-applied' },
      ]);

      await monitorTeam('cross-rebase-applied', repo);

      const events = await readTeamEvents('cross-rebase-applied', repo, { wakeableOnly: false });
      const wakeable = await readTeamEvents('cross-rebase-applied', repo, { wakeableOnly: true });
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_applied' && event.worker === 'worker-2'), true);
      assert.equal(wakeable.some((event) => event.type === 'worker_cross_rebase_applied'), false);
    } finally {
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves unfinished rebases during scale-down', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'wk1-rebase-preserve', 'omx-rebase-preserve-w1-');
      worker2Path = await addWorktree(repo, 'wk2-rebase-preserve', 'omx-rebase-preserve-w2-');

      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n', 'utf-8');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 change'], { cwd: worker1Path, stdio: 'ignore' });

      await configureWorkers('rebase-preserve', repo, [
        { path: worker1Path, branch: 'wk1-rebase-preserve' },
        { path: worker2Path, branch: 'wk2-rebase-preserve' },
      ]);

      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf8' }).trim();
      const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
      const fakeBin = await mkdtemp(join(tmpdir(), 'omx-rebase-preserve-fake-'));

      await writeFile(join(fakeBin, 'git'), `#!/bin/bash
if [[ "$PWD" -ef ${JSON.stringify(worker2Path)} && "\${1:-}" == "rebase" ]]; then
  echo 'conflict' > .git/REBASE_HEAD
  exit 1
fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });

      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

      try {
        await monitorTeam('rebase-preserve', repo);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }

      const currentHead = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf8' }).trim();
      assert.equal(currentHead, sourceHead);
      assert.equal(existsSync(join(worker2Path, '.git/REBASE_HEAD')), true);
      await rm(fakeBin, { recursive: true, force: true });
    } finally {
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('skips cross-rebase when worker has pending manual Git operations', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'wk1-pending-git', 'omx-pending-git-w1-');
      worker2Path = await addWorktree(repo, 'wk2-pending-git', 'omx-pending-git-w2-');

      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n', 'utf-8');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 change'], { cwd: worker1Path, stdio: 'ignore' });

      await configureWorkers('pending-git', repo, [
        { path: worker1Path, branch: 'wk1-pending-git' },
        { path: worker2Path, branch: 'wk2-pending-git' },
      ]);

      // Create a pending merge state
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf8' }).trim();
      await writeFile(join(worker2Path, '.git/MERGE_HEAD'), sourceHead, 'utf8');

      await monitorTeam('pending-git', repo);

      const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf8' }).trim();
      assert.equal(currentHead, sourceHead);
      assert.equal(existsSync(join(repo, 'w1.txt')), true);
      assert.equal(existsSync(join(worker2Path, 'w1.txt')), false);
    } finally {
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('handles commit-range failures during cross-rebase', async () => {
    const repo = await initRepo();
    const team = 'range-worker-team';
    const paths: string[] = [];
    const previousPath = process.env.PATH;
    try {
      for (const index of [1, 2]) {
        const path = await addWorktree(repo, `range-worker-${index}`, `omx-range-worker-${index}-`);
        paths.push(path);
        await writeFile(join(path, `w${index}.txt`), `worker ${index}\n`);
        execFileSync('git', ['add', '.'], { cwd: path, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', `worker ${index}`], { cwd: path, stdio: 'ignore' });
      }
      await configureWorkers(team, repo, paths.map((path, index) => ({ path, branch: `range-worker-${index + 1}` })));
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths[1], encoding: 'utf8' }).trim();
      const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
      const fakeBin = await mkdtemp(join(tmpdir(), 'omx-range-worker-fake-'));
      await writeFile(join(fakeBin, 'git'), `#!/bin/bash
if [[ "$PWD" -ef ${JSON.stringify(paths[1])} && "\${1:-}" == "rev-list" ]]; then
  echo 'simulated commit-range failure' >&2
  exit 1
fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      await monitorTeam(team, repo);
      assert.equal(execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: paths[1], encoding: 'utf8' }).trim(), sourceHead);
      assert.equal(existsSync(join(repo, 'w1.txt')), true);
      assert.equal(existsSync(join(repo, 'w2.txt')), false);
      assert.equal(existsSync(join(paths[1], 'w1.txt')), false);
      const snapshot = await readMonitorSnapshot(team, repo);
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.last_integrated_head, undefined);
      const events = await readTeamEvents(team, repo, { wakeableOnly: false });
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_skipped' && event.worker === 'worker-2' && event.metadata?.reason === 'unintegrated_changes'), true);
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_applied' && event.worker === 'worker-2'), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;

      for (const path of paths) await rm(path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps cross-rebase skipped as audit-only when worker state is not eligible', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'wk1-cross-skipped', 'omx-cross-skipped-w1-');
      worker2Path = await addWorktree(repo, 'wk2-cross-skipped', 'omx-cross-skipped-w2-');

      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n', 'utf-8');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 change'], { cwd: worker1Path, stdio: 'ignore' });

      const worker2HeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();

      await configureWorkers('cross-rebase-skipped', repo, [
        { path: worker1Path, branch: 'wk1-cross-skipped' },
        { path: worker2Path, branch: 'wk2-cross-skipped' },
      ]);
      await writeWorkerStatus('cross-rebase-skipped', 'worker-2', { state: 'working', updated_at: new Date().toISOString() }, repo);

      await monitorTeam('cross-rebase-skipped', repo);

      const worker2HeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();
      const events = await readTeamEvents('cross-rebase-skipped', repo, { wakeableOnly: false });
      const wakeable = await readTeamEvents('cross-rebase-skipped', repo, { wakeableOnly: true });

      assert.equal(worker2HeadAfter, worker2HeadBefore);
      assert.equal(existsSync(join(worker2Path, 'w1.txt')), false);
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_skipped'), true);
      assert.equal(wakeable.some((event) => event.type === 'worker_cross_rebase_skipped'), false);
    } finally {
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
