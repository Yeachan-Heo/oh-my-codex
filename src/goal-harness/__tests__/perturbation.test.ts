import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalHarnessRun } from '../artifacts.js';
import { buildGoalHarnessPerturbation } from '../perturbation.js';
import {
  buildGoalHarnessNextAction,
  buildGoalHarnessTeamPlan,
  readGoalHarnessRuntime,
  recordGoalHarnessLeaderStep,
  recordGoalHarnessTrajectory,
  selectGoalHarnessTrajectory,
} from '../runtime.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-perturbation-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('goal-harness stuck perturbations', () => {
  it('writes a basin-escape perturbation artifact and moves next action toward replanner lanes', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Recover a single-goal harness from a repeated local optimum.',
        slug: 'stuck-perturb',
      });
      const baseline = await recordGoalHarnessTrajectory(cwd, {
        slug: 'stuck-perturb',
        summary: 'Current path keeps retrying the same verification command.',
        evidence: 'The same failing command repeated twice.',
        score: 70,
        noveltyScore: 20,
      });
      const trajectory = await recordGoalHarnessTrajectory(cwd, {
        slug: 'stuck-perturb',
        summary: 'Alternate path isolates the fixture before retrying.',
        evidence: 'Different enough to compare before the initial selection.',
        score: 74,
        noveltyScore: 45,
      });
      await selectGoalHarnessTrajectory(cwd, {
        slug: 'stuck-perturb',
        trajectoryId: trajectory.trajectory.id,
        evidence: `Initially best path before the repeated blocker appeared; compared against ${baseline.trajectory.id}.`,
      });
      await recordGoalHarnessLeaderStep(cwd, {
        slug: 'stuck-perturb',
        outcome: 'blocked',
        evidence: 'Verification command still fails with the same fixture mismatch.',
      });

      const stuck = await readGoalHarnessRuntime(cwd, 'stuck-perturb');
      assert.equal(stuck.phase, 'stuck');
      assert.match(buildGoalHarnessNextAction(stuck).recommendedCommand ?? '', /goal-harness perturb/);

      const result = await buildGoalHarnessPerturbation(cwd, {
        slug: 'stuck-perturb',
        blocker: 'fixture mismatch repeats after two verified attempts',
        now: new Date('2026-05-29T03:00:00Z'),
      });

      assert.match(result.summary.id, /^B001-fixture-mismatch-repeats-after-two-verified/);
      assert.equal(result.artifact.phase, 'stuck');
      assert.equal(result.artifact.activeTrajectoryId, trajectory.trajectory.id);
      assert.equal(result.artifact.alternateStrategies.length, 3);
      assert.match(result.artifact.teamPlanCommand, /goal-harness team-plan/);
      assert.match(result.artifact.nextAction, /team plan/);

      const markdown = await readFile(join(cwd, result.summary.artifactPath), 'utf-8');
      assert.match(markdown, /Constraint-preserving reframe/);
      assert.match(markdown, /Distant implementation path/);
      assert.match(markdown, /Disconfirming verification probe/);
      assert.match(markdown, /Reject any path that removes objective audit/);

      const runtime = await readGoalHarnessRuntime(cwd, 'stuck-perturb');
      assert.equal(runtime.perturbations.length, 1);
      assert.match(buildGoalHarnessNextAction(runtime).recommendedCommand ?? '', /goal-harness team-plan/);

      const teamPlan = await buildGoalHarnessTeamPlan(cwd, {
        slug: 'stuck-perturb',
        task: `Run stuck perturbation ${result.summary.id}`,
        now: new Date('2026-05-29T03:01:00Z'),
      });
      assert.deepEqual(teamPlan.plan.lanes.map((lane) => lane.role), ['replanner', 'critic', 'tester']);
      assert.match(buildGoalHarnessNextAction(teamPlan.runtime).recommendedCommand ?? '', /import-worker-result/);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/stuck-perturb/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"perturbation_built"/);
      assert.match(ledger, /"strategyCount":3/);
    });
  });

  it('requires stuck phase before building a perturbation artifact', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Reject premature perturbation before a repeated blocker exists.',
        slug: 'not-stuck',
      });

      await assert.rejects(
        () => buildGoalHarnessPerturbation(cwd, {
          slug: 'not-stuck',
          blocker: 'not actually blocked',
        }),
        /requires stuck phase/,
      );
    });
  });
});
