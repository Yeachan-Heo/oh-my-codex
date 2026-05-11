import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canTransitionRuningTeamStatus,
  createCriticVerdict,
  createFinalSynthesis,
  createPlannerRevision,
  createRuningTeamSession,
  ingestTeamEvidence,
  createCheckpoint,
  transitionRuningTeamStatus,
  validateCriticVerdict,
  validatePlannerRevision,
} from '../controller.js';

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-runingteam-'));
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  try {
    await fn(cwd);
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

async function writeTeamEvidence(cwd: string): Promise<void> {
  const teamDir = join(cwd, '.omx', 'state', 'team', 'alpha');
  await mkdir(join(teamDir, 'events'), { recursive: true });
  await mkdir(join(teamDir, 'tasks'), { recursive: true });
  await writeFile(join(teamDir, 'tasks', 'task-1.json'), JSON.stringify({
    id: '1',
    subject: 'execution lane',
    description: 'implementation',
    status: 'completed',
    result: 'Implemented controller\nFiles changed: src/runingteam/controller.ts\nCommands: npm run build, node --test dist/runingteam/__tests__/controller.test.js',
  }, null, 2));
  await writeFile(join(teamDir, 'events', 'events.ndjson'), `${JSON.stringify({
    event_id: 'evt-1',
    team: 'alpha',
    type: 'task_completed',
    worker: 'worker-1',
    task_id: '1',
    created_at: '2026-05-09T00:00:00.000Z',
  })}\n`);
}

describe('RuningTeam controller', () => {
  it('enforces lifecycle transitions and final-synthesis completion gate', async () => {
    await withTempCwd(async (cwd) => {
      await createRuningTeamSession(cwd, { sessionId: 'sess1', task: 'example' });
      assert.equal(canTransitionRuningTeamStatus('planning', 'executing'), true);
      assert.equal(canTransitionRuningTeamStatus('executing', 'revising'), false);
      await transitionRuningTeamStatus(cwd, 'sess1', 'executing');
      await assert.rejects(
        () => transitionRuningTeamStatus(cwd, 'sess1', 'complete'),
        /complete requires final-synthesis\.md|invalid RuningTeam transition/,
      );
    });
  });

  it('validates critic verdict and planner revision contracts', () => {
    assert.throws(() => validateCriticVerdict({ verdict: 'ITERATE_PLAN', required_changes: [] }), /required_changes/);
    assert.throws(() => validateCriticVerdict({ verdict: 'REJECT_BATCH', rejected_claims: [] }), /rejected_claims/);
    assert.throws(
      () => validatePlannerRevision({ from_plan_version: 1, to_plan_version: 2, preserved_acceptance_criteria: false }),
      /preserved_acceptance_criteria/,
    );
  });

  it('ingests team evidence, writes checkpoint, verdict, revision, and preserves criteria', async () => {
    await withTempCwd(async (cwd) => {
      await createRuningTeamSession(cwd, { sessionId: 'sess2', task: 'example', teamName: 'alpha' });
      await writeTeamEvidence(cwd);
      const evidence = await ingestTeamEvidence(cwd, 'sess2');
      assert.equal(evidence.length, 1);
      assert.deepEqual(evidence[0].files_changed, ['src/runingteam/controller.ts']);

      const checkpoint = await createCheckpoint(cwd, 'sess2');
      assert.equal(checkpoint.evidence_count, 1);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'runingteam', 'sess2', 'iterations', '1', 'checkpoint.md')), true);

      const verdict = await createCriticVerdict(cwd, 'sess2', {
        verdict: 'ITERATE_PLAN',
        required_changes: ['add focused tests'],
      });
      assert.equal(verdict.verdict, 'ITERATE_PLAN');

      const revision = await createPlannerRevision(cwd, 'sess2');
      assert.equal(revision.from_plan_version, 1);
      assert.equal(revision.to_plan_version, 2);
      assert.equal(revision.preserved_acceptance_criteria, true);
    });
  });

  it('creates final synthesis only after FINAL_SYNTHESIS_READY and then allows completion', async () => {
    await withTempCwd(async (cwd) => {
      const { plan } = await createRuningTeamSession(cwd, { sessionId: 'sess3', task: 'example', teamName: 'alpha' });
      await writeTeamEvidence(cwd);
      await ingestTeamEvidence(cwd, 'sess3');
      await createCheckpoint(cwd, 'sess3');
      await createCriticVerdict(cwd, 'sess3', {
        verdict: 'FINAL_SYNTHESIS_READY',
        acceptance_criteria_evidence: Object.fromEntries(plan.acceptance_criteria.map((criterion) => [criterion, ['worker-1/task-1']])),
      });
      await createFinalSynthesis(cwd, 'sess3');
      const synthesisPath = join(cwd, '.omx', 'state', 'runingteam', 'sess3', 'final-synthesis.md');
      assert.equal(existsSync(synthesisPath), true);
      assert.match(await readFile(synthesisPath, 'utf-8'), /RuningTeam Final Synthesis/);
      const complete = await transitionRuningTeamStatus(cwd, 'sess3', 'complete');
      assert.equal(complete.status, 'complete');
    });
  });
});
