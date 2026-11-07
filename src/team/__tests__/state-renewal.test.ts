import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTeamState, createTask, claimTask, renewTaskClaim, transitionTaskStatus,
  reclaimExpiredTaskClaim, readTask, writeWorkerStatus, writeAtomic, listMailboxMessages, withTeamTaskBarrier,
} from '../state.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { updateWorkerHeartbeat } from '../../scripts/notify-hook/team-worker.js';
import { handleTeamWorkerPostToolUseSuccess } from '../../scripts/notify-hook/team-worker-posttooluse.js';
import { renewWorkerTaskLease, reportWorkerTaskLeaseLoss } from '../../scripts/notify-hook/team-worker-lease.js';

const team = 'lease-renewal';
describe('task claim renewal', () => {
  let cwd: string;
  let previousRoot: string | undefined;
  let realNow: typeof Date.now;
  beforeEach(async () => {
    previousRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    realNow = Date.now;
    cwd = await mkdtemp(join(tmpdir(), 'omx-task-renewal-'));
    await initTeamState(team, 'lease renewal', 'executor', 2, cwd);
  });
  afterEach(async () => {
    Date.now = realNow;
    if (previousRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
    else process.env.OMX_TEAM_STATE_ROOT = previousRoot;
    await rm(cwd, { recursive: true, force: true });
  });
  async function claimed() {
    const task = await createTask(team, { subject: 'long work', description: 'work', status: 'pending' }, cwd);
    const result = await claimTask(team, task.id, 'worker-1', null, cwd);
    assert.ok(result.ok);
    if (!result.ok) throw new Error('claim failed');
    return result;
  }
  async function expire(taskId: string) {
    const path = join(cwd, '.omx/state/team', team, 'tasks', `task-${taskId}.json`);
    const task = JSON.parse(await readFile(path, 'utf8'));
    task.claim.leased_until = new Date(Date.now() - 1000).toISOString();
    await writeAtomic(path, JSON.stringify(task));
  }

  it('notify heartbeat renews a captured token so work completes past its original lease', async () => {
    const claim = await claimed();
    const start = realNow();
    const originalExpiry = Date.parse(claim.task.claim!.leased_until);
    await writeWorkerStatus(team, 'worker-1', {
      state: 'working', current_task_id: claim.task.id, current_claim_token: claim.claimToken,
      updated_at: new Date().toISOString(),
    }, cwd);
    Date.now = () => start + 10 * 60_000;
    await updateWorkerHeartbeat(join(cwd, '.omx/state'), team, 'worker-1');
    const renewed = await readTask(team, claim.task.id, cwd);
    assert.ok(Date.parse(renewed!.claim!.leased_until) > originalExpiry);
    assert.equal(renewed!.version, claim.task.version + 1);
    assert.equal(renewed!.claim!.claimed_at, claim.task.claim!.claimed_at);
    Date.now = () => originalExpiry + 60_000;
    const complete = await transitionTaskStatus(team, claim.task.id, 'in_progress', 'completed', claim.claimToken, cwd);
    assert.equal(complete.ok, true);
  });

  it('successful Bash PostToolUse renews the worker token through the real hook handler', async () => {
    const claim = await claimed();
    const stateRoot = join(cwd, '.omx/state');
    await writeAtomic(join(stateRoot, 'team', team, 'workers/worker-1/identity.json'), JSON.stringify({
      name: 'worker-1', team_state_root: stateRoot, worktree_path: cwd,
    }));
    await writeWorkerStatus(team, 'worker-1', {
      state: 'working', current_task_id: claim.task.id, current_claim_token: claim.claimToken,
      updated_at: new Date().toISOString(),
    }, cwd);
    Date.now = () => realNow() + 10 * 60_000;
    await handleTeamWorkerPostToolUseSuccess({
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 0 }, tool_use_id: 'lease-tool',
    }, cwd, { ...process.env, OMX_TEAM_WORKER: `${team}/worker-1`, OMX_TEAM_STATE_ROOT: stateRoot });
    assert.equal((await readTask(team, claim.task.id, cwd))?.version, claim.task.version + 1);
  });

  it('explicit CLI API renewal validates inputs, owner and token', async () => {
    const claim = await claimed();
    const missing = await executeTeamApiOperation('renew-task-claim', { team_name: team }, cwd);
    assert.equal(missing.ok, false);
    assert.deepEqual(await renewTaskClaim(team, claim.task.id, 'worker-2', claim.claimToken, cwd), { ok: false, error: 'claim_conflict' });
    assert.deepEqual(await renewTaskClaim(team, claim.task.id, 'worker-1', 'stale', cwd), { ok: false, error: 'claim_conflict' });
    assert.deepEqual(await renewTaskClaim(team, claim.task.id, 'worker-404', claim.claimToken, cwd), { ok: false, error: 'worker_not_found' });
    const result = await executeTeamApiOperation('renew-task-claim', {
      team_name: team, task_id: claim.task.id, worker: 'worker-1', claim_token: claim.claimToken,
    }, cwd);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('api failed');
    assert.equal(result.data?.ok, true);
  });

  it('fresh heartbeat cannot revive an expired claim or adopt a reissued token for the same worker', async () => {
    const claim = await claimed();
    await writeWorkerStatus(team, 'worker-1', {
      state: 'working', current_task_id: claim.task.id, current_claim_token: claim.claimToken,
      updated_at: new Date().toISOString(),
    }, cwd);
    await expire(claim.task.id);
    const rejectedHeartbeat = await updateWorkerHeartbeat(join(cwd, '.omx/state'), team, 'worker-1');
    assert.ok(rejectedHeartbeat && !rejectedHeartbeat.ok && 'stopMessage' in rejectedHeartbeat);
    assert.match(rejectedHeartbeat.stopMessage, /LEASE LOST:.*STOP editing/);
    for (const recipient of ['worker-1', 'leader-fixed']) {
      assert.ok((await listMailboxMessages(team, recipient, cwd)).some((message) => /LEASE LOST:.*lease_expired.*STOP editing/.test(message.body)));
    }
    assert.deepEqual(await renewTaskClaim(team, claim.task.id, 'worker-1', claim.claimToken, cwd), { ok: false, error: 'lease_expired' });
    const reclaimed = await reclaimExpiredTaskClaim(team, claim.task.id, cwd);
    assert.equal(reclaimed.ok, true);
    const pendingBefore = await readTask(team, claim.task.id, cwd);
    const pendingHeartbeat = await updateWorkerHeartbeat(join(cwd, '.omx/state'), team, 'worker-1');
    assert.ok(pendingHeartbeat && !pendingHeartbeat.ok && 'stopMessage' in pendingHeartbeat);
    assert.match(pendingHeartbeat.stopMessage, /claim_conflict.*STOP editing/);
    assert.deepEqual(await readTask(team, claim.task.id, cwd), pendingBefore);
    const next = await claimTask(team, claim.task.id, 'worker-1', null, cwd);
    assert.ok(next.ok);
    if (!next.ok) throw new Error('reclaim failed');
    const before = await readTask(team, claim.task.id, cwd);
    assert.deepEqual(await renewWorkerTaskLease(join(cwd, '.omx/state'), team, 'worker-1'), { ok: false, error: 'claim_conflict' });
    const stateRoot = join(cwd, '.omx/state');
    await writeAtomic(join(stateRoot, 'team', team, 'workers/worker-1/identity.json'), JSON.stringify({
      name: 'worker-1', team_state_root: stateRoot, worktree_path: cwd,
    }));
    const postTool = await handleTeamWorkerPostToolUseSuccess({
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 0 },
    }, cwd, { ...process.env, OMX_TEAM_WORKER: `${team}/worker-1`, OMX_TEAM_STATE_ROOT: stateRoot });
    assert.match(postTool.stopMessage!, /claim_conflict.*STOP editing/);
    assert.deepEqual(postTool.operationKinds, []);
    assert.equal(postTool.checkpointCommit, undefined);
    for (const recipient of ['worker-1', 'leader-fixed']) {
      assert.ok((await listMailboxMessages(team, recipient, cwd)).some((message) => /claim_conflict.*STOP editing/.test(message.body)));
    }
    assert.deepEqual(await readTask(team, claim.task.id, cwd), before);
    assert.equal((await transitionTaskStatus(team, claim.task.id, 'in_progress', 'completed', claim.claimToken, cwd)).ok, false);
  });

  for (const terminalStatus of ['completed', 'failed'] as const) {
    it(`automatic renewal quietly closes an own ${terminalStatus} handoff before the separate idle-status command`, async () => {
      const task = await createTask(team, { subject: 'no-code handoff', description: 'research', status: 'pending', requires_code_change: false }, cwd);
      await createTask(team, { subject: 'other ongoing work', description: 'keep team active', status: 'pending', owner: 'worker-2' }, cwd);
      const claim = await claimTask(team, task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const stateRoot = join(cwd, '.omx/state');
      const workerRoot = join(stateRoot, 'team', team, 'workers/worker-1');
      await writeAtomic(join(workerRoot, 'identity.json'), JSON.stringify({ name: 'worker-1', team_state_root: stateRoot, worktree_path: cwd }));
      await writeWorkerStatus(team, 'worker-1', {
        state: 'working', current_task_id: task.id, current_claim_token: claim.claimToken, updated_at: new Date().toISOString(),
      }, cwd);
      const statusBefore = await readFile(join(workerRoot, 'status.json'), 'utf8');
      const transitioned = await transitionTaskStatus(team, task.id, 'in_progress', terminalStatus, claim.claimToken, cwd, {
        result: 'Research complete; no code changes.', error: 'Research could not finish.',
      });
      assert.ok(transitioned.ok);
      const taskBefore = await readTask(team, task.id, cwd);
      const explicit = await executeTeamApiOperation('renew-task-claim', {
        team_name: team, task_id: task.id, worker: 'worker-1', claim_token: claim.claimToken,
      }, cwd);
      assert.ok(explicit.ok);
      assert.equal(explicit.data?.ok, false);
      assert.equal(explicit.data?.error, 'already_terminal');
      const automatic = await renewWorkerTaskLease(stateRoot, team, 'worker-1');
      assert.ok(automatic?.ok && 'terminalHandoff' in automatic);
      assert.equal(automatic.task.claim, undefined);
      const heartbeat = await updateWorkerHeartbeat(stateRoot, team, 'worker-1');
      assert.ok(heartbeat?.ok && 'terminalHandoff' in heartbeat);
      const postTool = await handleTeamWorkerPostToolUseSuccess({
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 0 }, tool_use_id: 'terminal-handoff',
      }, cwd, { ...process.env, OMX_TEAM_WORKER: `${team}/worker-1`, OMX_TEAM_STATE_ROOT: stateRoot });
      assert.equal(postTool.reason, 'terminal_handoff');
      assert.equal(postTool.stopMessage, undefined);
      assert.equal(postTool.checkpointCommit, undefined);
      assert.deepEqual(postTool.operationKinds, []);
      for (const file of ['lease-loss.json', 'posttooluse-dedupe.json']) assert.equal(existsSync(join(workerRoot, file)), false);
      assert.equal(existsSync(join(cwd, '.omx/reports/team-commit-hygiene', `${team}.ledger.json`)), false);
      assert.deepEqual(await readTask(team, task.id, cwd), taskBefore);
      assert.equal(await readFile(join(workerRoot, 'status.json'), 'utf8'), statusBefore);
      await writeWorkerStatus(team, 'worker-1', { state: 'idle', updated_at: new Date().toISOString() }, cwd);
      assert.equal(await renewWorkerTaskLease(stateRoot, team, 'worker-1'), null);
    });

    it(`automatic renewal still reports a foreign-owner ${terminalStatus} task as lease loss`, async () => {
      const task = await createTask(team, { subject: 'foreign handoff', description: 'research', status: 'pending', requires_code_change: false }, cwd);
      const claim = await claimTask(team, task.id, 'worker-2', null, cwd);
      assert.ok(claim.ok);
      assert.ok((await transitionTaskStatus(team, task.id, 'in_progress', terminalStatus, claim.claimToken, cwd)).ok);
      await writeWorkerStatus(team, 'worker-1', {
        state: 'working', current_task_id: task.id, current_claim_token: claim.claimToken, updated_at: new Date().toISOString(),
      }, cwd);
      const taskBefore = await readTask(team, task.id, cwd);
      const heartbeat = await updateWorkerHeartbeat(join(cwd, '.omx/state'), team, 'worker-1');
      assert.ok(heartbeat && !heartbeat.ok && 'stopMessage' in heartbeat);
      assert.match(heartbeat.stopMessage, /already_terminal.*STOP editing/);
      assert.deepEqual(await readTask(team, task.id, cwd), taskBefore);
    });
  }

  it('automatic renewal reports a real membership timeout from PostToolUse and heartbeat without mutating the captured claim', async (t) => {
    const claim = await claimed();
    const stateRoot = join(cwd, '.omx/state');
    const workerRoot = join(stateRoot, 'team', team, 'workers/worker-1');
    await writeAtomic(join(workerRoot, 'identity.json'), JSON.stringify({
      name: 'worker-1', team_state_root: stateRoot, worktree_path: cwd,
    }));
    await writeWorkerStatus(team, 'worker-1', {
      state: 'working', current_task_id: claim.task.id, current_claim_token: claim.claimToken,
      updated_at: new Date().toISOString(),
    }, cwd);
    const statusBefore = await readFile(join(workerRoot, 'status.json'), 'utf8');
    const taskBefore = await readTask(team, claim.task.id, cwd);
    const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    await writeFile(join(cwd, 'work.txt'), 'before\n');
    git(['add', 'work.txt']);
    git(['commit', '-m', 'initial']);
    const headBefore = git(['rev-parse', 'HEAD']);
    await writeFile(join(cwd, 'work.txt'), 'unverified edits\n');
    const warnings: string[] = [];
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const barrier = withTeamTaskBarrier(team, cwd, async () => { acquired(); await held; });
    await ready;
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      // Both renewals must time out before letting their best-effort mailbox reports proceed.
      if (warnings.length === 2) release();
      return true;
    });
    try {
      // Call outside the barrier callback: inherited ALS ownership would bypass contention.
      const [postTool, heartbeat] = await Promise.all([
        handleTeamWorkerPostToolUseSuccess({
          hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 0 }, tool_use_id: 'timeout-tool',
        }, cwd, { ...process.env, OMX_TEAM_WORKER: `${team}/worker-1`, OMX_TEAM_STATE_ROOT: stateRoot }),
        updateWorkerHeartbeat(stateRoot, team, 'worker-1'),
      ]);
      assert.match(postTool.stopMessage!, /renewal_error:.*Timed out acquiring team task lock.*STOP editing/);
      assert.equal(postTool.handled, true);
      assert.deepEqual(postTool.operationKinds, []);
      assert.equal(postTool.checkpointCommit, undefined);
      assert.equal(postTool.dedupeKey, undefined);
      assert.ok(heartbeat && !heartbeat.ok && 'stopMessage' in heartbeat);
      assert.match(heartbeat.stopMessage, /Timed out acquiring team task lock.*STOP editing/);
      assert.equal(warnings.filter((message) => /Timed out acquiring team task lock.*STOP editing/.test(message)).length, 2);
      for (const recipient of ['worker-1', 'leader-fixed']) {
        const messages = await listMailboxMessages(team, recipient, cwd);
        assert.ok(messages.some((message) => /Timed out acquiring team task lock.*STOP editing/.test(message.body)));
      }
      assert.equal(existsSync(join(workerRoot, 'posttooluse-dedupe.json')), false);
      assert.equal(existsSync(join(cwd, '.omx/reports/team-commit-hygiene', `${team}.ledger.json`)), false);
      assert.match(await readFile(join(workerRoot, 'lease-loss.json'), 'utf8'), /STOP editing/);
      assert.equal(git(['rev-parse', 'HEAD']), headBefore);
      assert.equal(await readFile(join(cwd, 'work.txt'), 'utf8'), 'unverified edits\n');
      assert.equal(git(['diff', '--cached']), '');
      assert.deepEqual(await readTask(team, claim.task.id, cwd), taskBefore);
      assert.equal(await readFile(join(workerRoot, 'status.json'), 'utf8'), statusBefore);
    } finally {
      release();
      await barrier;
    }
  });

  it('automatic renewal catches config lookup errors only after capturing a working task/token', async () => {
    const claim = await claimed();
    const stateRoot = join(cwd, '.omx/state');
    const configPath = join(stateRoot, 'team', team, 'config.json');
    await rm(configPath);
    await mkdir(configPath);
    for (const status of [
      { state: 'idle' as const, current_task_id: claim.task.id, current_claim_token: claim.claimToken },
      { state: 'working' as const, current_task_id: claim.task.id },
    ]) {
      await writeWorkerStatus(team, 'worker-1', { ...status, updated_at: new Date().toISOString() }, cwd);
      assert.equal(await renewWorkerTaskLease(stateRoot, team, 'worker-1'), null);
    }
    await writeWorkerStatus(team, 'worker-1', {
      state: 'working', current_task_id: claim.task.id, current_claim_token: claim.claimToken, updated_at: new Date().toISOString(),
    }, cwd);
    const renewal = await renewWorkerTaskLease(stateRoot, team, 'worker-1');
    assert.ok(renewal && !renewal.ok);
    assert.match(renewal.error, /renewal_error:.*EISDIR/);
    assert.deepEqual(await readTask(team, claim.task.id, cwd), claim.task);
  });

  it('best-effort lease-loss reporting errors cannot erase the heartbeat STOP', async (t) => {
    const claim = await claimed();
    const stateRoot = join(cwd, '.omx/state');
    const teamRoot = join(stateRoot, 'team', team);
    const workerRoot = join(teamRoot, 'workers/worker-1');
    await writeWorkerStatus(team, 'worker-1', {
      state: 'working', current_task_id: claim.task.id, current_claim_token: claim.claimToken, updated_at: new Date().toISOString(),
    }, cwd);
    await writeFile(join(teamRoot, 'config.json'), 'null');
    await mkdir(join(workerRoot, 'lease-loss.json'));
    await rm(join(teamRoot, 'mailbox'), { recursive: true, force: true });
    await writeFile(join(teamRoot, 'mailbox'), 'blocked');
    const warnings: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; });
    const heartbeat = await updateWorkerHeartbeat(stateRoot, team, 'worker-1');
    assert.ok(heartbeat && !heartbeat.ok && 'stopMessage' in heartbeat);
    assert.match(heartbeat.stopMessage, /renewal_error:.*STOP editing/);
    assert.ok(warnings.some((message) => /Lease-loss record failed:/.test(message)));
    for (const recipient of ['worker-1', 'leader-fixed']) {
      assert.ok(warnings.some((message) => message.includes(`Notification to ${recipient} failed:`)));
    }
    t.mock.method(process.stderr, 'write', () => { throw new Error('stderr closed'); });
    assert.match(await reportWorkerTaskLeaseLoss(stateRoot, team, 'worker-1', 'renewal_error:io'), /renewal_error:io.*STOP editing/);
    assert.deepEqual(await readTask(team, claim.task.id, cwd), claim.task);
  });

  it('renewal and reclaim serialize without stealing a live claim; expired dead work stays reclaimable', async () => {
    const claim = await claimed();
    await Promise.all([
      renewTaskClaim(team, claim.task.id, 'worker-1', claim.claimToken, cwd),
      reclaimExpiredTaskClaim(team, claim.task.id, cwd),
    ]);
    assert.equal((await readTask(team, claim.task.id, cwd))?.claim?.token, claim.claimToken);
    await expire(claim.task.id);
    const [renewal] = await Promise.all([
      renewTaskClaim(team, claim.task.id, 'worker-1', claim.claimToken, cwd),
      reclaimExpiredTaskClaim(team, claim.task.id, cwd),
    ]);
    assert.equal(renewal.ok, false);
    const task = await readTask(team, claim.task.id, cwd);
    assert.equal(task?.status, 'pending');
    assert.equal(task?.claim, undefined);
  });

  it('idle or missing-token status does not renew an arbitrary task', async () => {
    const claim = await claimed();
    for (const state of ['idle', 'working'] as const) {
      await writeWorkerStatus(team, 'worker-1', { state, current_task_id: claim.task.id, updated_at: new Date().toISOString() }, cwd);
      assert.equal(await renewWorkerTaskLease(join(cwd, '.omx/state'), team, 'worker-1'), null);
    }
    assert.equal((await readTask(team, claim.task.id, cwd))?.version, claim.task.version);
  });
});
