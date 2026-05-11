import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { omxStateDir } from '../utils/paths.js';
import { listTasks, readTask, readTeamConfig, type TeamTask } from '../team/state.js';
import { readTeamEvents } from '../team/state/events.js';
import type { TeamEvent } from '../team/state.js';
import type { TeamEventType } from '../team/contracts.js';

export interface RuningTeamTeamAdapterState {
  team_name: string;
  team_state_root: string;
  event_cursor: string | null;
  worker_map: Record<string, string>;
  task_map: Record<string, string>;
  ingested_event_ids?: string[];
}

export interface RuningTeamCommandEvidence {
  command: string;
  exit_code: number;
  summary: string;
}

export interface RuningTeamTestEvidence {
  command: string;
  status: 'pass' | 'fail' | 'not_run' | 'fail_expected';
  summary: string;
}

export interface RuningTeamWorkerEvidenceReceived {
  type: 'worker_evidence_received';
  event_id: string;
  session_id: string;
  created_at: string;
  iteration: number;
  plan_version: number;
  team_name: string;
  worker: string;
  lane: string;
  task_id: string;
  claim: string;
  files_changed: string[];
  commands_run: RuningTeamCommandEvidence[];
  tests_run: RuningTeamTestEvidence[];
  blockers: string[];
  next_needed: string;
  source_team_event_id: string;
}

export interface RuningTeamTeamEventIngested {
  type: 'team_event_ingested';
  event_id: string;
  session_id: string;
  created_at: string;
  iteration: number;
  plan_version: number;
  team_name: string;
  worker: string;
  lane: string;
  task_id: string;
  team_event_type: TeamEventType;
  source_team_event_id: string;
  blockers: string[];
}

export type RuningTeamAdapterEvidenceEvent = RuningTeamWorkerEvidenceReceived | RuningTeamTeamEventIngested;

export interface RuningTeamEvidenceIngestOptions {
  cwd: string;
  sessionId: string;
  iteration: number;
  planVersion: number;
  teamName?: string;
  state?: RuningTeamTeamAdapterState;
  now?: Date;
}

export interface RuningTeamEvidenceIngestResult {
  state: RuningTeamTeamAdapterState;
  events: RuningTeamAdapterEvidenceEvent[];
  cursor: string | null;
  ingestedCount: number;
  skippedDuplicateCount: number;
}

function runingTeamSessionDir(cwd: string, sessionId: string): string {
  return join(resolve(cwd, '.omx', 'state'), 'runingteam', sessionId);
}

export function runingTeamAdapterStatePath(cwd: string, sessionId: string): string {
  return join(runingTeamSessionDir(cwd, sessionId), 'adapter', 'team.json');
}

export function runingTeamEvidenceLogPath(cwd: string, sessionId: string): string {
  return join(runingTeamSessionDir(cwd, sessionId), 'evidence', 'events.ndjson');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`)
    .join(',')}}`;
}

function stableEventId(sessionId: string, sourceTeamEventId: string, kind: string): string {
  const hash = createHash('sha256')
    .update(`${sessionId}:${sourceTeamEventId}:${kind}`)
    .digest('hex')
    .slice(0, 24);
  return `rte_${hash}`;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))];
}

function metadataRecord(event: TeamEvent): Record<string, unknown> {
  return event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
}

function extractFilesChanged(event: TeamEvent, task: TeamTask | null): string[] {
  const metadata = metadataRecord(event);
  const candidates: unknown[] = [
    metadata.files_changed,
    metadata.changed_files,
    metadata.files,
    metadata.conflict_files,
    task?.filePaths,
  ];
  return [...new Set(candidates.flatMap(uniqueStrings))];
}

function normalizeCommandEvidence(value: unknown): RuningTeamCommandEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RuningTeamCommandEvidence[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!command) return [];
    const exitCode = typeof record.exit_code === 'number'
      ? record.exit_code
      : typeof record.exitCode === 'number'
        ? record.exitCode
        : 0;
    const summary = typeof record.summary === 'string' && record.summary.trim() !== ''
      ? record.summary.trim()
      : `exit_code=${exitCode}`;
    return [{ command, exit_code: exitCode, summary }];
  });
}

function normalizeTestStatus(value: unknown): RuningTeamTestEvidence['status'] {
  return value === 'pass' || value === 'fail' || value === 'not_run' || value === 'fail_expected'
    ? value
    : 'not_run';
}

function normalizeTestEvidence(value: unknown): RuningTeamTestEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RuningTeamTestEvidence[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!command) return [];
    const status = normalizeTestStatus(record.status);
    const summary = typeof record.summary === 'string' && record.summary.trim() !== ''
      ? record.summary.trim()
      : status;
    return [{ command, status, summary }];
  });
}

function summarizeTaskResultCommands(task: TeamTask | null): { commands: RuningTeamCommandEvidence[]; tests: RuningTeamTestEvidence[] } {
  const result = task?.result ?? '';
  if (!result) return { commands: [], tests: [] };

  const commandLines = result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:PASS|FAIL)\b.*(?:npm|node|tsc|vitest|jest|biome|eslint|cargo|python|pytest|go test|make)\b/i.test(line));

  const tests: RuningTeamTestEvidence[] = [];
  const commands: RuningTeamCommandEvidence[] = [];
  for (const line of commandLines) {
    const status: RuningTeamTestEvidence['status'] = /^PASS\b/i.test(line) ? 'pass' : /^FAIL\b/i.test(line) ? 'fail' : 'not_run';
    const commandMatch = line.match(/(?:-|:|→)\s*`?([^`]+?)`?\s*(?:→|$)/);
    const command = commandMatch?.[1]?.trim() || line.replace(/^(?:PASS|FAIL)\b\s*[-:]?\s*/i, '').trim();
    if (/test|spec|vitest|jest|pytest|go test|cargo test/i.test(command)) {
      tests.push({ command, status, summary: line });
    } else {
      commands.push({ command, exit_code: status === 'fail' ? 1 : 0, summary: line });
    }
  }
  return { commands, tests };
}

function eventType(event: TeamEvent): TeamEventType {
  return String(event.type) as TeamEventType;
}

function extractBlockers(event: TeamEvent, task: TeamTask | null): string[] {
  const metadata = metadataRecord(event);
  const blockers = uniqueStrings(metadata.blockers);
  if (event.reason && (eventType(event) === 'task_failed' || eventType(event) === 'worker_stale_diff' || eventType(event) === 'worker_stale_heartbeat' || eventType(event) === 'worker_stale_stdout')) {
    blockers.push(event.reason);
  }
  if (task?.error) blockers.push(task.error);
  return [...new Set(blockers)];
}

function eventShouldBecomeWorkerEvidence(event: TeamEvent, task: TeamTask | null): boolean {
  const metadata = metadataRecord(event);
  return eventType(event) === 'task_completed'
    || eventType(event) === 'task_failed'
    || Array.isArray(metadata.commands_run)
    || Array.isArray(metadata.tests_run)
    || Array.isArray(metadata.files_changed)
    || Boolean(task?.error);
}

function mapLane(state: RuningTeamTeamAdapterState, event: TeamEvent, task: TeamTask | null): string {
  if (event.task_id && state.task_map[event.task_id]) return state.task_map[event.task_id];
  if (event.worker && state.worker_map[event.worker]) return state.worker_map[event.worker];
  if (typeof task?.lane === 'string' && task.lane.trim() !== '') return task.lane.trim();
  return event.task_id ? `team-task-${event.task_id}` : event.worker;
}

function claimFor(event: TeamEvent, task: TeamTask | null): string {
  const metadata = metadataRecord(event);
  const metadataClaim = typeof metadata.claim === 'string' ? metadata.claim.trim() : '';
  if (metadataClaim) return metadataClaim;
  if (task?.claim?.token) return task.claim.token;
  return event.event_id;
}

function buildEvidenceEvent(params: {
  event: TeamEvent;
  task: TeamTask | null;
  state: RuningTeamTeamAdapterState;
  sessionId: string;
  iteration: number;
  planVersion: number;
  createdAt: string;
}): RuningTeamAdapterEvidenceEvent {
  const { event, task, state, sessionId, iteration, planVersion, createdAt } = params;
  const lane = mapLane(state, event, task);
  const taskId = event.task_id ?? task?.id ?? '';
  const blockers = extractBlockers(event, task);
  if (eventShouldBecomeWorkerEvidence(event, task)) {
    const metadata = metadataRecord(event);
    const summarized = summarizeTaskResultCommands(task);
    return {
      type: 'worker_evidence_received',
      event_id: stableEventId(sessionId, event.event_id, 'worker_evidence_received'),
      session_id: sessionId,
      created_at: createdAt,
      iteration,
      plan_version: planVersion,
      team_name: event.team,
      worker: event.worker,
      lane,
      task_id: taskId,
      claim: claimFor(event, task),
      files_changed: extractFilesChanged(event, task),
      commands_run: normalizeCommandEvidence(metadata.commands_run).concat(summarized.commands),
      tests_run: normalizeTestEvidence(metadata.tests_run).concat(summarized.tests),
      blockers,
      next_needed: typeof metadata.next_needed === 'string' ? metadata.next_needed : blockers.length > 0 ? 'resolve_blockers' : 'checkpoint_review',
      source_team_event_id: event.event_id,
    };
  }

  return {
    type: 'team_event_ingested',
    event_id: stableEventId(sessionId, event.event_id, 'team_event_ingested'),
    session_id: sessionId,
    created_at: createdAt,
    iteration,
    plan_version: planVersion,
    team_name: event.team,
    worker: event.worker,
    lane,
    task_id: taskId,
    team_event_type: eventType(event),
    source_team_event_id: event.event_id,
    blockers,
  };
}

function mergeState(base: RuningTeamTeamAdapterState, patch: Partial<RuningTeamTeamAdapterState>): RuningTeamTeamAdapterState {
  return {
    ...base,
    ...patch,
    worker_map: { ...base.worker_map, ...(patch.worker_map ?? {}) },
    task_map: { ...base.task_map, ...(patch.task_map ?? {}) },
    ingested_event_ids: [...new Set([...(base.ingested_event_ids ?? []), ...(patch.ingested_event_ids ?? [])])],
  };
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function readRuningTeamAdapterState(cwd: string, sessionId: string): Promise<RuningTeamTeamAdapterState | null> {
  return await readJsonIfExists<RuningTeamTeamAdapterState>(runingTeamAdapterStatePath(cwd, sessionId));
}

export async function writeRuningTeamAdapterState(cwd: string, sessionId: string, state: RuningTeamTeamAdapterState): Promise<void> {
  const path = runingTeamAdapterStatePath(cwd, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export async function appendRuningTeamEvidenceEvents(cwd: string, sessionId: string, events: RuningTeamAdapterEvidenceEvent[]): Promise<void> {
  if (events.length === 0) return;
  const path = runingTeamEvidenceLogPath(cwd, sessionId);
  await mkdir(dirname(path), { recursive: true });
  const existingRaw = existsSync(path) ? await readFile(path, 'utf-8').catch(() => '') : '';
  const existingIds = new Set(existingRaw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { event_id?: unknown };
        return typeof parsed.event_id === 'string' ? [parsed.event_id] : [];
      } catch {
        return [];
      }
    }));
  const lines = events
    .filter((event) => !existingIds.has(event.event_id))
    .map((event) => stableJson(event));
  if (lines.length > 0) {
    await writeFile(path, `${existingRaw}${existingRaw && !existingRaw.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`, 'utf-8');
  }
}

export async function initializeRuningTeamAdapterState(params: {
  cwd: string;
  sessionId: string;
  teamName: string;
  workerMap?: Record<string, string>;
  taskMap?: Record<string, string>;
}): Promise<RuningTeamTeamAdapterState> {
  const existing = await readRuningTeamAdapterState(params.cwd, params.sessionId);
  if (existing) return mergeState(existing, { team_name: params.teamName, worker_map: params.workerMap, task_map: params.taskMap });

  const config = await readTeamConfig(params.teamName, params.cwd);
  const tasks = await listTasks(params.teamName, params.cwd).catch(() => []);
  const inferredWorkerMap: Record<string, string> = {};
  const inferredTaskMap: Record<string, string> = {};
  for (const task of tasks) {
    const lane = typeof task.lane === 'string' && task.lane.trim() !== '' ? task.lane.trim() : `team-task-${task.id}`;
    inferredTaskMap[task.id] = lane;
    if (task.owner) inferredWorkerMap[task.owner] = lane;
  }
  for (const worker of config?.workers ?? []) {
    inferredWorkerMap[worker.name] = params.workerMap?.[worker.name] ?? inferredWorkerMap[worker.name] ?? worker.assigned_tasks.map((id) => inferredTaskMap[id]).find(Boolean) ?? worker.name;
  }

  const state: RuningTeamTeamAdapterState = {
    team_name: params.teamName,
    team_state_root: config?.team_state_root ?? join(omxStateDir(params.cwd), 'team', params.teamName),
    event_cursor: null,
    worker_map: { ...inferredWorkerMap, ...(params.workerMap ?? {}) },
    task_map: { ...inferredTaskMap, ...(params.taskMap ?? {}) },
    ingested_event_ids: [],
  };
  await writeRuningTeamAdapterState(params.cwd, params.sessionId, state);
  return state;
}

export async function ingestRuningTeamAdapterEvidence(options: RuningTeamEvidenceIngestOptions): Promise<RuningTeamEvidenceIngestResult> {
  const existing = options.state
    ?? await readRuningTeamAdapterState(options.cwd, options.sessionId);
  const state = existing
    ?? await initializeRuningTeamAdapterState({
      cwd: options.cwd,
      sessionId: options.sessionId,
      teamName: options.teamName ?? '',
    });
  const teamName = options.teamName ?? state.team_name;
  if (!teamName) throw new Error('team_name_required');

  const teamEvents = await readTeamEvents(teamName, options.cwd, {
    afterEventId: state.event_cursor ?? undefined,
    wakeableOnly: false,
  });
  const seen = new Set(state.ingested_event_ids ?? []);
  const produced: RuningTeamAdapterEvidenceEvent[] = [];
  let skippedDuplicateCount = 0;

  for (const event of teamEvents) {
    if (seen.has(event.event_id)) {
      skippedDuplicateCount++;
      continue;
    }
    const task = event.task_id ? await readTask(teamName, event.task_id, options.cwd) : null;
    produced.push(buildEvidenceEvent({
      event,
      task,
      state,
      sessionId: options.sessionId,
      iteration: options.iteration,
      planVersion: options.planVersion,
      createdAt: (options.now ?? new Date()).toISOString(),
    }));
    seen.add(event.event_id);
  }

  const nextState = mergeState(state, {
    team_name: teamName,
    event_cursor: teamEvents.at(-1)?.event_id ?? state.event_cursor,
    ingested_event_ids: [...seen],
  });
  await appendRuningTeamEvidenceEvents(options.cwd, options.sessionId, produced);
  await writeRuningTeamAdapterState(options.cwd, options.sessionId, nextState);

  return {
    state: nextState,
    events: produced,
    cursor: nextState.event_cursor,
    ingestedCount: produced.length,
    skippedDuplicateCount,
  };
}
