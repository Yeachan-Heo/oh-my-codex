/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Spawned by omx_run_team_start in state-server.ts.
 */

import { readdirSync, readFileSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { startTeam, monitorTeam, shutdownTeam } from './runtime.js';
import type { TeamRuntime } from './runtime.js';
import { teamReadConfig as readTeamConfig } from './team-ops.js';

interface CliInput {
  teamName: string;
  workerCount?: number;
  agentTypes: string[];
  tasks: Array<{ subject: string; description: string }>;
  cwd: string;
  pollIntervalMs?: number;
}

interface TaskResult {
  taskId: string;
  status: string;
  summary: string;
}

interface CliOutput {
  status: 'completed' | 'failed';
  teamName: string;
  taskResults: TaskResult[];
  duration: number;
  workerCount: number;
}

export interface LivePaneState {
  paneIds: string[];
  leaderPaneId: string;
}

async function writePanesFile(
  jobId: string | undefined,
  paneIds: string[],
  leaderPaneId: string,
): Promise<void> {
  const omxJobsDir = process.env.OMX_JOBS_DIR;
  if (!jobId || !omxJobsDir) return;

  const panesPath = join(omxJobsDir, `${jobId}-panes.json`);
  await writeFile(
    panesPath + '.tmp',
    JSON.stringify({ paneIds: [...paneIds], leaderPaneId }),
  );
  await rename(panesPath + '.tmp', panesPath);
}

export async function loadLivePaneState(teamName: string, cwd: string): Promise<LivePaneState | null> {
  const config = await readTeamConfig(teamName, cwd);
  if (!config) return null;
  return {
    paneIds: config.workers
      .map((worker) => worker.pane_id)
      .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().length > 0),
    leaderPaneId: config.leader_pane_id ?? '',
  };
}

export async function shutdownWithForceFallback(teamName: string, cwd: string): Promise<void> {
  try {
    await shutdownTeam(teamName, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('shutdown_gate_blocked') && !message.includes('shutdown_rejected')) {
      throw error;
    }
    await shutdownTeam(teamName, cwd, { force: true });
  }
}

export function detectDeadWorkerFailure(
  deadWorkerCount: number,
  liveWorkerPaneCount: number,
  hasOutstandingWork: boolean,
  phase: string,
): { deadWorkerFailure: boolean; fixingWithNoWorkers: boolean } {
  const allWorkersDead = liveWorkerPaneCount > 0 && deadWorkerCount >= liveWorkerPaneCount;
  return {
    deadWorkerFailure: allWorkersDead && hasOutstandingWork,
    fixingWithNoWorkers: phase === 'team-fix' && allWorkersDead,
  };
}

function collectTaskResults(stateRoot: string, teamName: string): TaskResult[] {
  const tasksDir = join(stateRoot, 'team', teamName, 'tasks');
  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const raw = readFileSync(join(tasksDir, f), 'utf-8');
        const task = JSON.parse(raw) as { id?: string; status?: string; result?: string; summary?: string };
        return {
          taskId: task.id ?? f.replace('.json', ''),
          status: task.status ?? 'unknown',
          summary: (task.result ?? task.summary) ?? '',
        };
      } catch {
        return { taskId: f.replace('.json', ''), status: 'unknown', summary: '' };
      }
    });
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const startTime = Date.now();

  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const rawInput = Buffer.concat(chunks).toString('utf-8').trim();

  let input: CliInput;
  try {
    input = JSON.parse(rawInput) as CliInput;
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to parse stdin JSON: ${err}\n`);
    process.exit(1);
  }

  // Validate required fields
  const missing: string[] = [];
  if (!input.teamName) missing.push('teamName');
  if (!input.agentTypes || !Array.isArray(input.agentTypes) || input.agentTypes.length === 0) missing.push('agentTypes');
  if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) missing.push('tasks');
  if (!input.cwd) missing.push('cwd');
  if (missing.length > 0) {
    process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(', ')}\n`);
    process.exit(1);
  }

  const {
    teamName,
    agentTypes,
    tasks,
    cwd,
    pollIntervalMs = 5000,
  } = input;

  const workerCount = input.workerCount ?? agentTypes.length;
  const stateRoot = join(cwd, '.omx', 'state');

  let runtime: TeamRuntime | null = null;
  let finalStatus: 'completed' | 'failed' = 'failed';
  let pollActive = true;

  function exitCodeFor(status: 'completed' | 'failed'): number {
    return status === 'completed' ? 0 : 1;
  }

  async function doShutdown(status: 'completed' | 'failed'): Promise<void> {
    pollActive = false;
    finalStatus = status;

    // 1. Collect task results
    const taskResults = collectTaskResults(stateRoot, teamName);

    // 2. Shutdown team
    if (runtime) {
      try {
        await shutdownWithForceFallback(runtime.teamName, runtime.cwd);
      } catch (err) {
        process.stderr.write(`[runtime-cli] shutdownTeam error: ${err}\n`);
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const output: CliOutput = {
      status: finalStatus,
      teamName,
      taskResults,
      duration,
      workerCount,
    };

    // 3. Write result to stdout
    process.stdout.write(JSON.stringify(output) + '\n');

    // 4. Exit
    process.exit(exitCodeFor(status));
  }

  // Register signal handlers before poll loop
  process.on('SIGINT', () => {
    process.stderr.write('[runtime-cli] Received SIGINT, shutting down...\n');
    doShutdown('failed').catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    process.stderr.write('[runtime-cli] Received SIGTERM, shutting down...\n');
    doShutdown('failed').catch(() => process.exit(1));
  });

  // Start the team — OMX's startTeam takes individual parameters
  const agentType = agentTypes[0] ?? 'codex';
  try {
    runtime = await startTeam(
      teamName,
      tasks.map(t => t.subject).join('; '),
      agentType,
      workerCount,
      tasks,
      cwd,
    );
  } catch (err) {
    process.stderr.write(`[runtime-cli] startTeam failed: ${err}\n`);
    process.exit(1);
  }

  // Persist pane IDs so MCP server can clean up explicitly via omx_run_team_cleanup.
  const jobId = process.env.OMX_JOB_ID;
  try {
    const livePanes = await loadLivePaneState(teamName, cwd);
    if (livePanes) {
      await writePanesFile(jobId, livePanes.paneIds, livePanes.leaderPaneId);
    } else {
      const fallbackPaneIds = runtime.config.workers
        .map((worker) => worker.pane_id)
        .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().length > 0);
      await writePanesFile(jobId, fallbackPaneIds, runtime.config.leader_pane_id ?? '');
    }
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}\n`);
  }

  // Poll loop
  while (pollActive) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    if (!pollActive) break;

    let snap;
    try {
      snap = await monitorTeam(teamName, cwd);
    } catch (err) {
      process.stderr.write(`[runtime-cli] monitorTeam error: ${err}\n`);
      continue;
    }

    if (!snap) {
      process.stderr.write(`[runtime-cli] monitorTeam returned null\n`);
      continue;
    }

    // Refresh pane IDs (workers may have scaled)
    let livePaneState: LivePaneState | null = null;
    try {
      livePaneState = await loadLivePaneState(teamName, cwd);
      if (livePaneState) {
        await writePanesFile(jobId, livePaneState.paneIds, livePaneState.leaderPaneId);
      }
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}\n`);
    }

    const perfMs = snap.performance?.total_ms ?? 0;
    process.stderr.write(
      `[runtime-cli] phase=${snap.phase} pending=${snap.tasks.pending} inProgress=${snap.tasks.in_progress} completed=${snap.tasks.completed} failed=${snap.tasks.failed} dead=${snap.deadWorkers.length} monitorMs=${perfMs.toFixed(0)}\n`,
    );

    // Check completion
    if (snap.phase === 'complete') {
      await doShutdown('completed');
      return;
    }
    if (snap.phase === 'failed' || snap.phase === 'cancelled') {
      await doShutdown('failed');
      return;
    }

    // Check failure heuristics
    const hasOutstandingWork = (snap.tasks.pending + snap.tasks.in_progress) > 0;
    const liveWorkerPaneCount = livePaneState?.paneIds.length ?? 0;
    const { deadWorkerFailure, fixingWithNoWorkers } = detectDeadWorkerFailure(
      snap.deadWorkers.length,
      liveWorkerPaneCount,
      hasOutstandingWork,
      snap.phase,
    );

    if (deadWorkerFailure || fixingWithNoWorkers) {
      process.stderr.write(`[runtime-cli] Failure detected: deadWorkerFailure=${deadWorkerFailure} fixingWithNoWorkers=${fixingWithNoWorkers}\n`);
      await doShutdown('failed');
      return;
    }
  }
}

const shouldAutoStart = process.env.OMX_RUNTIME_CLI_DISABLE_AUTO_START !== '1';

if (shouldAutoStart) {
  main().catch(err => {
    process.stderr.write(`[runtime-cli] Fatal error: ${err}\n`);
    process.exit(1);
  });
}
