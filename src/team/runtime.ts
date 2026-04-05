/**
 * Team runtime — thin orchestration barrel.
 *
 * Previously 3669 lines; split into:
 * - runtime-integration.ts   (Worker → Leader Git integration)
 * - runtime-shutdown.ts      (Shutdown orchestration)
 * - runtime-prompt-worker.ts (Prompt worker lifecycle)
 * - runtime-dispatch.ts      (Message dispatch / mailbox)
 * - runtime-monitor.ts       (Monitor snapshot)
 *
 * This file re-exports the public API and retains the few top-level
 * helpers that don't cleanly belong to any single module (startup
 * evidence polling, governance checks, model instruction file mgmt).
 */
import { resolve, dirname, join } from 'path';
import { existsSync, mkdirSync, readFile } from 'fs';
import { readdir } from 'fs/promises';

import {
  sanitizeTeamName,
  dismissTrustPromptIfPresent,
  isTmuxAvailable,
  restoreStandaloneHudPane,
  sleepFractionalSeconds,
  destroyTeamSession,
  teardownWorkerPanes,
  killWorkerByPaneIdAsync,
  getWorkerPanePid,
  isWorkerAlive,
  waitForWorkerReady,
  unregisterResizeHook,
  createTeamSession,
  listTeamSessions,
} from './tmux-session.js';
import {
  type TeamConfig,
  type WorkerInfo,
  type WorkerHeartbeat,
  type WorkerStatus,
  type TeamTask,
  type TeamMonitorSnapshotState,
  type TeamPhaseState,
  type TeamGovernance,
  type TeamPolicy,
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
  teamNormalizeGovernance as normalizeTeamGovernance,
  teamClaimTask as claimTask,
  teamReleaseTaskClaim as releaseTaskClaim,
  teamReclaimExpiredTaskClaim as reclaimExpiredTaskClaim,
  teamAppendEvent as appendTeamEvent,
  teamReadTaskApproval as readTaskApproval,
  teamListMailbox as listMailboxMessages,
  teamCleanup as cleanupTeamState,
  teamSaveConfig as saveTeamConfig,
  teamWriteShutdownRequest as writeShutdownRequest,
  teamReadShutdownAck as readShutdownAck,
  teamReadMonitorSnapshot as readMonitorSnapshot,
  teamWriteMonitorSnapshot as writeMonitorSnapshot,
  teamReadPhase as readTeamPhaseState,
  teamWritePhase as writeTeamPhaseState,
  teamSetWorkerPid as setWorkerPid,
} from './team-ops.js';
import {
  generateWorkerOverlay,
  writeTeamWorkerInstructionsFile,
  removeTeamWorkerInstructionsFile,
  writeWorkerWorktreeRootAgentsFile,
  removeWorkerWorktreeRootAgentsFile,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  generateMailboxTriggerMessage,
  generateLeaderMailboxTriggerMessage,
  writeWorkerRoleInstructionsFile,
} from './worker-bootstrap.js';
import { loadRolePrompt } from './role-router.js';
import { composeRoleInstructionsForRole } from '../agents/native-config.js';
import { codexPromptsDir } from '../utils/paths.js';
import { type TeamPhase, type TerminalPhase } from './orchestrator.js';
import {
  resolveTeamWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  parseTeamWorkerLaunchArgs,
  splitWorkerLaunchArgs,
  resolveAgentDefaultModel,
  resolveAgentReasoningEffort,
  type TeamReasoningEffort,
} from './model-contract.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { inferPhaseTargetFromTaskCounts, reconcilePhaseStateForMonitor } from './phase-controller.js';
import { getTeamTmuxSessions } from '../notifications/tmux.js';
import { hasStructuredVerificationEvidence } from '../verification/verifier.js';
import { buildRebalanceDecisions } from './rebalance-policy.js';
import { readModeState, updateModeState } from '../modes/base.js';
import {
  appendTeamCommitHygieneEntries,
  buildTeamCommitHygieneContext,
  writeTeamCommitHygieneContext,
  type TeamCommitHygieneArtifactPaths,
  type TeamOperationalCommitEntry,
} from './commit-hygiene.js';
import {
  assertCleanLeaderWorkspaceForWorkerWorktrees,
  ensureWorktree,
  isGitRepository,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
  type EnsureWorktreeResult,
  type WorktreeMode,
} from './worktree.js';
import {
  resolveTeamWorkerCli,
  type TeamWorkerCli,
  resolveTeamWorkerCliPlan,
  resolveTeamWorkerLaunchMode,
} from './tmux-session.js';
import {
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  injectSendWorkerMessage,
  integrateWorkerCommitsIntoLeader,
  type CommandResult,
  type WorkerShutdownMergeReport,
} from './runtime-integration.js';
import {
  collectProvisionedShutdownWorktrees,
  type TeamShutdownSummary as ShutdownSummary,
  resolveEffectiveTeamWorktreeMode,
  injectResolveInstructionStateRoot as injectShutdownResolveInstructionStateRoot,
} from './runtime-shutdown.js';
import {
  shutdownTeam as shutdownTeamImpl,
} from './runtime-shutdown.js';
import {
  registerPromptWorkerHandle,
  getPromptWorkerHandle,
  removePromptWorkerHandle,
  isPidAlive,
  isProcessGroupAlive,
  spawnPromptWorker,
  isPromptWorkerAlive,
  teardownPromptWorker,
  terminateTrackedProcessTree,
  resolveWorkerLaunchArgsFromEnv,
  resolveEffectiveWorkerCliForStartupLog,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL as PROMPT_WORKER_TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  resolveCanonicalTeamStateRoot as PROMPT_WORKER_resolveCanonicalTeamStateRoot,
} from './runtime-prompt-worker.js';
import {
  resolveDispatchPolicy,
  dispatchCriticalInboxInstruction,
  finalizeHookPreferredMailboxDispatch,
  deliverPendingMailboxMessages,
  notifyWorkerOutcome,
  sendWorkerMessage as sendWorkerMessageImpl,
  broadcastWorkerMessage as broadcastWorkerMessageImpl,
  notifyLeaderAsync,
  injectResolveInstructionStateRoot as injectDispatchResolveInstructionStateRoot,
  injectWaitForWorkerStartupEvidence,
} from './runtime-dispatch.js';
import {
  monitorTeam as monitorTeamImpl,
  injectAssignTask,
  injectEmitMonitorDerivedEvents as injectMonitorEmitMonitorDerivedEvents,
} from './runtime-monitor.js';

// ── Re-exported interfaces ──

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

export interface TeamRuntime {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
}

export interface TeamStartOptions {
  worktreeMode?: WorktreeMode;
}

export type { TeamShutdownSummary } from './runtime-shutdown.js';
export {
  resolveWorkerLaunchArgsFromEnv,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  resolveCanonicalTeamStateRoot,
} from './runtime-prompt-worker.js';

// ── Startup evidence helpers ──

const MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const TEAM_STATE_ROOT_ENV = 'OMX_TEAM_STATE_ROOT';
const TEAM_LEADER_CWD_ENV = 'OMX_TEAM_LEADER_CWD';
const WORKTREE_TRIGGER_STATE_ROOT = '$OMX_TEAM_STATE_ROOT';
const STARTUP_EVIDENCE_TIMEOUT_MS = 2_000;
const STARTUP_EVIDENCE_POLL_MS = 100;

type WorkerStartupEvidence = 'task_claim' | 'worker_progress' | 'leader_ack' | 'none';

function resolveInstructionStateRoot(worktreePath?: string | null): string | undefined {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function parseTeamWorkerContext(raw: string | undefined): { teamName: string; workerName: string } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const [teamName, workerName] = raw.trim().split('/');
  if (!teamName || !workerName) return null;
  return { teamName, workerName };
}

function resolveManifestLookupCwds(cwd: string): string[] {
  const candidates = new Set<string>([resolve(cwd)]);
  const leaderCwd = process.env[TEAM_LEADER_CWD_ENV];
  if (typeof leaderCwd === 'string' && leaderCwd.trim() !== '') {
    candidates.add(resolve(leaderCwd));
  }

  const teamStateRoot = process.env[TEAM_STATE_ROOT_ENV];
  if (typeof teamStateRoot === 'string' && teamStateRoot.trim() !== '') {
    candidates.add(resolve(teamStateRoot, '..', '..'));
  }

  return [...candidates];
}

function resolveGovernancePolicy(
  governance: TeamGovernance | null | undefined,
  legacyPolicy?: Partial<TeamGovernance> | null | undefined,
): TeamGovernance {
  return normalizeTeamGovernance(governance, legacyPolicy);
}

async function assertNestedTeamAllowed(cwd: string): Promise<void> {
  const workerContext = parseTeamWorkerContext(process.env.OMX_TEAM_WORKER);
  if (!workerContext) return;

  for (const candidateCwd of resolveManifestLookupCwds(cwd)) {
    const manifest = await readTeamManifestV2(workerContext.teamName, candidateCwd);
    const governance = resolveGovernancePolicy(manifest?.governance);
    if (governance.nested_teams_allowed) return;
    if (manifest) break;
  }

  throw new Error('nested_team_disallowed');
}

async function readWorkerStartupEvidence(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerStartupEvidence> {
  const status = await readWorkerStatus(teamName, workerName, cwd);
  if (typeof status.current_task_id === 'string' && status.current_task_id.trim() !== '') {
    return 'task_claim';
  }
  if (status.state === 'working' || status.state === 'blocked' || status.state === 'done' || status.state === 'failed') {
    return 'worker_progress';
  }
  const leaderMailbox = await listMailboxMessages(teamName, 'leader-fixed', cwd).catch(() => []);
  if (leaderMailbox.some((message) => message?.from_worker === workerName)) {
    return 'leader_ack';
  }
  return 'none';
}

function doesStartupEvidenceSettle(
  workerCli: TeamWorkerCli,
  evidence: WorkerStartupEvidence,
): boolean {
  if (evidence === 'none') return false;
  if (workerCli === 'codex' && evidence === 'leader_ack') return false;
  return true;
}

export async function waitForWorkerStartupEvidence(params: {
  teamName: string;
  workerName: string;
  workerCli: TeamWorkerCli;
  cwd: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<WorkerStartupEvidence> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs ?? STARTUP_EVIDENCE_TIMEOUT_MS));
  const pollMs = Math.max(25, Math.floor(params.pollMs ?? STARTUP_EVIDENCE_POLL_MS));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const evidence = await readWorkerStartupEvidence(params.teamName, params.workerName, params.cwd);
    if (doesStartupEvidenceSettle(params.workerCli, evidence)) return evidence;
    if (Date.now() >= deadline) return 'none';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function waitForClaudeStartupEvidence(params: {
  teamName: string;
  workerName: string;
  cwd: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<WorkerStartupEvidence> {
  return await waitForWorkerStartupEvidence({ ...params, workerCli: 'claude' });
}

function shouldSkipWorkerReadyWait(env: NodeJS.ProcessEnv): boolean {
  return env.OMX_TEAM_SKIP_READY_WAIT === '1';
}

function setTeamModelInstructionsFile(teamName: string, filePath: string): void {
  previousModelInstructionsFileByTeam.set(teamName, process.env[MODEL_INSTRUCTIONS_FILE_ENV]);
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

const previousModelInstructionsFileByTeam = new Map<string, string | undefined>();

// ── Sync root team mode state (terminal phase) ──

async function syncRootTeamModeStateOnTerminalPhase(
  teamName: string,
  phase: TeamPhase | TerminalPhase,
  cwd: string,
): Promise<void> {
  if (phase !== 'complete' && phase !== 'failed' && phase !== 'cancelled') return;

  try {
    const teamState = await readModeState('team', cwd);
    if (!teamState) return;

    const stateTeamName = typeof teamState.team_name === 'string' ? teamState.team_name.trim() : '';
    if (stateTeamName && stateTeamName !== teamName) return;

    const alreadySynced = teamState.active === false
      && teamState.current_phase === phase
      && typeof teamState.completed_at === 'string'
      && teamState.completed_at.length > 0;
    if (alreadySynced) return;

    const updates: Record<string, unknown> = {
      active: false,
      current_phase: phase,
      team_name: teamName,
    };
    if (typeof teamState.completed_at !== 'string' || !teamState.completed_at) {
      updates.completed_at = new Date().toISOString();
    }

    await updateModeState('team', updates, cwd);
  } catch {
    // Best-effort compatibility sync only.
  }
}

// ── Inject circular dependencies ──

injectSendWorkerMessage(sendWorkerMessageImpl);

async function runResolveInstructionStateRoot(path?: string | null): Promise<string | undefined> {
  return resolveInstructionStateRoot(path);
}
injectShutdownResolveInstructionStateRoot(resolveInstructionStateRoot);
injectDispatchResolveInstructionStateRoot(resolveInstructionStateRoot);
injectWaitForWorkerStartupEvidence(waitForWorkerStartupEvidence);

// Monitor module needs emitMonitorDerivedEvents — inline it here
async function emitMonitorDerivedEvents(
  teamName: string,
  tasks: TeamTask[],
  workers: TeamSnapshot['workers'],
  previous: TeamMonitorSnapshotState | null,
  workerLaunchMode: TeamConfig['worker_launch_mode'],
  cwd: string,
): Promise<void> {
  for (const task of tasks) {
    const prevStatus = previous?.taskStatusById[task.id];
    if (prevStatus && prevStatus !== 'completed' && task.status === 'completed') {
      if (previous?.completedEventTaskIds?.[task.id]) continue;
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
    const prevAlive = previous?.workerAliveByName[worker.name];
    const shouldEmitInitialPromptWorkerStop = workerLaunchMode === 'prompt' && prevAlive === undefined;
    if ((prevAlive === true || shouldEmitInitialPromptWorkerStop) && worker.alive === false) {
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

    const prevState = previous?.workerStateByName[worker.name];
    if (prevState && prevState !== worker.status.state) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_state_changed',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
          state: worker.status.state,
          prev_state: prevState,
        },
        cwd
      );
    }

    if (prevState && prevState !== 'idle' && worker.status.state === 'idle') {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_idle',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: undefined,
          prev_state: prevState,
          state: 'idle',
          source_type: 'worker_idle',
        },
        cwd
      );
    }
  }
}

injectMonitorEmitMonitorDerivedEvents(emitMonitorDerivedEvents);

// ── Public wrappers ──

export { sendWorkerMessageImpl as sendWorkerMessage } from './runtime-dispatch.js';
export { broadcastWorkerMessageImpl as broadcastWorkerMessage } from './runtime-dispatch.js';

export async function shutdownTeam(teamName: string, cwd: string, options: { force?: boolean } = {}): Promise<ShutdownSummary> {
  return shutdownTeamImpl(teamName, cwd, options);
}

export async function monitorTeam(teamName: string, cwd: string): Promise<TeamSnapshot | null> {
  return monitorTeamImpl(teamName, cwd);
}

// ── startTeam (retained here: too central to split) ──

export async function startTeam(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string }>,
  cwd: string,
  options: TeamStartOptions = {},
): Promise<TeamRuntime> {
  const leaderCwd = resolve(cwd);
  await assertNestedTeamAllowed(leaderCwd);
  const effectiveWorktreeMode = resolveEffectiveTeamWorktreeMode(leaderCwd, options.worktreeMode);

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

  const sanitized = sanitizeTeamName(teamName);
  const teamStateRoot = resolveCanonicalTeamStateRoot(leaderCwd);
  const activeWorktreeMode: 'detached' | 'named' | null =
    effectiveWorktreeMode.enabled
      ? (effectiveWorktreeMode.detached ? 'detached' : 'named')
      : null;
  const workspaceMode: 'single' | 'worktree' = activeWorktreeMode ? 'worktree' : 'single';
  const workerWorkspaceByName = new Map<string, {
    cwd: string;
    worktreeRepoRoot?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeDetached?: boolean;
    worktreeCreated?: boolean;
  }>();
  const provisionedWorktrees: Array<EnsureWorktreeResult | { enabled: false }> = [];
  for (let i = 1; i <= workerCount; i++) {
    workerWorkspaceByName.set(`worker-${i}`, { cwd: leaderCwd });
  }

  if (activeWorktreeMode) {
    assertCleanLeaderWorkspaceForWorkerWorktrees(leaderCwd);
    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const planned = planWorktreeTarget({
        cwd: leaderCwd,
        scope: 'team',
        mode: effectiveWorktreeMode,
        teamName: sanitized,
        workerName,
      });
      const ensured = ensureWorktree(planned);
      provisionedWorktrees.push(ensured);
      if (ensured.enabled) {
        workerWorkspaceByName.set(workerName, {
          cwd: ensured.worktreePath,
          worktreeRepoRoot: ensured.repoRoot,
          worktreePath: ensured.worktreePath,
          worktreeBranch: ensured.branchName ?? undefined,
          worktreeDetached: ensured.detached,
          worktreeCreated: ensured.created,
        });
      }
    }
  }

  const leaderSessionId = await resolveLeaderSessionId(leaderCwd);

  const activeTeams = await findActiveTeams(leaderCwd, leaderSessionId);
  if (activeTeams.length > 0) {
    throw new Error(`leader_session_conflict: active team exists (${activeTeams.join(', ')})`);
  }

  let sessionName = `omx-team-${sanitized}`;
  const overlay = generateWorkerOverlay(sanitized);
  let workerInstructionsPath: string | null = null;
  let sessionCreated = false;
  const createdWorkerPaneIds: string[] = [];
  let createdLeaderPaneId: string | undefined;
  let config: TeamConfig | null = null;
  const sharedWorkerLaunchArgs = resolveTeamWorkerLaunchArgs({
    existingRaw: process.env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    fallbackModel: resolveAgentDefaultModel(agentType, process.env.CODEX_HOME),
  });
  const workerCliPlan = resolveTeamWorkerCliPlan(workerCount, sharedWorkerLaunchArgs, process.env);
  const workerReadyTimeoutMs = resolveWorkerReadyTimeoutMs(process.env);
  const skipWorkerReadyWait = shouldSkipWorkerReadyWait(process.env);

  try {
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
        worktree_mode: effectiveWorktreeMode,
      },
      'default',
    );
    if (!config) throw new Error('failed to initialize team config');
    config.leader_cwd = leaderCwd;
    config.team_state_root = teamStateRoot;
    config.workspace_mode = workspaceMode;
    config.worktree_mode = effectiveWorktreeMode;

    for (const t of tasks) {
      await createStateTask(sanitized, {
        subject: t.subject,
        description: t.description,
        status: 'pending',
        owner: t.owner,
        blocked_by: t.blocked_by,
        role: t.role,
      }, leaderCwd);
    }

    if (workspaceMode !== 'worktree') {
      workerInstructionsPath = await writeTeamWorkerInstructionsFile(sanitized, leaderCwd, overlay);
      setTeamModelInstructionsFile(sanitized, workerInstructionsPath);
    }

    const allTasks = await listTasks(sanitized, leaderCwd);
    const workerBootstrapPlans = [] as Array<{
      workerName: string;
      workerWorkspace: {
        cwd: string;
        worktreeRepoRoot?: string;
        worktreePath?: string;
        worktreeBranch?: string;
        worktreeDetached?: boolean;
        worktreeCreated?: boolean;
      };
      workerTasks: TeamTask[];
      workerRole: string;
      rolePromptContent: string | null;
      instructionsFilePath: string;
      inbox: string;
      trigger: string;
      initialPrompt?: string;
      workerLaunchArgs: string[];
      workerCli: TeamWorkerCli;
    }>;

    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const workerWorkspace = workerWorkspaceByName.get(workerName) ?? { cwd: leaderCwd };
      const workerTasks = allTasks.filter(t => t.owner === workerName);
      const taskRoles = workerTasks.map(t => t.role).filter(Boolean) as string[];
      const uniqueTaskRoles = new Set(taskRoles);
      const workerRole = taskRoles.length > 0 && uniqueTaskRoles.size === 1
        ? taskRoles[0]
        : agentType;
      const rawRolePromptContent = await loadRolePrompt(workerRole, join(leaderCwd, '.codex', 'prompts'))
        ?? await loadRolePrompt(workerRole, codexPromptsDir());
      const preferredReasoning = resolveAgentReasoningEffort(workerRole) ?? resolveAgentReasoningEffort(agentType);
      const workerLaunchArgs = resolveWorkerLaunchArgsFromEnv(
        process.env,
        workerRole,
        undefined,
        preferredReasoning,
        workerCliPlan[i - 1],
      );
      const resolvedWorkerModel = parseTeamWorkerLaunchArgs(workerLaunchArgs).modelOverride ?? undefined;
      const rolePromptContent = rawRolePromptContent
        ? composeRoleInstructionsForRole(workerRole, rawRolePromptContent, resolvedWorkerModel)
        : null;
      const workerWorktreePath = workerWorkspace.worktreePath ?? undefined;
      const fallbackInstructionsPath = workerInstructionsPath ?? join(leaderCwd, 'AGENTS.md');
      const instructionsFilePath = workerWorktreePath
        ? await writeWorkerWorktreeRootAgentsFile({
          teamName: sanitized,
          workerName,
          workerRole,
          rolePromptContent: rolePromptContent ?? "",
          teamStateRoot,
          leaderCwd,
          worktreePath: workerWorktreePath,
        })
        : rolePromptContent
          ? await writeWorkerRoleInstructionsFile(sanitized, workerName, leaderCwd, fallbackInstructionsPath, workerRole, rolePromptContent)
          : fallbackInstructionsPath;
      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks, {
        teamStateRoot,
        leaderCwd,
        workerRole,
        rolePromptContent: rawRolePromptContent ?? undefined,
        worktreeRootAgentsCanonical: Boolean(workerWorkspace.worktreePath),
      });
      const trigger = generateTriggerMessage(
        workerName,
        sanitized,
        resolveInstructionStateRoot(workerWorkspace.worktreePath),
      );
      const initialPrompt = workerCliPlan[i - 1] === 'gemini' ? trigger : undefined;
      if (initialPrompt) {
        await writeWorkerInbox(sanitized, workerName, inbox, leaderCwd);
      }
      workerBootstrapPlans.push({
        workerName,
        workerWorkspace,
        workerTasks,
        workerRole,
        rolePromptContent,
        instructionsFilePath,
        inbox,
        trigger,
        initialPrompt,
        workerLaunchArgs,
        workerCli: workerCliPlan[i - 1],
      });
    }

    const workerStartups = workerBootstrapPlans.map((plan) => {
      const env: Record<string, string> = {
        [TEAM_STATE_ROOT_ENV]: teamStateRoot,
        [TEAM_LEADER_CWD_ENV]: leaderCwd,
        [MODEL_INSTRUCTIONS_FILE_ENV]: plan.instructionsFilePath,
      };
      if (plan.workerWorkspace.worktreePath) {
        env.OMX_TEAM_WORKTREE_PATH = plan.workerWorkspace.worktreePath;
      }
      if (plan.workerWorkspace.worktreeBranch) {
        env.OMX_TEAM_WORKTREE_BRANCH = plan.workerWorkspace.worktreeBranch;
      }
      if (typeof plan.workerWorkspace.worktreeDetached === 'boolean') {
        env.OMX_TEAM_WORKTREE_DETACHED = plan.workerWorkspace.worktreeDetached ? '1' : '0';
      }
      return {
        cwd: plan.workerWorkspace.cwd,
        env,
        initialPrompt: plan.initialPrompt,
        launchArgs: plan.workerLaunchArgs,
        workerCli: plan.workerCli,
      };
    });

    const workerPaneIds = Array.from({ length: workerCount }, () => undefined as string | undefined);

    if (workerLaunchMode === 'interactive') {
      const createdSession = createTeamSession(sanitized, workerCount, leaderCwd, sharedWorkerLaunchArgs, workerStartups);
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
          startup.launchArgs || sharedWorkerLaunchArgs,
          startup.env || {},
          startup.workerCli || workerCliPlan[i - 1],
          startup.initialPrompt,
        );
        if (config.workers[i - 1]) {
          config.workers[i - 1].pid = child.pid;
        }
      }
    }
    await saveTeamConfig(config, leaderCwd);

    const manifest = await readTeamManifestV2(sanitized, leaderCwd);
    const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, workerLaunchMode);
    for (let i = 1; i <= workerCount; i++) {
      const bootstrapPlan = workerBootstrapPlans[i - 1];
      if (!bootstrapPlan) throw new Error(`missing bootstrap plan for worker-${i}`);
      const { workerName, paneId, workerTasks, workerRole, inbox, trigger, initialPrompt } = {
        workerName: bootstrapPlan.workerName,
        paneId: workerPaneIds[i - 1],
        workerTasks: bootstrapPlan.workerTasks,
        workerRole: bootstrapPlan.workerRole,
        inbox: bootstrapPlan.inbox,
        trigger: bootstrapPlan.trigger,
        initialPrompt: bootstrapPlan.initialPrompt,
      };
      const workerWorkspace = bootstrapPlan.workerWorkspace;

      if (workerTasks.map(t => t.role).filter(Boolean).length > 0 && new Set(workerTasks.map(t => t.role).filter(Boolean)).size > 1) {
        console.log(`[omx:team] ${workerName}: mixed task roles [${[...new Set(workerTasks.map(t => t.role).filter(Boolean))].join(', ')}], falling back to ${agentType}`);
      }

      const identity: WorkerInfo = {
        name: workerName,
        index: i,
        role: workerRole,
        worker_cli: workerCliPlan[i - 1],
        assigned_tasks: workerTasks.map(t => t.id),
        working_dir: workerWorkspace.cwd,
        worktree_repo_root: workerWorkspace.worktreeRepoRoot,
        worktree_path: workerWorkspace.worktreePath,
        worktree_branch: workerWorkspace.worktreeBranch,
        worktree_detached: workerWorkspace.worktreeDetached,
        worktree_created: workerWorkspace.worktreeCreated,
        team_state_root: teamStateRoot,
      };

      if (workerLaunchMode === 'interactive') {
        const panePid = getWorkerPanePid(sessionName, i);
        if (panePid) identity.pid = panePid;
      } else if (config.workers[i - 1]?.pid) {
        identity.pid = config.workers[i - 1].pid;
      }
      if (paneId) identity.pane_id = paneId;
      if (config.workers[i - 1]) {
        config.workers[i - 1].pane_id = paneId;
        config.workers[i - 1].role = workerRole;
        config.workers[i - 1].worker_cli = workerCliPlan[i - 1];
        config.workers[i - 1].working_dir = workerWorkspace.cwd;
        config.workers[i - 1].worktree_repo_root = workerWorkspace.worktreeRepoRoot;
        config.workers[i - 1].worktree_path = workerWorkspace.worktreePath;
        config.workers[i - 1].worktree_branch = workerWorkspace.worktreeBranch;
        config.workers[i - 1].worktree_detached = workerWorkspace.worktreeDetached;
        config.workers[i - 1].worktree_created = workerWorkspace.worktreeCreated;
        config.workers[i - 1].team_state_root = teamStateRoot;
      }

      await writeWorkerIdentity(sanitized, workerName, identity, leaderCwd);

      if (workerLaunchMode === 'interactive' && !skipWorkerReadyWait && !initialPrompt) {
        const ready = waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);
        if (!ready) {
          throw new Error(`Worker ${workerName} did not become ready in tmux session ${sessionName}`);
        }
      }

      const maxStartupDispatchRetries = 3;
      const startupRetryDelayS = 3;
      let dispatchOutcome: DispatchOutcome = initialPrompt
        ? { ok: true, transport: 'none', reason: 'startup_prompt_delivered_at_launch' }
        : { ok: false, transport: 'none', reason: 'not_attempted' };
      if (!initialPrompt) {
        for (let attempt = 1; attempt <= maxStartupDispatchRetries; attempt++) {
          dispatchOutcome = await dispatchCriticalInboxInstruction({
            teamName: sanitized,
            config: config!,
            workerName,
            workerIndex: i,
            paneId,
            workerCli: workerCliPlan[i - 1],
            inbox,
            triggerMessage: trigger,
            cwd: leaderCwd,
            dispatchPolicy,
            inboxCorrelationKey: `startup:${workerName}`,
            requireWorkerStartupEvidence: true,
          });
          if (dispatchOutcome.ok) break;
          if (attempt < maxStartupDispatchRetries) {
            if (workerLaunchMode === 'interactive') {
              if (dismissTrustPromptIfPresent(sessionName, i, paneId)) {
                waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);
              } else {
                sleepFractionalSeconds(startupRetryDelayS);
              }
            } else {
              sleepFractionalSeconds(startupRetryDelayS);
            }
          }
        }
      }
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

      if (sessionName.includes(':')) {
        for (const [index, paneId] of createdWorkerPaneIds.entries()) {
          const panePid = getWorkerPanePid(sessionName, index + 1, paneId);
          if (panePid) {
            await terminateTrackedProcessTree(panePid);
          }
          try {
            await killWorkerByPaneIdAsync(paneId, createdLeaderPaneId);
          } catch (err) {
            process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
          }
        }
        if (config?.hud_pane_id) {
          try {
            await killWorkerByPaneIdAsync(config.hud_pane_id, createdLeaderPaneId);
          } catch (err) {
            process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
          }
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

    if (config) {
      for (const worker of config.workers) {
        if (!worker.worktree_path || !worker.team_state_root) continue;
        try {
          await removeWorkerWorktreeRootAgentsFile(
            sanitized,
            worker.name,
            worker.team_state_root,
            worker.worktree_path,
          );
        } catch (cleanupError) {
          rollbackErrors.push(`removeWorkerWorktreeRootAgentsFile(${worker.name}): ${String(cleanupError)}`);
        }
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
        await rollbackProvisionedWorktrees(provisionedWorktrees, {
          skipBranchDeletion: false,
        });
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

// ── assignTask / reassignTask ──

export async function assignTask(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);

  const task = await readTask(sanitized, taskId, cwd);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'pending') throw new Error(`Task ${taskId} is not pending (status: ${task.status})`);
  if (task.blocked_by && task.blocked_by.length > 0) {
    const blockingIds = task.blocked_by.filter(Boolean);
    if (blockingIds.length > 0) {
      const blockingTasks = await Promise.all(blockingIds.map((id) => readTask(sanitized, id, cwd)));
      const blockingPending = blockingTasks.filter((t) => t && t.status !== 'completed');
      if (blockingPending.length > 0) {
        throw new Error(`Task ${taskId} is blocked by ${blockingTasks.filter((t) => t && t.status !== 'completed').map((t) => `task-${t!.id}`).join(', ')}`);
      }
    }
  }

  await claimTask(sanitized, taskId, workerName, cwd);

  const taskOwner = config.workers.find((w) => w.name === workerName);
  if (!taskOwner) throw new Error(`Worker ${workerName} not found in team`);
  const assignedTasks = [...taskOwner.assigned_tasks];
  if (!assignedTasks.includes(taskId)) assignedTasks.push(taskId);
  taskOwner.assigned_tasks = assignedTasks;
  await saveTeamConfig(config, cwd);

  const allTasks = await listTasks(sanitized, cwd);
  const workerTasks = allTasks.filter((t) => t.owner === workerName);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);

  const inboxContent = generateTaskAssignmentInbox(
    sanitized,
    workerName,
    workerTasks,
    {
      teamStateRoot: config.team_state_root ?? resolveCanonicalTeamStateRoot(cwd),
      leaderCwd: config.leader_cwd ?? cwd,
    },
  );
  const trigger = generateTriggerMessage(
    workerName,
    sanitized,
    resolveInstructionStateRoot(taskOwner.worktree_path),
  );

  await dispatchCriticalInboxInstruction({
    teamName: sanitized,
    config,
    workerName,
    workerIndex: taskOwner.index,
    paneId: taskOwner.pane_id,
    workerCli: taskOwner.worker_cli,
    inbox: inboxContent,
    triggerMessage: trigger,
    cwd: config.leader_cwd ?? cwd,
    dispatchPolicy,
    inboxCorrelationKey: `reassign:${taskId}`,
  });
}

export async function reassignTask(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const task = await readTask(sanitized, taskId, cwd);
  if (!task) throw new Error(`Task ${taskId} not found`);

  await releaseTaskClaim(sanitized, taskId, fromWorker, cwd);
  await assignTask(sanitized, toWorker, taskId, cwd);
}

// ── resumeTeam ──

export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  config.lifecycle_profile = 'default';

  if (config.worker_launch_mode === 'prompt') {
    const hasLivePromptWorker = config.workers.some((worker) => isPromptWorkerAlive(config, worker));
    if (!hasLivePromptWorker) return null;

    const missingHandles = config.workers
      .filter((worker) => {
        if (!Number.isFinite(worker.pid) || (worker.pid ?? 0) <= 0) return false;
        return isPidAlive(worker.pid as number);
      })
      .filter((worker) => !getPromptWorkerHandle(sanitized, worker.name));
    if (missingHandles.length > 0) {
      const detail = missingHandles.map((worker) => `${worker.name}:${worker.pid ?? 'unknown'}`).join(',');
      await appendTeamEvent(
        sanitized,
        {
          type: 'worker_stopped',
          worker: 'leader-fixed',
          reason: `prompt_resume_unavailable:missing handle:${detail}`,
        },
        cwd,
      ).catch(() => {});
      return null;
    }
  } else {
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

// ── Helpers used by startTeam / resumeTeam ──

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
    const governance = resolveGovernancePolicy(manifest?.governance);
    if (governance.one_team_per_leader_session === false) continue;
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
  } catch (_err) {
    // best-effort
  }
  return '';
}

// ── Backwards compat re-exports (from shutdown module) ──

export { resolveEffectiveTeamWorktreeMode } from './runtime-shutdown.js';
export { dispatchCriticalInboxInstruction, resolveDispatchPolicy } from './runtime-dispatch.js';
