import {
  completeRalphthonPrd,
  ensureHardeningPhase,
  findTaskRef,
  markTaskStatus,
  nextPendingTask,
  readRalphthonPrd,
  recordHardeningWaveResult,
  shouldTerminateHardening,
  writeRalphthonPrd,
  type RalphthonPrd,
  type RalphthonTaskRef,
} from './prd.js';
import {
  diffPaneCapture,
  readRalphthonRuntimeState,
  withPersistedCapture,
  writeRalphthonRuntimeState,
  type RalphthonRuntimeState,
} from './runtime.js';
import { readSessionState } from '../hooks/session.js';
import {
  readSubagentSessionSummary,
  type SubagentSessionSummary,
} from '../subagents/tracker.js';

export type RalphthonMarker =
  | { type: 'prd_ready'; raw: string }
  | { type: 'task_start'; raw: string; taskId: string }
  | { type: 'task_done'; raw: string; taskId: string }
  | { type: 'task_failed'; raw: string; taskId: string; reason?: string }
  | { type: 'hardening_generated'; raw: string; wave: number; count: number };

export interface RalphthonOrchestratorDeps {
  readPrd: () => Promise<RalphthonPrd | null>;
  writePrd: (prd: RalphthonPrd) => Promise<void>;
  readRuntime: () => Promise<RalphthonRuntimeState | null>;
  writeRuntime: (runtime: RalphthonRuntimeState) => Promise<void>;
  capturePane: (leaderTarget: string) => Promise<string>;
  injectPrompt: (leaderTarget: string, prompt: string) => Promise<boolean | void>;
  updateModeState?: (patch: Record<string, unknown>) => Promise<void>;
  alert?: (message: string) => Promise<void> | void;
  readSubagentSummary?: (sessionId: string, now: Date) => Promise<SubagentSessionSummary | null>;
  now?: () => Date;
}

export interface RalphthonTickResult {
  injectedPrompt?: string;
  markerTypes: RalphthonMarker['type'][];
  phase?: string;
  completed: boolean;
}

export function parseRalphthonMarkers(capture: string): RalphthonMarker[] {
  const markers: RalphthonMarker[] = [];
  for (const rawLine of capture.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('[RALPHTHON_')) continue;

    let match = /^\[RALPHTHON_PRD_READY\]\b/.exec(line);
    if (match) {
      markers.push({ type: 'prd_ready', raw: line });
      continue;
    }

    match = /^\[RALPHTHON_TASK_START\]\s+id=([^\s]+)\s*$/u.exec(line);
    if (match) {
      markers.push({ type: 'task_start', raw: line, taskId: match[1] || '' });
      continue;
    }

    match = /^\[RALPHTHON_TASK_DONE\]\s+id=([^\s]+)\s*$/u.exec(line);
    if (match) {
      markers.push({ type: 'task_done', raw: line, taskId: match[1] || '' });
      continue;
    }

    match = /^\[RALPHTHON_TASK_FAILED\]\s+id=([^\s]+)(?:\s+reason=(.+))?$/u.exec(line);
    if (match) {
      markers.push({
        type: 'task_failed',
        raw: line,
        taskId: match[1] || '',
        reason: match[2]?.trim() || undefined,
      });
      continue;
    }

    match = /^\[RALPHTHON_HARDENING_GENERATED\]\s+wave=(\d+)\s+count=(\d+)\s*$/u.exec(line);
    if (match) {
      markers.push({
        type: 'hardening_generated',
        raw: line,
        wave: Number.parseInt(match[1] || '0', 10),
        count: Number.parseInt(match[2] || '0', 10),
      });
    }
  }
  return markers;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function promptForTask(taskRef: RalphthonTaskRef, prd: RalphthonPrd): string {
  const phase = prd.phase;
  const story = taskRef.storyId ? ` story=${taskRef.storyId}` : '';
  return `[RALPHTHON_ASSIGN] id=${taskRef.task.id}${story} phase=${phase} desc=${JSON.stringify(taskRef.task.desc)}`;
}

function promptForHardeningWave(prd: RalphthonPrd): string {
  const wave = prd.runtime.currentHardeningWave + 1;
  return `[RALPHTHON_HARDENING_WAVE] wave=${wave} phase=hardening generate_or_update_prd`;
}

function promptForBootstrap(): string {
  return '[RALPHTHON_BOOTSTRAP] create_or_update_prd_and_emit_ready_marker';
}

function injectionStillFresh(runtime: RalphthonRuntimeState, nowMs: number, pollIntervalMs: number, injectionKey: string): boolean {
  if (runtime.lastInjectedTaskId !== injectionKey) return false;
  if (!runtime.lastInjectionAt) return false;
  const lastInjectionMs = Date.parse(runtime.lastInjectionAt);
  if (!Number.isFinite(lastInjectionMs)) return false;
  return nowMs - lastInjectionMs < pollIntervalMs;
}

function markTaskAsStalled(prd: RalphthonPrd, taskId: string, timestamp: string): RalphthonPrd {
  return markTaskStatus(prd, taskId, 'pending', {
    lastError: 'stalled-waiting-for-ralphthon-marker',
    timestamp,
  });
}

function applySubagentSnapshot(
  runtime: RalphthonRuntimeState,
  summary: SubagentSessionSummary | null,
  nowStamp: string,
): RalphthonRuntimeState {
  if (!summary) {
    return {
      ...runtime,
      subagentThreadIds: [],
      activeSubagentThreadIds: [],
      subagentWaitReason: undefined,
      subagentLastObservedAt: undefined,
      subagentSessionId: runtime.subagentSessionId,
      leaderThreadId: runtime.leaderThreadId,
    };
  }

  return {
    ...runtime,
    subagentSessionId: summary.sessionId,
    leaderThreadId: summary.leaderThreadId,
    subagentThreadIds: summary.allSubagentThreadIds,
    activeSubagentThreadIds: summary.activeSubagentThreadIds,
    subagentLastObservedAt: nowStamp,
    subagentWaitReason: summary.activeSubagentThreadIds.length > 0
      ? `waiting_for_${summary.activeSubagentThreadIds.length}_subagent_thread${summary.activeSubagentThreadIds.length === 1 ? '' : 's'}`
      : undefined,
  };
}

async function defaultReadPrd(): Promise<RalphthonPrd | null> {
  return readRalphthonPrd(process.cwd());
}

async function defaultReadRuntime(): Promise<RalphthonRuntimeState | null> {
  return readRalphthonRuntimeState(process.cwd());
}

async function defaultWritePrd(prd: RalphthonPrd): Promise<void> {
  await writeRalphthonPrd(process.cwd(), prd);
}

async function defaultWriteRuntime(runtime: RalphthonRuntimeState): Promise<void> {
  await writeRalphthonRuntimeState(process.cwd(), runtime);
}

export class RalphthonOrchestrator {
  private readonly deps: RalphthonOrchestratorDeps;

  constructor(deps: Partial<RalphthonOrchestratorDeps> = {}) {
    this.deps = {
      readPrd: deps.readPrd ?? defaultReadPrd,
      writePrd: deps.writePrd ?? defaultWritePrd,
      readRuntime: deps.readRuntime ?? defaultReadRuntime,
      writeRuntime: deps.writeRuntime ?? defaultWriteRuntime,
      capturePane: deps.capturePane ?? (async () => ''),
      injectPrompt: deps.injectPrompt ?? (async () => true),
      updateModeState: deps.updateModeState,
      alert: deps.alert,
      readSubagentSummary: deps.readSubagentSummary ?? (async (sessionId: string, now: Date) => readSubagentSessionSummary(process.cwd(), sessionId, { now })),
      now: deps.now ?? (() => new Date()),
    };
  }

  async tick(): Promise<RalphthonTickResult> {
    const now = this.deps.now ? this.deps.now() : new Date();
    const nowStamp = nowIso(now);
    const nowMs = now.getTime();
    let runtime = await this.deps.readRuntime();
    if (!runtime) {
      return { markerTypes: [], completed: false };
    }
    if (!runtime.leaderTarget) {
      runtime = {
        ...runtime,
        lastPollAt: nowStamp,
      };
      await this.deps.writeRuntime(runtime);
      return { markerTypes: [], completed: false };
    }

    const capture = await this.deps.capturePane(runtime.leaderTarget);
    const changedCapture = diffPaneCapture(runtime.lastCaptureText, capture);
    if (capture !== runtime.lastCaptureText) {
      runtime = {
        ...withPersistedCapture(runtime, capture),
        lastOutputChangeAt: nowStamp,
      };
    }

    const persistedSession = await readSessionState(process.cwd()).catch(() => null);
    const subagentSessionId = runtime.subagentSessionId?.trim() || persistedSession?.session_id?.trim() || '';
    const subagentSummary = subagentSessionId
      ? await this.deps.readSubagentSummary?.(subagentSessionId, now)
      : null;
    runtime = applySubagentSnapshot(runtime, subagentSummary ?? null, nowStamp);
    const hasActiveSubagents = runtime.activeSubagentThreadIds.length > 0;

    let prd = await this.deps.readPrd();
    const freshMarkers = parseRalphthonMarkers(changedCapture);

    for (const marker of freshMarkers) {
      if (!prd) continue;

      switch (marker.type) {
        case 'prd_ready':
          break;
        case 'task_start':
          prd = markTaskStatus(prd, marker.taskId, 'in_progress', { timestamp: nowStamp });
          runtime = {
            ...runtime,
            activeTaskId: marker.taskId,
          };
          break;
        case 'task_done':
          prd = markTaskStatus(prd, marker.taskId, 'done', { timestamp: nowStamp });
          runtime = {
            ...runtime,
            activeTaskId: runtime.activeTaskId === marker.taskId ? undefined : runtime.activeTaskId,
          };
          break;
        case 'task_failed': {
          const taskRef = findTaskRef(prd, marker.taskId);
          const maxRetries = prd.config.maxRetries;
          const nextRetryCount = (taskRef?.task.retries ?? 0) + 1;
          if (nextRetryCount >= maxRetries) {
            prd = markTaskStatus(prd, marker.taskId, 'failed', {
              incrementRetries: true,
              lastError: marker.reason,
              timestamp: nowStamp,
            });
            await this.deps.alert?.(`[ralphthon] task ${marker.taskId} failed ${nextRetryCount} times and was skipped.`);
          } else {
            prd = markTaskStatus(prd, marker.taskId, 'pending', {
              incrementRetries: true,
              lastError: marker.reason,
              timestamp: nowStamp,
            });
          }
          runtime = {
            ...runtime,
            activeTaskId: runtime.activeTaskId === marker.taskId ? undefined : runtime.activeTaskId,
          };
          break;
        }
        case 'hardening_generated':
          prd = recordHardeningWaveResult(prd, marker.count);
          runtime = {
            ...runtime,
            activeTaskId: undefined,
          };
          break;
      }
    }

    if (prd) {
      prd = ensureHardeningPhase(prd);
      if (shouldTerminateHardening(prd) && !hasActiveSubagents) {
        prd = completeRalphthonPrd(prd);
        await this.deps.writePrd(prd);
        await this.deps.writeRuntime({
          ...runtime,
          lastPollAt: nowStamp,
        });
        await this.deps.updateModeState?.({
          active: false,
          current_phase: 'complete',
          completed_at: nowStamp,
        });
        return {
          markerTypes: freshMarkers.map((marker) => marker.type),
          completed: true,
          phase: prd.phase,
        };
      }
    }

    const pollIntervalMs = (prd?.config.pollIntervalSec ?? 120) * 1000;
    const idleTimeoutMs = (prd?.config.idleTimeoutSec ?? 30) * 1000;
    const lastPollMs = runtime.lastPollAt ? Date.parse(runtime.lastPollAt) : 0;
    const lastOutputChangeMs = runtime.lastOutputChangeAt ? Date.parse(runtime.lastOutputChangeAt) : 0;
    const pollDue = !lastPollMs || nowMs - lastPollMs >= pollIntervalMs;
    const idleDue = !lastOutputChangeMs || nowMs - lastOutputChangeMs >= idleTimeoutMs;

    const waitingOnSubagents = (runtime.activeSubagentThreadIds?.length ?? 0) > 0;
    if (waitingOnSubagents) {
      runtime = {
        ...runtime,
        subagentWaitReason: `waiting_for_${runtime.activeSubagentThreadIds.length}_native_subagent_threads`,
      };
      await this.deps.writeRuntime({
        ...runtime,
        lastPollAt: nowStamp,
      });
      if (prd) {
        await this.deps.writePrd(prd);
        await this.deps.updateModeState?.({
          current_phase: prd.phase,
          active_native_subagent_threads: runtime.activeSubagentThreadIds,
          native_subagent_waiting: true,
        });
      }

      return {
        markerTypes: freshMarkers.map((marker) => marker.type),
        completed: false,
        phase: prd?.phase,
      };
    }

    runtime = {
      ...runtime,
      subagentWaitReason: undefined,
    };

    let injectedPrompt: string | undefined;
    if (idleDue || pollDue) {
      if (!prd) {
        const injectionKey = 'bootstrap';
        if (!injectionStillFresh(runtime, nowMs, pollIntervalMs, injectionKey)) {
          const nextPrompt = promptForBootstrap();
          const injected = await this.deps.injectPrompt(runtime.leaderTarget, nextPrompt);
          if (injected !== false) {
            injectedPrompt = nextPrompt;
            runtime = {
              ...runtime,
              lastInjectionAt: nowStamp,
              lastInjectedTaskId: injectionKey,
            };
          }
        }
      } else {
        let activeTask = runtime.activeTaskId ? findTaskRef(prd, runtime.activeTaskId) : null;
        const activeTaskStatus = activeTask?.task.status;
        const activeTaskId = activeTask?.task.id;
        const activeTaskHadFreshMarker = Boolean(
          activeTaskId
          && freshMarkers.some((marker) => 'taskId' in marker && marker.taskId === activeTaskId),
        );
        const activeTaskStalled = Boolean(
          activeTask
          && !hasActiveSubagents
          && !activeTaskHadFreshMarker
          && (activeTaskStatus === 'pending' || activeTaskStatus === 'in_progress')
          && !injectionStillFresh(runtime, nowMs, pollIntervalMs, activeTaskId || ''),
        );

        if (activeTask && activeTaskStalled) {
          prd = markTaskAsStalled(prd, activeTask.task.id, nowStamp);
          activeTask = findTaskRef(prd, activeTask.task.id);
          runtime = {
            ...runtime,
            activeTaskId: undefined,
          };
        }

        if (!hasActiveSubagents && (!activeTask || activeTask.task.status === 'done' || activeTask.task.status === 'failed' || activeTaskStalled)) {
          const nextTask = nextPendingTask(prd);
          if (nextTask) {
            if (!injectionStillFresh(runtime, nowMs, pollIntervalMs, nextTask.task.id)) {
              const nextPrompt = promptForTask(nextTask, prd);
              const injected = await this.deps.injectPrompt(runtime.leaderTarget, nextPrompt);
              if (injected !== false) {
                injectedPrompt = nextPrompt;
                runtime = {
                  ...runtime,
                  activeTaskId: nextTask.task.id,
                  lastInjectionAt: nowStamp,
                  lastInjectedTaskId: nextTask.task.id,
                };
              }
            }
          } else if (prd.phase === 'hardening') {
            const injectionKey = `hardening-wave-${prd.runtime.currentHardeningWave + 1}`;
            if (!injectionStillFresh(runtime, nowMs, pollIntervalMs, injectionKey)) {
              const nextPrompt = promptForHardeningWave(prd);
              const injected = await this.deps.injectPrompt(runtime.leaderTarget, nextPrompt);
              if (injected !== false) {
                injectedPrompt = nextPrompt;
                runtime = {
                  ...runtime,
                  activeTaskId: undefined,
                  lastInjectionAt: nowStamp,
                  lastInjectedTaskId: injectionKey,
                };
              }
            }
          }
        }
      }
    }

    runtime = {
      ...runtime,
      lastPollAt: nowStamp,
    };
    await this.deps.writeRuntime(runtime);
    if (prd) {
      await this.deps.writePrd(prd);
      await this.deps.updateModeState?.({ current_phase: prd.phase, active_native_subagent_threads: runtime.activeSubagentThreadIds ?? [], native_subagent_waiting: false });
    }

    return {
      markerTypes: freshMarkers.map((marker) => marker.type),
      completed: false,
      phase: prd?.phase,
      injectedPrompt,
    };
  }
}
