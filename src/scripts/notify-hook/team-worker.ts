// @ts-nocheck
/**
 * Team worker: heartbeat, idle detection, and leader notification.
 */

import { readFile, writeFile, mkdir, appendFile, rename, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveWorkerNotifyTeamStateRootPath } from '../../team/state-root.js';
import { asNumber, safeString, isTerminalPhase } from './utils.js';
import { readJsonIfExists } from './state-io.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, sendPaneInput } from './team-tmux-guard.js';
import { resolvePaneTarget } from './tmux-injection.js';
import {
  classifyLeaderActionState,
  resolveAllWorkersIdleIntent,
  resolveWorkerIdleIntent,
} from './orchestration-intent.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';

export async function resolveTeamStateDirForWorker(cwd, parsedTeamWorker) {
  return resolveWorkerNotifyTeamStateRootPath(cwd, parsedTeamWorker, process.env);
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
  // Try manifest.v2.json first (preferred), then config.json. Some older or
  // synthetic team states have a partial manifest plus the usable worker pane
  // metadata in config.json, so fall through when a candidate is incomplete.
  const manifestPath = join(stateDir, 'team', teamName, 'manifest.v2.json');
  const configPath = join(stateDir, 'team', teamName, 'config.json');
  const candidatePaths = [manifestPath, configPath].filter((path) => existsSync(path));
  let fallback = null;

  for (const srcPath of candidatePaths) {
    try {
      const raw = await readFile(srcPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const workers = parsed.workers;
      if (!Array.isArray(workers) || workers.length === 0) continue;
      const tmuxSession = safeString(parsed.tmux_session || '').trim();
      const leaderPaneId = safeString(parsed.leader_pane_id || '').trim();
      const result = { workers, tmuxSession, leaderPaneId };
      if (leaderPaneId) return result;
      if (!fallback) fallback = result;
    } catch {
      // Try the next state source.
    }
  }

  return fallback;
}


async function readTeamTaskCounts(stateDir, teamName) {
  const tasksDir = join(stateDir, 'team', teamName, 'tasks');
  const taskCounts = { pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  if (!existsSync(tasksDir)) return taskCounts;

  try {
    const taskFiles = (await readdir(tasksDir))
      .filter((entry) => /^task-\d+\.json$/.test(entry))
      .sort();
    for (const entry of taskFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(tasksDir, entry), 'utf-8'));
        const status = safeString(parsed?.status || 'pending').trim() || 'pending';
        if (Object.hasOwn(taskCounts, status)) taskCounts[status] += 1;
      } catch {
        // ignore malformed task files
      }
    }
  } catch {
    return taskCounts;
  }

  return taskCounts;
}

async function resolveCanonicalLeaderPaneId(_tmuxSession, leaderPaneId) {
  const normalizedLeaderPaneId = safeString(leaderPaneId).trim();
  if (normalizedLeaderPaneId) {
    try {
      const resolved = await resolvePaneTarget({ type: 'pane', value: normalizedLeaderPaneId }, '', '', '', {});
      const paneTarget = safeString(resolved?.paneTarget).trim();
      if (paneTarget) return paneTarget;
    } catch {
      // fall through to tmux session scan
    }
    return normalizedLeaderPaneId;
  }
  return '';
}

async function checkLeaderPaneReadyForWorkerStateReminder(paneTarget) {
  return evaluatePaneInjectionReadiness(paneTarget, {
    skipIfScrolling: true,
    // Worker-state reminders are their own trigger path. They should still
    // queue into a live Codex pane even while the leader is busy or not
    // visibly input-ready; only shell/copy-mode style safety guards remain.
    requireRunningAgent: true,
    requireReady: false,
    requireIdle: false,
  });
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
  orchestrationIntent = '',
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
    orchestration_intent: orchestrationIntent || null,
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
    orchestration_intent: orchestrationIntent || null,
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
  const canonicalLeaderPaneId = await resolveCanonicalLeaderPaneId(tmuxSession, leaderPaneId);

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

  const taskCounts = await readTeamTaskCounts(stateDir, teamName);
  const leaderActionState = classifyLeaderActionState({
    allWorkersIdle: allIdle,
    workerPanesAlive: snapshots.length > 0,
    taskCounts,
  });
  const orchestrationIntent = resolveAllWorkersIdleIntent(leaderActionState);

  if (!canonicalLeaderPaneId) {
    const nextIdleState = {
      ...idleState,
      last_notified_at_ms: nowMs,
      last_notified_at: nowIso,
      worker_count: workers.length,
      orchestration_intent: orchestrationIntent,
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
      leaderPaneId: canonicalLeaderPaneId,
      orchestrationIntent,
    });
    return;
  }

  const N = workers.length;
  const nextAction = `Run \`omx team status ${teamName}\` now, read unread worker messages, then assign the next concrete task, reconcile results, or shut the team down.`;
  const message = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle. ${nextAction} ${DEFAULT_MARKER}`;
  const tmuxTarget = canonicalLeaderPaneId;
  const paneGuard = await checkLeaderPaneReadyForWorkerStateReminder(tmuxTarget);
  if (!paneGuard.ok) {
    const nextIdleState = {
      ...idleState,
      last_notified_at_ms: nowMs,
      last_notified_at: nowIso,
      worker_count: N,
      orchestration_intent: orchestrationIntent,
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
      leaderPaneId: canonicalLeaderPaneId,
      orchestrationIntent,
    });
    return;
  }

  try {
    const sendResult = await sendPaneInput({
      paneTarget: tmuxTarget,
      prompt: message,
      submitKeyPresses: 2,
      submitDelayMs: 100,
    });
    if (!sendResult.ok) throw new Error(sendResult.error || sendResult.reason || 'send_failed');

    const nextIdleState = {
      ...idleState,
      last_notified_at_ms: nowMs,
      last_notified_at: nowIso,
      worker_count: N,
      orchestration_intent: orchestrationIntent,
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
        orchestration_intent: orchestrationIntent,
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
      orchestration_intent: orchestrationIntent,
    });
  } catch (err) {
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'all_workers_idle_notification',
      team: teamName,
      tmux_target: tmuxTarget,
      worker: workerName,
      orchestration_intent: orchestrationIntent,
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

  // Fire when a worker leaves active work into an idle-ish terminal state.
  if (currentState !== 'idle' && currentState !== 'done') return;
  if (!statusFresh) return;
  if (prevState === 'idle' || prevState === 'done') return;
  const orchestrationIntent = resolveWorkerIdleIntent(currentState);

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
  const canonicalLeaderPaneId = await resolveCanonicalLeaderPaneId(tmuxSession, leaderPaneId);

  if (!canonicalLeaderPaneId) {
    await emitLeaderPaneMissingDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      sourceType: 'worker_idle',
      tmuxSession,
      leaderPaneId: canonicalLeaderPaneId,
      orchestrationIntent,
    });
    return;
  }
  const tmuxTarget = canonicalLeaderPaneId;
  const paneGuard = await checkLeaderPaneReadyForWorkerStateReminder(tmuxTarget);
  if (!paneGuard.ok) {
    try {
      const tmpPath = cooldownPath + '.tmp.' + process.pid;
      await writeFile(tmpPath, JSON.stringify({
        last_notified_at_ms: nowMs,
        last_notified_at: nowIso,
        prev_state: prevState,
        orchestration_intent: orchestrationIntent,
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
      leaderPaneId: canonicalLeaderPaneId,
      orchestrationIntent,
    });
    return;
  }

  // Build notification message with context
  const parts = [`[OMX] ${workerName} ${currentState}`];
  if (prevState && prevState !== 'unknown') parts.push(`(was: ${prevState})`);
  if (currentTaskId) parts.push(`task: ${currentTaskId}`);
  if (currentReason) parts.push(`reason: ${currentReason}`);
  parts.push(`Next: read ${workerName}'s latest message/output, then assign the next concrete step or mark the task complete.`);
  const message = `${parts.join('. ')}. ${DEFAULT_MARKER}`;

  try {
    const sendResult = await sendPaneInput({
      paneTarget: tmuxTarget,
      prompt: message,
      submitKeyPresses: 2,
      submitDelayMs: 100,
    });
    if (!sendResult.ok) throw new Error(sendResult.error || sendResult.reason || 'send_failed');

    // Update cooldown state
    try {
      const tmpPath = cooldownPath + '.tmp.' + process.pid;
      await writeFile(tmpPath, JSON.stringify({
        last_notified_at_ms: nowMs,
        last_notified_at: nowIso,
        prev_state: prevState,
        orchestration_intent: orchestrationIntent,
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
        orchestration_intent: orchestrationIntent,
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
      orchestration_intent: orchestrationIntent,
    });
  } catch (err) {
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'worker_idle_notification',
      team: teamName,
      tmux_target: tmuxTarget,
      worker: workerName,
      orchestration_intent: orchestrationIntent,
      error: err instanceof Error ? err.message : safeString(err),
    }).catch(() => {});
  }
}
