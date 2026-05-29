import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createGoalWorkflowRun,
  readGoalWorkflowRun,
  transitionGoalWorkflowRun,
  type GoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import { buildGoalWorkflowHandoff } from '../goal-workflows/handoff.js';
import {
  buildGoalHarnessAnnealingChallenge,
  buildRefinedGoalPrompt,
  type GoalHarnessAnnealingChallenge,
  type RefinedGoalPrompt,
} from './policy.js';
import {
  GOAL_HARNESS_RUNTIME,
  initializeGoalHarnessRuntime,
  type GoalHarnessRuntimeState,
} from './runtime.js';

export const GOAL_HARNESS_WORKFLOW = 'goal-harness';
export const GOAL_HARNESS_MISSION = 'mission.md';

export interface CreateGoalHarnessRunOptions {
  objective: string;
  slug?: string;
  force?: boolean;
  now?: Date;
}

export interface GoalHarnessRunResult {
  run: GoalWorkflowRun;
  refinement: RefinedGoalPrompt;
  annealing: GoalHarnessAnnealingChallenge;
  missionPath: string;
  runtime: GoalHarnessRuntimeState;
}

function missionMarkdown(result: Omit<GoalHarnessRunResult, 'missionPath'>): string {
  const { run, refinement, annealing, runtime } = result;
  return [
    `# Goal Harness Mission: ${run.slug}`,
    '',
    '## Refined Codex Goal Prompt',
    '',
    '```text',
    refinement.objective,
    '```',
    '',
    '## Route',
    '',
    `- route: ${refinement.route.route}`,
    `- reason: ${refinement.route.reason}`,
    `- recommended skills: ${refinement.route.recommendedSkills.join(', ') || 'none'}`,
    '',
    '## Annealing Policy',
    '',
    `- phase: ${annealing.phase}`,
    `- label: ${annealing.label}`,
    `- strategy: ${annealing.strategy}`,
    `- worker lanes: ${annealing.workerLanes.join(', ')}`,
    `- stop rule: ${annealing.stopRule}`,
    `- runtime: ${runtime.runtimePath}`,
    '',
    '## Completion Boundary',
    '',
    'Only the leader owns the Codex goal. Workers must not call create_goal or update_goal. Completion requires objective audit, implementation evidence, external verification, adversarial review, and a passed basin-escape convergence challenge.',
    '',
  ].join('\n');
}

export async function createGoalHarnessRun(
  cwd: string,
  options: CreateGoalHarnessRunOptions,
): Promise<GoalHarnessRunResult> {
  const refinement = buildRefinedGoalPrompt(options.objective);
  const annealing = buildGoalHarnessAnnealingChallenge('early', refinement.route.route);
  const run = await createGoalWorkflowRun(cwd, {
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: options.slug,
    objective: refinement.objective,
    now: options.now,
    force: options.force,
    metadata: {
      rawObjective: options.objective.trim(),
      route: refinement.route,
      annealing,
    },
  });
  const runtime = await initializeGoalHarnessRuntime(cwd, run, refinement.route, annealing, options.now);
  const missionPath = `${run.artifactDir}/${GOAL_HARNESS_MISSION}`;
  await writeFile(join(cwd, missionPath), missionMarkdown({ run, refinement, annealing, runtime }), 'utf-8');
  return { run, refinement, annealing, missionPath, runtime };
}

export async function startGoalHarnessRun(
  cwd: string,
  slug: string,
  now = new Date(),
): Promise<{ run: GoalWorkflowRun; instruction: string }> {
  const existing = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
  const run = existing.status === 'pending'
    ? await transitionGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, existing.slug, {
        status: 'in_progress',
        message: 'Goal harness handoff emitted',
        now,
      })
    : existing;
  const instruction = [
    buildGoalWorkflowHandoff({
      run,
      title: 'goal-harness Codex goal handoff',
      degradedMode: true,
      completionCommand: `omx goal-harness complete --slug ${run.slug} --codex-goal-json <fresh-complete-get_goal-json-or-path>`,
    }),
    '',
    'Goal-harness execution policy:',
    '- Keep one Codex goal as the top-level objective.',
    `- Persist leader-loop search state in ${run.artifactDir}/${GOAL_HARNESS_RUNTIME}.`,
    '- Use deep-interview only when ambiguity remains material.',
    '- Use Team lanes only for evidence-producing exploration, implementation, testing, or critique.',
    '- Run a late basin-escape challenge before completion.',
    `- Persist local completion validation with: omx goal-harness gate --slug ${run.slug} --evidence-json <completion-evidence-json>.`,
    '- The leader is the only actor allowed to call update_goal({status: "complete"}).',
    `- After update_goal succeeds, call get_goal again and finish durable reconciliation with: omx goal-harness complete --slug ${run.slug} --codex-goal-json <fresh-complete-get_goal-json-or-path>.`,
  ].join('\n');
  return { run, instruction };
}
