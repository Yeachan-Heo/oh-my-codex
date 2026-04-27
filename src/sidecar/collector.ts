import { open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TEAM_NAME_SAFE_PATTERN, TEAM_TASK_STATUSES, WORKER_NAME_SAFE_PATTERN } from '../team/contracts.js';
import type {
  CollectSidecarSnapshotOptions,
  SidecarEvent,
  SidecarHighlight,
  SidecarPaneMapping,
  SidecarSnapshot,
  SidecarTask,
  SidecarTeamConfig,
  SidecarTopology,
  SidecarWorkerHeartbeat,
  SidecarWorkerInfo,
  SidecarWorkerSnapshot,
  SidecarWorkerState,
  SidecarWorkerStatus,
} from './types.js';

const WORKER_STATES = ['idle', 'working', 'blocked', 'done', 'failed', 'draining', 'unknown'] as const;
const DEFAULT_EVENT_LIMIT = 12;
const DEFAULT_EVENT_TAIL_BYTES = 64 * 1024;

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const safe = safeString(value);
  return safe || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asWorkerState(value: unknown): SidecarWorkerState {
  return typeof value === 'string' && (WORKER_STATES as readonly string[]).includes(value) ? value as SidecarWorkerState : 'unknown';
}

function asTaskStatus(value: unknown): SidecarTask['status'] {
  return typeof value === 'string' && (TEAM_TASK_STATUSES as readonly string[]).includes(value) ? value as SidecarTask['status'] : 'pending';
}

function stateRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  const explicit = safeString(env.OMX_TEAM_STATE_ROOT);
  return explicit ? resolve(cwd, explicit) : join(cwd, '.omx', 'state');
}

function teamRoot(teamName: string, cwd: string, env: NodeJS.ProcessEnv): string {
  return join(stateRoot(cwd, env), 'team', teamName);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface NormalizedConfig {
  config: SidecarTeamConfig;
  warnings: string[];
}

function normalizeWorker(raw: unknown, indexFallback: number): { worker: SidecarWorkerInfo | null; warning?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = safeString(value.name);
  if (!name) return { worker: null };
  if (!WORKER_NAME_SAFE_PATTERN.test(name)) {
    return { worker: null, warning: `skipped unsafe worker name: ${name}` };
  }
  return {
    worker: {
      name,
      index: optionalNumber(value.index) ?? indexFallback,
      role: safeString(value.role) || 'executor',
      assigned_tasks: asStringArray(value.assigned_tasks),
      pane_id: optionalString(value.pane_id),
      worker_cli: optionalString(value.worker_cli),
      working_dir: optionalString(value.working_dir),
      worktree_path: optionalString(value.worktree_path),
      worktree_branch: optionalString(value.worktree_branch),
    },
  };
}

function normalizeConfig(raw: unknown): NormalizedConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = safeString(value.name);
  if (!name) return null;
  const warnings: string[] = [];
  const workers = Array.isArray(value.workers)
    ? value.workers.map((worker, index) => normalizeWorker(worker, index + 1)).flatMap((normalized): SidecarWorkerInfo[] => {
      if (!normalized) return [];
      if (normalized.warning) warnings.push(normalized.warning);
      return normalized.worker ? [normalized.worker] : [];
    })
    : [];
  return {
    config: {
      name,
      task: safeString(value.task),
      worker_count: optionalNumber(value.worker_count) ?? workers.length,
      tmux_session: safeString(value.tmux_session),
      leader_pane_id: optionalString(value.leader_pane_id) ?? null,
      hud_pane_id: optionalString(value.hud_pane_id) ?? null,
      workers,
    },
    warnings,
  };
}

async function readSidecarConfig(root: string): Promise<{ config: SidecarTeamConfig | null; source: string | null; warnings: string[] }> {
  const manifestPath = join(root, 'manifest.v2.json');
  const manifest = await readJson<unknown>(manifestPath);
  const manifestConfig = normalizeConfig(manifest);
  if (manifestConfig) return { config: manifestConfig.config, source: manifestPath, warnings: manifestConfig.warnings };

  const configPath = join(root, 'config.json');
  const legacy = await readJson<unknown>(configPath);
  const legacyConfig = normalizeConfig(legacy);
  if (legacyConfig) return { config: legacyConfig.config, source: configPath, warnings: legacyConfig.warnings };

  return { config: null, source: null, warnings: [] };
}

function normalizeTask(raw: unknown): SidecarTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = safeString(value.id);
  if (!id) return null;
  const claim = value.claim && typeof value.claim === 'object'
    ? value.claim as Record<string, unknown>
    : null;
  return {
    id,
    subject: safeString(value.subject) || `task-${id}`,
    description: safeString(value.description),
    status: asTaskStatus(value.status),
    owner: optionalString(value.owner),
    role: optionalString(value.role),
    result: optionalString(value.result),
    error: optionalString(value.error),
    blocked_by: asStringArray(value.blocked_by),
    depends_on: asStringArray(value.depends_on),
    version: optionalNumber(value.version),
    claim: claim && safeString(claim.owner) && safeString(claim.leased_until)
      ? { owner: safeString(claim.owner), leased_until: safeString(claim.leased_until) }
      : undefined,
    created_at: optionalString(value.created_at),
    completed_at: optionalString(value.completed_at),
  };
}

async function readTasks(root: string): Promise<SidecarTask[]> {
  const tasksRoot = join(root, 'tasks');
  let files: string[] = [];
  try {
    files = await readdir(tasksRoot);
  } catch {
    return [];
  }
  const tasks = await Promise.all(
    files
      .filter((file) => /^task-\d+\.json$/.test(file))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
      .map((file) => readJson<unknown>(join(tasksRoot, file)).then(normalizeTask)),
  );
  return tasks.filter((task): task is SidecarTask => task !== null);
}

async function readWorkerStatus(root: string, workerName: string): Promise<SidecarWorkerStatus> {
  const raw = await readJson<Record<string, unknown>>(join(root, 'workers', workerName, 'status.json'));
  return {
    state: asWorkerState(raw?.state),
    current_task_id: optionalString(raw?.current_task_id),
    reason: optionalString(raw?.reason),
    updated_at: optionalString(raw?.updated_at),
  };
}

async function readWorkerHeartbeat(root: string, workerName: string): Promise<SidecarWorkerHeartbeat | null> {
  const raw = await readJson<Record<string, unknown>>(join(root, 'workers', workerName, 'heartbeat.json'));
  if (!raw) return null;
  return {
    pid: optionalNumber(raw.pid),
    last_turn_at: optionalString(raw.last_turn_at),
    turn_count: optionalNumber(raw.turn_count),
    alive: typeof raw.alive === 'boolean' ? raw.alive : undefined,
  };
}

async function readPhase(root: string): Promise<string | null> {
  const raw = await readJson<Record<string, unknown>>(join(root, 'phase.json'));
  return optionalString(raw?.current_phase) ?? null;
}

async function readMonitorSnapshot(root: string): Promise<Record<string, unknown> | null> {
  return readJson<Record<string, unknown>>(join(root, 'monitor-snapshot.json'));
}

function normalizeEvent(raw: unknown): SidecarEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const eventId = safeString(value.event_id);
  const team = safeString(value.team);
  const type = safeString(value.type);
  const worker = safeString(value.worker);
  const createdAt = safeString(value.created_at);
  if (!eventId || !team || !type || !worker || !createdAt) return null;
  if (type === 'worker_idle') {
    return {
      event_id: eventId,
      team,
      type: 'worker_state_changed',
      source_type: 'worker_idle',
      worker,
      task_id: optionalString(value.task_id),
      state: 'idle',
      prev_state: value.prev_state ? asWorkerState(value.prev_state) : undefined,
      reason: optionalString(value.reason),
      created_at: createdAt,
    };
  }
  return {
    event_id: eventId,
    team,
    type,
    worker,
    task_id: optionalString(value.task_id),
    state: value.state ? asWorkerState(value.state) : undefined,
    prev_state: value.prev_state ? asWorkerState(value.prev_state) : undefined,
    reason: optionalString(value.reason),
    source_type: optionalString(value.source_type),
    created_at: createdAt,
  };
}

export async function readTailText(path: string, maxBytes: number = DEFAULT_EVENT_TAIL_BYTES): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, 'r');
    const stats = await file.stat();
    if (!stats.isFile()) return null;
    const bytesToRead = Math.min(stats.size, Math.max(1, Math.floor(maxBytes)));
    const buffer = Buffer.alloc(bytesToRead);
    await file.read(buffer, 0, bytesToRead, stats.size - bytesToRead);
    return buffer.toString('utf-8');
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readEvents(root: string, limit: number): Promise<SidecarEvent[]> {
  const path = join(root, 'events', 'events.ndjson');
  const raw = await readTailText(path, DEFAULT_EVENT_TAIL_BYTES);
  if (!raw) return [];
  const lines = raw
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length > 0 && !raw.startsWith('{')) lines.shift();
  return lines
    .map((line) => {
      try { return normalizeEvent(JSON.parse(line) as unknown); } catch { return null; }
    })
    .filter((event): event is SidecarEvent => event !== null)
    .slice(-Math.max(1, limit));
}

function readRecordNumber(record: unknown, key: string): number | null {
  if (!record || typeof record !== 'object') return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRecordString(record: unknown, key: string): string {
  if (!record || typeof record !== 'object') return '';
  return safeString((record as Record<string, unknown>)[key]);
}

function buildWorkers(config: SidecarTeamConfig, tasks: SidecarTask[], root: string, monitorSnapshot: Record<string, unknown> | null): Promise<SidecarWorkerSnapshot[]> {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const previousTurns = monitorSnapshot?.workerTurnCountByName;
  const previousTaskIds = monitorSnapshot?.workerTaskIdByName;
  return Promise.all(config.workers.map(async (worker) => {
    const [status, heartbeat] = await Promise.all([
      readWorkerStatus(root, worker.name),
      readWorkerHeartbeat(root, worker.name),
    ]);
    const currentTaskId = status.current_task_id ?? '';
    const currentTask = currentTaskId ? taskById.get(currentTaskId) ?? null : null;
    const prevTaskId = readRecordString(previousTaskIds, worker.name);
    const prevTurnCount = readRecordNumber(previousTurns, worker.name);
    const currentTurnCount = heartbeat?.turn_count;
    const turnsWithoutProgress =
      status.state === 'working' && currentTask && prevTaskId === currentTaskId && prevTurnCount !== null && typeof currentTurnCount === 'number'
        ? Math.max(0, currentTurnCount - prevTurnCount)
        : null;
    return {
      ...worker,
      status,
      heartbeat,
      alive: typeof heartbeat?.alive === 'boolean' ? heartbeat.alive : null,
      current_task: currentTask,
      turns_without_progress: turnsWithoutProgress,
    };
  }));
}

function buildPanes(config: SidecarTeamConfig): SidecarPaneMapping[] {
  return [
    config.leader_pane_id ? { target: 'leader', pane_id: config.leader_pane_id, role: 'leader' as const } : null,
    config.hud_pane_id ? { target: 'hud', pane_id: config.hud_pane_id, role: 'hud' as const } : null,
    ...config.workers.map((worker) => worker.pane_id ? { target: worker.name, pane_id: worker.pane_id, role: 'worker' as const } : null),
  ].filter((pane): pane is NonNullable<typeof pane> => pane !== null);
}

function buildHighlights(workers: SidecarWorkerSnapshot[], tasks: SidecarTask[]): SidecarHighlight[] {
  const highlights: SidecarHighlight[] = [];
  for (const worker of workers) {
    if (worker.status.state === 'blocked') {
      highlights.push({ severity: 'warning', target: worker.name, kind: 'blocked-worker', message: worker.status.reason || `${worker.name} is blocked` });
    }
    if (worker.alive === false) {
      highlights.push({ severity: 'critical', target: worker.name, kind: 'dead-worker', message: `${worker.name} heartbeat reports not alive` });
    }
    if (typeof worker.turns_without_progress === 'number' && worker.turns_without_progress > 5) {
      highlights.push({ severity: 'warning', target: worker.name, kind: 'non-reporting-worker', message: `${worker.name} has ${worker.turns_without_progress} turns without task progress` });
    }
  }
  for (const task of tasks) {
    if (task.status === 'blocked') {
      highlights.push({ severity: 'warning', target: `task-${task.id}`, kind: 'blocked-task', message: task.subject || `task-${task.id} is blocked` });
    }
    if (task.status === 'failed') {
      highlights.push({ severity: 'critical', target: `task-${task.id}`, kind: 'failed-task', message: task.error || task.subject || `task-${task.id} failed` });
    }
  }
  return highlights;
}

function buildTopology(workers: SidecarWorkerSnapshot[], tasks: SidecarTask[]): SidecarTopology {
  const activeWorkers = workers.filter((worker) => worker.status.state === 'working').length;
  const blockedWorkers = workers.filter((worker) => worker.status.state === 'blocked').length;
  const pendingTasks = tasks.filter((task) => task.status === 'pending').length;
  const inProgressTasks = tasks.filter((task) => task.status === 'in_progress').length;
  return {
    summary: `${workers.length} workers · ${activeWorkers} working · ${blockedWorkers} blocked · ${inProgressTasks} in progress · ${pendingTasks} pending`,
    nodes: ['leader', ...workers.map((worker) => worker.name)],
    edges: workers.map((worker) => ({ from: 'leader', to: worker.name, label: worker.current_task ? `task-${worker.current_task.id}` : worker.status.state })),
  };
}

export async function collectSidecarSnapshot(
  teamName: string,
  options: CollectSidecarSnapshotOptions = {},
): Promise<SidecarSnapshot | null> {
  const sanitized = safeString(teamName);
  if (!TEAM_NAME_SAFE_PATTERN.test(sanitized)) {
    throw new Error(`Invalid team name: "${teamName}". Team name must match ${TEAM_NAME_SAFE_PATTERN}.`);
  }
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const root = teamRoot(sanitized, cwd, env);
  const warnings: string[] = [];
  const { config, source, warnings: configWarnings } = await readSidecarConfig(root);
  if (!config) return null;
  warnings.push(...configWarnings);
  if (!source) warnings.push('team config source missing');

  const [tasks, events, phase, monitorSnapshot] = await Promise.all([
    readTasks(root),
    readEvents(root, options.eventLimit ?? DEFAULT_EVENT_LIMIT),
    readPhase(root),
    readMonitorSnapshot(root),
  ]);
  const workers = await buildWorkers(config, tasks, root, monitorSnapshot);
  const panes = buildPanes(config);
  const highlights = buildHighlights(workers, tasks);
  const topology = buildTopology(workers, tasks);
  return {
    schema_version: 'omx.sidecar/v1',
    generated_at: (options.now ?? new Date()).toISOString(),
    team_name: config.name,
    team_task: config.task,
    phase,
    topology,
    workers,
    tasks,
    events,
    panes,
    highlights,
    source_warnings: warnings,
  };
}
