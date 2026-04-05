/**
 * Prompt Worker lifecycle management.
 *
 * Handles spawning, tracking, and tearing down prompt worker subprocesses,
 * plus process tree discovery and termination.
 */
import { spawn, spawnSync, type ChildProcessByStdio } from 'child_process';
import type { Writable } from 'stream';
import { resolveTeamWorkerCli, buildWorkerProcessLaunchSpec, type TeamWorkerCli } from './tmux-session.js';
import {
  type TeamConfig,
  type WorkerInfo,
  type TeamWorkerIntegrationState,
  teamAppendEvent as appendTeamEvent,
  teamReadManifest as readTeamManifestV2,
  teamNormalizeGovernance as normalizeTeamGovernance,
  teamReadWorkerStatus as readWorkerStatus,
  teamReadWorkerHeartbeat as readWorkerHeartbeat,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamWriteWorkerInbox as writeWorkerInbox,
  teamCreateTask as createStateTask,
  teamReadTask as readTask,
  teamSetWorkerPid as setWorkerPid,
} from './team-ops.js';
import {
  queueInboxInstruction,
  queueBroadcastMailboxMessage,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateInitialInbox,
  generateTriggerMessage,
  writeWorkerRoleInstructionsFile,
} from './worker-bootstrap.js';
import { loadRolePrompt } from './role-router.js';
import { composeRoleInstructionsForRole } from '../agents/native-config.js';
import { codexPromptsDir } from '../utils/paths.js';
import {
  resolveTeamWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  parseTeamWorkerLaunchArgs,
  splitWorkerLaunchArgs,
  resolveAgentDefaultModel,
  type TeamReasoningEffort,
} from './model-contract.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import type { WorktreeMode } from './worktree.js';

// ── Types & constants ──

export interface PromptWorkerHandle {
  child: ChildProcessByStdio<Writable, null, null>;
  pid: number;
  processGroupId: number | null;
}

export interface PromptWorkerTeardownResult {
  terminated: boolean;
  forcedKill: boolean;
  pid: number | null;
  error?: string;
}

export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
}

export const PROMPT_WORKER_SIGTERM_WAIT_MS = 3_000;
export const PROMPT_WORKER_SIGKILL_WAIT_MS = 2_000;
export const PROMPT_WORKER_EXIT_POLL_MS = 100;

// ── Registry ──

const promptWorkerRegistry = new Map<string, Map<string, PromptWorkerHandle>>();

export function registerPromptWorkerHandle(
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
  existingTeamHandles.set(workerName, {
    child,
    pid: processPid,
    processGroupId: process.platform !== 'win32' ? processPid : null,
  });
  promptWorkerRegistry.set(teamName, existingTeamHandles);

  child.on('exit', () => {
    const teamHandles = promptWorkerRegistry.get(teamName);
    if (!teamHandles) return;
    const handle = teamHandles.get(workerName);
    if (handle?.processGroupId && isProcessGroupAlive(handle.processGroupId)) {
      return;
    }
    teamHandles.delete(workerName);
    if (teamHandles.size === 0) promptWorkerRegistry.delete(teamName);
  });
}

export function getPromptWorkerHandle(teamName: string, workerName: string): PromptWorkerHandle | null {
  return promptWorkerRegistry.get(teamName)?.get(workerName) ?? null;
}

export function removePromptWorkerHandle(teamName: string, workerName: string): void {
  const teamHandles = promptWorkerRegistry.get(teamName);
  if (!teamHandles) return;
  teamHandles.delete(workerName);
  if (teamHandles.size === 0) promptWorkerRegistry.delete(teamName);
}

// ── Process tree queries ──

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    return false;
  }
}

export function isProcessGroupAlive(processGroupId: number): boolean {
  if (process.platform === 'win32') return false;
  if (!Number.isFinite(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    return false;
  }
}

export function listProcessTreeEntries(): ProcessTreeEntry[] {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['axww', '-o', 'pid=,ppid='], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      if (!Number.isFinite(ppid) || ppid < 0) return null;
      return { pid, ppid } satisfies ProcessTreeEntry;
    })
    .filter((entry): entry is ProcessTreeEntry => entry !== null);
}

export function collectProcessTreePids(rootPid: number): number[] {
  if (!Number.isFinite(rootPid) || rootPid <= 0) return [];

  const childrenByPid = new Map<number, number[]>();
  for (const entry of listProcessTreeEntries()) {
    const siblings = childrenByPid.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    childrenByPid.set(entry.ppid, siblings);
  }

  const ordered: number[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    ordered.push(pid);
    for (const childPid of childrenByPid.get(pid) ?? []) {
      if (!seen.has(childPid)) stack.push(childPid);
    }
  }

  return ordered.reverse();
}

// ── Termination ──

export async function waitForTrackedPidsExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const tracked = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
  if (tracked.length === 0) return true;

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (tracked.every((pid) => !isPidAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, PROMPT_WORKER_EXIT_POLL_MS));
  }

  return tracked.every((pid) => !isPidAlive(pid));
}

export async function terminateTrackedProcessTree(
  rootPid: number,
  processGroupId: number | null = null,
  graceMs: number = PROMPT_WORKER_SIGTERM_WAIT_MS,
  killWaitMs: number = PROMPT_WORKER_SIGKILL_WAIT_MS,
): Promise<{ terminated: boolean; forcedKill: boolean; trackedPids: number[] }> {
  if (processGroupId && process.platform !== 'win32') {
    const trackedPids = collectProcessTreePids(rootPid);
    try {
      process.kill(-processGroupId, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      }
    }
    for (const pid of trackedPids) {
      if (pid === rootPid) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
        }
      }
    }

    const groupDeadline = Date.now() + Math.max(0, graceMs);
    while (Date.now() < groupDeadline) {
      const groupAlive = isProcessGroupAlive(processGroupId);
      const descendantsAlive = trackedPids.some((pid) => isPidAlive(pid));
      if (!groupAlive && !descendantsAlive) {
        return { terminated: true, forcedKill: false, trackedPids };
      }
      await new Promise((resolve) => setTimeout(resolve, PROMPT_WORKER_EXIT_POLL_MS));
    }

    try {
      process.kill(-processGroupId, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      }
    }
    for (const pid of trackedPids) {
      if (!isPidAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
        }
      }
    }

    const killDeadline = Date.now() + Math.max(0, killWaitMs);
    while (Date.now() < killDeadline) {
      const groupAlive = isProcessGroupAlive(processGroupId);
      const descendantsAlive = trackedPids.some((pid) => isPidAlive(pid));
      if (!groupAlive && !descendantsAlive) {
        return { terminated: true, forcedKill: true, trackedPids };
      }
      await new Promise((resolve) => setTimeout(resolve, PROMPT_WORKER_EXIT_POLL_MS));
    }

    return {
      terminated: !isProcessGroupAlive(processGroupId) && trackedPids.every((pid) => !isPidAlive(pid)),
      forcedKill: true,
      trackedPids,
    };
  }

  const trackedPids = collectProcessTreePids(rootPid);
  if (trackedPids.length === 0) {
    return {
      terminated: !isPidAlive(rootPid),
      forcedKill: false,
      trackedPids: [],
    };
  }

  for (const pid of trackedPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      }
    }
  }

  if (await waitForTrackedPidsExit(trackedPids, graceMs)) {
    return { terminated: true, forcedKill: false, trackedPids };
  }

  for (const pid of trackedPids) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      }
    }
  }

  return {
    terminated: await waitForTrackedPidsExit(trackedPids, killWaitMs),
    forcedKill: true,
    trackedPids,
  };
}

export async function teardownPromptWorker(
  teamName: string,
  workerName: string,
  fallbackPid: number | undefined,
  cwd: string,
  context: 'startup_rollback' | 'shutdown',
): Promise<PromptWorkerTeardownResult> {
  const handle = getPromptWorkerHandle(teamName, workerName);
  const handlePid = handle?.pid;
  const processGroupId = handle?.processGroupId ?? null;
  const pid = (typeof handlePid === 'number' && Number.isFinite(handlePid))
    ? handlePid
    : (Number.isFinite(fallbackPid) && (fallbackPid ?? 0) > 0 ? (fallbackPid as number) : null);

  if (pid === null && processGroupId === null) {
    removePromptWorkerHandle(teamName, workerName);
    return { terminated: true, forcedKill: false, pid: null };
  }

  const teardown = await terminateTrackedProcessTree(pid ?? 0, processGroupId);
  const processGone = processGroupId ? !isProcessGroupAlive(processGroupId) : !isPidAlive(pid!);
  if (teardown.terminated && processGone) {
    removePromptWorkerHandle(teamName, workerName);
    return { terminated: true, forcedKill: teardown.forcedKill, pid };
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
  if (!teardown.terminated) {
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
      forcedKill: teardown.forcedKill,
      pid,
      error: 'still_alive_after_sigkill',
    };
  }

  removePromptWorkerHandle(teamName, workerName);
  return { terminated: true, forcedKill: teardown.forcedKill, pid };
}

export function isPromptWorkerAlive(config: TeamConfig, worker: WorkerInfo): boolean {
  const handle = getPromptWorkerHandle(config.name, worker.name);
  if (handle?.child.exitCode === null && !handle.child.killed) return true;
  if (handle?.processGroupId && isProcessGroupAlive(handle.processGroupId)) return true;
  if (process.platform !== 'win32' && isProcessGroupAlive(worker.pid as number)) return true;
  return isPidAlive(worker.pid as number);
}

// ── Spawning ──

export function spawnPromptWorker(
  teamName: string,
  workerName: string,
  workerIndex: number,
  workerCwd: string,
  launchArgs: string[],
  workerEnv: Record<string, string>,
  workerCli: 'codex' | 'claude' | 'gemini',
  initialPrompt?: string,
): ChildProcessByStdio<Writable, null, null> {
  const processSpec = buildWorkerProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    workerCwd,
    workerEnv,
    workerCli,
    initialPrompt,
  );
  const child = spawn(
    processSpec.command,
    processSpec.args,
    {
      cwd: workerCwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...processSpec.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  registerPromptWorkerHandle(teamName, workerName, child);
  return child;
}

// ── Worker startup helpers ──

export function resolveEffectiveWorkerCliForStartupLog(
  resolvedLaunchArgs: string[],
  env: NodeJS.ProcessEnv,
): 'codex' | 'claude' | 'gemini' {
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
      const resolvedMap = entries.map((entry): 'codex' | 'claude' | 'gemini' | null => {
        if (entry === 'auto') return autoCli;
        if (entry === 'codex' || entry === 'claude' || entry === 'gemini') return entry;
        return null;
      });
      if (resolvedMap.every((entry) => entry === 'claude')) return 'claude';
      if (resolvedMap.every((entry) => entry === 'gemini')) return 'gemini';
      if (resolvedMap.some((entry) => entry === 'codex')) return 'codex';
    }
  }

  return resolveTeamWorkerCli(resolvedLaunchArgs, env);
}

export function resolveWorkerLaunchArgsFromEnv(
  env: NodeJS.ProcessEnv,
  agentType: string,
  inheritedLeaderModel?: string,
  preferredReasoning?: TeamReasoningEffort,
  workerCliOverride?: TeamWorkerCli,
): string[] {
  const inheritedArgs = (typeof inheritedLeaderModel === 'string' && inheritedLeaderModel.trim() !== '')
    ? ['--model', inheritedLeaderModel.trim()]
    : [];
  const fallbackModel = resolveAgentDefaultModel(agentType, env.CODEX_HOME);

  // Detect if an explicit reasoning override exists before resolving (for log source labeling)
  const preEnvArgs = splitWorkerLaunchArgs(env.OMX_TEAM_WORKER_LAUNCH_ARGS);
  const preAllArgs = [...preEnvArgs, ...inheritedArgs];
  const hasExplicitReasoning = parseTeamWorkerLaunchArgs(preAllArgs).reasoningOverride !== null;

  const resolved = resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
    preferredReasoning,
  });

  // Extract resolved model and thinking level from result args for startup log
  const resolvedParsed = parseTeamWorkerLaunchArgs(resolved);
  const resolvedModel = resolvedParsed.modelOverride ?? fallbackModel ?? 'default';
  const reasoningMatch = resolvedParsed.reasoningOverride?.match(/model_reasoning_effort\s*=\s*"?(\w+)"?/);
  const thinkingLevel = reasoningMatch?.[1] ?? 'none';
  const source = hasExplicitReasoning
    ? 'explicit'
    : (preferredReasoning ? 'role-default' : 'none/default-none');
  const effectiveWorkerCli = workerCliOverride ?? resolveEffectiveWorkerCliForStartupLog(resolved, env);
  if (effectiveWorkerCli === 'claude') {
    console.log('[omx:team] worker startup resolution: model=claude source=local-settings');
  } else if (effectiveWorkerCli === 'gemini') {
    console.log('[omx:team] worker startup resolution: model=gemini source=local-settings');
  } else {
    console.log(`[omx:team] worker startup resolution: model=${resolvedModel} thinking_level=${thinkingLevel} source=${source}`);
  }

  return resolved;
}

// ── Re-exports ──

export { TEAM_LOW_COMPLEXITY_DEFAULT_MODEL, resolveCanonicalTeamStateRoot };
