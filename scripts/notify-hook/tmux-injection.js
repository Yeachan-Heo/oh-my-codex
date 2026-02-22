/**
 * Tmux prompt injection for notify-hook.
 * Handles pane resolution, injection guards, and state healing.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { safeString, asNumber } from './utils.js';
import {
  readJsonIfExists,
  normalizeTmuxState,
  pruneRecentKeys,
  getScopedStateDirsForCurrentSession,
  readdir,
} from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import {
  normalizeTmuxHookConfig,
  pickActiveMode,
  evaluateInjectionGuards,
  buildSendKeysArgv,
} from '../tmux-hook-engine.js';

export async function resolveSessionToPane(sessionName) {
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

export async function resolvePaneByCwd(expectedCwd) {
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

export async function resolvePaneTarget(target, fallbackPane, expectedCwd, modePane) {
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

export async function handleTmuxInjection({
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

  const { normalizeInputMessages } = await import('./payload-parser.js');
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

  const { renderPrompt } = await import('./payload-parser.js');
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
