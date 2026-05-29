import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGoalHarnessRun,
} from '../artifacts.js';
import {
  advanceGoalHarnessPhase,
  buildGoalHarnessNextAction,
  buildGoalHarnessTeamPlan,
  readGoalHarnessRuntime,
  recordGoalHarnessLeaderStep,
  recordGoalHarnessTrajectory,
  selectGoalHarnessTrajectory,
} from '../runtime.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-runtime-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('goal-harness runtime state', () => {
  it('initializes persistent annealing state when a harness run is created', async () => {
    await withTempRepo(async (cwd) => {
      const result = await createGoalHarnessRun(cwd, {
        objective: 'Build a team-assisted goal-native autonomy harness.',
        slug: 'runtime-init',
        now: new Date('2026-05-29T00:00:00Z'),
      });

      assert.equal(result.runtime.runtimePath, '.omx/goals/goal-harness/runtime-init/runtime.json');
      assert.equal(result.runtime.phase, 'early');
      assert.equal(result.runtime.trajectories.length, 0);
      assert.equal(result.runtime.leaderSteps.length, 0);
      assert.equal(result.runtime.teamPlans.length, 0);
      assert.equal(result.runtime.budget.alternativesRecorded, 0);

      const persisted = await readGoalHarnessRuntime(cwd, 'runtime-init');
      assert.equal(persisted.challenge.strategy, 'explore');
      assert.equal(persisted.phaseHistory[0]?.evidence, 'runtime initialized');

      const mission = await readFile(join(cwd, result.missionPath), 'utf-8');
      assert.match(mission, /runtime\.json/);
    });
  });

  it('records trajectories, selects the best evidenced path, and moves from exploration to exploitation', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Build a goal-native harness with strategy islands.',
        slug: 'trajectory-select',
      });

      const first = await recordGoalHarnessTrajectory(cwd, {
        slug: 'trajectory-select',
        source: 'worker',
        role: 'architect',
        summary: 'Use a heavy Ultragoal clone.',
        evidence: 'Rejected because it weakens the lightweight goal-native boundary.',
        score: 40,
        noveltyScore: 45,
      });
      const second = await recordGoalHarnessTrajectory(cwd, {
        slug: 'trajectory-select',
        source: 'leader',
        summary: 'Use a lightweight runtime with trajectories and gates.',
        evidence: 'Matches the single-goal boundary and supports annealing state.',
        score: 92,
        noveltyScore: 70,
      });

      assert.equal(first.trajectory.id, 'T001-use-a-heavy-ultragoal-clone');
      assert.equal(second.runtime.budget.alternativesRecorded, 2);

      const selected = await selectGoalHarnessTrajectory(cwd, {
        slug: 'trajectory-select',
        trajectoryId: second.trajectory.id,
        evidence: 'Best evidence-to-complexity tradeoff.',
        now: new Date('2026-05-29T00:02:00Z'),
      });

      assert.equal(selected.activeTrajectoryId, second.trajectory.id);
      assert.equal(selected.phase, 'middle');
      assert.equal(selected.challenge.strategy, 'exploit');
      assert.equal(selected.trajectories.find((trajectory) => trajectory.id === second.trajectory.id)?.status, 'accepted');

      const next = buildGoalHarnessNextAction(selected);
      assert.equal(next.phase, 'middle');
      assert.match(next.action, /critic\/tester pressure/);
    });
  });

  it('requires at least two early candidate trajectories before selection', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Avoid committing to the first plausible strategy.',
        slug: 'early-selection-guard',
      });
      const only = await recordGoalHarnessTrajectory(cwd, {
        slug: 'early-selection-guard',
        summary: 'First plausible path.',
        evidence: 'Looks workable but has no independent comparison yet.',
        score: 75,
      });

      await assert.rejects(
        () => selectGoalHarnessTrajectory(cwd, {
          slug: 'early-selection-guard',
          trajectoryId: only.trajectory.id,
          evidence: 'This looks good enough.',
        }),
        /at least two independent candidate trajectories/i,
      );
    });
  });

  it('requires early alternatives to carry an independence or novelty signal', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Reject shallow duplicate alternatives before selection.',
        slug: 'early-independence-guard',
      });
      const first = await recordGoalHarnessTrajectory(cwd, {
        slug: 'early-independence-guard',
        summary: 'Patch the runtime guard.',
        evidence: 'Same source and no novelty evidence.',
        score: 75,
      });
      await recordGoalHarnessTrajectory(cwd, {
        slug: 'early-independence-guard',
        summary: 'Patch the runtime guard with slightly different wording.',
        evidence: 'Same source and no novelty evidence.',
        score: 76,
      });

      await assert.rejects(
        () => selectGoalHarnessTrajectory(cwd, {
          slug: 'early-independence-guard',
          trajectoryId: first.trajectory.id,
          evidence: 'Two candidates exist, but they are not meaningfully independent.',
        }),
        /distinct source, role, or novelty evidence/i,
      );
    });
  });

  it('requires worker trajectories to include a role and candidate score', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Require scored worker evidence before trajectory selection.',
        slug: 'worker-trajectory-guards',
      });

      await assert.rejects(
        () => recordGoalHarnessTrajectory(cwd, {
          slug: 'worker-trajectory-guards',
          source: 'worker',
          summary: 'Worker evidence without a role.',
          evidence: 'Concrete evidence exists, but the worker role is missing.',
          score: 70,
        }),
        /worker role/i,
      );

      await assert.rejects(
        () => recordGoalHarnessTrajectory(cwd, {
          slug: 'worker-trajectory-guards',
          source: 'worker',
          role: 'critic',
          summary: 'Worker evidence without a candidate score.',
          evidence: 'Concrete evidence exists, but candidate scoring is missing.',
        }),
        /require a score/i,
      );

      const blocked = await recordGoalHarnessTrajectory(cwd, {
        slug: 'worker-trajectory-guards',
        source: 'worker',
        role: 'tester',
        status: 'blocked',
        summary: 'Tester could not run verification.',
        evidence: 'The test dependency is unavailable in this environment.',
      });

      assert.equal(blocked.trajectory.status, 'blocked');
      assert.equal(blocked.trajectory.score, undefined);
    });
  });

  it('advances to late phase and asks for completion-gate evidence', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Complete a persistent goal harness.',
        slug: 'late-gate',
      });
      const first = await recordGoalHarnessTrajectory(cwd, {
        slug: 'late-gate',
        summary: 'Use a minimal leader-only late gate.',
        evidence: 'Simple but lacks independent pressure.',
        score: 65,
        noveltyScore: 15,
      });
      const selected = await recordGoalHarnessTrajectory(cwd, {
        slug: 'late-gate',
        summary: 'Use selected runtime path with critic pressure.',
        evidence: 'Preserves one goal while requiring external review before late phase.',
        score: 90,
        noveltyScore: 55,
      });
      await selectGoalHarnessTrajectory(cwd, {
        slug: 'late-gate',
        trajectoryId: selected.trajectory.id,
        evidence: `Rejected ${first.trajectory.id}; selected path has stronger completion evidence.`,
      });
      await recordGoalHarnessTrajectory(cwd, {
        slug: 'late-gate',
        source: 'worker',
        role: 'critic',
        summary: 'Critic reviewed the selected late-gate path.',
        evidence: 'No missing leader-owned goal boundary was found.',
        score: 83,
      });
      const runtime = await advanceGoalHarnessPhase(cwd, {
        slug: 'late-gate',
        phase: 'late',
        evidence: 'Implementation evidence is ready for basin-escape review.',
      });

      assert.equal(runtime.phase, 'late');
      assert.equal(runtime.challenge.strategy, 'converge');
      assert.equal(runtime.budget.criticPassesUsed, 0);

      const next = buildGoalHarnessNextAction(runtime);
      assert.match(next.action, /completion gate/);
      assert.match(next.recommendedCommand ?? '', /goal-harness gate/);
      assert.match(next.recommendedCommand ?? '', /--slug late-gate/);
    });
  });

  it('rejects late phase before a selected trajectory and critic or tester pressure exist', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Reject premature late-phase convergence.',
        slug: 'premature-late',
      });

      await assert.rejects(
        () => advanceGoalHarnessPhase(cwd, {
          slug: 'premature-late',
          phase: 'late',
          evidence: 'Implementation looks done.',
        }),
        /active trajectory.*middle-phase.*critic\/tester/i,
      );
    });
  });

  it('records leader steps and moves blocked work into stuck perturbation', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Keep a long-running goal harness from silently converging.',
        slug: 'leader-step-stuck',
      });

      const result = await recordGoalHarnessLeaderStep(cwd, {
        slug: 'leader-step-stuck',
        action: 'try the selected implementation path',
        outcome: 'blocked',
        evidence: 'The same verification blocker repeated after two attempts.',
        now: new Date('2026-05-29T00:03:00Z'),
      });

      assert.equal(result.step.id, 'S001');
      assert.equal(result.step.phase, 'early');
      assert.equal(result.runtime.phase, 'stuck');
      assert.equal(result.runtime.challenge.strategy, 'perturb');
      assert.match(result.step.nextAction, /perturb/);

      const persisted = await readGoalHarnessRuntime(cwd, 'leader-step-stuck');
      assert.equal(persisted.leaderSteps.length, 1);
      assert.match(persisted.phaseHistory.at(-1)?.evidence ?? '', /leader step S001 blocked/);
    });
  });

  it('builds bounded team lane plans from the active annealing phase', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Use a team to pressure-test a goal-native harness design.',
        slug: 'team-plan',
      });

      await recordGoalHarnessLeaderStep(cwd, {
        slug: 'team-plan',
        outcome: 'needs_team_pressure',
        evidence: 'The current route needs independent architect and critic pressure before selection.',
        now: new Date('2026-05-29T00:03:00Z'),
      });

      const nextBeforePlan = buildGoalHarnessNextAction(await readGoalHarnessRuntime(cwd, 'team-plan'));
      assert.match(nextBeforePlan.recommendedCommand ?? '', /goal-harness team-plan/);

      const result = await buildGoalHarnessTeamPlan(cwd, {
        slug: 'team-plan',
        task: 'Pressure-test the candidate harness architecture.',
        now: new Date('2026-05-29T00:04:00Z'),
      });

      assert.equal(result.plan.id, 'P001-pressure-test-the-candidate-harn');
      assert.equal(result.plan.phase, 'early');
      assert.deepEqual(result.plan.lanes.map((lane) => lane.role), ['researcher', 'architect', 'critic']);
      assert.match(result.plan.launchHint, /omx team 3:executor/);
      assert.match(result.plan.lanes[0]?.instruction ?? '', /Do not call create_goal/);
      assert.match(result.plan.lanes[0]?.instruction ?? '', /Do not call update_goal/);
      assert.equal(result.runtime.teamPlans.length, 1);

      const nextAfterPlan = buildGoalHarnessNextAction(result.runtime);
      assert.match(nextAfterPlan.action, /record another independent trajectory/);
    });
  });
});
