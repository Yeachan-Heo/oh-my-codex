import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCheckpoint,
  createRunningTeamSession,
  ingestTeamEvidence,
  linkRunningTeamTeamAdapter,
  readRunningTeamSession,
  revisePlan,
  runningTeamPaths,
  transitionRunningTeamSession,
  validateCriticVerdictRecord,
  validatePlannerRevision,
  validateRunningTeamSession,
  writeCriticVerdict,
  writeFinalSynthesis,
} from '../runtime.js';
import { appendTeamEvent, initTeamState } from '../../team/state.js';

async function withTempRoot<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-runningteam-runtime-'));
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  try {
    return await fn(cwd);
  } finally {
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('RunningTeam runtime contracts', () => {
  it('creates first-class session state and rejects completion without final-synthesis.md', async () => {
    await withTempRoot(async (cwd) => {
      const session = await createRunningTeamSession('two lane fixture task', cwd, { sessionId: 'rt-final-gate' });
      assert.equal(session.status, 'planning');
      assert.equal(session.plan_version, 1);
      assert.equal(session.team_name, null);

      await assert.rejects(
        transitionRunningTeamSession(cwd, session.session_id, 'complete'),
        /complete_requires_final_synthesis/,
      );

      await writeFinalSynthesis(cwd, session.session_id, '# Final synthesis\n\nAll evidence is supported.');
      await assert.rejects(
        transitionRunningTeamSession(cwd, session.session_id, 'complete'),
        /complete_requires_final_synthesis_ready_verdict/,
      );
      await writeCriticVerdict(cwd, session.session_id, {
        iteration: 0,
        verdict: 'FINAL_SYNTHESIS_READY',
        acceptance_criteria_evidence: { 'final synthesis is created before completion': ['manual synthesis'] },
        created_at: new Date().toISOString(),
      });
      const complete = await transitionRunningTeamSession(cwd, session.session_id, 'complete');
      assert.equal(complete.status, 'complete');
    });
  });

  it('validates schema enums and verdict/revision guardrails', () => {
    assert.throws(
      () => validateRunningTeamSession({ session_id: 's', task: 't', created_at: 'n', updated_at: 'n', status: 'bogus', iteration: 0, plan_version: 1, team_name: null, max_iterations: 10, terminal_reason: null }),
      /invalid_status/,
    );
    assert.throws(
      () => validateCriticVerdictRecord({ iteration: 1, verdict: 'ITERATE_PLAN', created_at: 'now' }),
      /required_changes/,
    );
    assert.throws(
      () => validateCriticVerdictRecord({ iteration: 1, verdict: 'FINAL_SYNTHESIS_READY', created_at: 'now' }),
      /acceptance_criteria_evidence/,
    );
    assert.throws(
      () => validatePlannerRevision({ iteration: 1, from_plan_version: 1, to_plan_version: 2, reason: 'r', changes: ['c'], preserved_acceptance_criteria: false, created_at: 'now' }),
      /preserved_acceptance_criteria/,
    );
  });

  it('ingests team events once, checkpoints evidence, and revises only after checkpoint plus verdict', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('rt-team', 'fixture team', 'executor', 2, cwd);
      const session = await createRunningTeamSession('two lane fixture task', cwd, { sessionId: 'rt-e2e' });
      await linkRunningTeamTeamAdapter(cwd, session.session_id, {
        team_name: 'rt-team',
        cursor: '',
        lane_task_map: { tests: '1', implementation: '2' },
        evidence_guarantee: 'active',
      });

      await appendTeamEvent('rt-team', {
        type: 'task_completed',
        worker: 'worker-1',
        task_id: '1',
        reason: 'RED evidence emitted',
        metadata: { files_changed: ['src/runningteam/__tests__/runtime.test.ts'], commands: ['node --test'], tests: ['runtime.test.ts'] },
      }, cwd);
      const first = await ingestTeamEvidence(cwd, session.session_id);
      const second = await ingestTeamEvidence(cwd, session.session_id);
      assert.equal(first.length, 1);
      assert.equal(second.length, 0, 'stable cursor deduplicates already ingested events');

      const checkpoint = await createCheckpoint(cwd, session.session_id);
      assert.equal(checkpoint.iteration, 1);
      assert.deepEqual(checkpoint.evidence_ids, [first[0]?.evidence_id]);

      await assert.rejects(
        revisePlan(cwd, session.session_id, {
          iteration: 2,
          from_plan_version: 1,
          to_plan_version: 2,
          reason: 'missing checkpoint',
          changes: ['next batch'],
          preserved_acceptance_criteria: true,
          created_at: new Date().toISOString(),
        }),
        /revision_requires_checkpoint/,
      );

      await writeCriticVerdict(cwd, session.session_id, {
        iteration: 1,
        verdict: 'ITERATE_PLAN',
        required_changes: ['capture passing implementation evidence'],
        created_at: new Date().toISOString(),
      });
      const revised = await revisePlan(cwd, session.session_id, {
        iteration: 1,
        from_plan_version: 1,
        to_plan_version: 2,
        reason: 'critic requested iteration',
        changes: ['next implementation batch'],
        preserved_acceptance_criteria: true,
        created_at: new Date().toISOString(),
      });
      assert.equal(revised.plan_version, 2);
      assert.equal((await readRunningTeamSession(cwd, session.session_id)).plan_version, 2);
    });
  });

  it('requires fresh current-plan evidence for each checkpoint', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('rt-fresh-evidence-team', 'fixture team', 'executor', 2, cwd);
      const session = await createRunningTeamSession('fresh evidence fixture', cwd, { sessionId: 'rt-fresh-evidence' });
      await linkRunningTeamTeamAdapter(cwd, session.session_id, {
        team_name: 'rt-fresh-evidence-team',
        cursor: '',
        lane_task_map: { tests: '1', implementation: '2' },
        evidence_guarantee: 'active',
      });

      await appendTeamEvent('rt-fresh-evidence-team', {
        type: 'task_completed',
        worker: 'worker-1',
        task_id: '1',
        reason: 'plan v1 evidence',
        metadata: { commands: ['npm test'], tests: ['runningteam runtime'] },
      }, cwd);
      const firstEvidence = await ingestTeamEvidence(cwd, session.session_id);
      assert.equal(firstEvidence.length, 1);
      const firstCheckpoint = await createCheckpoint(cwd, session.session_id);
      assert.equal(firstCheckpoint.iteration, 1);

      await assert.rejects(
        createCheckpoint(cwd, session.session_id),
        /checkpoint_requires_new_evidence/,
        'already-checkpointed evidence must not satisfy a later checkpoint',
      );

      await writeCriticVerdict(cwd, session.session_id, {
        iteration: 1,
        verdict: 'ITERATE_PLAN',
        required_changes: ['collect plan v2 implementation evidence'],
        created_at: new Date().toISOString(),
      });
      await revisePlan(cwd, session.session_id, {
        iteration: 1,
        from_plan_version: 1,
        to_plan_version: 2,
        reason: 'advance to plan v2',
        changes: ['rerun implementation lane'],
        preserved_acceptance_criteria: true,
        created_at: new Date().toISOString(),
      });

      await assert.rejects(
        createCheckpoint(cwd, session.session_id),
        /checkpoint_requires_new_evidence/,
        'prior plan-version evidence must not satisfy a revised-plan checkpoint',
      );

      await appendTeamEvent('rt-fresh-evidence-team', {
        type: 'task_completed',
        worker: 'worker-2',
        task_id: '2',
        reason: 'plan v2 evidence',
        metadata: { commands: ['npm test'], tests: ['runningteam runtime v2'] },
      }, cwd);
      const secondEvidence = await ingestTeamEvidence(cwd, session.session_id);
      assert.equal(secondEvidence.length, 1);
      assert.equal(secondEvidence[0]?.plan_version, 2);
      const secondCheckpoint = await createCheckpoint(cwd, session.session_id);
      assert.equal(secondCheckpoint.iteration, 2);
      assert.deepEqual(secondCheckpoint.evidence_ids, [secondEvidence[0]?.evidence_id]);
    });
  });

  it('simulates two-lane E2E through final synthesis completion', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('rt-e2e-team', 'fixture team', 'executor', 2, cwd);
      const session = await createRunningTeamSession('two lane fixture task', cwd, { sessionId: 'rt-full-smoke' });
      await linkRunningTeamTeamAdapter(cwd, session.session_id, {
        team_name: 'rt-e2e-team',
        cursor: '',
        lane_task_map: { tests: '1', implementation: '2' },
        evidence_guarantee: 'active',
      });

      await appendTeamEvent('rt-e2e-team', { type: 'task_completed', worker: 'worker-1', task_id: '1', reason: 'tests lane RED', metadata: { commands: ['npm test'], tests: ['runningteam runtime'] } }, cwd);
      await ingestTeamEvidence(cwd, session.session_id);
      await createCheckpoint(cwd, session.session_id);
      await writeCriticVerdict(cwd, session.session_id, { iteration: 1, verdict: 'APPROVE_NEXT_BATCH', created_at: new Date().toISOString() });

      await appendTeamEvent('rt-e2e-team', { type: 'task_failed', worker: 'worker-2', task_id: '2', reason: 'implementation failed tests', metadata: { commands: ['npm test'], tests: ['failing runningteam runtime'] } }, cwd);
      await ingestTeamEvidence(cwd, session.session_id);
      await createCheckpoint(cwd, session.session_id);
      await writeCriticVerdict(cwd, session.session_id, { iteration: 2, verdict: 'ITERATE_PLAN', required_changes: ['fix implementation evidence'], created_at: new Date().toISOString() });
      await revisePlan(cwd, session.session_id, { iteration: 2, from_plan_version: 1, to_plan_version: 2, reason: 'failed implementation evidence', changes: ['rerun implementation lane'], preserved_acceptance_criteria: true, created_at: new Date().toISOString() });

      await appendTeamEvent('rt-e2e-team', { type: 'task_completed', worker: 'worker-2', task_id: '2', reason: 'implementation passing', metadata: { commands: ['npm test'], tests: ['passing runningteam runtime'] } }, cwd);
      await ingestTeamEvidence(cwd, session.session_id);
      await createCheckpoint(cwd, session.session_id);
      await writeCriticVerdict(cwd, session.session_id, { iteration: 3, verdict: 'FINAL_SYNTHESIS_READY', acceptance_criteria_evidence: { 'final synthesis is created before completion': ['worker-1', 'worker-2'] }, created_at: new Date().toISOString() });
      await writeFinalSynthesis(cwd, session.session_id, '# Final synthesis\n\nTwo-lane fixture completed.');
      const complete = await transitionRunningTeamSession(cwd, session.session_id, 'complete');
      assert.equal(complete.status, 'complete');
      assert.equal(existsSync(runningTeamPaths(cwd, session.session_id).finalSynthesis), true);
    });
  });



  it('ingests task result commands when team event metadata is empty', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('rt-result-fallback-team', 'fixture team', 'executor', 1, cwd);
      const session = await createRunningTeamSession('result fallback fixture', cwd, { sessionId: 'rt-result-fallback' });
      await linkRunningTeamTeamAdapter(cwd, session.session_id, {
        team_name: 'rt-result-fallback-team',
        cursor: '',
        lane_task_map: { implementation: '1' },
        evidence_guarantee: 'active',
      });
      const taskPath = join(cwd, '.omx', 'state', 'team', 'rt-result-fallback-team', 'tasks', 'task-1.json');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'rt-result-fallback-team', 'tasks'), { recursive: true });
      await writeFile(taskPath, JSON.stringify({
        id: '1',
        subject: 'implementation lane',
        description: 'report evidence in result',
        status: 'completed',
        owner: 'worker-1',
        created_at: '2026-05-10T00:00:00.000Z',
        filePaths: ['src/runningteam/runtime.ts'],
        result: [
          'Implemented result fallback.',
          'PASS - `npm test -- src/runningteam/__tests__/runtime.test.ts` → ok',
          'PASS - `npx tsc --noEmit` → ok',
        ].join('\n'),
      }, null, 2));

      await appendTeamEvent('rt-result-fallback-team', {
        type: 'task_completed',
        worker: 'worker-1',
        task_id: '1',
        reason: 'completed with result-only evidence',
        metadata: {},
      }, cwd);

      const evidence = await ingestTeamEvidence(cwd, session.session_id);
      assert.equal(evidence.length, 1);
      assert.deepEqual(evidence[0]?.files_changed, ['src/runningteam/runtime.ts']);
      assert.deepEqual(evidence[0]?.commands, ['npx tsc --noEmit']);
      assert.deepEqual(evidence[0]?.tests, ['npm test -- src/runningteam/__tests__/runtime.test.ts']);
      assert.equal(evidence[0]?.supported, true);
    });
  });

  it('preserves omx team state when RunningTeam is inactive', async () => {
    await withTempRoot(async (cwd) => {
      await initTeamState('plain-team', 'plain team task', 'executor', 1, cwd);
      const teamConfigPath = join(cwd, '.omx', 'state', 'team', 'plain-team', 'config.json');
      const before = await readFile(teamConfigPath, 'utf-8');
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      const sessions = await import('../runtime.js').then((m) => m.listRunningTeamSessions(cwd));
      assert.deepEqual(sessions, []);
      const after = await readFile(teamConfigPath, 'utf-8');
      assert.equal(after, before);
    });
  });
});
