#!/usr/bin/env node

import { existsSync } from 'fs';
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { drainPendingTeamDispatch } from './notify-hook/team-dispatch.js';
import { resolveNudgePaneTarget } from './notify-hook/auto-nudge.js';
import { checkPaneReadyForTeamSendKeys } from './notify-hook/team-tmux-guard.js';
import {
  isLeaderStale,
  maybeNudgeTeamLeader,
  resolveLeaderStalenessThresholdMs,
} from './notify-hook/team-leader-nudge.js';
import { DEFAULT_MARKER } from './tmux-hook-engine.js';

function argValue(name: string, fallback = ''): string {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function asNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseIsoMillis(value: string | null | undefined): number | null {
  const parsed = Date.parse(safeString(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid: number, timeoutMs = 3000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(stepMs);
  }
  return !isPidAlive(pid);
}

const cwd = resolve(argValue('--cwd', process.cwd()));
const notifyScript = resolve(argValue('--notify-script', join(cwd, 'dist', 'scripts', 'notify-hook.js')));
const runOnce = process.argv.includes('--once');
// Keep fallback control-plane ticks comfortably below the default dispatch
// ack budget so leaderless team dispatch + stale-alert recovery do not feel
// laggy between native notify-hook turns.
const pollMs = Math.max(50, asNumber(argValue('--poll-ms', '250'), 250));
const parentPid = Math.trunc(asNumber(argValue('--parent-pid', String(process.ppid || 0)), process.ppid || 0));
const startedAt = Date.now();
const fileWindowMs = runOnce ? 15000 : 30000;
const defaultMaxLifetimeMs = 6 * 60 * 60 * 1000;
const maxLifetimeMs = runOnce
  ? 0
  : Math.max(
    pollMs,
    asNumber(
      argValue('--max-lifetime-ms', process.env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS || String(defaultMaxLifetimeMs)),
      defaultMaxLifetimeMs
    )
  );

const omxDir = join(cwd, '.omx');
const logsDir = join(omxDir, 'logs');
const stateDir = join(omxDir, 'state');
const statePath = join(stateDir, 'notify-fallback-state.json');
const pidFilePath = resolve(argValue('--pid-file', join(stateDir, 'notify-fallback.pid')));
const logPath = join(logsDir, `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
const RALPH_CONTINUE_TEXT = 'Ralph loop active continue';
const RALPH_CONTINUE_CADENCE_MS = 60_000;
const RALPH_TERMINAL_PHASES = new Set(['complete', 'failed', 'cancelled']);

interface WatcherFileMeta {
  threadId: string;
  offset: number;
  size: number;
  partial: string;
}

interface RalphContinueSteerState {
  enabled: boolean;
  cadence_ms: number;
  message: string;
  active: boolean;
  last_state_check_at: string | null;
  last_sent_at: string;
  cooldown_anchor_at: string;
  last_reason: string;
  last_error: string | null;
  state_path: string;
  pane_id: string;
  pane_current_command: string;
  current_phase: string;
}

interface DispatchDrainState {
  leader_only: boolean;
  last_tick_at: string | null;
  last_result: unknown;
  last_error: string | null;
}

interface LeaderNudgeState {
  enabled: boolean;
  leader_only: boolean;
  stale_threshold_ms: number | null;
  precomputed_leader_stale: boolean | null;
  last_tick_at: string | null;
  last_error: string | null;
}

interface ParentGuardState {
  reason: string;
  state_path: string;
  current_phase: string;
}

const fileState = new Map<string, WatcherFileMeta>();
const seenTurnKeys = new Set<string>();
let stopping = false;
let shutdownPromise: Promise<void> | null = null;
const dispatchTickMax = Math.max(1, asNumber(argValue('--dispatch-max-per-tick', '5'), 5));
let dispatchDrainRuns = 0;
let lastDispatchDrain: DispatchDrainState = {
  leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
  last_tick_at: null,
  last_result: null,
  last_error: null,
};
let leaderNudgeRuns = 0;
let lastLeaderNudge: LeaderNudgeState = {
  enabled: true,
  leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
  stale_threshold_ms: null,
  precomputed_leader_stale: null,
  last_tick_at: null,
  last_error: null,
};
let lastRalphContinueSteer: RalphContinueSteerState = {
  enabled: true,
  cadence_ms: RALPH_CONTINUE_CADENCE_MS,
  message: RALPH_CONTINUE_TEXT,
  active: false,
  last_state_check_at: null,
  last_sent_at: '',
  cooldown_anchor_at: '',
  last_reason: 'init',
  last_error: null,
  state_path: '',
  pane_id: '',
  pane_current_command: '',
  current_phase: '',
};
let lastParentGuard: ParentGuardState = {
  reason: '',
  state_path: '',
  current_phase: '',
};
function eventLog(event: Record<string, unknown>): Promise<void> {
  return appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`).catch(() => {});
}

function normalizeRalphContinueSteerState(raw: Record<string, unknown> | null | undefined): RalphContinueSteerState {
  if (!raw || typeof raw !== 'object') return { ...lastRalphContinueSteer };
  return {
    enabled: raw.enabled !== false,
    cadence_ms: Number.isFinite(raw.cadence_ms) && (raw.cadence_ms as number) > 0 ? raw.cadence_ms as number : RALPH_CONTINUE_CADENCE_MS,
    message: safeString(raw.message) || RALPH_CONTINUE_TEXT,
    active: raw.active === true,
    last_state_check_at: safeString(raw.last_state_check_at) || null,
    last_sent_at: safeString(raw.last_sent_at),
    cooldown_anchor_at: safeString(raw.cooldown_anchor_at),
    last_reason: safeString(raw.last_reason) || 'init',
    last_error: safeString(raw.last_error) || null,
    state_path: safeString(raw.state_path),
    pane_id: safeString(raw.pane_id),
    pane_current_command: safeString(raw.pane_current_command),
    current_phase: safeString(raw.current_phase),
  };
}

function hasRalphTerminalState(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw || typeof raw !== 'object') return true;
  if (raw.active !== true) return true;
  const phase = safeString(raw.current_phase).trim().toLowerCase();
  if (phase && RALPH_TERMINAL_PHASES.has(phase)) return true;
  if (safeString(raw.completed_at).trim()) return true;
  return false;
}

async function loadPersistedWatcherState(): Promise<void> {
  const persisted = await readFile(statePath, 'utf-8')
    .then((content) => JSON.parse(content) as Record<string, unknown>)
    .catch(() => null);
  lastRalphContinueSteer = normalizeRalphContinueSteerState(persisted?.ralph_continue_steer as Record<string, unknown> | null | undefined);
}

interface ActiveModeResult {
  active: boolean;
  reason: string;
  path: string;
  state: Record<string, unknown> | null;
}

async function resolveActiveModeState(mode: string): Promise<ActiveModeResult> {
  const candidateDirs: string[] = [];
  const sessionPath = join(stateDir, 'session.json');
  try {
    const session = JSON.parse(await readFile(sessionPath, 'utf-8')) as Record<string, unknown>;
    const sessionId = safeString(session?.session_id).trim();
    if (sessionId) {
      candidateDirs.push(join(stateDir, 'sessions', sessionId));
    }
  } catch {
    // No active session file; fall back to root state only.
  }
  if (!candidateDirs.includes(stateDir)) candidateDirs.push(stateDir);

  for (const dir of candidateDirs) {
    const path = join(dir, `${mode}-state.json`);
    if (!existsSync(path)) continue;
    const parsed = await readFile(path, 'utf-8')
      .then((content) => JSON.parse(content) as Record<string, unknown>)
      .catch(() => null);
    if (!parsed || typeof parsed !== 'object') continue;
    if (hasRalphTerminalState(parsed)) {
      return {
        active: false,
        reason: 'terminal',
        path,
        state: parsed,
      };
    }
    return {
      active: true,
      reason: 'active',
      path,
      state: parsed,
    };
  }

  return {
    active: false,
    reason: 'cleared',
    path: '',
    state: null,
  };
}

async function resolveActiveRalphState(): Promise<ActiveModeResult> {
  return resolveActiveModeState('ralph');
}

async function emitRalphContinueSteer(paneId: string, message: string): Promise<void> {
  const markedText = `${message} ${DEFAULT_MARKER}`;
  await new Promise<void>((resolve) => {
    const typed = spawnSync('tmux', ['send-keys', '-t', paneId, '-l', markedText], { encoding: 'utf-8' });
    if (typed.status !== 0) throw new Error((typed.stderr || typed.stdout || '').trim() || 'tmux send-keys failed');
    setTimeout(resolve, 100);
  });
  await new Promise<void>((resolve) => {
    const submitA = spawnSync('tmux', ['send-keys', '-t', paneId, 'C-m'], { encoding: 'utf-8' });
    if (submitA.status !== 0) throw new Error((submitA.stderr || submitA.stdout || '').trim() || 'tmux send-keys C-m failed');
    setTimeout(resolve, 100);
  });
  const submitB = spawnSync('tmux', ['send-keys', '-t', paneId, 'C-m'], { encoding: 'utf-8' });
  if (submitB.status !== 0) {
    throw new Error((submitB.stderr || submitB.stdout || '').trim() || 'tmux send-keys C-m failed');
  }
}

async function runRalphContinueSteerTick(): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const startupIso = new Date(startedAt).toISOString();
  const activeRalph = await resolveActiveRalphState();
  lastRalphContinueSteer = {
    ...lastRalphContinueSteer,
    active: activeRalph.active,
    current_phase: safeString(activeRalph.state?.current_phase),
    last_state_check_at: nowIso,
    last_reason: activeRalph.reason,
    last_error: null,
    state_path: activeRalph.path,
    pane_current_command: '',
  };

  if (!activeRalph.active) return;

  const lastSentMs = parseIsoMillis(lastRalphContinueSteer.last_sent_at);
  const startupAnchorMs = parseIsoMillis(lastRalphContinueSteer.cooldown_anchor_at);
  if (lastSentMs === null && startupAnchorMs === null) {
    lastRalphContinueSteer.cooldown_anchor_at = startupIso;
  }
  const cooldownAnchorMs = lastSentMs ?? startupAnchorMs ?? startedAt;
  if (now - cooldownAnchorMs < RALPH_CONTINUE_CADENCE_MS) {
    lastRalphContinueSteer.last_reason = lastSentMs === null ? 'startup_cooldown' : 'cooldown';
    return;
  }

  const paneId = safeString(activeRalph.state?.tmux_pane_id).trim() || await resolveNudgePaneTarget(stateDir);
  if (!paneId) {
    lastRalphContinueSteer.last_reason = 'pane_missing';
    lastRalphContinueSteer.pane_id = '';
    return;
  }

  const paneGuard = await checkPaneReadyForTeamSendKeys(paneId);
  lastRalphContinueSteer.pane_id = paneId;
  lastRalphContinueSteer.pane_current_command = paneGuard.paneCurrentCommand || '';
  if (!paneGuard.ok) {
    lastRalphContinueSteer.last_reason = paneGuard.reason || 'pane_guard_blocked';
    return;
  }

  await emitRalphContinueSteer(paneId, RALPH_CONTINUE_TEXT);
  lastRalphContinueSteer.last_sent_at = nowIso;
  lastRalphContinueSteer.cooldown_anchor_at = nowIso;
  lastRalphContinueSteer.last_reason = 'sent';
  await eventLog({
    type: 'ralph_continue_steer',
    reason: 'sent',
    pane_id: paneId,
    state_path: activeRalph.path,
    current_phase: safeString(activeRalph.state?.current_phase) || null,
    cadence_ms: RALPH_CONTINUE_CADENCE_MS,
    message: RALPH_CONTINUE_TEXT,
  });
}

async function runRalphWatcherBehaviorTick(): Promise<void> {
  try {
    await runRalphContinueSteerTick();
  } catch (error) {
    const message = error instanceof Error ? error.message : safeString(error);
    lastRalphContinueSteer = {
      ...lastRalphContinueSteer,
      last_reason: 'send_failed',
      last_error: message || 'unknown_error',
    };
    await eventLog({
      type: 'ralph_continue_steer',
      reason: 'send_failed',
      pane_id: lastRalphContinueSteer.pane_id || null,
      state_path: lastRalphContinueSteer.state_path || null,
      current_phase: lastRalphContinueSteer.current_phase || null,
      error: lastRalphContinueSteer.last_error,
    });
  }
}

async function readPidFilePid(path: string): Promise<number | null> {
  const raw = await readFile(path, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Number.isFinite(parsed.pid) && (parsed.pid as number) > 0 ? parsed.pid as number : null;
  } catch {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
}

async function registerPidFile(): Promise<void> {
  if (runOnce) return;
  await mkdir(dirname(pidFilePath), { recursive: true }).catch(() => {});

  const existingPid = await readPidFilePid(pidFilePath).catch(() => null);
  if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
    try {
      process.kill(existingPid, 'SIGTERM');
      const exitedGracefully = await waitForPidExit(existingPid);
      let forced = false;
      if (!exitedGracefully && isPidAlive(existingPid)) {
        forced = true;
        process.kill(existingPid, 'SIGKILL');
        await waitForPidExit(existingPid, 1000, 25);
      }
      await eventLog({
        type: 'watcher_stale_pid_reaped',
        stale_pid: existingPid,
        pid_file: pidFilePath,
        forced,
      });
    } catch (error) {
      await eventLog({
        type: 'watcher_stale_pid_reap_failed',
        stale_pid: existingPid,
        pid_file: pidFilePath,
        error: error instanceof Error ? error.message : safeString(error),
      });
    }
  }

  await writeFile(pidFilePath, JSON.stringify({
    pid: process.pid,
    parent_pid: parentPid,
    cwd,
    started_at: new Date(startedAt).toISOString(),
    max_lifetime_ms: maxLifetimeMs,
  }, null, 2)).catch(() => {});
}

async function removePidFileIfOwned(): Promise<void> {
  if (runOnce) return;
  const existingPid = await readPidFilePid(pidFilePath).catch(() => null);
  if (existingPid !== process.pid) return;
  await unlink(pidFilePath).catch(() => {});
}

function parentIsGone(): boolean {
  if (!Number.isFinite(parentPid) || parentPid <= 0) return false;
  if (parentPid === process.pid) return false;
  return !isPidAlive(parentPid);
}

async function writeState(extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  const state = {
    pid: process.pid,
    parent_pid: parentPid,
    started_at: new Date(startedAt).toISOString(),
    cwd,
    notify_script: notifyScript,
    poll_ms: pollMs,
    pid_file: runOnce ? null : pidFilePath,
    max_lifetime_ms: maxLifetimeMs,
    tracked_files: fileState.size,
    seen_turns: seenTurnKeys.size,
    dispatch_drain: {
      enabled: true,
      max_per_tick: dispatchTickMax,
      run_count: dispatchDrainRuns,
      ...lastDispatchDrain,
    },
    leader_nudge: {
      ...lastLeaderNudge,
      enabled: true,
      run_count: leaderNudgeRuns,
    },
    ralph_continue_steer: {
      ...lastRalphContinueSteer,
      enabled: true,
      cadence_ms: RALPH_CONTINUE_CADENCE_MS,
      message: RALPH_CONTINUE_TEXT,
    },
    ...extra,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2)).catch(() => {});
}

async function requestShutdown(reason: string, signal: string | null = null): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    await writeState({ stop_reason: reason, stop_signal: signal, stopping: true });
    await eventLog({
      type: 'watcher_stop',
      signal,
      reason,
      parent_pid: parentPid,
      pid_file: runOnce ? null : pidFilePath,
    });
    await removePidFileIfOwned();
    process.exit(0);
  })();
  return shutdownPromise;
}

async function enforceLifecycleGuards(): Promise<boolean> {
  if (runOnce) return false;
  if (parentIsGone()) {
    const activeRalph = await resolveActiveRalphState();
    if (activeRalph.active) {
      const currentPhase = safeString(activeRalph.state?.current_phase);
      const nextParentGuard: ParentGuardState = {
        reason: 'parent_gone_deferred_for_active_ralph',
        state_path: activeRalph.path,
        current_phase: currentPhase,
      };
      if (
        lastParentGuard.reason !== nextParentGuard.reason
        || lastParentGuard.state_path !== nextParentGuard.state_path
        || lastParentGuard.current_phase !== nextParentGuard.current_phase
      ) {
        await eventLog({
          type: 'watcher_parent_guard',
          reason: nextParentGuard.reason,
          state_path: nextParentGuard.state_path,
          current_phase: currentPhase || null,
        });
        lastParentGuard = nextParentGuard;
      }
      return false;
    }
    lastParentGuard = { reason: '', state_path: '', current_phase: '' };
    await requestShutdown('parent_gone');
    return true;
  }
  if (maxLifetimeMs > 0 && Date.now() - startedAt >= maxLifetimeMs) {
    await requestShutdown('max_lifetime_exceeded');
    return true;
  }
  return false;
}

function sessionDirs(): string[] {
  const now = new Date();
  const today = join(
    homedir(),
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  );
  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = join(
    homedir(),
    '.codex',
    'sessions',
    String(yesterdayDate.getUTCFullYear()),
    String(yesterdayDate.getUTCMonth() + 1).padStart(2, '0'),
    String(yesterdayDate.getUTCDate()).padStart(2, '0')
  );
  return Array.from(new Set([today, yesterday]));
}

async function readFirstLine(path: string): Promise<string> {
  const content = await readFile(path, 'utf-8');
  const idx = content.indexOf('\n');
  return idx >= 0 ? content.slice(0, idx) : content;
}

function shouldTrackSessionMeta(line: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || parsed.type !== 'session_meta' || !parsed.payload) return null;
  const payload = parsed.payload as Record<string, unknown>;
  if (safeString(payload.cwd) !== cwd) return null;
  const threadId = safeString(payload.id);
  return threadId || null;
}

async function discoverRolloutFiles(): Promise<string[]> {
  const discovered: string[] = [];
  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < startedAt - fileWindowMs) continue;
      discovered.push(path);
    }
  }
  discovered.sort();
  return discovered;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId || 'no-thread'}|${turnId || 'no-turn'}`;
}

function buildNotifyPayload(threadId: string, turnId: string, lastMessage: string): Record<string, unknown> {
  return {
    type: 'agent-turn-complete',
    cwd,
    'thread-id': threadId,
    'turn-id': turnId,
    'input-messages': ['[notify-fallback] synthesized from rollout task_complete'],
    'last-assistant-message': lastMessage || '',
    source: 'notify-fallback-watcher',
  };
}

async function invokeNotifyHook(payload: Record<string, unknown>, filePath: string): Promise<void> {
  const result = spawnSync(process.execPath, [notifyScript, JSON.stringify(payload)], {
    cwd,
    encoding: 'utf-8',
  });
  const ok = result.status === 0;
  await eventLog({
    type: 'fallback_notify',
    ok,
    thread_id: (payload as Record<string, string>)['thread-id'],
    turn_id: (payload as Record<string, string>)['turn-id'],
    file: filePath,
    reason: ok ? 'sent' : 'notify_hook_failed',
    error: ok ? undefined : (result.stderr || result.stdout || '').trim().slice(0, 240),
  });
}

async function processLine(meta: WatcherFileMeta, line: string, filePath: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (!parsed || parsed.type !== 'event_msg' || !parsed.payload) return;
  if ((parsed.payload as Record<string, unknown>).type !== 'task_complete') return;

  const turnId = safeString((parsed.payload as Record<string, unknown>).turn_id);
  if (!turnId) return;

  const evtTs = Date.parse(safeString(parsed.timestamp));
  if (Number.isFinite(evtTs) && evtTs < startedAt - 3000) return;

  const key = turnKey(meta.threadId, turnId);
  if (seenTurnKeys.has(key)) return;
  seenTurnKeys.add(key);

  const payload = buildNotifyPayload(
    meta.threadId,
    turnId,
    safeString((parsed.payload as Record<string, unknown>).last_agent_message)
  );
  await invokeNotifyHook(payload, filePath);
}

async function ensureTrackedFiles(): Promise<void> {
  const files = await discoverRolloutFiles();
  for (const path of files) {
    if (fileState.has(path)) continue;
    const line = await readFirstLine(path).catch(() => '');
    const threadId = shouldTrackSessionMeta(line);
    if (!threadId) continue;
    const size = (await stat(path).catch(() => ({ size: 0 }))).size || 0;
    const offset = runOnce ? 0 : size;
    fileState.set(path, { threadId, offset, size, partial: '' });
  }
}

async function pollFiles(): Promise<void> {
  for (const [path, meta] of fileState.entries()) {
    const currentSize = (await stat(path).catch(() => ({ size: 0 }))).size || 0;
    if (currentSize <= meta.offset) continue;
    const content = await readFile(path, 'utf-8').catch(() => '');
    if (!content) continue;
    const delta = content.slice(meta.offset);
    meta.offset = currentSize;
    const merged = meta.partial + delta;
    const lines = merged.split('\n');
    meta.partial = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      await processLine(meta, line, path);
    }
  }
}

async function runLeaderNudgeTick(): Promise<void> {
  const startedIso = new Date().toISOString();
  const leaderOnly = safeString(process.env.OMX_TEAM_WORKER || '').trim() === '';
  const staleThresholdMs = resolveLeaderStalenessThresholdMs();

  if (!leaderOnly) {
    leaderNudgeRuns += 1;
    lastLeaderNudge = {
      enabled: true,
      leader_only: false,
      stale_threshold_ms: staleThresholdMs,
      precomputed_leader_stale: null,
      last_tick_at: startedIso,
      last_error: 'worker_context',
    };
    await eventLog({
      type: 'leader_nudge_tick',
      leader_only: false,
      run_count: leaderNudgeRuns,
      reason: 'worker_context',
      stale_threshold_ms: staleThresholdMs,
    });
    return;
  }

  try {
    const preComputedLeaderStale = await isLeaderStale(stateDir, staleThresholdMs, Date.now());
    await maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale });
    leaderNudgeRuns += 1;
    lastLeaderNudge = {
      enabled: true,
      leader_only: true,
      stale_threshold_ms: staleThresholdMs,
      precomputed_leader_stale: preComputedLeaderStale,
      last_tick_at: startedIso,
      last_error: null,
    };
    await eventLog({
      type: 'leader_nudge_tick',
      leader_only: true,
      run_count: leaderNudgeRuns,
      stale_threshold_ms: staleThresholdMs,
      precomputed_leader_stale: preComputedLeaderStale,
      reason: 'leader_nudge_checked',
    });
  } catch (err) {
    leaderNudgeRuns += 1;
    lastLeaderNudge = {
      enabled: true,
      leader_only: true,
      stale_threshold_ms: staleThresholdMs,
      precomputed_leader_stale: null,
      last_tick_at: startedIso,
      last_error: err instanceof Error ? err.message : safeString(err),
    };
    await eventLog({
      type: 'leader_nudge_tick',
      leader_only: true,
      run_count: leaderNudgeRuns,
      stale_threshold_ms: staleThresholdMs,
      reason: 'leader_nudge_failed',
      error: lastLeaderNudge.last_error,
    });
  }
}

async function runDispatchDrainTick(): Promise<void> {
  const startedIso = new Date().toISOString();
  try {
    const result = await drainPendingTeamDispatch({ cwd, stateDir, logsDir, maxPerTick: dispatchTickMax } as any);
    dispatchDrainRuns += 1;
    lastDispatchDrain = {
      leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
      last_tick_at: startedIso,
      last_result: result,
      last_error: null,
    };
    await eventLog({
      type: 'dispatch_drain_tick',
      leader_only: lastDispatchDrain.leader_only,
      dispatch_max_per_tick: dispatchTickMax,
      run_count: dispatchDrainRuns,
      ...(result && typeof result === 'object' ? result as Record<string, unknown> : {}),
    });
  } catch (err) {
    dispatchDrainRuns += 1;
    lastDispatchDrain = {
      leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
      last_tick_at: startedIso,
      last_result: null,
      last_error: err instanceof Error ? err.message : safeString(err),
    };
    await eventLog({
      type: 'dispatch_drain_tick',
      leader_only: lastDispatchDrain.leader_only,
      dispatch_max_per_tick: dispatchTickMax,
      run_count: dispatchDrainRuns,
      reason: 'dispatch_drain_failed',
      error: lastDispatchDrain.last_error,
    });
  }
}

async function pumpTeamControlPlaneTick(): Promise<void> {
  await runDispatchDrainTick();
  await runLeaderNudgeTick();
}


async function runWatcherCycle(): Promise<void> {
  await ensureTrackedFiles();
  await pollFiles();
  await pumpTeamControlPlaneTick();
  await runRalphWatcherBehaviorTick();
  await writeState();
}

async function tick(): Promise<void> {
  if (stopping) return;
  if (await enforceLifecycleGuards()) return;
  await runWatcherCycle();
  if (await enforceLifecycleGuards()) return;
  setTimeout(() => {
    void tick();
  }, pollMs);
}

function shutdown(signal: string): void {
  void requestShutdown('signal', signal);
}

async function main(): Promise<void> {
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  if (!existsSync(notifyScript)) {
    await eventLog({ type: 'watcher_error', reason: 'notify_script_missing', notify_script: notifyScript });
    process.exit(1);
  }

  await registerPidFile();
  await loadPersistedWatcherState();
  await eventLog({
    type: 'watcher_start',
    cwd,
    notify_script: notifyScript,
    poll_ms: pollMs,
    once: runOnce,
    parent_pid: parentPid,
    pid_file: runOnce ? null : pidFilePath,
    max_lifetime_ms: maxLifetimeMs,
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  if (await enforceLifecycleGuards()) return;

  if (runOnce) {
    await runWatcherCycle();
    await eventLog({ type: 'watcher_once_complete', seen_turns: seenTurnKeys.size });
    process.exit(0);
  }

  await tick();
}

main().catch(async (err) => {
  await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  await eventLog({
    type: 'watcher_error',
    reason: 'fatal',
    error: err instanceof Error ? err.message : safeString(err),
  });
  process.exit(1);
});
