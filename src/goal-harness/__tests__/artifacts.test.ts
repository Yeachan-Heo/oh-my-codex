import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGoalHarnessRun,
  startGoalHarnessRun,
} from '../artifacts.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('goal-harness artifacts', () => {
  it('creates a lightweight mission under shared goal workflow artifacts', async () => {
    await withTempRepo(async (cwd) => {
      const result = await createGoalHarnessRun(cwd, {
        objective: 'Build a goal-native autonomy harness with team-assisted basin escape.',
        slug: 'autonomy-harness',
        now: new Date('2026-05-29T00:00:00Z'),
      });

      assert.equal(result.run.workflow, 'goal-harness');
      assert.equal(result.run.artifactDir, '.omx/goals/goal-harness/autonomy-harness');
      assert.equal(result.missionPath, '.omx/goals/goal-harness/autonomy-harness/mission.md');
      assert.equal(result.annealing.phase, 'early');
      assert.match(result.run.objective, /Complete the user objective/);

      const mission = await readFile(join(cwd, result.missionPath), 'utf-8');
      assert.match(mission, /Refined Codex Goal Prompt/);
      assert.match(mission, /Only the leader owns the Codex goal/);
      assert.match(mission, /basin-escape/);
    });
  });

  it('emits a truthful model-facing handoff without claiming shell goal mutation', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Ship a persistent single-goal workflow.',
        slug: 'single-goal',
      });
      const result = await startGoalHarnessRun(cwd, 'single-goal', new Date('2026-05-29T00:01:00Z'));

      assert.equal(result.run.status, 'in_progress');
      assert.match(result.instruction, /call get_goal/i);
      assert.match(result.instruction, /Call create_goal only if no active goal exists/i);
      assert.match(result.instruction, /did not mutate hidden Codex goal state/i);
      assert.match(result.instruction, /late basin-escape challenge/i);
      assert.match(result.instruction, /leader is the only actor allowed/i);
    });
  });
});
