import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendGoalWorkflowLedger,
  readGoalWorkflowRun,
  type GoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import {
  buildGoalHarnessAnnealingChallenge,
  buildWorkerBoundaryInstruction,
  type GoalHarnessAnnealingChallenge,
  type GoalHarnessPhase,
  type GoalHarnessRouteDecision,
  type GoalHarnessWorkerRole,
} from './policy.js';

export const GOAL_HARNESS_RUNTIME = 'runtime.json';
const GOAL_HARNESS_WORKFLOW = 'goal-harness';

export type GoalHarnessTrajectorySource = 'leader' | 'worker';
export type GoalHarnessTrajectoryStatus = 'candidate' | 'accepted' | 'rejected' | 'blocked';
export type GoalHarnessLeaderStepOutcome = 'progress' | 'blocked' | 'ready_for_late_gate' | 'needs_team_pressure';

export interface GoalHarnessTrajectory {
  id: string;
  source: GoalHarnessTrajectorySource;
  role?: GoalHarnessWorkerRole;
  summary: string;
  evidence: string[];
  score?: number;
  noveltyScore?: number;
  risk?: string;
  status: GoalHarnessTrajectoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoalHarnessPhaseRecord {
  phase: GoalHarnessPhase;
  enteredAt: string;
  evidence?: string;
}

export interface GoalHarnessLeaderStep {
  id: string;
  phase: GoalHarnessPhase;
  action: string;
  outcome: GoalHarnessLeaderStepOutcome;
  evidence: string[];
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalHarnessTeamLanePlan {
  role: GoalHarnessWorkerRole;
  task: string;
  instruction: string;
  expectedEvidence: string[];
}

export interface GoalHarnessTeamPlan {
  id: string;
  phase: GoalHarnessPhase;
  task: string;
  lanes: GoalHarnessTeamLanePlan[];
  launchHint: string;
  packetPath?: string;
  packetManifestPath?: string;
  createdAt: string;
}

export interface GoalHarnessPerturbationSummary {
  id: string;
  artifactPath: string;
  blocker: string;
  activeTrajectoryId?: string;
  createdAt: string;
}

export interface GoalHarnessCompletionGateSummary {
  artifactPath: string;
  allowed: boolean;
  missing: string[];
  blockers: string[];
  checkedAt: string;
}

export interface GoalHarnessCodexGoalSnapshotSummary {
  kind?: 'status' | 'completion';
  artifactPath: string;
  status?: string;
  tokenBudget?: number;
  remainingTokens?: number | null;
  checkedAt: string;
  reconciliationOk: boolean;
  warnings: string[];
  errors: string[];
}

export interface GoalHarnessRuntimeState {
  version: 1;
  workflow: 'goal-harness';
  slug: string;
  phase: GoalHarnessPhase;
  route: GoalHarnessRouteDecision;
  challenge: GoalHarnessAnnealingChallenge;
  createdAt: string;
  updatedAt: string;
  runtimePath: string;
  activeTrajectoryId?: string;
  trajectories: GoalHarnessTrajectory[];
  leaderSteps: GoalHarnessLeaderStep[];
  teamPlans: GoalHarnessTeamPlan[];
  perturbations: GoalHarnessPerturbationSummary[];
  lastCompletionGate?: GoalHarnessCompletionGateSummary;
  lastCodexGoalSnapshot?: GoalHarnessCodexGoalSnapshotSummary;
  phaseHistory: GoalHarnessPhaseRecord[];
  budget: {
    maxAlternativeStrategies: number;
    maxCriticPasses: number;
    alternativesRecorded: number;
    criticPassesUsed: number;
  };
}

export interface RecordGoalHarnessTrajectoryOptions {
  slug: string;
  id?: string;
  source?: GoalHarnessTrajectorySource;
  role?: GoalHarnessWorkerRole;
  summary: string;
  evidence?: string | readonly string[];
  score?: number;
  noveltyScore?: number;
  risk?: string;
  status?: GoalHarnessTrajectoryStatus;
  now?: Date;
}

export interface AdvanceGoalHarnessPhaseOptions {
  slug: string;
  phase: GoalHarnessPhase;
  evidence?: string;
  now?: Date;
}

export interface SelectGoalHarnessTrajectoryOptions {
  slug: string;
  trajectoryId: string;
  evidence: string;
  now?: Date;
}

export interface RecordGoalHarnessLeaderStepOptions {
  slug: string;
  action?: string;
  outcome: GoalHarnessLeaderStepOutcome;
  evidence?: string | readonly string[];
  nextAction?: string;
  now?: Date;
}

export interface BuildGoalHarnessTeamPlanOptions {
  slug: string;
  task?: string;
  now?: Date;
}

export interface GoalHarnessNextAction {
  phase: GoalHarnessPhase;
  action: string;
  reason: string;
  recommendedCommand?: string;
}

export class GoalHarnessRuntimeError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

function repoRuntimePath(run: GoalWorkflowRun): string {
  return `${run.artifactDir}/${GOAL_HARNESS_RUNTIME}`;
}

function absoluteRuntimePath(cwd: string, run: GoalWorkflowRun): string {
  return join(cwd, repoRuntimePath(run));
}

function safeSegment(value: string, fallback: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return segment || fallback;
}

function normalizeEvidence(value: string | readonly string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeScore(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new GoalHarnessRuntimeError(`${label} must be a finite number between 0 and 100.`);
  }
  return Math.round(value * 100) / 100;
}

function nextTrajectoryId(runtime: GoalHarnessRuntimeState, summary: string): string {
  const next = runtime.trajectories.length + 1;
  return `T${String(next).padStart(3, '0')}-${safeSegment(summary, 'trajectory')}`;
}

function nextLeaderStepId(runtime: GoalHarnessRuntimeState): string {
  return `S${String(runtime.leaderSteps.length + 1).padStart(3, '0')}`;
}

function nextTeamPlanId(runtime: GoalHarnessRuntimeState, task: string): string {
  const next = runtime.teamPlans.length + 1;
  return `P${String(next).padStart(3, '0')}-${safeSegment(task, 'team-plan')}`;
}

function resetPhaseBudget(challenge: GoalHarnessAnnealingChallenge): GoalHarnessRuntimeState['budget'] {
  return {
    maxAlternativeStrategies: challenge.maxAlternativeStrategies,
    maxCriticPasses: challenge.maxCriticPasses,
    alternativesRecorded: 0,
    criticPassesUsed: 0,
  };
}

function enterRuntimePhase(runtime: GoalHarnessRuntimeState, phase: GoalHarnessPhase, evidence: string | undefined, now: string): void {
  const challenge = buildGoalHarnessAnnealingChallenge(phase, runtime.route.route);
  runtime.phase = phase;
  runtime.challenge = challenge;
  runtime.phaseHistory.push({ phase, enteredAt: now, evidence: evidence?.trim() || undefined });
  runtime.budget = resetPhaseBudget(challenge);
}

function assertLateReadiness(runtime: GoalHarnessRuntimeState, evidence: string | undefined): void {
  const blockers: string[] = [];
  if (!evidence?.trim()) {
    blockers.push('implementation evidence is required');
  }
  if (!runtime.activeTrajectoryId) {
    blockers.push('an active trajectory must be selected');
  }
  if (runtime.phase === 'early') {
    blockers.push('middle-phase exploitation must run before the late completion challenge');
  }
  if (runtime.budget.criticPassesUsed < 1) {
    blockers.push('at least one critic/tester pressure trajectory must be recorded');
  }
  if (blockers.length > 0) {
    throw new GoalHarnessRuntimeError(`Cannot enter late phase: ${blockers.join('; ')}.`);
  }
}

function hasIndependenceSignal(selected: GoalHarnessTrajectory, alternative: GoalHarnessTrajectory): boolean {
  if (alternative.source !== selected.source) return true;
  if (alternative.role && alternative.role !== selected.role) return true;
  if ((alternative.noveltyScore ?? 0) >= 30) return true;
  if (alternative.noveltyScore !== undefined && selected.noveltyScore !== undefined) {
    return Math.abs(alternative.noveltyScore - selected.noveltyScore) >= 20;
  }
  return false;
}

function assertEarlySelectionReadiness(runtime: GoalHarnessRuntimeState, selected: GoalHarnessTrajectory): void {
  const selectable = runtime.trajectories.filter((trajectory) => (
    trajectory.status === 'candidate' || trajectory.status === 'accepted'
  ));
  if (selectable.length < 2) {
    throw new GoalHarnessRuntimeError('Early trajectory selection requires at least two independent candidate trajectories.');
  }
  const alternatives = selectable.filter((trajectory) => trajectory.id !== selected.id);
  if (!alternatives.some((alternative) => hasIndependenceSignal(selected, alternative))) {
    throw new GoalHarnessRuntimeError('Early trajectory selection requires an independent alternative with distinct source, role, or novelty evidence.');
  }
}

function normalizeRuntime(parsed: GoalHarnessRuntimeState): GoalHarnessRuntimeState {
  if (!Array.isArray(parsed.leaderSteps)) parsed.leaderSteps = [];
  if (!Array.isArray(parsed.teamPlans)) parsed.teamPlans = [];
  if (!Array.isArray(parsed.perturbations)) parsed.perturbations = [];
  return parsed;
}

async function writeRuntime(cwd: string, runtime: GoalHarnessRuntimeState): Promise<void> {
  await writeFile(join(cwd, runtime.runtimePath), `${JSON.stringify(runtime, null, 2)}\n`);
}

export async function writeGoalHarnessRuntime(cwd: string, runtime: GoalHarnessRuntimeState): Promise<void> {
  await writeRuntime(cwd, runtime);
}

export function goalHarnessRuntimePath(run: GoalWorkflowRun): string {
  return repoRuntimePath(run);
}

export async function initializeGoalHarnessRuntime(
  cwd: string,
  run: GoalWorkflowRun,
  route: GoalHarnessRouteDecision,
  challenge: GoalHarnessAnnealingChallenge,
  nowDate = new Date(),
): Promise<GoalHarnessRuntimeState> {
  const now = iso(nowDate);
  const runtime: GoalHarnessRuntimeState = {
    version: 1,
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: run.slug,
    phase: challenge.phase,
    route,
    challenge,
    createdAt: now,
    updatedAt: now,
    runtimePath: repoRuntimePath(run),
    trajectories: [],
    leaderSteps: [],
    teamPlans: [],
    perturbations: [],
    phaseHistory: [{ phase: challenge.phase, enteredAt: now, evidence: 'runtime initialized' }],
    budget: resetPhaseBudget(challenge),
  };
  await writeFile(absoluteRuntimePath(cwd, run), `${JSON.stringify(runtime, null, 2)}\n`);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: 'runtime_initialized',
    status: run.status,
    message: `Goal harness runtime initialized in ${challenge.phase} phase`,
    metadata: { phase: challenge.phase, route: route.route },
  });
  return runtime;
}

export async function readGoalHarnessRuntime(cwd: string, slug: string): Promise<GoalHarnessRuntimeState> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
  let raw: string;
  try {
    raw = await readFile(absoluteRuntimePath(cwd, run), 'utf-8');
  } catch {
    throw new GoalHarnessRuntimeError(`No goal-harness runtime found at ${repoRuntimePath(run)}.`);
  }
  const parsed = normalizeRuntime(JSON.parse(raw) as GoalHarnessRuntimeState);
  if (parsed.version !== 1 || parsed.workflow !== GOAL_HARNESS_WORKFLOW || parsed.slug !== run.slug) {
    throw new GoalHarnessRuntimeError(`Invalid goal-harness runtime at ${repoRuntimePath(run)}.`);
  }
  return parsed;
}

export async function advanceGoalHarnessPhase(
  cwd: string,
  options: AdvanceGoalHarnessPhaseOptions,
): Promise<GoalHarnessRuntimeState> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  if (options.phase === 'late') {
    assertLateReadiness(runtime, options.evidence);
  }
  const now = iso(options.now);
  runtime.updatedAt = now;
  enterRuntimePhase(runtime, options.phase, options.evidence, now);
  await writeRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: 'phase_advanced',
    status: run.status,
    message: `Goal harness advanced to ${options.phase}`,
    evidence: options.evidence,
    metadata: { phase: options.phase, strategy: runtime.challenge.strategy },
  });
  return runtime;
}

export async function recordGoalHarnessTrajectory(
  cwd: string,
  options: RecordGoalHarnessTrajectoryOptions,
): Promise<{ runtime: GoalHarnessRuntimeState; trajectory: GoalHarnessTrajectory }> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const summary = options.summary.trim();
  if (!summary) throw new GoalHarnessRuntimeError('Trajectory summary is required.');
  const evidence = normalizeEvidence(options.evidence);
  if (evidence.length === 0) throw new GoalHarnessRuntimeError('Trajectory evidence is required.');

  const now = iso(options.now);
  const id = options.id?.trim() || nextTrajectoryId(runtime, summary);
  if (runtime.trajectories.some((trajectory) => trajectory.id === id)) {
    throw new GoalHarnessRuntimeError(`Trajectory already exists: ${id}`);
  }
  const source = options.source ?? 'leader';
  const status = options.status ?? 'candidate';
  if (source === 'worker' && !options.role) {
    throw new GoalHarnessRuntimeError('Worker trajectories require a worker role.');
  }
  if (source === 'worker' && (status === 'candidate' || status === 'accepted') && options.score === undefined) {
    throw new GoalHarnessRuntimeError('Worker candidate trajectories require a score from 0 to 100.');
  }
  const trajectory: GoalHarnessTrajectory = {
    id,
    source,
    role: options.role,
    summary,
    evidence,
    score: normalizeScore(options.score, 'score'),
    noveltyScore: normalizeScore(options.noveltyScore, 'novelty-score'),
    risk: options.risk?.trim() || undefined,
    status,
    createdAt: now,
    updatedAt: now,
  };
  runtime.trajectories.push(trajectory);
  runtime.updatedAt = now;
  if (trajectory.status === 'candidate' || trajectory.status === 'accepted') {
    runtime.budget.alternativesRecorded += 1;
  }
  if (trajectory.role === 'critic' || trajectory.role === 'tester') {
    runtime.budget.criticPassesUsed += 1;
  }
  if (trajectory.status === 'accepted') {
    runtime.activeTrajectoryId = trajectory.id;
  }
  await writeRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: 'trajectory_recorded',
    status: run.status,
    message: `Goal harness trajectory recorded: ${trajectory.id}`,
    evidence: evidence.join('\n'),
    metadata: {
      trajectoryId: trajectory.id,
      source: trajectory.source,
      role: trajectory.role,
      trajectoryStatus: trajectory.status,
      score: trajectory.score,
      noveltyScore: trajectory.noveltyScore,
    },
  });
  return { runtime, trajectory };
}

export async function selectGoalHarnessTrajectory(
  cwd: string,
  options: SelectGoalHarnessTrajectoryOptions,
): Promise<GoalHarnessRuntimeState> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const evidence = options.evidence.trim();
  if (!evidence) throw new GoalHarnessRuntimeError('Selection evidence is required.');
  const selected = runtime.trajectories.find((trajectory) => trajectory.id === options.trajectoryId);
  if (!selected) throw new GoalHarnessRuntimeError(`Unknown trajectory: ${options.trajectoryId}`);
  if (selected.status === 'blocked') throw new GoalHarnessRuntimeError(`Cannot select blocked trajectory: ${options.trajectoryId}`);
  if (runtime.phase === 'early') {
    assertEarlySelectionReadiness(runtime, selected);
  }

  const now = iso(options.now);
  for (const trajectory of runtime.trajectories) {
    if (trajectory.id === selected.id) {
      trajectory.status = 'accepted';
      trajectory.updatedAt = now;
      continue;
    }
    if (trajectory.status === 'accepted') {
      trajectory.status = 'candidate';
      trajectory.updatedAt = now;
    }
  }
  runtime.activeTrajectoryId = selected.id;
  runtime.updatedAt = now;
  if (runtime.phase === 'early') {
    enterRuntimePhase(runtime, 'middle', `selected ${selected.id}: ${evidence}`, now);
  }
  await writeRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: 'trajectory_selected',
    status: run.status,
    message: `Goal harness selected trajectory: ${selected.id}`,
    evidence,
    metadata: { trajectoryId: selected.id, phase: runtime.phase },
  });
  return runtime;
}

export async function recordGoalHarnessLeaderStep(
  cwd: string,
  options: RecordGoalHarnessLeaderStepOptions,
): Promise<{ runtime: GoalHarnessRuntimeState; step: GoalHarnessLeaderStep }> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const evidence = normalizeEvidence(options.evidence);
  if (evidence.length === 0) throw new GoalHarnessRuntimeError('Leader step evidence is required.');

  const now = iso(options.now);
  const before = buildGoalHarnessNextAction(runtime);
  const step: GoalHarnessLeaderStep = {
    id: nextLeaderStepId(runtime),
    phase: runtime.phase,
    action: options.action?.trim() || before.action,
    outcome: options.outcome,
    evidence,
    nextAction: options.nextAction?.trim() || '',
    createdAt: now,
    updatedAt: now,
  };
  runtime.leaderSteps.push(step);
  runtime.updatedAt = now;
  if (options.outcome === 'blocked') {
    enterRuntimePhase(runtime, 'stuck', `leader step ${step.id} blocked: ${evidence.join('; ')}`, now);
  } else if (options.outcome === 'ready_for_late_gate') {
    assertLateReadiness(runtime, evidence.join('\n'));
    enterRuntimePhase(runtime, 'late', `leader step ${step.id} is ready for late gate: ${evidence.join('; ')}`, now);
  }
  step.nextAction = step.nextAction || buildGoalHarnessNextAction(runtime).action;

  await writeRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: 'leader_step_recorded',
    status: run.status,
    message: `Goal harness leader step recorded: ${step.id} (${step.outcome})`,
    evidence: evidence.join('\n'),
    metadata: { stepId: step.id, phase: step.phase, outcome: step.outcome, currentPhase: runtime.phase },
  });
  return { runtime, step };
}

function roleTask(role: GoalHarnessWorkerRole, task: string): string {
  switch (role) {
    case 'researcher':
      return `Research independent alternatives for: ${task}. Return sources, assumptions, and a scored recommendation.`;
    case 'architect':
      return `Design a structurally different trajectory for: ${task}. Return tradeoffs, integration risk, and score.`;
    case 'implementer':
      return `Implement or prototype the selected trajectory for: ${task}. Return diff summary, touched files, and blockers.`;
    case 'tester':
      return `Verify the current trajectory for: ${task}. Return commands, results, uncovered gaps, and confidence score.`;
    case 'critic':
      return `Adversarially review the current trajectory for: ${task}. Return missed requirements, risks, and disconfirming evidence.`;
    case 'replanner':
      return `Reframe the stuck plan for: ${task}. Return a perturbation strategy that preserves acceptance criteria.`;
  }
}

function teamPlanContext(runtime: GoalHarnessRuntimeState): string {
  const active = runtime.activeTrajectoryId
    ? runtime.trajectories.find((trajectory) => trajectory.id === runtime.activeTrajectoryId)
    : undefined;
  const lastStep = runtime.leaderSteps.at(-1);
  return [
    `Goal harness slug: ${runtime.slug}`,
    `Phase: ${runtime.phase} (${runtime.challenge.strategy})`,
    `Active trajectory: ${active ? `${active.id} - ${active.summary}` : 'none'}`,
    lastStep ? `Latest leader step: ${lastStep.id} (${lastStep.outcome}) - ${lastStep.evidence.join('; ')}` : '',
    'Return evidence only; the leader owns the Codex goal and decides whether to accept any trajectory.',
  ].filter(Boolean).join('\n');
}

export async function buildGoalHarnessTeamPlan(
  cwd: string,
  options: BuildGoalHarnessTeamPlanOptions,
): Promise<{ runtime: GoalHarnessRuntimeState; plan: GoalHarnessTeamPlan }> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const task = (options.task?.trim() || buildGoalHarnessNextAction(runtime).action).slice(0, 1200);
  if (!task) throw new GoalHarnessRuntimeError('Team plan task is required.');
  const now = iso(options.now);
  const context = teamPlanContext(runtime);
  const lanes = runtime.challenge.workerLanes.map((role): GoalHarnessTeamLanePlan => {
    const laneTask = roleTask(role, task);
    return {
      role,
      task: laneTask,
      instruction: buildWorkerBoundaryInstruction({ role, task: laneTask, context }),
      expectedEvidence: [
        'concrete findings or diff summary',
        'verification commands and observed results',
        'risks, blockers, and missing evidence',
        'candidate trajectory score from 0 to 100',
      ],
    };
  });
  const plan: GoalHarnessTeamPlan = {
    id: nextTeamPlanId(runtime, task),
    phase: runtime.phase,
    task,
    lanes,
    launchHint: `omx team ${lanes.length}:executor ${JSON.stringify(task)}`,
    createdAt: now,
  };
  runtime.teamPlans.push(plan);
  runtime.updatedAt = now;
  await writeRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: 'team_plan_built',
    status: run.status,
    message: `Goal harness team plan built: ${plan.id}`,
    evidence: `${lanes.length} lanes planned for ${runtime.phase} phase`,
    metadata: { planId: plan.id, phase: runtime.phase, lanes: lanes.map((lane) => lane.role) },
  });
  return { runtime, plan };
}

export function buildGoalHarnessNextAction(runtime: GoalHarnessRuntimeState): GoalHarnessNextAction {
  const candidates = runtime.trajectories.filter((trajectory) => trajectory.status === 'candidate' || trajectory.status === 'accepted');
  const lastStep = runtime.leaderSteps.at(-1);
  const lastTeamPlan = runtime.teamPlans.at(-1);
  const codexSnapshot = runtime.lastCodexGoalSnapshot;
  const hasCompletionSnapshot = codexSnapshot?.reconciliationOk === true
    && codexSnapshot.status === 'complete'
    && (codexSnapshot.kind === 'completion' || codexSnapshot.kind === undefined);
  if (
    lastStep?.outcome === 'needs_team_pressure'
    && (!lastTeamPlan || lastTeamPlan.createdAt < lastStep.createdAt)
  ) {
    return {
      phase: runtime.phase,
      action: 'build a bounded team-lane plan before committing further',
      reason: `leader step ${lastStep.id} requested external worker pressure`,
      recommendedCommand: `omx goal-harness team-plan --slug ${runtime.slug} --task "<worker pressure task>"`,
    };
  }
  if (hasCompletionSnapshot) {
    return {
      phase: runtime.phase,
      action: 'Codex goal snapshot reconciled; durable goal-harness workflow is complete',
      reason: `fresh complete get_goal snapshot recorded at ${codexSnapshot.artifactPath}`,
    };
  }
  if (codexSnapshot && !codexSnapshot.reconciliationOk) {
    return {
      phase: runtime.phase,
      action: 'resolve Codex goal snapshot mismatch before relying on goal-mode status',
      reason: [...codexSnapshot.errors, ...codexSnapshot.warnings].join('; '),
      recommendedCommand: `omx goal-harness sync-goal --slug ${runtime.slug} --codex-goal-json <fresh-get_goal-json>`,
    };
  }
  if (runtime.phase === 'late' && runtime.lastCompletionGate?.allowed) {
    return {
      phase: runtime.phase,
      action: 'local completion validation passed; leader may call update_goal, then record a fresh get_goal snapshot',
      reason: `completion gate passed at ${runtime.lastCompletionGate.artifactPath}`,
      recommendedCommand: `omx goal-harness complete --slug ${runtime.slug} --codex-goal-json <fresh-complete-get_goal-json>`,
    };
  }
  if (runtime.phase === 'late' && runtime.lastCompletionGate && !runtime.lastCompletionGate.allowed) {
    return {
      phase: runtime.phase,
      action: 'resolve failed completion-gate evidence before completing the Codex goal',
      reason: [...runtime.lastCompletionGate.missing, ...runtime.lastCompletionGate.blockers].join('; '),
      recommendedCommand: `omx goal-harness gate --slug ${runtime.slug} --evidence-json <completion-evidence-json>`,
    };
  }
  if (runtime.phase === 'early') {
    if (runtime.budget.alternativesRecorded < runtime.challenge.maxAlternativeStrategies) {
      return {
        phase: runtime.phase,
        action: 'record another independent trajectory before committing',
        reason: `early exploration has ${runtime.budget.alternativesRecorded}/${runtime.challenge.maxAlternativeStrategies} alternatives`,
        recommendedCommand: `omx goal-harness record-trajectory --slug ${runtime.slug} --summary "<strategy>" --evidence "<evidence>"`,
      };
    }
    return {
      phase: runtime.phase,
      action: 'select the best evidenced trajectory and move into exploitation',
      reason: `${candidates.length} candidate trajectories are available`,
      recommendedCommand: `omx goal-harness select --slug ${runtime.slug} --trajectory-id <id> --evidence "<why this wins>"`,
    };
  }
  if (runtime.phase === 'middle') {
    if (!runtime.activeTrajectoryId) {
      return {
        phase: runtime.phase,
        action: 'select an active trajectory before implementation work continues',
        reason: 'middle exploitation requires a leader-selected trajectory',
        recommendedCommand: `omx goal-harness select --slug ${runtime.slug} --trajectory-id <id> --evidence "<why this wins>"`,
      };
    }
    if (runtime.budget.criticPassesUsed < runtime.challenge.maxCriticPasses) {
      return {
        phase: runtime.phase,
        action: 'keep exploiting the selected path while adding critic/tester pressure',
        reason: `critic pressure has ${runtime.budget.criticPassesUsed}/${runtime.challenge.maxCriticPasses} recorded passes`,
        recommendedCommand: `omx goal-harness record-trajectory --slug ${runtime.slug} --source worker --role critic --summary "<critique>" --evidence "<findings>"`,
      };
    }
    return {
      phase: runtime.phase,
      action: 'advance to late completion challenge after implementation evidence is ready',
      reason: 'selected trajectory has received bounded middle-phase pressure',
      recommendedCommand: `omx goal-harness advance --slug ${runtime.slug} --phase late --evidence "<implementation evidence ready>"`,
    };
  }
  if (runtime.phase === 'stuck') {
    const lastPerturbation = runtime.perturbations.at(-1);
    if (!lastPerturbation) {
      return {
        phase: runtime.phase,
        action: 'build a stuck-phase perturbation artifact before recording another trajectory',
        reason: runtime.challenge.stopRule,
        recommendedCommand: `omx goal-harness perturb --slug ${runtime.slug} --blocker "<repeated blocker>"`,
      };
    }
    if (!lastTeamPlan || lastTeamPlan.createdAt < lastPerturbation.createdAt) {
      return {
        phase: runtime.phase,
        action: 'launch bounded replanner/critic/tester pressure from the perturbation artifact',
        reason: `latest perturbation artifact is ${lastPerturbation.artifactPath}`,
        recommendedCommand: `omx goal-harness team-plan --slug ${runtime.slug} --task "Run stuck perturbation ${lastPerturbation.id}"`,
      };
    }
    return {
      phase: runtime.phase,
      action: 'import or record replanner/critic/tester evidence from the stuck perturbation lanes',
      reason: `latest perturbation artifact is ${lastPerturbation.artifactPath}`,
      recommendedCommand: `omx goal-harness import-worker-result --slug ${runtime.slug} --result <lane-result.md>`,
    };
  }
  return {
    phase: runtime.phase,
    action: 'run the completion gate with objective audit, verification, adversarial review, and basin-escape evidence',
    reason: runtime.challenge.stopRule,
    recommendedCommand: `omx goal-harness gate --slug ${runtime.slug} --evidence-json <completion-evidence-json>`,
  };
}
