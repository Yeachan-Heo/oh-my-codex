/**
 * Team leader nudge: remind the leader to check teammate/mailbox state.
 */

import { readFile, writeFile, mkdir, appendFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { checkPaneReadyForTeamSendKeys } from './team-tmux-guard.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';
const LEADER_PANE_MISSING_NO_INJECTION_REASON = 'leader_pane_missing_no_injection';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';
const LEADER_NOTIFICATION_DEFERRED_TYPE = 'leader_notification_deferred';
const ACK_WITHOUT_START_EVIDENCE_REASON = 'ack_without_start_evidence';
const ACK_LIKE_PATTERNS = [
  /^ack(?::\s*[a-z0-9-]+(?:\s+initialized)?)?[.!]*$/i,
  /^(?:ok|okay|k|roger|copy|received|got it|understood|sounds good)[.!]*$/i,
  /^(?:on it|will do|i(?:'|’)ll do it|working on it)[.!]*$/i,
];

export function resolveLeaderNudgeIntervalMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_NUDGE_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds for stale-leader follow-up. Guard against spam.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 30_000;
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

export async function checkWorkerPanesAlive(tmuxTarget, workerPaneIds = []) {
  const sessionName = tmuxTarget.split(':')[0];
  try {
    const result = await runProcess('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id} #{pane_pid}'], 2000);
    const lines = (result.stdout || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const workerPaneIdSet = new Set(
      Array.isArray(workerPaneIds)
        ? workerPaneIds.map((paneId) => safeString(paneId).trim()).filter(Boolean)
        : [],
    );
    const relevantLines = workerPaneIdSet.size > 0
      ? lines.filter((line) => workerPaneIdSet.has(line.split(/\s+/, 1)[0] || ''))
      : lines;
    return { alive: relevantLines.length > 0, paneCount: relevantLines.length };
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

async function readWorkerStatusSnapshot(stateDir, teamName, workerName) {
  if (!workerName) return { state: 'unknown', current_task_id: '' };
  const path = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
  try {
    if (!existsSync(path)) return { state: 'unknown', current_task_id: '' };
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return {
      state: safeString(parsed && parsed.state ? parsed.state : 'unknown') || 'unknown',
      current_task_id: safeString(parsed && parsed.current_task_id ? parsed.current_task_id : '').trim(),
    };
  } catch {
    return { state: 'unknown', current_task_id: '' };
  }
}

async function readWorkerStatusState(stateDir, teamName, workerName) {
  const snapshot = await readWorkerStatusSnapshot(stateDir, teamName, workerName);
  return snapshot.state;
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

function normalizeMailboxBody(body) {
  return safeString(body).replace(/\s+/g, ' ').trim();
}

function isAckLikeMailboxBody(body) {
  const normalized = normalizeMailboxBody(body);
  if (!normalized) return false;
  return ACK_LIKE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatMailboxBodyForLeader(body, maxLength = 40) {
  const normalized = normalizeMailboxBody(body);
  if (!normalized) return 'ack-like update';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

async function workerHasOwnedStartedTask(stateDir, teamName, workerName) {
  const tasksDir = join(stateDir, 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) return false;

  try {
    const taskFiles = (await readdir(tasksDir))
      .filter((entry) => /^task-\d+\.json$/.test(entry))
      .sort();
    for (const entry of taskFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(tasksDir, entry), 'utf-8'));
        if (safeString(parsed?.owner).trim() !== workerName) continue;
        const status = safeString(parsed?.status).trim();
        if (status === 'in_progress' || status === 'completed' || status === 'failed') return true;
      } catch {
        // ignore malformed task files
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function getAckWithoutStartEvidence(stateDir, teamName, msg) {
  if (!msg || typeof msg !== 'object') return null;
  const fromWorker = safeString(msg.from_worker || '').trim();
  if (!fromWorker || fromWorker === 'leader-fixed') return null;
  if (!isAckLikeMailboxBody(msg.body)) return null;

  const status = await readWorkerStatusSnapshot(stateDir, teamName, fromWorker);
  if (
    status.current_task_id
    || status.state === 'working'
    || status.state === 'blocked'
    || status.state === 'done'
    || status.state === 'failed'
  ) {
    return null;
  }

  if (await workerHasOwnedStartedTask(stateDir, teamName, fromWorker)) {
    return null;
  }

  return {
    worker: fromWorker,
    body: formatMailboxBodyForLeader(msg.body),
    statusState: status.state,
  };
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

async function emitLeaderNudgeDeferredEvent(cwd, teamName, reason, nowIso, { tmuxSession = '', leaderPaneId = '', paneCurrentCommand = '', sourceType = 'leader_nudge' } = {}) {
  const eventsDir = join(cwd, '.omx', 'state', 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  try {
    await mkdir(eventsDir, { recursive: true });
    const event = {
      event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: LEADER_NOTIFICATION_DEFERRED_TYPE,
      worker: 'leader-fixed',
      to_worker: 'leader-fixed',
      reason,
      created_at: nowIso,
      tmux_session: tmuxSession || null,
      leader_pane_id: leaderPaneId || null,
      tmux_injection_attempted: false,
      pane_current_command: paneCurrentCommand || null,
      source_type: sourceType,
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
    const candidateStateDirs = [...new Set([...scopedDirs, stateDir])];
    for (const scopedDir of candidateStateDirs) {
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
    const workerPaneIds = Array.isArray(workers)
      ? workers.map((w) => safeString(w && w.pane_id ? w.pane_id : '')).filter(Boolean)
      : [];
    if (!tmuxSession && !leaderPaneId) continue;
    const tmuxTarget = leaderPaneId;
    const paneStatus = tmuxSession
      ? await checkWorkerPanesAlive(tmuxSession, workerPaneIds)
      : { alive: false, paneCount: 0 };
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
    const ackWithoutStartEvidence = hasNewMessage
      ? await getAckWithoutStartEvidence(stateDir, teamName, newest)
      : null;

    const prevIdle = nudgeState.last_idle_nudged_by_team[teamName] && typeof nudgeState.last_idle_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_idle_nudged_by_team[teamName]
      : {};
    const prevIdleAtIso = safeString(prevIdle.at || '');
    const prevIdleAtMs = prevIdleAtIso ? Date.parse(prevIdleAtIso) : NaN;
    const dueByIdleCooldown = !Number.isFinite(prevIdleAtMs) || (nowMs - prevIdleAtMs >= idleCooldownMs);
    const shouldSendAllIdleNudge = allWorkersIdle && dueByIdleCooldown;

    // Stale-leader follow-up is the only periodic visible nudge path.
    // This keeps the leader pane quieter when the leader is not actually stale.
    const stalePanesNudge = paneStatus.alive && leaderStale;
    const staleFollowupDue = stalePanesNudge && dueByTime;

    if (!shouldSendAllIdleNudge && !hasNewMessage && !staleFollowupDue) continue;

    let nudgeReason = '';
    let text = '';
    if (shouldSendAllIdleNudge) {
      nudgeReason = 'all_workers_idle';
      const N = workerNames.length;
      text = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle. Ready for next instructions.`;
    } else if (ackWithoutStartEvidence) {
      nudgeReason = ACK_WITHOUT_START_EVIDENCE_REASON;
      text =
        `Team ${teamName}: ${ackWithoutStartEvidence.worker} said "${ackWithoutStartEvidence.body}" `
        + `but has no work-start evidence yet (status: ${ackWithoutStartEvidence.statusState}, no owned in_progress task). `
        + `Run: omx team status ${teamName}`;
    } else if (stalePanesNudge && hasNewMessage) {
      nudgeReason = 'stale_leader_with_messages';
      text = `Team ${teamName}: leader stale, ${paneStatus.paneCount} pane(s) active, ${messages.length} msg(s) pending. Run: omx team status ${teamName}`;
    } else if (staleFollowupDue) {
      nudgeReason = 'stale_leader_panes_alive';
      text = `Team ${teamName}: leader stale, ${paneStatus.paneCount} worker pane(s) still active. Run: omx team status ${teamName}`;
    } else if (hasNewMessage) {
      nudgeReason = 'new_mailbox_message';
      text = `Team ${teamName}: ${messages.length} msg(s) for leader. Run: omx team status ${teamName}`;
    } else {
      continue;
    }
    const capped = text.length > 180 ? `${text.slice(0, 177)}...` : text;
    const markedText = `${capped} ${DEFAULT_MARKER}`;

    if (!tmuxTarget) {
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '' };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = { at: nowIso, worker_count: workerNames.length };
      }
      await emitLeaderNudgeDeferredEvent(cwd, teamName, LEADER_PANE_MISSING_NO_INJECTION_REASON, nowIso, {
        tmuxSession,
        leaderPaneId,
        sourceType: 'leader_nudge',
      });
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: LEADER_NOTIFICATION_DEFERRED_TYPE,
          team: teamName,
          worker: 'leader-fixed',
          to_worker: 'leader-fixed',
          reason: LEADER_PANE_MISSING_NO_INJECTION_REASON,
          leader_pane_id: leaderPaneId || null,
          tmux_session: tmuxSession || null,
          tmux_injection_attempted: false,
          source_type: 'leader_nudge',
        });
      } catch { /* ignore */ }
      continue;
    }

    const paneGuard = await checkPaneReadyForTeamSendKeys(tmuxTarget);
    if (!paneGuard.ok) {
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '' };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = { at: nowIso, worker_count: workerNames.length };
      }
      await emitLeaderNudgeDeferredEvent(cwd, teamName, LEADER_PANE_SHELL_NO_INJECTION_REASON, nowIso, {
        tmuxSession,
        leaderPaneId,
        paneCurrentCommand: paneGuard.paneCurrentCommand,
        sourceType: 'leader_nudge',
      });
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: LEADER_NOTIFICATION_DEFERRED_TYPE,
          team: teamName,
          worker: 'leader-fixed',
          to_worker: 'leader-fixed',
          reason: LEADER_PANE_SHELL_NO_INJECTION_REASON,
          leader_pane_id: leaderPaneId || null,
          tmux_session: tmuxSession || null,
          tmux_injection_attempted: false,
          pane_current_command: paneGuard.paneCurrentCommand || null,
          source_type: 'leader_nudge',
        });
      } catch { /* ignore */ }
      continue;
    }

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
