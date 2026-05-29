import { classifyTaskSize, type TaskSizeResult } from '../hooks/task-size-detector.js';

export type GoalHarnessRoute = 'direct' | 'goal_only' | 'plan' | 'ralph_loop' | 'team_assisted';
export type GoalHarnessPhase = 'early' | 'middle' | 'late' | 'stuck';
export type GoalHarnessWorkerRole = 'researcher' | 'implementer' | 'tester' | 'critic' | 'architect' | 'replanner';

export interface GoalHarnessRouteDecision {
  route: GoalHarnessRoute;
  taskSize: TaskSizeResult;
  ambiguityScore: number;
  riskSignals: string[];
  recommendedSkills: string[];
  reason: string;
}

export interface RefinedGoalPrompt {
  objective: string;
  route: GoalHarnessRouteDecision;
  acceptanceChecklist: string[];
  policyBullets: string[];
}

export interface GoalHarnessAnnealingChallenge {
  phase: GoalHarnessPhase;
  label: string;
  strategy: 'explore' | 'exploit' | 'converge' | 'perturb';
  maxAlternativeStrategies: number;
  maxCriticPasses: number;
  workerLanes: GoalHarnessWorkerRole[];
  requiredProbes: string[];
  stopRule: string;
}

export interface WorkerBoundaryInstructionOptions {
  role: GoalHarnessWorkerRole;
  task: string;
  context?: string;
}

export interface CompletionGateEvidence {
  actor: 'leader' | 'worker';
  objectiveAudit?: string;
  implementationEvidence?: readonly string[];
  externalVerification?: readonly {
    command?: string;
    artifactPath?: string;
    status: 'pass' | 'fail' | 'blocked';
    evidence: string;
  }[];
  adversarialReview?: {
    status: 'clear' | 'issues' | 'blocked';
    evidence: string;
  };
  convergenceChallenge?: {
    status: 'passed' | 'failed' | 'blocked';
    alternativesConsidered: number;
    evidence: string;
  };
}

export interface CompletionGateDecision {
  allowed: boolean;
  missing: string[];
  blockers: string[];
  nextAction: string;
}

const RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:security|auth|oauth|credential|secret|token|permission)\b/i, 'security-sensitive'],
  [/\b(?:migration|database|schema|data loss|backfill)\b/i, 'data-migration'],
  [/\b(?:architecture|refactor|redesign|cross-cutting|system-wide|overhaul)\b/i, 'architectural'],
  [/\b(?:release|publish|deploy|production|rollback)\b/i, 'release-sensitive'],
  [/\b(?:performance|latency|throughput|benchmark|optimizer)\b/i, 'performance-sensitive'],
  [/\b(?:research|experiment|hypothesis|model|training|evaluation)\b/i, 'research-heavy'],
];

const AMBIGUITY_PATTERNS = [
  /\b(?:maybe|probably|somehow|unclear|not sure|figure out|whatever|best|better|improve)\b/i,
  /\b(?:make it work|fix this|handle this|do the thing)\b/i,
  /\b(?:optimize|improve|polish|clean up)\b/i,
];

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).replace(/\s+\S*$/, '')}...`;
}

export function detectGoalHarnessRiskSignals(objective: string): string[] {
  const signals = RISK_PATTERNS
    .filter(([pattern]) => pattern.test(objective))
    .map(([, label]) => label);
  return [...new Set(signals)];
}

export function scoreGoalHarnessAmbiguity(objective: string): number {
  const compact = compactWhitespace(objective);
  let score = 0;
  if (compact.length < 80) score += 2;
  if (!/\b(?:test|verify|acceptance|done|success|pass|expected)\b/i.test(compact)) score += 2;
  for (const pattern of AMBIGUITY_PATTERNS) {
    if (pattern.test(compact)) score += 1;
  }
  return Math.min(score, 5);
}

export function classifyGoalHarnessRoute(objective: string): GoalHarnessRouteDecision {
  const taskSize = classifyTaskSize(objective);
  const ambiguityScore = scoreGoalHarnessAmbiguity(objective);
  const riskSignals = detectGoalHarnessRiskSignals(objective);
  const wantsTeam = /\b(?:team|parallel|workers?|agents?|multiple sessions?|strategy islands?)\b/i.test(objective);
  const wantsPersistence = /\b(?:ralph|persistent|keep going|do not stop|long-running|until complete)\b/i.test(objective);

  let route: GoalHarnessRoute = 'goal_only';
  if (!wantsTeam && !wantsPersistence && taskSize.size === 'small' && riskSignals.length === 0 && ambiguityScore <= 2) {
    route = 'direct';
  } else if (wantsTeam || (taskSize.size === 'large' && riskSignals.length >= 2)) {
    route = 'team_assisted';
  } else if (wantsPersistence || taskSize.size === 'large') {
    route = 'ralph_loop';
  } else if (ambiguityScore >= 4 || riskSignals.length > 0) {
    route = 'plan';
  }

  const recommendedSkills = route === 'direct'
    ? []
    : [
        ...(ambiguityScore >= 3 ? ['deep-interview'] : []),
        ...(route === 'plan' || route === 'ralph_loop' || route === 'team_assisted' ? ['ralplan'] : []),
        ...(route === 'ralph_loop' ? ['ralph'] : []),
        ...(route === 'team_assisted' ? ['team'] : []),
      ];

  return {
    route,
    taskSize,
    ambiguityScore,
    riskSignals,
    recommendedSkills: [...new Set(recommendedSkills)],
    reason: [
      `task=${taskSize.size}`,
      `ambiguity=${ambiguityScore}/5`,
      riskSignals.length ? `risk=${riskSignals.join(',')}` : 'risk=none',
      wantsTeam ? 'team-requested' : '',
      wantsPersistence ? 'persistence-requested' : '',
    ].filter(Boolean).join('; '),
  };
}

export function buildRefinedGoalPrompt(rawObjective: string): RefinedGoalPrompt {
  const objective = truncate(rawObjective, 1200);
  const route = classifyGoalHarnessRoute(objective);
  const acceptanceChecklist = [
    'The original user objective is restated as concrete deliverables and non-goals.',
    'Implementation evidence maps each deliverable to files, commands, tests, or artifacts.',
    'External verification passes with a concrete command or artifact path and inspected output.',
    'A basin-escape challenge compares at least two alternative strategies, adversarial critiques, and verification probes.',
    'Only the leader calls update_goal({status: "complete"}) after the completion gate passes.',
  ];
  const policyBullets = [
    'Use one Codex goal as the single top-level source of truth; do not create per-subtask Codex goals.',
    'Start with deep-interview intake when scope, non-goals, or acceptance criteria are ambiguous.',
    'Use a Ralph-style leader loop for persistent execution, and use Team workers only as evidence-producing lanes.',
    'Workers must not call create_goal or update_goal; they return evidence, diffs, risks, blockers, and test results.',
    'Treat execution as search over trajectories; prefer the current path only when it survives external evidence.',
  ];

  return {
    route,
    acceptanceChecklist,
    policyBullets,
    objective: [
      `Complete the user objective: ${objective}`,
      '',
      'Use the goal-native OMX harness policy:',
      ...policyBullets.map((line) => `- ${line}`),
      '',
      'Completion checklist:',
      ...acceptanceChecklist.map((line) => `- ${line}`),
    ].join('\n'),
  };
}

export function buildGoalHarnessAnnealingChallenge(
  phase: GoalHarnessPhase,
  route: GoalHarnessRoute = 'goal_only',
): GoalHarnessAnnealingChallenge {
  if (phase === 'early') {
    return {
      phase,
      label: 'early broad-exploration pass',
      strategy: 'explore',
      maxAlternativeStrategies: route === 'team_assisted' ? 5 : 3,
      maxCriticPasses: 1,
      workerLanes: route === 'team_assisted' ? ['researcher', 'architect', 'critic'] : ['critic'],
      requiredProbes: [
        'generate independent goal-prompt candidates',
        'identify non-goals and acceptance gaps',
        'score at least one novelty-seeking alternative',
      ],
      stopRule: 'stop exploration after a clear route and acceptance checklist exist',
    };
  }
  if (phase === 'middle') {
    return {
      phase,
      label: 'middle exploit-with-pressure pass',
      strategy: 'exploit',
      maxAlternativeStrategies: 2,
      maxCriticPasses: 2,
      workerLanes: route === 'team_assisted' ? ['implementer', 'tester', 'critic'] : ['tester', 'critic'],
      requiredProbes: [
        'compare current trajectory against one simpler alternative',
        'run targeted verification before widening scope',
        'record blocker evidence before replanning',
      ],
      stopRule: 'continue only while evidence improves or a concrete blocker is being resolved',
    };
  }
  if (phase === 'stuck') {
    return {
      phase,
      label: 'stuck perturbation pass',
      strategy: 'perturb',
      maxAlternativeStrategies: 4,
      maxCriticPasses: 2,
      workerLanes: ['replanner', 'critic', 'tester'],
      requiredProbes: [
        'reframe the objective without weakening acceptance criteria',
        'try a distant strategy from the novelty archive',
        'isolate the repeated blocker and decide whether user input is truly required',
      ],
      stopRule: 'stop perturbing after two repeated identical blockers and report the blocker plainly',
    };
  }
  return {
    phase,
    label: 'late basin-escape completion challenge',
    strategy: 'converge',
    maxAlternativeStrategies: 2,
    maxCriticPasses: 2,
    workerLanes: ['critic', 'tester', 'architect'],
    requiredProbes: [
      'attack the completion claim with missed-requirement and edge-case checks',
      'compare the current solution with an independent alternative trajectory',
      'confirm external verification covers the objective rather than only the changed code',
      'reject completion if review evidence is self-review or lacks concrete artifacts',
    ],
    stopRule: 'allow completion only if the current trajectory survives the basin-escape challenge with concrete evidence',
  };
}

export function buildWorkerBoundaryInstruction(options: WorkerBoundaryInstructionOptions): string {
  const task = truncate(options.task, 1600);
  const context = options.context ? `\nContext:\n${truncate(options.context, 1200)}\n` : '';
  return [
    `Role: ${options.role}`,
    `Assigned task: ${task}`,
    context.trimEnd(),
    'Goal ownership boundary:',
    '- You do not own the Codex goal.',
    '- Do not call create_goal.',
    '- Do not call update_goal.',
    '- Do not mark the whole mission complete.',
    '- Return evidence, diffs, risks, blockers, verification commands/results, and a candidate trajectory score.',
    '- If you find a better direction, describe it as a proposal for the leader to accept or reject.',
  ].filter(Boolean).join('\n');
}

function hasText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function textItems(value: readonly string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((item) => hasText(item)) : [];
}

function externalVerificationItems(value: CompletionGateEvidence['externalVerification'] | undefined): NonNullable<CompletionGateEvidence['externalVerification']> {
  return Array.isArray(value) ? value : [];
}

function hasConcreteVerificationTarget(item: NonNullable<CompletionGateEvidence['externalVerification']>[number]): boolean {
  return hasText(item.command) || hasText(item.artifactPath);
}

export function evaluateGoalHarnessCompletionGate(evidence: CompletionGateEvidence): CompletionGateDecision {
  const missing: string[] = [];
  const blockers: string[] = [];
  const subject = evidence && typeof evidence === 'object'
    ? evidence as Partial<CompletionGateEvidence>
    : {};

  if (subject.actor !== 'leader') {
    blockers.push('only the leader may complete the Codex goal');
  }
  if (!hasText(subject.objectiveAudit)) {
    missing.push('objective audit');
  }
  if (textItems(subject.implementationEvidence).length === 0) {
    missing.push('implementation evidence');
  }
  const externalVerification = externalVerificationItems(subject.externalVerification);
  const passingVerification = externalVerification.filter((item) => item.status === 'pass' && hasText(item.evidence));
  if (passingVerification.length === 0) {
    missing.push('passing external verification evidence');
  } else if (!passingVerification.some(hasConcreteVerificationTarget)) {
    missing.push('concrete external verification command or artifact path');
  }
  if (externalVerification.some((item) => item.status === 'fail' || item.status === 'blocked')) {
    blockers.push('external verification has failing or blocked entries');
  }
  if (!subject.adversarialReview || !hasText(subject.adversarialReview.evidence)) {
    missing.push('clear adversarial review evidence');
  } else if (subject.adversarialReview.status !== 'clear') {
    blockers.push(`adversarial review is ${subject.adversarialReview.status}`);
  }
  const convergence = subject.convergenceChallenge;
  if (
    !convergence
    || !hasText(convergence.evidence)
    || !Number.isFinite(convergence.alternativesConsidered)
    || convergence.alternativesConsidered < 2
  ) {
    missing.push('passed basin-escape convergence challenge with at least two alternatives');
  } else if (convergence.status !== 'passed') {
    blockers.push(`basin-escape convergence challenge is ${convergence.status}`);
  }

  const allowed = missing.length === 0 && blockers.length === 0;
  return {
    allowed,
    missing,
    blockers,
    nextAction: allowed
      ? 'leader may call update_goal({status: "complete"}) after capturing a fresh final goal snapshot'
      : 'continue the leader loop; resolve blockers and gather missing evidence before completion',
  };
}
