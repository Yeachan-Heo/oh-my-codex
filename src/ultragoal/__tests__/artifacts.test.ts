import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUltragoalGoal,
  buildCodexGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  isUltragoalDone,
  readUltragoalPlan,
  recordFinalReviewBlockers,
  startNextUltragoal,
} from '../artifacts.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ultragoal-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function cleanQualityGate(): object {
  return {
    aiSlopCleaner: { status: 'passed', evidence: 'ai-slop-cleaner ran on changed files' },
    verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed after cleaner' },
    codeReview: { recommendation: 'APPROVE', architectStatus: 'CLEAR', evidence: '$code-review approved with CLEAR architecture' },
  };
}

describe('ultragoal artifacts', () => {
  it('creates brief, goals, and ledger artifacts from a brief', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Build the CLI\n- Add tests\n- Write docs',
        now: new Date('2026-05-04T10:00:00Z'),
      });

      assert.equal(plan.goals.length, 3);
      assert.equal(plan.codexGoalMode, 'aggregate');
      assert.match(plan.codexObjective ?? '', /Complete all ultragoal stories/);
      assert.match(plan.codexObjective ?? '', /G001-build-the-cli/);
      assert.equal(plan.goals[0]?.id, 'G001-build-the-cli');
      assert.equal(plan.goals[0]?.status, 'pending');
      assert.equal(await readFile(join(cwd, '.omx/ultragoal/brief.md'), 'utf-8'), '- Build the CLI\n- Add tests\n- Write docs\n');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"plan_created"/);
    });
  });

  it('starts one story at a time and emits an aggregate Codex goal handoff by default', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const started = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:01:00Z') });
      assert.equal(started.goal?.id, 'G001-first');
      assert.equal(started.goal?.status, 'in_progress');
      assert.equal(started.plan.activeGoalId, 'G001-first');

      const resumed = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:02:00Z') });
      assert.equal(resumed.goal?.id, 'G001-first');
      assert.equal(resumed.resumed, true);

      const instruction = buildCodexGoalInstruction(started.goal!, started.plan);
      assert.match(instruction, /call get_goal/i);
      assert.match(instruction, /call create_goal/i);
      assert.match(instruction, /Codex goal = the whole ultragoal run/i);
      assert.match(instruction, /same aggregate objective as active/i);
      assert.match(instruction, /do not call update_goal yet/i);
      assert.doesNotMatch(instruction, /fresh Codex thread/i);
      assert.match(instruction, /--codex-goal-json/);
      assert.match(instruction, /Complete all ultragoal stories/);
      assert.match(instruction, /Complete first milestone/);
      assert.doesNotMatch(instruction, /\/goal\b/);
      assert.doesNotMatch(instruction, /\.\.\/\.\.\/codex/);
      assert.doesNotMatch(instruction, /`codex\s+goal\b/i);
    });
  });

  it('checkpoints success, advances, and supports failed-goal retry', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.codexObjective!;
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'premature aggregate completion',
          codexGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        }),
        /expected active/,
      );
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'unit tests passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });
      const second = await startNextUltragoal(cwd);
      assert.equal(second.goal?.id, 'G002-second');

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: second.goal!.id,
          status: 'complete',
          evidence: 'not final yet',
          codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
        }),
        /not complete/,
      );

      await checkpointUltragoal(cwd, { goalId: second.goal!.id, status: 'failed', evidence: 'blocked' });
      const noPending = await startNextUltragoal(cwd);
      assert.equal(noPending.goal, null);
      assert.equal(noPending.done, false);

      const retry = await startNextUltragoal(cwd, { retryFailed: true });
      assert.equal(retry.goal?.id, 'G002-second');
      assert.equal(retry.goal?.status, 'in_progress');
      assert.equal(retry.goal?.attempt, 2);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.evidence, 'unit tests passed');
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_completed"/);
      assert.match(ledger, /"event":"goal_failed"/);
      assert.match(ledger, /"event":"goal_retried"/);
    });
  });

  it('requires aggregate Codex goal completion only for the final story', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.codexObjective!;
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'first audit passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });

      const second = await startNextUltragoal(cwd);
      await checkpointUltragoal(cwd, {
        goalId: second.goal!.id,
        status: 'complete',
        evidence: 'final audit passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.every((goal) => goal.status === 'complete'), true);
      assert.equal(plan.activeGoalId, undefined);
    });
  });

  it('treats existing v1 plans without mode metadata as legacy per-story plans', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });
      delete created.codexGoalMode;
      delete created.codexObjective;
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(created, null, 2)}\n`);

      const first = await startNextUltragoal(cwd);
      const instruction = buildCodexGoalInstruction(first.goal!, first.plan);
      assert.match(instruction, /Ultragoal active-goal handoff/);
      assert.match(instruction, /fresh Codex thread/);

      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'legacy per-story audit passed',
        codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.status, 'complete');
    });
  });

  it('appends goals without changing the stored aggregate objective', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      const objective = plan.codexObjective;
      const added = await addUltragoalGoal(cwd, {
        title: 'Resolve final code-review blockers',
        objective: 'Fix review blockers and rerun final gates.',
        evidence: 'review findings',
      });

      assert.equal(added.goal.id, 'G002-resolve-final-code-review-blockers');
      assert.equal(added.goal.status, 'pending');
      assert.equal(added.plan.codexObjective, objective);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_added"/);
    });
  });

  it('records final aggregate review blockers atomically and starts the blocker next', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-review REQUEST CHANGES',
        codexGoal: { goal: { objective, status: 'active' } },
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(result.plan.activeGoalId, undefined);
      assert.equal(result.plan.codexObjective, objective);

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, result.addedGoal.id);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"final_review_failed"/);
      assert.match(ledger, /"event":"goal_review_blocked"/);
    });
  });

  it('records final per-story review blockers without claiming Codex completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers in a fresh goal context.',
        evidence: 'architect BLOCK',
        codexGoal: { goal: { objective: started.goal!.objective, status: 'active' } },
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(isUltragoalDone(result.plan), false);
    });
  });

  it('requires structured final quality gate evidence for clean completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
        }),
        /quality-gate-json|quality gate/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: { recommendation: 'COMMENT', architectStatus: 'CLEAR', evidence: 'not clean' },
          },
        }),
        /APPROVE/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            aiSlopCleaner: { status: 'not_applicable', evidence: 'skipped cleaner' },
          },
        }),
        /aiSlopCleaner\.status="passed"/,
      );

      await checkpointUltragoal(cwd, {
        goalId: started.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"qualityGate"/);
      assert.match(ledger, /"aiSlopCleaner"/);
      assert.match(ledger, /"codeReview"/);
    });
  });

  it('records a completed legacy Codex-goal blocker without failing the active ultragoal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const blocked = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence: 'completed aggregate Codex goal blocks create_goal',
        codexGoal: { goal: { objective: 'achieve all goals on this repo ultragoal status', status: 'complete' } },
        now: new Date('2026-05-04T10:03:00Z'),
      });

      assert.equal(blocked.activeGoalId, first.goal!.id);
      assert.equal(blocked.goals[0]?.status, 'in_progress');
      assert.equal(blocked.goals[0]?.failureReason, undefined);
      assert.equal(blocked.goals[0]?.failedAt, undefined);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /completed aggregate Codex goal blocks create_goal/);
    });
  });

  it('guides different completed legacy snapshots to blocked checkpoints and fresh threads', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'audit passed but wrong Codex snapshot',
          codexGoal: { goal: { objective: 'Completed legacy objective', status: 'complete' } },
        }),
        (error: unknown) => {
          assert.match(String(error), /objective mismatch/);
          assert.match(String(error), /--status blocked/);
          assert.match(String(error), /fresh Codex thread/);
          return true;
        },
      );
    });
  });

  it('rejects blocked checkpoints for active or same-objective Codex goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'active wrong goal',
          codexGoal: { goal: { objective: 'Different active work', status: 'active' } },
        }),
        /strict objective mismatch protection remains required/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'same complete goal',
          codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        }),
        /different completed legacy Codex goal/,
      );
    });
  });
});
