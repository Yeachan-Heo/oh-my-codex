import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorTeam } from '../runtime.js';
import {
  initTeamState, createTask, readTeamConfig, saveTeamConfig, writeAtomic,
  readMonitorSnapshot, writeMonitorSnapshot, writeWorkerStatus,
} from '../state.js';

const team = 'delivery-gate';
describe('monitorTeam code delivery success gate', () => {
  let repo: string;
  let worker: string;
  let previousRoot: string | undefined;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  async function commit(cwd: string, file: string) {
    await writeFile(join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-m', file);
  }
  beforeEach(async () => {
    previousRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    repo = await mkdtemp(join(tmpdir(), 'omx-runtime-delivery-'));
    worker = await mkdtemp(join(tmpdir(), 'omx-runtime-delivery-worker-'));
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await commit(repo, 'README.md');
    git(repo, 'worktree', 'add', '-b', 'worker-delivery', worker, 'HEAD');
    await initTeamState(team, 'code delivery', 'executor', 1, repo);
    const config = (await readTeamConfig(team, repo))!;
    config.workers[0] = { ...config.workers[0], assigned_tasks: ['1'], worktree_path: worker, worktree_repo_root: repo };
    await saveTeamConfig(config, repo);
    const task = await createTask(team, {
      subject: 'delivered work', description: 'work', status: 'completed', owner: 'worker-1',
      // No requires_code_change flag: existing/legacy tasks still have delivery debt.
    }, repo);
    await writeAtomic(join(repo, '.omx/state/team', team, 'tasks', `task-${task.id}.json`), JSON.stringify({
      ...task, result: 'Verification:\n- PASS build: `npm run build`\n- PASS tests: `node --test tests.js`',
    }));
    await writeFile(join(repo, '.omx/state/team-state.json'), JSON.stringify({ active: true, current_phase: 'team-exec', team_name: team }));
  });
  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
    else process.env.OMX_TEAM_STATE_ROOT = previousRoot;
    await rm(worker, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });
  async function rootState() {
    return JSON.parse(await readFile(join(repo, '.omx/state/team-state.json'), 'utf8'));
  }

  it('keeps pending delivery in verify on read-only monitor without mutating state', async () => {
    await commit(worker, 'feature.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const snapshot = await monitorTeam(team, repo, { readOnly: true });
    assert.equal(snapshot?.phase, 'team-verify');
    assert.equal((await rootState()).active, true);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(await readMonitorSnapshot(team, repo), null);
    assert.equal(git(worker, 'rev-parse', 'HEAD') === head, false);
  });

  it('completes after successful integration and on subsequent contained read-only delivery', async () => {
    await commit(worker, 'feature.txt');
    const snapshot = await monitorTeam(team, repo);
    assert.equal(snapshot?.phase, 'complete');
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
    assert.equal((await rootState()).active, false);
    assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'complete');
  });

  it('accepts recorded cherry-pick delivery even when source HEAD is not an ancestor', async () => {
    await commit(worker, 'feature.txt');
    const workerHead = git(worker, 'rev-parse', 'HEAD');
    await commit(repo, 'leader.txt');
    // A working status prevents the unrelated idle cross-rebase path.
    await writeWorkerStatus(team, 'worker-1', { state: 'working', updated_at: new Date().toISOString() }, repo);
    assert.equal((await monitorTeam(team, repo))?.phase, 'complete');
    const delivery = (await readMonitorSnapshot(team, repo))?.integrationByWorker?.['worker-1'];
    assert.equal(delivery?.last_integrated_head, workerHead);
    assert.throws(() => git(repo, 'merge-base', '--is-ancestor', workerHead, 'HEAD'));
    assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'complete');
  });

  it('invalidates rewritten-away cherry-pick delivery even after an intervening nonterminal poll', async () => {
    await commit(worker, 'feature.txt');
    await commit(repo, 'leader.txt');
    const beforeDelivery = git(repo, 'rev-parse', 'HEAD');
    const taskPath = join(repo, '.omx/state/team', team, 'tasks/task-1.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8'));
    await writeAtomic(taskPath, JSON.stringify({ ...task, status: 'in_progress' }));
    await writeWorkerStatus(team, 'worker-1', { state: 'working', updated_at: new Date().toISOString() }, repo);
    await monitorTeam(team, repo);
    const proof = (await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'].delivery_leader_commit;
    assert.equal(proof, git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'reset', '--hard', beforeDelivery);
    // Read-only must distrust the old receipt even when every task is terminal.
    await writeAtomic(taskPath, JSON.stringify(task));
    assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'team-verify');
    assert.equal((await rootState()).active, true);
    // Mutating poll before completion must either restore delivery or leave honest debt.
    await writeAtomic(taskPath, JSON.stringify({ ...task, status: 'in_progress' }));
    await monitorTeam(team, repo);
    await writeAtomic(taskPath, JSON.stringify(task));
    const readOnly = await monitorTeam(team, repo, { readOnly: true });
    if (readOnly?.phase === 'complete') assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
    assert.equal((await monitorTeam(team, repo))?.phase, 'complete');
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
  });

  it('vetoes terminal success on cross-rebase index.lock failure and retries on a quiet second poll', async () => {
    await commit(worker, 'feature.txt');
    await commit(repo, 'leader.txt');
    await writeWorkerStatus(team, 'worker-1', { state: 'done', updated_at: new Date().toISOString() }, repo);
    const lock = git(worker, 'rev-parse', '--git-path', 'index.lock');
    await writeFile(lock, 'held by regression test');
    const first = await monitorTeam(team, repo);
    assert.equal(first?.phase, 'team-fix');
    const failed = (await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'];
    assert.equal(failed.status, 'rebase_conflict');
    assert.ok(failed.pending_rebase_leader_head);
    assert.match(failed.rebase_error!, /index.lock/);
    assert.equal((await rootState()).active, true);
    assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'team-fix');
    const leaderHead = git(repo, 'rev-parse', 'HEAD');
    await rm(lock);
    assert.equal((await monitorTeam(team, repo))?.phase, 'complete');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), leaderHead, 'retry does not require fresh leader advancement');
    const resolved = (await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'];
    assert.equal(resolved.pending_rebase_leader_head, undefined);
    assert.equal(resolved.rebase_error, undefined);
    assert.equal(resolved.last_rebased_leader_head, leaderHead);
    assert.equal((await rootState()).active, false);
  });

  it('allows genuinely no-change research worktrees to complete', async () => {
    assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'complete');
  });

  it('preserves a diverged merge-commit integration failure through rebase and never seals root success', async () => {
    await commit(worker, 'feature.txt');
    git(worker, 'checkout', '-b', 'worker-side');
    await commit(worker, 'side.txt');
    git(worker, 'checkout', 'worker-delivery');
    await commit(worker, 'other.txt');
    git(worker, 'merge', '--no-ff', '-m', 'worker merge commit', 'worker-side');
    await commit(repo, 'leader.txt');
    await writeWorkerStatus(team, 'worker-1', { state: 'done', updated_at: new Date().toISOString() }, repo);
    const snapshot = await monitorTeam(team, repo);
    assert.equal(snapshot?.phase, 'team-fix');
    const persisted = (await readMonitorSnapshot(team, repo))!;
    assert.equal(persisted.integrationByWorker?.['worker-1']?.status, 'cherry_pick_conflict');
    assert.equal((await rootState()).active, true);
    const phasePath = join(repo, '.omx/state/team', team, 'phase.json');
    const beforePhase = await readFile(phasePath, 'utf8');
    const beforeSnapshot = JSON.stringify(persisted);
    assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'team-fix');
    assert.equal(await readFile(phasePath, 'utf8'), beforePhase);
    assert.equal(JSON.stringify(await readMonitorSnapshot(team, repo)), beforeSnapshot);
    assert.equal((await rootState()).active, true);
  });

  it('persisted integration_failed vetoes read-only success even when worker head is contained', async () => {
    await monitorTeam(team, repo);
    const persisted = (await readMonitorSnapshot(team, repo))!;
    persisted.integrationByWorker!['worker-1'].status = 'integration_failed';
    await writeMonitorSnapshot(team, persisted, repo);
    const rootPath = join(repo, '.omx/state/team-state.json');
    await writeFile(rootPath, JSON.stringify({ active: true, current_phase: 'team-exec', team_name: team }));
    const result = await monitorTeam(team, repo, { readOnly: true });
    assert.equal(result?.phase, 'team-fix');
    assert.equal((await rootState()).active, true);
    assert.equal((await readMonitorSnapshot(team, repo))?.integrationByWorker?.['worker-1']?.status, 'integration_failed');
  });
});
