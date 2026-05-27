// @ts-nocheck
/**
 * Native worker Stop leader nudge.
 *
 * This path is intentionally tied to a resolved, allowed native Stop event.
 * It must not depend on idle/heartbeat freshness or inferred progress stalls.
 */

import { existsSync } from 'fs';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { DEFAULT_MARKER, paneHasActiveTask } from '../tmux-hook-engine.js';
import { appendTeamDeliveryLog } from '../../team/delivery-log.js';
import { safeString, asNumber, isTerminalPhase } from './utils.js';
import { readJsonIfExists } from './state-io.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, queuePaneInput, sendPaneInput } from './team-tmux-guard.js';
import { resolvePaneTarget } from './tmux-injection.js';
import { readTeamWorkersForIdleCheck } from './team-worker.js';

const STOP_NUDGE_COOLDOWN_MS = 30_000;
const SOURCE_TYPE = 'worker_stop';
const LEADER_PANE_MISSING_NO_INJECTION_REASON = 'leader_pane_missing_no_injection';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';
const TEAM_SHUTDOWN_NO_INJECTION_REASON = 'team_state_gone_or_shutdown';
const TEAM_LOCK_HELD_REASON = 'suppressed_team_lock_held';

function escapeRegExp(value) {
  return safeString(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function teamStopNudgeAlreadyQueued(paneCapture, teamName) {
  const capture = safeString(paneCapture);
  const normalizedTeamName = safeString(teamName).trim();
  if (!capture || !normalizedTeamName) return false;
  const teamPattern = escapeRegExp(normalizedTeamName);
  const stopNudgePattern = new RegExp(
    `\\[OMX\\]\\s+worker-\\d+\\s+native Stop allowed\\.[\\s\\S]*?omx team status ${teamPattern}(?:\\s|\`|,|\\.)`,
    'i',
  );
  return stopNudgePattern.test(capture);
}

async function teamStateAllowsWorkerStopNudge(stateDir, teamName) {
  const teamDir = join(stateDir, 'team', teamName);
  if (!existsSync(teamDir)) return false;
  if (existsSync(join(teamDir, 'shutdown.json'))) return false;

  const phase = await readJsonIfExists(join(teamDir, 'phase.json'), null);
  const currentPhase = safeString(phase?.current_phase || phase?.phase || '').trim();
  if (currentPhase && isTerminalPhase(currentPhase)) return false;

  return true;
}

async function acquireTeamStopNudgeLock(teamDir, nowMs, cooldownMs) {
  const lockDir = join(teamDir, 'worker-stop-nudge.lock');
  const staleAfterMs = Math.max(cooldownMs, 30_000);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        acquired_at_ms: nowMs,
        acquired_at: new Date(nowMs).toISOString(),
      }, null, 2)).catch(() => {});
      return { acquired: true, lockDir };
    } catch (error) {
      if (error?.code === 'ENOENT') return { acquired: false, reason: TEAM_SHUTDOWN_NO_INJECTION_REASON };
      if (error?.code !== 'EEXIST') return { acquired: false, reason: TEAM_LOCK_HELD_REASON };

      try {
        const lockStat = await stat(lockDir);
        if ((nowMs - lockStat.mtimeMs) >= staleAfterMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      return { acquired: false, reason: TEAM_LOCK_HELD_REASON };
    }
  }

  return { acquired: false, reason: TEAM_LOCK_HELD_REASON };
}

async function releaseTeamStopNudgeLock(lockDir) {
  if (!lockDir) return;
  await rm(lockDir, { recursive: true, force: true }).catch(() => {});
}

async function writeStopNudgeStateIfTeamExists(teamDir, statePath, state) {
  if (!existsSync(teamDir)) return false;
  await writeStopNudgeState(statePath, state);
  return true;
}

function resolveWorkerStopCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_WORKER_STOP_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return STOP_NUDGE_COOLDOWN_MS;
}

async function resolveCanonicalLeaderPaneId(leaderPaneId) {
  const normalizedLeaderPaneId = safeString(leaderPaneId).trim();
  if (!normalizedLeaderPaneId) return '';
  try {
    const resolved = await resolvePaneTarget({ type: 'pane', value: normalizedLeaderPaneId }, '', '', '', {});
    const paneTarget = safeString(resolved?.paneTarget).trim();
    if (paneTarget) return paneTarget;
  } catch {
    // Fall back to the recorded pane id; readiness guard remains authoritative.
  }
  return normalizedLeaderPaneId;
}

async function appendWorkerStopEvent(stateDir, teamName, event) {
  const eventsDir = join(stateDir, 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  await mkdir(eventsDir, { recursive: true }).catch(() => {});
  await appendFile(eventsPath, JSON.stringify(event) + '\n').catch(() => {});
}

async function writeStopNudgeState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true }).catch(() => {});
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, statePath);
}

async function recordDeferred({
  stateDir,
  logsDir,
  teamName,
  workerName,
  statePath,
  nextState,
  reason,
  tmuxSession,
  leaderPaneId,
  paneCurrentCommand = '',
}) {
  const nowIso = nextState.last_notified_at;
  await writeStopNudgeState(statePath, {
    ...nextState,
    delivery: 'deferred',
    reason,
    pane_current_command: paneCurrentCommand || null,
  }).catch(() => {});
  await appendWorkerStopEvent(stateDir, teamName, {
    event_id: `worker-stop-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    team: teamName,
    type: 'worker_stop_leader_nudge',
    worker: workerName,
    to_worker: 'leader-fixed',
    delivery: 'deferred',
    reason,
    created_at: nowIso,
    source_type: SOURCE_TYPE,
  });
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
    source_type: SOURCE_TYPE,
  }).catch(() => {});
  await appendTeamDeliveryLog(logsDir, {
    event: 'nudge_triggered',
    source: SOURCE_TYPE,
    team: teamName,
    from_worker: workerName,
    to_worker: 'leader-fixed',
    transport: 'none',
    result: 'deferred',
    reason,
  }).catch(() => {});
}

export async function maybeNudgeLeaderForAllowedWorkerStop({
  stateDir,
  logsDir,
  workerContext,
}) {
  const { teamName, workerName } = workerContext || {};
  if (!teamName || !workerName || !stateDir) return { ok: false, result: 'unresolved' };

  const teamDir = join(stateDir, 'team', teamName);
  const workerDir = join(teamDir, 'workers', workerName);
  const statePath = join(workerDir, 'worker-stop-nudge.json');
  const teamStatePath = join(teamDir, 'worker-stop-nudge.json');
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownMs = resolveWorkerStopCooldownMs();
  const nextState = {
    last_notified_at_ms: nowMs,
    last_notified_at: nowIso,
    team: teamName,
    worker: workerName,
    source_type: SOURCE_TYPE,
  };
  let tmuxSession = '';
  let leaderPaneId = '';

  if (!(await teamStateAllowsWorkerStopNudge(stateDir, teamName))) {
    return { ok: true, result: TEAM_SHUTDOWN_NO_INJECTION_REASON };
  }

  const lock = await acquireTeamStopNudgeLock(teamDir, nowMs, cooldownMs);
  if (!lock.acquired) {
    return { ok: true, result: lock.reason || TEAM_LOCK_HELD_REASON };
  }

  try {
    if (!(await teamStateAllowsWorkerStopNudge(stateDir, teamName))) {
      return { ok: true, result: TEAM_SHUTDOWN_NO_INJECTION_REASON };
    }

  const teamExisting = (await readJsonIfExists(teamStatePath, null)) || {};
  const teamLastNotifiedMs = asNumber(teamExisting.last_notified_at_ms) ?? 0;
  if ((nowMs - teamLastNotifiedMs) < cooldownMs) {
    return { ok: true, result: 'suppressed_team_cooldown' };
  }

  const existing = (await readJsonIfExists(statePath, null)) || {};
  const lastNotifiedMs = asNumber(existing.last_notified_at_ms) ?? 0;
  if ((nowMs - lastNotifiedMs) < cooldownMs) {
    return { ok: true, result: 'suppressed_cooldown' };
  }

  const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
  if (!teamInfo) return { ok: false, result: 'unresolved' };
  ({ tmuxSession, leaderPaneId } = teamInfo);
  const tmuxTarget = await resolveCanonicalLeaderPaneId(leaderPaneId);

  if (!tmuxTarget) {
    if (!(await teamStateAllowsWorkerStopNudge(stateDir, teamName))) {
      return { ok: true, result: TEAM_SHUTDOWN_NO_INJECTION_REASON };
    }
    await recordDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      statePath,
      nextState,
      reason: LEADER_PANE_MISSING_NO_INJECTION_REASON,
      tmuxSession,
      leaderPaneId,
    });
    return { ok: true, result: 'deferred' };
  }

  const paneGuard = await evaluatePaneInjectionReadiness(tmuxTarget, {
    skipIfScrolling: true,
    requireRunningAgent: true,
    requireReady: false,
    requireIdle: false,
  });
  if (!paneGuard.ok) {
    if (!(await teamStateAllowsWorkerStopNudge(stateDir, teamName))) {
      return { ok: true, result: TEAM_SHUTDOWN_NO_INJECTION_REASON };
    }
    await recordDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      statePath,
      nextState,
      reason: paneGuard.reason === 'pane_running_shell' ? LEADER_PANE_SHELL_NO_INJECTION_REASON : paneGuard.reason,
      tmuxSession,
      leaderPaneId,
      paneCurrentCommand: paneGuard.paneCurrentCommand,
    });
    return { ok: true, result: 'deferred' };
  }

  if (!(await teamStateAllowsWorkerStopNudge(stateDir, teamName))) {
    return { ok: true, result: TEAM_SHUTDOWN_NO_INJECTION_REASON };
  }

  if (teamStopNudgeAlreadyQueued(paneGuard.paneCapture, teamName)) {
    return { ok: true, result: 'suppressed_duplicate_queue' };
  }

  const prompt =
    `[OMX] ${workerName} native Stop allowed. `
    + `Run \`omx team status ${teamName}\`, read worker messages/results, then assign next task, reconcile completion, or shut down. `
    + DEFAULT_MARKER;

    const leaderHasActiveTask = paneHasActiveTask(paneGuard.paneCapture);
    let deliveryMode = 'sent';
    if (leaderHasActiveTask) {
      const sendResult = await queuePaneInput({
        paneTarget: tmuxTarget,
        prompt,
      });
      if (!sendResult.ok) throw new Error(sendResult.error || sendResult.reason || 'send_failed');
      deliveryMode = 'queued';
    } else {
      const sendResult = await sendPaneInput({
        paneTarget: tmuxTarget,
        prompt,
        submitKeyPresses: 2,
        submitDelayMs: 100,
      });
      if (!sendResult.ok) throw new Error(sendResult.error || sendResult.reason || 'send_failed');
    }

    const deliveryState = {
      ...nextState,
      delivery: deliveryMode,
      leader_pane_id: leaderPaneId || null,
      tmux_target: tmuxTarget,
    };
    const wroteWorkerState = await writeStopNudgeStateIfTeamExists(teamDir, statePath, deliveryState).catch(() => false);
    const wroteTeamState = wroteWorkerState
      ? await writeStopNudgeStateIfTeamExists(teamDir, teamStatePath, deliveryState).catch(() => false)
      : false;
    if (wroteTeamState) {
      await appendWorkerStopEvent(stateDir, teamName, {
        event_id: `worker-stop-nudge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        team: teamName,
        type: 'worker_stop_leader_nudge',
        worker: workerName,
        to_worker: 'leader-fixed',
        delivery: deliveryMode,
        created_at: nowIso,
        source_type: SOURCE_TYPE,
      });
    }
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'worker_stop_leader_nudge',
      team: teamName,
      worker: workerName,
      to_worker: 'leader-fixed',
      tmux_target: tmuxTarget,
      source_type: SOURCE_TYPE,
    }).catch(() => {});
    await appendTeamDeliveryLog(logsDir, {
      event: 'nudge_triggered',
      source: SOURCE_TYPE,
      team: teamName,
      from_worker: workerName,
      to_worker: 'leader-fixed',
      transport: 'send-keys',
      result: deliveryMode,
      reason: 'worker_stop_allowed',
    }).catch(() => {});
    return { ok: true, result: deliveryMode };
  } catch (err) {
    if (!(await teamStateAllowsWorkerStopNudge(stateDir, teamName))) {
      return { ok: true, result: TEAM_SHUTDOWN_NO_INJECTION_REASON };
    }
    await recordDeferred({
      stateDir,
      logsDir,
      teamName,
      workerName,
      statePath,
      nextState,
      reason: err instanceof Error ? err.message : safeString(err),
      tmuxSession,
      leaderPaneId,
    });
    return { ok: true, result: 'deferred' };
  } finally {
    await releaseTeamStopNudgeLock(lock.lockDir);
  }
}
