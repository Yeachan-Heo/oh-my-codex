import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTeamState,
  listMailboxMessages,
  readMonitorSnapshot,
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
      await writeWorkerStatus('cross-rebase-applied', 'worker-2', { state: 'idle', updated_at: new Date().toISOString() }, repo);

      await monitorTeam('cross-rebase-applied', repo);

      const events = await readTeamEvents('cross-rebase-applied', repo, { wakeableOnly: false });
      const wakeable = await readTeamEvents('cross-rebase-applied', repo, { wakeableOnly: true });
      const snapshot = await readMonitorSnapshot('cross-rebase-applied', repo);

      assert.equal(existsSync(join(worker2Path, 'w1.txt')), true);
      assert.equal(existsSync(join(worker2Path, 'w2.txt')), true);
      assert.equal(typeof snapshot?.integrationByWorker?.['worker-2']?.last_rebased_leader_head, 'string');
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_applied'), true);
      assert.equal(wakeable.some((event) => event.type === 'worker_cross_rebase_applied'), false);
    } finally {
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('fails closed for two workers editing the same line and never rebases away the conflict', async () => {
    const repo = await initRepo();
    const paths: string[] = [];
    const heads: string[] = [];
    const team = 'same-line-conflict';
    try {
      for (const index of [1, 2]) {
        const path = await addWorktree(repo, `same-line-${index}`, `omx-same-line-${index}-`);
        paths.push(path);
        await writeFile(join(path, 'README.md'), `worker-${index}\n`);
        execFileSync('git', ['add', 'README.md'], { cwd: path, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', `worker ${index} edits same line`], { cwd: path, stdio: 'ignore' });
        heads.push(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf-8' }).trim());
      }
      await configureWorkers(team, repo, paths.map((path, index) => ({ path, branch: `same-line-${index + 1}` })));
      await writeWorkerStatus(team, 'worker-2', { state: 'idle', updated_at: new Date().toISOString() }, repo);
      await monitorTeam(team, repo);
      const leaderHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      // A repeated monitor must not lose the conflict or the original worker history.
      await monitorTeam(team, repo);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim(), leaderHead);
      assert.equal(await readFile(join(repo, 'README.md'), 'utf-8'), 'worker-1\n');
      for (const [index, path] of paths.entries()) {
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf-8' }).trim(), heads[index]);
        assert.equal(await readFile(join(path, 'README.md'), 'utf-8'), `worker-${index + 1}\n`);
        assert.equal(execFileSync('git', ['show', `${heads[index]}:README.md`], { cwd: repo, encoding: 'utf-8' }), `worker-${index + 1}\n`);
      }
      assert.equal(execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo, encoding: 'utf-8' }), '');
      assert.equal(existsSync(join(repo, '.git', 'CHERRY_PICK_HEAD')), false);
      const snapshot = await readMonitorSnapshot(team, repo);
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.status, 'cherry_pick_conflict');
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.conflict_commit, heads[1]);
      assert.deepEqual(snapshot?.integrationByWorker?.['worker-2']?.conflict_files, ['README.md']);
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.last_integrated_head, undefined);
      const events = await readTeamEvents(team, repo, { wakeableOnly: false });
      const wakeable = await readTeamEvents(team, repo, { wakeableOnly: true });
      assert.equal(wakeable.some((event) => event.type === 'worker_cherry_pick_conflict' && event.worker === 'worker-2'), true);
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_skipped' && event.worker === 'worker-2' && event.metadata?.reason === 'unintegrated_changes'), true);
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_applied' && event.worker === 'worker-2'), false);
      const mailbox = await listMailboxMessages(team, 'leader-fixed', repo);
      assert.equal(mailbox.some((message) => /INTEGRATION CONFLICT:.*README.md.*Resolve the conflict/.test(message.body)), true);
      const report = await readFile(join(repo, '.omx', 'state', 'team', team, 'integration-report.md'), 'utf-8');
      assert.match(report, /cherry-pick.*README.md.*aborted/);
      assert.doesNotMatch(report, /auto-resolved/);
    } finally {
      for (const path of paths) await rm(path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('aborts a real text-conflicting cross-rebase and preserves the pre-rebase commit', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-rebase-race-bin-'));
    const previousPath = process.env.PATH;
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'rebase-text-1', 'omx-rebase-text-1-');
      worker2Path = await addWorktree(repo, 'rebase-text-2', 'omx-rebase-text-2-');
      await writeFile(join(worker1Path, 'README.md'), 'worker-one\n');
      execFileSync('git', ['add', 'README.md'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker one'], { cwd: worker1Path, stdio: 'ignore' });
      await configureWorkers('rebase-text', repo, [
        { path: worker1Path, branch: 'rebase-text-1' },
        { path: worker2Path, branch: 'rebase-text-2' },
      ]);
      await writeWorkerStatus('rebase-text', 'worker-2', { state: 'idle', updated_at: new Date().toISOString() }, repo);
      const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf-8' }).trim();
      const originalHeadPath = join(fakeBin, 'original-head');
      // Simulate a worker committing after integration checks but before rebase starts.
      await writeFile(join(fakeBin, 'git'), `#!/bin/bash
set -eu
if [[ "$PWD" -ef ${JSON.stringify(worker2Path)} && "\${1:-}" == "status" && "$(cat ${JSON.stringify(join(repo, 'README.md'))})" == "worker-one" && ! -f ${JSON.stringify(originalHeadPath)} ]]; then
  printf 'worker-two\\n' > README.md
  ${JSON.stringify(realGit)} add README.md
  ${JSON.stringify(realGit)} commit -m 'late worker commit' >/dev/null
  ${JSON.stringify(realGit)} rev-parse HEAD > ${JSON.stringify(originalHeadPath)}
fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      await monitorTeam('rebase-text', repo);
      const originalHead = (await readFile(originalHeadPath, 'utf-8')).trim();
      assert.equal(execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim(), originalHead);
      assert.equal(await readFile(join(worker2Path, 'README.md'), 'utf-8'), 'worker-two\n');
      assert.equal(await readFile(join(repo, 'README.md'), 'utf-8'), 'worker-one\n');
      assert.doesNotMatch(execFileSync(realGit, ['status'], { cwd: worker2Path, encoding: 'utf-8' }), /rebase in progress/);
      const snapshot = await readMonitorSnapshot('rebase-text', repo);
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.status, 'rebase_conflict');
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.conflict_commit, originalHead);
      assert.deepEqual(snapshot?.integrationByWorker?.['worker-2']?.conflict_files, ['README.md']);
      const wakeable = await readTeamEvents('rebase-text', repo, { wakeableOnly: true });
      assert.equal(wakeable.some((event) => event.type === 'worker_cross_rebase_conflict'), true);
      const mailbox = await listMailboxMessages('rebase-text', 'leader-fixed', repo);
      assert.equal(mailbox.some((message) => /REBASE CONFLICT:.*aborted.*README.md/.test(message.body)), true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
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
