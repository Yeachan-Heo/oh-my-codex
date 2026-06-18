import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { slugifyMissionName } from './contracts.js';
import {
  formatCodexGoalReconciliation,
  buildCompletedCodexGoalRemediation,
  buildCodexGoalTerminalCleanupNotice,
  parseCodexGoalSnapshot,
  reconcileCodexGoalSnapshot,
  type CodexGoalSnapshot,
  type CodexGoalReconciliation,
} from '../goal-workflows/codex-goal-snapshot.js';

export const AUTORESEARCH_GOAL_ROOT = '.omx/goals/autoresearch';
export const AUTORESEARCH_GOAL_MISSION = 'mission.json';
export const AUTORESEARCH_GOAL_RUBRIC = 'rubric.md';
export const AUTORESEARCH_GOAL_LEDGER = 'ledger.jsonl';
export const AUTORESEARCH_GOAL_COMPLETION = 'completion.json';

export type AutoresearchGoalStatus = 'created' | 'in_progress' | 'passed' | 'failed' | 'blocked' | 'complete';
export type AutoresearchGoalVerdict = 'pass' | 'fail' | 'blocked';

export interface AutoresearchGoalMission {
  schema_version: 1;
  workflow: 'autoresearch-goal';
  slug: string;
  topic: string;
  rubric: string;
  critic_command?: string;
  status: AutoresearchGoalStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  mission_path: string;
  rubric_path: string;
  ledger_path: string;
  completion_path: string;
}

export interface AutoresearchGoalCompletion {
  schema_version: 1;
  slug: string;
  verdict: AutoresearchGoalVerdict;
  passed: boolean;
  summary: string;
  evidence: string;
  artifact_path?: string;
  critic_command?: string;
  recorded_at: string;
}

export interface AutoresearchGoalLedgerEntry {
  ts: string;
  event:
    | 'workflow_created'
    | 'goal_handoff_emitted'
    | 'validation_passed'
    | 'validation_failed'
    | 'validation_blocked'
    | 'goal_completed';
  slug: string;
  status?: AutoresearchGoalStatus;
  message?: string;
  evidence?: string;
  artifact_path?: string;
}

export interface CreateAutoresearchGoalOptions {
  topic: string;
  rubric: string;
  slug?: string;
  criticCommand?: string;
  force?: boolean;
  now?: Date;
}

export interface RecordAutoresearchGoalVerdictOptions {
  slug: string;
  verdict: AutoresearchGoalVerdict;
  evidence: string;
  summary?: string;
  artifactPath?: string;
  now?: Date;
}

export interface CompleteAutoresearchGoalOptions {
  codexGoal?: unknown;
  now?: Date;
}

export class AutoresearchGoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AutoresearchGoalError(`Missing ${field}.`);
  return trimmed;
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

export function autoresearchGoalDir(cwd: string, slug: string): string {
  return join(cwd, AUTORESEARCH_GOAL_ROOT, slug);
}

export function autoresearchGoalMissionPath(cwd: string, slug: string): string {
  return join(autoresearchGoalDir(cwd, slug), AUTORESEARCH_GOAL_MISSION);
}

export function autoresearchGoalRubricPath(cwd: string, slug: string): string {
  return join(autoresearchGoalDir(cwd, slug), AUTORESEARCH_GOAL_RUBRIC);
}

export function autoresearchGoalLedgerPath(cwd: string, slug: string): string {
  return join(autoresearchGoalDir(cwd, slug), AUTORESEARCH_GOAL_LEDGER);
}

export function autoresearchGoalCompletionPath(cwd: string, slug: string): string {
  return join(autoresearchGoalDir(cwd, slug), AUTORESEARCH_GOAL_COMPLETION);
}

async function appendLedger(cwd: string, slug: string, entry: AutoresearchGoalLedgerEntry): Promise<void> {
  await mkdir(autoresearchGoalDir(cwd, slug), { recursive: true });
  await appendFile(autoresearchGoalLedgerPath(cwd, slug), `${JSON.stringify(entry)}\n`, 'utf-8');
}

async function writeMission(cwd: string, mission: AutoresearchGoalMission): Promise<void> {
  await mkdir(autoresearchGoalDir(cwd, mission.slug), { recursive: true });
  await writeFile(autoresearchGoalMissionPath(cwd, mission.slug), `${JSON.stringify(mission, null, 2)}\n`, 'utf-8');
}

export async function createAutoresearchGoal(cwd: string, options: CreateAutoresearchGoalOptions): Promise<AutoresearchGoalMission> {
  const topic = requireText(options.topic, '--topic');
  const rubric = requireText(options.rubric, '--rubric');
  const slug = slugifyMissionName(options.slug ?? topic);
  const missionPath = autoresearchGoalMissionPath(cwd, slug);
  if (!options.force && existsSync(missionPath)) {
    throw new AutoresearchGoalError(`Refusing to overwrite existing ${repoRelative(cwd, missionPath)}; pass --force to recreate it.`);
  }

  const now = iso(options.now);
  const mission: AutoresearchGoalMission = {
    schema_version: 1,
    workflow: 'autoresearch-goal',
    slug,
    topic,
    rubric,
    ...(options.criticCommand?.trim() ? { critic_command: options.criticCommand.trim() } : {}),
    status: 'created',
    created_at: now,
    updated_at: now,
    mission_path: repoRelative(cwd, missionPath),
    rubric_path: repoRelative(cwd, autoresearchGoalRubricPath(cwd, slug)),
    ledger_path: repoRelative(cwd, autoresearchGoalLedgerPath(cwd, slug)),
    completion_path: repoRelative(cwd, autoresearchGoalCompletionPath(cwd, slug)),
  };

  await mkdir(autoresearchGoalDir(cwd, slug), { recursive: true });
  await writeFile(autoresearchGoalRubricPath(cwd, slug), `${rubric}\n`, 'utf-8');
  await writeFile(autoresearchGoalLedgerPath(cwd, slug), '', 'utf-8');
  await writeMission(cwd, mission);
  await appendLedger(cwd, slug, { ts: now, event: 'workflow_created', slug, status: mission.status, message: `Autoresearch goal created: ${topic}` });
  return mission;
}

export async function readAutoresearchGoal(cwd: string, slug: string): Promise<AutoresearchGoalMission> {
  const normalizedSlug = slugifyMissionName(slug);
  const path = autoresearchGoalMissionPath(cwd, normalizedSlug);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new AutoresearchGoalError(`No autoresearch-goal mission found at ${repoRelative(cwd, path)}. Run \`omx autoresearch-goal create ...\` first.`);
  }
  const parsed = JSON.parse(raw) as AutoresearchGoalMission;
  if (parsed.schema_version !== 1 || parsed.workflow !== 'autoresearch-goal') {
    throw new AutoresearchGoalError(`Invalid autoresearch-goal mission at ${repoRelative(cwd, path)}.`);
  }
  return parsed;
}

export async function readAutoresearchGoalCompletion(cwd: string, slug: string): Promise<AutoresearchGoalCompletion | null> {
  const path = autoresearchGoalCompletionPath(cwd, slugifyMissionName(slug));
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as AutoresearchGoalCompletion;
  return parsed;
}

export async function recordAutoresearchGoalVerdict(
  cwd: string,
  options: RecordAutoresearchGoalVerdictOptions,
): Promise<{ mission: AutoresearchGoalMission; completion: AutoresearchGoalCompletion }> {
  const mission = await readAutoresearchGoal(cwd, options.slug);
  if (mission.status === 'complete') {
    throw new AutoresearchGoalError(`Autoresearch goal ${mission.slug} is already complete; create a new goal or explicitly reopen via a future workflow before recording more verdicts.`);
  }
  const evidence = requireText(options.evidence, '--evidence');
  const now = iso(options.now);
  const completion: AutoresearchGoalCompletion = {
    schema_version: 1,
    slug: mission.slug,
    verdict: options.verdict,
    passed: options.verdict === 'pass',
    summary: options.summary?.trim() || evidence,
    evidence,
    ...(options.artifactPath?.trim() ? { artifact_path: options.artifactPath.trim() } : {}),
    ...(mission.critic_command ? { critic_command: mission.critic_command } : {}),
    recorded_at: now,
  };

  mission.status = options.verdict === 'pass' ? 'passed' : options.verdict === 'fail' ? 'failed' : 'blocked';
  mission.updated_at = now;
  await writeMission(cwd, mission);
  await writeFile(autoresearchGoalCompletionPath(cwd, mission.slug), `${JSON.stringify(completion, null, 2)}\n`, 'utf-8');
  await appendLedger(cwd, mission.slug, {
    ts: now,
    event: options.verdict === 'pass' ? 'validation_passed' : options.verdict === 'fail' ? 'validation_failed' : 'validation_blocked',
    slug: mission.slug,
    status: mission.status,
    evidence,
    artifact_path: options.artifactPath,
  });
  return { mission, completion };
}

export async function completeAutoresearchGoal(cwd: string, slug: string, options: CompleteAutoresearchGoalOptions = {}): Promise<{ mission: AutoresearchGoalMission; completion: AutoresearchGoalCompletion }> {
  const mission = await readAutoresearchGoal(cwd, slug);
  const completion = await readAutoresearchGoalCompletion(cwd, mission.slug);
  if (!completion || !completion.passed || completion.verdict !== 'pass') {
    throw new AutoresearchGoalError(`Autoresearch goal ${mission.slug} cannot complete until professor-critic validation records verdict=pass in ${mission.completion_path}.`);
  }
  const reconciliation = reconcileAutoresearchCodexGoalSnapshot(
    options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal),
    mission,
    { requireSnapshot: true, requireComplete: true },
  );
  if (!reconciliation.ok) throw new AutoresearchGoalError(formatCodexGoalReconciliation(reconciliation));
  const completedAt = iso(options.now);
  mission.status = 'complete';
  mission.updated_at = completedAt;
  mission.completed_at = completedAt;
  await writeMission(cwd, mission);
  await appendLedger(cwd, mission.slug, {
    ts: completedAt,
    event: 'goal_completed',
    slug: mission.slug,
    status: mission.status,
    evidence: completion.evidence,
    artifact_path: completion.artifact_path,
  });
  return { mission, completion };
}

export function buildAutoresearchGoalObjective(mission: Pick<AutoresearchGoalMission, 'topic' | 'rubric' | 'slug'>): string {
  return [
    `Autoresearch goal: ${mission.topic}`,
    '',
    'Research methodology / professor-critic rubric:',
    mission.rubric,
    '',
    `Completion gate: record a passing professor-critic verdict with omx autoresearch-goal verdict --slug ${mission.slug} --verdict pass --evidence "<critic artifact/evidence>". After the objective audit passes, call update_goal({status: "complete"}), call get_goal again, then run omx autoresearch-goal complete --slug ${mission.slug} --codex-goal-json "<fresh get_goal JSON or path>".`,
  ].join('\n');
}

export function buildLegacyAutoresearchGoalObjective(mission: Pick<AutoresearchGoalMission, 'topic' | 'rubric' | 'slug'>): string {
  return [
    `Autoresearch goal: ${mission.topic}`,
    '',
    'Research methodology / professor-critic rubric:',
    mission.rubric,
    '',
    `Completion gate: record a passing professor-critic verdict with omx autoresearch-goal verdict --slug ${mission.slug} --verdict pass --evidence "<critic artifact/evidence>", then run omx autoresearch-goal complete --slug ${mission.slug}.`,
  ].join('\n');
}

export function reconcileAutoresearchCodexGoalSnapshot(
  snapshot: CodexGoalSnapshot | null | undefined,
  mission: Pick<AutoresearchGoalMission, 'topic' | 'rubric' | 'slug'>,
  options: { requireSnapshot?: boolean; requireComplete?: boolean } = {},
): CodexGoalReconciliation {
  const attempts = [buildAutoresearchGoalObjective(mission), buildLegacyAutoresearchGoalObjective(mission)]
    .map((expectedObjective) => reconcileCodexGoalSnapshot(snapshot, {
      expectedObjective,
      allowedStatuses: options.requireComplete ? ['complete'] : ['active', 'complete'],
      requireSnapshot: options.requireSnapshot,
      requireComplete: options.requireComplete,
    }));
  const successful = attempts.find((attempt) => attempt.ok);
  if (successful) return successful;
  const primary = attempts[0]!;
  const legacy = attempts[1]!;
  const legacyOnlyErrors = legacy.errors.filter((error) => !primary.errors.includes(error));
  return {
    ...primary,
    errors: [
      ...primary.errors,
      ...(legacyOnlyErrors.length ? [`Legacy autoresearch objective also failed reconciliation: ${legacyOnlyErrors.join(' ')}`] : []),
    ],
  };
}

export async function buildAutoresearchGoalHandoff(cwd: string, slug: string, now = new Date()): Promise<string> {
  const mission = await readAutoresearchGoal(cwd, slug);
  if (mission.status === 'created') {
    mission.status = 'in_progress';
    mission.updated_at = iso(now);
    await writeMission(cwd, mission);
  }
  await appendLedger(cwd, mission.slug, { ts: iso(now), event: 'goal_handoff_emitted', slug: mission.slug, status: mission.status });
  const createPayload = {
    objective: buildAutoresearchGoalObjective(mission),
  };

  return [
    'Autoresearch-goal active-goal handoff',
    `Mission: ${mission.mission_path}`,
    `Rubric: ${mission.rubric_path}`,
    `Ledger: ${mission.ledger_path}`,
    `Completion artifact: ${mission.completion_path}`,
    '',
    'Codex goal integration constraints:',
    '- This shell command does not mutate hidden Codex /goal state; it writes durable OMX artifacts and prints this handoff only.',
    '- First call get_goal. If no active goal exists, call create_goal with the payload below.',
    `- If get_goal reports status complete before create_goal, do not call create_goal over it. ${buildCompletedCodexGoalRemediation('Autoresearch-goal preflight')}`,
    '- If a different active Codex goal exists, finish/checkpoint that goal before starting this autoresearch goal.',
    '- Iterate research until the professor-critic evaluator records a concrete pass/fail/blocker artifact.',
    '- Do not call update_goal({status: "complete"}) until the professor-critic verdict is pass and the objective audit proves the mission complete; then call get_goal again and run omx autoresearch-goal complete --codex-goal-json with the fresh snapshot.',
    '- After omx autoresearch-goal complete succeeds, treat `/goal clear` as the explicit terminal cleanup step before another same-thread goal.',
    '- If validation fails or blocks, keep iterating or report the blocker with the recorded evidence; do not revive deprecated omx autoresearch.',
    '',
    ...(mission.status === 'complete'
      ? [
        '',
        'Terminal Codex goal cleanup:',
        buildCodexGoalTerminalCleanupNotice('Autoresearch-goal completion'),
      ]
      : []),
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Topic:',
    mission.topic,
    '',
    'Professor-critic rubric:',
    mission.rubric,
    ...(mission.critic_command ? ['', 'Professor-critic command:', mission.critic_command] : []),
  ].join('\n');
}
