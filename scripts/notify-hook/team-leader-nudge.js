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
    let tmuxTarget = '';
    try {
      const manifestPath = join(omxDir, 'state', 'team', teamName, 'manifest.v2.json');
      const configPath = join(omxDir, 'state', 'team', teamName, 'config.json');
      const srcPath = existsSync(manifestPath) ? manifestPath : configPath;
      if (existsSync(srcPath)) {
        const raw = JSON.parse(await readFile(srcPath, 'utf-8'));
        tmuxTarget = safeString(raw && raw.tmux_session ? raw.tmux_session : '').trim();
      }
    } catch {
      // ignore
    }
    if (!tmuxTarget) continue;

    const paneStatus = await checkWorkerPanesAlive(tmuxTarget);

    let mailbox = null;
    try {
      const mailboxPath = join(omxDir, 'state', 'team', teamName, 'mailbox', 'leader-fixed.json');
      mailbox = await readJsonIfExists(mailboxPath, null);
    } catch {
      mailbox = null;
    }
    const messages = mailbox && Array.isArray(mailbox.messages) ? mailbox.messages : [];
    const newest = messages.length > 0 ? messages[messages.length - 1] : null;
    const newestId = newest && typeof newest.message_id === 'string' ? newest.message_id : '';

    const prev = nudgeState.last_nudged_by_team[teamName] && typeof nudgeState.last_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_nudged_by_team[teamName]
      : {};
    const prevAtIso = safeString(prev.at || '');
    const prevAtMs = prevAtIso ? Date.parse(prevAtIso) : NaN;
    const prevMsgId = safeString(prev.last_message_id || '');

    const hasNewMessage = newestId && newestId !== prevMsgId;
    const dueByTime = !Number.isFinite(prevAtMs) || (nowMs - prevAtMs >= intervalMs);

    // stalePanesNudge must respect the same dueByTime rate limit (issue #116)
    const stalePanesNudge = paneStatus.alive && leaderStale;

    if (!hasNewMessage && !dueByTime) continue;

    let nudgeReason = '';
    let text = '';
    if (stalePanesNudge && hasNewMessage) {
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
