import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorTeam } from '../runtime.js';
import {
  initTeamState, createTask, readTeamConfig, saveTeamConfig, claimTask, transitionTaskStatus,
  readMonitorSnapshot, writeMonitorSnapshot, writeWorkerStatus, updateTask, readTask,
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
    await writeFile(join(repo, '.git/info/exclude'), '.omx/\n');
    await commit(repo, 'README.md');
    git(repo, 'worktree', 'add', '-b', 'worker-delivery', worker, 'HEAD');
    await initTeamState(team, 'code delivery', 'executor', 1, repo);
    const config = (await readTeamConfig(team, repo))!;
    config.workers[0] = { ...config.workers[0], assigned_tasks: ['1'], working_dir: worker, worktree_path: worker, worktree_repo_root: repo };
    await saveTeamConfig(config, repo);
    await createTask(team, {
      subject: 'delivered work', description: 'work', status: 'pending', owner: 'worker-1',
    }, repo);
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

  async function completeTask(taskId = '1', requiresCodeChange = true) {
    await updateTask(team, taskId, { requires_code_change: requiresCodeChange }, repo);
    const claim = await claimTask(team, taskId, 'worker-1', null, repo);
    assert.ok(claim.ok, JSON.stringify(claim));
    assert.equal(git(worker, 'status', '--porcelain', '--untracked-files=all'), '');
    let result = 'Verification: PASS `git status --porcelain --untracked-files=all` for no-change research.';
    if (requiresCodeChange) {
      const verifiedHead = git(worker, 'rev-parse', 'HEAD');
      await mkdir(join(worker, '.omx/evidence'), { recursive: true });
      const evidencePath = `.omx/evidence/task-${taskId}.json`;
      await writeFile(join(worker, evidencePath), JSON.stringify({
        teamName: team, taskId, claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        verifiedHead, summary: 'Verified committed worker output',
        verification: [{ command: 'git status --porcelain --untracked-files=all', result: 'passed', output: 'Clean worktree' }],
        unverified: [],
      }));
      result = `Verification: PASS \`git status --porcelain --untracked-files=all\` for committed worker output.\nEVIDENCE_RECORDED: ${evidencePath}`;
    }
    const completed = await transitionTaskStatus(team, taskId, 'in_progress', 'completed', claim.claimToken, repo, { result });
    assert.ok(completed.ok, JSON.stringify(completed));
    await writeWorkerStatus(team, 'worker-1', { state: 'done', updated_at: new Date().toISOString() }, repo);
  }

  it('keeps unverified pending delivery nonterminal on read-only monitor without mutating state', async () => {
    await commit(worker, 'feature.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const snapshot = await monitorTeam(team, repo, { readOnly: true });
    assert.equal(snapshot?.phase, 'team-exec');
    assert.equal((await readTask(team, '1', repo))?.status, 'pending');
    assert.equal((await rootState()).active, true);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(await readMonitorSnapshot(team, repo), null);
    assert.equal(git(worker, 'rev-parse', 'HEAD') === head, false);
  });

  it('completes after successful integration and on subsequent contained read-only delivery', async () => {
    await commit(worker, 'feature.txt');
    await completeTask();
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
    await completeTask();
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
    await completeTask();
    const sentinel = await createTask(team, {
      subject: 'final delivery verification', description: 'Keep the team active during the history rewrite', status: 'pending',
    }, repo);
    await monitorTeam(team, repo);
    assert.equal((await readTask(team, sentinel.id, repo))?.owner, undefined);
    const proof = (await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'].delivery_leader_commit;
    assert.equal(proof, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
    assert.equal((await rootState()).active, true);
    git(repo, 'reset', '--hard', beforeDelivery);
    // The unowned sentinel keeps the team nonterminal without blocking worker handoff.
    assert.notEqual((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'complete');
    assert.equal((await rootState()).active, true);
    await assert.rejects(readFile(join(repo, 'feature.txt')), { code: 'ENOENT' });
    // An intervening poll must restore delivery or leave honest debt, never reuse the lost receipt.
    assert.notEqual((await monitorTeam(team, repo))?.phase, 'complete');
    assert.equal((await rootState()).active, true);
    // Verify the current source again if cross-rebase changed it during the first delivery.
    await completeTask(sentinel.id);
    const readOnly = await monitorTeam(team, repo, { readOnly: true });
    if (readOnly?.phase === 'complete') assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
    assert.equal((await monitorTeam(team, repo))?.phase, 'complete');
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
  });

  it('vetoes terminal success on cross-rebase index.lock failure and retries on a quiet second poll', async () => {
    await commit(worker, 'feature.txt');
    await commit(repo, 'leader.txt');
    await completeTask();
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
    assert.equal(resolved.delivery_leader_commit, leaderHead);
    assert.equal((await rootState()).active, false);
  });

  for (const unfinishedRebase of [false, true]) {
    it(`redelivers lost pending-rebase receipts on a quiet poll${unfinishedRebase ? ' after restoring the original source' : ''}`, async () => {
      await commit(worker, 'feature.txt');
      const sourceHead = git(worker, 'rev-parse', 'HEAD');
      await commit(repo, 'leader.txt');
      const beforeDelivery = git(repo, 'rev-parse', 'HEAD');
      await completeTask();
      const lock = git(worker, 'rev-parse', '--git-path', 'index.lock');
      await writeFile(lock, 'held by regression test');
      assert.equal((await monitorTeam(team, repo))?.phase, 'team-fix');
      const failed = (await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'];
      assert.equal(failed.last_integrated_head, sourceHead);
      assert.ok(failed.pending_rebase_leader_head);
      assert.match(failed.rebase_error!, /index.lock/);
      await rm(lock);
      if (unfinishedRebase) {
        // Leave real rebase metadata and an intermediate HEAD, as after a failed abort.
        assert.throws(() => git(worker, 'rebase', '--reapply-cherry-picks', '--empty=keep', '--exec', 'false', failed.pending_rebase_leader_head!));
        assert.notEqual(git(worker, 'rev-parse', 'HEAD'), sourceHead);
      }
      git(repo, 'reset', '--hard', beforeDelivery);
      await assert.rejects(readFile(join(repo, 'feature.txt')), { code: 'ENOENT' });
      assert.equal((await monitorTeam(team, repo, { readOnly: true }))?.phase, 'team-fix');
      assert.equal((await monitorTeam(team, repo))?.phase, 'complete');
      assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
      const resolved = (await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'];
      assert.equal(resolved.pending_rebase_leader_head, undefined);
      assert.equal(resolved.rebase_error, undefined);
      assert.equal(resolved.last_integrated_head, sourceHead);
      assert.equal(resolved.delivery_leader_commit, git(repo, 'rev-parse', 'HEAD'));
      assert.equal(git(worker, 'status', '--porcelain'), '');
      assert.equal((await rootState()).active, false);
    });
  }

  it('keeps lost-receipt pending state sticky while the worker is active or dirty, without checkpointing', async () => {
    await commit(worker, 'feature.txt');
    const sourceHead = git(worker, 'rev-parse', 'HEAD');
    await commit(repo, 'leader.txt');
    const beforeDelivery = git(repo, 'rev-parse', 'HEAD');
    await completeTask();
    const lock = git(worker, 'rev-parse', '--git-path', 'index.lock');
    await writeFile(lock, 'held by regression test');
    assert.equal((await monitorTeam(team, repo))?.phase, 'team-fix');
    await rm(lock);
    git(repo, 'reset', '--hard', beforeDelivery);
    await writeWorkerStatus(team, 'worker-1', { state: 'working', updated_at: new Date().toISOString() }, repo);
    assert.equal((await monitorTeam(team, repo))?.phase, 'team-fix');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeDelivery);
    await writeWorkerStatus(team, 'worker-1', { state: 'done', updated_at: new Date().toISOString() }, repo);
    await writeFile(join(worker, 'unverified.txt'), 'do not publish');
    for (let poll = 0; poll < 2; poll++) {
      assert.equal((await monitorTeam(team, repo))?.phase, 'team-fix');
      assert.equal(git(worker, 'rev-parse', 'HEAD'), sourceHead);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeDelivery);
      assert.ok((await readMonitorSnapshot(team, repo))!.integrationByWorker!['worker-1'].pending_rebase_leader_head);
    }
    await rm(join(worker, 'unverified.txt'));
    assert.equal((await monitorTeam(team, repo))?.phase, 'complete');
    await assert.rejects(readFile(join(repo, 'unverified.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'feature.txt\n');
  });

  it('allows genuinely no-change research worktrees to complete', async () => {
    await completeTask('1', false);
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
    await completeTask();
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
    await commit(worker, 'feature.txt');
    await completeTask();
    const sentinel = await createTask(team, {
      subject: 'final research check', description: 'Keep the team active before the persisted failure',
      status: 'pending', requires_code_change: false,
    }, repo);
    assert.notEqual((await monitorTeam(team, repo))?.phase, 'complete');
    assert.equal((await rootState()).active, true);
    git(repo, 'merge-base', '--is-ancestor', git(worker, 'rev-parse', 'HEAD'), 'HEAD');
    const persisted = (await readMonitorSnapshot(team, repo))!;
    persisted.integrationByWorker!['worker-1'].status = 'integration_failed';
    await writeMonitorSnapshot(team, persisted, repo);
    await completeTask(sentinel.id, false);
    const result = await monitorTeam(team, repo, { readOnly: true });
    assert.equal(result?.phase, 'team-fix');
    assert.equal((await rootState()).active, true);
    assert.equal((await readMonitorSnapshot(team, repo))?.integrationByWorker?.['worker-1']?.status, 'integration_failed');
  });
});
