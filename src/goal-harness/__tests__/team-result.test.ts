import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalHarnessRun } from '../artifacts.js';
import {
  buildGoalHarnessTeamPlan,
  readGoalHarnessRuntime,
  recordGoalHarnessLeaderStep,
} from '../runtime.js';
import { writeGoalHarnessTeamPacket } from '../team-packet.js';
import {
  importGoalHarnessWorkerResult,
  parseGoalHarnessWorkerResultMarkdown,
} from '../team-result.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-team-result-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function workerResult(slug: string, planId: string, role = 'critic'): string {
  return [
    '# Goal Harness Worker Result',
    '',
    `- slug: ${slug}`,
    `- plan_id: ${planId}`,
    `- role: ${role}`,
    '- status: issues',
    '- score: 77',
    '- novelty_score: 61',
    '',
    '## Summary',
    '',
    'Critic found one documentation gap but no goal ownership violation.',
    '',
    '## Evidence',
    '',
    '- Checked worker instruction packet and completion boundary text.',
    '- Confirmed the leader remains responsible for the Codex goal.',
    '',
    '## Commands',
    '',
    '- command: node --test dist/goal-harness/__tests__/team-result.test.js',
    '  status: pass',
    '  evidence: import parser test passed',
    '',
    '## Risks Or Blockers',
    '',
    '- Documentation should mention import-worker-result in the Team result flow.',
    '',
    '## Candidate Trajectory',
    '',
    'Import critic worker results as bounded trajectory evidence before late completion.',
    '',
    '## Goal Boundary Confirmation',
    '',
    '- I did not call create_goal.',
    '- I did not call update_goal.',
    '- I did not mark the whole mission complete.',
    '',
  ].join('\n');
}

describe('goal-harness team worker result import', () => {
  it('parses a worker result and imports it as a worker trajectory', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Use Team worker result evidence in a single-goal harness.',
        slug: 'result-import',
      });
      await recordGoalHarnessLeaderStep(cwd, {
        slug: 'result-import',
        outcome: 'needs_team_pressure',
        evidence: 'A critic worker should test the selected evidence path.',
      });
      const plan = await buildGoalHarnessTeamPlan(cwd, {
        slug: 'result-import',
        task: 'Critique the team evidence import flow.',
      });
      const packet = await writeGoalHarnessTeamPacket(cwd, {
        slug: 'result-import',
        planId: plan.plan.id,
      });
      const criticLane = packet.packet.lanes.find((lane) => lane.role === 'critic');
      assert.ok(criticLane);
      await writeFile(join(cwd, criticLane.resultTemplatePath), workerResult('result-import', plan.plan.id), 'utf-8');

      const parsed = parseGoalHarnessWorkerResultMarkdown(
        await readFile(join(cwd, criticLane.resultTemplatePath), 'utf-8'),
        criticLane.resultTemplatePath,
      );
      assert.equal(parsed.role, 'critic');
      assert.equal(parsed.workerStatus, 'issues');
      assert.equal(parsed.boundaryConfirmed, true);

      const imported = await importGoalHarnessWorkerResult(cwd, {
        slug: 'result-import',
        resultPath: criticLane.resultTemplatePath,
        id: 'T900-imported-critic',
        now: new Date('2026-05-29T02:00:00Z'),
      });

      assert.equal(imported.trajectory.id, 'T900-imported-critic');
      assert.equal(imported.trajectory.source, 'worker');
      assert.equal(imported.trajectory.role, 'critic');
      assert.equal(imported.trajectory.status, 'candidate');
      assert.equal(imported.trajectory.score, 77);
      assert.equal(imported.trajectory.noveltyScore, 61);
      assert.match(imported.trajectory.summary, /Import critic worker results/);
      assert.match(imported.trajectory.risk ?? '', /Documentation should mention/);

      const runtime = await readGoalHarnessRuntime(cwd, 'result-import');
      assert.equal(runtime.budget.criticPassesUsed, 1);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/result-import/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"team_result_imported"/);
      assert.match(ledger, /"trajectoryId":"T900-imported-critic"/);
    });
  });

  it('rejects worker results that do not confirm the goal ownership boundary', () => {
    const unsafe = workerResult('unsafe', 'P001-test').replace('- I did not call update_goal.\n', '');
    assert.throws(
      () => parseGoalHarnessWorkerResultMarkdown(unsafe, 'unsafe-result.md'),
      /did not call create_goal, update_goal, or mark the mission complete/,
    );
  });
});
