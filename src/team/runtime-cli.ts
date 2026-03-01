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

    // 2. Shutdown team (force cleanup on failure/cancellation to bypass shutdown gate)
    if (runtime) {
      try {
        await shutdownTeam(runtime.teamName, runtime.cwd, { force: status === 'failed' });
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

  // Extract pane IDs from the runtime config
  const workerPaneIds = runtime.config.workers
    .map(w => w.pane_id)
    .filter((id): id is string => !!id);
  const leaderPaneId = runtime.config.leader_pane_id ?? '';

  // Persist pane IDs so MCP server can clean up explicitly via omx_run_team_cleanup.
  const jobId = process.env.OMX_JOB_ID;
  try {
    await writePanesFile(jobId, workerPaneIds, leaderPaneId);
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
    try {
      const currentPaneIds = runtime.config.workers
        .map(w => w.pane_id)
        .filter((id): id is string => !!id);
      await writePanesFile(jobId, currentPaneIds, leaderPaneId);
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

    // Check failure heuristics (use refreshed pane set, not stale startup snapshot)
    const currentWorkerPaneIds = runtime.config.workers
      .map(w => w.pane_id)
      .filter((id): id is string => !!id);
    const allWorkersDead = currentWorkerPaneIds.length > 0 && snap.deadWorkers.length >= currentWorkerPaneIds.length;
    const hasOutstandingWork = (snap.tasks.pending + snap.tasks.in_progress) > 0;

    const deadWorkerFailure = allWorkersDead && hasOutstandingWork;
    const fixingWithNoWorkers = snap.phase === 'team-fix' && allWorkersDead;

    if (deadWorkerFailure || fixingWithNoWorkers) {
      process.stderr.write(`[runtime-cli] Failure detected: deadWorkerFailure=${deadWorkerFailure} fixingWithNoWorkers=${fixingWithNoWorkers}\n`);
      await doShutdown('failed');
      return;
    }
  }
}

main().catch(err => {
  process.stderr.write(`[runtime-cli] Fatal error: ${err}\n`);
  process.exit(1);
});
