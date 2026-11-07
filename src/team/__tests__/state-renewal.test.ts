import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTeamState, createTask, claimTask, renewTaskClaim, transitionTaskStatus,
  reclaimExpiredTaskClaim, readTask, writeWorkerStatus, writeAtomic,
} from '../state.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { updateWorkerHeartbeat } from '../../scripts/notify-hook/team-worker.js';
import { handleTeamWorkerPostToolUseSuccess } from '../../scripts/notify-hook/team-worker-posttooluse.js';
import { renewWorkerTaskLease } from '../../scripts/notify-hook/team-worker-lease.js';

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
    await updateWorkerHeartbeat(join(cwd, '.omx/state'), team, 'worker-1');
    assert.deepEqual(await renewTaskClaim(team, claim.task.id, 'worker-1', claim.claimToken, cwd), { ok: false, error: 'lease_expired' });
    const reclaimed = await reclaimExpiredTaskClaim(team, claim.task.id, cwd);
    assert.equal(reclaimed.ok, true);
    const next = await claimTask(team, claim.task.id, 'worker-1', null, cwd);
    assert.ok(next.ok);
    if (!next.ok) throw new Error('reclaim failed');
    const before = await readTask(team, claim.task.id, cwd);
    assert.deepEqual(await renewWorkerTaskLease(join(cwd, '.omx/state'), team, 'worker-1'), { ok: false, error: 'claim_conflict' });
    assert.deepEqual(await readTask(team, claim.task.id, cwd), before);
    assert.equal((await transitionTaskStatus(team, claim.task.id, 'in_progress', 'completed', claim.claimToken, cwd)).ok, false);
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
