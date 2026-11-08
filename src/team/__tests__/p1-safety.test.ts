import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, rename } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import * as S from '../state.js';
import { monitorTeam, shutdownTeam } from '../runtime.js';
import { scaleDown } from '../scaling.js';
import { archiveIgnoredCompletionEvidence, rollbackProvisionedWorktrees } from '../worktree.js';
import { readTeamEvents } from '../state/events.js';

process.env.OMX_RUNTIME_BRIDGE = '0';
process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
delete process.env.OMX_TEAM_STATE_ROOT;
delete process.env.OMX_TEAM_WORKER;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(count = 1) {
  const repo = await mkdtemp(join(realpathSync(tmpdir()), 'omx-team-audit-'));
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Audit');
  git(repo, 'config', 'user.email', 'audit@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, '.git/info/exclude'), '.omx/\n');
  await writeFile(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await S.initTeamState('audit', 'Audit fixture', 'executor', count, repo);
  const cfg = await S.readTeamConfig('audit', repo);
  assert.ok(cfg);
  cfg.leader_pane_id = '';
  cfg.worker_launch_mode = 'prompt';
  const wt = join(repo, '.omx/team/audit/worktrees/worker-1');
  git(repo, 'worktree', 'add', '-b', 'audit-worker', wt, base);
  Object.assign(cfg.workers[0], { worktree_repo_root: repo, worktree_path: wt,
    worktree_branch: 'audit-worker', worktree_detached: false, worktree_created: true });
  await S.saveTeamConfig(cfg, repo);
  return { repo, wt, base };
}

async function complete(repo: string, wt: string, worker = 'worker-1', file = 'worker.js') {
  execFileSync(process.execPath, ['--check', join(wt, file)], { stdio: 'pipe' });
  const command = `node --check ${file}`;
  const task = await S.createTask('audit', { subject: 'Code', description: 'Verified output', status: 'pending', requires_code_change: true }, repo);
  const claim = await S.claimTask('audit', task.id, worker, null, repo);
  assert.ok(claim.ok, JSON.stringify(claim));
  await mkdir(join(wt, '.omx/evidence'), { recursive: true });
  await writeFile(join(wt, '.omx/evidence/handoff.json'), JSON.stringify({ teamName: 'audit', taskId: task.id,
    claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
    verifiedHead: git(wt, 'rev-parse', 'HEAD'), summary: 'Verified code',
    verification: [{ command, result: 'passed', output: 'Syntax valid' }], unverified: [] }));
  const result = await S.transitionTaskStatus('audit', task.id, 'in_progress', 'completed', claim.claimToken, repo,
    { result: `Verification: PASS ${command}\nEVIDENCE_RECORDED: .omx/evidence/handoff.json` }, wt);
  assert.equal(result.ok, true, JSON.stringify(result));
  await S.writeWorkerStatus('audit', worker, { state: 'done', updated_at: new Date().toISOString() }, repo);
  return task;
}

async function addWorkerCommit(wt: string) {
  await writeFile(join(wt, 'worker.js'), 'export const answer = 42;\n');
  git(wt, 'add', 'worker.js'); git(wt, 'commit', '-m', 'worker output');
}

function beginCleanManualMerge(wt: string) {
  git(wt, 'checkout', '-b', 'manual-pending');
  git(wt, 'commit', '--allow-empty', '-m', 'manual empty merge source');
  const source = git(wt, 'rev-parse', 'HEAD');
  git(wt, 'checkout', '-');
  git(wt, 'merge', '--no-ff', '--no-commit', source);
  assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=all'), '');
  return resolve(wt, git(wt, 'rev-parse', '--git-path', 'MERGE_HEAD'));
}

async function twoVerifiedWorkers() {
  const result = await fixture(2);
  const { repo, wt, base } = result;
  const second = join(repo, '.omx/team/audit/worktrees/worker-2');
  git(repo, 'worktree', 'add', '-b', 'second-worker', second, base);
  const cfg = await S.readTeamConfig('audit', repo);
  assert.ok(cfg);
  Object.assign(cfg.workers[1], { worktree_repo_root: repo, worktree_path: second, worktree_branch: 'second-worker', worktree_created: true, worktree_detached: false });
  await S.saveTeamConfig(cfg, repo);
  await addWorkerCommit(wt); await complete(repo, wt);
  await writeFile(join(second, 'second.js'), 'export const second = 2;\n');
  git(second, 'add', 'second.js'); git(second, 'commit', '-m', 'second worker output');
  await complete(repo, second, 'worker-2', 'second.js');
  return { ...result, second };
}

test('monitor preserves the leader manual cherry-pick and staged resolution', async () => {
  const { repo, wt, base } = await fixture();
  try {
    git(repo, 'checkout', '-b', 'manual-source', base);
    await writeFile(join(repo, 'README.md'), 'manual branch\n');
    git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'manual source');
    const manual = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-');
    await writeFile(join(repo, 'README.md'), 'leader branch\n');
    git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'leader divergent');
    await addWorkerCommit(wt);
    await complete(repo, wt);
    assert.notEqual(spawnSync('git', ['cherry-pick', manual], { cwd: repo }).status, 0);
    await writeFile(join(repo, 'README.md'), 'valuable manual resolution\n');
    git(repo, 'add', 'README.md');
    assert.equal(existsSync(join(repo, '.git/CHERRY_PICK_HEAD')), true);
    const staged = git(repo, 'diff', '--cached');
    await assert.rejects(monitorTeam('audit', repo), /git_operation_in_progress/);
    assert.equal(existsSync(join(repo, '.git/CHERRY_PICK_HEAD')), true);
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'valuable manual resolution\n');
    assert.equal(git(repo, 'diff', '--cached'), staged);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

for (const action of ['monitor', 'shutdown']) {
  test(`${action} preserves a manual leader merge and staged changes`, async () => {
    const { repo, wt, base } = await fixture();
    try {
      git(repo, 'checkout', '-b', 'manual-source', base);
      await writeFile(join(repo, 'README.md'), 'manual merge\n');
      git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'manual source');
      const manual = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'checkout', '-');
      await addWorkerCommit(wt); await complete(repo, wt);
      git(repo, 'merge', '--no-commit', '--no-ff', manual);
      await writeFile(join(repo, 'README.md'), 'valuable staged merge edit\n');
      git(repo, 'add', 'README.md');
      const staged = git(repo, 'diff', '--cached');
      await assert.rejects(action === 'monitor' ? monitorTeam('audit', repo) : shutdownTeam('audit', repo), /git_operation_in_progress/);
      assert.equal(existsSync(join(repo, '.git/MERGE_HEAD')), true);
      assert.equal(git(repo, 'diff', '--cached'), staged);
      assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'valuable staged merge edit\n');
      assert.equal(existsSync(join(repo, '.omx/state/team/audit')), true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
}

for (const corrupt of ['json', 'shape', 'id', 'directory']) {
  test(`task ${corrupt} corruption blocks monitoring and non-force shutdown without deleting state`, async () => {
    const repo = await mkdtemp(join(realpathSync(tmpdir()), 'omx-team-corrupt-'));
    try {
      await S.initTeamState('audit', 'Audit corruption', 'executor', 1, repo);
      const phase = await S.readTeamPhase('audit', repo);
      const task = await S.createTask('audit', { subject: 'Unfinished', description: 'Must not disappear', status: 'pending' }, repo);
      const path = join(repo, '.omx/state/team/audit/tasks', `task-${task.id}.json`);
      const bytes = corrupt === 'json' ? '{"status":"pending",' : JSON.stringify(corrupt === 'id' ? { ...task, id: '999' } : { nope: true });
      if (corrupt === 'directory') { await rm(path); await mkdir(path); }
      else await writeFile(path, bytes);
      for (const read of [S.listTasks, S.listTasksSnapshot, monitorTeam, shutdownTeam]) {
        await assert.rejects(read('audit', repo), /team_task_read_failed/);
        assert.equal(existsSync(path), true);
        if (corrupt !== 'directory') assert.equal(await readFile(path, 'utf8'), bytes);
      }
      assert.deepEqual(await S.readTeamPhase('audit', repo), phase);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
}

for (const action of ['scale-down', 'shutdown']) {
  test(`${action} accepts ignored completion evidence after verified integration`, async () => {
    const { repo, wt } = await fixture(2);
    try {
      git(wt, 'checkout', '--detach');
      const cfg = await S.readTeamConfig('audit', repo);
      assert.ok(cfg);
      cfg.workers[0].worktree_detached = true;
      cfg.workers[0].worktree_branch = undefined;
      await S.saveTeamConfig(cfg, repo);
      await addWorkerCommit(wt); await complete(repo, wt);
      await monitorTeam('audit', repo);
      git(repo, 'merge-base', '--is-ancestor', git(wt, 'rev-parse', 'HEAD'), 'HEAD');
      assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=all'), '');
      const ignored = git(wt, 'status', '--porcelain', '--ignored');
      assert.match(ignored, /\.omx\//);
      const report = await readFile(join(wt, '.omx/evidence/handoff.json'), 'utf8');
      if (action === 'scale-down') {
        const result = await scaleDown('audit', repo, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { ...process.env, OMX_TEAM_SCALING_ENABLED: '1' });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal((await S.readTeamConfig('audit', repo))?.workers.length, 1);
      } else {
        await shutdownTeam('audit', repo);
        assert.equal(existsSync(join(repo, '.omx/state/team/audit')), false);
      }
      assert.equal(existsSync(wt), false);
      const archive = join(repo, '.git/omx-completion-evidence');
      const records = await readdir(archive);
      assert.ok((await Promise.all(records.map(file => readFile(join(archive, file), 'utf8')))).includes(report));
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
}

for (const action of ['scale-down', 'shutdown']) {
  for (const path of ['.omx/cache.bin', '.omx/evidence/personal.json']) {
    test(`${action} retains unrecognized ignored files at ${path}`, async () => {
      const { repo, wt } = await fixture(2);
      try {
        git(wt, 'checkout', '--detach');
        const cfg = await S.readTeamConfig('audit', repo);
        assert.ok(cfg);
        cfg.workers[0].worktree_detached = true;
        cfg.workers[0].worktree_branch = undefined;
        await S.saveTeamConfig(cfg, repo);
        await addWorkerCommit(wt); await complete(repo, wt);
        await monitorTeam('audit', repo);
        await writeFile(join(wt, path), 'personal data');
        if (action === 'scale-down') {
          const result = await scaleDown('audit', repo, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { ...process.env, OMX_TEAM_SCALING_ENABLED: '1' });
          assert.equal(result.ok, false);
        } else await assert.rejects(shutdownTeam('audit', repo), /shutdown_worktree_preservation_failed/);
        assert.equal(await readFile(join(wt, path), 'utf8'), 'personal data');
        assert.equal(existsSync(join(repo, '.omx/state/team/audit')), true);
      } finally { await rm(repo, { recursive: true, force: true }); }
    });
  }
}

test('evidence archiving preserves tracked, unignored and symlinked reports', { skip: process.platform === 'win32' }, async () => {
  const { repo, wt } = await fixture();
  const outside = await mkdtemp(join(realpathSync(tmpdir()), 'omx-evidence-outside-'));
  try {
    await addWorkerCommit(wt); await complete(repo, wt);
    const report = await readFile(join(wt, '.omx/evidence/handoff.json'), 'utf8');
    await writeFile(join(wt, '.omx/evidence/tracked.json'), report);
    git(wt, 'add', '-f', '.omx/evidence/tracked.json');
    await writeFile(join(outside, 'report.json'), report);
    await symlink(join(outside, 'report.json'), join(wt, '.omx/evidence/link.json'));
    await symlink(outside, join(wt, '.omx/evidence/linked-dir'));
    await writeFile(join(wt, '.omx/evidence/unignored.json'), report);
    await writeFile(join(repo, '.git/info/exclude'), '.omx/*\n!.omx/evidence/\n.omx/evidence/*\n!.omx/evidence/unignored.json\n');
    await archiveIgnoredCompletionEvidence(wt);
    assert.equal(existsSync(join(wt, '.omx/evidence/handoff.json')), false);
    for (const path of ['tracked.json', 'link.json', 'linked-dir/report.json', 'unignored.json']) {
      assert.equal(await readFile(join(wt, '.omx/evidence', path), 'utf8'), report);
    }
    assert.equal(await readFile(join(outside, 'report.json'), 'utf8'), report);
    assert.match(git(wt, 'diff', '--cached', '--name-only'), /tracked\.json/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

for (const mode of ['missing', 'symlink']) {
  test(`a ${mode} task directory blocks false completion and cleanup`, async () => {
    const repo = await mkdtemp(join(realpathSync(tmpdir()), 'omx-task-dir-regression-'));
    try {
      await S.initTeamState('audit', 'Task root corruption', 'executor', 1, repo);
      const task = await S.createTask('audit', { subject: 'Pending', description: 'Not finished', status: 'pending' }, repo);
      const teamRoot = join(repo, '.omx/state/team/audit');
      await rename(join(teamRoot, 'tasks'), join(teamRoot, 'tasks.saved'));
        if (mode === 'symlink') await symlink(join(teamRoot, 'tasks.saved'), join(teamRoot, 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');
      const saved = join(teamRoot, 'tasks.saved', `task-${task.id}.json`);
      for (const read of [S.listTasks, S.listTasksSnapshot, monitorTeam, shutdownTeam]) {
        await assert.rejects(read('audit', repo), /team_task_read_failed/);
        assert.equal(existsSync(saved), true);
      }
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
}

test('task enumeration distinguishes an absent Team from an empty Team', async () => {
  const repo = await mkdtemp(join(realpathSync(tmpdir()), 'omx-empty-team-'));
  try {
    assert.deepEqual(await S.listTasks('missing', repo), []);
    await S.initTeamState('audit', 'Empty team', 'executor', 1, repo);
    assert.deepEqual(await S.listTasks('audit', repo), []);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a worker manual Git operation blocks only that worker and permits a safe retry', async () => {
  const { repo, second } = await twoVerifiedWorkers();
  try {
    const marker = beginCleanManualMerge(second);
    await monitorTeam('audit', repo);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(join(repo, 'worker.js')), true);
    assert.equal(existsSync(join(repo, 'second.js')), false);
    const snapshot = await S.readMonitorSnapshot('audit', repo);
    assert.ok(snapshot?.integrationByWorker?.['worker-1']?.delivery_leader_commit);
    assert.equal(snapshot?.integrationByWorker?.['worker-2']?.status, 'rebase_conflict');
    git(second, 'merge', '--abort');
    await monitorTeam('audit', repo);
    assert.equal(await readFile(join(repo, 'second.js'), 'utf8'), 'export const second = 2;\n');
    assert.notEqual((await S.readMonitorSnapshot('audit', repo))?.integrationByWorker?.['worker-2']?.status, 'cherry_pick_conflict');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

for (const target of ['worker', 'leader', 'phase-write']) {
  test(`a late ${target} Git operation preserves prior integration receipts`, async () => {
    const { repo, second } = await twoVerifiedWorkers();
    const original = fsPromises.appendFile;
    const originalOpen = fsPromises.open;
    let marker = '';
    try {
      fsPromises.appendFile = async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (marker || !String(args[0]).endsWith(join('events', 'events.ndjson'))) return;
        const event = JSON.parse(String(args[1]));
        if (target !== 'leader' && event.type === 'worker_cherry_pick_applied' && event.worker === 'worker-2') marker = beginCleanManualMerge(second);
        if (target === 'leader' && event.type === 'worker_merge_applied' && event.worker === 'worker-1') marker = beginCleanManualMerge(repo);
      };
      S.setWriteAtomicOpenForTests(async (...args: Parameters<typeof originalOpen>) => {
        if (target === 'phase-write' && marker && String(args[0]).includes('phase.json')) throw new Error('phase_write_io');
        return originalOpen(...args);
      });
      syncBuiltinESMExports();
      if (target === 'leader') await assert.rejects(monitorTeam('audit', repo), /git_operation_in_progress/);
      else if (target === 'phase-write') await assert.rejects(monitorTeam('audit', repo), /phase_write_io/);
      else await monitorTeam('audit', repo);
      fsPromises.appendFile = original; syncBuiltinESMExports();
      S.resetWriteAtomicOpenForTests();
      assert.ok(marker && existsSync(marker));
      const snapshot = await S.readMonitorSnapshot('audit', repo);
      const worker = target === 'leader' ? 'worker-1' : 'worker-2';
      assert.ok(snapshot?.integrationByWorker?.[worker]?.delivery_leader_commit);
      git(target === 'leader' ? repo : second, 'merge', '--abort');
      await monitorTeam('audit', repo);
      const events = await readTeamEvents('audit', repo);
      assert.equal(events.filter(e => e.worker === 'worker-1' && (e.type as string) === 'worker_merge_applied').length, 1);
      assert.equal(events.filter(e => e.worker === 'worker-2' && e.type === 'worker_cherry_pick_applied').length, 1);
      assert.notEqual((await S.readMonitorSnapshot('audit', repo))?.integrationByWorker?.['worker-2']?.status, 'cherry_pick_conflict');
    } finally {
      fsPromises.appendFile = original; syncBuiltinESMExports();
      S.resetWriteAtomicOpenForTests();
      await rm(repo, { recursive: true, force: true });
    }
  });
}

for (const target of ['worker', 'leader']) {
  test(`forced shutdown stops its worker and retains a ${target} manual Git operation`, async () => {
    const { repo, wt } = await fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await addWorkerCommit(wt); await complete(repo, wt);
      const cfg = await S.readTeamConfig('audit', repo);
      assert.ok(cfg); cfg.workers[0].pid = child.pid;
      await S.saveTeamConfig(cfg, repo);
      const marker = beginCleanManualMerge(target === 'worker' ? wt : repo);
      await assert.rejects(shutdownTeam('audit', repo, { force: true }), /git_operation_in_progress/);
      assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
      assert.equal(existsSync(marker), true);
      assert.equal(existsSync(join(wt, 'worker.js')), true);
      const after = await S.readTeamConfig('audit', repo);
      assert.ok(after); assert.equal(after.workers[0].pid, undefined);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      await rm(repo, { recursive: true, force: true });
    }
  });
}

for (const boundary of ['task-read', 'integration']) {
  test(`a completion at ${boundary} keeps its marker and emits one event`, async () => {
    const { repo } = await twoVerifiedWorkers();
    const originalAppend = fsPromises.appendFile;
    const originalReaddir = fsPromises.readdir;
    let completed = false;
    try {
      const cfg = await S.readTeamConfig('audit', repo);
      assert.ok(cfg); cfg.workers[0].pid = process.pid; await S.saveTeamConfig(cfg, repo);
      const task = await S.createTask('audit', { subject: 'Research', description: 'Concurrent completion', status: 'pending', owner: 'worker-2' }, repo);
      const previous = await S.readMonitorSnapshot('audit', repo);
      assert.ok(previous); previous.taskStatusById[task.id] = 'pending'; await S.writeMonitorSnapshot('audit', previous, repo);
      const finish = async () => {
        completed = true;
        const claim = await S.claimTask('audit', task.id, 'worker-2', null, repo);
        assert.ok(claim.ok);
        assert.ok((await S.transitionTaskStatus('audit', task.id, 'in_progress', 'completed', claim.claimToken, repo, { result: 'Research completed' })).ok);
      };
      fsPromises.appendFile = async (...args: Parameters<typeof originalAppend>) => {
        await originalAppend(...args);
        if (boundary === 'integration' && !completed && String(args[1]).includes('"type":"worker_merge_applied"')) await finish();
      };
      fsPromises.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
        if (boundary === 'task-read' && !completed && String(args[0]) === join(repo, '.omx/state/team/audit/tasks')) await finish();
        return originalReaddir(...args);
      }) as typeof fsPromises.readdir;
      syncBuiltinESMExports();
      await monitorTeam('audit', repo);
      fsPromises.appendFile = originalAppend; fsPromises.readdir = originalReaddir; syncBuiltinESMExports();
      assert.equal(completed, true);
      assert.equal((await S.readMonitorSnapshot('audit', repo))?.completedEventTaskIds[task.id], true);
      await monitorTeam('audit', repo);
      const events = await readTeamEvents('audit', repo);
      assert.equal(events.filter(event => event.type === 'task_completed' && event.task_id === task.id).length, 1);
    } finally {
      fsPromises.appendFile = originalAppend; fsPromises.readdir = originalReaddir; syncBuiltinESMExports();
      await rm(repo, { recursive: true, force: true });
    }
  });
}


for (const boundary of ['git-operation', 'task-corruption']) {
  test(`shutdown preserves state when ${boundary} appears after preflight`, async () => {
    const { repo, wt } = await fixture();
    const originalRename = fsPromises.rename;
    const originalLink = fsPromises.link;
    let injected = false;
    let marker = '';
    try {
      git(wt, 'checkout', '--detach');
      const cfg = await S.readTeamConfig('audit', repo);
      assert.ok(cfg); cfg.workers[0].worktree_detached = true; cfg.workers[0].worktree_branch = undefined;
      await S.saveTeamConfig(cfg, repo);
      await addWorkerCommit(wt); const task = await complete(repo, wt); await monitorTeam('audit', repo);
      const path = join(repo, '.omx/state/team/audit/tasks', `task-${task.id}.json`);
      fsPromises.rename = async (...args: Parameters<typeof originalRename>) => {
        await originalRename(...args);
        if (boundary === 'git-operation' && !injected && String(args[0]) === join(wt, '.omx/evidence/handoff.json')) {
          injected = true; marker = beginCleanManualMerge(wt);
        }
      };
      fsPromises.link = async (...args: Parameters<typeof originalLink>) => {
        await originalLink(...args);
        if (boundary === 'task-corruption' && !injected && String(args[1]) === join(wt, '.omx/diff.md')) {
          injected = true; await writeFile(path, '{"broken":');
        }
      };
      syncBuiltinESMExports();
      await assert.rejects(shutdownTeam('audit', repo), /git_operation_in_progress|team_task_read_failed/);
      assert.equal(injected, true);
      assert.equal(existsSync(wt), true);
      assert.equal(existsSync(path), true);
      if (boundary === 'git-operation') assert.equal(existsSync(marker), true);
      else assert.equal(await readFile(path, 'utf8'), '{"broken":');
    } finally {
      fsPromises.rename = originalRename; fsPromises.link = originalLink; syncBuiltinESMExports();
      await rm(repo, { recursive: true, force: true });
    }
  });
}

test('guarded rollback rechecks Git operations after archiving evidence', async () => {
  const { repo, wt } = await fixture();
  const original = fsPromises.rename;
  let marker = '';
  try {
    await addWorkerCommit(wt); await complete(repo, wt);
    fsPromises.rename = async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (!marker && String(args[0]) === join(wt, '.omx/evidence/handoff.json')) marker = beginCleanManualMerge(wt);
    };
    syncBuiltinESMExports();
    await assert.rejects(rollbackProvisionedWorktrees([{
      enabled: true, repoRoot: repo, worktreePath: wt, branchName: 'audit-worker',
      detached: false, created: true, reused: false, createdBranch: false,
    }], { force: false }), /git_operation_in_progress/);
    assert.ok(marker && existsSync(marker));
    assert.equal(await readFile(join(wt, 'worker.js'), 'utf8'), 'export const answer = 42;\n');
  } finally {
    fsPromises.rename = original; syncBuiltinESMExports();
    await rm(repo, { recursive: true, force: true });
  }
});

for (const failure of ['corrupt', 'missing']) {
  test(`leader stop preserves actionable work when task state is ${failure}`, async () => {
    const { repo } = await fixture();
    try {
      const task = await S.createTask('audit', { subject: 'Unfinished', description: 'Still pending', status: 'pending' }, repo);
      await S.writeMonitorSnapshot('audit', {
        taskStatusById: { [task.id]: 'pending' }, workerAliveByName: { 'worker-1': true },
        workerStateByName: { 'worker-1': 'idle' }, workerTurnCountByName: {}, workerTaskIdByName: {},
        mailboxNotifiedByMessageId: {}, completedEventTaskIds: {},
      }, repo);
      if (failure === 'corrupt') await writeFile(join(repo, '.omx/state/team/audit/tasks', `task-${task.id}.json`), '{"broken":');
      else await rename(join(repo, '.omx/state/team/audit/tasks'), join(repo, '.omx/state/team/audit/tasks.saved'));
      const state = await S.markTeamLeaderStopObserved('audit', repo, 'leader');
      assert.equal(state.leader_session_active, false);
      assert.equal(state.work_remaining, true);
      assert.equal(state.leader_decision_state, 'still_actionable');
      assert.equal(state.leader_attention_pending, true);
      assert.ok(state.attention_reasons.includes('task_state_unavailable'));
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
}
