import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { performance } from 'perf_hooks';

export interface TeamSummary {
  teamName: string;
  workerCount: number;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  workers: Array<{ name: string; alive: boolean; lastTurnAt: string | null; turnsWithoutProgress: number }>;
  nonReportingWorkers: string[];
  performance?: TeamSummaryPerformance;
}

export interface TeamSummaryPerformance {
  total_ms: number;
  tasks_loaded_ms: number;
  workers_polled_ms: number;
  task_count: number;
  worker_count: number;
}

interface TeamSummarySnapshot {
  workerTurnCountByName: Record<string, number>;
  workerTaskByName: Record<string, string>;
}

export interface TeamWorkerIntegrationState {
  last_seen_head?: string;
  last_integrated_head?: string;
  last_leader_head?: string;
  last_rebased_leader_head?: string;
  status?: 'idle' | 'integrated' | 'integration_failed' | 'cherry_pick_conflict' | 'rebase_conflict';
  conflict_commit?: string;
  conflict_files?: string[];
  updated_at?: string;
}

export interface TeamMonitorSnapshotState {
  taskStatusById: Record<string, string>;
  workerAliveByName: Record<string, boolean>;
  workerStateByName: Record<string, string>;
  workerTurnCountByName: Record<string, number>;
  workerTaskIdByName: Record<string, string>;
  mailboxNotifiedByMessageId: Record<string, string>;
  completedEventTaskIds: Record<string, boolean>;
  integrationByWorker?: Record<string, TeamWorkerIntegrationState>;
  monitorTimings?: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    mailbox_delivery_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

export interface TeamPhaseState {
  current_phase: string;
  max_fix_attempts: number;
  current_fix_attempt: number;
  transitions: Array<{ from: string; to: string; at: string; reason?: string }>;
  updated_at: string;
}

interface MonitorDeps {
  teamName: string;
  cwd: string;
  readTeamConfig: (teamName: string, cwd: string) => Promise<{ name: string; worker_count: number; workers: Array<{ name: string }> } | null>;
  listTasks: (teamName: string, cwd: string) => Promise<Array<{ id: string; status: string }>>;
  readWorkerHeartbeat: (
    teamName: string,
    workerName: string,
    cwd: string,
  ) => Promise<{ alive: boolean; last_turn_at: string; turn_count: number } | null>;
  readWorkerStatus: (
    teamName: string,
    workerName: string,
    cwd: string,
  ) => Promise<{ state: string; current_task_id?: string }>;
  summarySnapshotPath: (teamName: string, cwd: string) => string;
  monitorSnapshotPath: (teamName: string, cwd: string) => string;
  teamPhasePath: (teamName: string, cwd: string) => string;
  writeAtomic: (filePath: string, data: string) => Promise<void>;
}

export async function readSummarySnapshot(teamName: string, cwd: string, summarySnapshotPath: MonitorDeps['summarySnapshotPath']): Promise<TeamSummarySnapshot | null> {
  const p = summarySnapshotPath(teamName, cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TeamSummarySnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskByName: parsed.workerTaskByName ?? {},
    };
  } catch {
    return null;
  }
}

export async function writeSummarySnapshot(
  teamName: string,
  snapshot: TeamSummarySnapshot,
  cwd: string,
  summarySnapshotPath: MonitorDeps['summarySnapshotPath'],
  writeAtomic: MonitorDeps['writeAtomic'],
): Promise<void> {
  await writeAtomic(summarySnapshotPath(teamName, cwd), JSON.stringify(snapshot, null, 2));
}

export async function getTeamSummary(deps: MonitorDeps): Promise<TeamSummary | null> {
  const summaryStartMs = performance.now();
  const cfg = await deps.readTeamConfig(deps.teamName, deps.cwd);
  if (!cfg) return null;

  const tasksStartMs = performance.now();
  const tasks = await deps.listTasks(deps.teamName, deps.cwd);
  const tasksLoadedMs = performance.now() - tasksStartMs;
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const previousSnapshot = await readSummarySnapshot(deps.teamName, deps.cwd, deps.summarySnapshotPath);

  const counts = { total: tasks.length, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === 'pending') counts.pending++;
    else if (t.status === 'blocked') counts.blocked++;
    else if (t.status === 'in_progress') counts.in_progress++;
    else if (t.status === 'completed') counts.completed++;
    else if (t.status === 'failed') counts.failed++;
  }

  const workers = cfg.workers || [];
  const workerSummaries: TeamSummary['workers'] = [];
  const nonReportingWorkers: string[] = [];
  const nextSnapshot: TeamSummarySnapshot = { workerTurnCountByName: {}, workerTaskByName: {} };

  const workerPollStartMs = performance.now();
  const workerSignals = await Promise.all(
    workers.map(async (worker) => {
      const [hb, status] = await Promise.all([
        deps.readWorkerHeartbeat(deps.teamName, worker.name, deps.cwd),
        deps.readWorkerStatus(deps.teamName, worker.name, deps.cwd),
      ]);
      return { worker, hb, status };
    }),
  );
  const workersPolledMs = performance.now() - workerPollStartMs;

  for (const { worker, hb, status } of workerSignals) {
    const alive = hb?.alive ?? false;
    const lastTurnAt = hb?.last_turn_at ?? null;

    const currentTaskId = status.current_task_id ?? '';
    const prevTaskId = previousSnapshot?.workerTaskByName[worker.name] ?? '';
    const prevTurnCount = previousSnapshot?.workerTurnCountByName[worker.name] ?? 0;
    const currentTask = currentTaskId ? taskById.get(currentTaskId) ?? null : null;

    const turnsWithoutProgress =
      hb &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId === prevTaskId
        ? Math.max(0, hb.turn_count - prevTurnCount)
        : 0;

    if (alive && status.state === 'working' && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(worker.name);
    }

    workerSummaries.push({ name: worker.name, alive, lastTurnAt, turnsWithoutProgress });
    nextSnapshot.workerTurnCountByName[worker.name] = hb?.turn_count ?? 0;
    nextSnapshot.workerTaskByName[worker.name] = currentTaskId;
  }

  await writeSummarySnapshot(deps.teamName, nextSnapshot, deps.cwd, deps.summarySnapshotPath, deps.writeAtomic);

  return {
    teamName: cfg.name,
    workerCount: cfg.worker_count,
    tasks: counts,
    workers: workerSummaries,
    nonReportingWorkers,
    performance: {
      total_ms: Number((performance.now() - summaryStartMs).toFixed(2)),
      tasks_loaded_ms: Number(tasksLoadedMs.toFixed(2)),
      workers_polled_ms: Number(workersPolledMs.toFixed(2)),
      task_count: tasks.length,
      worker_count: workers.length,
    },
  };
}

export async function readMonitorSnapshot(
  teamName: string,
  cwd: string,
  monitorSnapshotPath: MonitorDeps['monitorSnapshotPath'],
): Promise<TeamMonitorSnapshotState | null> {
  const p = monitorSnapshotPath(teamName, cwd);
  if (!existsSync(p)) return null;

  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamMonitorSnapshotState>;
    if (!parsed || typeof parsed !== 'object') return null;
    const monitorTimings = (() => {
      const candidate = parsed.monitorTimings as TeamMonitorSnapshotState['monitorTimings'];
      if (!candidate || typeof candidate !== 'object') return undefined;
      if (
        typeof candidate.list_tasks_ms !== 'number' ||
        typeof candidate.worker_scan_ms !== 'number' ||
        typeof candidate.mailbox_delivery_ms !== 'number' ||
        typeof candidate.total_ms !== 'number' ||
        typeof candidate.updated_at !== 'string'
      ) {
        return undefined;
      }
      return candidate;
    })();

    return {
      taskStatusById: parsed.taskStatusById ?? {},
      workerAliveByName: parsed.workerAliveByName ?? {},
      workerStateByName: parsed.workerStateByName ?? {},
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskIdByName: parsed.workerTaskIdByName ?? {},
      mailboxNotifiedByMessageId: parsed.mailboxNotifiedByMessageId ?? {},
      completedEventTaskIds: parsed.completedEventTaskIds ?? {},
      integrationByWorker: parsed.integrationByWorker ?? {},
      monitorTimings,
    };
  } catch {
    return null;
  }
}

export async function writeMonitorSnapshot(
  teamName: string,
  snapshot: TeamMonitorSnapshotState,
  cwd: string,
  monitorSnapshotPath: MonitorDeps['monitorSnapshotPath'],
  writeAtomic: MonitorDeps['writeAtomic'],
): Promise<void> {
  await writeAtomic(monitorSnapshotPath(teamName, cwd), JSON.stringify(snapshot, null, 2));
}

export async function readTeamPhase(teamName: string, cwd: string, teamPhasePath: MonitorDeps['teamPhasePath']): Promise<TeamPhaseState | null> {
  const p = teamPhasePath(teamName, cwd);
  if (!existsSync(p)) return null;

  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamPhaseState>;
    if (!parsed || typeof parsed !== 'object') return null;
    const currentPhase = typeof parsed.current_phase === 'string' ? parsed.current_phase : 'team-exec';
    return {
      current_phase: currentPhase,
      max_fix_attempts: typeof parsed.max_fix_attempts === 'number' ? parsed.max_fix_attempts : 3,
      current_fix_attempt: typeof parsed.current_fix_attempt === 'number' ? parsed.current_fix_attempt : 0,
      transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeTeamPhase(
  teamName: string,
  phaseState: TeamPhaseState,
  cwd: string,
  teamPhasePath: MonitorDeps['teamPhasePath'],
  writeAtomic: MonitorDeps['writeAtomic'],
): Promise<void> {
  await writeAtomic(teamPhasePath(teamName, cwd), JSON.stringify(phaseState, null, 2));
}
