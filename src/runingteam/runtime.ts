import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getBaseStateDir } from '../mcp/state-paths.js';
import { readTeamEvents } from '../team/state/events.js';
import { readTask, type TeamEvent, type TeamTask } from '../team/state.js';
import {
  RUNINGTEAM_CRITIC_VERDICTS,
  RUNINGTEAM_STATUSES,
  RUNINGTEAM_TERMINAL_STATUSES,
  type RuningTeamCheckpoint,
  type RuningTeamCriticVerdict,
  type RuningTeamCriticVerdictRecord,
  type RuningTeamPlan,
  type RuningTeamPlannerRevision,
  type RuningTeamSession,
  type RuningTeamStatus,
  type RuningTeamTeamAdapterState,
  type RuningTeamWorkerEvidence,
} from './contracts.js';

export interface RuningTeamPaths {
  root: string;
  session: string;
  plan: string;
  lanes: string;
  adapterTeam: string;
  evidenceEvents: string;
  finalSynthesis: string;
  iterationDir: (iteration: number) => string;
  checkpointJson: (iteration: number) => string;
  checkpointMd: (iteration: number) => string;
  verdictJson: (iteration: number) => string;
  revisionJson: (iteration: number) => string;
}

export interface RuningTeamSessionSummary {
  session_id: string;
  status: RuningTeamStatus;
  iteration: number;
  plan_version: number;
  team_name: string | null;
  final_synthesis_present: boolean;
}

export function createRuningTeamSessionId(): string {
  return `runingteam-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`;
}

export function runingTeamRoot(cwd: string): string {
  return join(getBaseStateDir(cwd), 'runingteam');
}

export function runingTeamPaths(cwd: string, sessionId: string): RuningTeamPaths {
  const root = join(runingTeamRoot(cwd), sessionId);
  return {
    root,
    session: join(root, 'session.json'),
    plan: join(root, 'plan.json'),
    lanes: join(root, 'lanes.json'),
    adapterTeam: join(root, 'adapter', 'team.json'),
    evidenceEvents: join(root, 'evidence', 'events.ndjson'),
    finalSynthesis: join(root, 'final-synthesis.md'),
    iterationDir: (iteration) => join(root, 'iterations', String(iteration)),
    checkpointJson: (iteration) => join(root, 'iterations', String(iteration), 'checkpoint.json'),
    checkpointMd: (iteration) => join(root, 'iterations', String(iteration), 'checkpoint.md'),
    verdictJson: (iteration) => join(root, 'verdicts', `${iteration}.json`),
    revisionJson: (iteration) => join(root, 'revisions', `${iteration}.json`),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`invalid_${key}`);
  return raw;
}

function requireNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) throw new Error(`invalid_${key}`);
  return raw;
}

function requireStringArray(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`invalid_${key}`);
  }
  return raw;
}

export function validateRuningTeamSession(raw: unknown): RuningTeamSession {
  if (!isRecord(raw)) throw new Error('invalid_session');
  const status = requireString(raw, 'status');
  if (!RUNINGTEAM_STATUSES.includes(status as RuningTeamStatus)) throw new Error('invalid_status');
  const teamName = raw.team_name;
  const terminalReason = raw.terminal_reason;
  return {
    session_id: requireString(raw, 'session_id'),
    task: requireString(raw, 'task'),
    created_at: requireString(raw, 'created_at'),
    updated_at: requireString(raw, 'updated_at'),
    status: status as RuningTeamStatus,
    iteration: requireNumber(raw, 'iteration'),
    plan_version: requireNumber(raw, 'plan_version'),
    team_name: teamName === null || typeof teamName === 'string' ? teamName : null,
    max_iterations: requireNumber(raw, 'max_iterations'),
    terminal_reason: terminalReason === null || typeof terminalReason === 'string' ? terminalReason : null,
  };
}

export function validateRuningTeamPlan(raw: unknown): RuningTeamPlan {
  if (!isRecord(raw)) throw new Error('invalid_plan');
  const lanes = raw.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error('invalid_lanes');
  return {
    plan_version: requireNumber(raw, 'plan_version'),
    task: requireString(raw, 'task'),
    intent: requireString(raw, 'intent'),
    acceptance_criteria: requireStringArray(raw, 'acceptance_criteria'),
    non_goals: requireStringArray(raw, 'non_goals'),
    lanes: lanes.map((lane, index) => {
      if (!isRecord(lane)) throw new Error(`invalid_lane_${index}`);
      const status = requireString(lane, 'status');
      if (!['pending', 'executing', 'complete', 'blocked'].includes(status)) throw new Error(`invalid_lane_status_${index}`);
      return {
        id: requireString(lane, 'id'),
        title: requireString(lane, 'title'),
        status: status as RuningTeamPlan['lanes'][number]['status'],
        acceptance_criteria: requireStringArray(lane, 'acceptance_criteria'),
      };
    }),
  };
}

export function validateCriticVerdictRecord(raw: unknown): RuningTeamCriticVerdictRecord {
  if (!isRecord(raw)) throw new Error('invalid_critic_verdict');
  const verdict = requireString(raw, 'verdict');
  if (!RUNINGTEAM_CRITIC_VERDICTS.includes(verdict as RuningTeamCriticVerdict)) throw new Error('invalid_verdict');
  const record = raw as Record<string, unknown>;
  if (verdict === 'ITERATE_PLAN' && (!Array.isArray(record.required_changes) || record.required_changes.length === 0)) {
    throw new Error('iterate_plan_requires_required_changes');
  }
  if (verdict === 'REJECT_BATCH' && (!Array.isArray(record.rejected_claims) || record.rejected_claims.length === 0)) {
    throw new Error('reject_batch_requires_rejected_claims');
  }
  if (verdict === 'FINAL_SYNTHESIS_READY' && !isRecord(record.acceptance_criteria_evidence)) {
    throw new Error('final_synthesis_ready_requires_acceptance_criteria_evidence');
  }
  return {
    iteration: requireNumber(record, 'iteration'),
    verdict: verdict as RuningTeamCriticVerdict,
    required_changes: Array.isArray(record.required_changes) ? record.required_changes.filter((v): v is string => typeof v === 'string') : undefined,
    rejected_claims: Array.isArray(record.rejected_claims) ? record.rejected_claims.filter((v): v is string => typeof v === 'string') : undefined,
    acceptance_criteria_evidence: isRecord(record.acceptance_criteria_evidence)
      ? Object.fromEntries(Object.entries(record.acceptance_criteria_evidence).map(([key, value]) => [key, Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []]))
      : undefined,
    created_at: requireString(record, 'created_at'),
  };
}

export function validatePlannerRevision(raw: unknown): RuningTeamPlannerRevision {
  if (!isRecord(raw)) throw new Error('invalid_planner_revision');
  const preserved = raw.preserved_acceptance_criteria;
  const override = raw.user_override;
  if (preserved !== true && typeof override !== 'string') {
    throw new Error('planner_revision_requires_preserved_acceptance_criteria_or_user_override');
  }
  return {
    iteration: requireNumber(raw, 'iteration'),
    from_plan_version: requireNumber(raw, 'from_plan_version'),
    to_plan_version: requireNumber(raw, 'to_plan_version'),
    reason: requireString(raw, 'reason'),
    changes: requireStringArray(raw, 'changes'),
    preserved_acceptance_criteria: preserved === true,
    user_override: typeof override === 'string' ? override : undefined,
    created_at: requireString(raw, 'created_at'),
  };
}

export async function createRuningTeamSession(task: string, cwd: string, opts: { sessionId?: string; maxIterations?: number } = {}): Promise<RuningTeamSession> {
  const now = new Date().toISOString();
  const session: RuningTeamSession = {
    session_id: opts.sessionId ?? createRuningTeamSessionId(),
    task,
    created_at: now,
    updated_at: now,
    status: 'planning',
    iteration: 0,
    plan_version: 1,
    team_name: null,
    max_iterations: opts.maxIterations ?? 10,
    terminal_reason: null,
  };
  const paths = runingTeamPaths(cwd, session.session_id);
  const plan: RuningTeamPlan = {
    plan_version: 1,
    task,
    intent: `RuningTeam dynamic plan for: ${task}`,
    acceptance_criteria: ['final synthesis is created before completion', 'worker evidence is checkpointed before revision'],
    non_goals: ['no MVP framing', 'no manual ralplan pre-step'],
    lanes: [
      { id: 'tests', title: 'Tests and regression evidence', status: 'pending', acceptance_criteria: ['tests are recorded'] },
      { id: 'implementation', title: 'Implementation lane', status: 'pending', acceptance_criteria: ['implementation evidence is recorded'] },
    ],
  };
  await writeJson(paths.session, session);
  await writeJson(paths.plan, plan);
  await writeJson(paths.lanes, { lanes: plan.lanes });
  return session;
}

export async function readRuningTeamSession(cwd: string, sessionId: string): Promise<RuningTeamSession> {
  return validateRuningTeamSession(await readJson(runingTeamPaths(cwd, sessionId).session));
}

export async function readRuningTeamPlan(cwd: string, sessionId: string): Promise<RuningTeamPlan> {
  return validateRuningTeamPlan(await readJson(runingTeamPaths(cwd, sessionId).plan));
}

export async function updateRuningTeamSession(cwd: string, sessionId: string, updates: Partial<RuningTeamSession>): Promise<RuningTeamSession> {
  const current = await readRuningTeamSession(cwd, sessionId);
  const next = validateRuningTeamSession({ ...current, ...updates, updated_at: new Date().toISOString() });
  await writeJson(runingTeamPaths(cwd, sessionId).session, next);
  return next;
}

export async function assertRuningTeamCompletionReady(cwd: string, sessionId: string): Promise<void> {
  const paths = runingTeamPaths(cwd, sessionId);
  if (!existsSync(paths.finalSynthesis)) {
    throw new Error('complete_requires_final_synthesis');
  }
  const session = await readRuningTeamSession(cwd, sessionId);
  const verdictPath = paths.verdictJson(session.iteration);
  if (!existsSync(verdictPath)) {
    throw new Error('complete_requires_final_synthesis_ready_verdict');
  }
  const verdict = validateCriticVerdictRecord(await readJson<unknown>(verdictPath));
  if (verdict.verdict !== 'FINAL_SYNTHESIS_READY') {
    throw new Error('complete_requires_final_synthesis_ready_verdict');
  }
}

export async function transitionRuningTeamSession(cwd: string, sessionId: string, to: RuningTeamStatus): Promise<RuningTeamSession> {
  const current = await readRuningTeamSession(cwd, sessionId);
  if (RUNINGTEAM_TERMINAL_STATUSES.has(current.status) && current.status !== to) {
    throw new Error('terminal_states_require_explicit_recovery');
  }
  if (to === 'complete') {
    await assertRuningTeamCompletionReady(cwd, sessionId);
  }
  return await updateRuningTeamSession(cwd, sessionId, { status: to, terminal_reason: to === 'complete' ? 'final synthesis ready' : current.terminal_reason });
}

export async function writeFinalSynthesis(cwd: string, sessionId: string, content: string): Promise<string> {
  const paths = runingTeamPaths(cwd, sessionId);
  await mkdir(dirname(paths.finalSynthesis), { recursive: true });
  await writeFile(paths.finalSynthesis, content.trimEnd() + '\n', 'utf-8');
  await updateRuningTeamSession(cwd, sessionId, { status: 'synthesizing' });
  return paths.finalSynthesis;
}

export async function listRuningTeamSessions(cwd: string): Promise<RuningTeamSessionSummary[]> {
  const root = runingTeamRoot(cwd);
  if (!existsSync(root)) return [];
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true });
  const sessions: RuningTeamSessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const session = await readRuningTeamSession(cwd, entry.name);
      sessions.push({
        session_id: session.session_id,
        status: session.status,
        iteration: session.iteration,
        plan_version: session.plan_version,
        team_name: session.team_name,
        final_synthesis_present: existsSync(runingTeamPaths(cwd, session.session_id).finalSynthesis),
      });
    } catch {
      // Ignore malformed session directories in status listings.
    }
  }
  return sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));
}

export async function linkRuningTeamTeamAdapter(cwd: string, sessionId: string, adapter: RuningTeamTeamAdapterState): Promise<void> {
  await writeJson(runingTeamPaths(cwd, sessionId).adapterTeam, adapter);
  await updateRuningTeamSession(cwd, sessionId, { team_name: adapter.team_name });
}

function parseResultEvidence(result: string): { files: string[]; commands: string[]; tests: string[] } {
  if (!result.trim()) return { files: [], commands: [], tests: [] };
  const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const listMatches = (label: string) => {
    const pattern = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'gim');
    return unique([...result.matchAll(pattern)].flatMap((match) => String(match[1] ?? '').split(/[,;|]/)));
  };
  const files = listMatches('Files changed');
  const commands = listMatches('(?:Command|Commands|Verification)');
  const tests = listMatches('(?:Test|Tests)');

  for (const line of result.split(/\r?\n/).map((entry) => entry.trim())) {
    if (!/^(?:PASS|FAIL)\b/i.test(line)) continue;
    if (!/(?:npm|node|tsc|vitest|jest|biome|eslint|cargo|python|pytest|go test|make)\b/i.test(line)) continue;
    const commandMatch = line.match(/(?:-|:|→)\s*`?([^`]+?)`?\s*(?:→|$)/);
    const command = (commandMatch?.[1] ?? line.replace(/^(?:PASS|FAIL)\b\s*[-:]?\s*/i, '')).trim();
    if (!command) continue;
    if (/test|spec|vitest|jest|pytest|go test|cargo test/i.test(command)) tests.push(command);
    else commands.push(command);
  }

  if (files.length === 0) {
    files.push(...[...result.matchAll(/`([^`]+\.(?:ts|tsx|js|jsx|json|md|mdx|yml|yaml))`/g)].map((match) => match[1] ?? ''));
  }

  return { files: unique(files), commands: unique(commands), tests: unique(tests) };
}

function evidenceFromTeamEvent(event: TeamEvent, planVersion: number, laneTaskMap: Record<string, string>, task?: TeamTask | null): RuningTeamWorkerEvidence | null {
  if (event.type !== 'task_completed' && event.type !== 'task_failed') return null;
  const taskId = event.task_id;
  if (!taskId) return null;
  const lane = Object.entries(laneTaskMap).find(([, mappedTaskId]) => mappedTaskId === taskId)?.[0] ?? taskId;
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const parsedResult = parseResultEvidence(typeof task?.result === 'string' ? task.result : '');
  const filesChanged = Array.isArray(metadata.files_changed)
    ? metadata.files_changed.filter((v): v is string => typeof v === 'string')
    : task?.filePaths?.length
      ? task.filePaths
      : parsedResult.files;
  const commands = Array.isArray(metadata.commands) ? metadata.commands.filter((v): v is string => typeof v === 'string') : parsedResult.commands;
  const tests = Array.isArray(metadata.tests) ? metadata.tests.filter((v): v is string => typeof v === 'string') : parsedResult.tests;
  return {
    evidence_id: event.event_id,
    worker: event.worker,
    lane,
    task_id: taskId,
    plan_version: planVersion,
    files_changed: filesChanged,
    commands,
    tests,
    summary: event.reason ?? `${event.type} from ${event.worker}`,
    supported: event.type === 'task_completed' && commands.length + tests.length > 0,
    created_at: event.created_at,
  };
}

export async function ingestTeamEvidence(cwd: string, sessionId: string): Promise<RuningTeamWorkerEvidence[]> {
  const paths = runingTeamPaths(cwd, sessionId);
  const session = await readRuningTeamSession(cwd, sessionId);
  const adapter = await readJson<RuningTeamTeamAdapterState>(paths.adapterTeam);
  const events = await readTeamEvents(adapter.team_name, cwd, { afterEventId: adapter.cursor, wakeableOnly: false });
  const seen = new Set<string>();
  const evidence: RuningTeamWorkerEvidence[] = [];
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    const task = event.task_id ? await readTask(adapter.team_name, event.task_id, cwd) : null;
    const record = evidenceFromTeamEvent(event, session.plan_version, adapter.lane_task_map, task);
    if (record) evidence.push(record);
    adapter.cursor = event.event_id;
  }
  if (evidence.length > 0) {
    await mkdir(dirname(paths.evidenceEvents), { recursive: true });
    await appendFile(paths.evidenceEvents, evidence.map((record) => JSON.stringify({ type: 'worker_evidence_received', ...record })).join('\n') + '\n', 'utf-8');
  }
  await writeJson(paths.adapterTeam, adapter);
  return evidence;
}

export async function readEvidence(cwd: string, sessionId: string): Promise<RuningTeamWorkerEvidence[]> {
  const path = runingTeamPaths(cwd, sessionId).evidenceEvents;
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RuningTeamWorkerEvidence);
}

export async function createCheckpoint(cwd: string, sessionId: string, opts: { force?: boolean } = {}): Promise<RuningTeamCheckpoint> {
  const session = await readRuningTeamSession(cwd, sessionId);
  const evidence = await readEvidence(cwd, sessionId);
  if (!opts.force && evidence.length === 0) throw new Error('checkpoint_requires_new_evidence');
  const iteration = session.iteration + 1;
  const checkpoint: RuningTeamCheckpoint = {
    iteration,
    plan_version: session.plan_version,
    created_at: new Date().toISOString(),
    evidence_ids: evidence.map((entry) => entry.evidence_id),
    lane_status: Object.fromEntries(evidence.map((entry) => [entry.lane, entry.supported ? 'evidence-supported' : 'evidence-unsupported'])),
    blockers: evidence.filter((entry) => !entry.supported).map((entry) => entry.evidence_id),
    summary: `Checkpoint ${iteration}: ${evidence.length} evidence record(s)`,
  };
  const paths = runingTeamPaths(cwd, sessionId);
  await writeJson(paths.checkpointJson(iteration), checkpoint);
  await mkdir(dirname(paths.checkpointMd(iteration)), { recursive: true });
  await writeFile(paths.checkpointMd(iteration), `# RuningTeam Checkpoint ${iteration}\n\n${checkpoint.summary}\n`, 'utf-8');
  await updateRuningTeamSession(cwd, sessionId, { status: 'checkpointing', iteration });
  return checkpoint;
}

export async function writeCriticVerdict(cwd: string, sessionId: string, record: RuningTeamCriticVerdictRecord): Promise<RuningTeamCriticVerdictRecord> {
  const validated = validateCriticVerdictRecord(record);
  await writeJson(runingTeamPaths(cwd, sessionId).verdictJson(validated.iteration), validated);
  await updateRuningTeamSession(cwd, sessionId, { status: 'reviewing' });
  return validated;
}

export async function revisePlan(cwd: string, sessionId: string, revision: RuningTeamPlannerRevision): Promise<RuningTeamPlan> {
  const validatedRevision = validatePlannerRevision(revision);
  const paths = runingTeamPaths(cwd, sessionId);
  if (!existsSync(paths.checkpointJson(validatedRevision.iteration))) throw new Error('revision_requires_checkpoint');
  if (!existsSync(paths.verdictJson(validatedRevision.iteration))) throw new Error('revision_requires_critic_verdict');
  const currentPlan = await readRuningTeamPlan(cwd, sessionId);
  const nextPlan = validateRuningTeamPlan({ ...currentPlan, plan_version: validatedRevision.to_plan_version });
  await writeJson(paths.revisionJson(validatedRevision.iteration), validatedRevision);
  await writeJson(paths.plan, nextPlan);
  await updateRuningTeamSession(cwd, sessionId, { status: 'revising', plan_version: nextPlan.plan_version });
  return nextPlan;
}
