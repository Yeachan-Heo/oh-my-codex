/**
 * Team worker: heartbeat, idle detection, and leader notification.
 */

import { readFile, writeFile, mkdir, appendFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString } from './utils.js';
import { readJsonIfExists } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';

export function parseTeamWorkerEnv(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}

export function resolveAllWorkersIdleCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_ALL_IDLE_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  // Default: 60 seconds. Guard against unreasonable values.
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return 60_000;
}

export async function readWorkerStatusState(stateDir, teamName, workerName) {
  if (!workerName) return 'unknown';
  const statusPath = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
  try {
    if (!existsSync(statusPath)) return 'unknown';
    const raw = await readFile(statusPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.state === 'string') return parsed.state;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function readTeamWorkersForIdleCheck(stateDir, teamName) {
  // Try manifest.v2.json first (preferred), then config.json
  const manifestPath = join(stateDir, 'team', teamName, 'manifest.v2.json');
  const configPath = join(stateDir, 'team', teamName, 'config.json');
  const srcPath = existsSync(manifestPath) ? manifestPath : existsSync(configPath) ? configPath : null;
  if (!srcPath) return null;

  try {
    const raw = await readFile(srcPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const workers = parsed.workers;
    if (!Array.isArray(workers) || workers.length === 0) return null;
    const tmuxSession = safeString(parsed.tmux_session || '').trim();
    return { workers, tmuxSession };
  } catch {
    return null;
  }
}

export async function updateWorkerHeartbeat(stateDir, teamName, workerName) {
  const heartbeatPath = join(stateDir, 'team', teamName, 'workers', workerName, 'heartbeat.json');
  let turnCount = 0;
  try {
    const existing = JSON.parse(await readFile(heartbeatPath, 'utf-8'));
    turnCount = existing.turn_count || 0;
  } catch { /* first heartbeat or malformed */ }
  const heartbeat = {
    pid: process.ppid || process.pid,
    last_turn_at: new Date().toISOString(),
    turn_count: turnCount + 1,
    alive: true,
  };
  // Atomic write: tmp + rename
  const tmpPath = heartbeatPath + '.tmp.' + process.pid;
  await writeFile(tmpPath, JSON.stringify(heartbeat, null, 2));
  await rename(tmpPath, heartbeatPath);
}

export async function maybeNotifyLeaderAllWorkersIdle({ cwd, stateDir, logsDir, parsedTeamWorker }) {
  const { teamName, workerName } = parsedTeamWorker;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Only trigger check when this worker is idle
  const myState = await readWorkerStatusState(stateDir, teamName, workerName);
  if (myState !== 'idle') return;

  // Read team config to get worker list and leader tmux target
  const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
  if (!teamInfo) return;
  const { workers, tmuxSession } = teamInfo;
  if (!tmuxSession) return;

  // Check cooldown to prevent notification spam
  const idleStatePath = join(stateDir, 'team', teamName, 'all-workers-idle.json');
  const idleState = (await readJsonIfExists(idleStatePath, null)) || {};
  const cooldownMs = resolveAllWorkersIdleCooldownMs();
  const lastNotifiedMs = asNumber(idleState.last_notified_at_ms) ?? 0;
  if ((nowMs - lastNotifiedMs) < cooldownMs) return;

  // Check if ALL workers are idle (or done)
  const states = await Promise.all(
    workers.map(w => readWorkerStatusState(stateDir, teamName, safeString(w && w.name ? w.name : '')))
  );
  const allIdle = states.length > 0 && states.every(s => s === 'idle' || s === 'done');
  if (!allIdle) return;

  const N = workers.length;
  const message = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle. Ready for next instructions. ${DEFAULT_MARKER}`;

  try {
    await runProcess('tmux', ['send-keys', '-t', tmuxSession, '-l', message], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', tmuxSession, 'C-m'], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', tmuxSession, 'C-m'], 3000);

    const nextIdleState = {
      ...idleState,
      last_notified_at_ms: nowMs,
      last_notified_at: nowIso,
      worker_count: N,
    };
    await writeFile(idleStatePath, JSON.stringify(nextIdleState, null, 2)).catch(() => {});

    const eventsDir = join(stateDir, 'team', teamName, 'events');
    const eventsPath = join(eventsDir, 'events.ndjson');
    try {
      await mkdir(eventsDir, { recursive: true });
      const event = {
        event_id: `all-idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        team: teamName,
        type: 'all_workers_idle',
        worker: workerName,
        worker_count: N,
        created_at: nowIso,
      };
      await appendFile(eventsPath, JSON.stringify(event) + '\n');
    } catch { /* best effort */ }

    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'all_workers_idle_notification',
      team: teamName,
      tmux_target: tmuxSession,
      worker: workerName,
      worker_count: N,
    });
  } catch (err) {
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'all_workers_idle_notification',
      team: teamName,
      tmux_target: tmuxSession,
      worker: workerName,
      error: err instanceof Error ? err.message : safeString(err),
    }).catch(() => {});
  }
}
