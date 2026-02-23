/**
 * Team leader nudge: remind the leader to check teammate/mailbox state.
 */

import { readFile, writeFile, mkdir, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';

export function resolveLeaderNudgeIntervalMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_NUDGE_MS || '');
  const parsed = asNumber(raw);
  // Default: 2 minutes. Guard against spam.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 120_000;
}

export function resolveLeaderAllIdleNudgeCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_ALL_IDLE_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds.
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return 30_000;
}

export function resolveLeaderStalenessThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_STALE_MS || '');
  const parsed = asNumber(raw);
  // Default: 3 minutes. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 180_000;
}

export async function checkWorkerPanesAlive(tmuxTarget) {
  const sessionName = tmuxTarget.split(':')[0];
  try {
    const result = await runProcess('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id} #{pane_pid}'], 2000);
    const lines = (result.stdout || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    return { alive: lines.length > 0, paneCount: lines.length };
  } catch {
    return { alive: false, paneCount: 0 };
  }
}

export async function isLeaderStale(stateDir, thresholdMs, nowMs) {
  const hudStatePath = join(stateDir, 'hud-state.json');
  const hudState = await readJsonIfExists(hudStatePath, null);
  if (!hudState || typeof hudState !== 'object') return true;
  const lastTurnAt = safeString(hudState.last_turn_at || '');
  if (!lastTurnAt) return true;
  const lastMs = Date.parse(lastTurnAt);
  if (!Number.isFinite(lastMs)) return true;
  return (nowMs - lastMs) >= thresholdMs;
}

async function readWorkerStatusState(stateDir, teamName, workerName) {
  if (!workerName) return 'unknown';
  const path = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
  try {
    if (!existsSync(path)) return 'unknown';
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return safeString(parsed && parsed.state ? parsed.state : 'unknown') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizeMailboxMessages(rawMailbox) {
  if (Array.isArray(rawMailbox)) return rawMailbox;
  if (rawMailbox && typeof rawMailbox === 'object' && Array.isArray(rawMailbox.messages)) {
    return rawMailbox.messages;
  }
  return [];
}

function normalizeMessageIdentity(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const explicitId = safeString(msg.message_id || '').trim();
  if (explicitId) return explicitId;
  const createdAt = safeString(msg.created_at || msg.timestamp || '').trim();
  const from = safeString(msg.from_worker || msg.from || '').trim();
  const body = safeString(msg.body || '').trim();
  return [createdAt, from, body].filter(Boolean).join('|');
}

export async function emitTeamNudgeEvent(cwd, teamName, reason, nowIso) {
  const eventsDir = join(cwd, '.omx', 'state', 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  try {
    await mkdir(eventsDir, { recursive: true });
    const event = {
      event_id: `nudge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason,
      created_at: nowIso,
    };
    await appendFile(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort
  }
}

export async function maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale }) {
  const intervalMs = resolveLeaderNudgeIntervalMs();
  const idleCooldownMs = resolveLeaderAllIdleNudgeCooldownMs();
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const omxDir = join(cwd, '.omx');
  const nudgeStatePath = join(stateDir, 'team-leader-nudge.json');

  let nudgeState = await readJsonIfExists(nudgeStatePath, null);
  if (!nudgeState || typeof nudgeState !== 'object') {
    nudgeState = { last_nudged_by_team: {} };
  }
  if (!nudgeState.last_nudged_by_team || typeof nudgeState.last_nudged_by_team !== 'object') {
    nudgeState.last_nudged_by_team = {};
  }
  if (!nudgeState.last_idle_nudged_by_team || typeof nudgeState.last_idle_nudged_by_team !== 'object') {
    nudgeState.last_idle_nudged_by_team = {};
  }

  const activeTeamNames = new Set();
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    for (const scopedDir of scopedDirs) {
      const teamStatePath = join(scopedDir, 'team-state.json');
      if (!existsSync(teamStatePath)) continue;
      const parsed = JSON.parse(await readFile(teamStatePath, 'utf-8'));
      if (!parsed || parsed.active !== true) continue;
      const teamName = safeString(parsed.team_name || '').trim();
      if (teamName) activeTeamNames.add(teamName);
    }
  } catch {
    // Non-critical
  }

  // Use pre-computed staleness (captured before HUD state was updated this turn)
  const leaderStale = typeof preComputedLeaderStale === 'boolean' ? preComputedLeaderStale : false;

  for (const teamName of activeTeamNames) {
    let tmuxSession = '';
    let leaderPaneId = '';
    let workers = [];
    try {
      const manifestPath = join(omxDir, 'state', 'team', teamName, 'manifest.v2.json');
      const configPath = join(omxDir, 'state', 'team', teamName, 'config.json');
      const srcPath = existsSync(manifestPath) ? manifestPath : configPath;
      if (existsSync(srcPath)) {
        const raw = JSON.parse(await readFile(srcPath, 'utf-8'));
        tmuxSession = safeString(raw && raw.tmux_session ? raw.tmux_session : '').trim();
        leaderPaneId = safeString(raw && raw.leader_pane_id ? raw.leader_pane_id : '').trim();
        if (Array.isArray(raw && raw.workers)) workers = raw.workers;
      }
    } catch {
      // ignore
    }
    const tmuxTarget = leaderPaneId || tmuxSession;
    if (!tmuxTarget) continue;

    const paneStatus = tmuxSession
      ? await checkWorkerPanesAlive(tmuxSession)
      : { alive: false, paneCount: 0 };

    let mailbox = null;
    try {
      const mailboxPath = join(omxDir, 'state', 'team', teamName, 'mailbox', 'leader-fixed.json');
      mailbox = await readJsonIfExists(mailboxPath, null);
    } catch {
      mailbox = null;
    }
    const messages = normalizeMailboxMessages(mailbox);
    const newest = messages.length > 0 ? messages[messages.length - 1] : null;
    const newestId = normalizeMessageIdentity(newest);

    const workerNames = Array.isArray(workers)
      ? workers.map((w) => safeString(w && w.name ? w.name : '')).filter(Boolean)
      : [];
    const workerStates = workerNames.length > 0
      ? await Promise.all(workerNames.map((workerName) => readWorkerStatusState(stateDir, teamName, workerName)))
      : [];
    const allWorkersIdle = workerStates.length > 0 && workerStates.every((state) => state === 'idle' || state === 'done');

    const prev = nudgeState.last_nudged_by_team[teamName] && typeof nudgeState.last_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_nudged_by_team[teamName]
      : {};
    const prevAtIso = safeString(prev.at || '');
    const prevAtMs = prevAtIso ? Date.parse(prevAtIso) : NaN;
    const prevMsgId = safeString(prev.last_message_id || '');

    const hasNewMessage = newestId && newestId !== prevMsgId;
    const dueByTime = !Number.isFinite(prevAtMs) || (nowMs - prevAtMs >= intervalMs);

    const prevIdle = nudgeState.last_idle_nudged_by_team[teamName] && typeof nudgeState.last_idle_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_idle_nudged_by_team[teamName]
      : {};
    const prevIdleAtIso = safeString(prevIdle.at || '');
    const prevIdleAtMs = prevIdleAtIso ? Date.parse(prevIdleAtIso) : NaN;
    const dueByIdleCooldown = !Number.isFinite(prevIdleAtMs) || (nowMs - prevIdleAtMs >= idleCooldownMs);
    const shouldSendAllIdleNudge = allWorkersIdle && dueByIdleCooldown;

    // stalePanesNudge must respect the same dueByTime rate limit (issue #116)
    const stalePanesNudge = paneStatus.alive && leaderStale;

    if (!shouldSendAllIdleNudge && !hasNewMessage && !dueByTime) continue;

    let nudgeReason = '';
    let text = '';
    if (shouldSendAllIdleNudge) {
      nudgeReason = 'all_workers_idle';
      const N = workerNames.length;
      text = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle. Ready for next instructions.`;
    } else if (stalePanesNudge && hasNewMessage) {
      nudgeReason = 'stale_leader_with_messages';
      text = `Team ${teamName}: leader stale, ${paneStatus.paneCount} pane(s) active, ${messages.length} msg(s) pending. Run: omx team status ${teamName}`;
    } else if (stalePanesNudge) {
      nudgeReason = 'stale_leader_panes_alive';
      text = `Team ${teamName}: leader stale, ${paneStatus.paneCount} worker pane(s) still active. Run: omx team status ${teamName}`;
    } else if (hasNewMessage) {
      nudgeReason = 'new_mailbox_message';
      text = `Team ${teamName}: ${messages.length} msg(s) for leader. Run: omx team status ${teamName}`;
    } else {
      nudgeReason = 'periodic_check';
      text = `Team ${teamName} active. Run: omx team status ${teamName}`;
    }
    const capped = text.length > 180 ? `${text.slice(0, 177)}...` : text;
    const markedText = `${capped} ${DEFAULT_MARKER}`;

    try {
      await runProcess('tmux', ['send-keys', '-t', tmuxTarget, '-l', markedText], 3000);
      await new Promise(r => setTimeout(r, 100));
      await runProcess('tmux', ['send-keys', '-t', tmuxTarget, 'C-m'], 3000);
      await new Promise(r => setTimeout(r, 100));
      await runProcess('tmux', ['send-keys', '-t', tmuxTarget, 'C-m'], 3000);
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '' };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = { at: nowIso, worker_count: workerNames.length };
      }

      await emitTeamNudgeEvent(cwd, teamName, nudgeReason, nowIso);

      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          pane_count: paneStatus.paneCount,
          leader_stale: leaderStale,
          message_count: messages.length,
        });
      } catch { /* ignore */ }
    } catch (err) {
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          error: safeString(err && err.message ? err.message : err),
        });
      } catch { /* ignore */ }
    }
  }

  await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});
}
