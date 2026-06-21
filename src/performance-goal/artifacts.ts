import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  formatCodexGoalReconciliation,
  buildCompletedCodexGoalRemediation,
  buildCodexGoalTerminalCleanupNotice,
  parseCodexGoalSnapshot,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';

export const PERFORMANCE_GOAL_ROOT = '.omx/goals/performance';
export const PERFORMANCE_GOAL_STATE = 'state.json';
export const PERFORMANCE_GOAL_LEDGER = 'ledger.jsonl';
export const PERFORMANCE_GOAL_EVALUATOR = 'evaluator.md';

export type PerformanceGoalStatus = 'created' | 'in_progress' | 'validation_passed' | 'validation_failed' | 'blocked' | 'complete';
export type PerformanceValidationStatus = 'pass' | 'fail' | 'blocked';

export interface PerformanceEvaluatorContract {
  command: string;
  contract: string;
}

export interface PerformanceValidationRecord {
  status: PerformanceValidationStatus;
  evidence: string;
  recordedAt: string;
}

export interface PerformanceGoalState {
  version: 1;
  workflow: 'performance-goal';
  slug: string;
  objective: string;
  status: PerformanceGoalStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  evaluator: PerformanceEvaluatorContract;
  lastValidation?: PerformanceValidationRecord;
  artifactPaths: {
    state: string;
    ledger: string;
    evaluator: string;
  };
}

export interface CreatePerformanceGoalOptions {
  objective: string;
  evaluatorCommand: string;
  evaluatorContract: string;
  slug?: string;
  force?: boolean;
  now?: Date;
}

export interface CheckpointPerformanceGoalOptions {
  slug: string;
  status: PerformanceValidationStatus;
  evidence: string;
  now?: Date;
}

export interface CompletePerformanceGoalOptions {
  slug: string;
  evidence?: string;
  codexGoal?: unknown;
  now?: Date;
}

export interface PerformanceGoalLedgerEntry {
  ts: string;
  event:
    | 'workflow_created'
    | 'goal_handoff_emitted'
    | 'validation_passed'
    | 'validation_failed'
    | 'validation_blocked'
    | 'goal_completed';
  status?: PerformanceGoalStatus;
  validationStatus?: PerformanceValidationStatus;
  evidence?: string;
  message?: string;
}

export class PerformanceGoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'performance-goal';
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

function workflowDir(cwd: string, slug: string): string {
  return join(cwd, PERFORMANCE_GOAL_ROOT, slug);
}

export function performanceGoalStatePath(cwd: string, slug: string): string {
  return join(workflowDir(cwd, slug), PERFORMANCE_GOAL_STATE);
}

export function performanceGoalLedgerPath(cwd: string, slug: string): string {
  return join(workflowDir(cwd, slug), PERFORMANCE_GOAL_LEDGER);
}

export function performanceGoalEvaluatorPath(cwd: string, slug: string): string {
  return join(workflowDir(cwd, slug), PERFORMANCE_GOAL_EVALUATOR);
}

async function writeState(cwd: string, state: PerformanceGoalState): Promise<void> {
  await mkdir(workflowDir(cwd, state.slug), { recursive: true });
  await writeFile(performanceGoalStatePath(cwd, state.slug), `${JSON.stringify(state, null, 2)}\n`);
}

async function appendLedger(cwd: string, slug: string, entry: PerformanceGoalLedgerEntry): Promise<void> {
  await mkdir(workflowDir(cwd, slug), { recursive: true });
  await appendFile(performanceGoalLedgerPath(cwd, slug), `${JSON.stringify(entry)}\n`);
}

function evaluatorMarkdown(state: PerformanceGoalState): string {
  return [
    `# Performance Evaluator: ${state.slug}`,
    '',
    '## Objective',
    state.objective,
    '',
    '## Evaluator Command',
    '```sh',
    state.evaluator.command,
    '```',
    '',
    '## Pass/Fail Contract',
    state.evaluator.contract,
    '',
    'This evaluator must exist and produce concrete pass/fail evidence before the performance goal can be completed.',
    '',
  ].join('\n');
}

function requireText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new PerformanceGoalError(`Missing ${name}.`);
  return trimmed;
}

export async function createPerformanceGoal(cwd: string, options: CreatePerformanceGoalOptions): Promise<PerformanceGoalState> {
  const objective = requireText(options.objective, 'objective');
  const evaluatorCommand = requireText(options.evaluatorCommand, 'evaluator command');
  const evaluatorContract = requireText(options.evaluatorContract, 'evaluator contract');
  const slug = slugify(options.slug ?? objective);
  const statePath = performanceGoalStatePath(cwd, slug);
  if (!options.force && existsSync(statePath)) {
    throw new PerformanceGoalError(`Refusing to overwrite existing ${repoRelative(cwd, statePath)}; pass --force to recreate it.`);
  }

  const now = iso(options.now);
  const state: PerformanceGoalState = {
    version: 1,
    workflow: 'performance-goal',
    slug,
    objective,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    evaluator: {
      command: evaluatorCommand,
      contract: evaluatorContract,
    },
    artifactPaths: {
      state: repoRelative(cwd, statePath),
      ledger: repoRelative(cwd, performanceGoalLedgerPath(cwd, slug)),
      evaluator: repoRelative(cwd, performanceGoalEvaluatorPath(cwd, slug)),
    },
  };

  await mkdir(workflowDir(cwd, slug), { recursive: true });
  await writeFile(performanceGoalLedgerPath(cwd, slug), '');
  await writeFile(performanceGoalEvaluatorPath(cwd, slug), evaluatorMarkdown(state));
  await writeState(cwd, state);
  await appendLedger(cwd, slug, {
    ts: now,
    event: 'workflow_created',
    status: state.status,
    message: 'Performance goal created with evaluator contract',
  });
  return state;
}

export async function readPerformanceGoal(cwd: string, slug: string): Promise<PerformanceGoalState> {
  const path = performanceGoalStatePath(cwd, slugify(slug));
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new PerformanceGoalError(`No performance goal found at ${repoRelative(cwd, path)}. Run \`omx performance-goal create ...\` first.`);
  }
  const parsed = JSON.parse(raw) as PerformanceGoalState;
  if (parsed.version !== 1 || parsed.workflow !== 'performance-goal' || !parsed.evaluator?.command) {
    throw new PerformanceGoalError(`Invalid performance goal state at ${repoRelative(cwd, path)}.`);
  }
  return parsed;
}

export async function startPerformanceGoal(cwd: string, slug: string, nowDate = new Date()): Promise<{ state: PerformanceGoalState; instruction: string }> {
  const state = await readPerformanceGoal(cwd, slug);
  const now = iso(nowDate);
  if (state.status === 'created') {
    state.status = 'in_progress';
    state.startedAt = now;
    state.updatedAt = now;
    await writeState(cwd, state);
  }
  const instruction = buildPerformanceGoalInstruction(state);
  await appendLedger(cwd, state.slug, {
    ts: now,
    event: 'goal_handoff_emitted',
    status: state.status,
    message: 'Emitted model-facing Codex goal handoff; shell command did not mutate Codex goal state',
  });
  return { state, instruction };
}

export async function checkpointPerformanceGoal(cwd: string, options: CheckpointPerformanceGoalOptions): Promise<PerformanceGoalState> {
  const state = await readPerformanceGoal(cwd, options.slug);
  if (state.status === 'complete') {
    throw new PerformanceGoalError(`Performance goal ${state.slug} is already complete; create a new goal or explicitly reopen via a future workflow before recording more checkpoints.`);
  }
  const evidence = requireText(options.evidence, 'validation evidence');
  const now = iso(options.now);
  state.lastValidation = { status: options.status, evidence, recordedAt: now };
  state.status = options.status === 'pass' ? 'validation_passed' : options.status === 'fail' ? 'validation_failed' : 'blocked';
  state.updatedAt = now;
  await writeState(cwd, state);
  await appendLedger(cwd, state.slug, {
    ts: now,
    event: options.status === 'pass' ? 'validation_passed' : options.status === 'fail' ? 'validation_failed' : 'validation_blocked',
    status: state.status,
    validationStatus: options.status,
    evidence,
  });
  return state;
}

export async function completePerformanceGoal(cwd: string, options: CompletePerformanceGoalOptions): Promise<PerformanceGoalState> {
  const state = await readPerformanceGoal(cwd, options.slug);
  if (state.lastValidation?.status !== 'pass') {
    throw new PerformanceGoalError('Cannot complete performance goal until evaluator validation has a passing checkpoint. Run `omx performance-goal checkpoint --status pass ...` first.');
  }
  const reconciliation = reconcileCodexGoalSnapshot(
    options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal),
    {
      expectedObjective: state.objective,
      allowedStatuses: ['complete'],
      requireSnapshot: true,
      requireComplete: true,
    },
  );
  if (!reconciliation.ok) throw new PerformanceGoalError(formatCodexGoalReconciliation(reconciliation));
  const now = iso(options.now);
  state.status = 'complete';
  state.completedAt = now;
  state.updatedAt = now;
  await writeState(cwd, state);
  await appendLedger(cwd, state.slug, {
    ts: now,
    event: 'goal_completed',
    status: state.status,
    evidence: options.evidence ?? state.lastValidation.evidence,
  });
  return state;
}

export function buildPerformanceGoalInstruction(state: PerformanceGoalState): string {
  const createPayload = { objective: state.objective };
  return [
    'Performance goal handoff',
    `State: ${state.artifactPaths.state}`,
    `Ledger: ${state.artifactPaths.ledger}`,
    `Evaluator: ${state.artifactPaths.evaluator}`,
    '',
    'Codex goal integration constraints:',
    '- First call get_goal. If no active goal exists, call create_goal with the payload below.',
    `- If get_goal reports status complete before create_goal, do not call create_goal over it. ${buildCompletedCodexGoalRemediation('Performance-goal preflight')}`,
    '- If a different active Codex goal exists, finish or checkpoint that goal before starting this performance goal.',
    '- Do not treat this shell command as hidden Codex goal mutation; it only wrote OMX artifacts and this handoff.',
    '- Optimize only against the evaluator command/contract below; do not begin optimization without that evaluator.',
    '- Completion is blocked until evaluator evidence passes and is recorded with `omx performance-goal checkpoint --status pass ...`.',
    '- After evaluator pass and a completion audit prove the objective is complete, call update_goal({status: "complete"}) in the Codex thread, then call get_goal again for a fresh completion snapshot.',
    `- Finish by running: omx performance-goal complete --slug ${state.slug} --evidence "<passing evaluator/tests/files evidence>" --codex-goal-json "<fresh get_goal JSON or path>"`,
    '- After the complete command succeeds, treat `/goal clear` as the explicit terminal cleanup step before another same-thread goal.',
    '- If the evaluator fails or blocks, checkpoint with --status fail or --status blocked and continue iterating.',
    '',
    ...(state.status === 'complete'
      ? [
        '',
        'Terminal Codex goal cleanup:',
        buildCodexGoalTerminalCleanupNotice('Performance-goal completion'),
      ]
      : []),
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Evaluator command:',
    state.evaluator.command,
    '',
    'Evaluator pass/fail contract:',
    state.evaluator.contract,
    '',
    'Objective:',
    state.objective,
  ].join('\n');
}
