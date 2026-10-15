import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimTask, createTask, initTeamState, readMonitorSnapshot, readTask, releaseTaskClaim, saveTeamConfig, transitionTaskStatus, updateTask, teamEventLogPath } from '../state.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { monitorTeam } from '../runtime.js';

describe('worker completion evidence', () => {
  it('rejects enabling evidence on terminal tasks through the public API without reclassifying them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'review', 'executor', 1, cwd);
      const malformedFlag = await executeTeamApiOperation('create-task', {
        team_name: 'proof', subject: 'code', description: 'implement', requires_code_change: 'true',
      }, cwd);
      assert.equal(malformedFlag.ok, false);
      if (!malformedFlag.ok) {
        assert.equal(malformedFlag.error.code, 'invalid_input');
        assert.match(malformedFlag.error.message, /requires_code_change must be a boolean/);
      }
      for (const entry of [
        { status: 'completed' as const, requires_code_change: false, result: 'Reviewed the implementation' },
        { status: 'completed' as const, requires_code_change: undefined, result: 'Verification: PASS review' },
        { status: 'failed' as const, requires_code_change: false, result: undefined },
      ]) {
        const task = await createTask('proof', { subject: 'review', description: 'read only', status: 'pending', requires_code_change: entry.requires_code_change }, cwd);
        const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
        assert.ok(claim.ok);
        assert.equal((await transitionTaskStatus('proof', task.id, 'in_progress', entry.status, claim.claimToken, cwd, { result: entry.result })).ok, true);
        const before = await readTask('proof', task.id, cwd);
        const response = await executeTeamApiOperation('update-task', {
          team_name: 'proof', task_id: task.id, requires_code_change: true,
        }, cwd);
        assert.equal(response.ok, false);
        if (!response.ok) {
          assert.equal(response.error.code, 'operation_failed');
          assert.match(response.error.message, /Cannot enable/);
        }
        assert.deepEqual(await readTask('proof', task.id, cwd), before);
        assert.ok(await updateTask('proof', task.id, { description: 'Review notes updated' }, cwd));
      }
      assert.equal((await monitorTeam('proof', cwd))?.phase, 'team-fix');
      const pending = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: false }, cwd);
      const enabled = await executeTeamApiOperation('update-task', { team_name: 'proof', task_id: pending.id, requires_code_change: true }, cwd);
      assert.equal(enabled.ok, true);
      assert.ok(await updateTask('proof', pending.id, { requires_code_change: true }, cwd));
      const claim = await claimTask('proof', pending.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const rejected = await transitionTaskStatus('proof', pending.id, 'in_progress', 'completed', claim.claimToken, cwd);
      assert.ok(!rejected.ok && rejected.error === 'invalid_completion_evidence');

      const bypass = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: false }, cwd);
      const beforeBypass = await readTask('proof', bypass.id, cwd);
      await assert.rejects(
        updateTask('proof', bypass.id, { status: 'completed', requires_code_change: true }, cwd),
        /transition-task-status/,
      );
      assert.deepEqual(await readTask('proof', bypass.id, cwd), beforeBypass);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects marker-only results and accepts valid dot-prefixed evidence through team verification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      await mkdir(join(cwd, '.omx/evidence'), { recursive: true });
      await writeFile(join(cwd, '.omx/evidence/test-results.json'), JSON.stringify({
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Fix addition and exercise positive and negative inputs',
        verification: [{ command: 'node --test', result: 'passed', output: '2 tests passed' }], unverified: [],
      }));
      const marker = 'EVIDENCE_RECORDED: .omx/evidence/test-results.json';
      for (const result of [marker, `Verification:\n${marker}`, `Verification:\n ${marker}`]) {
        const rejected = await transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result });
        assert.ok(!rejected.ok && rejected.error === 'invalid_completion_evidence');
        assert.match(rejected.reason ?? '', /Verification/);
        assert.equal((await readTask('proof', task.id, cwd))?.status, 'in_progress');
        assert.equal((await readMonitorSnapshot('proof', cwd))?.completedEventTaskIds?.[task.id], undefined);
      }
      const completed = await transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result: `Verification:\n- PASS node --test: 2 tests passed\n${marker}` });
      assert.equal(completed.ok, true);
      assert.ok(await updateTask('proof', task.id, { requires_code_change: true }, cwd));
      for (let poll = 0; poll < 2; poll += 1) {
        const snapshot = await monitorTeam('proof', cwd);
        assert.equal(snapshot?.phase, 'complete');
        assert.ok(!snapshot?.recommendations.some((recommendation) => recommendation.includes('Verification evidence missing')));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cannot disable evidence through the public API before claiming or after releasing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const disable = () => executeTeamApiOperation('update-task', {
        team_name: 'proof', task_id: task.id, requires_code_change: false,
      }, cwd);
      assert.equal((await disable()).ok, false);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const released = await executeTeamApiOperation('release-task-claim', {
        team_name: 'proof', task_id: task.id, worker: 'worker-1', claim_token: claim.claimToken,
      }, cwd);
      assert.ok(released.ok && released.data.ok);
      assert.equal((await disable()).ok, false);
      const next = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(next.ok);
      const completed = await executeTeamApiOperation('transition-task-status', {
        team_name: 'proof', task_id: task.id, from: 'in_progress', to: 'completed', claim_token: next.claimToken,
      }, cwd);
      assert.ok(completed.ok);
      assert.equal(completed.data.error, 'invalid_completion_evidence');
      assert.equal((await readTask('proof', task.id, cwd))?.status, 'in_progress');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the assigned worker directory and rejects evidence from an earlier claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      const config = await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const workerCwd = join(cwd, 'worker');
      config.workers[0]!.working_dir = workerCwd;
      await saveTeamConfig(config, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const evidence = {
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Implement multiplication',
        verification: [{ command: 'node --test', result: 'passed', output: '3 tests passed' }], unverified: ['Manual UI check'],
      };
      assert.ok((await releaseTaskClaim('proof', task.id, claim.claimToken, 'worker-1', cwd)).ok);
      const next = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(next.ok);
      const path = '.omx/evidence/task.json';
      await mkdir(join(workerCwd, '.omx/evidence'), { recursive: true });
      await writeFile(join(workerCwd, path), JSON.stringify(evidence));
      const complete = () => transitionTaskStatus('proof', task.id, 'in_progress', 'completed', next.claimToken, cwd, { result: `Verification: PASS\nEVIDENCE_RECORDED: ${path}` });
      const rejected = await complete();
      assert.ok(!rejected.ok && rejected.error === 'invalid_completion_evidence');
      evidence.claimTokenSha256 = createHash('sha256').update(next.claimToken).digest('hex');
      await writeFile(join(workerCwd, path), JSON.stringify(evidence));
      assert.equal((await complete()).ok, true);
      const readOnly = await createTask('proof', { subject: 'review', description: 'read only', status: 'pending', requires_code_change: false }, cwd);
      const readClaim = await claimTask('proof', readOnly.id, 'worker-1', null, cwd);
      assert.ok(readClaim.ok);
      assert.equal((await transitionTaskStatus('proof', readOnly.id, 'in_progress', 'completed', readClaim.claimToken, cwd)).ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the API caller directory when worker and team state roots differ', async () => {
    const stateCwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-state-'));
    const callerCwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-caller-'));
    const previousStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      const config = await initTeamState('proof', 'implement', 'executor', 1, stateCwd);
      delete config.workers[0]!.working_dir;
      await saveTeamConfig(config, stateCwd);
      process.env.OMX_TEAM_STATE_ROOT = join(stateCwd, '.omx', 'state');
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, stateCwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, stateCwd);
      assert.ok(claim.ok);
      const path = '.omx/evidence/task.json';
      await mkdir(join(callerCwd, '.omx/evidence'), { recursive: true });
      await writeFile(join(callerCwd, path), JSON.stringify({
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Implement division',
        verification: [{ command: 'node --test', result: 'passed', output: '4 tests passed' }],
        unverified: [],
      }));
      const result = await executeTeamApiOperation('transition-task-status', {
        team_name: 'proof', task_id: task.id, from: 'in_progress', to: 'completed',
        claim_token: claim.claimToken, result: `Verification: PASS\nEVIDENCE_RECORDED: ${path}`,
      }, callerCwd);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.data.ok, true);
      assert.equal((await readTask('proof', task.id, stateCwd))?.status, 'completed');
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousStateRoot;
      await rm(stateCwd, { recursive: true, force: true });
      await rm(callerCwd, { recursive: true, force: true });
    }
  });

  it('rejects missing, escaped, stale, mismatched and placeholder reports without completing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const evidence = {
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Implement addition and exercise negative numbers',
        verification: [{ command: 'node --test', result: 'passed', output: '2 tests passed' }], unverified: [],
      };
      await mkdir(join(cwd, '.omx/evidence'), { recursive: true });
      const path = '.omx/evidence/task.json';
      const complete = (result?: string) => transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result });
      const reject = async (result?: string) => {
        const response = await complete(`Verification: PASS\n${result ?? ''}`);
        assert.equal(response.ok, false);
        if (!response.ok) assert.equal(response.error, 'invalid_completion_evidence');
        assert.equal((await readTask('proof', task.id, cwd))?.status, 'in_progress');
        assert.equal((await readMonitorSnapshot('proof', cwd))?.completedEventTaskIds?.[task.id], undefined);
      };
      await reject('Tests passed');
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), '{}');
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), '{');
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify({ ...evidence, taskId: 'other-task' }));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify({ ...evidence, claimTokenSha256: 'old-claim' }));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify({ ...evidence, verification: [{ command: 'node --test', result: 'passed', output: 'TODO' }] }));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify(evidence));
      await utimes(join(cwd, path), new Date(0), new Date(0));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, '.omx/outside.json'), JSON.stringify(evidence));
      await reject('EVIDENCE_RECORDED: .omx/outside.json');
      await symlink(join(cwd, '.omx/outside.json'), join(cwd, '.omx/evidence/link.json'));
      await reject('EVIDENCE_RECORDED: .omx/evidence/link.json');
      await symlink(join(cwd, '.omx'), join(cwd, '.omx/evidence/linked-dir'));
      await reject('EVIDENCE_RECORDED: .omx/evidence/linked-dir/outside.json');
      await assert.rejects(updateTask('proof', task.id, { status: 'completed' }, cwd), /transition-task-status/);
      await assert.rejects(updateTask('proof', task.id, { requires_code_change: false }, cwd), /Cannot disable/);
      await writeFile(join(cwd, path), JSON.stringify(evidence));
      assert.equal((await complete(`Verification: PASS\nEVIDENCE_RECORDED: ${path}`)).ok, true);
      assert.equal((await readTask('proof', task.id, cwd))?.status, 'completed');
      assert.match((await readFile(teamEventLogPath('proof', cwd), 'utf8')), /task_completed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
