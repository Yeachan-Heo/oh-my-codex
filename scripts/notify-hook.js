#!/usr/bin/env node

/**
 * oh-my-codex Notification Hook
 * Codex CLI fires this after each agent turn via the `notify` config.
 * Receives JSON payload as the last argv argument.
 *
 * This hook:
 * 1. Logs agent turn completions to .omx/logs/
 * 2. Updates state for active workflow modes
 * 3. Tracks subagent activity
 * 4. Triggers desktop notifications if configured
 */

import { writeFile, appendFile, mkdir, readFile, rename } from 'fs/promises';
import { join, resolve as resolvePath } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import {
  normalizeTmuxHookConfig,
  pickActiveMode,
  evaluateInjectionGuards,
  buildSendKeysArgv,
} from './tmux-hook-engine.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getSessionTokenUsage(payload) {
  const usage = payload.usage || payload['usage'] || payload.token_usage || payload['token-usage'] || {};

  function firstTokenMatch(candidates) {
    for (const [raw, cumulative] of candidates) {
      const value = asNumber(raw);
      if (value !== null) return { value, cumulative };
    }
    return { value: null, cumulative: false };
  }

  const inputMatch = firstTokenMatch([
    [usage.session_input_tokens, true],
    [usage.input_tokens, false],
    [usage.total_input_tokens, true],
    [usage.prompt_tokens, false],
    [usage.promptTokens, false],
    [payload.session_input_tokens, true],
    [payload.input_tokens, false],
    [payload.total_input_tokens, true],
    [payload.prompt_tokens, false],
    [payload.promptTokens, false],
  ]);
  const outputMatch = firstTokenMatch([
    [usage.session_output_tokens, true],
    [usage.output_tokens, false],
    [usage.total_output_tokens, true],
    [usage.completion_tokens, false],
    [usage.completionTokens, false],
    [payload.session_output_tokens, true],
    [payload.output_tokens, false],
    [payload.total_output_tokens, true],
    [payload.completion_tokens, false],
    [payload.completionTokens, false],
  ]);
  const totalMatch = firstTokenMatch([
    [usage.session_total_tokens, true],
    [usage.total_tokens, true],
    [payload.session_total_tokens, true],
    [payload.total_tokens, true],
  ]);

  const input = inputMatch.value;
  const output = outputMatch.value;
  const total = totalMatch.value;

  if (input === null && output === null && total === null) return null;

  return {
    input,
    inputCumulative: inputMatch.cumulative,
    output,
    outputCumulative: outputMatch.cumulative,
    total,
    totalCumulative: totalMatch.cumulative,
  };
}

function clampPct(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value <= 1) return Math.round(value * 100);
  if (value > 100) return 100;
  return Math.round(value);
}

function extractLimitPct(limit) {
  if (limit == null) return null;
  if (typeof limit === 'number' || typeof limit === 'string') return clampPct(asNumber(limit));
  if (typeof limit !== 'object') return null;

  const directPct = clampPct(asNumber(limit.percent ?? limit.pct ?? limit.usage_percent ?? limit.usagePct));
  if (directPct !== null) return directPct;

  const used = asNumber(limit.used ?? limit.usage ?? limit.current);
  const max = asNumber(limit.limit ?? limit.max ?? limit.total);
  if (used !== null && max !== null && max > 0) {
    return clampPct((used / max) * 100);
  }

  const remaining = asNumber(limit.remaining ?? limit.left);
  if (remaining !== null && max !== null && max > 0) {
    return clampPct(((max - remaining) / max) * 100);
  }

  return null;
}

function getQuotaUsage(payload) {
  const usage = payload.usage || payload['usage'] || payload.token_usage || payload['token-usage'] || {};

  const fiveHourRaw =
    usage.five_hour_limit
    ?? usage.fiveHourLimit
    ?? usage['5h_limit']
    ?? payload.five_hour_limit
    ?? payload.fiveHourLimit
    ?? payload['5h_limit'];
  const weeklyRaw =
    usage.weekly_limit
    ?? usage.weeklyLimit
    ?? payload.weekly_limit
    ?? payload.weeklyLimit;

  const fiveHourLimitPct = extractLimitPct(fiveHourRaw);
  const weeklyLimitPct = extractLimitPct(weeklyRaw);

  if (fiveHourLimitPct === null && weeklyLimitPct === null) return null;
  return { fiveHourLimitPct, weeklyLimitPct };
}

function safeString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

function isTerminalPhase(phase) {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled';
}

function normalizeInputMessages(payload) {
  const items = payload['input-messages'] || payload.input_messages || [];
  if (!Array.isArray(items)) return [];
  return items.map(item => safeString(item));
}

function renderPrompt(template, context) {
  return safeString(template)
    .replaceAll('{{mode}}', context.mode)
    .replaceAll('{{thread_id}}', context.threadId)
    .replaceAll('{{turn_id}}', context.turnId)
    .replaceAll('{{timestamp}}', context.timestamp);
}

function normalizeTmuxState(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      total_injections: 0,
      pane_counts: {},
      session_counts: {},
      recent_keys: {},
      last_injection_ts: 0,
      last_reason: 'init',
      last_event_at: '',
    };
  }
  return {
    total_injections: asNumber(raw.total_injections) ?? 0,
    pane_counts: raw.pane_counts && typeof raw.pane_counts === 'object' ? raw.pane_counts : {},
    session_counts: raw.session_counts && typeof raw.session_counts === 'object' ? raw.session_counts : {},
    recent_keys: raw.recent_keys && typeof raw.recent_keys === 'object' ? raw.recent_keys : {},
    last_injection_ts: asNumber(raw.last_injection_ts) ?? 0,
    last_reason: safeString(raw.last_reason),
    last_event_at: safeString(raw.last_event_at),
  };
}

function normalizeNotifyState(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      recent_turns: {},
      last_event_at: '',
    };
  }
  return {
    recent_turns: raw.recent_turns && typeof raw.recent_turns === 'object' ? raw.recent_turns : {},
    last_event_at: safeString(raw.last_event_at),
  };
}

function pruneRecentTurns(recentTurns, now) {
  const pruned = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentTurns || {}).slice(-2000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

function pruneRecentKeys(recentKeys, now) {
  const pruned = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentKeys || {}).slice(-1000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

function readJsonIfExists(path, fallback) {
  return readFile(path, 'utf-8')
    .then(content => JSON.parse(content))
    .catch(() => fallback);
}

function runProcess(command, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
      }
    });
  });
}

async function resolveSessionToPane(sessionName) {
  const result = await runProcess('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id} #{pane_active}']);
  const lines = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const active = lines.find(line => line.endsWith(' 1')) || lines[0];
  const paneId = active.split(' ')[0];
  return paneId || null;
}

async function resolvePaneByCwd(expectedCwd) {
  if (!expectedCwd) return null;
  const result = await runProcess('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_path}\t#{pane_active}\t#{session_name}']);
  const lines = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const expected = resolvePath(expectedCwd);
  const candidates = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [paneId, paneCwd, activeRaw, sessionName] = parts;
    if (!paneId || !paneCwd) continue;
    if (resolvePath(paneCwd) !== expected) continue;
    const active = activeRaw === '1';
    candidates.push({ paneId, paneCwd, active, sessionName: sessionName || null });
  }
  if (candidates.length === 0) return null;

  const pick = candidates.find(c => c.active) || candidates[0];
  return pick;
}

async function resolvePaneTarget(target, fallbackPane, expectedCwd, modePane) {
  if (modePane) {
    try {
      const modePaneResult = await runProcess('tmux', ['display-message', '-p', '-t', modePane, '#{pane_id}']);
      const paneId = safeString(modePaneResult.stdout).trim();
      if (paneId) {
        if (expectedCwd) {
          const paneCwdResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
          const paneCwd = safeString(paneCwdResult.stdout).trim();
          if (!paneCwd || resolvePath(paneCwd) === resolvePath(expectedCwd)) {
            const currentSession = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
            const sessionName = safeString(currentSession.stdout).trim();
            return {
              paneTarget: paneId,
              reason: 'fallback_mode_state_pane',
              matched_session: sessionName || null,
            };
          }
        } else {
          const currentSession = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
          const sessionName = safeString(currentSession.stdout).trim();
          return {
            paneTarget: paneId,
            reason: 'fallback_mode_state_pane',
            matched_session: sessionName || null,
          };
        }
      }
    } catch {
      // Fall through to config/fallback probes
    }
  }

  if (!target) return { paneTarget: null, reason: 'invalid_target' };

  if (target.type === 'pane') {
    try {
      const result = await runProcess('tmux', ['display-message', '-p', '-t', target.value, '#{pane_id}']);
      const paneId = safeString(result.stdout).trim();
      if (paneId) return { paneTarget: paneId, reason: 'ok' };
    } catch {
      // Fall through to fallback probe
    }
  } else {
    try {
      const paneId = await resolveSessionToPane(target.value);
      if (paneId) return { paneTarget: paneId, reason: 'ok' };
    } catch {
      // Fall through to fallback probe
    }
  }

  if (fallbackPane) {
    try {
      const currentPane = await runProcess('tmux', ['display-message', '-p', '-t', fallbackPane, '#{pane_id}']);
      const paneId = safeString(currentPane.stdout).trim();
      if (paneId) {
        if (expectedCwd) {
          const paneCwdResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
          const paneCwd = safeString(paneCwdResult.stdout).trim();
          if (paneCwd && resolvePath(paneCwd) !== resolvePath(expectedCwd)) {
            return {
              paneTarget: null,
              reason: 'pane_cwd_mismatch',
              pane_cwd: paneCwd,
              expected_cwd: expectedCwd,
            };
          }
        }

        const currentSession = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
        const sessionName = safeString(currentSession.stdout).trim();
        return {
          paneTarget: paneId,
          reason: 'fallback_current_pane',
          matched_session: sessionName || null,
        };
      }
    } catch {
      // Fall through
    }
  }

  try {
    const match = await resolvePaneByCwd(expectedCwd);
    if (match && match.paneId) {
      return {
        paneTarget: match.paneId,
        reason: 'fallback_pane_by_cwd',
        matched_session: match.sessionName,
      };
    }
  } catch {
    // Fall through
  }

  return { paneTarget: null, reason: 'target_not_found' };
}

async function logTmuxHookEvent(logsDir, event) {
  const file = join(logsDir, `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(file, JSON.stringify(event) + '\n').catch(() => {});
}

async function getScopedStateDirsForCurrentSession(baseStateDir) {
  const scopedDirs = [baseStateDir];
  const sessionPath = join(baseStateDir, 'session.json');
  try {
    const session = JSON.parse(await readFile(sessionPath, 'utf-8'));
    const sessionId = safeString(session && session.session_id ? session.session_id : '');
    if (SESSION_ID_PATTERN.test(sessionId)) {
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      if (existsSync(sessionDir)) scopedDirs.push(sessionDir);
    }
  } catch {
    // No session file or malformed - fall back to global only
  }
  return scopedDirs;
}

function resolveLeaderNudgeIntervalMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_NUDGE_MS || '');
  const parsed = asNumber(raw);
  // Default: 2 minutes. Guard against spam.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 120_000;
}

function resolveLeaderStalenessThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_STALE_MS || '');
  const parsed = asNumber(raw);
  // Default: 3 minutes. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 180_000;
}

async function checkWorkerPanesAlive(tmuxTarget) {
  // Check if the team tmux session has worker panes running.
  // tmuxTarget is either "omx-team-foo" or "session:window".
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

async function isLeaderStale(stateDir, thresholdMs, nowMs) {
  // Check HUD state (updated by the notify hook on each leader turn) for staleness.
  const hudStatePath = join(stateDir, 'hud-state.json');
  const hudState = await readJsonIfExists(hudStatePath, null);
  if (!hudState || typeof hudState !== 'object') return true;
  const lastTurnAt = safeString(hudState.last_turn_at || '');
  if (!lastTurnAt) return true;
  const lastMs = Date.parse(lastTurnAt);
  if (!Number.isFinite(lastMs)) return true;
  return (nowMs - lastMs) >= thresholdMs;
}

async function emitTeamNudgeEvent(cwd, teamName, reason, nowIso) {
  // Write a team_leader_nudge event to the team's events.ndjson log.
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

async function maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale }) {
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
    // Resolve tmux target (session:window) from manifest/config. Best effort.
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

    // Check if worker panes are still alive in tmux
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

    // New condition: worker panes alive + leader stale = always nudge
    const stalePanesNudge = paneStatus.alive && leaderStale;

    if (!hasNewMessage && !dueByTime && !stalePanesNudge) continue;

    // Build contextual nudge message
    const msgCount = messages.length;
    let nudgeReason = '';
    let text = '';
    if (stalePanesNudge && hasNewMessage) {
      nudgeReason = 'stale_leader_with_messages';
      text = `Team ${teamName}: leader stale, ${paneStatus.paneCount} pane(s) active, ${msgCount} msg(s) pending. Run: omx team status ${teamName}`;
    } else if (stalePanesNudge) {
      nudgeReason = 'stale_leader_panes_alive';
      text = `Team ${teamName}: leader stale, ${paneStatus.paneCount} worker pane(s) still active. Run: omx team status ${teamName}`;
    } else if (hasNewMessage) {
      nudgeReason = 'new_mailbox_message';
      text = `Team ${teamName}: ${msgCount} msg(s) for leader. Run: omx team status ${teamName}`;
    } else {
      nudgeReason = 'periodic_check';
      text = `Team ${teamName} active. Run: omx team status ${teamName}`;
    }
    const capped = text.length > 180 ? `${text.slice(0, 177)}...` : text;

    try {
      await runProcess('tmux', ['display-message', '-t', tmuxTarget, '--', capped], 1200);
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '' };

      // Emit team event for the nudge
      await emitTeamNudgeEvent(cwd, teamName, nudgeReason, nowIso);

      // Log the nudge
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          pane_count: paneStatus.paneCount,
          leader_stale: leaderStale,
          message_count: msgCount,
        });
      } catch { /* ignore */ }
    } catch (err) {
      // Best effort. Log only in debug mode to avoid noise.
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

async function handleTmuxInjection({
  payload,
  cwd,
  stateDir,
  logsDir,
}) {
  const omxDir = join(cwd, '.omx');
  const configPath = join(omxDir, 'tmux-hook.json');
  const hookStatePath = join(stateDir, 'tmux-hook-state.json');
  const nowIso = new Date().toISOString();
  const now = Date.now();

  const rawConfig = await readJsonIfExists(configPath, null);
  const config = normalizeTmuxHookConfig(rawConfig);

  const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
  const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
  const sessionKey = threadId || 'unknown';
  const assistantMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  const inputMessages = normalizeInputMessages(payload);
  const sourceText = inputMessages.join('\n');
  const state = normalizeTmuxState(await readJsonIfExists(hookStatePath, null));
  state.recent_keys = pruneRecentKeys(state.recent_keys, now);

  const activeModes = [];
  const activeModeStates = {};
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    for (const scopedDir of scopedDirs) {
      const files = await readdir(scopedDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'tmux-hook-state.json') continue;
        const path = join(scopedDir, file);
        const parsed = JSON.parse(await readFile(path, 'utf-8'));
        if (parsed && parsed.active) {
          const modeName = file.replace('-state.json', '');
          activeModes.push(modeName);
          activeModeStates[modeName] = parsed;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  const mode = pickActiveMode(activeModes, config.allowed_modes);
  const modeState = mode ? (activeModeStates[mode] || {}) : {};
  const modePane = safeString(modeState.tmux_pane_id || '');
  const preGuard = evaluateInjectionGuards({
    config,
    mode,
    sourceText,
    assistantMessage,
    threadId,
    turnId,
    sessionKey,
    skipQuotaChecks: true,
    now,
    state,
  });

  const baseLog = {
    timestamp: nowIso,
    type: 'tmux_hook',
    mode,
    reason: preGuard.reason,
    turn_id: turnId,
    thread_id: threadId,
    target: config.target,
    dry_run: config.dry_run,
    sent: false,
  };

  if (!preGuard.allow) {
    state.last_reason = preGuard.reason;
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    if (config.enabled || config.log_level === 'debug') {
      await logTmuxHookEvent(logsDir, { ...baseLog, event: 'injection_skipped' });
    }
    return;
  }

  const prompt = renderPrompt(config.prompt_template, {
    mode: mode || 'unknown',
    threadId,
    turnId,
    timestamp: nowIso,
  });
  const fallbackPane = safeString(process.env.TMUX_PANE || '');
  const resolution = await resolvePaneTarget(config.target, fallbackPane, cwd, modePane);
  if (!resolution.paneTarget) {
    state.last_reason = resolution.reason;
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_skipped',
      reason: resolution.reason,
      pane_cwd: resolution.pane_cwd,
      expected_cwd: resolution.expected_cwd,
    });
    return;
  }
  const paneTarget = resolution.paneTarget;

  // Final guard phase: pane is canonical identity for quota/cooldown.
  const guard = evaluateInjectionGuards({
    config,
    mode,
    sourceText,
    assistantMessage,
    threadId,
    turnId,
    paneKey: paneTarget,
    sessionKey,
    now,
    state,
  });
  if (!guard.allow) {
    state.last_reason = guard.reason;
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, { ...baseLog, event: 'injection_skipped', reason: guard.reason });
    return;
  }

  // Pane-canonical healing: persist resolved pane target so routing stops depending on session names.
  // Legacy configs with target.type="session" remain accepted but are auto-migrated on success.
  if (config.target && config.target.type !== 'pane') {
    try {
      const healed = {
        ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
        target: { type: 'pane', value: paneTarget },
      };
      await writeFile(configPath, JSON.stringify(healed, null, 2) + '\n');
      await logTmuxHookEvent(logsDir, {
        ...baseLog,
        event: 'target_healed',
        reason: 'migrated_to_pane_target',
        previous_target: config.target.value,
        healed_target: paneTarget,
      });
    } catch {
      // Non-fatal
    }
  }

  const argv = buildSendKeysArgv({
    paneTarget,
    prompt,
    dryRun: config.dry_run,
  });

  const updateStateForAttempt = (success, reason) => {
    if (guard.dedupeKey) state.recent_keys[guard.dedupeKey] = now;
    state.last_reason = reason;
    state.last_event_at = nowIso;
    if (success) {
      state.last_injection_ts = now;
      state.total_injections = (asNumber(state.total_injections) ?? 0) + 1;
      state.pane_counts = state.pane_counts && typeof state.pane_counts === 'object' ? state.pane_counts : {};
      state.pane_counts[paneTarget] = (asNumber(state.pane_counts[paneTarget]) ?? 0) + 1;
      state.last_target = paneTarget;
      state.last_prompt_preview = prompt.slice(0, 120);
    }
  };

  if (config.dry_run) {
    updateStateForAttempt(false, 'dry_run');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_dry_run',
      reason: 'dry_run',
      pane_target: paneTarget,
      argv,
    });
    return;
  }

  try {
    await runProcess('tmux', argv.typeArgv, 3000);
    for (const submit of argv.submitArgv) {
      await runProcess('tmux', submit, 3000);
      // Give the pane a moment to process the keypress; avoids occasional missed submits.
      await new Promise(r => setTimeout(r, 25));
    }
    updateStateForAttempt(true, 'injection_sent');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_sent',
      reason: 'ok',
      pane_target: paneTarget,
      sent: true,
      argv,
    });
  } catch (err) {
    updateStateForAttempt(false, 'send_failed');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_error',
      reason: 'send_failed',
      pane_target: paneTarget,
      error: err instanceof Error ? err.message : safeString(err),
    });
  }
}

async function syncLinkedRalphOnTeamTerminalInDir(stateDir, nowIso) {
  const teamStatePath = join(stateDir, 'team-state.json');
  const ralphStatePath = join(stateDir, 'ralph-state.json');
  if (!existsSync(teamStatePath) || !existsSync(ralphStatePath)) return;

  try {
    const teamState = JSON.parse(await readFile(teamStatePath, 'utf-8'));
    const ralphState = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
    const teamPhase = safeString(teamState.current_phase);
    const linked = teamState.linked_ralph === true && ralphState.linked_team === true;
    if (!linked || !isTerminalPhase(teamPhase)) return;

    let changed = false;
    if (ralphState.active !== false) {
      ralphState.active = false;
      changed = true;
    }
    if (ralphState.current_phase !== teamPhase) {
      ralphState.current_phase = teamPhase;
      changed = true;
    }

    const terminalAt = safeString(teamState.completed_at) || nowIso;
    if (ralphState.linked_team_terminal_phase !== teamPhase) {
      ralphState.linked_team_terminal_phase = teamPhase;
      changed = true;
    }
    if (ralphState.linked_team_terminal_at !== terminalAt) {
      ralphState.linked_team_terminal_at = terminalAt;
      changed = true;
    }
    if (!ralphState.completed_at) {
      ralphState.completed_at = terminalAt;
      changed = true;
    }

    if (changed) {
      ralphState.last_turn_at = nowIso;
      await writeFile(ralphStatePath, JSON.stringify(ralphState, null, 2));
    }
  } catch {
    // Non-critical
  }
}

async function syncLinkedRalphOnTeamTerminal(stateRootDir, nowIso) {
  await syncLinkedRalphOnTeamTerminalInDir(stateRootDir, nowIso);

  const sessionsDir = join(stateRootDir, 'sessions');
  if (!existsSync(sessionsDir)) return;

  try {
    const entries = await readdir(sessionsDir);
    for (const sessionId of entries) {
      // Session IDs are controlled by state-server validation; this check avoids accidental traversal.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) continue;
      await syncLinkedRalphOnTeamTerminalInDir(join(sessionsDir, sessionId), nowIso);
    }
  } catch {
    // Non-critical
  }
}

function parseTeamWorkerEnv(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}

async function main() {
  const rawPayload = process.argv[process.argv.length - 1];
  if (!rawPayload || rawPayload.startsWith('-')) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || payload['cwd'] || process.cwd();
  const omxDir = join(cwd, '.omx');
  const logsDir = join(omxDir, 'logs');
  const stateDir = join(omxDir, 'state');

  // Ensure directories exist
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await mkdir(stateDir, { recursive: true }).catch(() => {});

  // Turn-level dedupe prevents double-processing when native notify and fallback
  // watcher both emit the same completed turn.
  try {
    const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
    if (turnId) {
      const now = Date.now();
      const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
      const eventType = safeString(payload.type || 'agent-turn-complete');
      const key = `${threadId || 'no-thread'}|${turnId}|${eventType}`;
      const dedupeStatePath = join(stateDir, 'notify-hook-state.json');
      const dedupeState = normalizeNotifyState(await readJsonIfExists(dedupeStatePath, null));
      dedupeState.recent_turns = pruneRecentTurns(dedupeState.recent_turns, now);
      if (dedupeState.recent_turns[key]) {
        process.exit(0);
      }
      dedupeState.recent_turns[key] = now;
      dedupeState.last_event_at = new Date().toISOString();
      await writeFile(dedupeStatePath, JSON.stringify(dedupeState, null, 2)).catch(() => {});
    }
  } catch {
    // Non-critical
  }

  // Team worker detection via environment variable
  const teamWorkerEnv = process.env.OMX_TEAM_WORKER; // e.g., "fix-ts/worker-1"
  const parsedTeamWorker = parseTeamWorkerEnv(teamWorkerEnv);
  const isTeamWorker = !!parsedTeamWorker;

  // 1. Log the turn
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: payload.type || 'agent-turn-complete',
    thread_id: payload['thread-id'] || payload.thread_id,
    turn_id: payload['turn-id'] || payload.turn_id,
    input_preview: (payload['input-messages'] || payload.input_messages || [])
      .map(m => m.slice(0, 100))
      .join('; '),
    output_preview: (payload['last-assistant-message'] || payload.last_assistant_message || '')
      .slice(0, 200),
  };

  const logFile = join(logsDir, `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(logFile, JSON.stringify(logEntry) + '\n').catch(() => {});

  // 2. Update active mode state (increment iteration)
  // GUARD: Skip when running inside a team worker to prevent state corruption
  if (!isTeamWorker) {
    try {
      const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
      for (const scopedDir of scopedDirs) {
        const stateFiles = await readdir(scopedDir).catch(() => []);
        for (const f of stateFiles) {
          if (!f.endsWith('-state.json')) continue;
          const statePath = join(scopedDir, f);
          const state = JSON.parse(await readFile(statePath, 'utf-8'));
          if (state.active) {
            state.iteration = (state.iteration || 0) + 1;
            state.last_turn_at = new Date().toISOString();
            await writeFile(statePath, JSON.stringify(state, null, 2));
          }
        }
      }
    } catch {
      // Non-critical
    }
  }

  // If linked team reaches terminal state, mark linked ralph terminal/inactive too.
  if (!isTeamWorker) {
    await syncLinkedRalphOnTeamTerminal(stateDir, new Date().toISOString());
  }

  // 3. Track subagent metrics (lead session only)
  if (!isTeamWorker) {
    const metricsPath = join(omxDir, 'metrics.json');
    try {
      let metrics = {
        total_turns: 0,
        session_turns: 0,
        last_activity: '',
        session_input_tokens: 0,
        session_output_tokens: 0,
        session_total_tokens: 0,
      };
      if (existsSync(metricsPath)) {
        metrics = { ...metrics, ...JSON.parse(await readFile(metricsPath, 'utf-8')) };
      }

      const tokenUsage = getSessionTokenUsage(payload);
      const quotaUsage = getQuotaUsage(payload);

      metrics.total_turns++;
      metrics.session_turns++;
      metrics.last_activity = new Date().toISOString();

      if (tokenUsage) {
        if (tokenUsage.input !== null) {
          if (tokenUsage.inputCumulative) {
            metrics.session_input_tokens = tokenUsage.input;
          } else {
            metrics.session_input_tokens = (metrics.session_input_tokens || 0) + tokenUsage.input;
          }
        }
        if (tokenUsage.output !== null) {
          if (tokenUsage.outputCumulative) {
            metrics.session_output_tokens = tokenUsage.output;
          } else {
            metrics.session_output_tokens = (metrics.session_output_tokens || 0) + tokenUsage.output;
          }
        }
        if (tokenUsage.total !== null) {
          if (tokenUsage.totalCumulative) {
            metrics.session_total_tokens = tokenUsage.total;
          } else {
            metrics.session_total_tokens = (metrics.session_total_tokens || 0) + tokenUsage.total;
          }
        } else {
          metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
        }
      } else {
        metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
      }

      if (quotaUsage) {
        if (quotaUsage.fiveHourLimitPct !== null) metrics.five_hour_limit_pct = quotaUsage.fiveHourLimitPct;
        if (quotaUsage.weeklyLimitPct !== null) metrics.weekly_limit_pct = quotaUsage.weeklyLimitPct;
      }

      await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
    } catch {
      // Non-critical
    }
  }

  // 3.5. Pre-compute leader staleness BEFORE updating HUD state (used by nudge in step 6)
  let preComputedLeaderStale = false;
  if (!isTeamWorker) {
    try {
      const stalenessMs = resolveLeaderStalenessThresholdMs();
      preComputedLeaderStale = await isLeaderStale(stateDir, stalenessMs, Date.now());
    } catch {
      // Non-critical
    }
  }

  // 4. Write HUD state summary for `omx hud` (lead session only)
  if (!isTeamWorker) {
    const hudStatePath = join(stateDir, 'hud-state.json');
    try {
      let hudState = { last_turn_at: '', turn_count: 0 };
      if (existsSync(hudStatePath)) {
        hudState = JSON.parse(await readFile(hudStatePath, 'utf-8'));
      }
      hudState.last_turn_at = new Date().toISOString();
      hudState.turn_count = (hudState.turn_count || 0) + 1;
      hudState.last_agent_output = (payload['last-assistant-message'] || payload.last_assistant_message || '')
        .slice(0, 100);
      await writeFile(hudStatePath, JSON.stringify(hudState, null, 2));
    } catch {
      // Non-critical
    }
  }

  // 4.5. Update team worker heartbeat (if applicable)
  if (isTeamWorker) {
    try {
      if (parsedTeamWorker) {
        const { teamName: twTeamName, workerName: twWorkerName } = parsedTeamWorker;
        const heartbeatPath = join(stateDir, 'team', twTeamName, 'workers', twWorkerName, 'heartbeat.json');
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
    } catch {
      // Non-critical: heartbeat write failure should never block the hook
    }
  }

  // 5. Optional tmux prompt injection workaround (non-fatal, opt-in)
  // Skip for team workers - only the lead should inject prompts
  if (!isTeamWorker) {
    try {
      await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
    } catch {
      // Non-critical
    }
  }

  // 6. Team leader nudge (lead session only): remind the leader to check teammate/mailbox state.
  if (!isTeamWorker) {
    try {
      await maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale });
    } catch {
      // Non-critical
    }
  }

  // 7. Dispatch session-idle lifecycle notification (lead session only, best effort)
  if (!isTeamWorker) {
    try {
      const { notifyLifecycle } = await import('../dist/notifications/index.js');
      const sessionJsonPath = join(stateDir, 'session.json');
      let notifySessionId = '';
      try {
        const sessionData = JSON.parse(await readFile(sessionJsonPath, 'utf-8'));
        notifySessionId = safeString(sessionData && sessionData.session_id ? sessionData.session_id : '');
      } catch { /* no session file */ }

      if (notifySessionId) {
        await notifyLifecycle('session-idle', {
          sessionId: notifySessionId,
          projectPath: cwd,
        });
      }
    } catch {
      // Non-fatal: notification module may not be built or config may not exist
    }
  }
}

async function readdir(dir) {
  const { readdir: rd } = await import('fs/promises');
  return rd(dir);
}

main().catch(() => process.exit(0));
