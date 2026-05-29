import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendGoalWorkflowLedger,
  readGoalWorkflowRun,
  transitionGoalWorkflowRun,
  type GoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import {
  formatCodexGoalReconciliation,
  reconcileCodexGoalSnapshot,
  type CodexGoalReconciliation,
  type CodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';
import { normalizeGoalWorkflowValidation } from '../goal-workflows/validation.js';
import {
  evaluateGoalHarnessCompletionGate,
  type CompletionGateDecision,
  type CompletionGateEvidence,
} from './policy.js';
import {
  readGoalHarnessRuntime,
  writeGoalHarnessRuntime,
  GoalHarnessRuntimeError,
  type GoalHarnessRuntimeState,
} from './runtime.js';

export const GOAL_HARNESS_COMPLETION_GATE = 'completion-gate.json';
export const GOAL_HARNESS_CODEX_GOAL_SNAPSHOT = 'codex-goal-snapshot.json';
export const GOAL_HARNESS_CODEX_GOAL_STATUS = 'codex-goal-status.json';
const GOAL_HARNESS_WORKFLOW = 'goal-harness';

export interface RunGoalHarnessCompletionGateOptions {
  slug: string;
  evidence: CompletionGateEvidence;
  now?: Date;
}

export interface CompleteGoalHarnessRunOptions {
  slug: string;
  codexGoal: CodexGoalSnapshot | null;
  evidence?: string;
  now?: Date;
}

export interface SyncGoalHarnessCodexGoalSnapshotOptions {
  slug: string;
  codexGoal: CodexGoalSnapshot | null;
  evidence?: string;
  now?: Date;
}

export interface GoalHarnessCompletionGateRecord {
  version: 1;
  workflow: 'goal-harness';
  slug: string;
  artifactPath: string;
  checkedAt: string;
  runtimePhase: GoalHarnessRuntimeState['phase'];
  activeTrajectoryId?: string;
  allowed: boolean;
  missing: string[];
  blockers: string[];
  nextAction: string;
  evidence: CompletionGateEvidence;
}

export interface GoalHarnessCompletionGateResult {
  run: GoalWorkflowRun;
  runtime: GoalHarnessRuntimeState;
  record: GoalHarnessCompletionGateRecord;
  decision: CompletionGateDecision;
}

export interface GoalHarnessCodexGoalCompletionRecord {
  version: 1;
  workflow: 'goal-harness';
  slug: string;
  kind: 'status' | 'completion';
  artifactPath: string;
  checkedAt: string;
  evidence?: string;
  snapshot: CodexGoalSnapshot;
  reconciliation: CodexGoalReconciliation;
}

export interface SyncGoalHarnessCodexGoalSnapshotResult {
  run: GoalWorkflowRun;
  runtime: GoalHarnessRuntimeState;
  record: GoalHarnessCodexGoalCompletionRecord;
  reconciliation: CodexGoalReconciliation;
}

export interface CompleteGoalHarnessRunResult {
  run: GoalWorkflowRun;
  runtime: GoalHarnessRuntimeState;
  record: GoalHarnessCodexGoalCompletionRecord;
}

function iso(now = new Date()): string {
  return now.toISOString();
}

function allowedGoalStatusesForSync(run: GoalWorkflowRun): Array<'active' | 'complete'> {
  if (run.status === 'complete') return ['complete'];
  if (run.status === 'validation_passed') return ['active', 'complete'];
  return ['active'];
}

function withRuntimeGate(decision: CompletionGateDecision, runtime: GoalHarnessRuntimeState): CompletionGateDecision {
  const missing = [...decision.missing];
  const blockers = [...decision.blockers];
  if (runtime.phase !== 'late') {
    blockers.push(`completion gate requires late phase; current phase is ${runtime.phase}`);
  }
  const allowed = missing.length === 0 && blockers.length === 0;
  return {
    allowed,
    missing,
    blockers,
    nextAction: allowed
      ? decision.nextAction
      : 'continue the leader loop; enter late phase and resolve missing or blocked completion evidence before update_goal',
  };
}

export async function syncGoalHarnessCodexGoalSnapshot(
  cwd: string,
  options: SyncGoalHarnessCodexGoalSnapshotOptions,
): Promise<SyncGoalHarnessCodexGoalSnapshotResult> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const reconciliation = reconcileCodexGoalSnapshot(options.codexGoal, {
    expectedObjective: run.objective,
    allowedStatuses: allowedGoalStatusesForSync(run),
    requireSnapshot: true,
  });
  const checkedAt = iso(options.now);
  const artifactPath = `${run.artifactDir}/${GOAL_HARNESS_CODEX_GOAL_STATUS}`;
  const record: GoalHarnessCodexGoalCompletionRecord = {
    version: 1,
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: run.slug,
    kind: 'status',
    artifactPath,
    checkedAt,
    evidence: options.evidence?.trim() || undefined,
    snapshot: reconciliation.snapshot,
    reconciliation,
  };

  await writeFile(join(cwd, artifactPath), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  runtime.lastCodexGoalSnapshot = {
    kind: 'status',
    artifactPath,
    status: reconciliation.snapshot.status,
    tokenBudget: reconciliation.snapshot.tokenBudget,
    remainingTokens: reconciliation.snapshot.remainingTokens,
    checkedAt,
    reconciliationOk: reconciliation.ok,
    warnings: reconciliation.warnings,
    errors: reconciliation.errors,
  };
  runtime.updatedAt = checkedAt;
  await writeGoalHarnessRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: checkedAt,
    event: 'codex_goal_snapshot_synced',
    status: run.status,
    message: reconciliation.ok
      ? 'Goal harness Codex goal status snapshot synced'
      : 'Goal harness Codex goal status snapshot did not reconcile cleanly',
    evidence: options.evidence?.trim() || formatCodexGoalReconciliation(reconciliation),
    metadata: {
      artifactPath,
      codexGoalStatus: reconciliation.snapshot.status,
      tokenBudget: reconciliation.snapshot.tokenBudget,
      remainingTokens: reconciliation.snapshot.remainingTokens,
      reconciliationOk: reconciliation.ok,
    },
  });
  return { run, runtime, record, reconciliation };
}

export async function runGoalHarnessCompletionGate(
  cwd: string,
  options: RunGoalHarnessCompletionGateOptions,
): Promise<GoalHarnessCompletionGateResult> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const checkedAt = iso(options.now);
  const decision = withRuntimeGate(evaluateGoalHarnessCompletionGate(options.evidence), runtime);
  const artifactPath = `${run.artifactDir}/${GOAL_HARNESS_COMPLETION_GATE}`;
  const record: GoalHarnessCompletionGateRecord = {
    version: 1,
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: run.slug,
    artifactPath,
    checkedAt,
    runtimePhase: runtime.phase,
    activeTrajectoryId: runtime.activeTrajectoryId,
    allowed: decision.allowed,
    missing: decision.missing,
    blockers: decision.blockers,
    nextAction: decision.nextAction,
    evidence: options.evidence,
  };

  await writeFile(join(cwd, artifactPath), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  runtime.lastCompletionGate = {
    artifactPath,
    allowed: decision.allowed,
    missing: decision.missing,
    blockers: decision.blockers,
    checkedAt,
  };
  runtime.updatedAt = checkedAt;
  await writeGoalHarnessRuntime(cwd, runtime);

  await appendGoalWorkflowLedger(cwd, run, {
    ts: checkedAt,
    event: decision.allowed ? 'completion_gate_passed' : 'completion_gate_failed',
    status: run.status,
    message: decision.allowed
      ? 'Goal harness completion gate passed'
      : 'Goal harness completion gate did not pass',
    evidence: decision.allowed ? decision.nextAction : [...decision.missing, ...decision.blockers].join('\n'),
    metadata: { artifactPath, runtimePhase: runtime.phase, activeTrajectoryId: runtime.activeTrajectoryId },
  });

  if (!decision.allowed) {
    return { run, runtime, record, decision };
  }

  const validation = normalizeGoalWorkflowValidation({
    status: 'pass',
    summary: [
      `Goal harness completion gate passed for ${run.slug}.`,
      'Objective audit, implementation evidence, external verification, adversarial review, and basin-escape convergence challenge were supplied.',
      `Artifact: ${artifactPath}`,
    ].join(' '),
    artifactPath,
    checkedAt: options.now,
  });
  const validatedRun = await transitionGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, run.slug, {
    status: 'validation_passed',
    message: 'Goal harness completion gate validated local workflow evidence',
    validation,
    now: options.now,
  });
  return { run: validatedRun, runtime, record, decision };
}

export async function completeGoalHarnessRun(
  cwd: string,
  options: CompleteGoalHarnessRunOptions,
): Promise<CompleteGoalHarnessRunResult> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  if (run.status !== 'validation_passed') {
    throw new GoalHarnessRuntimeError('Goal harness completion requires a passing slug-aware completion gate first.');
  }
  if (runtime.lastCompletionGate?.allowed !== true) {
    throw new GoalHarnessRuntimeError('Goal harness completion requires runtime.lastCompletionGate.allowed=true.');
  }

  const reconciliation = reconcileCodexGoalSnapshot(options.codexGoal, {
    expectedObjective: run.objective,
    allowedStatuses: ['complete'],
    requireSnapshot: true,
    requireComplete: true,
  });
  if (!reconciliation.ok) {
    throw new GoalHarnessRuntimeError(formatCodexGoalReconciliation(reconciliation));
  }

  const checkedAt = iso(options.now);
  const artifactPath = `${run.artifactDir}/${GOAL_HARNESS_CODEX_GOAL_SNAPSHOT}`;
  const record: GoalHarnessCodexGoalCompletionRecord = {
    version: 1,
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: run.slug,
    kind: 'completion',
    artifactPath,
    checkedAt,
    evidence: options.evidence?.trim() || undefined,
    snapshot: reconciliation.snapshot,
    reconciliation,
  };
  await writeFile(join(cwd, artifactPath), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');

  runtime.lastCodexGoalSnapshot = {
    kind: 'completion',
    artifactPath,
    status: reconciliation.snapshot.status,
    tokenBudget: reconciliation.snapshot.tokenBudget,
    remainingTokens: reconciliation.snapshot.remainingTokens,
    checkedAt,
    reconciliationOk: reconciliation.ok,
    warnings: reconciliation.warnings,
    errors: reconciliation.errors,
  };
  runtime.updatedAt = checkedAt;
  await writeGoalHarnessRuntime(cwd, runtime);

  const completedRun = await transitionGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, run.slug, {
    status: 'complete',
    evidence: options.evidence?.trim() || `Codex goal snapshot reconciled at ${artifactPath}.`,
    metadata: {
      codexGoalSnapshotPath: artifactPath,
      codexGoalStatus: reconciliation.snapshot.status,
      tokenBudget: reconciliation.snapshot.tokenBudget,
      remainingTokens: reconciliation.snapshot.remainingTokens,
    },
    now: options.now,
  });
  return { run: completedRun, runtime, record };
}
