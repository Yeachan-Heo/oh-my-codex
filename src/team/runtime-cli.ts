/**
 * CLI entry point for team runtime.
 * Reads JSON config from --input-json, --input-json-base64, or stdin,
 * runs startTeam/monitorTeam/shutdownTeam, writes structured JSON result
 * to stdout.
 *
 * Spawned by OMX team orchestration entrypoints when a background team run starts.
 */

import { createInterface } from 'readline';
import { readdirSync, readFileSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { startTeam, monitorTeam, shutdownTeam } from './runtime.js';
import type { TeamRuntime, TeamShutdownSummary, StaleTeamSummary } from './runtime.js';
import type { ApprovedTeamExecutionBinding } from './approved-execution.js';
import type { TeamDecompositionMetadata } from './repo-aware-decomposition.js';
import { teamReadConfig as readTeamConfig } from './team-ops.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { resolveCodexHomeForLaunch } from '../cli/codex-home.js';

async function promptStaleCleanup(summary: StaleTeamSummary): Promise<boolean> {
  process.stderr.write(
    `\n[omx] Stale artifacts from previous team "${summary.teamName}":\n` +
    `  Worktrees: ${summary.worktreePaths.join(', ')}\n` +
    `  State dir: ${summary.statePath}\n` +
    (summary.hasDirtyWorktrees
      ? '  ⚠ Some worktrees have uncommitted changes that will be lost.\n'
      : '') +
    '  Clean up and continue? [y/N] ',
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((res) => {
    rl.question('', (answer) => {
      rl.close();
      res(answer.trim().toLowerCase() === 'y');
    });
  });
}

interface CliInput {
  teamName: string;
  task?: string;
  workerCount?: number;
  agentType?: string;
  agentTypes?: string[];
  tasks: Array<{
    subject: string;
    description: string;
    owner?: string;
    blocked_by?: string[];
    depends_on?: string[];
    symbolic_depends_on?: string[];
    role?: string;
    requires_code_change?: boolean;
    filePaths?: string[];
    domains?: string[];
    lane?: string;
    allocation_reason?: string;
    symbolic_id?: string;
  }>;
  cwd: string;
  approvedExecution?: ApprovedTeamExecutionBinding | null;
  pollIntervalMs?: number;
  decompositionMetadata?: TeamDecompositionMetadata;
}

const RUNTIME_CLI_INPUT_JSON_FLAG = '--input-json';
const RUNTIME_CLI_INPUT_JSON_BASE64_FLAG = '--input-json-base64';

type TeamWorkerProvider = 'codex' | 'claude' | 'gemini';

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

export type TerminalPhaseResult = 'complete' | 'failed' | 'cancelled';

export interface TerminalCliResult {
  output: CliOutput;
  exitCode: number;
  notice: string;
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

export async function shutdownWithForceFallback(teamName: string, cwd: string): Promise<TeamShutdownSummary> {
  try {
    return await shutdownTeam(teamName, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('shutdown_gate_blocked') && !message.includes('shutdown_rejected')) {
      throw error;
    }
    return await shutdownTeam(teamName, cwd, { force: true });
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

export function resolveRuntimeCliStateRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveCanonicalTeamStateRoot(cwd, env);
}

export function collectTaskResults(stateRoot: string, teamName: string): TaskResult[] {
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

export function buildCliOutput(
  stateRoot: string,
  teamName: string,
  status: 'completed' | 'failed',
  workerCount: number,
  startTimeMs: number,
): CliOutput {
  const taskResults = collectTaskResults(stateRoot, teamName);
  const duration = (Date.now() - startTimeMs) / 1000;
  return {
    status,
    teamName,
    taskResults,
    duration,
    workerCount,
  };
}

export function buildTerminalCliResult(
  stateRoot: string,
  teamName: string,
  phase: TerminalPhaseResult,
  workerCount: number,
  startTimeMs: number,
): TerminalCliResult {
  const status = phase === 'complete' ? 'completed' : 'failed';
  return {
    output: buildCliOutput(stateRoot, teamName, status, workerCount, startTimeMs),
    exitCode: status === 'completed' ? 0 : 1,
    notice:
      `[runtime-cli] phase=${phase} reached terminal state; preserving team state for inspection. `
      + `Inspect with "omx team status ${teamName} --json" or "omx team api read-stall-state --input '{\"team_name\":\"${teamName}\"}' --json". `
      + `Run "omx team shutdown ${teamName}" (or --force after state capture) when explicit cleanup is desired.\n`,
  };
}

export function normalizeAgentTypes(raw: string[], workerCount: number): TeamWorkerProvider[] {
  const providers = raw.map((entry) => String(entry || '').trim().toLowerCase());
  const invalid = providers.filter((entry) => entry !== 'codex' && entry !== 'claude' && entry !== 'gemini');
  if (invalid.length > 0) {
    throw new Error(`Invalid agentTypes entries: ${invalid.join(', ')}. Expected codex|claude|gemini.`);
  }
  if (providers.length !== 1 && providers.length !== workerCount) {
    throw new Error(`agentTypes length must be 1 or ${workerCount}; received ${providers.length}.`);
  }
  return providers as TeamWorkerProvider[];
}

export function resolveRuntimeCliProviderMap(
  raw: string[] | undefined,
  workerCount: number,
): string | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  return normalizeAgentTypes(raw, workerCount).join(',');
}

export function resolveRuntimeCliAgentType(raw: string | undefined): string {
  const normalized = typeof raw === 'string' ? raw.trim() : '';
  return normalized || 'executor';
}

export function resolveRuntimeCliMissingFields(input: Partial<CliInput>): string[] {
  const missing: string[] = [];
  if (!input.teamName) missing.push('teamName');
  const hasAgentTypes = Array.isArray(input.agentTypes) && input.agentTypes.length > 0;
  const hasWorkerCount = Number.isInteger(input.workerCount) && Number(input.workerCount) > 0;
  if (!hasAgentTypes && !hasWorkerCount) {
    missing.push('workerCount or agentTypes');
  }
  if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) missing.push('tasks');
  if (!input.cwd) missing.push('cwd');
  return missing;
}

export function resolveRuntimeCliTask(input: Pick<CliInput, 'task' | 'tasks'>): string {
  const explicitTask = typeof input.task === 'string' ? input.task.trim() : '';
  if (explicitTask !== '') {
    return explicitTask;
  }
  return input.tasks.map((task) => task.subject).join('; ');
}

export function resolveRuntimeCliInlineInput(argv: readonly string[]): string | null {
  const index = argv.indexOf(RUNTIME_CLI_INPUT_JSON_FLAG);
  if (index !== -1) {
    const payload = argv[index + 1];
    if (typeof payload !== 'string' || payload.trim() === '') {
      throw new Error(`Missing JSON payload for ${RUNTIME_CLI_INPUT_JSON_FLAG}`);
    }
    return payload;
  }

  const base64Index = argv.indexOf(RUNTIME_CLI_INPUT_JSON_BASE64_FLAG);
  if (base64Index === -1) {
    return null;
  }
  const payload = argv[base64Index + 1];
  if (typeof payload !== 'string' || payload.trim() === '') {
    throw new Error(`Missing JSON payload for ${RUNTIME_CLI_INPUT_JSON_BASE64_FLAG}`);
  }
  return Buffer.from(payload.trim(), 'base64url').toString('utf-8');
}

async function readRuntimeCliRawInput(argv: readonly string[]): Promise<string> {
  const inlineInput = resolveRuntimeCliInlineInput(argv);
  if (inlineInput != null) {
    return inlineInput.trim();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

async function main(): Promise<void> {
  const startTime = Date.now();

  const rawInput = await readRuntimeCliRawInput(process.argv.slice(2));

  let input: CliInput;
  try {
    input = JSON.parse(rawInput) as CliInput;
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to parse JSON input: ${err}\n`);
    process.exit(1);
  }

  // Validate required fields
  const missing = resolveRuntimeCliMissingFields(input);
  if (missing.length > 0) {
    process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(', ')}\n`);
    process.exit(1);
  }

  const {
    teamName,
    agentType: rawAgentType,
    agentTypes,
    tasks,
    cwd,
    pollIntervalMs = 5000,
    decompositionMetadata,
  } = input;

  const workerCount = input.workerCount ?? agentTypes?.length ?? 0;
  const stateRoot = resolveRuntimeCliStateRoot(cwd);

  let runtime: TeamRuntime | null = null;
  let finalStatus: 'completed' | 'failed' = 'failed';
  let pollActive = true;

  async function doShutdown(status: 'completed' | 'failed'): Promise<void> {
    pollActive = false;
    finalStatus = status;

    // 1. Shutdown team
    let shutdownSummary: TeamShutdownSummary | null = null;
    if (runtime) {
      try {
        if (status === 'failed') {
          // Failure/cancellation path must force cleanup to bypass shutdown gate.
          shutdownSummary = await shutdownTeam(runtime.teamName, runtime.cwd, { force: true });
        } else {
          shutdownSummary = await shutdownWithForceFallback(runtime.teamName, runtime.cwd);
        }
      } catch (err) {
        process.stderr.write(`[runtime-cli] shutdownTeam error: ${err}\n`);
      }
    }

    if (shutdownSummary?.commitHygieneArtifacts) {
      process.stderr.write(`[runtime-cli] commit_hygiene_context_json=${shutdownSummary.commitHygieneArtifacts.jsonPath}\n`);
      process.stderr.write(`[runtime-cli] commit_hygiene_context_md=${shutdownSummary.commitHygieneArtifacts.markdownPath}\n`);
    }

    const output = buildCliOutput(stateRoot, teamName, finalStatus, workerCount, startTime);

    // 2. Write result to stdout
    process.stdout.write(JSON.stringify(output) + '\n');

    // 3. Exit
    process.exit(status === 'completed' ? 0 : 1);
  }

  function exitWithoutShutdown(phase: TerminalPhaseResult): void {
    pollActive = false;
    finalStatus = phase === 'complete' ? 'completed' : 'failed';
    const result = buildTerminalCliResult(stateRoot, teamName, phase, workerCount, startTime);
    process.stderr.write(result.notice);
    process.stdout.write(JSON.stringify(result.output) + '\n');
    process.exit(result.exitCode);
  }

  // Register signal handlers before poll loop
  let shutdownInProgress = false;
  const handleShutdown = (signal: string): void => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    process.stderr.write(`[runtime-cli] Received ${signal}, shutting down...\n`);
    doShutdown('failed')
      .catch((err) => {
        process.stderr.write(`[runtime-cli] Shutdown error: ${err}\n`);
      })
      .finally(() => process.exit(1));
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Start the team — OMX's startTeam takes individual parameters
  const agentType = resolveRuntimeCliAgentType(rawAgentType);
  const task = resolveRuntimeCliTask(input);
  try {
    const providerMap = resolveRuntimeCliProviderMap(agentTypes, workerCount);
    const previousCliMap = process.env.OMX_TEAM_WORKER_CLI_MAP;
    try {
      if (providerMap) {
        process.env.OMX_TEAM_WORKER_CLI_MAP = providerMap;
      }
      runtime = await startTeam(
        teamName,
        task,
        agentType,
        workerCount,
        tasks,
        cwd,
        {
          codexHomeOverride: resolveCodexHomeForLaunch(cwd, process.env),
          confirmStaleCleanup: promptStaleCleanup,
          ...(Object.prototype.hasOwnProperty.call(input, 'approvedExecution')
            ? { approvedExecution: input.approvedExecution ?? null }
            : {}),
          ...(decompositionMetadata ? { decompositionMetadata } : {}),
        },
      );
    } finally {
      if (providerMap) {
        if (typeof previousCliMap === 'string') process.env.OMX_TEAM_WORKER_CLI_MAP = previousCliMap;
        else delete process.env.OMX_TEAM_WORKER_CLI_MAP;
      }
    }
  } catch (err) {
    process.stderr.write(`[runtime-cli] startTeam failed: ${err}\n`);
    process.exit(1);
  }

  // Persist pane IDs when a background launcher provides an OMX job ID.
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
      exitWithoutShutdown('complete');
      return;
    }
    if (snap.phase === 'failed' || snap.phase === 'cancelled') {
      exitWithoutShutdown(snap.phase);
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
      // Monitor-detected failure is still not an explicit shutdown request.
      // Preserve team state for inspection and let the leader decide when to clean up.
      exitWithoutShutdown('failed');
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
