import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGoalWorkflowRun } from '../../goal-workflows/artifacts.js';
import {
  createGoalHarnessRun,
  startGoalHarnessRun,
} from '../artifacts.js';
import { completeGoalHarnessRun, runGoalHarnessCompletionGate } from '../completion.js';
import { writeGoalHarnessDeepInterview, writeGoalHarnessRalplan } from '../planning.js';
import type { CompletionGateEvidence } from '../policy.js';
import {
  buildGoalHarnessNextAction,
  buildGoalHarnessTeamPlan,
  readGoalHarnessRuntime,
  recordGoalHarnessLeaderStep,
  recordGoalHarnessTrajectory,
  selectGoalHarnessTrajectory,
} from '../runtime.js';
import { buildGoalHarnessStatusSummary } from '../status.js';
import { writeGoalHarnessTeamPacket } from '../team-packet.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-lifecycle-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function passingEvidence(command: string): CompletionGateEvidence {
  return {
    actor: 'leader',
    objectiveAudit: 'The lifecycle test covers mission, intake, ralplan, trajectory selection, team pressure, late gate, and Codex snapshot reconciliation.',
    implementationEvidence: [
      'src/goal-harness/runtime.ts records trajectories, leader steps, and team plans.',
      'src/goal-harness/completion.ts requires a passing local gate before Codex snapshot completion.',
    ],
    externalVerification: [{ command, status: 'pass', evidence: 'Focused goal-harness lifecycle test passed.' }],
    adversarialReview: { status: 'clear', evidence: 'Worker boundary and late completion checks were inspected in the lifecycle path.' },
    convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'A direct path and a Team-pressure path were compared before accepting completion.' },
  };
}

describe('goal-harness lifecycle', () => {
  it('runs a leader-owned goal harness from intake through completion reconciliation', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createGoalHarnessRun(cwd, {
        objective: 'Build a Codex goal-native autonomy harness with Team workers, persistent execution, verification, and late completion evidence.',
        slug: 'full-lifecycle',
        now: new Date('2026-05-29T00:00:00Z'),
      });
      const started = await startGoalHarnessRun(cwd, 'full-lifecycle', new Date('2026-05-29T00:01:00Z'));
      const intake = await writeGoalHarnessDeepInterview(cwd, 'full-lifecycle', new Date('2026-05-29T00:02:00Z'));
      const plan = await writeGoalHarnessRalplan(cwd, 'full-lifecycle', new Date('2026-05-29T00:03:00Z'));

      assert.equal(started.run.status, 'in_progress');
      assert.match(started.instruction, /single top-level/i);
      assert.equal(intake.artifact.questions.some((question) => question.id === 'team-lanes'), true);
      assert.equal(plan.artifact.candidates.some((candidate) => candidate.id === 'C003-team-pressure'), true);

      const minimal = await recordGoalHarnessTrajectory(cwd, {
        slug: 'full-lifecycle',
        summary: 'Leader-only minimal runtime path.',
        evidence: 'Smallest state surface, but weaker independent pressure before completion.',
        score: 78,
        noveltyScore: 30,
        now: new Date('2026-05-29T00:04:00Z'),
      });
      const teamPressure = await recordGoalHarnessTrajectory(cwd, {
        slug: 'full-lifecycle',
        summary: 'Team-pressure runtime with critic and tester lanes.',
        evidence: 'Keeps one Codex goal while collecting independent evidence before late completion.',
        score: 91,
        noveltyScore: 72,
        now: new Date('2026-05-29T00:05:00Z'),
      });
      await selectGoalHarnessTrajectory(cwd, {
        slug: 'full-lifecycle',
        trajectoryId: teamPressure.trajectory.id,
        evidence: 'Best verified path because it preserves one goal and adds independent pressure.',
        now: new Date('2026-05-29T00:06:00Z'),
      });

      assert.match(buildGoalHarnessNextAction(await readGoalHarnessRuntime(cwd, 'full-lifecycle')).action, /critic\/tester pressure/);

      await recordGoalHarnessLeaderStep(cwd, {
        slug: 'full-lifecycle',
        action: 'Implement selected runtime and identify missing independent evidence.',
        outcome: 'needs_team_pressure',
        evidence: 'Selected implementation path needs critic and tester pressure before late completion.',
        now: new Date('2026-05-29T00:07:00Z'),
      });
      const nextAfterStep = buildGoalHarnessNextAction(await readGoalHarnessRuntime(cwd, 'full-lifecycle'));
      assert.match(nextAfterStep.recommendedCommand ?? '', /team-plan/);

      const teamPlan = await buildGoalHarnessTeamPlan(cwd, {
        slug: 'full-lifecycle',
        task: 'Pressure-test the selected goal-harness trajectory before late completion.',
        now: new Date('2026-05-29T00:08:00Z'),
      });
      assert.deepEqual(teamPlan.plan.lanes.map((lane) => lane.role), ['implementer', 'tester', 'critic']);
      for (const lane of teamPlan.plan.lanes) {
        assert.match(lane.instruction, /You do not own the Codex goal/);
        assert.match(lane.instruction, /Do not call create_goal/);
        assert.match(lane.instruction, /Do not call update_goal/);
      }
      const packet = await writeGoalHarnessTeamPacket(cwd, {
        slug: 'full-lifecycle',
        planId: teamPlan.plan.id,
        now: new Date('2026-05-29T00:08:30Z'),
      });
      assert.match(packet.packet.teamLaunchCommand, /omx team 3:executor/);
      assert.equal(packet.packet.lanes.every((lane) => lane.recordTrajectoryCommand.includes('--source worker')), true);

      await recordGoalHarnessTrajectory(cwd, {
        slug: 'full-lifecycle',
        source: 'worker',
        role: 'critic',
        summary: 'Critic pass found no missing single-goal ownership boundary.',
        evidence: 'Reviewed worker instructions and completion policy boundaries.',
        score: 82,
        noveltyScore: 45,
        now: new Date('2026-05-29T00:09:00Z'),
      });
      await recordGoalHarnessTrajectory(cwd, {
        slug: 'full-lifecycle',
        source: 'worker',
        role: 'critic',
        summary: 'Second critic pass checked late gate evidence requirements.',
        evidence: 'Confirmed objective audit, implementation evidence, external verification, adversarial review, and convergence challenge are required.',
        score: 86,
        noveltyScore: 50,
        now: new Date('2026-05-29T00:10:00Z'),
      });
      await recordGoalHarnessLeaderStep(cwd, {
        slug: 'full-lifecycle',
        action: 'Prepare the final completion gate after bounded critic pressure.',
        outcome: 'ready_for_late_gate',
        evidence: 'Implementation evidence is present and two critic passes are recorded.',
        now: new Date('2026-05-29T00:11:00Z'),
      });

      const gate = await runGoalHarnessCompletionGate(cwd, {
        slug: 'full-lifecycle',
        evidence: passingEvidence('node --test dist/goal-harness/__tests__/lifecycle.test.js'),
        now: new Date('2026-05-29T00:12:00Z'),
      });
      assert.equal(gate.decision.allowed, true);
      assert.equal(gate.run.status, 'validation_passed');

      const completed = await completeGoalHarnessRun(cwd, {
        slug: 'full-lifecycle',
        codexGoal: {
          available: true,
          objective: created.run.objective,
          status: 'complete',
          tokenBudget: 100000,
          remainingTokens: 42000,
          raw: { goal: { objective: created.run.objective, status: 'complete', token_budget: 100000 }, remainingTokens: 42000 },
        },
        evidence: 'Fresh get_goal snapshot after leader-owned update_goal matched the harness objective.',
        now: new Date('2026-05-29T00:13:00Z'),
      });

      assert.equal(completed.run.status, 'complete');
      assert.equal(completed.runtime.activeTrajectoryId, teamPressure.trajectory.id);
      assert.equal(completed.runtime.lastCodexGoalSnapshot?.remainingTokens, 42000);

      const summary = await buildGoalHarnessStatusSummary(cwd, 'full-lifecycle');
      assert.equal(summary.aggregate.completedStages, summary.aggregate.totalStages);
      assert.equal(summary.aggregate.nextAction.recommendedCommand, undefined);
      assert.match(summary.aggregate.nextAction.action, /workflow is complete/);

      const workflow = await readGoalWorkflowRun(cwd, 'goal-harness', 'full-lifecycle');
      assert.equal(workflow.status, 'complete');
      assert.equal(workflow.metadata?.route && typeof workflow.metadata.route === 'object' && 'route' in workflow.metadata.route ? workflow.metadata.route.route : undefined, 'team_assisted');

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/full-lifecycle/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"intake_emitted"/);
      assert.match(ledger, /"event":"plan_emitted"/);
      assert.match(ledger, /"event":"team_plan_built"/);
      assert.match(ledger, /"event":"team_packet_built"/);
      assert.match(ledger, /"event":"completion_gate_passed"/);
      assert.match(ledger, /"event":"goal_completed"/);
      assert.notEqual(minimal.trajectory.id, teamPressure.trajectory.id);
    });
  });
});
