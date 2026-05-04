import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const ULTRAGOAL_DIR = '.omx/ultragoal';
export const ULTRAGOAL_BRIEF = 'brief.md';
export const ULTRAGOAL_GOALS = 'goals.json';
export const ULTRAGOAL_LEDGER = 'ledger.jsonl';

export type UltragoalStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

export interface UltragoalItem {
  id: string;
  title: string;
  objective: string;
  status: UltragoalStatus;
  tokenBudget?: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  evidence?: string;
  failureReason?: string;
}

export interface UltragoalPlan {
  version: 1;
  createdAt: string;
  updatedAt: string;
  briefPath: string;
  goalsPath: string;
  ledgerPath: string;
  activeGoalId?: string;
  goals: UltragoalItem[];
}

export interface UltragoalLedgerEntry {
  ts: string;
  event:
    | 'plan_created'
    | 'goal_started'
    | 'goal_resumed'
    | 'goal_completed'
    | 'goal_failed'
    | 'goal_retried';
  goalId?: string;
  status?: UltragoalStatus;
  message?: string;
  codexGoal?: unknown;
  evidence?: string;
}

export interface CreateUltragoalOptions {
  brief: string;
  goals?: Array<{ title?: string; objective: string; tokenBudget?: number }>;
  now?: Date;
  force?: boolean;
}

export interface StartNextOptions {
  now?: Date;
  retryFailed?: boolean;
}

export interface CheckpointOptions {
  goalId: string;
  status: Extract<UltragoalStatus, 'complete' | 'failed'>;
  evidence?: string;
  codexGoal?: unknown;
  now?: Date;
}

export class UltragoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

export function ultragoalDir(cwd: string): string {
  return join(cwd, ULTRAGOAL_DIR);
}

export function ultragoalBriefPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_BRIEF);
}

export function ultragoalGoalsPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_GOALS);
}

export function ultragoalLedgerPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_LEDGER);
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

function titleFromObjective(objective: string, fallback: string): string {
  const firstLine = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
}

export function deriveGoalCandidates(brief: string): Array<{ title: string; objective: string }> {
  const lines = brief.split(/\r?\n/);
  const bulletGoals = lines
    .map((line) => ({ original: line, cleaned: cleanLine(line) }))
    .filter(({ cleaned }) => cleaned.length > 0 && cleaned.length <= 1200)
    .filter(({ original, cleaned }, index, all) => (
      /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(original)
      && all.findIndex((candidate) => candidate.cleaned === cleaned) === index
    ))
    .map(({ cleaned }) => cleaned);

  const objectives = bulletGoals.length > 0
    ? bulletGoals
    : brief
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#'));

  const selected = objectives.length > 0 ? objectives : [brief.trim() || 'Complete the requested project objective.'];
  return selected.map((objective, index) => ({
    title: titleFromObjective(objective, `Goal ${index + 1}`),
    objective,
  }));
}

function normalizeGoalId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return `G${String(index + 1).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
}

async function appendLedger(cwd: string, entry: UltragoalLedgerEntry): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const path = ultragoalLedgerPath(cwd);
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  const path = ultragoalGoalsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new UltragoalError(`No ultragoal plan found at ${repoRelative(cwd, path)}. Run \`omx ultragoal create-goals ...\` first.`);
  }
  const parsed = JSON.parse(raw) as UltragoalPlan;
  if (parsed.version !== 1 || !Array.isArray(parsed.goals)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${repoRelative(cwd, path)}.`);
  }
  return parsed;
}

async function writePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  await writeFile(ultragoalGoalsPath(cwd), `${JSON.stringify(plan, null, 2)}\n`);
}

export async function createUltragoalPlan(cwd: string, options: CreateUltragoalOptions): Promise<UltragoalPlan> {
  if (!options.force && existsSync(ultragoalGoalsPath(cwd))) {
    throw new UltragoalError(`Refusing to overwrite existing ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}; pass --force to recreate it.`);
  }
  const now = iso(options.now);
  const sourceGoals: Array<{ title?: string; objective: string; tokenBudget?: number }> = options.goals?.length
    ? options.goals
    : deriveGoalCandidates(options.brief);
  const candidates = sourceGoals
    .map((goal, index): UltragoalItem => ({
      id: normalizeGoalId(goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`), index),
      title: goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
      objective: goal.objective.trim(),
      status: 'pending',
      tokenBudget: goal.tokenBudget,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }));

  const plan: UltragoalPlan = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    briefPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`,
    goalsPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`,
    ledgerPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`,
    goals: candidates,
  };

  await mkdir(ultragoalDir(cwd), { recursive: true });
  await writeFile(ultragoalBriefPath(cwd), options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`);
  await writePlan(cwd, plan);
  await writeFile(ultragoalLedgerPath(cwd), '');
  await appendLedger(cwd, { ts: now, event: 'plan_created', message: `${candidates.length} goal(s) created` });
  return plan;
}

export function summarizeUltragoalPlan(plan: UltragoalPlan): { total: number; pending: number; inProgress: number; complete: number; failed: number; activeGoalId?: string } {
  return {
    total: plan.goals.length,
    pending: plan.goals.filter((goal) => goal.status === 'pending').length,
    inProgress: plan.goals.filter((goal) => goal.status === 'in_progress').length,
    complete: plan.goals.filter((goal) => goal.status === 'complete').length,
    failed: plan.goals.filter((goal) => goal.status === 'failed').length,
    activeGoalId: plan.activeGoalId,
  };
}

export async function startNextUltragoal(cwd: string, options: StartNextOptions = {}): Promise<{ plan: UltragoalPlan; goal: UltragoalItem | null; resumed: boolean; done: boolean }> {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  const existing = plan.goals.find((goal) => goal.status === 'in_progress');
  if (existing) {
    await appendLedger(cwd, { ts: now, event: 'goal_resumed', goalId: existing.id, status: existing.status, message: 'Resuming active ultragoal' });
    return { plan, goal: existing, resumed: true, done: false };
  }

  let next = plan.goals.find((goal) => goal.status === 'pending');
  if (!next && options.retryFailed) {
    next = plan.goals.find((goal) => goal.status === 'failed');
    if (next) await appendLedger(cwd, { ts: now, event: 'goal_retried', goalId: next.id, status: 'pending', message: next.failureReason });
  }
  if (!next) return { plan, goal: null, resumed: false, done: plan.goals.every((goal) => goal.status === 'complete') };

  next.status = 'in_progress';
  next.attempt += 1;
  next.startedAt = now;
  next.failedAt = undefined;
  next.failureReason = undefined;
  next.updatedAt = now;
  plan.activeGoalId = next.id;
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, { ts: now, event: 'goal_started', goalId: next.id, status: next.status, message: `Attempt ${next.attempt}` });
  return { plan, goal: next, resumed: false, done: false };
}

export async function checkpointUltragoal(cwd: string, options: CheckpointOptions): Promise<UltragoalPlan> {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  const now = iso(options.now);
  goal.status = options.status;
  goal.updatedAt = now;
  if (options.status === 'complete') {
    goal.completedAt = now;
    goal.evidence = options.evidence;
    goal.failureReason = undefined;
    goal.failedAt = undefined;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  } else {
    goal.failedAt = now;
    goal.failureReason = options.evidence;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  }
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: options.status === 'complete' ? 'goal_completed' : 'goal_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
  });
  return plan;
}

export function buildCodexGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  const createPayload = {
    objective: goal.objective,
    ...(goal.tokenBudget ? { token_budget: goal.tokenBudget } : {}),
  };
  return [
    'Ultragoal active-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Codex goal integration constraints:',
    '- First call get_goal. If no active goal exists, call create_goal with the payload below.',
    '- If a different active Codex goal exists, finish/checkpoint that goal before starting this ultragoal.',
    '- Work only this goal until its completion audit passes.',
    '- After the goal is actually complete, call update_goal({status: "complete"}), then checkpoint the ledger with:',
    `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>"`,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Objective:',
    goal.objective,
  ].join('\n');
}
