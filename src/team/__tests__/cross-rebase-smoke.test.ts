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
    const taskId = await completeIntegrationTask(teamName, repo, worker.name, worker.worktree_path!);
    assert.deepEqual(worker.assigned_tasks, [taskId]);
  }
}

async function completeIntegrationTask(teamName: string, repo: string, workerName: string, workerCwd: string, taskId?: string): Promise<string> {
  const task = taskId ? await readTask(teamName, taskId, repo) : await createTask(teamName, {
    subject: `Verified output from ${workerName}`, description: 'Ready for integration',
    status: 'pending', owner: workerName, requires_code_change: true,
  }, repo);
  assert.ok(task);
  const claim = await claimTask(teamName, task.id, workerName, null, repo);
  assert.ok(claim.ok);
  await mkdir(join(workerCwd, '.omx/evidence'), { recursive: true });
  await writeFile(join(workerCwd, '.omx/evidence/handoff.json'), JSON.stringify({
    teamName, taskId: task.id, claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
    verifiedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workerCwd, encoding: 'utf8' }).trim(),
    summary: 'Verified worker output', verification: [{ command: 'npm test', result: 'passed', output: 'Tests passed' }], unverified: [],
  }));
  const completed = await transitionTaskStatus(teamName, task.id, 'in_progress', 'completed', claim.claimToken, repo, {
    result: 'Verification: PASS `npm test` for worker output.\nEVIDENCE_RECORDED: .omx/evidence/handoff.json',
  }, workerCwd);
  assert.ok(completed.ok, JSON.stringify(completed));
  await writeWorkerStatus(teamName, workerName, { state: 'done', updated_at: new Date().toISOString() }, repo);
  return task.id;
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
        if (index === 1) {
          assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf-8' }).trim(), heads[index]);
        } else {
          execFileSync('git', ['merge-base', '--is-ancestor', heads[index], 'HEAD'], { cwd: path, stdio: 'ignore' });
        }
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
      const verifiedHead = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();
      const originalHeadPath = join(fakeBin, 'original-head');
      // Race after the final verified-HEAD check: inject only when Git rebase is invoked.
      await writeFile(join(fakeBin, 'git'), `#!/bin/bash
set -eu
if [[ "$PWD" -ef ${JSON.stringify(worker2Path)} && "\${1:-}" == "rebase" && "\${2:-}" != "--abort" && "$#" == "2" && "$(cat ${JSON.stringify(join(repo, 'README.md'))})" == "worker-one" && ! -f ${JSON.stringify(originalHeadPath)} ]]; then
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
      assert.notEqual(originalHead, verifiedHead);
      assert.equal(execFileSync(realGit, ['rev-parse', `${originalHead}^`], { cwd: worker2Path, encoding: 'utf-8' }).trim(), verifiedHead);
      assert.equal(execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim(), originalHead);
      assert.equal(await readFile(join(worker2Path, 'README.md'), 'utf-8'), 'worker-two\n');
      assert.equal(await readFile(join(repo, 'README.md'), 'utf-8'), 'worker-one\n');
      assert.doesNotMatch(execFileSync(realGit, ['status'], { cwd: worker2Path, encoding: 'utf-8' }), /rebase in progress/);
      const snapshot = await readMonitorSnapshot('rebase-text', repo);
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.status, 'rebase_conflict');
      // Diagnostic metadata records the last observed pre-call HEAD, not the later injected commit.
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.conflict_commit, verifiedHead);
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

  it('rebases a previously cherry-picked unchanged worker when another worker advances the next cycle', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-cached-rebase-bin-'));
    const previousPath = process.env.PATH;
    const team = 'cached-cherry-pick';
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'cached-worker-1', 'omx-cached-worker-1-');
      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker diverges'], { cwd: worker1Path, stdio: 'ignore' });
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker1Path, encoding: 'utf8' }).trim();
      await writeFile(join(repo, 'leader.txt'), 'leader divergence\n');
      execFileSync('git', ['add', 'leader.txt'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'leader diverges'], { cwd: repo, stdio: 'ignore' });
      worker2Path = await addWorktree(repo, 'cached-worker-2', 'omx-cached-worker-2-');
      await configureWorkers(team, repo, [
        { path: worker1Path, branch: 'cached-worker-1' },
        { path: worker2Path, branch: 'cached-worker-2' },
      ]);
      const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
      const nextTask = await createTask(team, {
        subject: 'Second cycle worker change', description: 'Publish worker 2 output next cycle',
        status: 'pending', owner: 'worker-2', requires_code_change: true,
      }, repo);
      const statusPath = join(repo, '.omx', 'state', 'team', team, 'workers', 'worker-1', 'status.json');
      // Publication starts done; a real successful pick races with the worker resuming work before Phase C.
      await writeFile(join(fakeBin, 'git'), `#!/bin/bash
set -eu
if [[ "$PWD" -ef ${JSON.stringify(repo)} && "\${1:-}" == "cherry-pick" && "\${2:-}" == "--allow-empty" ]]; then
  ${JSON.stringify(realGit)} "$@"
  printf '%s' '${JSON.stringify({ state: 'working', updated_at: new Date().toISOString() })}' > ${JSON.stringify(statusPath)}
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      await monitorTeam(team, repo);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      const firstSnapshot = await readMonitorSnapshot(team, repo);
      assert.equal(firstSnapshot?.integrationByWorker?.['worker-1']?.last_integrated_head, sourceHead);
      assert.equal(execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: worker1Path, encoding: 'utf8' }).trim(), sourceHead);
      const firstLeaderHead = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.notEqual(firstLeaderHead, sourceHead);
      assert.notEqual(execFileSync(realGit, ['merge-base', sourceHead, firstLeaderHead], { cwd: repo, encoding: 'utf8' }).trim(), sourceHead);
      assert.equal(await readFile(join(repo, 'w1.txt'), 'utf8'), 'from worker 1\n');
      const firstEvents = await readTeamEvents(team, repo, { wakeableOnly: false });
      assert.equal(firstEvents.some((event) => event.type === 'worker_cherry_pick_applied' && event.worker === 'worker-1'), true);
      assert.equal(firstEvents.some((event) => event.type === 'worker_cross_rebase_skipped' && event.worker === 'worker-1' && event.metadata?.worker_state === 'working'), true);

      await writeWorkerStatus(team, 'worker-1', { state: 'idle', updated_at: new Date().toISOString() }, repo);
      await writeFile(join(worker2Path, 'w2.txt'), 'from worker 2\n');
      execFileSync(realGit, ['add', 'w2.txt'], { cwd: worker2Path, stdio: 'ignore' });
      execFileSync(realGit, ['commit', '-m', 'second cycle worker change'], { cwd: worker2Path, stdio: 'ignore' });
      await completeIntegrationTask(team, repo, 'worker-2', worker2Path, nextTask.id);
      await monitorTeam(team, repo);

      const leaderHead = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.notEqual(leaderHead, firstLeaderHead);
      assert.equal(await readFile(join(worker1Path, 'w2.txt'), 'utf8'), 'from worker 2\n');
      assert.equal(await readFile(join(worker1Path, 'w1.txt'), 'utf8'), 'from worker 1\n');
      execFileSync(realGit, ['merge-base', '--is-ancestor', leaderHead, 'HEAD'], { cwd: worker1Path, stdio: 'ignore' });
      const snapshot = await readMonitorSnapshot(team, repo);
      assert.equal(snapshot?.integrationByWorker?.['worker-1']?.last_rebased_leader_head, leaderHead);
      const events = await readTeamEvents(team, repo, { wakeableOnly: false });
      assert.equal(events.filter((event) => event.type === 'worker_cherry_pick_applied' && event.worker === 'worker-1').length, 1);
      assert.equal(events.some((event) => event.type === 'worker_cross_rebase_applied' && event.worker === 'worker-1'), true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
      if (worker1Path) await rm(worker1Path, { recursive: true, force: true });
      if (worker2Path) await rm(worker2Path, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not treat a failed Git commit-range query as proof of integration', async () => {
    const repo = await initRepo();
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-range-failure-bin-'));
    const previousPath = process.env.PATH;
    const paths: string[] = [];
    const team = 'range-query-failure';
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
      await rm(fakeBin, { recursive: true, force: true });
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
