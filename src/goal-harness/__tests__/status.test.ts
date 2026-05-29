import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalHarnessRun } from '../artifacts.js';
import { completeGoalHarnessRun, runGoalHarnessCompletionGate } from '../completion.js';
import { writeGoalHarnessDeepInterview, writeGoalHarnessRalplan } from '../planning.js';
import { buildGoalHarnessArtifactAwareNextAction, buildGoalHarnessStatusSummary } from '../status.js';
import {
  advanceGoalHarnessPhase,
  readGoalHarnessRuntime,
  recordGoalHarnessTrajectory,
  selectGoalHarnessTrajectory,
} from '../runtime.js';
import type { CompletionGateEvidence } from '../policy.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-status-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function passingEvidence(): CompletionGateEvidence {
  return {
    actor: 'leader',
    objectiveAudit: 'All requested status-summary deliverables map to concrete artifacts.',
    implementationEvidence: ['summary stages are produced from mission/intake/plan/runtime/gate/snapshot artifacts'],
    externalVerification: [{ command: 'node --test dist/goal-harness/__tests__/status.test.js', status: 'pass', evidence: 'status summary tests pass' }],
    adversarialReview: { status: 'clear', evidence: 'No missing aggregate status stage found.' },
    convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'A heavy Ultragoal clone and a status-only shortcut were rejected in favor of a lightweight aggregate summary.' },
  };
}

describe('goal-harness aggregate status summary', () => {
  it('keeps early next actions on required intake and ralplan artifacts before trajectories', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createGoalHarnessRun(cwd, {
        objective: 'Somehow build a team-assisted goal harness with better verification and worker lanes.',
        slug: 'artifact-aware-next',
      });
      let runtime = await readGoalHarnessRuntime(cwd, 'artifact-aware-next');

      const first = buildGoalHarnessArtifactAwareNextAction(cwd, created.run, runtime);
      assert.match(first.action, /deep-interview intake/);
      assert.equal(first.recommendedCommand, 'omx goal-harness interview --slug artifact-aware-next');

      await writeGoalHarnessDeepInterview(cwd, 'artifact-aware-next');
      runtime = await readGoalHarnessRuntime(cwd, 'artifact-aware-next');
      const second = buildGoalHarnessArtifactAwareNextAction(cwd, created.run, runtime);
      assert.match(second.action, /ralplan/);
      assert.equal(second.recommendedCommand, 'omx goal-harness plan --slug artifact-aware-next');

      await writeGoalHarnessRalplan(cwd, 'artifact-aware-next');
      runtime = await readGoalHarnessRuntime(cwd, 'artifact-aware-next');
      const third = buildGoalHarnessArtifactAwareNextAction(cwd, created.run, runtime);
      assert.match(third.recommendedCommand ?? '', /record-trajectory/);
    });
  });

  it('summarizes lightweight aggregate progress across harness artifacts', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createGoalHarnessRun(cwd, {
        objective: 'Build a goal harness with aggregate status and completion reconciliation.',
        slug: 'aggregate-status',
      });
      await writeGoalHarnessDeepInterview(cwd, 'aggregate-status');
      await writeGoalHarnessRalplan(cwd, 'aggregate-status');
      const trajectory = await recordGoalHarnessTrajectory(cwd, {
        slug: 'aggregate-status',
        summary: 'Use a lightweight aggregate summary instead of heavy Ultragoal ledgers.',
        evidence: 'Keeps one top-level objective while exposing progress stages.',
        score: 91,
        noveltyScore: 62,
      });
      await recordGoalHarnessTrajectory(cwd, {
        slug: 'aggregate-status',
        summary: 'Use a heavy Ultragoal-style status ledger.',
        evidence: 'Rejected because it adds unnecessary ledger weight.',
        score: 45,
        noveltyScore: 35,
      });
      await selectGoalHarnessTrajectory(cwd, {
        slug: 'aggregate-status',
        trajectoryId: trajectory.trajectory.id,
        evidence: 'Best evidence-to-complexity tradeoff.',
      });
      await recordGoalHarnessTrajectory(cwd, {
        slug: 'aggregate-status',
        source: 'worker',
        role: 'tester',
        summary: 'Tester verified the aggregate summary path.',
        evidence: 'Status summary stages were checked before late completion.',
        score: 88,
      });
      await advanceGoalHarnessPhase(cwd, {
        slug: 'aggregate-status',
        phase: 'late',
        evidence: 'Ready for final gate.',
      });
      await runGoalHarnessCompletionGate(cwd, {
        slug: 'aggregate-status',
        evidence: passingEvidence(),
      });
      await completeGoalHarnessRun(cwd, {
        slug: 'aggregate-status',
        codexGoal: {
          available: true,
          objective: created.run.objective,
          status: 'complete',
          raw: { goal: { objective: created.run.objective, status: 'complete' } },
        },
      });

      const summary = await buildGoalHarnessStatusSummary(cwd, 'aggregate-status');

      assert.equal(summary.aggregate.workflowStatus, 'complete');
      assert.equal(summary.aggregate.active, false);
      assert.equal(summary.aggregate.completedStages, summary.aggregate.totalStages);
      assert.deepEqual(
        summary.aggregate.stages.map((stage) => [stage.id, stage.status]),
        [
          ['mission', 'complete'],
          ['intake', 'complete'],
          ['plan', 'complete'],
          ['trajectory', 'complete'],
          ['phase-pressure', 'complete'],
          ['completion-gate', 'complete'],
          ['completion-artifact', 'complete'],
          ['codex-goal', 'complete'],
          ['codex-artifact', 'complete'],
        ],
      );
      assert.match(summary.aggregate.nextAction.action, /workflow is complete/);
    });
  });
});
