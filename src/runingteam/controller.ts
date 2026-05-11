import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getBaseStateDir } from '../state/paths.js';
import type { TeamEvent } from '../team/state/types.js';

export const RUNINGTEAM_STATUSES = [
  'planning',
  'executing',
  'checkpointing',
  'reviewing',
  'revising',
  'synthesizing',
  'complete',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type RuningTeamStatus = (typeof RUNINGTEAM_STATUSES)[number];

export const RUNINGTEAM_CRITIC_VERDICTS = [
  'APPROVE_NEXT_BATCH',
  'ITERATE_PLAN',
  'REJECT_BATCH',
  'ASK_USER',
  'FINAL_SYNTHESIS_READY',
  'FAIL',
] as const;

export type RuningTeamCriticVerdict = (typeof RUNINGTEAM_CRITIC_VERDICTS)[number];

export interface RuningTeamSession {
  session_id: string;
  task: string;
  created_at: string;
  updated_at: string;
  status: RuningTeamStatus;
  iteration: number;
  plan_version: number;
  team_name: string | null;
  max_iterations: number;
  terminal_reason: string | null;
}

export interface RuningTeamLane {
  lane_id: string;
  goal: string;
  owned_paths: string[];
  worker_profile: string;
  status: 'pending' | 'active' | 'complete' | 'blocked' | 'rejected';
}

export interface RuningTeamPlan {
  plan_version: number;
  task: string;
  intent: string;
  acceptance_criteria: string[];
  non_goals: string[];
  lanes: RuningTeamLane[];
  verification_commands: string[];
  revision_policy: {
    checkpoint_only: true;
    may_change: string[];
    must_not_change: string[];
  };
}

export interface RuningTeamWorkerEvidence {
  event_id: string;
  worker: string;
  lane_id: string;
  team_task_id: string;
  plan_version: number;
  status: 'completed' | 'failed';
  files_changed: string[];
  commands: string[];
  summary: string;
  created_at: string;
  unsupported_claims: string[];
}

export interface RuningTeamCheckpoint {
  session_id: string;
  iteration: number;
  plan_version: number;
  created_at: string;
  evidence_count: number;
  lane_status: Array<{ lane_id: string; status: RuningTeamLane['status']; evidence_count: number }>;
  evidence: RuningTeamWorkerEvidence[];
  blockers: string[];
  open_questions: string[];
}

export interface RuningTeamCriticVerdictRecord {
  session_id: string;
  iteration: number;
  plan_version: number;
  verdict: RuningTeamCriticVerdict;
  required_changes: string[];
  rejected_claims: string[];
  acceptance_criteria_evidence: Record<string, string[]>;
  reason: string;
  created_at: string;
}

export interface RuningTeamPlannerRevision {
  session_id: string;
  iteration: number;
  from_plan_version: number;
  to_plan_version: number;
  reason: string;
  changes: string[];
  preserved_acceptance_criteria: boolean;
  created_at: string;
}

export interface RuningTeamFinalSynthesis {
  session_id: string;
  plan_version: number;
  iteration: number;
  completed_at: string;
  summary: string;
  acceptance_criteria: Array<{ criterion: string; evidence: string[] }>;
  checkpoint_count: number;
}

export interface RuningTeamControllerOptions {
  cwd: string;
  sessionId: string;
}

interface TeamTaskSnapshot {
  id?: unknown;
  subject?: unknown;
  description?: unknown;
  result?: unknown;
  error?: unknown;
  status?: unknown;
}

const TERMINAL_STATUSES = new Set<RuningTeamStatus>(['complete', 'blocked', 'failed', 'cancelled']);

function nowIso(): string {
  return new Date().toISOString();
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isStatus(value: unknown): value is RuningTeamStatus {
  return typeof value === 'string' && RUNINGTEAM_STATUSES.includes(value as RuningTeamStatus);
}

function isVerdict(value: unknown): value is RuningTeamCriticVerdict {
  return typeof value === 'string' && RUNINGTEAM_CRITIC_VERDICTS.includes(value as RuningTeamCriticVerdict);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null;
  return readJsonFile<T>(filePath);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function makeMarkdownList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ['- none'];
}

function parseEvidenceList(result: string, label: string): string[] {
  const pattern = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'gim');
  const matches = [...result.matchAll(pattern)].flatMap((match) => String(match[1] || '').split(/[,;|]/));
  return uniqueStrings(matches);
}

function inferFilesChanged(result: string): string[] {
  const explicit = parseEvidenceList(result, 'Files changed');
  if (explicit.length > 0) return explicit;
  const changed = [...result.matchAll(/`([^`]+\.(?:ts|tsx|js|jsx|json|md|mdx|yml|yaml))`/g)].map((match) => match[1]);
  return uniqueStrings(changed);
}

function inferCommands(result: string): string[] {
  const explicit = parseEvidenceList(result, '(?:Command|Commands|Tests|Verification)');
  if (explicit.length > 0) return explicit;
  const commandLines = result
    .split(/\r?\n/)
    .filter((line) => /(?:npm|node|tsc|biome|cargo|pytest|go test|pnpm|yarn)\b/.test(line));
  return uniqueStrings(commandLines.map((line) => line.replace(/^\s*[-*]\s*/, '').trim()));
}

function inferUnsupportedClaims(task: TeamTaskSnapshot, status: RuningTeamWorkerEvidence['status']): string[] {
  const result = typeof task.result === 'string' ? task.result : '';
  const unsupported = parseEvidenceList(result, 'Unsupported claims');
  if (status === 'completed' && inferCommands(result).length === 0) unsupported.push('missing_verification_commands');
  return uniqueStrings(unsupported);
}

function summarizeTask(task: TeamTaskSnapshot): string {
  const raw = typeof task.result === 'string' && task.result.trim()
    ? task.result.trim()
    : typeof task.error === 'string' && task.error.trim()
      ? task.error.trim()
      : typeof task.description === 'string'
        ? task.description.trim()
        : typeof task.subject === 'string'
          ? task.subject.trim()
          : '';
  return raw.length <= 500 ? raw : `${raw.slice(0, 500)}…`;
}

function laneForTask(plan: RuningTeamPlan, event: TeamEvent, task: TeamTaskSnapshot | null): string {
  const subject = typeof task?.subject === 'string' ? task.subject.toLowerCase() : '';
  const description = typeof task?.description === 'string' ? task.description.toLowerCase() : '';
  const haystack = `${subject}\n${description}\n${event.worker}`;
  const matched = plan.lanes.find((lane) => {
    const id = lane.lane_id.toLowerCase();
    return haystack.includes(id) || haystack.includes(lane.goal.toLowerCase());
  });
  return matched?.lane_id ?? plan.lanes[0]?.lane_id ?? 'execution';
}

function sessionRoot(cwd: string, sessionId: string): string {
  return join(getBaseStateDir(cwd), 'runingteam', sessionId);
}

function sessionPath(cwd: string, sessionId: string): string {
  return join(sessionRoot(cwd, sessionId), 'session.json');
}

function planPath(cwd: string, sessionId: string): string {
  return join(sessionRoot(cwd, sessionId), 'plan.json');
}

function checkpointPath(cwd: string, sessionId: string, iteration: number): string {
  return join(sessionRoot(cwd, sessionId), 'iterations', String(iteration), 'checkpoint.json');
}

function checkpointMarkdownPath(cwd: string, sessionId: string, iteration: number): string {
  return join(sessionRoot(cwd, sessionId), 'iterations', String(iteration), 'checkpoint.md');
}

function verdictPath(cwd: string, sessionId: string, iteration: number): string {
  return join(sessionRoot(cwd, sessionId), 'verdicts', `${iteration}.json`);
}

function revisionPath(cwd: string, sessionId: string, iteration: number): string {
  return join(sessionRoot(cwd, sessionId), 'revisions', `${iteration}.json`);
}

function finalSynthesisPath(cwd: string, sessionId: string): string {
  return join(sessionRoot(cwd, sessionId), 'final-synthesis.md');
}

function eventsPath(cwd: string, sessionId: string): string {
  return join(sessionRoot(cwd, sessionId), 'evidence', 'events.ndjson');
}

function teamTaskPath(cwd: string, teamName: string, taskId: string): string {
  return join(getBaseStateDir(cwd), 'team', teamName, 'tasks', `task-${taskId}.json`);
}

function teamEventsPath(cwd: string, teamName: string): string {
  return join(getBaseStateDir(cwd), 'team', teamName, 'events', 'events.ndjson');
}

export function validateRuningTeamSession(value: unknown): RuningTeamSession {
  assertObject(value, 'session.json');
  const session = value as Partial<RuningTeamSession>;
  if (typeof session.session_id !== 'string' || !session.session_id.trim()) throw new Error('session_id is required');
  if (typeof session.task !== 'string') throw new Error('task is required');
  if (!isStatus(session.status)) throw new Error('invalid lifecycle status');
  if (typeof session.iteration !== 'number' || session.iteration < 0) throw new Error('iteration must be non-negative');
  if (typeof session.plan_version !== 'number' || session.plan_version < 1) throw new Error('plan_version must be positive');
  if (typeof session.team_name !== 'string' && session.team_name !== null) throw new Error('team_name must be string|null');
  if (typeof session.max_iterations !== 'number' || session.max_iterations < 1) throw new Error('max_iterations must be positive');
  return session as RuningTeamSession;
}

export function validateRuningTeamPlan(value: unknown): RuningTeamPlan {
  assertObject(value, 'plan.json');
  const plan = value as Partial<RuningTeamPlan>;
  if (typeof plan.plan_version !== 'number' || plan.plan_version < 1) throw new Error('plan_version must be positive');
  if (typeof plan.task !== 'string') throw new Error('task is required');
  if (!Array.isArray(plan.acceptance_criteria) || plan.acceptance_criteria.length === 0) throw new Error('acceptance_criteria are required');
  if (!Array.isArray(plan.lanes) || plan.lanes.length === 0) throw new Error('lanes are required');
  for (const lane of plan.lanes) {
    assertObject(lane, 'plan.lane');
    if (typeof lane.lane_id !== 'string' || !lane.lane_id.trim()) throw new Error('lane_id is required');
  }
  if (plan.revision_policy?.checkpoint_only !== true) throw new Error('revision_policy.checkpoint_only must be true');
  return plan as RuningTeamPlan;
}

export function validateCriticVerdict(value: unknown): RuningTeamCriticVerdictRecord {
  assertObject(value, 'critic_verdict');
  const record = value as Partial<RuningTeamCriticVerdictRecord>;
  if (!isVerdict(record.verdict)) throw new Error('invalid verdict');
  const requiredChanges = asStringArray(record.required_changes);
  const rejectedClaims = asStringArray(record.rejected_claims);
  if (record.verdict === 'ITERATE_PLAN' && requiredChanges.length === 0) throw new Error('ITERATE_PLAN requires required_changes');
  if (record.verdict === 'REJECT_BATCH' && rejectedClaims.length === 0) throw new Error('REJECT_BATCH requires rejected_claims');
  if (record.verdict === 'FINAL_SYNTHESIS_READY') {
    assertObject(record.acceptance_criteria_evidence, 'acceptance_criteria_evidence');
    if (Object.values(record.acceptance_criteria_evidence).some((items) => !Array.isArray(items) || items.length === 0)) {
      throw new Error('FINAL_SYNTHESIS_READY requires all acceptance criteria to have evidence');
    }
  }
  return { ...record, required_changes: requiredChanges, rejected_claims: rejectedClaims } as RuningTeamCriticVerdictRecord;
}

export function validatePlannerRevision(
  revision: unknown,
  opts: { userOverride?: boolean } = {},
): RuningTeamPlannerRevision {
  assertObject(revision, 'planner_revision');
  const record = revision as Partial<RuningTeamPlannerRevision>;
  if (record.preserved_acceptance_criteria !== true && opts.userOverride !== true) {
    throw new Error('planner_revision.preserved_acceptance_criteria must be true unless a user override is present');
  }
  if (typeof record.to_plan_version !== 'number' || typeof record.from_plan_version !== 'number' || record.to_plan_version <= record.from_plan_version) {
    throw new Error('planner_revision must increment plan version');
  }
  return record as RuningTeamPlannerRevision;
}

export function canTransitionRuningTeamStatus(from: RuningTeamStatus, to: RuningTeamStatus): boolean {
  if (TERMINAL_STATUSES.has(from)) return false;
  if (TERMINAL_STATUSES.has(to)) return true;
  const allowed: Record<RuningTeamStatus, RuningTeamStatus[]> = {
    planning: ['executing'],
    executing: ['checkpointing'],
    checkpointing: ['reviewing'],
    reviewing: ['revising', 'synthesizing'],
    revising: ['executing'],
    synthesizing: ['complete'],
    complete: [],
    blocked: [],
    failed: [],
    cancelled: [],
  };
  return allowed[from].includes(to);
}

export function createInitialRuningTeamPlan(task: string): RuningTeamPlan {
  return {
    plan_version: 1,
    task,
    intent: task,
    acceptance_criteria: [
      'Direct RuningTeam invocation creates a managed session and plan.',
      'Worker evidence is checkpointed before plan mutation.',
      'Critic verdicts gate planner revision and final synthesis.',
      'Completion is impossible without final-synthesis.md.',
    ],
    non_goals: ['no MVP framing', 'no manual ralplan pre-step'],
    lanes: [
      {
        lane_id: 'execution',
        goal: task,
        owned_paths: [],
        worker_profile: 'executor',
        status: 'pending',
      },
    ],
    verification_commands: ['npm run build', 'npm test'],
    revision_policy: {
      checkpoint_only: true,
      may_change: ['lane_split', 'owner', 'order', 'verification', 'blocker_strategy'],
      must_not_change: ['acceptance_criteria_without_user_override'],
    },
  };
}

export async function createRuningTeamSession(
  cwd: string,
  input: { sessionId: string; task: string; teamName?: string | null; maxIterations?: number; plan?: RuningTeamPlan },
): Promise<{ session: RuningTeamSession; plan: RuningTeamPlan }> {
  const now = nowIso();
  const plan = input.plan ?? createInitialRuningTeamPlan(input.task);
  validateRuningTeamPlan(plan);
  const session: RuningTeamSession = {
    session_id: input.sessionId,
    task: input.task,
    created_at: now,
    updated_at: now,
    status: 'planning',
    iteration: 0,
    plan_version: plan.plan_version,
    team_name: input.teamName ?? null,
    max_iterations: input.maxIterations ?? 10,
    terminal_reason: null,
  };
  validateRuningTeamSession(session);
  await writeJsonFile(sessionPath(cwd, input.sessionId), session);
  await writeJsonFile(planPath(cwd, input.sessionId), plan);
  return { session, plan };
}

export async function readRuningTeamSession(cwd: string, sessionId: string): Promise<RuningTeamSession> {
  return validateRuningTeamSession(await readJsonFile(sessionPath(cwd, sessionId)));
}

export async function readRuningTeamPlan(cwd: string, sessionId: string): Promise<RuningTeamPlan> {
  return validateRuningTeamPlan(await readJsonFile(planPath(cwd, sessionId)));
}

export async function transitionRuningTeamStatus(
  cwd: string,
  sessionId: string,
  to: RuningTeamStatus,
  opts: { terminalReason?: string } = {},
): Promise<RuningTeamSession> {
  const session = await readRuningTeamSession(cwd, sessionId);
  if (!canTransitionRuningTeamStatus(session.status, to)) {
    throw new Error(`invalid RuningTeam transition: ${session.status} -> ${to}`);
  }
  if (to === 'complete' && !existsSync(finalSynthesisPath(cwd, sessionId))) {
    throw new Error('complete requires final-synthesis.md');
  }
  const next: RuningTeamSession = {
    ...session,
    status: to,
    updated_at: nowIso(),
    terminal_reason: TERMINAL_STATUSES.has(to) ? opts.terminalReason ?? session.terminal_reason : session.terminal_reason,
  };
  await writeJsonFile(sessionPath(cwd, sessionId), next);
  return next;
}

async function appendEvidenceEvent(cwd: string, sessionId: string, evidence: RuningTeamWorkerEvidence): Promise<void> {
  const file = eventsPath(cwd, sessionId);
  await ensureParentDir(file);
  await writeFile(file, `${JSON.stringify(evidence)}\n`, { flag: 'a', encoding: 'utf-8' });
}

async function readEvidenceEvents(cwd: string, sessionId: string): Promise<RuningTeamWorkerEvidence[]> {
  const file = eventsPath(cwd, sessionId);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf-8');
  const seen = new Set<string>();
  const out: RuningTeamWorkerEvidence[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RuningTeamWorkerEvidence;
      if (!parsed.event_id || seen.has(parsed.event_id)) continue;
      seen.add(parsed.event_id);
      out.push(parsed);
    } catch {}
  }
  return out;
}

export async function ingestTeamEvidence(
  cwd: string,
  sessionId: string,
  opts: { afterEventId?: string } = {},
): Promise<RuningTeamWorkerEvidence[]> {
  const session = await readRuningTeamSession(cwd, sessionId);
  if (!session.team_name) return [];
  const plan = await readRuningTeamPlan(cwd, sessionId);
  const teamLog = teamEventsPath(cwd, session.team_name);
  if (!existsSync(teamLog)) return [];
  const existing = new Set((await readEvidenceEvents(cwd, sessionId)).map((event) => event.event_id));
  const raw = await readFile(teamLog, 'utf-8');
  const ingested: RuningTeamWorkerEvidence[] = [];
  let started = !opts.afterEventId;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: TeamEvent;
    try {
      event = JSON.parse(line) as TeamEvent;
    } catch {
      continue;
    }
    if (!event.event_id) continue;
    if (!started) {
      if (event.event_id === opts.afterEventId) started = true;
      continue;
    }
    if (existing.has(event.event_id)) continue;
    if (event.type !== 'task_completed' && event.type !== 'task_failed') continue;
    const taskId = typeof event.task_id === 'string' ? event.task_id : '';
    if (!taskId) continue;
    const task = await readJsonIfExists<TeamTaskSnapshot>(teamTaskPath(cwd, session.team_name, taskId));
    const status: RuningTeamWorkerEvidence['status'] = event.type === 'task_failed' ? 'failed' : 'completed';
    const result = typeof task?.result === 'string' ? task.result : '';
    const evidence: RuningTeamWorkerEvidence = {
      event_id: event.event_id,
      worker: event.worker,
      lane_id: laneForTask(plan, event, task),
      team_task_id: taskId,
      plan_version: session.plan_version,
      status,
      files_changed: inferFilesChanged(result),
      commands: inferCommands(result),
      summary: summarizeTask(task ?? {}),
      created_at: event.created_at ?? nowIso(),
      unsupported_claims: inferUnsupportedClaims(task ?? {}, status),
    };
    await appendEvidenceEvent(cwd, sessionId, evidence);
    existing.add(event.event_id);
    ingested.push(evidence);
  }
  return ingested;
}

export async function createCheckpoint(cwd: string, sessionId: string): Promise<RuningTeamCheckpoint> {
  const session = await readRuningTeamSession(cwd, sessionId);
  const plan = await readRuningTeamPlan(cwd, sessionId);
  const evidence = (await readEvidenceEvents(cwd, sessionId)).filter((item) => item.plan_version === session.plan_version);
  if (evidence.length === 0) throw new Error('checkpoint requires new evidence');
  const nextIteration = session.iteration + 1;
  const checkpoint: RuningTeamCheckpoint = {
    session_id: sessionId,
    iteration: nextIteration,
    plan_version: session.plan_version,
    created_at: nowIso(),
    evidence_count: evidence.length,
    lane_status: plan.lanes.map((lane) => {
      const laneEvidence = evidence.filter((item) => item.lane_id === lane.lane_id);
      return {
        lane_id: lane.lane_id,
        status: laneEvidence.some((item) => item.status === 'failed')
          ? 'blocked'
          : laneEvidence.some((item) => item.status === 'completed')
            ? 'complete'
            : lane.status,
        evidence_count: laneEvidence.length,
      };
    }),
    evidence,
    blockers: uniqueStrings(evidence.flatMap((item) => item.unsupported_claims)),
    open_questions: [],
  };
  await writeJsonFile(checkpointPath(cwd, sessionId, nextIteration), checkpoint);
  await ensureParentDir(checkpointMarkdownPath(cwd, sessionId, nextIteration));
  await writeFile(checkpointMarkdownPath(cwd, sessionId, nextIteration), renderCheckpointMarkdown(checkpoint), 'utf-8');
  await writeJsonFile(sessionPath(cwd, sessionId), {
    ...session,
    status: 'checkpointing',
    iteration: nextIteration,
    updated_at: nowIso(),
  } satisfies RuningTeamSession);
  return checkpoint;
}

function renderCheckpointMarkdown(checkpoint: RuningTeamCheckpoint): string {
  return [
    `# RuningTeam Checkpoint ${checkpoint.iteration}`,
    '',
    `- Plan version: ${checkpoint.plan_version}`,
    `- Evidence count: ${checkpoint.evidence_count}`,
    '',
    '## Lane Status',
    ...checkpoint.lane_status.map((lane) => `- ${lane.lane_id}: ${lane.status} (${lane.evidence_count} evidence)`),
    '',
    '## Evidence',
    ...checkpoint.evidence.map((item) => `- ${item.worker}/task-${item.team_task_id}: ${item.status} — ${item.summary}`),
    '',
    '## Blockers',
    ...makeMarkdownList(checkpoint.blockers),
    '',
  ].join('\n');
}

export async function createCriticVerdict(
  cwd: string,
  sessionId: string,
  input?: Partial<RuningTeamCriticVerdictRecord>,
): Promise<RuningTeamCriticVerdictRecord> {
  const session = await readRuningTeamSession(cwd, sessionId);
  const plan = await readRuningTeamPlan(cwd, sessionId);
  const checkpoint = await readJsonIfExists<RuningTeamCheckpoint>(checkpointPath(cwd, sessionId, session.iteration));
  if (!checkpoint) throw new Error('critic verdict requires checkpoint');
  const rejectedClaims = uniqueStrings(checkpoint.evidence.flatMap((item) => item.unsupported_claims));
  const criteriaEvidence = Object.fromEntries(plan.acceptance_criteria.map((criterion) => [
    criterion,
    checkpoint.evidence
      .filter((item) => item.status === 'completed' && item.unsupported_claims.length === 0)
      .map((item) => `${item.worker}/task-${item.team_task_id}`),
  ]));
  const hasRejected = rejectedClaims.length > 0;
  const allCriteriaSupported = Object.values(criteriaEvidence).every((items) => items.length > 0);
  const verdict = input?.verdict ?? (hasRejected ? 'ITERATE_PLAN' : allCriteriaSupported ? 'FINAL_SYNTHESIS_READY' : 'APPROVE_NEXT_BATCH');
  const record: RuningTeamCriticVerdictRecord = validateCriticVerdict({
    session_id: sessionId,
    iteration: session.iteration,
    plan_version: session.plan_version,
    verdict,
    required_changes: input?.required_changes ?? (hasRejected ? rejectedClaims.map((claim) => `resolve ${claim}`) : []),
    rejected_claims: input?.rejected_claims ?? (verdict === 'REJECT_BATCH' ? rejectedClaims : []),
    acceptance_criteria_evidence: input?.acceptance_criteria_evidence ?? criteriaEvidence,
    reason: input?.reason ?? (hasRejected ? 'checkpoint contains unsupported claims' : 'checkpoint evidence reviewed'),
    created_at: nowIso(),
  });
  await writeJsonFile(verdictPath(cwd, sessionId, session.iteration), record);
  await writeJsonFile(sessionPath(cwd, sessionId), { ...session, status: 'reviewing', updated_at: nowIso() } satisfies RuningTeamSession);
  return record;
}

export async function createPlannerRevision(
  cwd: string,
  sessionId: string,
  input?: { reason?: string; changes?: string[]; userOverride?: boolean },
): Promise<RuningTeamPlannerRevision> {
  const session = await readRuningTeamSession(cwd, sessionId);
  const plan = await readRuningTeamPlan(cwd, sessionId);
  const checkpoint = await readJsonIfExists<RuningTeamCheckpoint>(checkpointPath(cwd, sessionId, session.iteration));
  if (!checkpoint) throw new Error('planner revision requires checkpoint');
  const verdict = validateCriticVerdict(await readJsonFile(verdictPath(cwd, sessionId, session.iteration)));
  if (verdict.verdict !== 'ITERATE_PLAN' && verdict.verdict !== 'REJECT_BATCH') {
    throw new Error('planner revision requires ITERATE_PLAN or REJECT_BATCH verdict');
  }
  const changes = input?.changes ?? verdict.required_changes;
  const nextPlan: RuningTeamPlan = {
    ...plan,
    plan_version: plan.plan_version + 1,
    lanes: plan.lanes.map((lane) => ({
      ...lane,
      status: checkpoint.lane_status.find((item) => item.lane_id === lane.lane_id)?.status === 'blocked' ? 'active' : lane.status,
    })),
  };
  const revision = validatePlannerRevision({
    session_id: sessionId,
    iteration: session.iteration,
    from_plan_version: plan.plan_version,
    to_plan_version: nextPlan.plan_version,
    reason: input?.reason ?? verdict.reason,
    changes,
    preserved_acceptance_criteria: true,
    created_at: nowIso(),
  }, { userOverride: input?.userOverride });
  await writeJsonFile(revisionPath(cwd, sessionId, session.iteration), revision);
  await writeJsonFile(planPath(cwd, sessionId), nextPlan);
  await writeJsonFile(sessionPath(cwd, sessionId), {
    ...session,
    status: 'revising',
    plan_version: nextPlan.plan_version,
    updated_at: nowIso(),
  } satisfies RuningTeamSession);
  return revision;
}

export async function createFinalSynthesis(cwd: string, sessionId: string): Promise<RuningTeamFinalSynthesis> {
  const session = await readRuningTeamSession(cwd, sessionId);
  const plan = await readRuningTeamPlan(cwd, sessionId);
  const verdict = validateCriticVerdict(await readJsonFile(verdictPath(cwd, sessionId, session.iteration)));
  if (verdict.verdict !== 'FINAL_SYNTHESIS_READY') throw new Error('final synthesis requires FINAL_SYNTHESIS_READY verdict');
  const synthesis: RuningTeamFinalSynthesis = {
    session_id: sessionId,
    plan_version: session.plan_version,
    iteration: session.iteration,
    completed_at: nowIso(),
    summary: `RuningTeam completed ${plan.task} with checkpoint-backed evidence.`,
    acceptance_criteria: plan.acceptance_criteria.map((criterion) => ({
      criterion,
      evidence: verdict.acceptance_criteria_evidence[criterion] ?? [],
    })),
    checkpoint_count: session.iteration,
  };
  const markdown = [
    '# RuningTeam Final Synthesis',
    '',
    `- Session: ${synthesis.session_id}`,
    `- Plan version: ${synthesis.plan_version}`,
    `- Iteration: ${synthesis.iteration}`,
    `- Completed at: ${synthesis.completed_at}`,
    '',
    '## Summary',
    synthesis.summary,
    '',
    '## Acceptance Criteria Evidence',
    ...synthesis.acceptance_criteria.flatMap((item) => [
      `- ${item.criterion}`,
      ...item.evidence.map((evidence) => `  - ${evidence}`),
    ]),
    '',
  ].join('\n');
  await ensureParentDir(finalSynthesisPath(cwd, sessionId));
  await writeFile(finalSynthesisPath(cwd, sessionId), markdown, 'utf-8');
  await writeJsonFile(sessionPath(cwd, sessionId), { ...session, status: 'synthesizing', updated_at: nowIso() } satisfies RuningTeamSession);
  return synthesis;
}

export async function runCheckpointReviewRevisionCycle(
  opts: RuningTeamControllerOptions,
): Promise<{ checkpoint: RuningTeamCheckpoint; verdict: RuningTeamCriticVerdictRecord; revision?: RuningTeamPlannerRevision; synthesis?: RuningTeamFinalSynthesis }> {
  await ingestTeamEvidence(opts.cwd, opts.sessionId);
  const checkpoint = await createCheckpoint(opts.cwd, opts.sessionId);
  const verdict = await createCriticVerdict(opts.cwd, opts.sessionId);
  if (verdict.verdict === 'FINAL_SYNTHESIS_READY') {
    const synthesis = await createFinalSynthesis(opts.cwd, opts.sessionId);
    return { checkpoint, verdict, synthesis };
  }
  if (verdict.verdict === 'ITERATE_PLAN' || verdict.verdict === 'REJECT_BATCH') {
    const revision = await createPlannerRevision(opts.cwd, opts.sessionId);
    return { checkpoint, verdict, revision };
  }
  return { checkpoint, verdict };
}
