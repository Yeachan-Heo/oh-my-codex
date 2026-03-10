/**
 * Team worker: heartbeat, idle detection, and leader notification.
 */

import { readFile, writeFile, mkdir, appendFile, rename, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { asNumber, safeString, isTerminalPhase } from './utils.js';
import { readJsonIfExists } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { checkPaneReadyForTeamSendKeys } from './team-tmux-guard.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';

async function readTeamStateRootFromJson(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    const value = parsed && typeof parsed.team_state_root === 'string'
      ? parsed.team_state_root.trim()
      : '';
    return value ? value : null;
  } catch {
    return null;
  }
}

export async function resolveTeamStateDirForWorker(cwd, parsedTeamWorker) {
  const explicitStateRoot = safeString(process.env.OMX_TEAM_STATE_ROOT || '').trim();
  if (explicitStateRoot) {
    return resolvePath(cwd, explicitStateRoot);
  }

  const teamName = parsedTeamWorker.teamName;
  const workerName = parsedTeamWorker.workerName;
  const leaderCwd = safeString(process.env.OMX_TEAM_LEADER_CWD || '').trim();

  const candidateStateDirs = [];
  if (leaderCwd) {
    candidateStateDirs.push(join(resolvePath(leaderCwd), '.omx', 'state'));
  }
  candidateStateDirs.push(join(cwd, '.omx', 'state'));

  for (const candidateStateDir of candidateStateDirs) {
    const teamRoot = join(candidateStateDir, 'team', teamName);
    if (!existsSync(teamRoot)) continue;

    const identityRoot = await readTeamStateRootFromJson(
      join(teamRoot, 'workers', workerName, 'identity.json'),
    );
    if (identityRoot) return resolvePath(cwd, identityRoot);

    const manifestRoot = await readTeamStateRootFromJson(join(teamRoot, 'manifest.v2.json'));
    if (manifestRoot) return resolvePath(cwd, manifestRoot);

    const configRoot = await readTeamStateRootFromJson(join(teamRoot, 'config.json'));
    if (configRoot) return resolvePath(cwd, configRoot);

    return candidateStateDir;
  }

  return join(cwd, '.omx', 'state');
}

export function parseTeamWorkerEnv(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}

export function resolveWorkerIdleNotifyEnabled() {
  const raw = safeString(process.env.OMX_TEAM_WORKER_IDLE_NOTIFY || '').trim().toLowerCase();
  // Default: enabled. Disable with "false", "0", or "off".
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  return true;
}

export function resolveWorkerIdleCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_WORKER_IDLE_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds. Guard against unreasonable values.
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return 30_000;
}

export function resolveAllWorkersIdleCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_ALL_IDLE_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  // Default: 60 seconds. Guard against unreasonable values.
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return 60_000;
}

export function resolveStatusStaleMs() {
  const raw = safeString(process.env.OMX_TEAM_STATUS_STALE_MS || '');
  const parsed = asNumber(raw);
  if (parsed !== null && parsed >= 5_000 && parsed <= 60 * 60_000) return parsed;
  return 120_000;
}

export function resolveHeartbeatStaleMs() {
  const raw = safeString(process.env.OMX_TEAM_HEARTBEAT_STALE_MS || '');
  const parsed = asNumber(raw);
  if (parsed !== null && parsed >= 5_000 && parsed <= 60 * 60_000) return parsed;
  return 180_000;
}

function parseIsoMs(value) {
  const normalized = safeString(value).trim();
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function isFreshIso(value, maxAgeMs, nowMs) {
  const ts = parseIsoMs(value);
  if (!Number.isFinite(ts)) return false;
  return (nowMs - ts) <= maxAgeMs;
}

function resolveTerminalAtFromPhaseDoc(parsed, fallbackIso) {
  const transitions = Array.isArray(parsed && parsed.transitions) ? parsed.transitions : [];
  for (let idx = transitions.length - 1; idx >= 0; idx -= 1) {
    const at = safeString(transitions[idx] && transitions[idx].at).trim();
    if (at) return at;
  }
  const updatedAt = safeString(parsed && parsed.updated_at).trim();
  return updatedAt || fallbackIso;
}

async function readTeamPhaseSnapshot(stateDir, teamName, nowIso = new Date().toISOString()) {
  const phasePath = join(stateDir, 'team', teamName, 'phase.json');
  try {
    if (!existsSync(phasePath)) return { currentPhase: '', terminal: false, completedAt: '' };
    const parsed = JSON.parse(await readFile(phasePath, 'utf-8'));
    const currentPhase = safeString(parsed && parsed.current_phase).trim();
    return {
      currentPhase,
      terminal: isTerminalPhase(currentPhase),
      completedAt: resolveTerminalAtFromPhaseDoc(parsed, nowIso),
    };
  } catch {
    return { currentPhase: '', terminal: false, completedAt: '' };
  }
}

async function syncScopedTeamStateFromPhase(stateDir, teamName, phaseSnapshot, nowIso = new Date().toISOString()) {
  if (!phaseSnapshot || !phaseSnapshot.terminal) return false;
  const teamStatePath = join(stateDir, 'team-state.json');
  try {
    if (!existsSync(teamStatePath)) return false;
    const parsed = JSON.parse(await readFile(teamStatePath, 'utf-8'));
    if (!parsed || safeString(parsed.team_name).trim() !== teamName) return false;

    let changed = false;
    if (parsed.active !== false) {
      parsed.active = false;
      changed = true;
    }
    if (safeString(parsed.current_phase).trim() !== phaseSnapshot.currentPhase) {
      parsed.current_phase = phaseSnapshot.currentPhase;
      changed = true;
    }
    if (safeString(parsed.completed_at).trim() !== phaseSnapshot.completedAt && phaseSnapshot.completedAt) {
      parsed.completed_at = phaseSnapshot.completedAt;
      changed = true;
    }
    if (safeString(parsed.last_turn_at).trim() !== nowIso) {
      parsed.last_turn_at = nowIso;
      changed = true;
    }

    if (changed) {
      await writeFile(teamStatePath, JSON.stringify(parsed, null, 2));
    }
    return changed;
  } catch {
    return false;
  }
}

async function readWorkerStatusSnapshot(stateDir, teamName, workerName, nowMs = Date.now()) {
  const statusPath = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
  try {
    if (!existsSync(statusPath)) return { state: 'unknown', updated_at: null, fresh: false };
    const raw = await readFile(statusPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const state = parsed && typeof parsed.state === 'string' ? parsed.state : 'unknown';
    const updatedAt = parsed && typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
    let fresh = false;
    if (updatedAt) {
      fresh = isFreshIso(updatedAt, resolveStatusStaleMs(), nowMs);
    } else {
      // Fallback: if worker omits updated_at, use file mtime as staleness proxy
      try {
        const st = await stat(statusPath);
        fresh = (nowMs - st.mtimeMs) <= resolveStatusStaleMs();
      } catch {
        fresh = false;
      }
    }
    return { state, updated_at: updatedAt, fresh };
  } catch {
    return { state: 'unknown', updated_at: null, fresh: false };
  }
}

async function readWorkerHeartbeatSnapshot(stateDir, teamName, workerName, nowMs = Date.now()) {
  const heartbeatPath = join(stateDir, 'team', teamName, 'workers', workerName, 'heartbeat.json');
  try {
    if (!existsSync(heartbeatPath)) return { last_turn_at: null, fresh: true, missing: true };
    const raw = await readFile(heartbeatPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const lastTurnAt = parsed && typeof parsed.last_turn_at === 'string' ? parsed.last_turn_at : null;
    const fresh = isFreshIso(lastTurnAt, resolveHeartbeatStaleMs(), nowMs);
    return { last_turn_at: lastTurnAt, fresh, missing: false };
  } catch {
    return { last_turn_at: null, fresh: false, missing: false };
  }
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
    const leaderPaneId = safeString(parsed.leader_pane_id || '').trim();
    return { workers, tmuxSession, leaderPaneId };
  } catch {
    return null;
  }
}

async function emitLeaderPaneMissingDeferred({
  stateDir,
  logsDir,
  teamName,
  workerName,
  tmuxSession,
  leaderPaneId,
  reason = 'leader_pane_missing_no_injection',
  paneCurrentCommand = '',
  sourceType = 'unknown',
}) {
  const nowIso = new Date().toISOString();
  await logTmuxHookEvent(logsDir, {
    timestamp: nowIso,
    type: 'leader_notification_deferred',
    team: teamName,
    worker: workerName,
    to_worker: 'leader-fixed',
    reason,
    leader_pane_id: leaderPaneId || null,
    tmux_session: tmuxSession || null,
    tmux_injection_attempted: false,
    pane_current_command: paneCurrentCommand || null,
    source_type: sourceType,
  }).catch(() => {});

  const eventsDir = join(stateDir, 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  await mkdir(eventsDir, { recursive: true }).catch(() => {});
  const event = {
    event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    team: teamName,
    type: 'leader_notification_deferred',
    worker: workerName,
    to_worker: 'leader-fixed',
    reason,
    created_at: nowIso,
    leader_pane_id: leaderPaneId || null,
    tmux_session: tmuxSession || null,
    tmux_injection_attempted: false,
    pane_current_command: paneCurrentCommand || null,
    source_type: sourceType,
  };
  await appendFile(eventsPath, JSON.stringify(event) + '\n').catch(() => {});
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
  const phaseSnapshot = await readTeamPhaseSnapshot(stateDir, teamName, nowIso);
  if (phaseSnapshot.terminal) {
    await syncScopedTeamStateFromPhase(stateDir, teamName, phaseSnapshot, nowIso);
    return;
  }

  // Only trigger check when this worker is idle
  const mySnapshot = await readWorkerStatusSnapshot(stateDir, teamName, workerName, nowMs);
  if (mySnapshot.state !== 'idle' || !mySnapshot.fresh) return;
  const myHeartbeat = await readWorkerHeartbeatSnapshot(stateDir, teamName, workerName, nowMs);
  if (!myHeartbeat.fresh) return;

  // Read team config to get worker list and leader tmux target
  const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
  if (!teamInfo) return;
  const { workers, tmuxSession, leaderPaneId } = teamInfo;

  // Check cooldown to prevent notification spam
  const idleStatePath = join(stateDir, 'team', teamName, 'all-workers-idle.json');
  const idleState = (await readJsonIfExists(idleStatePath, null)) || {};
  const cooldownMs = resolveAllWorkersIdleCooldownMs();
  const lastNotifiedMs = asNumber(idleState.last_notified_at_ms) ?? 0;
  if ((nowMs - lastNotifiedMs) < cooldownMs) return;

  // Check if ALL workers are idle (or done)
  const snapshots = await Promise.all(
    workers.map(async (w) => {
      const worker = safeString(w && w.name ? w.name : '');
      const status = await readWorkerStatusSnapshot(stateDir, teamName, worker, nowMs);
      const heartbeat = await readWorkerHeartbeatSnapshot(stateDir, teamName, worker, nowMs);
      return { worker, status, heartbeat };
    }),
  );
  const allIdle = snapshots.length > 0 && snapshots.every(({ status, heartbeat }) =>
    (status.state === 'idle' || status.state === 'done') && status.fresh && heartbeat.fresh
  );
  if (!allIdle) return;

  if (!leaderPaneId) {
    const nextIdleState = {
      ...idleState,
      last_notified_at_ms: nowMs,
      last_notified_at: nowIso,
      worker_count: workers.length,
      delivery: 'deferred',
    };
    await writeFile(idleStatePath, JSON.stringify(nextIdleState, null, 2)).catch(() => {});
    await emitLeaderPaneMissingDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      sourceType: 'all_workers_idle',
      tmuxSession,
      leaderPaneId,
    });
    return;
  }

  const N = workers.length;
  const message = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle. Ready for next instructions. ${DEFAULT_MARKER}`;
  const tmuxTarget = leaderPaneId;
  const paneGuard = await checkPaneReadyForTeamSendKeys(tmuxTarget);
  if (!paneGuard.ok) {
    const nextIdleState = {
      ...idleState,
      last_notified_at_ms: nowMs,
      last_notified_at: nowIso,
      worker_count: N,
      delivery: 'deferred_shell',
      pane_current_command: paneGuard.paneCurrentCommand || null,
    };
    await writeFile(idleStatePath, JSON.stringify(nextIdleState, null, 2)).catch(() => {});
    await emitLeaderPaneMissingDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      reason: LEADER_PANE_SHELL_NO_INJECTION_REASON,
      paneCurrentCommand: paneGuard.paneCurrentCommand,
      sourceType: 'all_workers_idle',
      tmuxSession,
      leaderPaneId,
    });
    return;
  }

  try {
    await runProcess('tmux', ['send-keys', '-t', tmuxTarget, '-l', message], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', tmuxTarget, 'C-m'], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', tmuxTarget, 'C-m'], 3000);

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
      tmux_target: tmuxTarget,
      worker: workerName,
      worker_count: N,
    });
  } catch (err) {
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'all_workers_idle_notification',
      team: teamName,
      tmux_target: tmuxTarget,
      worker: workerName,
      error: err instanceof Error ? err.message : safeString(err),
    }).catch(() => {});
  }
}

export async function maybeNotifyLeaderWorkerIdle({ cwd, stateDir, logsDir, parsedTeamWorker }) {
  if (!resolveWorkerIdleNotifyEnabled()) return;

  const { teamName, workerName } = parsedTeamWorker;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const phaseSnapshot = await readTeamPhaseSnapshot(stateDir, teamName, nowIso);
  if (phaseSnapshot.terminal) {
    await syncScopedTeamStateFromPhase(stateDir, teamName, phaseSnapshot, nowIso);
    return;
  }

  // Read current worker status (full object for task context)
  const workerDir = join(stateDir, 'team', teamName, 'workers', workerName);
  const statusPath = join(workerDir, 'status.json');
  let currentState = 'unknown';
  let currentTaskId = '';
  let currentReason = '';
  let statusFresh = false;
  try {
    if (existsSync(statusPath)) {
      const parsed = JSON.parse(await readFile(statusPath, 'utf-8'));
      if (parsed && typeof parsed.state === 'string') currentState = parsed.state;
      if (parsed && typeof parsed.current_task_id === 'string') currentTaskId = parsed.current_task_id;
      if (parsed && typeof parsed.reason === 'string') currentReason = parsed.reason;
      const updatedAtField = parsed && typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
      if (updatedAtField) {
        statusFresh = isFreshIso(updatedAtField, resolveStatusStaleMs(), nowMs);
      } else {
        // Fallback: use file mtime when worker omits updated_at
        try {
          const st = await stat(statusPath);
          statusFresh = (nowMs - st.mtimeMs) <= resolveStatusStaleMs();
        } catch {
          statusFresh = false;
        }
      }
    }
  } catch { /* ignore */ }

  // Read and update previous state for transition detection
  const prevStatePath = join(workerDir, 'prev-notify-state.json');
  let prevState = 'unknown';
  try {
    if (existsSync(prevStatePath)) {
      const parsed = JSON.parse(await readFile(prevStatePath, 'utf-8'));
      if (parsed && typeof parsed.state === 'string') prevState = parsed.state;
    }
  } catch { /* ignore */ }

  // Always update prev state (atomic write)
  try {
    await mkdir(workerDir, { recursive: true });
    const tmpPath = prevStatePath + '.tmp.' + process.pid;
    await writeFile(tmpPath, JSON.stringify({ state: currentState, updated_at: nowIso }, null, 2));
    await rename(tmpPath, prevStatePath);
  } catch { /* best effort */ }

  // Only fire on working->idle transition (non-idle to idle)
  if (currentState !== 'idle') return;
  if (!statusFresh) return;
  if (prevState === 'idle' || prevState === 'done') return;

  const heartbeat = await readWorkerHeartbeatSnapshot(stateDir, teamName, workerName, nowMs);
  if (!heartbeat.fresh) return;

  // Check per-worker cooldown
  const cooldownPath = join(workerDir, 'worker-idle-notify.json');
  const cooldownMs = resolveWorkerIdleCooldownMs();
  let lastNotifiedMs = 0;
  try {
    if (existsSync(cooldownPath)) {
      const parsed = JSON.parse(await readFile(cooldownPath, 'utf-8'));
      lastNotifiedMs = asNumber(parsed && parsed.last_notified_at_ms) ?? 0;
    }
  } catch { /* ignore */ }
  if ((nowMs - lastNotifiedMs) < cooldownMs) return;

  // Read team config for tmux target
  const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
  if (!teamInfo) return;
  const { tmuxSession, leaderPaneId } = teamInfo;

  if (!leaderPaneId) {
    await emitLeaderPaneMissingDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      sourceType: 'worker_idle',
      tmuxSession,
      leaderPaneId,
    });
    return;
  }
  const tmuxTarget = leaderPaneId;
  const paneGuard = await checkPaneReadyForTeamSendKeys(tmuxTarget);
  if (!paneGuard.ok) {
    try {
      const tmpPath = cooldownPath + '.tmp.' + process.pid;
      await writeFile(tmpPath, JSON.stringify({
        last_notified_at_ms: nowMs,
        last_notified_at: nowIso,
        prev_state: prevState,
        delivery: 'deferred_shell',
        pane_current_command: paneGuard.paneCurrentCommand || null,
      }, null, 2));
      await rename(tmpPath, cooldownPath);
    } catch { /* best effort */ }
    await emitLeaderPaneMissingDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      reason: LEADER_PANE_SHELL_NO_INJECTION_REASON,
      paneCurrentCommand: paneGuard.paneCurrentCommand,
      sourceType: 'worker_idle',
      tmuxSession,
      leaderPaneId,
    });
    return;
  }

  // Build notification message with context
  const parts = [`[OMX] ${workerName} idle`];
  if (prevState && prevState !== 'unknown') parts.push(`(was: ${prevState})`);
  if (currentTaskId) parts.push(`task: ${currentTaskId}`);
  if (currentReason) parts.push(`reason: ${currentReason}`);
  const message = `${parts.join('. ')}. ${DEFAULT_MARKER}`;

  try {
    await runProcess('tmux', ['send-keys', '-t', tmuxTarget, '-l', message], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', tmuxTarget, 'C-m'], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', tmuxTarget, 'C-m'], 3000);

    // Update cooldown state
    try {
      const tmpPath = cooldownPath + '.tmp.' + process.pid;
      await writeFile(tmpPath, JSON.stringify({
        last_notified_at_ms: nowMs,
        last_notified_at: nowIso,
        prev_state: prevState,
      }, null, 2));
      await rename(tmpPath, cooldownPath);
    } catch { /* best effort */ }

    // Write event to events.ndjson
    const eventsDir = join(stateDir, 'team', teamName, 'events');
    const eventsPath = join(eventsDir, 'events.ndjson');
    try {
      await mkdir(eventsDir, { recursive: true });
      const event = {
        event_id: `worker-idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        team: teamName,
        type: 'worker_idle',
        worker: workerName,
        prev_state: prevState,
        task_id: currentTaskId || null,
        reason: currentReason || null,
        created_at: nowIso,
      };
      await appendFile(eventsPath, JSON.stringify(event) + '\n');
    } catch { /* best effort */ }

    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'worker_idle_notification',
      team: teamName,
      tmux_target: tmuxTarget,
      worker: workerName,
      prev_state: prevState,
      task_id: currentTaskId || null,
    });
  } catch (err) {
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'worker_idle_notification',
      team: teamName,
      tmux_target: tmuxTarget,
      worker: workerName,
      error: err instanceof Error ? err.message : safeString(err),
    }).catch(() => {});
  }
}
