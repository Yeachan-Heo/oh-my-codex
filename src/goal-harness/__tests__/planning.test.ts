import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalHarnessRun } from '../artifacts.js';
import {
  buildGoalHarnessDeepInterview,
  buildGoalHarnessRalplan,
  writeGoalHarnessDeepInterview,
  writeGoalHarnessRalplan,
} from '../planning.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-planning-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('goal-harness intake and ralplan artifacts', () => {
  it('builds deep-interview questions for ambiguous team-assisted work', () => {
    const interview = buildGoalHarnessDeepInterview('Somehow improve the research harness with team agents and better verification.');

    assert.equal(interview.route.route, 'team_assisted');
    assert.ok(interview.route.recommendedSkills.includes('deep-interview'));
    assert.ok(interview.questions.some((question) => question.id === 'acceptance' && question.required));
    assert.ok(interview.questions.some((question) => question.id === 'non-goals' && question.required));
    assert.ok(interview.questions.some((question) => question.id === 'verification' && question.required));
    assert.ok(interview.questions.some((question) => question.id === 'team-lanes' && question.required));
  });

  it('builds ralplan candidates with critique and novelty pressure', () => {
    const plan = buildGoalHarnessRalplan('Build a long-running team-assisted research harness with verification and completion gates.');

    assert.equal(plan.route.route, 'team_assisted');
    assert.ok(plan.candidates.some((candidate) => candidate.id === 'C003-team-pressure'));
    assert.ok(plan.candidates.some((candidate) => candidate.id === 'C004-annealing-perturb' && candidate.noveltyScore >= 90));
    assert.match(plan.critique.issues.join(' '), /Do not let Team workers mutate Codex goal state/);
    assert.match(plan.critique.recommendedNextCommand, /record-trajectory/);
  });

  it('writes durable intake and plan artifacts into a goal-harness run', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Use team agents to improve a persistent research harness with verification.',
        slug: 'planning-artifacts',
        now: new Date('2026-05-29T00:00:00Z'),
      });

      const intake = await writeGoalHarnessDeepInterview(cwd, 'planning-artifacts', new Date('2026-05-29T00:01:00Z'));
      const plan = await writeGoalHarnessRalplan(cwd, 'planning-artifacts', new Date('2026-05-29T00:02:00Z'));

      assert.equal(intake.artifactPath, '.omx/goals/goal-harness/planning-artifacts/intake.md');
      assert.equal(plan.artifactPath, '.omx/goals/goal-harness/planning-artifacts/plan.md');

      const intakeMarkdown = await readFile(join(cwd, intake.artifactPath), 'utf-8');
      const planMarkdown = await readFile(join(cwd, plan.artifactPath), 'utf-8');
      assert.match(intakeMarkdown, /Goal Harness Deep Interview/);
      assert.match(planMarkdown, /Goal Harness Ralplan/);
      assert.match(planMarkdown, /Novelty-seeking annealing perturbation/);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/planning-artifacts/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"intake_emitted"/);
      assert.match(ledger, /"event":"plan_emitted"/);
    });
  });
});
