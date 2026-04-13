import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

export const DEFAULT_ALLOWED_MODES = ['ralph', 'ultrawork', 'team'];
export const DEFAULT_MARKER = '[OMX_TMUX_INJECT]';
const PLACEHOLDER_TARGET_VALUES = new Set([
  'replace-with-tmux-pane-id',
  'replace-with-tmux-session-name',
  'unset',
]);

function asPositiveInteger(value: any): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.floor(value);
}

export function normalizeTmuxHookConfig(raw: any): any {
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
    ? raw.allowed_modes.filter((mode: any) => typeof mode === 'string' && mode.trim() !== '')
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

export function tmuxHookExplicitlyDisablesInjection(raw: any): boolean {
  return Boolean(raw && typeof raw === 'object' && raw.enabled === false);
}

export function pickActiveMode(activeModes: any, allowedModes: any): string | null {
  const activeSet = new Set((activeModes || []).filter((mode: any) => typeof mode === 'string'));
  for (const mode of allowedModes || []) {
    if (activeSet.has(mode)) return mode;
  }
  return null;
}

export function buildDedupeKey({ threadId, turnId, mode, prompt }: any): string {
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
}: any): any {
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
export function buildPaneInModeArgv(paneTarget: any): string[] {
  return ['display-message', '-p', '-t', paneTarget, '#{pane_in_mode}'];
}

/**
 * Returns the tmux argv to query the current foreground command of a pane.
 * Used to detect when the agent process has exited and the pane has returned
 * to a shell (zsh, bash, fish, etc.).
 */
export function buildPaneCurrentCommandArgv(paneTarget: any): string[] {
  return ['display-message', '-p', '-t', paneTarget, '#{pane_current_command}'];
}

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'csh', 'tcsh', 'login']);

/**
 * Returns true when the pane's foreground process is an interactive shell,
 * meaning the agent has exited and injection would land on a bare prompt.
 */
export function isPaneRunningShell(paneCurrentCommand: any): boolean {
  if (typeof paneCurrentCommand !== 'string') return false;
  const cmd = paneCurrentCommand.trim().toLowerCase();
  if (cmd === '') return false;
  // Handle paths like /bin/zsh -> zsh, and flags like -zsh -> zsh
  const base = cmd.split('/').pop()!.replace(/^-/, '');
  return SHELL_COMMANDS.has(base);
}

// Codex agent commands — do NOT include 'claude' (that's Claude Code CLI, a different tool)
const AGENT_COMMANDS = new Set(['node', 'codex', 'npx']);

function isHudStartCommand(startCommand: string): boolean {
  return /\bomx\b.*\bhud\b.*--watch/i.test(startCommand);
}

/**
 * Canonical codex pane resolver. Finds the tmux pane running a codex/claude agent.
 *
 * Resolution order:
 * 1. TMUX_PANE env var — but only if the pane looks like a real agent pane, not HUD
 * 2. Scan all panes in the same tmux session for one started with codex
 * 3. Fail closed instead of guessing a shell or HUD pane
 *
 * All callers (auto-nudge, ralph steer, team dispatch, tmux injection) should
 * use this instead of raw `process.env.TMUX_PANE`.
 */
export function resolveCodexPane(): string {
  const envPane = (process.env.TMUX_PANE || '').trim();
  const tmuxCommand = resolveTmuxBinaryForPlatform() || 'tmux';
  if (!envPane) return '';

  try {
    const cmd = execFileSync(tmuxCommand, ['display-message', '-t', envPane, '-p', '#{pane_current_command}'], {
      encoding: 'utf-8', timeout: 2000, windowsHide: process.platform === 'win32',
    }).trim().toLowerCase();
    const startCmd = execFileSync(tmuxCommand, ['display-message', '-t', envPane, '-p', '#{pane_start_command}'], {
      encoding: 'utf-8', timeout: 2000, windowsHide: process.platform === 'win32',
    }).trim().toLowerCase();
    const base = cmd.split('/').pop()?.replace(/^-/, '') || '';
    if (AGENT_COMMANDS.has(base) && !isHudStartCommand(startCmd)) {
      return envPane;
    }
    if (!SHELL_COMMANDS.has(base)) {
      // Not a shell and not a known agent (e.g. claude CLI) — fall through to
      // session scan so we can still reject HUD or locate a codex pane.
    }
  } catch {
    // Fall through to session scan instead of guessing.
  }

  try {
    const sessionName = execFileSync(tmuxCommand, ['display-message', '-t', envPane, '-p', '#S'], {
      encoding: 'utf-8', timeout: 2000,
      windowsHide: true,
    }).trim();
    if (!sessionName) return '';

    const panes = execFileSync(tmuxCommand, [
      'list-panes', '-s', '-t', sessionName,
      '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}',
    ], { encoding: 'utf-8', timeout: 2000, windowsHide: process.platform === 'win32' }).trim().split('\n');

    for (const line of panes) {
      const parts = line.split('\t');
      const paneId = parts[0];
      const startCmd = (parts[2] || '').toLowerCase();
      if (!paneId) continue;
      if (startCmd.includes('codex') && !isHudStartCommand(startCmd)) {
        return paneId;
      }
    }
  } catch {
    // Fall through
  }

  return '';
}

export function normalizeTmuxCapture(value: any): string {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePaneLines(capturedOrLines: any): string[] {
  if (Array.isArray(capturedOrLines)) {
    return capturedOrLines
      .map((line: any) => String(line ?? '').replace(/\r/g, '').trimEnd())
      .filter((line: string) => line.trim() !== '');
  }

  return String(capturedOrLines ?? '')
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trimEnd())
    .filter((line) => line.trim() !== '');
}

export function paneIsBootstrapping(capturedOrLines: any): boolean {
  const lines = normalizePaneLines(capturedOrLines);
  return lines.some((line) =>
    /\b(loading|initializing|starting up)\b/i.test(line)
    || /\bmodel:\s*loading\b/i.test(line)
    || /\bconnecting\s+to\b/i.test(line)
  );
}

export function paneLooksReady(captured: any): boolean {
  const content = String(captured ?? '').trimEnd();
  if (content === '') return false;

  const lines = normalizePaneLines(content);

  if (paneIsBootstrapping(lines)) return false;

  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  if (/^\s*[›>❯]\s*/u.test(lastLine)) return true;

  const hasCodexPromptLine = lines.some((line) => /^\s*›\s*/u.test(line));
  const hasClaudePromptLine = lines.some((line) => /^\s*❯\s*/u.test(line));
  if (hasCodexPromptLine || hasClaudePromptLine) return true;

  const hasCodexWelcomePrompt = lines.some((line) => /\bhow can i help(?: you)?\b/i.test(line));
  if (hasCodexWelcomePrompt) return true;

  return lines.some((line) => /^\s*(?:[›>❯]\s*)?[A-Z][A-Z0-9]+-\d+\s+only(?:\s*(?:…|\.{3}))?\s*$/iu.test(line));
}

export function paneShowsCodexViewport(captured: any): boolean {
  const lines = normalizePaneLines(captured);
  if (lines.length === 0) return false;
  if (paneIsBootstrapping(lines)) return false;

  const hasCodexBanner = lines.some((line) => /\bOpenAI Codex\b/i.test(line));
  if (!hasCodexBanner) return false;

  return lines.some((line) => /(?:^|\s)(?:model|directory):/i.test(line));
}

export function paneHasActiveTask(captured: any): boolean {
  const tail = normalizePaneLines(captured).map((line) => line.trim()).slice(-40);
  if (tail.some((line) => /\b\d+\s+background terminal running\b/i.test(line))) return true;
  if (tail.some((line) => /esc to interrupt/i.test(line))) return true;
  if (tail.some((line) => /\bbackground terminal running\b/i.test(line))) return true;
  if (tail.some((line) => /^•\s.+\(.+•\s*esc to interrupt\)$/i.test(line))) return true;
  return tail.some((line) => /^[·✻]\s+[A-Za-z][A-Za-z0-9''-]*(?:\s+[A-Za-z][A-Za-z0-9''-]*){0,3}(?:…|\.{3})$/u.test(line));
}

export function buildCapturePaneArgv(paneTarget: any, tailLines = 80): string[] {
  return ['capture-pane', '-t', paneTarget, '-p', '-S', `-${tailLines}`];
}

export function buildVisibleCapturePaneArgv(paneTarget: any): string[] {
  return ['capture-pane', '-t', paneTarget, '-p'];
}

export function buildSendKeysArgv({ paneTarget, prompt, dryRun, submitKeyPresses = 2 }: any): any {
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
