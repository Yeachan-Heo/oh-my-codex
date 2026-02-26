import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Writable } from 'stream';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  createTeamSession,
  buildWorkerProcessLaunchSpec,
  resolveTeamWorkerCli,
  resolveTeamWorkerCliPlan,
  resolveTeamWorkerLaunchMode,
  waitForWorkerReady,
  sendToWorker,
  sendToWorkerStdin,
  notifyLeaderStatus,
  isWorkerAlive,
  getWorkerPanePid,
  killWorker,
  killWorkerByPaneId,
  unregisterResizeHook,
  destroyTeamSession,
  listTeamSessions,
} from './tmux-session.js';
import {
  teamInit as initTeamState,
  DEFAULT_MAX_WORKERS,
  teamReadConfig as readTeamConfig,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamReadWorkerHeartbeat as readWorkerHeartbeat,
  teamReadWorkerStatus as readWorkerStatus,
  teamWriteWorkerInbox as writeWorkerInbox,
  teamCreateTask as createStateTask,
  teamReadTask as readTask,
  teamListTasks as listTasks,
  teamReadManifest as readTeamManifestV2,
  teamNormalizePolicy as normalizeTeamPolicy,
  teamClaimTask as claimTask,
  teamReleaseTaskClaim as releaseTaskClaim,
  teamAppendEvent as appendTeamEvent,
  teamReadTaskApproval as readTaskApproval,
  teamListMailbox as listMailboxMessages,
  teamMarkMessageNotified as markMessageNotified,
  teamEnqueueDispatchRequest as enqueueDispatchRequest,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  teamReadDispatchRequest as readDispatchRequest,
  teamCleanup as cleanupTeamState,
  teamSaveConfig as saveTeamConfig,
  teamWriteShutdownRequest as writeShutdownRequest,
  teamReadShutdownAck as readShutdownAck,
  teamReadMonitorSnapshot as readMonitorSnapshot,
  teamWriteMonitorSnapshot as writeMonitorSnapshot,
  teamReadPhase as readTeamPhaseState,
  teamWritePhase as writeTeamPhaseState,
  type TeamConfig,
  type WorkerInfo,
  type WorkerHeartbeat,
  type WorkerStatus,
  type TeamTask,
  type TeamMonitorSnapshotState,
  type TeamPhaseState,
  type TeamPolicy,
} from './team-ops.js';
import {
  queueInboxInstruction,
  queueDirectMailboxMessage,
  queueBroadcastMailboxMessage,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateWorkerOverlay,
  writeTeamWorkerInstructionsFile,
  removeTeamWorkerInstructionsFile,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  generateMailboxTriggerMessage,
} from './worker-bootstrap.js';
import { type TeamPhase, type TerminalPhase } from './orchestrator.js';
import {
  isLowComplexityAgentType,
  resolveTeamWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  resolveTeamLowComplexityDefaultModel,
  parseTeamWorkerLaunchArgs,
  splitWorkerLaunchArgs,
} from './model-contract.js';
import { inferPhaseTargetFromTaskCounts, reconcilePhaseStateForMonitor } from './phase-controller.js';
import { getTeamTmuxSessions } from '../notifications/tmux.js';
import { hasStructuredVerificationEvidence } from '../verification/verifier.js';
import {
  ensureWorktree,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
  type EnsureWorktreeResult,
  type WorktreeMode,
} from './worktree.js';

/** Snapshot of the team state at a point in time */
export interface TeamSnapshot {
  teamName: string;
  phase: TeamPhase | TerminalPhase;
  workers: Array<{
    name: string;
    alive: boolean;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    turnsWithoutProgress: number;
  }>;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
    items: TeamTask[];
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  nonReportingWorkers: string[];
  recommendations: string[];
  performance?: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    mailbox_delivery_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

/** Runtime handle returned by startTeam */
export interface TeamRuntime {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
}

interface ShutdownOptions {
  force?: boolean;
}

export interface TeamStartOptions {
  worktreeMode?: WorktreeMode;
}

interface ShutdownGateCounts {
  total: number;
  pending: number;
  blocked: number;
  in_progress: number;
  completed: number;
  failed: number;
  allowed: boolean;
}

const MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const TEAM_STATE_ROOT_ENV = 'OMX_TEAM_STATE_ROOT';
const TEAM_LEADER_CWD_ENV = 'OMX_TEAM_LEADER_CWD';

interface PromptWorkerHandle {
  child: ChildProcessByStdio<Writable, null, null>;
  pid: number;
}

const promptWorkerRegistry = new Map<string, Map<string, PromptWorkerHandle>>();
const previousModelInstructionsFileByTeam = new Map<string, string | undefined>();
const PROMPT_WORKER_SIGTERM_WAIT_MS = 3_000;
const PROMPT_WORKER_SIGKILL_WAIT_MS = 2_000;
const PROMPT_WORKER_EXIT_POLL_MS = 100;

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function shouldSkipWorkerReadyWait(env: NodeJS.ProcessEnv): boolean {
  return env.OMX_TEAM_SKIP_READY_WAIT === '1';
}

function setTeamModelInstructionsFile(teamName: string, filePath: string): void {
  if (!previousModelInstructionsFileByTeam.has(teamName)) {
    previousModelInstructionsFileByTeam.set(teamName, process.env[MODEL_INSTRUCTIONS_FILE_ENV]);
  }
  process.env[MODEL_INSTRUCTIONS_FILE_ENV] = filePath;
}

function restoreTeamModelInstructionsFile(teamName: string): void {
  if (!previousModelInstructionsFileByTeam.has(teamName)) return;

  const previous = previousModelInstructionsFileByTeam.get(teamName);
  previousModelInstructionsFileByTeam.delete(teamName);

  if (typeof previous === 'string') {
    process.env[MODEL_INSTRUCTIONS_FILE_ENV] = previous;
    return;
  }
  delete process.env[MODEL_INSTRUCTIONS_FILE_ENV];
}

function registerPromptWorkerHandle(
  teamName: string,
  workerName: string,
  child: ChildProcessByStdio<Writable, null, null>,
): void {
  const { pid } = child;
  if (!Number.isFinite(pid) || (pid ?? 0) < 1) {
    throw new Error(`failed to spawn prompt worker process for ${workerName}`);
  }
  const processPid = pid as number;
  const existingTeamHandles = promptWorkerRegistry.get(teamName) ?? new Map<string, PromptWorkerHandle>();
  existingTeamHandles.set(workerName, { child, pid: processPid });
  promptWorkerRegistry.set(teamName, existingTeamHandles);

  child.on('exit', () => {
    const teamHandles = promptWorkerRegistry.get(teamName);
    if (!teamHandles) return;
    teamHandles.delete(workerName);
    if (teamHandles.size === 0) promptWorkerRegistry.delete(teamName);
  });
}

function getPromptWorkerHandle(teamName: string, workerName: string): PromptWorkerHandle | null {
  return promptWorkerRegistry.get(teamName)?.get(workerName) ?? null;
}

function removePromptWorkerHandle(teamName: string, workerName: string): void {
  const teamHandles = promptWorkerRegistry.get(teamName);
  if (!teamHandles) return;
  teamHandles.delete(workerName);
  if (teamHandles.size === 0) promptWorkerRegistry.delete(teamName);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROMPT_WORKER_EXIT_POLL_MS));
    if (!isPidAlive(pid)) return true;
  }
  return !isPidAlive(pid);
}

interface PromptWorkerTeardownResult {
  terminated: boolean;
  forcedKill: boolean;
  pid: number | null;
  error?: string;
}

async function teardownPromptWorker(
  teamName: string,
  workerName: string,
  fallbackPid: number | undefined,
  cwd: string,
  context: 'startup_rollback' | 'shutdown',
): Promise<PromptWorkerTeardownResult> {
  const handle = getPromptWorkerHandle(teamName, workerName);
  const pid = Number.isFinite(handle?.pid)
    ? (handle!.pid as number)
    : (Number.isFinite(fallbackPid) && (fallbackPid ?? 0) > 0 ? (fallbackPid as number) : null);

  if (pid === null) {
    removePromptWorkerHandle(teamName, workerName);
    return { terminated: true, forcedKill: false, pid: null };
  }

  try {
    if (handle && handle.child.exitCode === null && !handle.child.killed) {
      handle.child.kill('SIGTERM');
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Best effort.
  }

  const exitedOnTerm = await waitForPidExit(pid, PROMPT_WORKER_SIGTERM_WAIT_MS);
  if (exitedOnTerm) {
    removePromptWorkerHandle(teamName, workerName);
    return { terminated: true, forcedKill: false, pid };
  }

  await appendTeamEvent(
    teamName,
    {
      type: 'worker_stopped',
      worker: workerName,
      reason: `prompt_force_kill:${context}:pid=${pid}`,
    },
    cwd,
  ).catch(() => {});

  try {
    if (handle && handle.child.exitCode === null) {
      handle.child.kill('SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Best effort.
  }

  const exitedOnKill = await waitForPidExit(pid, PROMPT_WORKER_SIGKILL_WAIT_MS);
  if (!exitedOnKill) {
    await appendTeamEvent(
      teamName,
      {
        type: 'worker_stopped',
        worker: workerName,
        reason: `prompt_teardown_failed:${context}:pid=${pid}`,
      },
      cwd,
    ).catch(() => {});
    return {
      terminated: false,
      forcedKill: true,
      pid,
      error: 'still_alive_after_sigkill',
    };
  }

  removePromptWorkerHandle(teamName, workerName);
  return { terminated: true, forcedKill: true, pid };
}

function isPromptWorkerAlive(config: TeamConfig, worker: WorkerInfo): boolean {
  const handle = getPromptWorkerHandle(config.name, worker.name);
  if (handle?.child.exitCode === null && !handle.child.killed) return true;
  if (!Number.isFinite(worker.pid) || (worker.pid ?? 0) <= 0) return false;
  try {
    process.kill(worker.pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

export { TEAM_LOW_COMPLEXITY_DEFAULT_MODEL };

export function resolveCanonicalTeamStateRoot(leaderCwd: string): string {
  return resolve(join(leaderCwd, '.omx', 'state'));
}

function spawnPromptWorker(
  teamName: string,
  workerName: string,
  workerIndex: number,
  workerCwd: string,
  launchArgs: string[],
  workerEnv: Record<string, string>,
  workerCli: 'codex' | 'claude',
): ChildProcessByStdio<Writable, null, null> {
  const processSpec = buildWorkerProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    workerCwd,
    workerEnv,
    workerCli,
  );
  const child = spawn(
    processSpec.command,
    processSpec.args,
    {
      cwd: workerCwd,
      env: { ...process.env, ...processSpec.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  registerPromptWorkerHandle(teamName, workerName, child);
  return child;
}

export function resolveWorkerLaunchArgsFromEnv(
  env: NodeJS.ProcessEnv,
  agentType: string,
  inheritedLeaderModel?: string,
): string[] {
  const inheritedArgs = (typeof inheritedLeaderModel === 'string' && inheritedLeaderModel.trim() !== '')
    ? ['--model', inheritedLeaderModel.trim()]
    : [];
  const fallbackModel = isLowComplexityAgentType(agentType)
    ? resolveTeamLowComplexityDefaultModel(env.CODEX_HOME)
    : undefined;

  // Detect if an explicit reasoning override exists before resolving (for log source labelling)
  const preEnvArgs = splitWorkerLaunchArgs(env.OMX_TEAM_WORKER_LAUNCH_ARGS);
  const preAllArgs = [...preEnvArgs, ...inheritedArgs];
  const hasExplicitReasoning = parseTeamWorkerLaunchArgs(preAllArgs).reasoningOverride !== null;

  const resolved = resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
  });

  // Extract resolved model and thinking level from result args for startup log
  const resolvedParsed = parseTeamWorkerLaunchArgs(resolved);
  const resolvedModel = resolvedParsed.modelOverride ?? fallbackModel ?? 'default';
  const reasoningMatch = resolvedParsed.reasoningOverride?.match(/model_reasoning_effort\s*=\s*"?(\w+)"?/);
  const thinkingLevel = reasoningMatch?.[1] ?? 'none';
  const source = hasExplicitReasoning ? 'explicit' : 'none/default-none';
  const effectiveWorkerCli = resolveEffectiveWorkerCliForStartupLog(resolved, env);
  if (effectiveWorkerCli === 'claude') {
    console.log('[omx:team] worker startup resolution: model=claude source=local-settings');
  } else {
    console.log(`[omx:team] worker startup resolution: model=${resolvedModel} thinking_level=${thinkingLevel} source=${source}`);
  }

  return resolved;
}

function resolveEffectiveWorkerCliForStartupLog(
  resolvedLaunchArgs: string[],
  env: NodeJS.ProcessEnv,
): 'codex' | 'claude' {
  const rawCliMap = String(env.OMX_TEAM_WORKER_CLI_MAP ?? '').trim();
  if (rawCliMap !== '') {
    const entries = rawCliMap
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      const autoCli = resolveTeamWorkerCli(resolvedLaunchArgs, {
        ...env,
        OMX_TEAM_WORKER_CLI: 'auto',
      });
      const resolvedMap = entries.map((entry): 'codex' | 'claude' | null => {
        if (entry === 'auto') return autoCli;
        if (entry === 'codex' || entry === 'claude') return entry;
        return null;
      });
      if (resolvedMap.every((entry) => entry === 'claude')) return 'claude';
      if (resolvedMap.some((entry) => entry === 'codex')) return 'codex';
    }
  }

  return resolveTeamWorkerCli(resolvedLaunchArgs, env);
}

/**
 * Start a new team: init state, create tmux session, bootstrap workers.
 */
export async function startTeam(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[] }>,
  cwd: string,
  options: TeamStartOptions = {},
): Promise<TeamRuntime> {
  if (process.env.OMX_TEAM_WORKER) {
    throw new Error('nested_team_disallowed');
  }

  const workerLaunchMode = resolveTeamWorkerLaunchMode(process.env);
  const displayMode = workerLaunchMode === 'interactive' ? 'split_pane' : 'auto';
  if (workerLaunchMode === 'interactive') {
    if (!isTmuxAvailable()) {
      throw new Error('Team mode requires tmux. Install with: apt install tmux / brew install tmux');
    }
    if (!process.env.TMUX) {
      throw new Error('Team mode requires running inside tmux current leader pane');
    }
  }

  const leaderCwd = resolve(cwd);
  const sanitized = sanitizeTeamName(teamName);
  const teamStateRoot = resolveCanonicalTeamStateRoot(leaderCwd);
  const activeWorktreeMode: 'detached' | 'named' | null =
    options.worktreeMode?.enabled
      ? (options.worktreeMode.detached ? 'detached' : 'named')
      : null;
  const workspaceMode: 'single' | 'worktree' = activeWorktreeMode ? 'worktree' : 'single';
  const workerWorkspaceByName = new Map<string, {
    cwd: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeDetached?: boolean;
  }>();
  const provisionedWorktrees: Array<EnsureWorktreeResult | { enabled: false }> = [];
  for (let i = 1; i <= workerCount; i++) {
    workerWorkspaceByName.set(`worker-${i}`, { cwd: leaderCwd });
  }

  if (activeWorktreeMode) {
    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const planned = planWorktreeTarget({
        cwd: leaderCwd,
        scope: 'team',
        mode: options.worktreeMode!,
        teamName: sanitized,
        workerName,
      });
      const ensured = ensureWorktree(planned);
      provisionedWorktrees.push(ensured);
      if (ensured.enabled) {
        workerWorkspaceByName.set(workerName, {
          cwd: ensured.worktreePath,
          worktreePath: ensured.worktreePath,
          worktreeBranch: ensured.branchName ?? undefined,
          worktreeDetached: ensured.detached,
        });
      }
    }
  }

  const leaderSessionId = await resolveLeaderSessionId(leaderCwd);

  // Topology guard: one active team per leader session/process context.
  const activeTeams = await findActiveTeams(leaderCwd, leaderSessionId);
  if (activeTeams.length > 0) {
    throw new Error(`leader_session_conflict: active team exists (${activeTeams.join(', ')})`);
  }

  // 2. Team name is already sanitized above.
  let sessionName = `omx-team-${sanitized}`;
  const overlay = generateWorkerOverlay(sanitized);
  let workerInstructionsPath: string | null = null;
  let sessionCreated = false;
  const createdWorkerPaneIds: string[] = [];
  let createdLeaderPaneId: string | undefined;
  let config: TeamConfig | null = null;
  const workerLaunchArgs = resolveWorkerLaunchArgsFromEnv(process.env, agentType);
  const workerCliPlan = resolveTeamWorkerCliPlan(workerCount, workerLaunchArgs, process.env);
  const workerReadyTimeoutMs = resolveWorkerReadyTimeoutMs(process.env);
  const skipWorkerReadyWait = shouldSkipWorkerReadyWait(process.env);

  try {
    // 3. Init state directory + config
    config = await initTeamState(
      sanitized,
      task,
      agentType,
      workerCount,
      leaderCwd,
      DEFAULT_MAX_WORKERS,
      { ...process.env, OMX_TEAM_DISPLAY_MODE: displayMode, OMX_TEAM_WORKER_LAUNCH_MODE: workerLaunchMode },
      {
        leader_cwd: leaderCwd,
        team_state_root: teamStateRoot,
        workspace_mode: workspaceMode,
      },
    );
    if (!config) {
      throw new Error('failed to initialize team config');
    }
    config.leader_cwd = leaderCwd;
    config.team_state_root = teamStateRoot;
    config.workspace_mode = workspaceMode;

    // 4. Create tasks
    for (const t of tasks) {
      await createStateTask(sanitized, {
        subject: t.subject,
        description: t.description,
        status: 'pending',
        owner: t.owner,
        blocked_by: t.blocked_by,
      }, leaderCwd);
    }

    // 5. Write team-scoped worker instructions file (no mutation of project AGENTS.md)
    workerInstructionsPath = await writeTeamWorkerInstructionsFile(sanitized, leaderCwd, overlay);
    setTeamModelInstructionsFile(sanitized, workerInstructionsPath);

    const workerStartups = Array.from({ length: workerCount }, (_, index) => {
      const workerName = `worker-${index + 1}`;
      const workerWorkspace = workerWorkspaceByName.get(workerName) ?? { cwd: leaderCwd };
      const env: Record<string, string> = {
        [TEAM_STATE_ROOT_ENV]: teamStateRoot,
        [TEAM_LEADER_CWD_ENV]: leaderCwd,
      };
      if (workerWorkspace.worktreePath) {
        env.OMX_TEAM_WORKTREE_PATH = workerWorkspace.worktreePath;
      }
      if (workerWorkspace.worktreeBranch) {
        env.OMX_TEAM_WORKTREE_BRANCH = workerWorkspace.worktreeBranch;
      }
      if (typeof workerWorkspace.worktreeDetached === 'boolean') {
        env.OMX_TEAM_WORKTREE_DETACHED = workerWorkspace.worktreeDetached ? '1' : '0';
      }
      return {
        cwd: workerWorkspace.cwd,
        env,
      };
    });

    const workerPaneIds = Array.from({ length: workerCount }, () => undefined as string | undefined);

    // 6. Create worker runtime (interactive tmux panes or prompt-mode child processes)
    if (workerLaunchMode === 'interactive') {
      const createdSession = createTeamSession(sanitized, workerCount, leaderCwd, workerLaunchArgs, workerStartups);
      sessionName = createdSession.name;
      sessionCreated = true;
      createdWorkerPaneIds.push(...createdSession.workerPaneIds);
      createdLeaderPaneId = createdSession.leaderPaneId;
      config.tmux_session = sessionName;
      config.leader_pane_id = createdSession.leaderPaneId;
      config.hud_pane_id = createdSession.hudPaneId;
      config.resize_hook_name = createdSession.resizeHookName;
      config.resize_hook_target = createdSession.resizeHookTarget;
      for (let i = 0; i < createdSession.workerPaneIds.length; i++) {
        workerPaneIds[i] = createdSession.workerPaneIds[i];
      }
    } else {
      config.tmux_session = `prompt-${sanitized}`;
      config.leader_pane_id = null;
      config.hud_pane_id = null;
      config.resize_hook_name = null;
      config.resize_hook_target = null;
      for (let i = 1; i <= workerCount; i++) {
        const startup = workerStartups[i - 1] || {};
        const workerName = `worker-${i}`;
        const child = spawnPromptWorker(
          sanitized,
          workerName,
          i,
          startup.cwd || leaderCwd,
          workerLaunchArgs,
          startup.env || {},
          workerCliPlan[i - 1],
        );
        if (config.workers[i - 1]) {
          config.workers[i - 1].pid = child.pid;
        }
      }
    }
    await saveTeamConfig(config, leaderCwd);

    // 7. Wait for all workers to be ready (interactive mode), then bootstrap them
    const allTasks = await listTasks(sanitized, leaderCwd);
    const manifest = await readTeamManifestV2(sanitized, leaderCwd);
    const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, workerLaunchMode);
    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const paneId = workerPaneIds[i - 1];
      const workerWorkspace = workerWorkspaceByName.get(workerName) ?? { cwd: leaderCwd };

      // Get tasks assigned to this worker
      const workerTasks = allTasks.filter(t => t.owner === workerName);

      // Write worker identity
      const identity: WorkerInfo = {
        name: workerName,
        index: i,
        role: agentType,
        worker_cli: workerCliPlan[i - 1],
        assigned_tasks: workerTasks.map(t => t.id),
        working_dir: workerWorkspace.cwd,
        worktree_path: workerWorkspace.worktreePath,
        worktree_branch: workerWorkspace.worktreeBranch,
        worktree_detached: workerWorkspace.worktreeDetached,
        team_state_root: teamStateRoot,
      };

      // Get pane PID and store it (interactive mode) or process PID (prompt mode)
      if (workerLaunchMode === 'interactive') {
        const panePid = getWorkerPanePid(sessionName, i);
        if (panePid) identity.pid = panePid;
      } else if (config.workers[i - 1]?.pid) {
        identity.pid = config.workers[i - 1].pid;
      }
      if (paneId) identity.pane_id = paneId;
      if (config.workers[i - 1]) {
        config.workers[i - 1].pane_id = paneId;
        config.workers[i - 1].worker_cli = workerCliPlan[i - 1];
        config.workers[i - 1].working_dir = workerWorkspace.cwd;
        config.workers[i - 1].worktree_path = workerWorkspace.worktreePath;
        config.workers[i - 1].worktree_branch = workerWorkspace.worktreeBranch;
        config.workers[i - 1].worktree_detached = workerWorkspace.worktreeDetached;
        config.workers[i - 1].team_state_root = teamStateRoot;
      }

      await writeWorkerIdentity(sanitized, workerName, identity, leaderCwd);

      // Wait for worker readiness
      if (workerLaunchMode === 'interactive' && !skipWorkerReadyWait) {
        const ready = waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);
        if (!ready) {
          throw new Error(`Worker ${workerName} did not become ready in tmux session ${sessionName}`);
        }
      }

      // Queue inbox via MCP/state then notify worker via tmux transport.
      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks, {
        teamStateRoot,
        leaderCwd,
      });
      const trigger = generateTriggerMessage(workerName, sanitized);
      const dispatchOutcome = await dispatchCriticalInboxInstruction({
        teamName: sanitized,
        config: config!,
        workerName,
        workerIndex: i,
        paneId,
        inbox,
        triggerMessage: trigger,
        cwd: leaderCwd,
        dispatchPolicy,
        inboxCorrelationKey: `startup:${workerName}`,
      });
      if (!dispatchOutcome.ok) {
        throw new Error(`worker_notify_failed:${workerName}`);
      }
    }
    await saveTeamConfig(config, leaderCwd);

    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName,
      config,
      cwd: leaderCwd,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];

    if (sessionCreated) {
      if (config?.resize_hook_name && config.resize_hook_target) {
        try {
          const unregistered = unregisterResizeHook(config.resize_hook_target, config.resize_hook_name);
          if (!unregistered) {
            rollbackErrors.push('unregisterResizeHook: returned false');
          }
        } catch (cleanupError) {
          rollbackErrors.push(`unregisterResizeHook: ${String(cleanupError)}`);
        }
      }

      if (config) {
        config.resize_hook_name = null;
        config.resize_hook_target = null;
        try {
          await saveTeamConfig(config, leaderCwd);
        } catch (cleanupError) {
          rollbackErrors.push(`saveTeamConfig(clear resize hook): ${String(cleanupError)}`);
        }
      }

      // In split-pane topology, we must not kill the entire tmux session; kill only created panes.
      if (sessionName.includes(':')) {
        for (const paneId of createdWorkerPaneIds) {
          try { killWorkerByPaneId(paneId, createdLeaderPaneId); } catch { /* ignore */ }
        }
        if (config?.hud_pane_id) {
          try { killWorkerByPaneId(config.hud_pane_id, createdLeaderPaneId); } catch { /* ignore */ }
        }
      } else {
        try {
          destroyTeamSession(sessionName);
        } catch (cleanupError) {
          rollbackErrors.push(`destroyTeamSession: ${String(cleanupError)}`);
        }
      }
    }
    if (workerLaunchMode === 'prompt' && config) {
      const promptTeardownFailures: string[] = [];
      for (const worker of config.workers) {
        const teardown = await teardownPromptWorker(
          sanitized,
          worker.name,
          worker.pid as number | undefined,
          leaderCwd,
          'startup_rollback',
        );
        if (!teardown.terminated) {
          promptTeardownFailures.push(`${worker.name}:${teardown.error || 'unknown_error'}`);
        }
      }
      if (promptTeardownFailures.length > 0) {
        rollbackErrors.push(`promptTeardown:${promptTeardownFailures.join(',')}`);
      }
    }

    if (workerInstructionsPath) {
      try {
        await removeTeamWorkerInstructionsFile(sanitized, leaderCwd);
      } catch (cleanupError) {
        rollbackErrors.push(`removeTeamWorkerInstructionsFile: ${String(cleanupError)}`);
      }
    }
    restoreTeamModelInstructionsFile(sanitized);

    try {
      await cleanupTeamState(sanitized, leaderCwd);
    } catch (cleanupError) {
      rollbackErrors.push(`cleanupTeamState: ${String(cleanupError)}`);
    }
    if (provisionedWorktrees.length > 0) {
      try {
        await rollbackProvisionedWorktrees(provisionedWorktrees);
      } catch (cleanupError) {
        rollbackErrors.push(`rollbackProvisionedWorktrees: ${String(cleanupError)}`);
      }
    }

    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; rollback encountered errors: ${rollbackErrors.join(' | ')}`);
    }

    throw error;
  }
}

/**
 * Monitor team state by polling files. Returns a snapshot.
 */
export async function monitorTeam(teamName: string, cwd: string): Promise<TeamSnapshot | null> {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  const sessionName = config.tmux_session;
  const listTasksStartMs = performance.now();
  const allTasks = await listTasks(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;
  const taskById = new Map(allTasks.map((task) => [task.id, task] as const));
  const inProgressByOwner = new Map<string, TeamTask[]>();
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  const workers: TeamSnapshot['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const alive = config.worker_launch_mode === 'prompt'
        ? isPromptWorkerAlive(config, worker)
        : isWorkerAlive(sessionName, worker.index, worker.pane_id);
      const [status, heartbeat] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
      ]);
      return { worker, alive, status, heartbeat };
    })
  );
  const workerScanMs = performance.now() - workerScanStartMs;

  for (const { worker: w, alive, status, heartbeat } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
    const currentTaskId = status.current_task_id ?? '';
    const turnsWithoutProgress =
      heartbeat &&
      previousTurns !== null &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId !== '' &&
      previousTaskId === currentTaskId
        ? Math.max(0, heartbeat.turn_count - previousTurns)
        : 0;

    workers.push({
      name: w.name,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress,
    });

    if (!alive) {
      deadWorkers.push(w.name);
      // Find in-progress tasks owned by this dead worker
      const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }

    if (alive && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
      recommendations.push(`Send reminder to non-reporting ${w.name}`);
    }
  }

  // Count tasks
  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter(t => t.status === 'pending').length,
    blocked: allTasks.filter(t => t.status === 'blocked').length,
    in_progress: allTasks.filter(t => t.status === 'in_progress').length,
    completed: allTasks.filter(t => t.status === 'completed').length,
    failed: allTasks.filter(t => t.status === 'failed').length,
  };

  const verificationPendingTasks = allTasks.filter(
    (task) => task.status === 'completed'
      && task.requires_code_change === true
      && !hasStructuredVerificationEvidence(task.result),
  );
  if (verificationPendingTasks.length > 0) {
    for (const task of verificationPendingTasks) {
      recommendations.push(`Verification evidence missing for task-${task.id}; require structured PASS/FAIL evidence before terminal success`);
    }
  }

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;

  const persistedPhase = await readTeamPhaseState(sanitized, cwd);
  const targetPhase = inferPhaseTargetFromTaskCounts(taskCounts, {
    verificationPending: verificationPendingTasks.length > 0,
  });
  const phaseState: TeamPhaseState = reconcilePhaseStateForMonitor(persistedPhase, targetPhase);
  await writeTeamPhaseState(sanitized, phaseState, cwd);
  const phase: TeamPhase | TerminalPhase = phaseState.current_phase;

  await emitMonitorDerivedEvents(sanitized, allTasks, workers, previousSnapshot, cwd);
  const mailboxDeliveryStartMs = performance.now();
  const mailboxNotifiedByMessageId = await deliverPendingMailboxMessages(
    sanitized,
    config,
    workers,
    previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    dispatchPolicy,
    cwd
  );
  const mailboxDeliveryMs = performance.now() - mailboxDeliveryStartMs;
  const updatedAt = new Date().toISOString();
  const totalMs = performance.now() - monitorStartMs;
  await writeMonitorSnapshot(
    sanitized,
      {
        taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
        workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
        workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
        workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
        workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
        mailboxNotifiedByMessageId,
        completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
        monitorTimings: {
          list_tasks_ms: Number(listTasksMs.toFixed(2)),
          worker_scan_ms: Number(workerScanMs.toFixed(2)),
          mailbox_delivery_ms: Number(mailboxDeliveryMs.toFixed(2)),
          total_ms: Number(totalMs.toFixed(2)),
          updated_at: updatedAt,
        },
      },
      cwd
  );

  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: allTasks,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
    performance: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      mailbox_delivery_ms: Number(mailboxDeliveryMs.toFixed(2)),
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  };
}

/**
 * Assign a task to a worker by writing inbox and sending trigger.
 */
export async function assignTask(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const task = await readTask(sanitized, taskId, cwd);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);

  if (manifest?.policy?.delegation_only && workerName === 'leader-fixed') {
    throw new Error('delegation_only_violation');
  }

  if (manifest?.policy?.plan_approval_required && task.requires_code_change === true) {
    const approved = await isTaskApprovedForExecution(sanitized, taskId, cwd);
    if (!approved) {
      throw new Error('plan_approval_required');
    }
  }
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const workerInfo = config.workers.find(w => w.name === workerName);
  if (!workerInfo) throw new Error(`Worker ${workerName} not found in team`);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);

  const claim = await claimTask(sanitized, taskId, workerName, task.version ?? 1, cwd);
  if (!claim.ok) {
    if (claim.error === 'blocked_dependency') {
      throw new Error(`blocked_dependency:${(claim.dependencies ?? []).join(',')}`);
    }
    throw new Error(claim.error);
  }

  try {
    const inbox = generateTaskAssignmentInbox(workerName, sanitized, taskId, task.description);
    const outcome = await dispatchCriticalInboxInstruction({
      teamName: sanitized,
      config,
      workerName,
      workerIndex: workerInfo.index,
      paneId: workerInfo.pane_id,
      inbox,
      triggerMessage: generateTriggerMessage(workerName, sanitized),
      cwd,
      dispatchPolicy,
      inboxCorrelationKey: `assign:${taskId}:${workerName}`,
    });
    if (!outcome.ok) {
      throw new Error('worker_notify_failed');
    }
  } catch (error) {
    // Roll back claim to avoid stuck in_progress tasks on any post-claim dispatch failure.
    const released = await releaseTaskClaim(sanitized, taskId, claim.claimToken, workerName, cwd);

    const reason = error instanceof Error && error.message.trim() !== ''
      ? error.message
      : 'worker_assignment_failed';

    try {
      await writeWorkerInbox(
        sanitized,
        workerName,
        `# Assignment Cancelled\n\nTask ${taskId} was not dispatched due to ${reason}.\nDo not execute this task from prior inbox content.`,
        cwd,
      );
    } catch {
      // best effort
    }

    if (!released.ok) {
      throw new Error(`${reason}:${released.error}`);
    }

    if (reason === 'worker_notify_failed') throw new Error('worker_notify_failed');
    throw new Error(`worker_assignment_failed:${reason}`);
  }
}

/**
 * Reassign a task from one worker to another.
 */
export async function reassignTask(
  teamName: string,
  taskId: string,
  _fromWorker: string,
  toWorker: string,
  cwd: string,
): Promise<void> {
  await assignTask(teamName, toWorker, taskId, cwd);
}

/**
 * Graceful shutdown: send shutdown inbox to all workers, wait, force kill, cleanup.
 */
export async function shutdownTeam(teamName: string, cwd: string, options: ShutdownOptions = {}): Promise<void> {
  const force = options.force === true;
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) {
    // No config -- just try to kill tmux session and clean up
    try { destroyTeamSession(`omx-team-${sanitized}`); } catch { /* ignore */ }
    await cleanupTeamState(sanitized, cwd);
    restoreTeamModelInstructionsFile(sanitized);
    return;
  }

  if (!force) {
    const allTasks = await listTasks(sanitized, cwd);
    const gate: ShutdownGateCounts = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      blocked: allTasks.filter((t) => t.status === 'blocked').length,
      in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
      failed: allTasks.filter((t) => t.status === 'failed').length,
      allowed: false,
    };
    gate.allowed = gate.pending === 0 && gate.blocked === 0 && gate.in_progress === 0 && gate.failed === 0;

    await appendTeamEvent(
      sanitized,
      {
        type: 'shutdown_gate',
        worker: 'leader-fixed',
        reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed}`,
      },
      cwd,
    ).catch(() => {});

    if (!gate.allowed) {
      throw new Error(
        `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
      );
    }
  }

  const sessionName = config.tmux_session;
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const shutdownRequestTimes = new Map<string, string>();

  // 1. Send shutdown inbox to each worker
  for (const w of config.workers) {
    try {
      const requestedAt = new Date().toISOString();
      await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
      shutdownRequestTimes.set(w.name, requestedAt);
      await dispatchCriticalInboxInstruction({
        teamName: sanitized,
        config,
        workerName: w.name,
        workerIndex: w.index,
        paneId: w.pane_id,
        inbox: generateShutdownInbox(sanitized, w.name),
        triggerMessage: generateTriggerMessage(w.name, sanitized),
        cwd,
        dispatchPolicy,
        inboxCorrelationKey: `shutdown:${w.name}`,
      });
    } catch { /* worker might already be dead */ }
  }

  // 2. Wait up to 15s for workers to exit and collect acks
  const deadline = Date.now() + 15_000;
  const rejected: Array<{ worker: string; reason: string }> = [];
  const ackedWorkers = new Set<string>();
  while (Date.now() < deadline) {
    for (const w of config.workers) {
      const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
      if (ack && !ackedWorkers.has(w.name)) {
        ackedWorkers.add(w.name);
        await appendTeamEvent(sanitized, {
          type: 'shutdown_ack',
          worker: w.name,
          reason: ack.status === 'reject' ? `reject:${ack.reason || 'no_reason'}` : 'accept',
        }, cwd);
      }
      if (ack?.status === 'reject') {
        if (!rejected.some((r) => r.worker === w.name)) {
          rejected.push({ worker: w.name, reason: ack.reason || 'no_reason' });
        }
      }
    }
    if (rejected.length > 0 && !force) {
      const detail = rejected.map(r => `${r.worker}:${r.reason}`).join(',');
      throw new Error(`shutdown_rejected:${detail}`);
    }

    const anyAlive = config.workers.some((w) => (
      config.worker_launch_mode === 'prompt'
        ? isPromptWorkerAlive(config, w)
        : isWorkerAlive(sessionName, w.index, w.pane_id)
    ));
    if (!anyAlive) break;
    // Sleep 2s
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const anyAliveAfterWait = config.workers.some((w) => (
    config.worker_launch_mode === 'prompt'
      ? isPromptWorkerAlive(config, w)
      : isWorkerAlive(sessionName, w.index, w.pane_id)
  ));
  if (anyAliveAfterWait && !force) {
    // Workers may have accepted shutdown but not exited (Codex TUI requires explicit exit).
    // In this case, proceed to force kill panes (next step) rather than failing and leaving state around.
  }

  // 3. Force kill remaining workers
  const leaderPaneId = config.leader_pane_id;
  const hudPaneId = config.hud_pane_id;
  if (config.worker_launch_mode === 'interactive') {
    let resizeHookWarning: string | null = null;
    if (config.resize_hook_name && config.resize_hook_target) {
      const resizeHookName = config.resize_hook_name;
      const unregistered = unregisterResizeHook(config.resize_hook_target, resizeHookName);
      if (!unregistered && isTmuxAvailable()) {
        const baseSession = sessionName.split(':')[0];
        const sessionStillActive = listTeamSessions().includes(baseSession);
        if (sessionStillActive) {
          resizeHookWarning = `failed to unregister resize hook ${resizeHookName}`;
        }
      }
    }
    config.resize_hook_name = null;
    config.resize_hook_target = null;
    await saveTeamConfig(config, cwd);
    if (resizeHookWarning) {
      console.warn(`[team shutdown] ${sanitized}: ${resizeHookWarning}; continuing teardown`);
    }
    for (const w of config.workers) {
      try {
        // Guard: never kill the leader's own pane or the HUD pane.
        if (leaderPaneId && w.pane_id === leaderPaneId) continue;
        if (hudPaneId && w.pane_id === hudPaneId) continue;
        if (isWorkerAlive(sessionName, w.index, w.pane_id)) {
          killWorker(sessionName, w.index, w.pane_id, leaderPaneId ?? undefined);
        }
      } catch { /* ignore */ }
    }

    // 4. Destroy tmux session
    if (!sessionName.includes(':')) {
      try { destroyTeamSession(sessionName); } catch { /* ignore */ }
    }
  } else {
    const promptTeardownFailures: string[] = [];
    for (const w of config.workers) {
      const teardown = await teardownPromptWorker(
        sanitized,
        w.name,
        w.pid as number | undefined,
        cwd,
        'shutdown',
      );
      if (!teardown.terminated) {
        promptTeardownFailures.push(`${w.name}:${teardown.error || 'unknown_error'}`);
      }
    }
    if (promptTeardownFailures.length > 0) {
      throw new Error(`shutdown_prompt_teardown_failed:${promptTeardownFailures.join(',')}`);
    }
  }

  // 5. Remove team-scoped worker instructions file (no mutation of project AGENTS.md)
  try { await removeTeamWorkerInstructionsFile(sanitized, cwd); } catch { /* ignore */ }
  restoreTeamModelInstructionsFile(sanitized);

  // 6. Cleanup state
  await cleanupTeamState(sanitized, cwd);
}

/**
 * Resume monitoring an existing team.
 */
export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;

  if (config.worker_launch_mode === 'prompt') {
    const hasLivePromptWorker = config.workers.some((worker) => isPromptWorkerAlive(config, worker));
    if (!hasLivePromptWorker) return null;

    const missingHandles = config.workers
      .filter((worker) => {
        if (!Number.isFinite(worker.pid) || (worker.pid ?? 0) <= 0) return false;
        try {
          process.kill(worker.pid as number, 0);
          return true;
        } catch {
          return false;
        }
      })
      .filter((worker) => !getPromptWorkerHandle(sanitized, worker.name));
    if (missingHandles.length > 0) {
      const detail = missingHandles.map((worker) => `${worker.name}:${worker.pid ?? 'unknown'}`).join(',');
      await appendTeamEvent(
        sanitized,
        {
          type: 'worker_stopped',
          worker: 'leader-fixed',
          reason: `prompt_resume_unavailable:missing_handle:${detail}`,
        },
        cwd,
      ).catch(() => {});
      return null;
    }
  } else {
    // Check if tmux session still exists
    const baseSession = config.tmux_session.split(':')[0];
    const teamSessions = getTeamTmuxSessions(sanitized);
    if (!teamSessions.includes(baseSession)) return null;
  }

  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName: config.tmux_session,
    config,
    cwd,
  };
}

async function findActiveTeams(cwd: string, leaderSessionId: string): Promise<string[]> {
  const root = join(cwd, '.omx', 'state', 'team');
  if (!existsSync(root)) return [];
  const sessions = new Set(listTeamSessions());
  const entries = await readdir(root, { withFileTypes: true });
  const active: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const teamName = e.name;
    const cfg = await readTeamConfig(teamName, cwd);
    const manifest = await readTeamManifestV2(teamName, cwd);
    if (manifest?.policy?.one_team_per_leader_session === false) continue;
    const workerLaunchMode = cfg?.worker_launch_mode
      ?? manifest?.policy?.worker_launch_mode
      ?? 'interactive';
    const tmuxSession = (manifest?.tmux_session || cfg?.tmux_session || `omx-team-${teamName}`).split(':')[0];
    if (leaderSessionId) {
      const ownerSessionId = manifest?.leader?.session_id?.trim() ?? '';
      if (ownerSessionId && ownerSessionId !== leaderSessionId) continue;
    }
    if (workerLaunchMode === 'prompt') {
      if ((cfg?.workers ?? []).some((worker) => isPromptWorkerAlive(cfg!, worker))) {
        active.push(teamName);
      }
      continue;
    }
    if (sessions.has(tmuxSession)) active.push(teamName);
  }
  return active;
}

async function resolveLeaderSessionId(cwd: string): Promise<string> {
  const fromEnv = process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.SESSION_ID;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  const p = join(cwd, '.omx', 'state', 'session.json');
  if (!existsSync(p)) return '';
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim() !== '') return parsed.session_id.trim();
  } catch {
    return '';
  }
  return '';
}

async function isTaskApprovedForExecution(teamName: string, taskId: string, cwd: string): Promise<boolean> {
  const record = await readTaskApproval(teamName, taskId, cwd);
  return record?.status === 'approved';
}

async function emitMonitorDerivedEvents(
  teamName: string,
  tasks: TeamTask[],
  workers: TeamSnapshot['workers'],
  previous: TeamMonitorSnapshotState | null,
  cwd: string,
): Promise<void> {
  if (!previous) return;

  for (const task of tasks) {
    const prevStatus = previous.taskStatusById[task.id];
    if (prevStatus && prevStatus !== 'completed' && task.status === 'completed') {
      // Skip if a task_completed event was already emitted by transitionTaskStatus (issue #161).
      if (previous.completedEventTaskIds?.[task.id]) continue;
      await appendTeamEvent(
        teamName,
        {
          type: 'task_completed',
          worker: task.owner || 'unknown',
          task_id: task.id,
          message_id: null,
          reason: undefined,
        },
        cwd
      );
    }
  }

  for (const worker of workers) {
    const prevAlive = previous.workerAliveByName[worker.name];
    if (prevAlive === true && worker.alive === false) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_stopped',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
        },
        cwd
      );
    }

    const prevState = previous.workerStateByName[worker.name];
    if (prevState && prevState !== 'idle' && worker.status.state === 'idle') {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_idle',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: undefined,
        },
        cwd
      );
    }
  }
}

function notifyWorkerOutcome(config: TeamConfig, workerIndex: number, message: string, workerPaneId?: string): DispatchOutcome {
  const worker = config.workers.find((candidate) => candidate.index === workerIndex);
  if (!worker) return { ok: false, transport: 'none', reason: 'worker_not_found' };

  if (config.worker_launch_mode === 'prompt') {
    const handle = getPromptWorkerHandle(config.name, worker.name);
    if (!handle) return { ok: false, transport: 'prompt_stdin', reason: 'prompt_worker_handle_missing' };
    try {
      sendToWorkerStdin(handle.child.stdin, message);
      return { ok: true, transport: 'prompt_stdin', reason: 'prompt_stdin_sent' };
    } catch (error) {
      return {
        ok: false,
        transport: 'prompt_stdin',
        reason: `prompt_stdin_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!config.tmux_session || !isTmuxAvailable()) {
    return { ok: false, transport: 'tmux_send_keys', reason: 'tmux_unavailable' };
  }
  try {
    sendToWorker(config.tmux_session, workerIndex, message, workerPaneId, worker.worker_cli);
    return { ok: true, transport: 'tmux_send_keys', reason: 'tmux_send_keys_sent' };
  } catch (error) {
    return {
      ok: false,
      transport: 'tmux_send_keys',
      reason: `tmux_send_keys_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveDispatchPolicy(
  manifestPolicy: TeamPolicy | null | undefined,
  workerLaunchMode: TeamConfig['worker_launch_mode'],
): TeamPolicy {
  return normalizeTeamPolicy(manifestPolicy, {
    display_mode: manifestPolicy?.display_mode === 'split_pane' ? 'split_pane' : 'auto',
    worker_launch_mode: workerLaunchMode,
  });
}

async function dispatchCriticalInboxInstruction(params: {
  teamName: string;
  config: TeamConfig;
  workerName: string;
  workerIndex: number;
  paneId?: string;
  inbox: string;
  triggerMessage: string;
  cwd: string;
  dispatchPolicy: TeamPolicy;
  inboxCorrelationKey: string;
}): Promise<DispatchOutcome> {
  const { teamName, config, workerName, workerIndex, paneId, inbox, triggerMessage, cwd, dispatchPolicy, inboxCorrelationKey } = params;

  if (config.worker_launch_mode === 'prompt') {
    return await queueInboxInstruction({
      teamName,
      workerName,
      workerIndex,
      paneId,
      inbox,
      triggerMessage,
      cwd,
      transportPreference: 'prompt_stdin',
      fallbackAllowed: false,
      inboxCorrelationKey,
      notify: (_target, message) => notifyWorkerOutcome(config, workerIndex, message, paneId),
    });
  }

  if (dispatchPolicy.dispatch_mode === 'transport_direct') {
    return await queueInboxInstruction({
      teamName,
      workerName,
      workerIndex,
      paneId,
      inbox,
      triggerMessage,
      cwd,
      transportPreference: 'transport_direct',
      fallbackAllowed: false,
      inboxCorrelationKey,
      notify: (_target, message) => notifyWorkerOutcome(config, workerIndex, message, paneId),
    });
  }

  const queued = await queueInboxInstruction({
    teamName,
    workerName,
    workerIndex,
    paneId,
    inbox,
    triggerMessage,
    cwd,
    transportPreference: 'hook_preferred_with_fallback',
    fallbackAllowed: true,
    inboxCorrelationKey,
    notify: () => ({ ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }),
  });

  if (!queued.request_id) return { ...queued, ok: false, reason: 'dispatch_request_missing_id' };

  const receipt = await waitForDispatchReceipt(teamName, queued.request_id, cwd, {
    timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
    pollMs: 50,
  });
  if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
    return { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: queued.request_id };
  }
  if (receipt?.status === 'failed') {
    const fallback = notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId);
    if (fallback.ok) {
      await transitionDispatchRequest(
        teamName,
        queued.request_id,
        'failed',
        'failed',
        { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
      return {
        ok: true,
        transport: fallback.transport,
        reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
        request_id: queued.request_id,
      };
    }
    await transitionDispatchRequest(
      teamName,
      queued.request_id,
      receipt.status,
      'failed',
      { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
    return {
      ok: false,
      transport: fallback.transport,
      reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
      request_id: queued.request_id,
    };
  }

  const fallback = notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId);
  if (fallback.ok) {
    const marked = await markDispatchRequestNotified(
      teamName,
      queued.request_id,
      { last_reason: `fallback_confirmed:${fallback.reason}` },
      cwd,
    );
    if (!marked) {
      await transitionDispatchRequest(
        teamName,
        queued.request_id,
        'failed',
        'failed',
        { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
    }
    return {
      ok: true,
      transport: fallback.transport,
      reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
      request_id: queued.request_id,
    };
  }

  const current = await readDispatchRequest(teamName, queued.request_id, cwd);
  if (current && current.status !== 'failed') {
    await transitionDispatchRequest(
      teamName,
      queued.request_id,
      current.status,
      'failed',
      { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
  }
  return {
    ok: false,
    transport: fallback.transport,
    reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
    request_id: queued.request_id,
  };
}

async function finalizeHookPreferredMailboxDispatch(params: {
  teamName: string;
  requestId: string;
  workerName: string;
  workerIndex?: number;
  paneId?: string;
  messageId: string;
  triggerMessage: string;
  config: TeamConfig;
  dispatchPolicy: TeamPolicy;
  cwd: string;
  fallbackNotify?: () => DispatchOutcome;
}): Promise<DispatchOutcome> {
  const {
    teamName,
    requestId,
    workerName,
    workerIndex,
    paneId,
    messageId,
    triggerMessage,
    config,
    dispatchPolicy,
    cwd,
    fallbackNotify,
  } = params;
  const receipt = await waitForDispatchReceipt(teamName, requestId, cwd, {
    timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
    pollMs: 50,
  });
  if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
    await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
    return { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: requestId, message_id: messageId };
  }

  const fallback: DispatchOutcome = fallbackNotify
    ? fallbackNotify()
    : (typeof workerIndex === 'number'
      ? notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId)
      : { ok: false, transport: 'none', reason: 'missing_worker_index' });
  if (receipt?.status === 'failed') {
    if (fallback.ok) {
      await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
      await transitionDispatchRequest(
        teamName,
        requestId,
        'failed',
        'failed',
        { message_id: messageId, last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
      return {
        ok: true,
        transport: fallback.transport,
        reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
        request_id: requestId,
        message_id: messageId,
      };
    }
    await transitionDispatchRequest(
      teamName,
      requestId,
      'failed',
      'failed',
      { message_id: messageId, last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
    return {
      ok: false,
      transport: fallback.transport,
      reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
      request_id: requestId,
      message_id: messageId,
    };
  }

  if (fallback.ok) {
    await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
    const marked = await markDispatchRequestNotified(
      teamName,
      requestId,
      { message_id: messageId, last_reason: `fallback_confirmed:${fallback.reason}` },
      cwd,
    );
    if (!marked) {
      await transitionDispatchRequest(
        teamName,
        requestId,
        'failed',
        'failed',
        { message_id: messageId, last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
    }
    return {
      ok: true,
      transport: fallback.transport,
      reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
      request_id: requestId,
      message_id: messageId,
    };
  }

  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (current) {
    await transitionDispatchRequest(
      teamName,
      requestId,
      current.status,
      'failed',
      { message_id: messageId, last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
  }
  return {
    ok: false,
    transport: fallback.transport,
    reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
    request_id: requestId,
    message_id: messageId,
  };
}

function notifyLeader(config: TeamConfig, message: string): boolean {
  if (!config.tmux_session) return false;
  return notifyLeaderStatus(config.tmux_session, message);
}

async function deliverPendingMailboxMessages(
  teamName: string,
  config: TeamConfig,
  workers: TeamSnapshot['workers'],
  previousNotifications: Record<string, string>,
  dispatchPolicy: TeamPolicy,
  cwd: string,
): Promise<Record<string, string>> {
  const nextNotifications: Record<string, string> = {};
  const pendingIdsAcrossTeam = new Set<string>();

  for (const worker of workers) {
    const workerInfo = config.workers.find((w) => w.name === worker.name);
    if (!workerInfo) continue;
    const mailbox = await listMailboxMessages(teamName, worker.name, cwd);
    const pending = mailbox.filter((m) => !m.delivered_at);
    if (pending.length === 0) continue;

    const pendingIds = pending.map((m) => m.message_id);
    for (const id of pendingIds) pendingIdsAcrossTeam.add(id);

    // Preserve already-tracked notification timestamps in the next snapshot.
    for (const msg of pending) {
      nextNotifications[msg.message_id] = msg.notified_at || previousNotifications[msg.message_id] || '';
    }

    // Only notify for messages that have never been successfully notified.
    // Using a message-ID set prevents re-notification on every monitor poll
    // (issue #116). A message is considered notified when either:
    //   - notified_at is set in the mailbox file (persisted by markMessageNotified), or
    //   - the message_id exists in previousNotifications from the last snapshot.
    // Both checks use Boolean() so an empty-string value is treated as unnotified.
    const unnotified = pending.filter(
      (m) => !m.notified_at && !previousNotifications[m.message_id],
    );
    if (unnotified.length === 0) continue;
    if (!worker.alive) continue;

    for (const msg of unnotified) {
      const triggerMessage = generateMailboxTriggerMessage(worker.name, teamName, 1);
      const transportPreference = config.worker_launch_mode === 'prompt'
        ? 'prompt_stdin'
        : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');
      const fallbackAllowed = transportPreference === 'hook_preferred_with_fallback';
      const queued = await enqueueDispatchRequest(
        teamName,
        {
          kind: 'mailbox',
          to_worker: worker.name,
          worker_index: workerInfo.index,
          pane_id: workerInfo.pane_id,
          trigger_message: triggerMessage,
          message_id: msg.message_id,
          transport_preference: transportPreference,
          fallback_allowed: fallbackAllowed,
        },
        cwd,
      );

      let outcome: DispatchOutcome;
      if (transportPreference === 'hook_preferred_with_fallback') {
        outcome = await finalizeHookPreferredMailboxDispatch({
          teamName,
          requestId: queued.request.request_id,
          workerName: worker.name,
          workerIndex: workerInfo.index,
          paneId: workerInfo.pane_id,
          messageId: msg.message_id,
          triggerMessage,
          config,
          dispatchPolicy,
          cwd,
        });
      } else {
        const direct = notifyWorkerOutcome(config, workerInfo.index, triggerMessage, workerInfo.pane_id);
        outcome = { ...direct, request_id: queued.request.request_id, message_id: msg.message_id };
        if (outcome.ok) {
          await markMessageNotified(teamName, worker.name, msg.message_id, cwd).catch(() => false);
          await markDispatchRequestNotified(
            teamName,
            queued.request.request_id,
            { message_id: msg.message_id, last_reason: outcome.reason },
            cwd,
          ).catch(() => null);
        }
      }

      if (outcome.ok) {
        nextNotifications[msg.message_id] = new Date().toISOString();
      }
    }
  }

  const pruned: Record<string, string> = {};
  for (const [messageId, ts] of Object.entries(nextNotifications)) {
    if (pendingIdsAcrossTeam.has(messageId) && ts) pruned[messageId] = ts;
  }
  return pruned;
}

export async function sendWorkerMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  if (toWorker === 'leader-fixed') {
    const leaderTriggerMessage = `Team ${sanitized}: new worker message for leader from ${fromWorker}`;
    const leaderTransportPreference = dispatchPolicy.dispatch_mode === 'transport_direct'
      ? 'transport_direct'
      : 'hook_preferred_with_fallback';
    const outcome = await queueDirectMailboxMessage({
      teamName: sanitized,
      fromWorker,
      toWorker,
      toPaneId: config.leader_pane_id ?? undefined,
      body,
      triggerMessage: leaderTriggerMessage,
      cwd,
      transportPreference: leaderTransportPreference,
      fallbackAllowed: leaderTransportPreference === 'hook_preferred_with_fallback',
      notify: (_target, message) => (
        leaderTransportPreference === 'hook_preferred_with_fallback'
          ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
          : { ok: notifyLeader(config, message), transport: 'tmux_send_keys', reason: 'leader_notified' }
      ),
    });
    let finalOutcome = outcome;
    const canLeaderFallbackDirectly = Boolean(config.leader_pane_id) && isTmuxAvailable();
    if (leaderTransportPreference === 'hook_preferred_with_fallback' && canLeaderFallbackDirectly) {
      if (!outcome.request_id || !outcome.message_id) {
        throw new Error('mailbox_notify_failed:dispatch_request_missing_id');
      }
      finalOutcome = await finalizeHookPreferredMailboxDispatch({
        teamName: sanitized,
        requestId: outcome.request_id,
        workerName: 'leader-fixed',
        paneId: config.leader_pane_id ?? undefined,
        messageId: outcome.message_id,
        triggerMessage: leaderTriggerMessage,
        config,
        dispatchPolicy,
        cwd,
        fallbackNotify: () => ({
          ok: notifyLeader(config, leaderTriggerMessage),
          transport: 'tmux_send_keys',
          reason: 'leader_notified',
        }),
      });
    }
    if (!finalOutcome.ok) throw new Error(`mailbox_notify_failed:${finalOutcome.reason}`);
    return;
  }

  const recipient = config.workers.find((w) => w.name === toWorker);
  if (!recipient) throw new Error(`Worker ${toWorker} not found in team`);

  const triggerMessage = generateMailboxTriggerMessage(toWorker, sanitized, 1);
  const transportPreference = config.worker_launch_mode === 'prompt'
    ? 'prompt_stdin'
    : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');
  const outcome = await queueDirectMailboxMessage({
    teamName: sanitized,
    fromWorker,
    toWorker,
    toWorkerIndex: recipient.index,
    toPaneId: recipient.pane_id,
    body,
    triggerMessage,
    cwd,
    transportPreference,
    fallbackAllowed: transportPreference === 'hook_preferred_with_fallback',
    notify: (_target, message) => (
      transportPreference === 'hook_preferred_with_fallback'
        ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
        : notifyWorkerOutcome(config, recipient.index, message, recipient.pane_id)
    ),
  });
  let finalOutcome = outcome;
  if (transportPreference === 'hook_preferred_with_fallback') {
    if (!outcome.request_id || !outcome.message_id) {
      throw new Error('mailbox_notify_failed:dispatch_request_missing_id');
    }
    finalOutcome = await finalizeHookPreferredMailboxDispatch({
      teamName: sanitized,
      requestId: outcome.request_id,
      workerName: recipient.name,
      workerIndex: recipient.index,
      paneId: recipient.pane_id,
      messageId: outcome.message_id,
      triggerMessage,
      config,
      dispatchPolicy,
      cwd,
    });
  }
  if (!finalOutcome.ok) throw new Error(`mailbox_notify_failed:${finalOutcome.reason}`);
}

export async function broadcastWorkerMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const transportPreference = config.worker_launch_mode === 'prompt'
    ? 'prompt_stdin'
    : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');

  const outcomes = await queueBroadcastMailboxMessage({
    teamName: sanitized,
    fromWorker,
    recipients: config.workers.map((w) => ({ workerName: w.name, workerIndex: w.index, paneId: w.pane_id })),
    body,
    cwd,
    triggerFor: (workerName) => generateMailboxTriggerMessage(workerName, sanitized, 1),
    transportPreference,
    fallbackAllowed: transportPreference === 'hook_preferred_with_fallback',
    notify: (target, message) =>
      transportPreference === 'hook_preferred_with_fallback'
        ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
        : (typeof target.workerIndex === 'number'
        ? notifyWorkerOutcome(config, target.workerIndex, message, target.paneId)
        : { ok: false, transport: 'none', reason: 'missing_worker_index' }),
  });
  const finalizedOutcomes: DispatchOutcome[] = [];
  for (const outcome of outcomes) {
    if (transportPreference !== 'hook_preferred_with_fallback') {
      finalizedOutcomes.push(outcome);
      continue;
    }
    if (!outcome.request_id || !outcome.message_id) {
      finalizedOutcomes.push({ ...outcome, ok: false, reason: 'dispatch_request_missing_id' });
      continue;
    }
    const target = outcome.to_worker
      ? (config.workers.find((w) => w.name === outcome.to_worker) ?? null)
      : null;
    if (!target) {
      finalizedOutcomes.push({ ...outcome, ok: false, reason: 'missing_worker_index' });
      continue;
    }
    finalizedOutcomes.push(await finalizeHookPreferredMailboxDispatch({
      teamName: sanitized,
      requestId: outcome.request_id,
      workerName: target.name,
      workerIndex: target.index,
      paneId: target.pane_id,
      messageId: outcome.message_id,
      triggerMessage: generateMailboxTriggerMessage(target.name, sanitized, 1),
      config,
      dispatchPolicy,
      cwd,
    }));
  }
  const results = transportPreference === 'hook_preferred_with_fallback' ? finalizedOutcomes : outcomes;
  if (results.some((result) => !result.ok)) {
    const firstFailure = results.find((result) => !result.ok);
    throw new Error(`mailbox_notify_failed:${firstFailure?.reason ?? 'unknown'}`);
  }
}
