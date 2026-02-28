import { createHash } from 'crypto';

export const DEFAULT_ALLOWED_MODES = ['ralph', 'ultrawork', 'team'];
export const DEFAULT_MARKER = '[OMX_TMUX_INJECT]';
const PLACEHOLDER_TARGET_VALUES = new Set([
  'replace-with-tmux-pane-id',
  'replace-with-tmux-session-name',
  'unset',
]);

function asPositiveInteger(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.floor(value);
}

export function normalizeTmuxHookConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: false,
      valid: false,
      reason: 'missing_config',
      target: null,
      allowed_modes: DEFAULT_ALLOWED_MODES,
      cooldown_ms: 15000,
      max_injections_per_session: 200,
      prompt_template: `Continue from current mode state. ${DEFAULT_MARKER}`,
      marker: DEFAULT_MARKER,
      dry_run: false,
      log_level: 'info',
    };
  }

  const allowedModes = Array.isArray(raw.allowed_modes)
    ? raw.allowed_modes.filter(mode => typeof mode === 'string' && mode.trim() !== '')
    : [];

  const targetValue = raw.target && typeof raw.target === 'object' && typeof raw.target.value === 'string'
    ? raw.target.value.trim()
    : '';
  const targetValueLower = targetValue.toLowerCase();
  const targetIsValid = raw.target
    && typeof raw.target === 'object'
    && (raw.target.type === 'session' || raw.target.type === 'pane')
    && targetValue !== ''
    && !PLACEHOLDER_TARGET_VALUES.has(targetValueLower);

  const cooldown = asPositiveInteger(raw.cooldown_ms);
  const maxPerPane = asPositiveInteger(raw.max_injections_per_pane);
  const maxPerSession = asPositiveInteger(raw.max_injections_per_session);

  const marker = typeof raw.marker === 'string' && raw.marker.trim() !== ''
    ? raw.marker
    : DEFAULT_MARKER;

  const promptTemplate = typeof raw.prompt_template === 'string' && raw.prompt_template.trim() !== ''
    ? raw.prompt_template
    : `Continue from current mode state. ${marker}`;

  const logLevel = raw.log_level === 'error' || raw.log_level === 'debug' ? raw.log_level : 'info';

  return {
    enabled: raw.enabled === true,
    valid: targetIsValid,
    reason: targetIsValid ? 'ok' : 'invalid_target',
    target: targetIsValid ? { type: raw.target.type, value: raw.target.value } : null,
    allowed_modes: allowedModes.length > 0 ? allowedModes : DEFAULT_ALLOWED_MODES,
    cooldown_ms: cooldown === null ? 15000 : cooldown,
    // Canonical setting is per-pane. Keep max_injections_per_session as legacy alias.
    max_injections_per_session: maxPerPane === null
      ? (maxPerSession === null || maxPerSession === 0 ? 200 : maxPerSession)
      : (maxPerPane === 0 ? 200 : maxPerPane),
    prompt_template: promptTemplate,
    marker,
    dry_run: raw.dry_run === true,
    log_level: logLevel,
    // Skip injection when the target pane is in copy-mode / scrollback (default: true).
    skip_if_scrolling: raw.skip_if_scrolling === false ? false : true,
  };
}

export function pickActiveMode(activeModes, allowedModes) {
  const activeSet = new Set((activeModes || []).filter(mode => typeof mode === 'string'));
  for (const mode of allowedModes || []) {
    if (activeSet.has(mode)) return mode;
  }
  return null;
}

export function buildDedupeKey({ threadId, turnId, mode, prompt }) {
  const keyBase = `${threadId || 'no-thread'}|${turnId || 'no-turn'}|${mode || 'no-mode'}|${prompt || ''}`;
  return createHash('sha256').update(keyBase).digest('hex');
}

export function evaluateInjectionGuards({
  config,
  mode,
  sourceText,
  assistantMessage,
  threadId,
  turnId,
  paneKey,
  sessionKey,
  skipQuotaChecks,
  now,
  state,
}) {
  if (!config.enabled) return { allow: false, reason: 'disabled' };
  if (!config.valid || !config.target) return { allow: false, reason: 'invalid_config' };
  if (!mode) return { allow: false, reason: 'mode_not_allowed' };

  const source = typeof sourceText === 'string' ? sourceText : '';
  if (config.marker && typeof assistantMessage === 'string' && assistantMessage.includes(config.marker)) {
    return { allow: false, reason: 'loop_guard_output_marker' };
  }
  if (config.marker && source.includes(config.marker)) {
    return { allow: false, reason: 'loop_guard_input_marker' };
  }

  const dedupeKey = buildDedupeKey({ threadId, turnId, mode, prompt: source });
  const recentKeys = state.recent_keys && typeof state.recent_keys === 'object' ? state.recent_keys : {};
  if (recentKeys[dedupeKey]) {
    return { allow: false, reason: 'duplicate_event', dedupeKey };
  }

  if (!skipQuotaChecks) {
    // Pane is canonical for routing; read legacy session_counts for compatibility.
    const paneCounts = state.pane_counts && typeof state.pane_counts === 'object' ? state.pane_counts : {};
    const legacySessionCounts = state.session_counts && typeof state.session_counts === 'object' ? state.session_counts : {};
    const paneKeyNorm = typeof paneKey === 'string' && paneKey.trim() !== '' ? paneKey : '';
    const sessionKeyNorm = typeof sessionKey === 'string' && sessionKey.trim() !== '' ? sessionKey : 'unknown';
    const count = paneKeyNorm && typeof paneCounts[paneKeyNorm] === 'number'
      ? paneCounts[paneKeyNorm]
      : (typeof legacySessionCounts[sessionKeyNorm] === 'number' ? legacySessionCounts[sessionKeyNorm] : 0);
    if (count >= config.max_injections_per_session) {
      return { allow: false, reason: 'pane_cap_reached', dedupeKey };
    }

    const lastInjectionTs = typeof state.last_injection_ts === 'number' ? state.last_injection_ts : 0;
    if (config.cooldown_ms > 0 && lastInjectionTs > 0 && now - lastInjectionTs < config.cooldown_ms) {
      return { allow: false, reason: 'cooldown_active', dedupeKey };
    }
  }

  return { allow: true, reason: 'ok', dedupeKey };
}

/**
 * Returns the tmux argv to query whether a pane is currently in copy-mode
 * (scrollback). The command prints "1" if the pane is in any mode, "0"
 * otherwise.
 */
export function buildPaneInModeArgv(paneTarget) {
  return ['display-message', '-p', '-t', paneTarget, '#{pane_in_mode}'];
}

export function buildCapturePaneArgv(paneTarget, tailLines = 80) {
  return ['capture-pane', '-t', paneTarget, '-p', '-S', `-${tailLines}`];
}

export function buildSendKeysArgv({ paneTarget, prompt, dryRun, submitKeyPresses = 2 }) {
  if (dryRun) return null;
  const pressCountRaw = Number.isFinite(submitKeyPresses) ? Math.floor(submitKeyPresses) : 2;
  const pressCount = Math.max(1, Math.min(4, pressCountRaw));
  const submitArgv = Array.from({ length: pressCount }, () => ([
    'send-keys', '-t', paneTarget, 'C-m',
  ]));
  // Use a 2-step send for reliability:
  // 1) literal prompt bytes, 2) explicit carriage return.
  return {
    typeArgv: ['send-keys', '-t', paneTarget, '-l', prompt],
    // Codex generally prefers two presses; Claude typically needs one.
    submitArgv,
  };
}
