/**
 * Dynamic worker scaling for team mode — Phase 1: Manual Scaling.
 *
 * Provides scale_up (add workers mid-session) and scale_down (drain + remove idle workers).
 * Gated behind the OMX_TEAM_SCALING_ENABLED environment variable.
 *
 * Key design decisions:
 * - Monotonic worker index counter (next_worker_index in config) ensures unique names
 * - File-based scaling lock prevents concurrent scale operations
 * - 'draining' worker status for graceful transitions during scale_down
 */

import { join, resolve } from 'path';
import { mkdir, rm } from 'fs/promises';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  waitForWorkerReady,
  dismissTrustPromptIfPresent,
  sendToWorker,
  isWorkerAlive,
  getWorkerPanePid,
  teardownWorkerPanes,
  buildWorkerStartupCommand,
  resolveTeamWorkerCliPlan,
} from './tmux-session.js';
import { execFileSync, spawnSync } from 'child_process';
import {
  teamReadConfig as readTeamConfig,
  teamSaveConfig as saveTeamConfig,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamReadManifest as readTeamManifestV2,
  teamNormalizePolicy as normalizeTeamPolicy,
  teamReadWorkerStatus as readWorkerStatus,
  teamWriteWorkerStatus as writeWorkerStatus,
  teamWithScalingLock as withScalingLock,
  teamAppendEvent as appendTeamEvent,
  teamCreateTask as createStateTask,
  teamListTasks as listTasks,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamReadDispatchRequest as readDispatchRequest,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  type TeamConfig,
  type WorkerInfo,
  type WorkerStatus,
} from './team-ops.js';
import {
  queueInboxInstruction,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateInitialInbox,
  buildTriggerDirective,
  writeWorkerRoleInstructionsFile,
  writeWorkerWorktreeRootAgentsFile,
  removeWorkerWorktreeRootAgentsFile,
} from './worker-bootstrap.js';
import { buildTeamWorkerGoalInstruction } from './goal-workflow.js';
import { loadRolePrompt } from './role-router.js';
import { composeRoleInstructionsForRole } from '../agents/native-config.js';
import { codexPromptsDir } from '../utils/paths.js';
import { resolveCodexHomeForLaunch } from '../cli/codex-home.js';
import {
  parseTeamWorkerLaunchArgs,
  resolveTeamWorkerLaunchArgs,
  resolveAgentDefaultModel,
  resolveAgentReasoningEffort,
  type TeamReasoningEffort,
} from './model-contract.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import {
  ensureWorktree,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
  type EnsureWorktreeResult,
  type WorktreeMode,
} from './worktree.js';

// ── Environment gate ──────────────────────────────────────────────────────────

const OMX_TEAM_SCALING_ENABLED_ENV = 'OMX_TEAM_SCALING_ENABLED';
const WORKTREE_TRIGGER_STATE_ROOT = '$OMX_TEAM_STATE_ROOT';

export function isScalingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OMX_TEAM_SCALING_ENABLED_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function assertScalingEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isScalingEnabled(env)) {
    throw new Error(
      `Dynamic scaling is disabled. Set ${OMX_TEAM_SCALING_ENABLED_ENV}=1 to enable.`,
    );
  }
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ScaleUpResult {
  ok: true;
  addedWorkers: WorkerInfo[];
  newWorkerCount: number;
  nextWorkerIndex: number;
}

export interface ScaleDownResult {
  ok: true;
  removedWorkers: string[];
  newWorkerCount: number;
}

export interface ScaleError {
  ok: false;
  error: string;
}

function resolveInstructionStateRoot(worktreePath?: string | null): string | undefined {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}

function resolveLegacyScaledTeamWorktreeMode(config: Pick<TeamConfig, 'name' | 'workspace_mode' | 'worktree_mode' | 'workers'>): WorktreeMode {
  if (config.worktree_mode) return config.worktree_mode;
  if (config.workspace_mode !== 'worktree') return { enabled: false };

  const workersWithMetadata = config.workers.filter((worker) =>
    worker.worktree_path || worker.worktree_branch || typeof worker.worktree_detached === 'boolean',
  );
  if (workersWithMetadata.length === 0) {
    throw new Error(`scale_up_missing_team_worktree_contract:${config.name}`);
  }

  if (workersWithMetadata.some((worker) => worker.worktree_detached === true)) {
    return { enabled: true, detached: true, name: null };
  }

  const branchPrefixes = new Set(
    workersWithMetadata
      .map((worker) => worker.worktree_branch?.trim())
      .filter((branch): branch is string => Boolean(branch))
      .map((branch) => {
        const match = /^(.*)\/worker-\d+$/.exec(branch);
        return match?.[1]?.trim() || '';
      })
      .filter(Boolean),
  );

  if (branchPrefixes.size === 1) {
    return { enabled: true, detached: false, name: [...branchPrefixes][0] };
  }

  throw new Error(`scale_up_missing_team_worktree_contract:${config.name}`);
}

function resolveScaleUpWorktreeMode(config: TeamConfig): WorktreeMode {
  if (config.workspace_mode !== 'worktree') return { enabled: false };
  try {
    return resolveLegacyScaledTeamWorktreeMode(config);
  } catch (error) {
    if (error instanceof Error && error.message === `scale_up_missing_team_worktree_contract:${config.name}`) {
      return { enabled: true, detached: true, name: null };
    }
    throw error;
  }
}

async function notifyWorkerPaneOutcome(
  sessionName: string,
  workerIndex: number,
  message: string,
  paneId?: string,
  workerCli?: 'codex' | 'claude' | 'gemini',
): Promise<DispatchOutcome> {
  try {
    await sendToWorker(sessionName, workerIndex, message, paneId, workerCli);
    return { ok: true, transport: 'tmux_send_keys', reason: 'tmux_send_keys_sent' };
  } catch (error) {
    return {
      ok: false,
      transport: 'tmux_send_keys',
      reason: `tmux_send_keys_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Scale Up ──────────────────────────────────────────────────────────────────

/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUp(
  teamName: string,
  count: number,
  agentType: string,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string }>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleUpResult | ScaleError> {
  assertScalingEnabled(env);

  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, error: `count must be a positive integer (got ${count})` };
  }

  if (!isTmuxAvailable()) {
    return { ok: false, error: 'tmux is not available' };
  }

  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleUpResult | ScaleError> => {
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }

    const maxWorkers = config.max_workers;
    const currentCount = config.workers.length;
    if (currentCount + count > maxWorkers) {
      return {
        ok: false,
        error: `Cannot add ${count} workers: would exceed max_workers (${currentCount} + ${count} > ${maxWorkers})`,
      };
    }

    const teamStateRoot = config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd);
    const codexHomeOverride = resolveCodexHomeForLaunch(leaderCwd, env);
    const launchEnv = codexHomeOverride
      ? { ...env, CODEX_HOME: codexHomeOverride }
      : env;
    const sessionName = config.tmux_session;
    const manifest = await readTeamManifestV2(sanitized, leaderCwd);
    const dispatchPolicy = normalizeTeamPolicy(manifest?.policy, {
      display_mode: manifest?.policy?.display_mode === 'split_pane' ? 'split_pane' : 'auto',
      worker_launch_mode: config.worker_launch_mode,
    });
    const effectiveWorktreeMode = config.worktree_mode ?? resolveScaleUpWorktreeMode(config);
    if (!config.worktree_mode && effectiveWorktreeMode.enabled) {
      config.worktree_mode = effectiveWorktreeMode;
      await saveTeamConfig(config, leaderCwd);
    }

    // Resolve the monotonic worker index counter
    let nextIndex = config.next_worker_index ?? (currentCount + 1);
    const initialNextIndex = nextIndex;
    const addedWorkers: WorkerInfo[] = [];
    const createdTaskIds: string[] = [];

    const rollbackScaleUp = async (
      error: string,
      context: { paneId?: string; workerName?: string; worktreePath?: string } = {},
    ): Promise<ScaleError> => {
      for (const w of addedWorkers) {
        const idx = config.workers.findIndex((worker) => worker.name === w.name);
        if (idx >= 0) {
          config.workers.splice(idx, 1);
        }
        try {
          if (w.pane_id) {
            execFileSync('tmux', ['kill-pane', '-t', w.pane_id], { stdio: 'pipe',
      windowsHide: true,
    });
          }
        } catch {}
        if (w.worktree_path) {
          await removeWorkerWorktreeRootAgentsFile(sanitized, w.name, teamStateRoot, w.worktree_path).catch(() => {});
        }
      }

      if (
        context.workerName &&
        context.worktreePath &&
        !addedWorkers.some((worker) => worker.name === context.workerName)
      ) {
        await removeWorkerWorktreeRootAgentsFile(
          sanitized,
          context.workerName,
          teamStateRoot,
          context.worktreePath,
        ).catch(() => {});
      }

      if (context.paneId) {
        try {
          execFileSync('tmux', ['kill-pane', '-t', context.paneId], { stdio: 'pipe',
      windowsHide: true,
    });
        } catch {}
      }

      for (const taskId of createdTaskIds) {
        await rm(join(leaderCwd, '.omx', 'state', 'team', sanitized, 'tasks', `task-${taskId}.json`), { force: true }).catch(() => {});
      }

      config.worker_count = config.workers.length;
      config.next_worker_index = initialNextIndex;
      await saveTeamConfig(config, leaderCwd);

      return { ok: false, error };
    };

    // Persist incoming tasks first so scaling resolves worker roles and inboxes from
    // canonical task state (stable task ids, owner, role), matching startTeam().
    for (const task of tasks) {
      const createdTask = await createStateTask(sanitized, {
        subject: task.subject,
        description: task.description,
        status: 'pending',
        owner: task.owner,
        blocked_by: task.blocked_by,
        role: task.role,
      }, leaderCwd);
      createdTaskIds.push(createdTask.id);
    }
    const persistedTasks = await listTasks(sanitized, leaderCwd);

    // Resolve shared worker launch args for CLI selection.
    const sharedWorkerLaunchArgs = resolveWorkerLaunchArgsForScaling(launchEnv, agentType, undefined, codexHomeOverride);
    const workerCliPlan = resolveTeamWorkerCliPlan(count, sharedWorkerLaunchArgs, launchEnv);

    for (let i = 0; i < count; i++) {
      const workerIndex = nextIndex;
      nextIndex++;
      const workerName = `worker-${workerIndex}`;

      // Create worker directory
      const workerDirPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'workers', workerName);
      await mkdir(workerDirPath, { recursive: true });

      // Resolve per-worker role from assigned task roles before launch so reasoning effort can vary by teammate.
      const workerTaskRoles = persistedTasks.filter(t => t.owner === workerName).map(t => t.role).filter(Boolean) as string[];
      const uniqueTaskRoles = new Set(workerTaskRoles);
      const workerRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1
        ? workerTaskRoles[0]
        : agentType;
      const runtimeRole = workerRole;
      if (uniqueTaskRoles.size > 1) {
        console.log(`[omx:scaling] ${workerName}: mixed task roles [${[...uniqueTaskRoles].join(', ')}], falling back to ${agentType}`);
      }

      const worktreeMode = resolveScaleUpWorktreeMode(config);
      const workerWorkspaceResult = worktreeMode.enabled
        ? ensureWorktree(planWorktreeTarget({
            cwd: leaderCwd,
            scope: 'team',
            mode: worktreeMode,
            teamName: sanitized,
            workerName,
          }))
        : { enabled: false } as const;
      const workerWorkspace = workerWorkspaceResult.enabled ? workerWorkspaceResult : null;
      const workerCwd = workerWorkspace ? workerWorkspace.worktreePath : leaderCwd;

      // Build startup command and create tmux pane
      const rawRolePromptContent = await loadRolePrompt(runtimeRole, join(leaderCwd, '.codex', 'prompts'))
        ?? await loadRolePrompt(runtimeRole, codexPromptsDir());
      const preferredReasoning = resolveAgentReasoningEffort(runtimeRole, codexHomeOverride)
        ?? resolveAgentReasoningEffort(agentType, codexHomeOverride);
      const workerLaunchArgs = resolveWorkerLaunchArgsForScaling(launchEnv, runtimeRole, preferredReasoning, codexHomeOverride);
      const resolvedWorkerModel = parseTeamWorkerLaunchArgs(workerLaunchArgs).modelOverride ?? undefined;
      const rolePromptContent = rawRolePromptContent
        ? composeRoleInstructionsForRole(runtimeRole, rawRolePromptContent, resolvedWorkerModel)
        : null;
      const teamInstructionsPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'worker-agents.md');
      const instructionsFilePath = workerWorkspace
        ? await writeWorkerWorktreeRootAgentsFile({
            teamName: sanitized,
            workerName,
            workerRole: runtimeRole,
            rolePromptContent: rolePromptContent ?? '',
            teamStateRoot,
            leaderCwd,
            worktreePath: workerWorkspace.worktreePath,
          })
        : rolePromptContent
          ? await writeWorkerRoleInstructionsFile(sanitized, workerName, leaderCwd, teamInstructionsPath, runtimeRole, rolePromptContent)
          : teamInstructionsPath;
      const extraEnv: Record<string, string> = {
        OMX_TEAM_STATE_ROOT: teamStateRoot,
        OMX_TEAM_LEADER_CWD: leaderCwd,
        OMX_MODEL_INSTRUCTIONS_FILE: instructionsFilePath,
        ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
      };
      if (workerWorkspace) {
        extraEnv.OMX_TEAM_WORKTREE_PATH = workerWorkspace.worktreePath;
        if (workerWorkspace.branchName) {
          extraEnv.OMX_TEAM_WORKTREE_BRANCH = workerWorkspace.branchName;
        }
        extraEnv.OMX_TEAM_WORKTREE_DETACHED = workerWorkspace.detached ? '1' : '0';
      }
      const cmd = buildWorkerStartupCommand(
        sanitized,
        workerIndex,
        workerLaunchArgs,
        workerCwd,
        extraEnv,
        workerCliPlan[i],
        undefined,
        runtimeRole,
      );

      // Find the right-most worker pane to split from, or fall back to leader pane.
      // Keep the initial split from leader horizontal to preserve the leader-left
      // / workers-right composition.
      const splitTarget = config.workers.length > 0
        ? (config.workers[config.workers.length - 1]?.pane_id ?? config.leader_pane_id ?? '')
        : (config.leader_pane_id ?? '');
      const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';

      const result = spawnSync('tmux', [
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', workerCwd, cmd,
      ], { encoding: 'utf-8' });

      if (result.status !== 0) {
        return await rollbackScaleUp(
          `Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`,
          { workerName, worktreePath: workerWorkspace?.worktreePath },
        );
      }

      const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }

      // Intentionally avoid forcing `select-layout tiled` here.
      // Tiled relayout reflows leader/HUD panes and breaks team window layout.

      // Get PID
      const panePid = getWorkerPanePid(sessionName, workerIndex, paneId);

      const workerInfo: WorkerInfo = {
        name: workerName,
        index: workerIndex,
        role: workerRole,
        worker_cli: workerCliPlan[i],
        assigned_tasks: [],
        pid: panePid ?? undefined,
        pane_id: paneId,
        working_dir: workerCwd,
        worktree_repo_root: workerWorkspace ? workerWorkspace.repoRoot : undefined,
        worktree_path: workerWorkspace ? workerWorkspace.worktreePath : undefined,
        worktree_branch: workerWorkspace ? (workerWorkspace.branchName ?? undefined) : undefined,
        worktree_detached: workerWorkspace ? workerWorkspace.detached : undefined,
        worktree_created: workerWorkspace ? workerWorkspace.created : undefined,
        team_state_root: teamStateRoot,
      };

      await writeWorkerIdentity(sanitized, workerName, workerInfo, leaderCwd);

      // Wait for worker readiness
      const readyTimeoutMs = resolveWorkerReadyTimeoutMs(env);
      const skipReadyWait = env.OMX_TEAM_SKIP_READY_WAIT === '1';
      if (!skipReadyWait) {
        const ready = waitForWorkerReady(sessionName, workerIndex, readyTimeoutMs, paneId);
        if (!ready) {
          console.log(`[omx:scaling] Warning: worker ${workerName} did not become ready within timeout`);
        }
      }

      // Get assigned tasks for this worker
      const workerTasks = persistedTasks.filter(t => t.owner === workerName);

      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks, {
        teamStateRoot,
        leaderCwd,
        workerRole: runtimeRole,
        rolePromptContent: rawRolePromptContent ?? undefined,
        worktreeRootAgentsCanonical: Boolean(workerWorkspace?.worktreePath),
        workerGoalInstruction: buildTeamWorkerGoalInstruction(sanitized, workerName, workerTasks, { teamStateRoot }),
      });

      const triggerDirective = buildTriggerDirective(
        workerName,
        sanitized,
        resolveInstructionStateRoot(workerInfo.worktree_path),
      );
      const queued = await queueInboxInstruction({
        teamName: sanitized,
        workerName,
        workerIndex,
        paneId,
        inbox,
        triggerMessage: triggerDirective.text,
        intent: triggerDirective.intent,
        cwd: leaderCwd,
        transportPreference: dispatchPolicy.dispatch_mode,
        fallbackAllowed: true,
        inboxCorrelationKey: `scale_up:${workerName}`,
        notify: async (_target, message) => {
          if (dispatchPolicy.dispatch_mode === 'hook_preferred_with_fallback') {
            return { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' };
          }
          return await notifyWorkerPaneOutcome(sessionName, workerIndex, message, paneId, workerCliPlan[i]);
        },
      });
      let outcome = queued;
      if (dispatchPolicy.dispatch_mode === 'hook_preferred_with_fallback' && queued.request_id) {
        const receipt = await waitForDispatchReceipt(sanitized, queued.request_id, leaderCwd, {
          timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
          pollMs: 50,
        });
        if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
          outcome = { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: queued.request_id };
        } else {
          const fallback = await notifyWorkerPaneOutcome(sessionName, workerIndex, triggerDirective.text, paneId, workerCliPlan[i]);
          if (receipt?.status === 'failed') {
            if (fallback.ok) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
              outcome = {
                ok: true,
                transport: fallback.transport,
                reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
                request_id: queued.request_id,
              };
            } else {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
              outcome = {
                ok: false,
                transport: fallback.transport,
                reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
                request_id: queued.request_id,
              };
            }
          } else if (fallback.ok) {
            const marked = await markDispatchRequestNotified(
              sanitized,
              queued.request_id,
              { last_reason: `fallback_confirmed:${fallback.reason}` },
              leaderCwd,
            );
            if (!marked) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
            }
            outcome = {
              ok: true,
              transport: fallback.transport,
              reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
              request_id: queued.request_id,
            };
          } else {
            const current = await readDispatchRequest(sanitized, queued.request_id, leaderCwd);
            if (current) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                current.status,
                'failed',
                { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
            }
            outcome = {
              ok: false,
              transport: fallback.transport,
              reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
              request_id: queued.request_id,
            };
          }
        }
      }
      // Retry dispatch once if a trust prompt is blocking the worker pane (fixes #393).
      if (!outcome.ok && dismissTrustPromptIfPresent(sessionName, workerIndex, paneId)) {
        waitForWorkerReady(sessionName, workerIndex, readyTimeoutMs, paneId);
        const retry = await notifyWorkerPaneOutcome(sessionName, workerIndex, triggerDirective.text, paneId, workerCliPlan[i]);
        if (retry.ok) {
          outcome = retry;
        }
      }
      if (!outcome.ok) {
        return await rollbackScaleUp(`scale_up_dispatch_failed:${workerName}:${outcome.reason}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }

      addedWorkers.push(workerInfo);
      config.workers.push(workerInfo);
      config.worker_count = config.workers.length;
      config.next_worker_index = nextIndex;
      await saveTeamConfig(config, leaderCwd);
    }

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      addedWorkers,
      newWorkerCount: config.worker_count,
      nextWorkerIndex: nextIndex,
    };
  });
}

// ── Scale Down ────────────────────────────────────────────────────────────────

export interface ScaleDownOptions {
  /** Worker names to remove. If empty, removes idle workers up to `count`. */
  workerNames?: string[];
  /** Number of idle workers to remove (used when workerNames is not specified). */
  count?: number;
  /** Force kill without waiting for drain. Default: false. */
  force?: boolean;
  /** Drain timeout in milliseconds. Default: 30000. */
  drainTimeoutMs?: number;
}

/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export async function scaleDown(
  teamName: string,
  cwd: string,
  options: ScaleDownOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleDownResult | ScaleError> {
  assertScalingEnabled(env);

  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);
  const force = options.force === true;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleDownResult | ScaleError> => {
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }

    // Determine which workers to remove
    let targetWorkers: WorkerInfo[];
    if (options.workerNames && options.workerNames.length > 0) {
      targetWorkers = [];
      for (const name of options.workerNames) {
        const w = config.workers.find(w => w.name === name);
        if (!w) {
          return { ok: false, error: `Worker ${name} not found in team ${sanitized}` };
        }
        targetWorkers.push(w);
      }
    } else {
      const count = options.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        return { ok: false, error: `count must be a positive integer (got ${count})` };
      }
      // Find idle workers to remove
      const idleWorkers: WorkerInfo[] = [];
      for (const w of config.workers) {
        const status = await readWorkerStatus(sanitized, w.name, leaderCwd);
        if (status.state === 'idle' || status.state === 'done' || status.state === 'unknown') {
          idleWorkers.push(w);
        }
      }
      if (idleWorkers.length < count && !force) {
        return {
          ok: false,
          error: `Not enough idle workers to remove: found ${idleWorkers.length}, requested ${count}. Use force=true to remove busy workers.`,
        };
      }
      targetWorkers = idleWorkers.slice(0, count);
      if (force && targetWorkers.length < count) {
        // Add non-idle workers if force is enabled
        const remaining = count - targetWorkers.length;
        const targetNames = new Set(targetWorkers.map(w => w.name));
        const nonIdle = config.workers.filter(w => !targetNames.has(w.name));
        targetWorkers.push(...nonIdle.slice(0, remaining));
      }
    }

    if (targetWorkers.length === 0) {
      return { ok: false, error: 'No workers selected for removal' };
    }

    // Minimum worker guard: must keep at least 1 worker
    if (config.workers.length - targetWorkers.length < 1) {
      return { ok: false, error: 'Cannot remove all workers — at least 1 must remain' };
    }

    const sessionName = config.tmux_session;
    const removedNames: string[] = [];

    // Phase 1: Set workers to 'draining' status
    for (const w of targetWorkers) {
      const drainingStatus: WorkerStatus = {
        state: 'draining',
        reason: 'scale_down requested by leader',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus(sanitized, w.name, drainingStatus, leaderCwd);
    }

    // Phase 2: Wait for draining workers to finish or timeout
    if (!force) {
      const deadline = Date.now() + drainTimeoutMs;
      while (Date.now() < deadline) {
        const allDrained = await Promise.all(
          targetWorkers.map(async (w) => {
            const status = await readWorkerStatus(sanitized, w.name, leaderCwd);
            return status.state === 'idle' || status.state === 'done' ||
                   status.state === 'draining' || !isWorkerAlive(sessionName, w.index, w.pane_id);
          }),
        );
        if (allDrained.every(Boolean)) break;
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // Phase 3: Kill tmux panes and remove from config
    const leaderPaneId = config.leader_pane_id;
    const hudPaneId = config.hud_pane_id;
    const targetPaneIds = targetWorkers
      .map((w) => w.pane_id)
      .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().length > 0);
    await teardownWorkerPanes(targetPaneIds, {
      leaderPaneId,
      hudPaneId,
    });
    const detachedWorktreesToRollback: EnsureWorktreeResult[] = targetWorkers
      .filter((worker) =>
        worker.worktree_created === true
        && worker.worktree_detached === true
        && typeof worker.worktree_repo_root === 'string'
        && worker.worktree_repo_root.length > 0
        && typeof worker.worktree_path === 'string'
        && worker.worktree_path.length > 0,
      )
      .map((worker) => ({
        enabled: true,
        repoRoot: worker.worktree_repo_root as string,
        worktreePath: resolve(worker.worktree_path as string),
        detached: true,
        branchName: null,
        created: true,
        reused: false,
        createdBranch: false,
      }));
    if (detachedWorktreesToRollback.length > 0) {
      try {
        await rollbackProvisionedWorktrees(detachedWorktreesToRollback);
      } catch (error) {
        return { ok: false, error: `scale_down_worktree_cleanup_failed:${String(error)}` };
      }
    }

    for (const w of targetWorkers) {
      if (w.worktree_path) {
        await removeWorkerWorktreeRootAgentsFile(sanitized, w.name, w.team_state_root ?? config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd), w.worktree_path).catch(() => {});
      }
      removedNames.push(w.name);
    }

    // Phase 4: Update config
    const removedSet = new Set(removedNames);
    config.workers = config.workers.filter(w => !removedSet.has(w.name));
    config.worker_count = config.workers.length;
    await saveTeamConfig(config, leaderCwd);

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_down: removed ${removedNames.length} worker(s) [${removedNames.join(', ')}], new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      removedWorkers: removedNames,
      newWorkerCount: config.worker_count,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function resolveWorkerLaunchArgsForScaling(
  env: NodeJS.ProcessEnv,
  agentType: string,
  preferredReasoning?: TeamReasoningEffort,
  codexHomeOverride?: string,
): string[] {
  const inheritedArgs: string[] = [];
  const fallbackModel = resolveAgentDefaultModel(agentType, codexHomeOverride ?? env.CODEX_HOME);

  return resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
    preferredReasoning,
  });
}
