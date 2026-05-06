/**
 * Session Lifecycle Manager for oh-my-codex
 *
 * Tracks session start/end, detects stale sessions from crashed launches,
 * and provides structured logging for session events.
 */

import { readFile, writeFile, mkdir, unlink, appendFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { omxRoot, omxStateDir, omxLogsDir, sameFilePath } from '../utils/paths.js';
import { getStateFilePath } from '../mcp/state-paths.js';

export interface SessionState {
  session_id: string;
  native_session_id?: string;
  started_at: string;
  cwd: string;
  pid: number;
  platform?: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline?: string;
  tmux_session_name?: string;
}

const SESSION_FILE = 'session.json';
const HISTORY_FILE = 'session-history.jsonl';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// No age-based threshold: staleness is determined by PID liveness/identity.
// Long-running sessions (>2h) are legitimate and should not be reaped.

function sessionPath(cwd: string): string {
  return join(omxStateDir(cwd), SESSION_FILE);
}

function historyPath(cwd: string): string {
  return join(omxLogsDir(cwd), HISTORY_FILE);
}

async function removeDeadSessionHudState(
  cwd: string,
  sessionIds: Array<string | undefined>,
): Promise<void> {
  const uniqueSessionIds = [...new Set(
    sessionIds
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim()),
  )];

  const candidatePaths = [
    getStateFilePath('hud-state.json', cwd),
    ...uniqueSessionIds.map((sessionId) => getStateFilePath('hud-state.json', cwd, sessionId)),
  ];

  await Promise.all(candidatePaths.map(async (path) => {
    try {
      await rm(path, { force: true });
    } catch {
      // best effort only
    }
  }));
}

/**
 * Reset session-scoped HUD/metrics files at launch so stale values do not leak
 * into a new Codex session.
 */
export async function resetSessionMetrics(cwd: string, sessionId?: string): Promise<void> {
  const omxDir = omxRoot(cwd);
  const stateDir = omxStateDir(cwd);
  await mkdir(omxDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const now = new Date().toISOString();
  await writeFile(join(omxDir, 'metrics.json'), JSON.stringify({
    total_turns: 0,
    session_turns: 0,
    last_activity: now,
    session_input_tokens: 0,
    session_output_tokens: 0,
    session_total_tokens: 0,
    five_hour_limit_pct: 0,
    weekly_limit_pct: 0,
  }, null, 2));

  const hudStatePath = getStateFilePath('hud-state.json', cwd, sessionId);
  await mkdir(dirname(hudStatePath), { recursive: true });
  await writeFile(hudStatePath, JSON.stringify({
    last_turn_at: now,
    last_progress_at: now,
    turn_count: 0,
    last_agent_output: '',
  }, null, 2));
}

/**
 * Read current session state. Returns null if no session file exists.
 */
export async function readSessionState(cwd: string): Promise<SessionState | null> {
  const path = sessionPath(cwd);
  if (!existsSync(path)) return null;

  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

export function isSessionStateAuthoritativeForCwd(state: SessionState, cwd: string): boolean {
  if (!SESSION_ID_PATTERN.test(state.session_id)) return false;

  if (typeof state.cwd === 'string' && state.cwd.trim() !== '') {
    return sameFilePath(state.cwd, cwd);
  }

  return true;
}

export function isSessionStateUsable(
  state: SessionState,
  cwd: string,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!isSessionStateAuthoritativeForCwd(state, cwd)) return false;

  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  const hasLinuxIdentityMetadata = typeof state.pid_start_ticks === 'number'
    || typeof state.pid_cmdline === 'string';
  if (hasPidMetadata || hasLinuxIdentityMetadata) {
    return !isSessionStale(state, options);
  }

  return true;
}

export async function readUsableSessionState(
  cwd: string,
  options: SessionStaleCheckOptions = {},
): Promise<SessionState | null> {
  const state = await readSessionState(cwd);
  if (!state) return null;
  return isSessionStateUsable(state, cwd, options) ? state : null;
}

interface LinuxProcessIdentity {
  startTicks: number;
  cmdline: string | null;
}

interface SessionStaleCheckOptions {
  platform?: NodeJS.Platform;
  isPidAlive?: (pid: number) => boolean;
  readLinuxIdentity?: (pid: number) => LinuxProcessIdentity | null;
}

interface SessionStartOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  nativeSessionId?: string;
  tmuxSessionName?: string;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLinuxProcStartTicks(statContent: string): number | null {
  const commandEnd = statContent.lastIndexOf(')');
  if (commandEnd === -1) return null;

  const remainder = statContent.slice(commandEnd + 1).trim();
  const fields = remainder.split(/\s+/);
  if (fields.length <= 19) return null;

  const startTicks = Number(fields[19]);
  return Number.isFinite(startTicks) ? startTicks : null;
}

function normalizeCmdline(cmdline: string | null | undefined): string | null {
  if (!cmdline) return null;
  const normalized = cmdline.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const startTicks = parseLinuxProcStartTicks(stat);
    if (startTicks == null) return null;

    let cmdline: string | null = null;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
        .replace(/\u0000+/g, ' ')
        .trim();
    } catch {
      cmdline = null;
    }

    return {
      startTicks,
      cmdline: normalizeCmdline(cmdline),
    };
  } catch {
    return null;
  }
}

function createSessionState(
  cwd: string,
  sessionId: string,
  pid: number,
  platform: NodeJS.Platform,
  linuxIdentity: LinuxProcessIdentity | null,
  options: {
    nowIso?: string;
    nativeSessionId?: string;
    startedAt?: string;
    tmuxSessionName?: string;
  } = {},
): SessionState {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nativeSessionId = typeof options.nativeSessionId === 'string' && options.nativeSessionId.trim()
    ? options.nativeSessionId.trim()
    : undefined;
  const tmuxSessionName = typeof options.tmuxSessionName === 'string' && options.tmuxSessionName.trim()
    ? options.tmuxSessionName.trim()
    : undefined;

  return {
    session_id: sessionId,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
    started_at: options.startedAt ?? nowIso,
    cwd,
    pid,
    platform,
    pid_start_ticks: linuxIdentity?.startTicks,
    pid_cmdline: linuxIdentity?.cmdline ?? undefined,
    ...(tmuxSessionName ? { tmux_session_name: tmuxSessionName } : {}),
  };
}

/**
 * Check if a session is stale.
 * - If the owning PID is dead, it is stale.
 * - On Linux, require process identity validation (start ticks, optional cmdline).
 *   If identity cannot be validated, treat the session as stale.
 */
export function isSessionStale(
  state: SessionState,
  options: SessionStaleCheckOptions = {},
): boolean {
  if (!Number.isInteger(state.pid) || state.pid <= 0) return true;

  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!isPidAlive(state.pid)) return true;

  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return false;

  const readIdentity = options.readLinuxIdentity ?? readLinuxProcessIdentity;
  const liveIdentity = readIdentity(state.pid);
  if (!liveIdentity) return true;

  if (typeof state.pid_start_ticks !== 'number') return true;
  if (state.pid_start_ticks !== liveIdentity.startTicks) return true;

  const expectedCmdline = normalizeCmdline(state.pid_cmdline);
  if (expectedCmdline) {
    const liveCmdline = normalizeCmdline(liveIdentity.cmdline);
    if (!liveCmdline || liveCmdline !== expectedCmdline) return true;
  }

  return false;
}

/**
 * Write session start state.
 */
export async function writeSessionStart(
  cwd: string,
  sessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const stateDir = omxStateDir(cwd);
  await mkdir(stateDir, { recursive: true });
  const pid = Number.isInteger(options.pid) && options.pid && options.pid > 0
    ? options.pid
    : process.pid;
  const platform = options.platform ?? process.platform;
  const linuxIdentity = platform === 'linux'
    ? readLinuxProcessIdentity(pid)
    : null;
  const state = createSessionState(cwd, sessionId, pid, platform, linuxIdentity, {
    nativeSessionId: options.nativeSessionId,
    tmuxSessionName: options.tmuxSessionName,
  });

  await writeFile(sessionPath(cwd), JSON.stringify(state, null, 2));
  await appendToLog(cwd, {
    event: 'session_start',
    session_id: sessionId,
    ...(state.native_session_id ? { native_session_id: state.native_session_id } : {}),
    pid,
    timestamp: state.started_at,
  });
  return state;
}

/**
 * Reconcile a native/Codex SessionStart with the canonical OMX launch session.
 * If an authoritative current session already exists for this cwd/run, preserve
 * its OMX scope id and refresh PID/native metadata. Otherwise establish a fresh
 * canonical session using the native session id.
 */
export async function reconcileNativeSessionStart(
  cwd: string,
  nativeSessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const existing = await readUsableSessionState(cwd, {
    ...(options.platform ? { platform: options.platform } : {}),
  });
  if (!existing) {
    return await writeSessionStart(cwd, nativeSessionId, {
      ...options,
      nativeSessionId,
    });
  }

  const existingNativeSessionId = typeof existing.native_session_id === 'string'
    ? existing.native_session_id.trim()
    : '';
  if (existingNativeSessionId && existingNativeSessionId !== nativeSessionId) {
    return await writeSessionStart(cwd, nativeSessionId, {
      ...options,
      nativeSessionId,
    });
  }

  const pid = Number.isInteger(options.pid) && options.pid && options.pid > 0
    ? options.pid
    : process.pid;
  const platform = options.platform ?? process.platform;
  const linuxIdentity = platform === 'linux'
    ? readLinuxProcessIdentity(pid)
    : null;
  const nowIso = new Date().toISOString();
  const state = createSessionState(cwd, existing.session_id, pid, platform, linuxIdentity, {
    nowIso,
    nativeSessionId,
    startedAt: existing.started_at,
    tmuxSessionName: existing.tmux_session_name,
  });

  await writeFile(sessionPath(cwd), JSON.stringify(state, null, 2));
  await appendToLog(cwd, {
    event: 'session_start_reconciled',
    session_id: state.session_id,
    native_session_id: nativeSessionId,
    pid,
    timestamp: nowIso,
  });
  return state;
}

/**
 * Write session end: archive to history, delete session.json.
 */
export async function writeSessionEnd(cwd: string, sessionId: string): Promise<void> {
  const state = await readSessionState(cwd);
  const endTime = new Date().toISOString();
  const ownsCurrentSessionFile = state == null
    || state.session_id === sessionId
    || state.native_session_id === sessionId;

  // Archive to session history
  const logsDir = omxLogsDir(cwd);
  await mkdir(logsDir, { recursive: true });

  const historyEntry = {
    session_id: ownsCurrentSessionFile ? state?.session_id || sessionId : sessionId,
    ...(ownsCurrentSessionFile && state?.native_session_id ? { native_session_id: state.native_session_id } : {}),
    started_at: ownsCurrentSessionFile ? state?.started_at || 'unknown' : 'unknown',
    ended_at: endTime,
    cwd,
    pid: ownsCurrentSessionFile ? state?.pid || process.pid : process.pid,
    ...(!ownsCurrentSessionFile && state?.session_id
      ? { preserved_active_session_id: state.session_id }
      : {}),
  };

  await appendFile(historyPath(cwd), JSON.stringify(historyEntry) + '\n');

  await removeDeadSessionHudState(cwd, [
    ...(ownsCurrentSessionFile ? [state?.session_id, state?.native_session_id] : []),
    sessionId,
  ]);

  // Delete session.json only when this end event owns the current pointer.
  if (ownsCurrentSessionFile) {
    try {
      await unlink(sessionPath(cwd));
    } catch { /* already gone */ }
  }

  await appendToLog(cwd, {
    event: 'session_end',
    session_id: ownsCurrentSessionFile ? state?.session_id || sessionId : sessionId,
    ...(ownsCurrentSessionFile && state?.native_session_id ? { native_session_id: state.native_session_id } : {}),
    ...(!ownsCurrentSessionFile && state?.session_id
      ? { preserved_active_session_id: state.session_id }
      : {}),
    timestamp: endTime,
  });
}

/**
 * Append a structured JSONL entry to the daily log file.
 */
export async function appendToLog(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const logsDir = omxLogsDir(cwd);
  await mkdir(logsDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = join(logsDir, `omx-${date}.jsonl`);
  const line = JSON.stringify({ ...entry, _ts: new Date().toISOString() }) + '\n';

  await appendFile(logFile, line);
}
