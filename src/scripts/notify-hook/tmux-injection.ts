// @ts-nocheck
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
import { resolveManagedCurrentPane, resolveManagedSessionContext, verifyManagedPaneTarget } from './managed-tmux.js';
import { evaluatePaneInjectionReadiness, mapPaneInjectionReadinessReason, sendPaneInput } from './team-tmux-guard.js';
import {
  normalizeTmuxHookConfig,
  pickActiveMode,
  evaluateInjectionGuards,
  buildSendKeysArgv,
} from '../tmux-hook-engine.js';

function isHudPaneStartCommand(startCommand: any): boolean {
  return /\bomx\b.*\bhud\b.*--watch/i.test(safeString(startCommand));
}

async function resolvePaneCwdMismatch(paneId: string, expectedCwd: any): Promise<any | null> {
  if (!expectedCwd) return null;
  try {
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
  } catch {
    // Best effort only — if tmux cannot report cwd, keep the explicit pane target.
  }
  return null;
}

async function finalizeResolvedPane(paneId: string, reason: string, expectedCwd: any): Promise<any> {
  const cwdMismatch = await resolvePaneCwdMismatch(paneId, expectedCwd);
  if (cwdMismatch) return cwdMismatch;
  let sessionName = '';
  try {
    const currentSession = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
    sessionName = safeString(currentSession.stdout).trim();
  } catch {
    sessionName = '';
  }
  return {
    paneTarget: paneId,
    reason,
    matched_session: sessionName || null,
  };
}

async function resolveCanonicalPaneFromPaneTarget(paneTarget: any, expectedCwd: any): Promise<any> {
  const paneResult = await runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#{pane_id}']);
  const paneId = safeString(paneResult.stdout).trim();
  if (!paneId) return { paneTarget: null, reason: 'target_not_found' };

  let startCommand = '';
  try {
    const startResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#{pane_start_command}']);
    startCommand = safeString(startResult.stdout).trim();
  } catch {
    startCommand = '';
  }
  if (!startCommand || !isHudPaneStartCommand(startCommand)) {
    return finalizeResolvedPane(paneId, 'ok', expectedCwd);
  }

  let sessionName = '';
  try {
    const sessionResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
    sessionName = safeString(sessionResult.stdout).trim();
  } catch {
    sessionName = '';
  }
  if (!sessionName) return { paneTarget: null, reason: 'target_is_hud_pane' };

  const healedPaneId = await resolveSessionToPane(sessionName);
  if (!healedPaneId) return { paneTarget: null, reason: 'target_is_hud_pane' };
  return finalizeResolvedPane(healedPaneId, 'healed_hud_pane_target', expectedCwd);
}

async function resolvePreferredModePane(stateDir: string, allowedModes: string[]): Promise<{ mode: string; state: any; pane: string } | null> {
  const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir).catch(() => [stateDir]);
  const dirs = [...scopedDirs];
  if (!dirs.map((dir) => resolvePath(dir)).includes(resolvePath(stateDir))) {
    dirs.push(stateDir);
  }
  for (const dir of dirs) {
    for (const mode of allowedModes || []) {
      const path = join(dir, `${mode}-state.json`);
      const parsed = await readJsonIfExists(path, null);
      const pane = safeString(parsed?.tmux_pane_id || '').trim();
      if (parsed?.active && pane) {
        return { mode, state: parsed, pane };
      }
    }
  }
  return null;
}

export async function resolveSessionToPane(sessionName: any): Promise<string | null> {
  const result = await runProcess('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_start_command}']);
  const rows = result.stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const parts = line.includes('\t')
        ? line.split('\t')
        : line.split(/\s+/, 4);
      const [paneId = '', activeRaw = '0', currentCommand = '', startCommand = ''] = parts;
      return {
        paneId,
        active: activeRaw === '1',
        currentCommand: safeString(currentCommand).trim().toLowerCase(),
        startCommand: safeString(startCommand).trim(),
      };
    })
    .filter((row: any) => row.paneId.startsWith('%'));
  if (rows.length === 0) return null;

  const nonHudRows = rows.filter((row: any) => !isHudPaneStartCommand(row.startCommand));
  const canonicalRows = nonHudRows.filter((row: any) => /\bcodex\b/i.test(row.startCommand));
  const activeCanonical = canonicalRows.find((row: any) => row.active);
  if (activeCanonical) return activeCanonical.paneId;
  if (canonicalRows[0]) return canonicalRows[0].paneId;

  const activeNonHud = nonHudRows.find((row: any) => row.active);
  if (activeNonHud) return activeNonHud.paneId;
  return nonHudRows[0]?.paneId || null;
}

export async function resolvePaneTarget(target: any, expectedCwd: any, modePane: any, cwd: string, payload: any): Promise<any> {
  const requiresManagedOwnership = safeString(cwd).trim() !== '' && safeString(payload?.session_id || payload?.['session-id'] || process.env.OMX_SESSION_ID || '').trim() !== '';
  const managedContext = requiresManagedOwnership
    ? await resolveManagedSessionContext(cwd, payload, { allowTeamWorker: false })
    : { managed: false, reason: 'not_required', invocationSessionId: '', sessionState: null, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
  if (requiresManagedOwnership && !managedContext.managed) {
    return { paneTarget: null, reason: managedContext.reason || 'unmanaged_session' };
  }

  const canonicalModePane = safeString(modePane).trim();
  if (canonicalModePane) {
    try {
      const resolved = await resolveCanonicalPaneFromPaneTarget(canonicalModePane, expectedCwd);
      if (resolved.paneTarget) {
        const ownership = requiresManagedOwnership
          ? await verifyManagedPaneTarget(resolved.paneTarget, cwd, payload, { allowTeamWorker: false })
          : { ok: true };
        if (ownership.ok) {
          return {
            ...resolved,
            reason: resolved.reason === 'ok' ? 'fallback_mode_state_pane' : resolved.reason,
            source: 'mode_state',
            healTarget: true,
          };
        }
        return { paneTarget: null, reason: ownership.reason || 'pane_not_managed_session' };
      }
    } catch {
      // Fall through to explicit config target
    }
  }

  if (!target) return { paneTarget: null, reason: 'invalid_target' };

  if (target.type === 'pane') {
    try {
      const resolved = await resolveCanonicalPaneFromPaneTarget(target.value, expectedCwd);
      if (resolved.paneTarget) {
        const ownership = requiresManagedOwnership
          ? await verifyManagedPaneTarget(resolved.paneTarget, cwd, payload, { allowTeamWorker: false })
          : { ok: true };
        if (ownership.ok) {
          return {
            ...resolved,
            reason: resolved.reason === 'ok' ? 'explicit_pane_target' : resolved.reason,
            source: 'explicit_target',
            healTarget: true,
          };
        }
        return { paneTarget: null, reason: ownership.reason || 'pane_not_managed_session' };
      }
    } catch {
      // Fall through
    }
    return { paneTarget: null, reason: 'target_not_found' };
  }

  try {
    if (!requiresManagedOwnership) return { paneTarget: null, reason: 'target_session_requires_managed_context' };
    const explicitSessionTarget = safeString(target.value).trim();
    const expectedSessionTarget = safeString(managedContext.expectedTmuxSessionName).trim();
    const sessionIdTarget = safeString(managedContext.invocationSessionId).trim();
    const stateSessionTarget = safeString(managedContext.sessionState?.session_id).trim();
    const allowedSessionTargets = new Set([expectedSessionTarget, sessionIdTarget, stateSessionTarget].filter(Boolean));
    if (!allowedSessionTargets.has(explicitSessionTarget)) {
      return { paneTarget: null, reason: 'target_session_not_managed' };
    }
    const paneId = await resolveSessionToPane(expectedSessionTarget);
    if (!paneId) return { paneTarget: null, reason: 'target_not_found' };
    const resolved = await finalizeResolvedPane(paneId, 'managed_session_target', expectedCwd);
    if (!resolved.paneTarget) return resolved;
    const ownership = await verifyManagedPaneTarget(resolved.paneTarget, cwd, payload, { allowTeamWorker: false });
    if (!ownership.ok) {
      return { paneTarget: null, reason: ownership.reason || 'pane_not_managed_session' };
    }
    return {
      ...resolved,
      source: 'explicit_target',
      healTarget: true,
    };
  } catch {
    return { paneTarget: null, reason: 'target_not_found' };
  }
}

export async function handleTmuxInjection({
  payload,
  cwd,
  stateDir,
  logsDir,
}: any): Promise<void> {
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

  const activeModes: string[] = [];
  const activeModeStates: Record<string, any> = {};
  const scannedStateDirs = new Set<string>();
  const scanActiveModeStateDirs = async (dirs: string[], preserveExisting = false) => {
    for (const scopedDir of dirs) {
      const resolvedScopedDir = resolvePath(scopedDir);
      if (scannedStateDirs.has(resolvedScopedDir)) continue;
      scannedStateDirs.add(resolvedScopedDir);

      const files = await readdir(scopedDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'tmux-hook-state.json') continue;
        const path = join(scopedDir, file);
        const parsed = JSON.parse(await readFile(path, 'utf-8'));
        if (parsed && parsed.active) {
          const modeName = file.replace('-state.json', '');
          activeModes.push(modeName);
          if (!preserveExisting || !activeModeStates[modeName]) {
            activeModeStates[modeName] = parsed;
          }
        }
      }
    }
  };
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    await scanActiveModeStateDirs(scopedDirs);

    if (!pickActiveMode(activeModes, config.allowed_modes) && !scannedStateDirs.has(resolvePath(stateDir))) {
      await scanActiveModeStateDirs([stateDir], true);
    }
  } catch {
    // Non-fatal
  }

  const preferredModePane = await resolvePreferredModePane(stateDir, config.allowed_modes).catch(() => null);
  const mode = preferredModePane?.mode || pickActiveMode(activeModes, config.allowed_modes);
  const modeState = preferredModePane?.state || (mode ? (activeModeStates[mode] || {}) : {});
  const modePane = preferredModePane?.pane || safeString(modeState.tmux_pane_id || '');
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

  const baseLog: any = {
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

  const { renderPrompt, injectLanguageReminder } = await import('./payload-parser.js');
  const prompt = injectLanguageReminder(renderPrompt(config.prompt_template, {
    mode: mode || 'unknown',
    threadId,
    turnId,
    timestamp: nowIso,
  }), sourceText);
  const preferredPaneTarget = modePane || await resolveManagedCurrentPane(cwd, payload, { allowTeamWorker: false });
  let resolution = preferredModePane
    ? await resolveCanonicalPaneFromPaneTarget(preferredModePane.pane, cwd).then((resolved) => (
      resolved.paneTarget
        ? { ...resolved, reason: 'fallback_mode_state_pane', source: 'mode_state', healTarget: true }
        : resolved
    ))
    : preferredPaneTarget
      ? await resolvePaneTarget({ type: 'pane', value: preferredPaneTarget }, cwd, '', cwd, payload)
      : await resolvePaneTarget(config.target, cwd, modePane, cwd, payload);
  if (!resolution.paneTarget && preferredPaneTarget) {
    resolution = await resolvePaneTarget(config.target, cwd, modePane, cwd, payload);
  }
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

  // Pane-canonical healing: persist resolved pane target so routing stops depending on session names or stale pane ids.
  if (resolution.healTarget && config.target && (config.target.type !== 'pane' || safeString(config.target.value).trim() !== paneTarget)) {
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

  const updateStateForAttempt = (success: boolean, reason: string) => {
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

  // Shared pane-state guard: skip injection when the target pane is scrolling,
  // has returned to a shell, is still bootstrapping, or is visibly busy.
  try {
    const paneGuard = await evaluatePaneInjectionReadiness(paneTarget, {
      skipIfScrolling: config.skip_if_scrolling,
    });
    if (!paneGuard.ok) {
      const reason = mapPaneInjectionReadinessReason(paneGuard.reason);
      state.last_reason = reason;
      state.last_event_at = nowIso;
      await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
      await logTmuxHookEvent(logsDir, {
        ...baseLog,
        event: 'injection_skipped',
        reason,
        pane_target: paneTarget,
        pane_current_command: paneGuard.paneCurrentCommand || undefined,
        pane_capture_excerpt: paneGuard.paneCapture ? paneGuard.paneCapture.slice(-200) : undefined,
      });
      return;
    }
  } catch {
    // Non-fatal: if querying pane state fails, proceed with injection.
  }

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
    const sendResult = await sendPaneInput({
      paneTarget,
      prompt,
      submitKeyPresses: argv.submitArgv.length,
      submitDelayMs: 25,
    });
    if (!sendResult.ok) {
      throw new Error(sendResult.error || sendResult.reason);
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
