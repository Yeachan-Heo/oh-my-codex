import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readGoalWorkflowRun, type GoalWorkflowRun } from '../goal-workflows/artifacts.js';
import { GOAL_HARNESS_MISSION, GOAL_HARNESS_WORKFLOW } from './artifacts.js';
import {
  GOAL_HARNESS_CODEX_GOAL_SNAPSHOT,
  GOAL_HARNESS_COMPLETION_GATE,
} from './completion.js';
import { GOAL_HARNESS_INTAKE, GOAL_HARNESS_PLAN } from './planning.js';
import {
  buildGoalHarnessNextAction,
  readGoalHarnessRuntime,
  type GoalHarnessNextAction,
  type GoalHarnessRuntimeState,
} from './runtime.js';

export type GoalHarnessAggregateStageStatus = 'pending' | 'in_progress' | 'blocked' | 'complete';

export interface GoalHarnessAggregateStage {
  id: string;
  label: string;
  status: GoalHarnessAggregateStageStatus;
  artifactPath?: string;
  detail?: string;
}

export interface GoalHarnessAggregateStatus {
  slug: string;
  active: boolean;
  workflowStatus: GoalWorkflowRun['status'];
  phase: GoalHarnessRuntimeState['phase'];
  completedStages: number;
  totalStages: number;
  stages: GoalHarnessAggregateStage[];
  nextAction: ReturnType<typeof buildGoalHarnessNextAction>;
}

export interface GoalHarnessStatusSummary {
  run: GoalWorkflowRun;
  runtime: GoalHarnessRuntimeState;
  aggregate: GoalHarnessAggregateStatus;
}

function artifactExists(cwd: string, artifactPath: string): boolean {
  return existsSync(join(cwd, artifactPath));
}

export function buildGoalHarnessArtifactAwareNextAction(
  cwd: string,
  run: GoalWorkflowRun,
  runtime: GoalHarnessRuntimeState,
): GoalHarnessNextAction {
  const intakePath = `${run.artifactDir}/${GOAL_HARNESS_INTAKE}`;
  const planPath = `${run.artifactDir}/${GOAL_HARNESS_PLAN}`;
  if (runtime.phase === 'early' && runtime.trajectories.length === 0) {
    if (runtime.route.recommendedSkills.includes('deep-interview') && !artifactExists(cwd, intakePath)) {
      return {
        phase: runtime.phase,
        action: 'write deep-interview intake before recording trajectories',
        reason: 'route recommends deep-interview and no intake artifact exists',
        recommendedCommand: `omx goal-harness interview --slug ${runtime.slug}`,
      };
    }
    if (runtime.route.recommendedSkills.includes('ralplan') && !artifactExists(cwd, planPath)) {
      return {
        phase: runtime.phase,
        action: 'write ralplan candidate/critique artifact before selecting trajectories',
        reason: 'route recommends ralplan and no plan artifact exists',
        recommendedCommand: `omx goal-harness plan --slug ${runtime.slug}`,
      };
    }
  }
  return buildGoalHarnessNextAction(runtime);
}

function stage(
  id: string,
  label: string,
  status: GoalHarnessAggregateStageStatus,
  artifactPath?: string,
  detail?: string,
): GoalHarnessAggregateStage {
  return {
    id,
    label,
    status,
    ...(artifactPath ? { artifactPath } : {}),
    ...(detail ? { detail } : {}),
  };
}

function artifactStage(cwd: string, id: string, label: string, artifactPath: string): GoalHarnessAggregateStage {
  return stage(id, label, artifactExists(cwd, artifactPath) ? 'complete' : 'pending', artifactPath);
}

function trajectoryStage(runtime: GoalHarnessRuntimeState): GoalHarnessAggregateStage {
  if (runtime.activeTrajectoryId) {
    return stage('trajectory', 'active trajectory selected', 'complete', undefined, runtime.activeTrajectoryId);
  }
  if (runtime.trajectories.length > 0) {
    return stage('trajectory', 'trajectory search', 'in_progress', undefined, `${runtime.trajectories.length} candidates recorded`);
  }
  return stage('trajectory', 'trajectory search', 'pending', undefined, 'no candidates recorded');
}

function phasePressureStage(runtime: GoalHarnessRuntimeState): GoalHarnessAggregateStage {
  if (runtime.lastCompletionGate || runtime.phase === 'late') {
    return stage('phase-pressure', 'annealing phase pressure', 'complete', undefined, runtime.phase);
  }
  if (runtime.phase === 'middle' || runtime.phase === 'stuck') {
    return stage('phase-pressure', 'annealing phase pressure', 'in_progress', undefined, runtime.phase);
  }
  return stage('phase-pressure', 'annealing phase pressure', 'pending', undefined, runtime.phase);
}

function completionGateStage(runtime: GoalHarnessRuntimeState): GoalHarnessAggregateStage {
  const gate = runtime.lastCompletionGate;
  if (!gate) return stage('completion-gate', 'local completion gate', 'pending');
  return stage(
    'completion-gate',
    'local completion gate',
    gate.allowed ? 'complete' : 'blocked',
    gate.artifactPath,
    gate.allowed ? 'passed' : [...gate.missing, ...gate.blockers].join('; '),
  );
}

function codexGoalStage(runtime: GoalHarnessRuntimeState): GoalHarnessAggregateStage {
  const snapshot = runtime.lastCodexGoalSnapshot;
  if (!snapshot) {
    return stage(
      'codex-goal',
      'fresh Codex goal reconciliation',
      runtime.lastCompletionGate?.allowed ? 'in_progress' : 'pending',
      undefined,
      runtime.lastCompletionGate?.allowed ? 'waiting for update_goal then get_goal snapshot' : undefined,
    );
  }
  if (!snapshot.reconciliationOk) {
    return stage(
      'codex-goal',
      'fresh Codex goal reconciliation',
      'blocked',
      snapshot.artifactPath,
      [...snapshot.errors, ...snapshot.warnings].join('; '),
    );
  }
  if (snapshot.kind === 'completion' || (snapshot.kind === undefined && snapshot.status === 'complete')) {
    return stage(
      'codex-goal',
      'fresh Codex goal reconciliation',
      'complete',
      snapshot.artifactPath,
      snapshot.status,
    );
  }
  return stage(
    'codex-goal',
    'fresh Codex goal reconciliation',
    'in_progress',
    snapshot.artifactPath,
    [
      snapshot.status ?? 'unknown',
      snapshot.tokenBudget !== undefined ? `budget=${snapshot.tokenBudget}` : '',
      snapshot.remainingTokens !== undefined && snapshot.remainingTokens !== null ? `remaining=${snapshot.remainingTokens}` : '',
    ].filter(Boolean).join('; '),
  );
}

export async function buildGoalHarnessStatusSummary(cwd: string, slug: string): Promise<GoalHarnessStatusSummary> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const stages = [
    artifactStage(cwd, 'mission', 'mission artifact', `${run.artifactDir}/${GOAL_HARNESS_MISSION}`),
    artifactStage(cwd, 'intake', 'deep interview intake', `${run.artifactDir}/${GOAL_HARNESS_INTAKE}`),
    artifactStage(cwd, 'plan', 'ralplan critique', `${run.artifactDir}/${GOAL_HARNESS_PLAN}`),
    trajectoryStage(runtime),
    phasePressureStage(runtime),
    completionGateStage(runtime),
    artifactStage(cwd, 'completion-artifact', 'completion gate artifact', `${run.artifactDir}/${GOAL_HARNESS_COMPLETION_GATE}`),
    codexGoalStage(runtime),
    artifactStage(cwd, 'codex-artifact', 'Codex goal snapshot artifact', `${run.artifactDir}/${GOAL_HARNESS_CODEX_GOAL_SNAPSHOT}`),
  ];
  const completedStages = stages.filter((item) => item.status === 'complete').length;
  return {
    run,
    runtime,
    aggregate: {
      slug: run.slug,
      active: run.status !== 'complete',
      workflowStatus: run.status,
      phase: runtime.phase,
      completedStages,
      totalStages: stages.length,
      stages,
      nextAction: buildGoalHarnessArtifactAwareNextAction(cwd, run, runtime),
    },
  };
}
