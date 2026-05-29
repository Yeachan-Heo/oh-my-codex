import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendGoalWorkflowLedger,
  readGoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import {
  buildRefinedGoalPrompt,
} from './policy.js';
import {
  GoalHarnessRuntimeError,
  readGoalHarnessRuntime,
  writeGoalHarnessRuntime,
  type GoalHarnessPerturbationSummary,
  type GoalHarnessRuntimeState,
  type GoalHarnessTrajectory,
} from './runtime.js';

export const GOAL_HARNESS_PERTURBATION_DIR = 'perturbations';
const GOAL_HARNESS_WORKFLOW = 'goal-harness';

export interface BuildGoalHarnessPerturbationOptions {
  slug: string;
  blocker?: string;
  now?: Date;
}

export interface GoalHarnessPerturbationStrategy {
  id: string;
  label: string;
  summary: string;
  noveltyScore: number;
  evidenceToCollect: string[];
  recordCommand: string;
}

export interface GoalHarnessPerturbationArtifact {
  version: 1;
  workflow: 'goal-harness';
  slug: string;
  id: string;
  artifactPath: string;
  createdAt: string;
  phase: GoalHarnessRuntimeState['phase'];
  activeTrajectoryId?: string;
  blocker: string;
  reframePrompt: string;
  alternateStrategies: GoalHarnessPerturbationStrategy[];
  verificationProbes: string[];
  teamPlanCommand: string;
  nextAction: string;
}

export interface BuildGoalHarnessPerturbationResult {
  runtime: GoalHarnessRuntimeState;
  summary: GoalHarnessPerturbationSummary;
  artifact: GoalHarnessPerturbationArtifact;
}

function iso(now = new Date()): string {
  return now.toISOString();
}

function safeSegment(value: string, fallback: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || fallback;
}

function latestBlockedEvidence(runtime: GoalHarnessRuntimeState): string {
  const blockedStep = [...runtime.leaderSteps].reverse().find((step) => step.outcome === 'blocked');
  if (blockedStep) return blockedStep.evidence.join('; ');
  const blockedTrajectory = [...runtime.trajectories].reverse().find((trajectory) => trajectory.status === 'blocked');
  if (blockedTrajectory) return blockedTrajectory.evidence.join('; ');
  return '';
}

function activeTrajectory(runtime: GoalHarnessRuntimeState): GoalHarnessTrajectory | undefined {
  return runtime.activeTrajectoryId
    ? runtime.trajectories.find((trajectory) => trajectory.id === runtime.activeTrajectoryId)
    : undefined;
}

function nextPerturbationId(runtime: GoalHarnessRuntimeState, blocker: string): string {
  const next = runtime.perturbations.length + 1;
  return `B${String(next).padStart(3, '0')}-${safeSegment(blocker, 'perturbation')}`;
}

function recordCommand(slug: string, role: 'replanner' | 'critic' | 'tester', summary: string, noveltyScore: number): string {
  return [
    'omx goal-harness record-trajectory',
    `--slug ${slug}`,
    '--source worker',
    `--role ${role}`,
    `--summary ${JSON.stringify(summary)}`,
    '--evidence "<worker evidence>"',
    '--score <0-100>',
    `--novelty-score ${noveltyScore}`,
  ].join(' ');
}

function buildAlternateStrategies(slug: string, blocker: string, active: GoalHarnessTrajectory | undefined): GoalHarnessPerturbationStrategy[] {
  const activeSummary = active ? ` Current active trajectory: ${active.id} - ${active.summary}` : '';
  return [
    {
      id: 'A001-reframe',
      label: 'Constraint-preserving reframe',
      summary: `Restate the objective and acceptance criteria so the blocker is addressed without weakening completion requirements.${activeSummary}`,
      noveltyScore: 72,
      evidenceToCollect: [
        'new objective wording',
        'unchanged acceptance criteria',
        `why this addresses blocker: ${blocker}`,
      ],
      recordCommand: recordCommand(slug, 'replanner', 'Constraint-preserving reframe for the repeated blocker', 72),
    },
    {
      id: 'A002-distant-implementation',
      label: 'Distant implementation path',
      summary: 'Try a structurally different implementation or research path that avoids the blocked dependency or assumption.',
      noveltyScore: 88,
      evidenceToCollect: [
        'files or subsystems that would change',
        'tradeoffs against the active trajectory',
        'smallest reversible probe',
      ],
      recordCommand: recordCommand(slug, 'replanner', 'Distant implementation path that avoids the repeated blocker', 88),
    },
    {
      id: 'A003-disconfirming-probe',
      label: 'Disconfirming verification probe',
      summary: 'Attack the assumption that the current blocker is real, fatal, or on the critical path.',
      noveltyScore: 66,
      evidenceToCollect: [
        'command or inspection that could falsify the blocker',
        'expected pass/fail interpretation',
        'fallback if the blocker is confirmed',
      ],
      recordCommand: recordCommand(slug, 'tester', 'Disconfirming probe for the repeated blocker', 66),
    },
  ];
}

function renderPerturbationMarkdown(artifact: GoalHarnessPerturbationArtifact): string {
  return [
    `# Goal Harness Perturbation: ${artifact.id}`,
    '',
    `Slug: ${artifact.slug}`,
    `Phase: ${artifact.phase}`,
    `Created: ${artifact.createdAt}`,
    artifact.activeTrajectoryId ? `Active trajectory: ${artifact.activeTrajectoryId}` : 'Active trajectory: none',
    '',
    '## Blocker',
    '',
    artifact.blocker,
    '',
    '## Reframe Prompt',
    '',
    artifact.reframePrompt,
    '',
    '## Alternate Strategies',
    '',
    ...artifact.alternateStrategies.flatMap((strategy) => [
      `### ${strategy.id}: ${strategy.label}`,
      '',
      strategy.summary,
      '',
      `- novelty score: ${strategy.noveltyScore}`,
      '- evidence to collect:',
      ...strategy.evidenceToCollect.map((item) => `  - ${item}`),
      `- record command: \`${strategy.recordCommand}\``,
      '',
    ]),
    '## Verification Probes',
    '',
    ...artifact.verificationProbes.map((probe) => `- ${probe}`),
    '',
    '## Team Pressure',
    '',
    `Run: \`${artifact.teamPlanCommand}\``,
    '',
    '## Next Action',
    '',
    artifact.nextAction,
    '',
  ].join('\n');
}

export async function buildGoalHarnessPerturbation(
  cwd: string,
  options: BuildGoalHarnessPerturbationOptions,
): Promise<BuildGoalHarnessPerturbationResult> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  if (runtime.phase !== 'stuck') {
    throw new GoalHarnessRuntimeError(`Goal harness perturbation requires stuck phase; current phase is ${runtime.phase}.`);
  }

  const blocker = (options.blocker?.trim() || latestBlockedEvidence(runtime)).trim();
  if (!blocker) throw new GoalHarnessRuntimeError('Perturbation requires a blocker or prior blocked evidence.');

  const createdAt = iso(options.now);
  const id = nextPerturbationId(runtime, blocker);
  const artifactPath = `${run.artifactDir}/${GOAL_HARNESS_PERTURBATION_DIR}/${id}.md`;
  const active = activeTrajectory(runtime);
  const refined = buildRefinedGoalPrompt(run.objective);
  const artifact: GoalHarnessPerturbationArtifact = {
    version: 1,
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: run.slug,
    id,
    artifactPath,
    createdAt,
    phase: runtime.phase,
    activeTrajectoryId: runtime.activeTrajectoryId,
    blocker,
    reframePrompt: [
      'Reframe the mission without weakening acceptance criteria.',
      `Original harness objective: ${refined.objective.split('\n')[0]}`,
      `Repeated blocker: ${blocker}`,
      'Generate a path that preserves the single Codex goal, keeps worker goal mutation forbidden, and produces external verification evidence.',
    ].join('\n'),
    alternateStrategies: buildAlternateStrategies(run.slug, blocker, active),
    verificationProbes: [
      'Run or define the smallest command that can reproduce the blocker.',
      'Run or define one disconfirming probe that could prove the active trajectory is still viable.',
      'Compare the active trajectory with at least one distant alternative before returning to middle or late phase.',
      'Reject any path that removes objective audit, external verification, adversarial review, or convergence challenge requirements.',
    ],
    teamPlanCommand: `omx goal-harness team-plan --slug ${run.slug} --task ${JSON.stringify(`Run stuck perturbation ${id}: ${blocker}`)}`,
    nextAction: 'Build a stuck-phase team plan, write a team packet, import worker results, then select or reject the new trajectory with evidence.',
  };

  await mkdir(join(cwd, run.artifactDir, GOAL_HARNESS_PERTURBATION_DIR), { recursive: true });
  await writeFile(join(cwd, artifactPath), renderPerturbationMarkdown(artifact), 'utf-8');
  const summary: GoalHarnessPerturbationSummary = {
    id,
    artifactPath,
    blocker,
    activeTrajectoryId: runtime.activeTrajectoryId,
    createdAt,
  };
  runtime.perturbations.push(summary);
  runtime.updatedAt = createdAt;
  await writeGoalHarnessRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: createdAt,
    event: 'perturbation_built',
    status: run.status,
    message: `Goal harness perturbation built: ${id}`,
    evidence: blocker,
    metadata: {
      perturbationId: id,
      artifactPath,
      activeTrajectoryId: runtime.activeTrajectoryId,
      strategyCount: artifact.alternateStrategies.length,
    },
  });

  return { runtime, summary, artifact };
}
