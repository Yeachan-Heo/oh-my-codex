import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGoalWorkflowRun } from '../../goal-workflows/artifacts.js';
import { createGoalHarnessRun } from '../artifacts.js';
import {
  completeGoalHarnessRun,
  GOAL_HARNESS_CODEX_GOAL_STATUS,
  runGoalHarnessCompletionGate,
  syncGoalHarnessCodexGoalSnapshot,
} from '../completion.js';
import {
  advanceGoalHarnessPhase,
  buildGoalHarnessNextAction,
  readGoalHarnessRuntime,
  recordGoalHarnessTrajectory,
  selectGoalHarnessTrajectory,
} from '../runtime.js';
import type { CompletionGateEvidence } from '../policy.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-completion-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function passingEvidence(): CompletionGateEvidence {
  return {
    actor: 'leader',
    objectiveAudit: 'Every requested deliverable maps to implementation and verification evidence.',
    implementationEvidence: ['src/goal-harness/completion.ts records the completion gate artifact.'],
    externalVerification: [{ command: 'node --test dist/goal-harness/__tests__/completion.test.js', status: 'pass', evidence: 'completion tests pass' }],
    adversarialReview: { status: 'clear', evidence: 'Late review found no missing gate requirement.' },
    convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'A non-runtime gate and a heavy Ultragoal clone were considered and rejected.' },
  };
}

async function advanceLateReady(cwd: string, slug: string): Promise<void> {
  const first = await recordGoalHarnessTrajectory(cwd, {
    slug,
    summary: 'Minimal completion path.',
    evidence: 'Simple but lacks independent pressure.',
    score: 70,
    noveltyScore: 15,
  });
  const selected = await recordGoalHarnessTrajectory(cwd, {
    slug,
    summary: 'Completion path with critic pressure.',
    evidence: 'Keeps one Codex goal while requiring review before late gate.',
    score: 91,
    noveltyScore: 55,
  });
  await selectGoalHarnessTrajectory(cwd, {
    slug,
    trajectoryId: selected.trajectory.id,
    evidence: `Selected over ${first.trajectory.id} because it has stronger gate evidence.`,
  });
  await recordGoalHarnessTrajectory(cwd, {
    slug,
    source: 'worker',
    role: 'critic',
    summary: 'Critic checked late completion evidence.',
    evidence: 'Objective audit and completion boundary were reviewed.',
    score: 84,
  });
  await advanceGoalHarnessPhase(cwd, {
    slug,
    phase: 'late',
    evidence: 'Implementation and verification evidence are ready.',
  });
}

describe('goal-harness completion gate artifacts', () => {
  it('syncs active Codex goal snapshots with token budget without marking the harness complete', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createGoalHarnessRun(cwd, {
        objective: 'Track active goal-mode token budget during a long-running harness.',
        slug: 'active-snapshot',
      });

      const result = await syncGoalHarnessCodexGoalSnapshot(cwd, {
        slug: 'active-snapshot',
        codexGoal: {
          available: true,
          objective: created.run.objective,
          status: 'active',
          tokenBudget: 50000,
          remainingTokens: 32000,
          raw: { goal: { objective: created.run.objective, status: 'active', token_budget: 50000 }, remainingTokens: 32000 },
        },
        evidence: 'Leader called get_goal after a long-running checkpoint.',
        now: new Date('2026-05-29T00:04:00Z'),
      });

      assert.equal(result.reconciliation.ok, true);
      assert.equal(result.record.kind, 'status');
      assert.equal(result.record.artifactPath, `.omx/goals/goal-harness/active-snapshot/${GOAL_HARNESS_CODEX_GOAL_STATUS}`);

      const artifact = JSON.parse(await readFile(join(cwd, result.record.artifactPath), 'utf-8')) as { kind: string; snapshot: { tokenBudget: number; remainingTokens: number } };
      assert.equal(artifact.kind, 'status');
      assert.equal(artifact.snapshot.tokenBudget, 50000);
      assert.equal(artifact.snapshot.remainingTokens, 32000);

      const runtime = await readGoalHarnessRuntime(cwd, 'active-snapshot');
      assert.equal(runtime.lastCodexGoalSnapshot?.kind, 'status');
      assert.equal(runtime.lastCodexGoalSnapshot?.status, 'active');
      assert.equal(runtime.lastCodexGoalSnapshot?.tokenBudget, 50000);
      assert.doesNotMatch(buildGoalHarnessNextAction(runtime).action, /workflow is complete/);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/active-snapshot/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"codex_goal_snapshot_synced"/);
    });
  });

  it('flags premature complete Codex snapshots before local validation passes', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createGoalHarnessRun(cwd, {
        objective: 'Reject premature goal-mode completion.',
        slug: 'premature-goal-complete',
      });

      const result = await syncGoalHarnessCodexGoalSnapshot(cwd, {
        slug: 'premature-goal-complete',
        codexGoal: {
          available: true,
          objective: created.run.objective,
          status: 'complete',
          raw: { goal: { objective: created.run.objective, status: 'complete' } },
        },
      });

      assert.equal(result.reconciliation.ok, false);
      assert.match(result.reconciliation.errors.join(' '), /status mismatch/);
      const runtime = await readGoalHarnessRuntime(cwd, 'premature-goal-complete');
      assert.equal(runtime.lastCodexGoalSnapshot?.reconciliationOk, false);
      assert.match(buildGoalHarnessNextAction(runtime).action, /snapshot mismatch/);
    });
  });

  it('persists a passing late completion gate and marks local workflow validation passed', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Complete a goal-native harness with durable completion validation.',
        slug: 'completion-pass',
      });
      await advanceLateReady(cwd, 'completion-pass');

      const result = await runGoalHarnessCompletionGate(cwd, {
        slug: 'completion-pass',
        evidence: passingEvidence(),
        now: new Date('2026-05-29T00:05:00Z'),
      });

      assert.equal(result.decision.allowed, true);
      assert.equal(result.run.status, 'validation_passed');
      assert.equal(result.record.artifactPath, '.omx/goals/goal-harness/completion-pass/completion-gate.json');
      assert.equal(result.record.runtimePhase, 'late');

      const artifact = JSON.parse(await readFile(join(cwd, result.record.artifactPath), 'utf-8')) as { allowed: boolean };
      assert.equal(artifact.allowed, true);

      const runtime = await readGoalHarnessRuntime(cwd, 'completion-pass');
      assert.equal(runtime.lastCompletionGate?.allowed, true);
      assert.equal(runtime.lastCompletionGate?.artifactPath, result.record.artifactPath);
      assert.match(buildGoalHarnessNextAction(runtime).recommendedCommand ?? '', /goal-harness complete/);

      const run = await readGoalWorkflowRun(cwd, 'goal-harness', 'completion-pass');
      assert.equal(run.validation?.artifactPath, result.record.artifactPath);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/completion-pass/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"completion_gate_passed"/);
      assert.match(ledger, /"event":"validation_passed"/);
    });
  });

  it('requires a fresh complete Codex goal snapshot before marking the workflow complete', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createGoalHarnessRun(cwd, {
        objective: 'Complete a goal-native harness with Codex snapshot reconciliation.',
        slug: 'completion-reconcile',
      });
      await advanceLateReady(cwd, 'completion-reconcile');
      await runGoalHarnessCompletionGate(cwd, {
        slug: 'completion-reconcile',
        evidence: passingEvidence(),
      });

      await assert.rejects(
        () => completeGoalHarnessRun(cwd, {
          slug: 'completion-reconcile',
          codexGoal: { available: true, objective: created.run.objective, status: 'active', raw: {} },
        }),
        /not complete/,
      );

      const result = await completeGoalHarnessRun(cwd, {
        slug: 'completion-reconcile',
        codexGoal: {
          available: true,
          objective: created.run.objective,
          status: 'complete',
          tokenBudget: 12345,
          remainingTokens: 678,
          raw: { goal: { objective: created.run.objective, status: 'complete', token_budget: 12345 }, remainingTokens: 678 },
        },
        evidence: 'Fresh get_goal snapshot after update_goal matched the harness objective.',
        now: new Date('2026-05-29T00:07:00Z'),
      });

      assert.equal(result.run.status, 'complete');
      assert.equal(result.record.artifactPath, '.omx/goals/goal-harness/completion-reconcile/codex-goal-snapshot.json');
      assert.equal(result.record.reconciliation.ok, true);

      const artifact = JSON.parse(await readFile(join(cwd, result.record.artifactPath), 'utf-8')) as { reconciliation: { ok: boolean } };
      assert.equal(artifact.reconciliation.ok, true);

      const runtime = await readGoalHarnessRuntime(cwd, 'completion-reconcile');
      assert.equal(runtime.lastCodexGoalSnapshot?.status, 'complete');
      assert.equal(runtime.lastCodexGoalSnapshot?.tokenBudget, 12345);
      assert.equal(runtime.lastCodexGoalSnapshot?.remainingTokens, 678);
      assert.match(buildGoalHarnessNextAction(runtime).action, /workflow is complete/);
    });
  });

  it('persists a failed gate without advancing validation when runtime is not late', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Reject completion claims before late phase.',
        slug: 'completion-early',
      });

      const result = await runGoalHarnessCompletionGate(cwd, {
        slug: 'completion-early',
        evidence: passingEvidence(),
        now: new Date('2026-05-29T00:06:00Z'),
      });

      assert.equal(result.decision.allowed, false);
      assert.match(result.decision.blockers.join(' '), /requires late phase/);
      assert.equal(result.run.status, 'pending');
      assert.equal(result.record.allowed, false);

      const runtime = await readGoalHarnessRuntime(cwd, 'completion-early');
      assert.equal(runtime.lastCompletionGate?.allowed, false);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/completion-early/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"completion_gate_failed"/);
      assert.doesNotMatch(ledger, /"event":"validation_passed"/);
    });
  });
});
