// @ts-nocheck
/**
 * Native worker Stop leader nudge.
 *
 * This path is intentionally tied to a resolved, allowed native Stop event.
 * It must not depend on idle/heartbeat freshness or inferred progress stalls.
 */

import { appendFile, mkdir, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';
import { appendTeamDeliveryLog } from '../../team/delivery-log.js';
import { safeString, asNumber } from './utils.js';
import { readJsonIfExists } from './state-io.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, sendPaneInput } from './team-tmux-guard.js';
import { resolvePaneTarget } from './tmux-injection.js';
import { readTeamWorkersForIdleCheck } from './team-worker.js';

const STOP_NUDGE_COOLDOWN_MS = 30_000;
const SOURCE_TYPE = 'worker_stop';
const LEADER_PANE_MISSING_NO_INJECTION_REASON = 'leader_pane_missing_no_injection';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';

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

  const workerDir = join(stateDir, 'team', teamName, 'workers', workerName);
  const statePath = join(workerDir, 'worker-stop-nudge.json');
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const existing = (await readJsonIfExists(statePath, null)) || {};
  const lastNotifiedMs = asNumber(existing.last_notified_at_ms) ?? 0;
  const cooldownMs = resolveWorkerStopCooldownMs();
  if ((nowMs - lastNotifiedMs) < cooldownMs) {
    return { ok: true, result: 'suppressed_cooldown' };
  }

  const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName);
  if (!teamInfo) return { ok: false, result: 'unresolved' };
  const { tmuxSession, leaderPaneId } = teamInfo;
  const tmuxTarget = await resolveCanonicalLeaderPaneId(leaderPaneId);
  const nextState = {
    last_notified_at_ms: nowMs,
    last_notified_at: nowIso,
    team: teamName,
    worker: workerName,
    source_type: SOURCE_TYPE,
  };

  if (!tmuxTarget) {
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

  const prompt =
    `[OMX] ${workerName} native Stop allowed. `
    + `Run \`omx team status ${teamName}\`, read worker messages/results, then assign next task, reconcile completion, or shut down. `
    + DEFAULT_MARKER;

  try {
    const sendResult = await sendPaneInput({
      paneTarget: tmuxTarget,
      prompt,
      submitKeyPresses: 2,
      submitDelayMs: 100,
    });
    if (!sendResult.ok) throw new Error(sendResult.error || sendResult.reason || 'send_failed');

    await writeStopNudgeState(statePath, {
      ...nextState,
      delivery: 'sent',
      leader_pane_id: leaderPaneId || null,
      tmux_target: tmuxTarget,
    });
    await appendWorkerStopEvent(stateDir, teamName, {
      event_id: `worker-stop-nudge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: 'worker_stop_leader_nudge',
      worker: workerName,
      to_worker: 'leader-fixed',
      delivery: 'sent',
      created_at: nowIso,
      source_type: SOURCE_TYPE,
    });
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
      result: 'sent',
      reason: 'worker_stop_allowed',
    }).catch(() => {});
    return { ok: true, result: 'sent' };
  } catch (err) {
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
  }
}
