/**
 * Session Lifecycle Manager for oh-my-codex
 *
 * Tracks session start/end, detects stale sessions from crashed launches,
 * and provides structured logging for session events.
 */

import { readFile, writeFile, mkdir, unlink, appendFile } from 'fs/promises';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { omxStateDir, omxLogsDir } from '../utils/paths.js';

export interface SessionState {
  session_id: string;
  started_at: string;
  cwd: string;
  pid: number;
  platform?: NodeJS.Platform;
  pid_start_ticks?: number;
  pid_cmdline?: string;
}

const SESSION_FILE = 'session.json';
const HISTORY_FILE = 'session-history.jsonl';
// No age-based threshold: staleness is determined by PID liveness/identity.
// Long-running sessions (>2h) are legitimate and should not be reaped.

function sessionPath(cwd: string): string {
  return join(omxStateDir(cwd), SESSION_FILE);
}

function historyPath(cwd: string): string {
  return join(omxLogsDir(cwd), HISTORY_FILE);
}

/**
 * Reset session-scoped HUD/metrics files at launch so stale values do not leak
 * into a new Codex session.
 */
export async function resetSessionMetrics(cwd: string): Promise<void> {
  const omxDir = join(cwd, '.omx');
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

  await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
    last_turn_at: now,
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

interface LinuxProcessIdentity {
  startTicks: number;
  cmdline: string | null;
}

interface SessionStaleCheckOptions {
  platform?: NodeJS.Platform;
  isPidAlive?: (pid: number) => boolean;
  readLinuxIdentity?: (pid: number) => LinuxProcessIdentity | null;
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
export async function writeSessionStart(cwd: string, sessionId: string): Promise<void> {
  const stateDir = omxStateDir(cwd);
  await mkdir(stateDir, { recursive: true });
  const linuxIdentity = process.platform === 'linux'
    ? readLinuxProcessIdentity(process.pid)
    : null;

  const state: SessionState = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    cwd,
    pid: process.pid,
    platform: process.platform,
    pid_start_ticks: linuxIdentity?.startTicks,
    pid_cmdline: linuxIdentity?.cmdline ?? undefined,
  };

  await writeFile(sessionPath(cwd), JSON.stringify(state, null, 2));
  await appendToLog(cwd, {
    event: 'session_start',
    session_id: sessionId,
    pid: process.pid,
    timestamp: state.started_at,
  });
}

/**
 * Write session end: archive to history, delete session.json.
 */
export async function writeSessionEnd(cwd: string, sessionId: string): Promise<void> {
  const state = await readSessionState(cwd);
  const endTime = new Date().toISOString();

  // Archive to session history
  const logsDir = omxLogsDir(cwd);
  await mkdir(logsDir, { recursive: true });

  const historyEntry = {
    session_id: sessionId,
    started_at: state?.started_at || 'unknown',
    ended_at: endTime,
    cwd,
    pid: state?.pid || process.pid,
  };

  await appendFile(historyPath(cwd), JSON.stringify(historyEntry) + '\n');

  // Delete session.json
  try {
    await unlink(sessionPath(cwd));
  } catch { /* already gone */ }

  await appendToLog(cwd, {
    event: 'session_end',
    session_id: sessionId,
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
