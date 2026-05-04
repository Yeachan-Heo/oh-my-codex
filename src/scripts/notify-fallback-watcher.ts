#!/usr/bin/env node

import { existsSync } from 'fs';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { StringDecoder } from 'string_decoder';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import { drainPendingTeamDispatch } from './notify-hook/team-dispatch.js';
import {
  maybeAutoNudge,
  isDeepInterviewInputLockActive,
  isDeepInterviewStateActive,
  loadAutoNudgeConfig,
  normalizeAutoNudgeSignatureText,
  resolveAutoNudgeSignature,
} from './notify-hook/auto-nudge.js';
import {
  readScopedJsonIfExists,
} from './notify-hook/state-io.js';
import { checkPaneReadyForTeamSendKeys } from './notify-hook/team-tmux-guard.js';
import {
  checkWorkerPanesAlive,
  isLeaderStale,
  maybeNudgeTeamLeader,
  resolveLeaderStalenessThresholdMs,
} from './notify-hook/team-leader-nudge.js';
import { resolveManagedPaneFromAnchor, resolveManagedSessionPane } from './notify-hook/managed-tmux.js';
import { DEFAULT_MARKER } from './tmux-hook-engine.js';
import { isTerminalPhase } from './notify-hook/utils.js';
import { isSessionStale, isSessionStateAuthoritativeForCwd, readSessionState } from '../hooks/session.js';
import {
  DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS,
  readSubagentSessionSummary,
} from '../subagents/tracker.js';
import { listNotifyCanonicalActiveTeams } from './notify-hook/active-team.js';
import { sameFilePath } from '../utils/paths.js';
import { validateSessionId } from '../mcp/state-paths.js';
import { TEAM_NAME_SAFE_PATTERN } from '../team/contracts.js';
import { shouldContinueRun } from '../runtime/run-loop.js';

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

function normalizeValidSessionId(value: unknown): string {
  const trimmed = safeString(value).trim();
  if (!trimmed) return '';
  try {
    return validateSessionId(trimmed) ?? '';
  } catch {
    return '';
  }
}

function normalizeValidTeamName(value: unknown): string {
  const trimmed = safeString(value).trim();
  return TEAM_NAME_SAFE_PATTERN.test(trimmed) ? trimmed : '';
}

function parsePositivePid(value: unknown): number | null {
  const pid = Math.trunc(asNumber(value as string | number | undefined, 0));
  return pid > 0 ? pid : null;
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

let atomicJsonWriteCounter = 0;

async function writeJsonObjectAtomically(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${++atomicJsonWriteCounter}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2));
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
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
const authorityOnly = process.argv.includes('--authority-only');
// Keep fallback control-plane ticks comfortably below the default dispatch
// ack budget so leaderless team dispatch + stale-alert recovery do not feel
// laggy between native notify-hook turns.
const pollMs = Math.max(50, asNumber(argValue('--poll-ms', '250'), 250));
const idleMaxPollMs = Math.max(
  pollMs,
  asNumber(argValue('--idle-max-poll-ms', process.env.OMX_NOTIFY_FALLBACK_IDLE_MAX_POLL_MS || '1000'), 1000),
);
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

const runtimeRoot = resolve(process.env.OMX_ROOT || process.env.OMX_STATE_ROOT || cwd);
const omxDir = join(runtimeRoot, '.omx');
const logsDir = join(omxDir, 'logs');
const stateDir = join(omxDir, 'state');
const statePath = join(stateDir, 'notify-fallback-state.json');
const pidFilePath = resolve(argValue('--pid-file', join(stateDir, 'notify-fallback.pid')));
const logPath = join(logsDir, `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
const logRotatePath = `${logPath}.1`;
const logLockPath = `${logPath}.lock`;
const defaultMaxLogBytes = 10 * 1024 * 1024;
const maxLogBytes = Math.max(
  0,
  asNumber(argValue('--log-max-bytes', process.env.OMX_NOTIFY_FALLBACK_LOG_MAX_BYTES || String(defaultMaxLogBytes)), defaultMaxLogBytes),
);
const ralphSteerTimestampPath = join(stateDir, 'ralph-last-steer-at');
const ralphSteerLockPath = join(stateDir, 'ralph-continue-steer.lock');
const watcherOwnerToken = `${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
const RALPH_CONTINUE_TEXT = 'Ralph loop active continue';
const RALPH_CONTINUE_CADENCE_MS = 60_000;
const RALPH_STEER_LOCK_STALE_MS = 30_000;
const RALPH_TERMINAL_PHASES = new Set(['blocked_on_user', 'complete', 'failed', 'cancelled']);
const RALPH_STARTING_PHASE_TIMEOUT_MS = RALPH_CONTINUE_CADENCE_MS * 2;
const QUIET_ONCE_EVENT_TYPES = new Set(['watcher_start', 'watcher_once_complete']);

interface WatcherFileMeta {
  threadId: string;
  offset: number;
  size: number;
  partial: string;
  decoder: StringDecoder;
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
  subagent_session_id: string;
  active_subagent_thread_ids: string[];
  shared_timestamp_path: string;
  shared_last_sent_at: string;
  singleton_lock_path: string;
}

interface PidFileRecord {
  pid: number;
  parent_pid?: number;
  cwd?: string;
  started_at?: string;
  max_lifetime_ms?: number;
  owner_token?: string;
}

interface RalphSteerLockRecord {
  pid: number;
  acquired_at: string;
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
  team_name?: string;
  pane_count?: number;
}

interface AuthorityBackoffState {
  active: boolean;
  reason: string;
  primary_pid: number | null;
  primary_last_tick_at: string;
  freshness_ms: number | null;
  threshold_ms: number | null;
}

interface ActiveTeamResult {
  active: boolean;
  reason: string;
  path: string;
  state: Record<string, unknown> | null;
  team_name: string;
  pane_count: number;
}

interface FallbackAutoNudgeState {
  enabled: boolean;
  stall_ms: number;
  last_tick_at: string | null;
  last_turn_at: string;
  last_turn_count: number | null;
  last_message: string;
  last_reason: string;
  last_error: string | null;
  last_nudged_signature: string;
  last_nudged_at: string;
}

interface AdaptivePollState {
  enabled: boolean;
  base_ms: number;
  max_ms: number;
  current_ms: number;
  idle_streak: number;
  last_tick_at: string | null;
  last_activity_at: string | null;
  last_activity_reason: string;
}

interface CycleActivitySummary {
  active: boolean;
  reason: string;
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
  subagent_session_id: '',
  active_subagent_thread_ids: [],
  shared_timestamp_path: ralphSteerTimestampPath,
  shared_last_sent_at: '',
  singleton_lock_path: ralphSteerLockPath,
};
let lastParentGuard: ParentGuardState = {
  reason: '',
  state_path: '',
  current_phase: '',
};
let lastAuthorityBackoff: AuthorityBackoffState = {
  active: false,
  reason: '',
  primary_pid: null,
  primary_last_tick_at: '',
  freshness_ms: null,
  threshold_ms: null,
};
const AUTO_NUDGE_STALL_MS = Math.max(
  pollMs,
  asNumber(process.env.OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS || '5000', 5000),
);
let lastFallbackAutoNudge: FallbackAutoNudgeState = {
  enabled: true,
  stall_ms: AUTO_NUDGE_STALL_MS,
  last_tick_at: null,
  last_turn_at: '',
  last_turn_count: null,
  last_message: '',
  last_reason: 'init',
  last_error: null,
  last_nudged_signature: '',
  last_nudged_at: '',
};
let adaptivePollState: AdaptivePollState = {
  enabled: true,
  base_ms: pollMs,
  max_ms: idleMaxPollMs,
  current_ms: pollMs,
  idle_streak: 0,
  last_tick_at: null,
  last_activity_at: null,
  last_activity_reason: 'init',
};

function shouldSuppressEventLog(event: Record<string, unknown>): boolean {
  const eventType = safeString(event.type).trim();
  return runOnce && QUIET_ONCE_EVENT_TYPES.has(eventType);
}

async function acquireLogLock(timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await mkdir(logLockPath, { recursive: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') return false;
      const lockStat = await stat(logLockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 5000) {
        await rm(logLockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(10);
    }
  }
  return false;
}

async function releaseLogLock(): Promise<void> {
  await rm(logLockPath, { recursive: true, force: true }).catch(() => {});
}

async function rotateLogIfNeeded(nextEntryBytes: number): Promise<void> {
  if (maxLogBytes <= 0) return;
  const currentStat = await stat(logPath).catch(() => null);
  if (!currentStat || currentStat.size + nextEntryBytes <= maxLogBytes) return;
  await unlink(logRotatePath).catch(() => {});
  await rename(logPath, logRotatePath).catch(() => {});
}

async function eventLog(event: Record<string, unknown>): Promise<void> {
  if (shouldSuppressEventLog(event)) return;
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
  await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  const locked = await acquireLogLock();
  if (!locked) return;
  try {
    await rotateLogIfNeeded(Buffer.byteLength(line));
    await appendFile(logPath, line);
  } catch {
    // best effort only
  } finally {
    await releaseLogLock();
  }
}

function shouldLogLeaderNudgeTick(reason: string): boolean {
  return reason === 'leader_nudge_checked' || reason === 'leader_nudge_failed';
}

function nextIdlePollMs(currentMs: number): number {
  return Math.min(idleMaxPollMs, Math.max(pollMs, currentMs * 2));
}

function updateAdaptivePollState(summary: CycleActivitySummary): number {
  const nowIso = new Date().toISOString();
  if (summary.active) {
    adaptivePollState = {
      ...adaptivePollState,
      enabled: true,
      base_ms: pollMs,
      max_ms: idleMaxPollMs,
      current_ms: pollMs,
      idle_streak: 0,
      last_tick_at: nowIso,
      last_activity_at: nowIso,
      last_activity_reason: summary.reason,
    };
    return adaptivePollState.current_ms;
  }

  const nextMs = nextIdlePollMs(adaptivePollState.current_ms);
  adaptivePollState = {
    ...adaptivePollState,
    enabled: true,
    base_ms: pollMs,
    max_ms: idleMaxPollMs,
    current_ms: nextMs,
    idle_streak: adaptivePollState.idle_streak + 1,
    last_tick_at: nowIso,
    last_activity_reason: summary.reason,
  };
  return adaptivePollState.current_ms;
}

function shouldLogDispatchDrainTick(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  const processed = asNumber(record.processed as string | number | undefined, 0);
  const skipped = asNumber(record.skipped as string | number | undefined, 0);
  const failed = asNumber(record.failed as string | number | undefined, 0);
  if (processed > 0 || skipped > 0 || failed > 0) return true;
  const reason = safeString(record.reason).trim();
  return reason !== '' && reason !== 'worker_context';
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
    subagent_session_id: safeString(raw.subagent_session_id),
    active_subagent_thread_ids: Array.isArray(raw.active_subagent_thread_ids)
      ? raw.active_subagent_thread_ids.map((value) => safeString(value).trim()).filter(Boolean)
      : [],
    shared_timestamp_path: safeString(raw.shared_timestamp_path) || ralphSteerTimestampPath,
    shared_last_sent_at: safeString(raw.shared_last_sent_at),
    singleton_lock_path: safeString(raw.singleton_lock_path) || ralphSteerLockPath,
  };
}

function hasRalphTerminalState(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw || typeof raw !== 'object') return true;
  if (raw.active !== true) return true;
  if (!shouldContinueRun(raw)) return true;
  const phase = safeString(raw.current_phase).trim().toLowerCase();
  if (phase && RALPH_TERMINAL_PHASES.has(phase)) return true;
  if (isStaleRalphStartingPhase(raw)) return true;
  if (safeString(raw.completed_at).trim()) return true;
  return false;
}

function isStaleRalphStartingPhase(raw: Record<string, unknown>): boolean {
  const phase = safeString(raw.current_phase).trim().toLowerCase();
  if (phase !== 'starting') return false;
  const reference = parseIsoMillis(safeString(raw.last_turn_at)) ?? parseIsoMillis(safeString(raw.started_at));
  if (reference === null) return false;
  return Date.now() - reference > RALPH_STARTING_PHASE_TIMEOUT_MS;
}

async function loadPersistedWatcherState(): Promise<void> {
  const persisted = await readFile(statePath, 'utf-8')
    .then((content) => JSON.parse(content) as Record<string, unknown>)
    .catch(() => null);
  lastRalphContinueSteer = normalizeRalphContinueSteerState(persisted?.ralph_continue_steer as Record<string, unknown> | null | undefined);
  const persistedAutoNudge = persisted?.fallback_auto_nudge as Record<string, unknown> | null | undefined;
  if (persistedAutoNudge && typeof persistedAutoNudge === 'object') {
    lastFallbackAutoNudge = {
      enabled: persistedAutoNudge.enabled !== false,
      stall_ms: Number.isFinite(persistedAutoNudge.stall_ms) && (persistedAutoNudge.stall_ms as number) > 0
        ? persistedAutoNudge.stall_ms as number
        : AUTO_NUDGE_STALL_MS,
      last_tick_at: safeString(persistedAutoNudge.last_tick_at) || null,
      last_turn_at: safeString(persistedAutoNudge.last_turn_at),
      last_turn_count: Number.isFinite(persistedAutoNudge.last_turn_count) ? persistedAutoNudge.last_turn_count as number : null,
      last_message: safeString(persistedAutoNudge.last_message),
      last_reason: safeString(persistedAutoNudge.last_reason) || 'init',
      last_error: safeString(persistedAutoNudge.last_error) || null,
      last_nudged_signature: safeString(persistedAutoNudge.last_nudged_signature),
      last_nudged_at: safeString(persistedAutoNudge.last_nudged_at),
    };
  }
  const persistedAdaptivePoll = persisted?.adaptive_poll as Record<string, unknown> | null | undefined;
  if (persistedAdaptivePoll && typeof persistedAdaptivePoll === 'object') {
    adaptivePollState = {
      enabled: persistedAdaptivePoll.enabled !== false,
      base_ms: pollMs,
      max_ms: idleMaxPollMs,
      current_ms: Math.min(idleMaxPollMs, Math.max(pollMs, asNumber(persistedAdaptivePoll.current_ms as string | number | undefined, pollMs))),
      idle_streak: Math.max(0, Math.trunc(asNumber(persistedAdaptivePoll.idle_streak as string | number | undefined, 0))),
      last_tick_at: safeString(persistedAdaptivePoll.last_tick_at) || null,
      last_activity_at: safeString(persistedAdaptivePoll.last_activity_at) || null,
      last_activity_reason: safeString(persistedAdaptivePoll.last_activity_reason) || 'init',
    };
  }
}

interface ActiveModeResult {
  active: boolean;
  reason: string;
  path: string;
  state: Record<string, unknown> | null;
}

async function resolveActiveModeState(mode: string): Promise<ActiveModeResult> {
  const candidateDirs: string[] = [];
  let currentSessionId = '';
  let currentSessionIsLive = false;
  const session = await readSessionState(cwd);
  if (session?.session_id) {
    if (isSessionStateAuthoritativeForCwd(session, cwd)) {
      currentSessionId = normalizeValidSessionId(session.session_id);
      currentSessionIsLive = currentSessionId !== '' && !isSessionStale(session);
    }
    if (currentSessionId && currentSessionIsLive) {
      candidateDirs.push(join(stateDir, 'sessions', currentSessionId));
    }
  }
  if (!candidateDirs.includes(stateDir)) candidateDirs.push(stateDir);

  for (const dir of candidateDirs) {
    if (mode === 'ralph' && dir === stateDir && currentSessionId) {
      return {
        active: false,
        reason: currentSessionIsLive ? 'blocked_by_current_session' : 'stale_current_session',
        path: '',
        state: null,
      };
    }

    const path = join(dir, `${mode}-state.json`);
    if (!existsSync(path)) continue;
    const parsed = await readFile(path, 'utf-8')
      .then((content) => JSON.parse(content) as Record<string, unknown>)
      .catch(() => null);
    if (!parsed || typeof parsed !== 'object') continue;
    if (mode === 'ralph' && dir !== stateDir && isStaleRalphStartingPhase(parsed)) {
      return {
        active: false,
        reason: 'starting_stale',
        path,
        state: parsed,
      };
    }
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

async function resolveActiveTeamState(): Promise<ActiveTeamResult> {
  const candidateDirs: string[] = [];
  let currentSessionId = '';
  let currentSessionIsLive = false;
  const session = await readSessionState(cwd);
  if (session?.session_id) {
    currentSessionId = normalizeValidSessionId(session.session_id);
    currentSessionIsLive = currentSessionId !== '' && !isSessionStale(session);
    if (currentSessionId && currentSessionIsLive) {
      candidateDirs.push(join(stateDir, 'sessions', currentSessionId));
    }
  }
  if (!candidateDirs.includes(stateDir)) candidateDirs.push(stateDir);

  for (const dir of candidateDirs) {
    if (dir === stateDir && currentSessionId) {
      continue;
    }

    const path = join(dir, 'team-state.json');
    if (!existsSync(path)) continue;
    const parsed = await readFile(path, 'utf-8')
      .then((content) => JSON.parse(content) as Record<string, unknown>)
      .catch(() => null);
    if (!parsed || typeof parsed !== 'object' || parsed.active !== true) continue;

    const teamName = normalizeValidTeamName(parsed.team_name);
    if (!teamName) continue;

    const teamConfigDir = join(stateDir, 'team', teamName);
    const phasePath = join(teamConfigDir, 'phase.json');
    const phaseState = existsSync(phasePath)
      ? await readFile(phasePath, 'utf-8')
        .then((content) => JSON.parse(content) as Record<string, unknown>)
        .catch(() => null)
      : null;
    const phase = safeString(phaseState?.current_phase).trim();
    if (phase && isTerminalPhase(phase)) continue;

    const manifestPath = join(teamConfigDir, 'manifest.v2.json');
    const configPath = join(teamConfigDir, 'config.json');
    const teamConfigPath = existsSync(manifestPath) ? manifestPath : configPath;
    const teamConfig = existsSync(teamConfigPath)
      ? await readFile(teamConfigPath, 'utf-8')
        .then((content) => JSON.parse(content) as Record<string, unknown>)
        .catch(() => null)
      : null;
    const tmuxSession = safeString(teamConfig?.tmux_session).trim();
    if (!tmuxSession) continue;

    const workers = Array.isArray(teamConfig?.workers) ? teamConfig.workers as Array<Record<string, unknown>> : [];
    const workerPaneIds: string[] = workers
      .map((worker) => safeString(worker?.pane_id).trim())
      .filter(Boolean);
    const paneStatus = await checkWorkerPanesAlive(tmuxSession, workerPaneIds as any);
    if (!paneStatus.alive) continue;

    return {
      active: true,
      reason: 'active',
      path,
      state: parsed,
      team_name: teamName,
      pane_count: paneStatus.paneCount,
    };
  }

  const canonicalFallbackTeams = await listNotifyCanonicalActiveTeams(cwd, currentSessionId).catch(() => []);
  for (const team of canonicalFallbackTeams) {
    const teamName = normalizeValidTeamName(team.teamName);
    if (!teamName) continue;
    const teamConfigDir = join(stateDir, 'team', teamName);
    const manifestPath = join(teamConfigDir, 'manifest.v2.json');
    const configPath = join(teamConfigDir, 'config.json');
    const teamConfigPath = existsSync(manifestPath) ? manifestPath : configPath;
    const teamConfig = existsSync(teamConfigPath)
      ? await readFile(teamConfigPath, 'utf-8')
        .then((content) => JSON.parse(content) as Record<string, unknown>)
        .catch(() => null)
      : null;
    const tmuxSession = safeString(teamConfig?.tmux_session).trim();
    if (!tmuxSession) continue;

    const workers = Array.isArray(teamConfig?.workers) ? teamConfig.workers as Array<Record<string, unknown>> : [];
    const workerPaneIds: string[] = workers
      .map((worker) => safeString(worker?.pane_id).trim())
      .filter(Boolean);
    const paneStatus = await checkWorkerPanesAlive(tmuxSession, workerPaneIds as any);
    if (!paneStatus.alive) continue;

    return {
      active: true,
      reason: team.source,
      path: team.path,
      state: {
        active: true,
        team_name: teamName,
        current_phase: team.phase,
      },
      team_name: teamName,
      pane_count: paneStatus.paneCount,
    };
  }

  if (currentSessionId) {
    return {
      active: false,
      reason: currentSessionIsLive ? 'blocked_by_current_session' : 'stale_current_session',
      path: '',
      state: null,
      team_name: '',
      pane_count: 0,
    };
  }

  return {
    active: false,
    reason: 'cleared',
    path: '',
    state: null,
    team_name: '',
    pane_count: 0,
  };
}

async function emitRalphContinueSteer(paneId: string, message: string): Promise<void> {
  const markedText = `${message} ${DEFAULT_MARKER}`;
  await new Promise<void>((resolve) => {
    const { result: typed } = spawnPlatformCommandSync('tmux', ['send-keys', '-t', paneId, '-l', markedText], { encoding: 'utf-8' });
    if (typed.error) throw new Error(typed.error.message);
    if (typed.status !== 0) throw new Error((typed.stderr || typed.stdout || '').trim() || 'tmux send-keys failed');
    setTimeout(resolve, 100);
  });
  await new Promise<void>((resolve) => {
    const { result: submitA } = spawnPlatformCommandSync('tmux', ['send-keys', '-t', paneId, 'C-m'], { encoding: 'utf-8' });
    if (submitA.error) throw new Error(submitA.error.message);
    if (submitA.status !== 0) throw new Error((submitA.stderr || submitA.stdout || '').trim() || 'tmux send-keys C-m failed');
    setTimeout(resolve, 100);
  });
  const { result: submitB } = spawnPlatformCommandSync('tmux', ['send-keys', '-t', paneId, 'C-m'], { encoding: 'utf-8' });
  if (submitB.error) throw new Error(submitB.error.message);
  if (submitB.status !== 0) {
    throw new Error((submitB.stderr || submitB.stdout || '').trim() || 'tmux send-keys C-m failed');
  }
}

async function readRalphSteerTimestamp(): Promise<string> {
  return readFile(ralphSteerTimestampPath, 'utf-8')
    .then((content) => safeString(content).trim())
    .catch(() => '');
}

async function writeRalphSteerTimestamp(nowIso: string): Promise<void> {
  await mkdir(dirname(ralphSteerTimestampPath), { recursive: true }).catch(() => {});
  const tempPath = `${ralphSteerTimestampPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${nowIso}\n`, 'utf-8');
  await rename(tempPath, ralphSteerTimestampPath);
}

async function readRalphSteerLock(path: string): Promise<RalphSteerLockRecord | null> {
  const raw = await readFile(path, 'utf-8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = parsePositivePid(parsed.pid);
    const acquiredAt = safeString(parsed.acquired_at).trim();
    if (pid === null || !acquiredAt) return null;
    return { pid, acquired_at: acquiredAt };
  } catch {
    return null;
  }
}

const RALPH_STEER_LOCK_MAX_RETRIES = 5;

async function withRalphSteerLock<T>(task: () => Promise<T>): Promise<T | null> {
  await mkdir(dirname(ralphSteerLockPath), { recursive: true }).catch(() => {});

  let acquired = false;
  for (let attempt = 0; attempt < RALPH_STEER_LOCK_MAX_RETRIES; attempt++) {
    let handle;
    try {
      handle = await open(ralphSteerLockPath, 'wx');
      const payload: RalphSteerLockRecord = {
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(payload, null, 2));
      acquired = true;
      break;
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : '';
      if (code !== 'EEXIST') throw error;
      const existing = await readRalphSteerLock(ralphSteerLockPath);
      const lockAgeMs = parseIsoMillis(existing?.acquired_at) ?? 0;
      const stale = existing !== null
        && (!isPidAlive(existing.pid) || (lockAgeMs > 0 && Date.now() - lockAgeMs > RALPH_STEER_LOCK_STALE_MS));
      if (stale) {
        await unlink(ralphSteerLockPath).catch(() => {});
        continue;
      }
      lastRalphContinueSteer.last_reason = 'global_lock_busy';
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  if (!acquired) {
    lastRalphContinueSteer.last_reason = 'global_lock_exhausted';
    return null;
  }

  try {
    return await task();
  } finally {
    const existing = await readRalphSteerLock(ralphSteerLockPath);
    if (existing?.pid === process.pid) {
      await unlink(ralphSteerLockPath).catch(() => {});
    }
  }
}

interface RalphProgressGateResult {
  allow: boolean;
  reason: string;
  progress_at: string;
  subagent_session_id?: string;
  active_subagent_thread_ids?: string[];
}

async function readRalphProgressGate(
  activeRalphState: Record<string, unknown> | null,
  now: number,
): Promise<RalphProgressGateResult> {
  const subagentSessionId = safeString(activeRalphState?.owner_codex_session_id).trim();
  if (subagentSessionId) {
    const summary = await readSubagentSessionSummary(cwd, subagentSessionId, {
      now: new Date(now),
      activeWindowMs: DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS,
    });
    if ((summary?.activeSubagentThreadIds.length ?? 0) > 0) {
      return {
        allow: false,
        reason: 'subagents_active',
        progress_at: '',
        subagent_session_id: subagentSessionId,
        active_subagent_thread_ids: summary?.activeSubagentThreadIds ?? [],
      };
    }
  }

  const hudState = await readScopedJsonIfExists(stateDir, 'hud-state.json', undefined, null);
  if (!hudState || typeof hudState !== 'object') {
    return { allow: false, reason: 'progress_missing', progress_at: '', subagent_session_id: subagentSessionId };
  }

  const progressAt = safeString(hudState.last_progress_at).trim();
  if (!progressAt) {
    return { allow: false, reason: 'progress_missing', progress_at: '', subagent_session_id: subagentSessionId };
  }

  const progressMs = parseIsoMillis(progressAt);
  if (progressMs === null) {
    return { allow: false, reason: 'progress_invalid', progress_at: progressAt, subagent_session_id: subagentSessionId };
  }

  if (now - progressMs < RALPH_CONTINUE_CADENCE_MS) {
    return { allow: false, reason: 'progress_fresh', progress_at: progressAt, subagent_session_id: subagentSessionId };
  }

  return { allow: true, reason: 'progress_stale', progress_at: progressAt, subagent_session_id: subagentSessionId };
}

function shouldSkipRalphContinue(now: number, candidateIso: string): { skip: boolean; reason: string; anchorMs: number; anchorIso: string } {
  const sharedMs = parseIsoMillis(candidateIso);
  const localMs = parseIsoMillis(lastRalphContinueSteer.last_sent_at);
  const startupAnchorIso = lastRalphContinueSteer.cooldown_anchor_at;
  const startupAnchorMs = parseIsoMillis(startupAnchorIso);
  const startupCooldown = sharedMs === null && localMs === null && startupAnchorMs !== null;
  const anchorMs = sharedMs ?? localMs ?? startupAnchorMs ?? 0;
  const anchorIso = sharedMs !== null
    ? candidateIso
    : (localMs !== null ? lastRalphContinueSteer.last_sent_at : startupAnchorIso);
  return {
    skip: anchorMs > 0 && now - anchorMs < RALPH_CONTINUE_CADENCE_MS,
    reason: startupCooldown ? 'startup_cooldown' : (sharedMs !== null ? 'global_cooldown' : 'cooldown'),
    anchorMs,
    anchorIso,
  };
}

async function readPidFileRecord(path: string): Promise<PidFileRecord | null> {
  const raw = await readFile(path, 'utf-8').catch(() => '');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const pid = parsePositivePid(parsed.pid);
    if (pid === null) return null;
    return {
      pid,
      parent_pid: parsePositivePid(parsed.parent_pid) ?? undefined,
      cwd: safeString(parsed.cwd) || undefined,
      started_at: safeString(parsed.started_at) || undefined,
      max_lifetime_ms: asNumber(parsed.max_lifetime_ms as string | number | undefined, 0) || undefined,
      owner_token: safeString(parsed.owner_token) || undefined,
    };
  } catch {
    const pid = parsePositivePid(trimmed);
    return pid === null ? null : { pid };
  }
}

function createAuthorityBackoffState(
  reason: string,
  overrides: Partial<AuthorityBackoffState> = {},
): AuthorityBackoffState {
  return {
    active: false,
    reason,
    primary_pid: null,
    primary_last_tick_at: '',
    freshness_ms: null,
    threshold_ms: null,
    ...overrides,
  };
}

function latestWatcherTickIso(state: Record<string, unknown> | null): string {
  if (!state || typeof state !== 'object') return '';
  const candidates = [
    safeString((state.dispatch_drain as Record<string, unknown> | undefined)?.last_tick_at),
    safeString((state.leader_nudge as Record<string, unknown> | undefined)?.last_tick_at),
    safeString((state.fallback_auto_nudge as Record<string, unknown> | undefined)?.last_tick_at),
    safeString((state.ralph_continue_steer as Record<string, unknown> | undefined)?.last_state_check_at),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  let latestIso = '';
  let latestMs = -1;
  for (const candidate of candidates) {
    const parsed = parseIsoMillis(candidate);
    if (parsed === null || parsed <= latestMs) continue;
    latestMs = parsed;
    latestIso = candidate;
  }
  return latestIso;
}

async function resolveAuthorityPrimaryWatcherHealth(now = Date.now()): Promise<AuthorityBackoffState> {
  if (!authorityOnly) return createAuthorityBackoffState('not_authority');

  const existingRecord = await readPidFileRecord(pidFilePath).catch(() => null);
  if (!existingRecord) return createAuthorityBackoffState('pid_missing');
  if (existingRecord.cwd && !sameFilePath(existingRecord.cwd, cwd)) return createAuthorityBackoffState('cwd_mismatch');
  if (!isPidAlive(existingRecord.pid)) {
    return createAuthorityBackoffState('pid_stale', {
      primary_pid: existingRecord.pid,
    });
  }

  const persistedState = await readJsonObject(statePath);
  if (!persistedState) {
    return createAuthorityBackoffState('state_missing', {
      primary_pid: existingRecord.pid,
    });
  }

  const persistedPid = Math.trunc(asNumber(persistedState.pid as string | number | undefined, 0));
  if (persistedPid > 0 && persistedPid !== existingRecord.pid) {
    return createAuthorityBackoffState('state_pid_mismatch', {
      primary_pid: existingRecord.pid,
    });
  }

  const lastTickAt = latestWatcherTickIso(persistedState);
  if (!lastTickAt) {
    return createAuthorityBackoffState('tick_missing', {
      primary_pid: existingRecord.pid,
    });
  }

  const lastTickMs = parseIsoMillis(lastTickAt);
  const primaryPollMs = Math.max(50, asNumber(persistedState.poll_ms as string | number | undefined, 250));
  const thresholdMs = Math.max(1_000, primaryPollMs * 4);
  if (lastTickMs === null) {
    return createAuthorityBackoffState('tick_invalid', {
      primary_pid: existingRecord.pid,
      primary_last_tick_at: lastTickAt,
      threshold_ms: thresholdMs,
    });
  }

  const freshnessMs = now - lastTickMs;
  if (freshnessMs > thresholdMs) {
    return {
      active: false,
      reason: 'tick_stale',
      primary_pid: existingRecord.pid,
      primary_last_tick_at: lastTickAt,
      freshness_ms: freshnessMs,
      threshold_ms: thresholdMs,
    };
  }

  return {
    active: true,
    reason: 'primary_watcher_healthy',
    primary_pid: existingRecord.pid,
    primary_last_tick_at: lastTickAt,
    freshness_ms: freshnessMs,
    threshold_ms: thresholdMs,
  };
}

async function writePidFileRecord(): Promise<void> {
  const nextRecord: PidFileRecord = {
    pid: process.pid,
    parent_pid: parentPid,
    cwd,
    started_at: new Date(startedAt).toISOString(),
    max_lifetime_ms: maxLifetimeMs,
    owner_token: watcherOwnerToken,
  };
  await writeFile(pidFilePath, JSON.stringify(nextRecord, null, 2)).catch(() => {});
}

async function buildWatcherManagedPayload(): Promise<Record<string, string> | null> {
  const session = await readSessionState(cwd).catch(() => null);
  const sessionId = safeString(session?.session_id).trim();
  if (!sessionId || !session || isSessionStale(session)) return null;
  return { session_id: sessionId };
}

async function persistReboundRalphPaneState(
  statePath: string,
  state: Record<string, unknown> | null,
  paneId: string,
  nowIso: string,
): Promise<Record<string, unknown>> {
  const latestState = await readFile(statePath, 'utf-8')
    .then((content) => JSON.parse(content) as Record<string, unknown>)
    .catch(() => null);
  const nextState = {
    ...((latestState && typeof latestState === 'object') ? latestState : (state || {})),
    tmux_pane_id: paneId,
    tmux_pane_set_at: nowIso,
  };
  const tmpPath = `${statePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, JSON.stringify(nextState, null, 2));
  try {
    await rename(tmpPath, statePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
  return nextState;
}

async function resolveRalphContinuePaneTarget(
  activeRalph: ActiveModeResult,
  nowIso: string,
): Promise<{ paneId: string; state: Record<string, unknown> | null; reboundFrom: string }> {
  const currentState = activeRalph.state && typeof activeRalph.state === 'object'
    ? activeRalph.state as Record<string, unknown>
    : null;
  const anchorPaneId = safeString(currentState?.tmux_pane_id).trim();
  if (!anchorPaneId) {
    return {
      paneId: '',
      state: currentState,
      reboundFrom: '',
    };
  }

  const managedPayload = await buildWatcherManagedPayload();
  if (!managedPayload) {
    return {
      paneId: anchorPaneId,
      state: currentState,
      reboundFrom: '',
    };
  }

  let resolvedPaneId = await resolveManagedPaneFromAnchor(anchorPaneId, cwd, managedPayload, { allowTeamWorker: false });
  if (!resolvedPaneId) {
    resolvedPaneId = await resolveManagedSessionPane(cwd, managedPayload);
  }
  if (!resolvedPaneId) {
    return {
      paneId: '',
      state: currentState,
      reboundFrom: '',
    };
  }
  if (resolvedPaneId === anchorPaneId) {
    return {
      paneId: resolvedPaneId,
      state: currentState,
      reboundFrom: '',
    };
  }

  const updatedState = await persistReboundRalphPaneState(activeRalph.path, currentState, resolvedPaneId, nowIso);
  return {
    paneId: resolvedPaneId,
    state: updatedState,
    reboundFrom: anchorPaneId,
  };
}

async function runRalphContinueSteerTick(): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const activeRalph = await resolveActiveRalphState();
  const activePaneId = safeString(activeRalph.state?.tmux_pane_id).trim();
  lastRalphContinueSteer = {
    ...lastRalphContinueSteer,
    active: activeRalph.active,
    current_phase: safeString(activeRalph.state?.current_phase),
    last_state_check_at: nowIso,
    last_reason: activeRalph.reason,
    last_error: null,
    state_path: activeRalph.path,
    pane_id: activePaneId,
    pane_current_command: '',
    subagent_session_id: safeString(activeRalph.state?.owner_codex_session_id).trim(),
    active_subagent_thread_ids: [],
    shared_timestamp_path: ralphSteerTimestampPath,
    singleton_lock_path: ralphSteerLockPath,
  };

  if (!activeRalph.active) {
    if (activeRalph.reason === 'starting_stale') {
      lastRalphContinueSteer.last_reason = 'starting_stale';
    }
    return;
  }

  const sharedBeforeLock = await readRalphSteerTimestamp();
  lastRalphContinueSteer.shared_last_sent_at = sharedBeforeLock;
  const initialCooldown = shouldSkipRalphContinue(now, sharedBeforeLock);
  if (initialCooldown.skip) {
    lastRalphContinueSteer.last_reason = initialCooldown.reason;
    if (!sharedBeforeLock && initialCooldown.reason === 'startup_cooldown') {
      lastRalphContinueSteer.cooldown_anchor_at = initialCooldown.anchorIso;
    }
    return;
  }

  const outcome = await withRalphSteerLock(async () => {
    const sharedLastSentAt = await readRalphSteerTimestamp();
    lastRalphContinueSteer.shared_last_sent_at = sharedLastSentAt;
    const cooldown = shouldSkipRalphContinue(Date.now(), sharedLastSentAt);
    if (cooldown.skip) {
      lastRalphContinueSteer.last_reason = cooldown.reason;
      if (!sharedLastSentAt && cooldown.reason === 'startup_cooldown') {
        lastRalphContinueSteer.cooldown_anchor_at = cooldown.anchorIso;
      }
      return { sent: false, skipped: true };
    }

    const progressGate = await readRalphProgressGate(activeRalph.state, Date.now());
    if (!progressGate.allow) {
      lastRalphContinueSteer.last_reason = progressGate.reason;
      lastRalphContinueSteer.subagent_session_id = progressGate.subagent_session_id ?? lastRalphContinueSteer.subagent_session_id;
      lastRalphContinueSteer.active_subagent_thread_ids = progressGate.active_subagent_thread_ids ?? [];
      return { sent: false, skipped: true };
    }

    const resolvedPane = await resolveRalphContinuePaneTarget(activeRalph, nowIso);
    activeRalph.state = resolvedPane.state;
    const paneId = resolvedPane.paneId;
    if (!paneId) {
      lastRalphContinueSteer.last_reason = 'pane_missing';
      lastRalphContinueSteer.pane_id = '';
      return { sent: false, skipped: true };
    }

    const paneGuard = await checkPaneReadyForTeamSendKeys(paneId);
    lastRalphContinueSteer.pane_id = paneId;
    lastRalphContinueSteer.pane_current_command = paneGuard.paneCurrentCommand || '';
    if (!paneGuard.ok) {
      lastRalphContinueSteer.last_reason = paneGuard.reason || 'pane_guard_blocked';
      return { sent: false, skipped: true };
    }

    await emitRalphContinueSteer(paneId, RALPH_CONTINUE_TEXT);
    await writeRalphSteerTimestamp(nowIso);
    lastRalphContinueSteer.last_sent_at = nowIso;
    lastRalphContinueSteer.shared_last_sent_at = nowIso;
    lastRalphContinueSteer.cooldown_anchor_at = nowIso;
    lastRalphContinueSteer.last_reason = 'sent';
    await eventLog({
      type: 'ralph_continue_steer',
      reason: 'sent',
      pane_id: paneId,
      rebound_from: resolvedPane.reboundFrom || null,
      state_path: activeRalph.path,
      current_phase: safeString(activeRalph.state?.current_phase) || null,
      cadence_ms: RALPH_CONTINUE_CADENCE_MS,
      message: RALPH_CONTINUE_TEXT,
      shared_timestamp_path: ralphSteerTimestampPath,
    });
    return { sent: true, skipped: false };
  });

  if (outcome === null) {
    lastRalphContinueSteer.shared_last_sent_at = await readRalphSteerTimestamp();
  }
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

async function registerPidFile(): Promise<void> {
  if (runOnce) return;
  await mkdir(dirname(pidFilePath), { recursive: true }).catch(() => {});

  const existingRecord = await readPidFileRecord(pidFilePath).catch(() => null);
  const existingPid = existingRecord?.pid ?? null;
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

  await writePidFileRecord();
}

async function removePidFileIfOwned(): Promise<void> {
  if (runOnce) return;
  const existingRecord = await readPidFileRecord(pidFilePath).catch(() => null);
  if (existingRecord?.pid !== process.pid) return;
  if (existingRecord.owner_token && existingRecord.owner_token !== watcherOwnerToken) return;
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
    authority_only: authorityOnly,
    poll_ms: pollMs,
    effective_poll_ms: adaptivePollState.current_ms,
    idle_max_poll_ms: idleMaxPollMs,
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
    fallback_auto_nudge: {
      ...lastFallbackAutoNudge,
      enabled: true,
      stall_ms: AUTO_NUDGE_STALL_MS,
    },
    authority_backoff: lastAuthorityBackoff,
    adaptive_poll: {
      ...adaptivePollState,
      enabled: true,
      base_ms: pollMs,
      max_ms: idleMaxPollMs,
    },
    ...extra,
  };
  await writeJsonObjectAtomically(statePath, state).catch(() => {});
}

async function writeAuthorityBackoffState(): Promise<void> {
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  const existing = await readJsonObject(statePath);
  const state = existing && typeof existing === 'object'
    ? { ...existing, authority_backoff: lastAuthorityBackoff }
    : { authority_backoff: lastAuthorityBackoff };
  await writeJsonObjectAtomically(statePath, state).catch(() => {});
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  return readFile(path, 'utf-8')
    .then((content) => JSON.parse(content) as Record<string, unknown>)
    .catch(() => null);
}

async function readAutoNudgeCount(): Promise<number> {
  const parsed = await readScopedJsonIfExists(stateDir, 'auto-nudge-state.json', undefined, null);
  return Math.max(0, Math.trunc(asNumber(parsed?.nudgeCount as string | number | undefined, 0)));
}

async function readAutoNudgeState(): Promise<Record<string, unknown> | null> {
  return readScopedJsonIfExists(stateDir, 'auto-nudge-state.json', undefined, null);
}

async function runFallbackAutoNudgeTick(): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const hudState = await readScopedJsonIfExists(stateDir, 'hud-state.json', undefined, null);

  lastFallbackAutoNudge = {
    ...lastFallbackAutoNudge,
    enabled: true,
    stall_ms: AUTO_NUDGE_STALL_MS,
    last_tick_at: nowIso,
    last_error: null,
  };

  if (!hudState) {
    lastFallbackAutoNudge.last_reason = 'hud_state_missing';
    return;
  }

  const lastTurnAt = safeString(hudState.last_turn_at);
  const turnCount = Number.isFinite(hudState.turn_count) ? hudState.turn_count as number : null;
  const lastMessage = safeString(hudState.last_agent_output || hudState.last_agent_message || '');
  const lastTurnMs = parseIsoMillis(lastTurnAt);

  lastFallbackAutoNudge.last_turn_at = lastTurnAt;
  lastFallbackAutoNudge.last_turn_count = turnCount;
  lastFallbackAutoNudge.last_message = lastMessage.slice(0, 400);

  if (!lastTurnAt || lastTurnMs === null || turnCount === null || turnCount < 1) {
    lastFallbackAutoNudge.last_reason = 'hud_state_incomplete';
    return;
  }
  if (!lastMessage.trim()) {
    lastFallbackAutoNudge.last_reason = 'no_last_message';
    return;
  }
  if (now - lastTurnMs < AUTO_NUDGE_STALL_MS) {
    lastFallbackAutoNudge.last_reason = 'recent_turn_activity';
    return;
  }

  const signature = await resolveAutoNudgeSignature(stateDir, {
    type: 'agent-turn-complete',
    cwd,
    source: 'notify-fallback-watcher-stall',
    'thread-id': 'notify-fallback-watcher-stall',
    'turn-id': `stalled-turn-${turnCount}`,
    'input-messages': ['[notify-fallback] synthesized from stalled hud-state'],
    'last-assistant-message': lastMessage,
  }, lastMessage);
  const persistedAutoNudgeState = await readAutoNudgeState();
  const autoNudgeConfig = await loadAutoNudgeConfig();
  const semanticSignature = normalizeAutoNudgeSignatureText(lastMessage);
  if (signature && safeString(persistedAutoNudgeState?.lastSignature) === signature) {
    lastFallbackAutoNudge.last_reason = 'already_nudged_for_signature';
    lastFallbackAutoNudge.last_nudged_signature = signature;
    return;
  }
  const lastNudgeAtMs = parseIsoMillis(safeString(persistedAutoNudgeState?.lastNudgeAt));
  if (
    semanticSignature
    && safeString(persistedAutoNudgeState?.lastSemanticSignature) === semanticSignature
    && autoNudgeConfig.ttlMs > 0
    && lastNudgeAtMs !== null
    && (now - lastNudgeAtMs) < autoNudgeConfig.ttlMs
  ) {
    lastFallbackAutoNudge.last_reason = 'ttl_active';
    lastFallbackAutoNudge.last_nudged_signature = signature;
    return;
  }

  const beforeCount = await readAutoNudgeCount();
  await maybeAutoNudge({
    cwd,
    stateDir,
    logsDir,
    payload: {
      type: 'agent-turn-complete',
      cwd,
      source: 'notify-fallback-watcher-stall',
      'thread-id': 'notify-fallback-watcher-stall',
      'turn-id': `stalled-turn-${turnCount}`,
      'input-messages': ['[notify-fallback] synthesized from stalled hud-state'],
      'last-assistant-message': lastMessage,
    },
  });
  const afterCount = await readAutoNudgeCount();

  if (afterCount > beforeCount) {
    lastFallbackAutoNudge.last_nudged_signature = signature;
    lastFallbackAutoNudge.last_nudged_at = nowIso;
    lastFallbackAutoNudge.last_reason = 'sent';
    await eventLog({
      type: 'fallback_auto_nudge_tick',
      reason: 'sent',
      turn_count: turnCount,
      last_turn_at: lastTurnAt,
      stall_ms: AUTO_NUDGE_STALL_MS,
    });
    return;
  }

  lastFallbackAutoNudge.last_reason = 'eligible_but_not_sent';
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
        || lastParentGuard.team_name !== nextParentGuard.team_name
        || lastParentGuard.pane_count !== nextParentGuard.pane_count
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

    const activeTeam = await resolveActiveTeamState();
    if (activeTeam.active) {
      const currentPhase = safeString(activeTeam.state?.current_phase);
      const nextParentGuard: ParentGuardState = {
        reason: 'parent_gone_deferred_for_active_team',
        state_path: activeTeam.path,
        current_phase: currentPhase,
        team_name: activeTeam.team_name,
        pane_count: activeTeam.pane_count,
      };
      if (
        lastParentGuard.reason !== nextParentGuard.reason
        || lastParentGuard.state_path !== nextParentGuard.state_path
        || lastParentGuard.current_phase !== nextParentGuard.current_phase
        || lastParentGuard.team_name !== nextParentGuard.team_name
        || lastParentGuard.pane_count !== nextParentGuard.pane_count
      ) {
        await eventLog({
          type: 'watcher_parent_guard',
          reason: nextParentGuard.reason,
          state_path: nextParentGuard.state_path,
          current_phase: currentPhase || null,
          team_name: activeTeam.team_name,
          pane_count: activeTeam.pane_count,
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
      windowsHide: true,
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
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) continue;
    const size = fileStat.size || 0;
    const offset = runOnce ? 0 : size;
    fileState.set(path, { threadId, offset, size, partial: '', decoder: new StringDecoder('utf8') });
  }
}

function splitBufferedLines(partial: string, delta: string): { lines: string[]; partial: string } {
  const merged = partial + delta;
  const lines = merged.split('\n');
  return {
    lines,
    partial: lines.pop() || '',
  };
}

async function readFileDelta(
  path: string,
  offset: number,
  currentSize: number,
): Promise<{ bytes: Buffer; nextOffset: number }> {
  const length = currentSize - offset;
  if (length <= 0) return { bytes: Buffer.alloc(0), nextOffset: offset };
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let totalBytesRead = 0;
    while (totalBytesRead < length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        length - totalBytesRead,
        offset + totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    return {
      bytes: buffer.subarray(0, totalBytesRead),
      nextOffset: offset + totalBytesRead,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function pollFiles(): Promise<number> {
  let processedCount = 0;
  for (const [path, meta] of fileState.entries()) {
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) continue;
    const currentSize = fileStat.size || 0;
    if (currentSize < meta.offset) {
      meta.offset = 0;
      meta.partial = '';
      meta.decoder = new StringDecoder('utf8');
    }
    if (currentSize <= meta.offset) continue;
    const read = await readFileDelta(path, meta.offset, currentSize).catch(() => null);
    if (!read || read.bytes.length === 0) continue;
    const { bytes, nextOffset } = read;
    meta.offset = nextOffset;
    const delta = meta.decoder.write(bytes);
    if (!delta) continue;
    const buffered = splitBufferedLines(meta.partial, delta);
    const lines = buffered.lines;
    meta.partial = buffered.partial;
    for (const line of lines) {
      if (!line.trim()) continue;
      await processLine(meta, line, path);
      processedCount += 1;
    }
  }
  return processedCount;
}

async function runLeaderNudgeTick(): Promise<boolean> {
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
    return false;
  }

  try {
    const preComputedLeaderStale = await isLeaderStale(stateDir, staleThresholdMs, Date.now());
    await maybeNudgeTeamLeader({
      cwd,
      stateDir,
      logsDir,
      preComputedLeaderStale,
      allowFreshMailboxNudges: false,
      source: 'notify_fallback_watcher',
    });
    leaderNudgeRuns += 1;
    lastLeaderNudge = {
      enabled: true,
      leader_only: true,
      stale_threshold_ms: staleThresholdMs,
      precomputed_leader_stale: preComputedLeaderStale,
      last_tick_at: startedIso,
      last_error: null,
    };
    const reason = preComputedLeaderStale ? 'leader_nudge_checked' : 'leader_nudge_skipped_not_stale';
    if (shouldLogLeaderNudgeTick(reason)) {
      await eventLog({
        type: 'leader_nudge_tick',
        leader_only: true,
        run_count: leaderNudgeRuns,
        stale_threshold_ms: staleThresholdMs,
        precomputed_leader_stale: preComputedLeaderStale,
        reason,
      });
    }
    return preComputedLeaderStale;
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
    return true;
  }
}

async function runDispatchDrainTick(): Promise<boolean> {
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
    if (shouldLogDispatchDrainTick(result)) {
      await eventLog({
        type: 'dispatch_drain_tick',
        leader_only: lastDispatchDrain.leader_only,
        dispatch_max_per_tick: dispatchTickMax,
        run_count: dispatchDrainRuns,
        ...(result && typeof result === 'object' ? result as Record<string, unknown> : {}),
      });
    }
    return shouldLogDispatchDrainTick(result);
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
    return true;
  }
}

async function shouldSuppressInteractiveFallbackTicks(): Promise<boolean> {
  const [deepInterviewStateActive, deepInterviewInputLockActive] = await Promise.all([
    isDeepInterviewStateActive(stateDir, undefined),
    isDeepInterviewInputLockActive(stateDir, undefined),
  ]);
  return deepInterviewStateActive || deepInterviewInputLockActive;
}

async function pumpTeamControlPlaneTick(): Promise<CycleActivitySummary> {
  const dispatchActive = await runDispatchDrainTick();
  if (await shouldSuppressInteractiveFallbackTicks()) {
    return { active: dispatchActive, reason: dispatchActive ? 'dispatch_drain' : 'deep_interview_locked' };
  }
  const leaderActive = await runLeaderNudgeTick();
  await runFallbackAutoNudgeTick();
  const autoNudgeActive = lastFallbackAutoNudge.last_reason === 'sent';
  if (dispatchActive) return { active: true, reason: 'dispatch_drain' };
  if (leaderActive) return { active: true, reason: 'leader_nudge' };
  if (autoNudgeActive) return { active: true, reason: 'fallback_auto_nudge' };
  return { active: false, reason: lastFallbackAutoNudge.last_reason || 'control_plane_idle' };
}


async function runWatcherCycle(): Promise<number> {
  let processedRolloutCount = 0;
  if (authorityOnly) {
    const authorityBackoff = await resolveAuthorityPrimaryWatcherHealth();
    lastAuthorityBackoff = authorityBackoff;
    if (authorityBackoff.active) {
      await writeAuthorityBackoffState();
      return processedRolloutCount;
    }
  } else {
    lastAuthorityBackoff = createAuthorityBackoffState('');
  }
  if (!authorityOnly) {
    await ensureTrackedFiles();
    processedRolloutCount = await pollFiles();
  }
  const controlPlaneSummary = await pumpTeamControlPlaneTick();
  if (!authorityOnly && !(await shouldSuppressInteractiveFallbackTicks())) {
    await runRalphWatcherBehaviorTick();
  }
  const ralphActive = lastRalphContinueSteer.last_reason === 'sent';
  const summary: CycleActivitySummary = processedRolloutCount > 0
    ? { active: true, reason: 'rollout_event' }
    : controlPlaneSummary.active
      ? controlPlaneSummary
      : ralphActive
        ? { active: true, reason: 'ralph_continue_steer' }
        : { active: false, reason: controlPlaneSummary.reason || lastRalphContinueSteer.last_reason || 'idle' };
  const nextDelayMs = updateAdaptivePollState(summary);
  await writeState({ last_cycle_activity: summary.reason });
  return nextDelayMs;
}

async function tick(): Promise<void> {
  if (stopping) return;
  if (await enforceLifecycleGuards()) return;
  const nextDelayMs = await runWatcherCycle();
  if (await enforceLifecycleGuards()) return;
  setTimeout(() => {
    void tick();
  }, nextDelayMs);
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
  if (!(runOnce && authorityOnly)) {
    await eventLog({
      type: 'watcher_start',
      cwd,
      notify_script: notifyScript,
      authority_only: authorityOnly,
      poll_ms: pollMs,
      effective_poll_ms: adaptivePollState.current_ms,
      idle_max_poll_ms: idleMaxPollMs,
      once: runOnce,
      parent_pid: parentPid,
      pid_file: runOnce ? null : pidFilePath,
      max_lifetime_ms: maxLifetimeMs,
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  if (await enforceLifecycleGuards()) return;

  if (runOnce) {
    await runWatcherCycle();
    if (!authorityOnly) {
      await eventLog({ type: 'watcher_once_complete', authority_only: authorityOnly, seen_turns: seenTurnKeys.size });
    }
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
