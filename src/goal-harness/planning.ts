import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendGoalWorkflowLedger,
  readGoalWorkflowRun,
  type GoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import {
  buildRefinedGoalPrompt,
  classifyGoalHarnessRoute,
  type GoalHarnessRoute,
  type GoalHarnessRouteDecision,
} from './policy.js';

export const GOAL_HARNESS_INTAKE = 'intake.md';
export const GOAL_HARNESS_PLAN = 'plan.md';
const GOAL_HARNESS_WORKFLOW = 'goal-harness';

export interface GoalHarnessIntakeQuestion {
  id: string;
  prompt: string;
  reason: string;
  required: boolean;
}

export interface GoalHarnessDeepInterview {
  objective: string;
  route: GoalHarnessRouteDecision;
  questions: GoalHarnessIntakeQuestion[];
  recommendedNextCommand: string;
}

export interface GoalHarnessPlanCandidate {
  id: string;
  label: string;
  route: GoalHarnessRoute;
  summary: string;
  evidenceNeeded: string[];
  risks: string[];
  verification: string[];
  score: number;
  noveltyScore: number;
}

export interface GoalHarnessPlanCritique {
  preferredCandidateId: string;
  issues: string[];
  requiredBeforeSelection: string[];
  recommendedNextCommand: string;
}

export interface GoalHarnessRalplan {
  objective: string;
  route: GoalHarnessRouteDecision;
  candidates: GoalHarnessPlanCandidate[];
  critique: GoalHarnessPlanCritique;
  artifactPath?: string;
}

export interface GoalHarnessPlanningArtifactResult<T> {
  run: GoalWorkflowRun;
  artifactPath: string;
  artifact: T;
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function artifactObjective(run: GoalWorkflowRun): string {
  const rawObjective = typeof run.metadata?.rawObjective === 'string' ? run.metadata.rawObjective : '';
  return rawObjective.trim() || run.objective;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

export function buildGoalHarnessDeepInterview(objective: string): GoalHarnessDeepInterview {
  const route = classifyGoalHarnessRoute(objective);
  const questions: GoalHarnessIntakeQuestion[] = [
    {
      id: 'acceptance',
      prompt: 'What concrete outputs, files, commands, or behavior prove this goal is complete?',
      reason: 'The completion gate needs objective-specific evidence, not a general completion claim.',
      required: true,
    },
    {
      id: 'non-goals',
      prompt: 'What should stay explicitly out of scope even if it looks useful?',
      reason: 'A single Codex goal needs stable boundaries to avoid scope drift during long execution.',
      required: true,
    },
    {
      id: 'verification',
      prompt: 'Which external checks should the leader run or inspect before completion?',
      reason: 'Goal Harness only allows completion after passing external verification evidence.',
      required: true,
    },
  ];

  if (route.ambiguityScore >= 3) {
    questions.push({
      id: 'ambiguity',
      prompt: 'Which terms in the request are underspecified, and what default interpretation should the leader use?',
      reason: 'Deep interview should resolve material ambiguity before create_goal or major commitment.',
      required: true,
    });
  }
  if (route.riskSignals.length > 0) {
    questions.push({
      id: 'risk',
      prompt: `Which safeguards are required for these risk signals: ${route.riskSignals.join(', ')}?`,
      reason: 'Risk-sensitive goals need explicit rollback, security, data, or release boundaries.',
      required: true,
    });
  }
  if (route.route === 'team_assisted') {
    questions.push({
      id: 'team-lanes',
      prompt: 'Which work can safely be split into independent worker lanes, and what evidence should each lane return?',
      reason: 'Team workers can explore or verify trajectories, but only the leader owns the Codex goal.',
      required: true,
    });
  }
  if (route.route === 'ralph_loop' || route.route === 'team_assisted') {
    questions.push({
      id: 'persistence',
      prompt: 'What checkpoint cadence, budget signal, or stop condition should the persistent leader loop respect?',
      reason: 'Ralph-style execution needs a bounded loop contract instead of open-ended motion.',
      required: false,
    });
  }

  return {
    objective,
    route,
    questions,
    recommendedNextCommand: route.recommendedSkills.includes('deep-interview')
      ? 'answer required questions before create_goal or plan selection'
      : 'proceed to plan/refine if the defaults are acceptable',
  };
}

function candidate(
  id: string,
  label: string,
  route: GoalHarnessRoute,
  summary: string,
  score: number,
  noveltyScore: number,
  risks: string[],
  verification: string[],
): GoalHarnessPlanCandidate {
  return {
    id,
    label,
    route,
    summary,
    score,
    noveltyScore,
    risks,
    verification,
    evidenceNeeded: [
      'objective audit mapped to requested deliverables',
      'implementation or research artifact paths',
      'external verification output inspected by the leader',
      'adversarial critique before completion',
    ],
  };
}

export function buildGoalHarnessRalplan(objective: string): GoalHarnessRalplan {
  const refined = buildRefinedGoalPrompt(objective);
  const route = refined.route;
  const candidates: GoalHarnessPlanCandidate[] = [
    candidate(
      'C001-leader-minimal',
      'Leader-owned minimal goal loop',
      'goal_only',
      'Keep one Codex goal, refine the prompt, execute directly, and use the completion gate for proof.',
      route.route === 'direct' || route.route === 'goal_only' ? 88 : 72,
      25,
      ['may under-explore alternatives if ambiguity remains'],
      ['run the repository-specific test or inspection command before gate'],
    ),
    candidate(
      'C002-persistent-runtime',
      'Ralph-style persistent runtime',
      'ralph_loop',
      'Use runtime.json leader steps, trajectory selection, and phase transitions to keep long execution from ending early.',
      route.route === 'ralph_loop' ? 90 : 78,
      55,
      ['requires disciplined evidence recording to avoid noisy state'],
      ['record leader steps and verify next-action output after phase changes'],
    ),
    candidate(
      'C003-team-pressure',
      'Bounded Team pressure lanes',
      'team_assisted',
      'Use researcher/architect/critic/tester lanes for independent evidence, while the leader keeps the single Codex goal.',
      route.route === 'team_assisted' ? 92 : 70,
      70,
      ['coordination overhead can exceed value on small changes'],
      ['record worker outputs as trajectories with score, risk, and verification evidence'],
    ),
    candidate(
      'C004-annealing-perturb',
      'Novelty-seeking annealing perturbation',
      'plan',
      'Before major commitments, generate an intentionally different strategy and an adversarial critique to escape local optima.',
      route.riskSignals.length > 0 || route.ambiguityScore >= 3 ? 86 : 76,
      92,
      ['can distract from a simple verified path if used without a bounded stop rule'],
      ['compare against the active trajectory and reject unless evidence improves'],
    ),
  ];
  const preferred = [...candidates].sort((a, b) => b.score - a.score || b.noveltyScore - a.noveltyScore)[0] ?? candidates[0];
  const issues = [
    'Do not select a candidate only because it is the current trajectory.',
    'Do not let Team workers mutate Codex goal state.',
    'Do not call update_goal until the late completion gate writes a passing artifact.',
  ];
  if (route.recommendedSkills.includes('deep-interview')) {
    issues.unshift('Required intake questions should be answered before locking the plan.');
  }

  return {
    objective: refined.objective,
    route,
    candidates,
    critique: {
      preferredCandidateId: preferred.id,
      issues,
      requiredBeforeSelection: [
        'acceptance criteria and non-goals are explicit',
        'at least one alternative or critique has concrete evidence',
        'verification commands or inspection artifacts are known',
      ],
      recommendedNextCommand: `omx goal-harness record-trajectory --slug <slug> --summary ${jsonString(preferred.label)} --evidence "<why this candidate wins>" --score ${preferred.score} --novelty-score ${preferred.noveltyScore}`,
    },
  };
}

export function renderGoalHarnessDeepInterviewMarkdown(interview: GoalHarnessDeepInterview): string {
  return [
    '# Goal Harness Deep Interview',
    '',
    `Route: ${interview.route.route}`,
    `Reason: ${interview.route.reason}`,
    `Recommended next: ${interview.recommendedNextCommand}`,
    '',
    '## Questions',
    '',
    ...interview.questions.flatMap((question) => [
      `### ${question.id}`,
      '',
      question.prompt,
      '',
      `- required: ${question.required ? 'yes' : 'no'}`,
      `- reason: ${question.reason}`,
      '',
    ]),
  ].join('\n');
}

export function renderGoalHarnessRalplanMarkdown(plan: GoalHarnessRalplan): string {
  return [
    '# Goal Harness Ralplan',
    '',
    `Route: ${plan.route.route}`,
    `Reason: ${plan.route.reason}`,
    '',
    '## Candidates',
    '',
    ...plan.candidates.flatMap((candidatePlan) => [
      `### ${candidatePlan.id}: ${candidatePlan.label}`,
      '',
      candidatePlan.summary,
      '',
      `- route: ${candidatePlan.route}`,
      `- score: ${candidatePlan.score}`,
      `- novelty score: ${candidatePlan.noveltyScore}`,
      `- risks: ${candidatePlan.risks.join('; ')}`,
      `- verification: ${candidatePlan.verification.join('; ')}`,
      `- evidence needed: ${candidatePlan.evidenceNeeded.join('; ')}`,
      '',
    ]),
    '## Critique',
    '',
    `Preferred candidate: ${plan.critique.preferredCandidateId}`,
    '',
    'Issues:',
    ...plan.critique.issues.map((issue) => `- ${issue}`),
    '',
    'Required before selection:',
    ...plan.critique.requiredBeforeSelection.map((item) => `- ${item}`),
    '',
    `Next command: ${plan.critique.recommendedNextCommand}`,
    '',
  ].join('\n');
}

export async function writeGoalHarnessDeepInterview(
  cwd: string,
  slug: string,
  now = new Date(),
): Promise<GoalHarnessPlanningArtifactResult<GoalHarnessDeepInterview>> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
  const artifact = buildGoalHarnessDeepInterview(artifactObjective(run));
  const artifactPath = `${run.artifactDir}/${GOAL_HARNESS_INTAKE}`;
  await writeFile(join(cwd, artifactPath), renderGoalHarnessDeepInterviewMarkdown(artifact), 'utf-8');
  await appendGoalWorkflowLedger(cwd, run, {
    ts: nowIso(now),
    event: 'intake_emitted',
    status: run.status,
    message: 'Goal harness deep-interview intake emitted',
    metadata: {
      artifactPath,
      route: artifact.route.route,
      questionCount: artifact.questions.length,
      requiredQuestionCount: artifact.questions.filter((question) => question.required).length,
    },
  });
  return { run, artifactPath, artifact };
}

export async function writeGoalHarnessRalplan(
  cwd: string,
  slug: string,
  now = new Date(),
): Promise<GoalHarnessPlanningArtifactResult<GoalHarnessRalplan>> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
  const artifactPath = `${run.artifactDir}/${GOAL_HARNESS_PLAN}`;
  const artifact = { ...buildGoalHarnessRalplan(artifactObjective(run)), artifactPath };
  await writeFile(join(cwd, artifactPath), renderGoalHarnessRalplanMarkdown(artifact), 'utf-8');
  await appendGoalWorkflowLedger(cwd, run, {
    ts: nowIso(now),
    event: 'plan_emitted',
    status: run.status,
    message: 'Goal harness ralplan emitted',
    metadata: {
      artifactPath,
      route: artifact.route.route,
      candidateCount: artifact.candidates.length,
      preferredCandidateId: artifact.critique.preferredCandidateId,
    },
  });
  return { run, artifactPath, artifact };
}
