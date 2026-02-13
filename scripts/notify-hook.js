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

import { writeFile, appendFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
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
      session_counts: {},
      recent_keys: {},
      last_injection_ts: 0,
      last_reason: 'init',
      last_event_at: '',
    };
  }
  return {
    total_injections: asNumber(raw.total_injections) ?? 0,
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

async function resolvePaneTarget(target) {
  if (!target) return null;
  if (target.type === 'pane') return target.value;
  try {
    const result = await runProcess('tmux', ['list-panes', '-t', target.value, '-F', '#{pane_id} #{pane_active}']);
    const lines = result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    const active = lines.find(line => line.endsWith(' 1')) || lines[0];
    const paneId = active.split(' ')[0];
    return paneId || null;
  } catch {
    return null;
  }
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
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    for (const scopedDir of scopedDirs) {
      const files = await readdir(scopedDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'tmux-hook-state.json') continue;
        const path = join(scopedDir, file);
        const parsed = JSON.parse(await readFile(path, 'utf-8'));
        if (parsed && parsed.active) {
          activeModes.push(file.replace('-state.json', ''));
        }
      }
    }
  } catch {
    // Non-fatal
  }

  const mode = pickActiveMode(activeModes, config.allowed_modes);
  const guard = evaluateInjectionGuards({
    config,
    mode,
    sourceText,
    assistantMessage,
    threadId,
    turnId,
    sessionKey,
    now,
    state,
  });

  const baseLog = {
    timestamp: nowIso,
    type: 'tmux_hook',
    mode,
    reason: guard.reason,
    turn_id: turnId,
    thread_id: threadId,
    target: config.target,
    dry_run: config.dry_run,
    sent: false,
  };

  if (!guard.allow) {
    state.last_reason = guard.reason;
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
  const paneTarget = await resolvePaneTarget(config.target);
  if (!paneTarget) {
    state.last_reason = 'target_not_found';
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, { ...baseLog, event: 'injection_skipped', reason: 'target_not_found' });
    return;
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
      state.session_counts[sessionKey] = (asNumber(state.session_counts[sessionKey]) ?? 0) + 1;
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
    await runProcess('tmux', argv, 3000);
    updateStateForAttempt(true, 'injection_sent');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_sent',
      reason: 'ok',
      pane_target: paneTarget,
      sent: true,
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

  // If linked team reaches terminal state, mark linked ralph terminal/inactive too.
  await syncLinkedRalphOnTeamTerminal(stateDir, new Date().toISOString());

  // 3. Track subagent metrics
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

  // 4. Write HUD state summary for `omx hud`
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

  // 5. Optional tmux prompt injection workaround (non-fatal, opt-in)
  try {
    await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
  } catch {
    // Non-critical
  }
}

async function readdir(dir) {
  const { readdir: rd } = await import('fs/promises');
  return rd(dir);
}

main().catch(() => process.exit(0));
