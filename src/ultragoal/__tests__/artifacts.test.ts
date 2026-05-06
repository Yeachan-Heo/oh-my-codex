import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCodexGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  readUltragoalPlan,
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

describe('ultragoal artifacts', () => {
  it('creates brief, goals, and ledger artifacts from a brief', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Build the CLI\n- Add tests\n- Write docs',
        now: new Date('2026-05-04T10:00:00Z'),
      });

      assert.equal(plan.goals.length, 3);
      assert.equal(plan.goals[0]?.id, 'G001-build-the-cli');
      assert.equal(plan.goals[0]?.status, 'pending');
      assert.equal(await readFile(join(cwd, '.omx/ultragoal/brief.md'), 'utf-8'), '- Build the CLI\n- Add tests\n- Write docs\n');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"plan_created"/);
    });
  });

  it('starts one goal at a time and emits a Codex goal handoff', async () => {
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
      assert.match(instruction, /different completed legacy\/thread goal/i);
      assert.match(instruction, /fresh Codex thread/i);
      assert.match(instruction, /--status blocked/);
      assert.match(instruction, /update_goal\(\{status: "complete"\}\)/);
      assert.match(instruction, /--codex-goal-json/);
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
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'unit tests passed',
        codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
      });
      const second = await startNextUltragoal(cwd);
      assert.equal(second.goal?.id, 'G002-second');

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

  it('records a completed legacy Codex-goal blocker without failing the active ultragoal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
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

  it('rejects blocked checkpoints for active or same-objective Codex goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
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
