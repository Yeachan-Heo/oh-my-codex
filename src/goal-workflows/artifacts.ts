import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { assertGoalWorkflowCanComplete } from './validation.js';

export const GOAL_WORKFLOWS_DIR = '.omx/goals';
export const GOAL_WORKFLOW_STATUS = 'status.json';
export const GOAL_WORKFLOW_LEDGER = 'ledger.jsonl';

// Shared goal-workflow artifacts are a narrow substrate for durable, validator-gated
// handoffs. Concrete workflows may keep dedicated schemas until explicitly migrated,
// but any generic completion must pass a real validation summary: non-placeholder
// evidence plus a non-empty artifact path recorded in the status artifact.
export type GoalWorkflowStatus = 'pending' | 'in_progress' | 'validation_passed' | 'blocked' | 'failed' | 'complete';

export type GoalWorkflowLedgerEvent =
  | 'workflow_created'
  | 'goal_started'
  | 'validation_passed'
  | 'validation_failed'
  | 'goal_handoff_emitted'
  | 'intake_emitted'
  | 'plan_emitted'
  | 'runtime_initialized'
  | 'phase_advanced'
  | 'trajectory_recorded'
  | 'trajectory_selected'
  | 'leader_step_recorded'
  | 'team_plan_built'
  | 'team_packet_built'
  | 'team_result_imported'
  | 'perturbation_built'
  | 'codex_goal_snapshot_synced'
  | 'completion_gate_passed'
  | 'completion_gate_failed'
  | 'goal_completed'
  | 'goal_failed';

export interface GoalWorkflowRun {
  version: 1;
  workflow: string;
  slug: string;
  objective: string;
  status: GoalWorkflowStatus;
  createdAt: string;
  updatedAt: string;
  artifactDir: string;
  statusPath: string;
  ledgerPath: string;
  metadata?: Record<string, unknown>;
  validation?: GoalWorkflowValidationSummary;
  evidence?: string;
}

export interface GoalWorkflowValidationSummary {
  status: Extract<GoalWorkflowStatus, 'validation_passed' | 'blocked' | 'failed'>;
  summary: string;
  artifactPath?: string;
  checkedAt: string;
}

export interface GoalWorkflowLedgerEntry {
  ts: string;
  event: GoalWorkflowLedgerEvent;
  status?: GoalWorkflowStatus;
  message?: string;
  evidence?: string;
  validation?: GoalWorkflowValidationSummary;
  metadata?: Record<string, unknown>;
}

export interface CreateGoalWorkflowRunOptions {
  workflow: string;
  slug?: string;
  objective: string;
  metadata?: Record<string, unknown>;
  now?: Date;
  force?: boolean;
}

export interface TransitionGoalWorkflowOptions {
  status: Exclude<GoalWorkflowStatus, 'pending'>;
  message?: string;
  evidence?: string;
  validation?: GoalWorkflowValidationSummary;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export class GoalWorkflowError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

function cleanSegment(value: string, fallback: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return segment || fallback;
}

function slugFromObjective(objective: string): string {
  const firstLine = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'goal-workflow';
  return cleanSegment(firstLine, 'goal-workflow');
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

export function normalizeGoalWorkflowSegment(value: string, fallback = 'workflow'): string {
  return cleanSegment(value, fallback);
}

export function goalWorkflowDir(cwd: string, workflow: string, slug: string): string {
  return join(cwd, GOAL_WORKFLOWS_DIR, normalizeGoalWorkflowSegment(workflow), normalizeGoalWorkflowSegment(slug, 'goal-workflow'));
}

export function goalWorkflowStatusPath(cwd: string, workflow: string, slug: string): string {
  return join(goalWorkflowDir(cwd, workflow, slug), GOAL_WORKFLOW_STATUS);
}

export function goalWorkflowLedgerPath(cwd: string, workflow: string, slug: string): string {
  return join(goalWorkflowDir(cwd, workflow, slug), GOAL_WORKFLOW_LEDGER);
}

export async function appendGoalWorkflowLedger(cwd: string, run: GoalWorkflowRun, entry: GoalWorkflowLedgerEntry): Promise<void> {
  await mkdir(join(cwd, run.artifactDir), { recursive: true });
  await appendFile(join(cwd, run.ledgerPath), `${JSON.stringify(entry)}\n`);
}

async function writeRun(cwd: string, run: GoalWorkflowRun): Promise<void> {
  await mkdir(join(cwd, run.artifactDir), { recursive: true });
  await writeFile(join(cwd, run.statusPath), `${JSON.stringify(run, null, 2)}\n`);
}

export async function createGoalWorkflowRun(cwd: string, options: CreateGoalWorkflowRunOptions): Promise<GoalWorkflowRun> {
  if (!options.objective.trim()) throw new GoalWorkflowError('Missing goal workflow objective.');
  const workflow = normalizeGoalWorkflowSegment(options.workflow);
  const slug = normalizeGoalWorkflowSegment(options.slug ?? slugFromObjective(options.objective), 'goal-workflow');
  const statusPath = goalWorkflowStatusPath(cwd, workflow, slug);
  if (!options.force && existsSync(statusPath)) {
    throw new GoalWorkflowError(`Refusing to overwrite existing ${repoRelative(cwd, statusPath)}; pass force to recreate it.`);
  }

  const now = iso(options.now);
  const artifactDir = repoRelative(cwd, goalWorkflowDir(cwd, workflow, slug));
  const run: GoalWorkflowRun = {
    version: 1,
    workflow,
    slug,
    objective: options.objective.trim(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    artifactDir,
    statusPath: `${artifactDir}/${GOAL_WORKFLOW_STATUS}`,
    ledgerPath: `${artifactDir}/${GOAL_WORKFLOW_LEDGER}`,
    metadata: options.metadata,
  };

  await writeRun(cwd, run);
  await writeFile(join(cwd, run.ledgerPath), '');
  await appendGoalWorkflowLedger(cwd, run, { ts: now, event: 'workflow_created', status: run.status, message: 'Goal workflow created' });
  return run;
}

export async function readGoalWorkflowRun(cwd: string, workflow: string, slug: string): Promise<GoalWorkflowRun> {
  const path = goalWorkflowStatusPath(cwd, workflow, slug);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new GoalWorkflowError(`No goal workflow run found at ${repoRelative(cwd, path)}.`);
  }
  const parsed = JSON.parse(raw) as GoalWorkflowRun;
  if (parsed.version !== 1 || !parsed.workflow || !parsed.slug || !parsed.objective) {
    throw new GoalWorkflowError(`Invalid goal workflow run at ${repoRelative(cwd, path)}.`);
  }
  return parsed;
}

function eventForStatus(status: TransitionGoalWorkflowOptions['status']): GoalWorkflowLedgerEvent {
  switch (status) {
    case 'in_progress': return 'goal_started';
    case 'validation_passed': return 'validation_passed';
    case 'blocked':
    case 'failed': return 'goal_failed';
    case 'complete': return 'goal_completed';
  }
}

export async function transitionGoalWorkflowRun(cwd: string, workflow: string, slug: string, options: TransitionGoalWorkflowOptions): Promise<GoalWorkflowRun> {
  const run = await readGoalWorkflowRun(cwd, workflow, slug);
  if (options.status === 'validation_passed') {
    assertGoalWorkflowCanComplete(options.validation);
  }
  if (options.status === 'complete') {
    if (run.status !== 'validation_passed') {
      throw new GoalWorkflowError('Goal workflow completion requires a passing validation artifact first.');
    }
    assertGoalWorkflowCanComplete(run.validation);
  }

  const now = iso(options.now);
  run.status = options.status;
  run.updatedAt = now;
  run.evidence = options.evidence ?? run.evidence;
  run.metadata = { ...run.metadata, ...options.metadata };
  if (options.validation) run.validation = options.validation;

  await writeRun(cwd, run);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: now,
    event: eventForStatus(options.status),
    status: run.status,
    message: options.message,
    evidence: options.evidence,
    validation: options.validation,
    metadata: options.metadata,
  });
  return run;
}
