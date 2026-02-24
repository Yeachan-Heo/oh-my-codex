import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_HEIGHT_LINES } from '../hud/constants.js';

export interface TeamSession {
  name: string; // tmux target in "session:window" form
  workerCount: number;
  cwd: string;
  workerPaneIds: string[];
  /** Leader's own pane ID — must never be targeted by worker cleanup routines. */
  leaderPaneId: string;
  /** HUD pane spawned below the leader column, or null if creation failed. */
  hudPaneId: string | null;
  /** Registered tmux resize hook name for the HUD pane, or null if unavailable. */
  resizeHookName: string | null;
  /** Registered tmux resize hook target in "<session>:<window>" form, or null. */
  resizeHookTarget: string | null;
}

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MADMAX_FLAG = '--madmax';
const CONFIG_FLAG = '-c';
const LONG_CONFIG_FLAG = '--config';
const MODEL_FLAG = '--model';
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = 'OMX_BYPASS_DEFAULT_SYSTEM_PROMPT';
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const OMX_TEAM_WORKER_CLI_ENV = 'OMX_TEAM_WORKER_CLI';
const OMX_TEAM_WORKER_CLI_MAP_ENV = 'OMX_TEAM_WORKER_CLI_MAP';
const OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV = 'OMX_TEAM_AUTO_INTERRUPT_RETRY';

export type TeamWorkerCli = 'codex' | 'claude';
type TeamWorkerCliMode = 'auto' | TeamWorkerCli;

interface WorkerLaunchSpec {
  shell: string;
  rcFile: string | null;
}

interface TmuxPaneInfo {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
}

function baseSessionName(target: string): string {
  return target.split(':')[0] || target;
}

function listPanes(target: string): TmuxPaneInfo[] {
  const result = runTmux(['list-panes', '-t', target, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}']);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId = '', currentCommand = '', startCommand = ''] = line.split('\t');
      return { paneId, currentCommand, startCommand };
    })
    .filter((pane) => pane.paneId.startsWith('%'));
}

function isHudWatchPane(pane: TmuxPaneInfo): boolean {
  const start = pane.startCommand || '';
  return /\bomx\b.*\bhud\b.*--watch/i.test(start);
}

export function chooseTeamLeaderPaneId(panes: TmuxPaneInfo[], preferredPaneId: string): string {
  const preferred = panes.find((pane) => pane.paneId === preferredPaneId);
  if (preferred && !isHudWatchPane(preferred)) return preferred.paneId;

  const nonHud = panes.find((pane) => !isHudWatchPane(pane));
  if (nonHud) return nonHud.paneId;

  return preferredPaneId;
}

function findHudPaneIds(target: string, leaderPaneId: string): string[] {
  const panes = listPanes(target);
  return panes
    .filter((pane) => pane.paneId !== leaderPaneId)
    .filter((pane) => isHudWatchPane(pane))
    .map((pane) => pane.paneId);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const MAX_FRACTIONAL_SLEEP_MS = 60_000;

function toFractionalSleepMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const ms = Math.ceil(seconds * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_FRACTIONAL_SLEEP_MS, ms);
}

function sleepSeconds(seconds: number): void {
  sleepFractionalSeconds(seconds);
}

export function sleepFractionalSeconds(
  seconds: number,
  sleepImpl: (ms: number) => void = sleepMs,
): void {
  const ms = toFractionalSleepMs(seconds);
  if (ms <= 0) return;
  sleepImpl(ms);
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTmuxHookToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return normalized === '' ? 'unknown' : normalized;
}

function normalizeHudPaneToken(hudPaneId: string): string {
  const trimmed = hudPaneId.trim();
  const withoutPrefix = trimmed.startsWith('%') ? trimmed.slice(1) : trimmed;
  return normalizeTmuxHookToken(withoutPrefix);
}

export function buildResizeHookTarget(sessionName: string, windowIndex: string): string {
  return `${sessionName}:${windowIndex}`;
}

export function buildResizeHookName(
  teamName: string,
  sessionName: string,
  windowIndex: string,
  hudPaneId: string,
): string {
  return [
    'omx_resize',
    normalizeTmuxHookToken(teamName),
    normalizeTmuxHookToken(sessionName),
    normalizeTmuxHookToken(windowIndex),
    normalizeHudPaneToken(hudPaneId),
  ].join('_');
}

export function buildHudPaneTarget(hudPaneId: string): string {
  const trimmed = hudPaneId.trim();
  return trimmed.startsWith('%') ? trimmed : `%${trimmed}`;
}

function buildHudResizeCommand(hudPaneId: string): string {
  return `resize-pane -t ${buildHudPaneTarget(hudPaneId)} -y ${HUD_TMUX_HEIGHT_LINES}`;
}

export function buildRegisterResizeHookArgs(hookTarget: string, hookName: string, hudPaneId: string): string[] {
  const resizeCommand = shellQuoteSingle(`tmux ${buildHudResizeCommand(hudPaneId)}`);
  return ['set-hook', '-t', hookTarget, `client-resized[${hookName}]`, `run-shell -b ${resizeCommand}`];
}

export function buildUnregisterResizeHookArgs(hookTarget: string, hookName: string): string[] {
  return ['set-hook', '-u', '-t', hookTarget, `client-resized[${hookName}]`];
}

export function unregisterResizeHook(hookTarget: string, hookName: string): boolean {
  const result = runTmux(buildUnregisterResizeHookArgs(hookTarget, hookName));
  return result.ok;
}

export function buildScheduleDelayedHudResizeArgs(
  hudPaneId: string,
  delaySeconds: number = HUD_RESIZE_RECONCILE_DELAY_SECONDS,
): string[] {
  const delay = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : HUD_RESIZE_RECONCILE_DELAY_SECONDS;
  return ['run-shell', '-b', `sleep ${delay}; tmux ${buildHudResizeCommand(hudPaneId)}`];
}

export function buildReconcileHudResizeArgs(hudPaneId: string): string[] {
  return buildHudResizeCommand(hudPaneId).split(' ');
}

function buildWorkerLaunchSpec(shellPath: string | undefined): WorkerLaunchSpec {
  if (shellPath && /\/zsh$/i.test(shellPath)) {
    return { shell: shellPath, rcFile: '~/.zshrc' };
  }
  if (shellPath && /\/bash$/i.test(shellPath)) {
    return { shell: shellPath, rcFile: '~/.bashrc' };
  }
  if (shellPath && shellPath.trim() !== '') {
    return { shell: shellPath, rcFile: null };
  }
  return { shell: '/bin/sh', rcFile: null };
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

function hasModelInstructionsOverride(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isModelInstructionsOverride(maybeValue)) {
        return true;
      }
      continue;
    }
    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const inlineValue = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
      if (isModelInstructionsOverride(inlineValue)) return true;
    }
  }
  return false;
}

function normalizeTeamWorkerCliMode(raw: string | undefined, sourceEnv: string = OMX_TEAM_WORKER_CLI_ENV): TeamWorkerCliMode {
  const normalized = String(raw ?? 'auto').trim().toLowerCase();
  if (normalized === '' || normalized === 'auto') return 'auto';
  if (normalized === 'codex' || normalized === 'claude') return normalized;
  throw new Error(`Invalid ${sourceEnv} value "${raw}". Expected: auto, codex, claude`);
}

function extractModelOverride(args: string[]): string | null {
  let model: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === MODEL_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && maybeValue.trim() !== '' && !maybeValue.startsWith('-')) {
        model = maybeValue.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inline = arg.slice(`${MODEL_FLAG}=`.length).trim();
      if (inline !== '') model = inline;
    }
  }
  return model;
}

export function resolveTeamWorkerCli(launchArgs: string[] = [], env: NodeJS.ProcessEnv = process.env): TeamWorkerCli {
  const mode = normalizeTeamWorkerCliMode(env[OMX_TEAM_WORKER_CLI_ENV]);
  if (mode !== 'auto') return mode;
  return resolveTeamWorkerCliFromLaunchArgs(launchArgs);
}

function resolveTeamWorkerCliFromLaunchArgs(launchArgs: string[] = []): TeamWorkerCli {
  const model = extractModelOverride(launchArgs);
  return model && /claude/i.test(model) ? 'claude' : 'codex';
}

export function resolveTeamWorkerCliPlan(
  workerCount: number,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli[] {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }

  const rawMap = String(env[OMX_TEAM_WORKER_CLI_MAP_ENV] ?? '').trim();
  const fallback = (): TeamWorkerCli => resolveTeamWorkerCli(launchArgs, env);
  const fallbackAutoFromArgs = (): TeamWorkerCli => resolveTeamWorkerCliFromLaunchArgs(launchArgs);

  if (rawMap === '') {
    const cli = fallback();
    return Array.from({ length: workerCount }, () => cli);
  }

  const entries = rawMap
    .split(',')
    .map((part) => part.trim());

  if (entries.length === 0 || entries.every((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Expected comma-separated values: auto|codex|claude.`,
    );
  }
  if (entries.some((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Empty entries are not allowed.`,
    );
  }
  if (entries.length !== 1 && entries.length !== workerCount) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} length ${entries.length}; `
        + `expected 1 or ${workerCount} comma-separated values.`,
    );
  }

  const expanded = entries.length === 1 ? Array.from({ length: workerCount }, () => entries[0] as string) : entries;
  return expanded.map((entry) => {
    const mode = normalizeTeamWorkerCliMode(entry, OMX_TEAM_WORKER_CLI_MAP_ENV);
    return mode === 'auto' ? fallbackAutoFromArgs() : mode;
  });
}

export function translateWorkerLaunchArgsForCli(workerCli: TeamWorkerCli, args: string[]): string[] {
  if (workerCli === 'codex') return [...args];

  // Claude workers must launch as plain `claude` with no extra args.
  // This preserves Claude defaults from settings.json and avoids passing
  // Codex-only flags, model overrides, or config/reasoning overrides.
  void args;
  return [];
}

function commandExists(binary: string): boolean {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf-8' });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
  }
  return true;
}

export function assertTeamWorkerCliBinaryAvailable(
  workerCli: TeamWorkerCli,
  existsImpl: (binary: string) => boolean = commandExists,
): void {
  if (existsImpl(workerCli)) return;
  throw new Error(
    `Selected team worker CLI "${workerCli}" is not available on PATH. `
      + `Install "${workerCli}" or set ${OMX_TEAM_WORKER_CLI_ENV}=codex|claude.`,
  );
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== '0';
}

function buildModelInstructionsOverride(cwd: string, env: NodeJS.ProcessEnv): string {
  const filePath = env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] || join(cwd, 'AGENTS.md');
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

function resolveWorkerLaunchArgs(extraArgs: string[] = [], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const merged = [...extraArgs];
  const wantsBypass = process.argv.includes(CODEX_BYPASS_FLAG) || process.argv.includes(MADMAX_FLAG);
  if (wantsBypass && !merged.includes(CODEX_BYPASS_FLAG)) {
    merged.push(CODEX_BYPASS_FLAG);
  }
  if (shouldBypassDefaultSystemPrompt(env) && !hasModelInstructionsOverride(merged)) {
    merged.push(CONFIG_FLAG, buildModelInstructionsOverride(cwd, env));
  }
  return merged;
}

export function buildWorkerStartupCommand(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
): string {
  const spec = buildWorkerLaunchSpec(process.env.SHELL);
  const fullLaunchArgs = resolveWorkerLaunchArgs(launchArgs, cwd);
  const workerCli = workerCliOverride ?? resolveTeamWorkerCli(fullLaunchArgs, process.env);
  const cliLaunchArgs = translateWorkerLaunchArgsForCli(workerCli, fullLaunchArgs);
  const quotedArgs = cliLaunchArgs.map(shellQuoteSingle).join(' ');
  const cliInvocation = quotedArgs.length > 0 ? `exec ${workerCli} ${quotedArgs}` : `exec ${workerCli}`;
  const rcPrefix = spec.rcFile ? `if [ -f ${spec.rcFile} ]; then source ${spec.rcFile}; fi; ` : '';
  const inner = `${rcPrefix}${cliInvocation}`;

  const envParts = [`OMX_TEAM_WORKER=${teamName}/worker-${workerIndex}`];
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    envParts.push(`${key}=${value}`);
  }

  return `env ${envParts.map(shellQuoteSingle).join(' ')} ${shellQuoteSingle(spec.shell)} -lc ${shellQuoteSingle(inner)}`;
}

// Sanitize team name: lowercase, alphanumeric + hyphens, max 30 chars
export function sanitizeTeamName(name: string): string {
  const lowered = name.toLowerCase();
  const replaced = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');

  const truncated = replaced.slice(0, 30).replace(/-$/, '');
  if (truncated.trim() === '') {
    throw new Error('sanitizeTeamName: empty after sanitization');
  }
  return truncated;
}

/**
 * Detect whether the process is running inside a WSL2 environment.
 * WSL2 always sets WSL_DISTRO_NAME; WSL_INTEROP is also present.
 * Fallback: check /proc/version for the Microsoft kernel string.
 */
export function isWsl2(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Detect whether the process is running on native Windows (not WSL2).
 * OMX requires tmux, which is unavailable on native Windows.
 */
export function isNativeWindows(): boolean {
  return process.platform === 'win32' && !isWsl2();
}

// Check if tmux is available
export function isTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' });
  if (result.error) return false;
  return result.status === 0;
}

// Create tmux session with N worker windows
// Split the current tmux leader window into worker panes.
// Returns TeamSession or throws if tmux not available
export function createTeamSession(
  teamName: string,
  workerCount: number,
  cwd: string,
  workerLaunchArgs: string[] = [],
  workerStartups: Array<{ cwd?: string; env?: Record<string, string> }> = [],
): TeamSession {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!process.env.TMUX) {
    throw new Error('team mode requires running inside tmux leader pane');
  }
  const normalizedWorkerLaunchArgs = resolveWorkerLaunchArgs(workerLaunchArgs, cwd);
  const workerCliPlan = resolveTeamWorkerCliPlan(workerCount, normalizedWorkerLaunchArgs, process.env);
  for (const workerCli of new Set(workerCliPlan)) {
    assertTeamWorkerCliBinaryAvailable(workerCli);
  }

  const safeTeamName = sanitizeTeamName(teamName);
  let registeredResizeHook: { name: string; target: string } | null = null;
  const rollbackPaneIds: string[] = [];
  try {
    const context = runTmux(['display-message', '-p', '#S:#I #{pane_id}']);
    if (!context.ok) {
      throw new Error(`failed to detect current tmux target: ${context.stderr}`);
    }
    const [sessionAndWindow = '', detectedLeaderPaneId = ''] = context.stdout.split(' ');
    const [sessionName, windowIndex] = (sessionAndWindow || '').split(':');
    if (!sessionName || !windowIndex || !detectedLeaderPaneId || !detectedLeaderPaneId.startsWith('%')) {
      throw new Error(`failed to parse current tmux target: ${context.stdout}`);
    }
    const teamTarget = `${sessionName}:${windowIndex}`;
    const panes = listPanes(teamTarget);
    const leaderPaneId = chooseTeamLeaderPaneId(panes, detectedLeaderPaneId);
    const initialHudPaneIds = findHudPaneIds(teamTarget, leaderPaneId);
    // Team mode prioritizes leader + worker visibility. Remove HUD panes in this window
    // to keep a clean "leader left / workers right" layout.
    for (const hudPaneId of initialHudPaneIds) {
      runTmux(['kill-pane', '-t', hudPaneId]);
    }

    const workerPaneIds: string[] = [];
    let rightStackRootPaneId: string | null = null;
    for (let i = 1; i <= workerCount; i++) {
      const startup = workerStartups[i - 1] || {};
      const workerCwd = startup.cwd || cwd;
      const workerEnv = startup.env || {};
      const cmd = buildWorkerStartupCommand(
        safeTeamName,
        i,
        workerLaunchArgs,
        workerCwd,
        workerEnv,
        workerCliPlan[i - 1],
      );
      // First split creates the right side from leader. Remaining splits stack on the right.
      const splitDirection = i === 1 ? '-h' : '-v';
      const splitTarget = i === 1 ? leaderPaneId : (rightStackRootPaneId ?? leaderPaneId);
      const split = runTmux([
        'split-window',
        splitDirection,
        '-t',
        splitTarget,
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-c',
        workerCwd,
        cmd,
      ]);
      if (!split.ok) {
        throw new Error(`failed to create worker pane ${i}: ${split.stderr}`);
      }
      const paneId = split.stdout.split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        throw new Error(`failed to capture worker pane id for worker ${i}`);
      }
      workerPaneIds.push(paneId);
      rollbackPaneIds.push(paneId);
      if (i === 1) rightStackRootPaneId = paneId;
    }

    // Keep leader as full left/main pane; workers stay stacked on the right.
    runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);

    // Force leader pane to use half the window width.
    const windowWidthResult = runTmux(['display-message', '-p', '-t', teamTarget, '#{window_width}']);
    if (windowWidthResult.ok) {
      const width = Number.parseInt(windowWidthResult.stdout.split('\n')[0]?.trim() || '', 10);
      if (Number.isFinite(width) && width >= 40) {
        const half = String(Math.floor(width / 2));
        runTmux(['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
        runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);
      }
    }

    // Re-create a single HUD pane under the leader column for team visibility.
    // Keep this after layout sizing so HUD does not get mixed into worker stack.
    // Capture the HUD pane ID so it can be tracked and excluded from worker cleanup.
    let hudPaneId: string | null = null;
    let resizeHookName: string | null = null;
    let resizeHookTarget: string | null = null;
    const omxEntry = process.argv[1];
    if (omxEntry && omxEntry.trim() !== '') {
      const hudCmd = `node ${shellQuoteSingle(omxEntry)} hud --watch`;
      const hudResult = runTmux([
        'split-window', '-v', '-l', String(HUD_TMUX_HEIGHT_LINES), '-t', leaderPaneId, '-d', '-P', '-F', '#{pane_id}', '-c', cwd, hudCmd,
      ]);
      if (hudResult.ok) {
        const id = hudResult.stdout.split('\n')[0]?.trim() ?? '';
        if (id.startsWith('%')) {
          hudPaneId = id;
          rollbackPaneIds.push(hudPaneId);

          resizeHookTarget = buildResizeHookTarget(sessionName, windowIndex);
          resizeHookName = buildResizeHookName(safeTeamName, sessionName, windowIndex, hudPaneId);
          const registerHook = runTmux(buildRegisterResizeHookArgs(resizeHookTarget, resizeHookName, hudPaneId));
          if (!registerHook.ok) {
            throw new Error(`failed to register resize hook ${resizeHookName}: ${registerHook.stderr}`);
          }
          registeredResizeHook = { name: resizeHookName, target: resizeHookTarget };

          const delayed = runTmux(buildScheduleDelayedHudResizeArgs(hudPaneId));
          if (!delayed.ok) {
            throw new Error(`failed to schedule delayed HUD resize: ${delayed.stderr}`);
          }
          const reconcile = runTmux(buildReconcileHudResizeArgs(hudPaneId));
          if (!reconcile.ok) {
            throw new Error(`failed to reconcile HUD resize: ${reconcile.stderr}`);
          }
        }
      }
    }

    runTmux(['select-pane', '-t', leaderPaneId]);
    sleepSeconds(0.5);

    // Enable mouse scrolling so agent output panes can be scrolled with the
    // mouse wheel without conflicting with keyboard up/down arrow-key input
    // history navigation in the Codex CLI input field. (issue #103)
    // Opt-out: set OMX_TEAM_MOUSE=0 in the environment.
    if (process.env.OMX_TEAM_MOUSE !== '0') {
      enableMouseScrolling(sessionName);
    }

    return {
      name: teamTarget,
      workerCount,
      cwd,
      workerPaneIds,
      leaderPaneId,
      hudPaneId,
      resizeHookName,
      resizeHookTarget,
    };
  } catch (error) {
    if (registeredResizeHook) {
      runTmux(buildUnregisterResizeHookArgs(registeredResizeHook.target, registeredResizeHook.name));
    }
    for (const paneId of rollbackPaneIds) {
      runTmux(['kill-pane', '-t', paneId]);
    }
    throw error;
  }
}

/**
 * Returns the tmux argv arrays for the scroll-and-copy key bindings applied
 * by enableMouseScrolling. Exported as a pure function so tests can verify
 * the binding configuration without requiring a live tmux session.
 *
 * The bindings fix two issues that appear in --xhigh and --madmax modes
 * (closes #206):
 *
 *  1. Scroll: Codex CLI TUI claims mouse input, causing tmux to forward wheel
 *     events to the application where they are interpreted as up/down arrow
 *     keys (history navigation). The WheelUpPane binding in the root table
 *     intercepts scroll events before they reach the app and enters tmux
 *     copy-mode so the user sees viewport scrolling instead.
 *
 *  2. Copy: with only "mouse on" set, selecting text with the mouse does not
 *     reach the system clipboard. The MouseDragEnd1Pane binding in copy-mode
 *     copies the selection via copy-selection-and-cancel; OSC 52
 *     (set-clipboard on) then propagates it to the terminal's clipboard.
 */
export function buildScrollCopyBindings(): Array<string[]> {
  return [
    // On scroll-up: if already in copy-mode forward the event; otherwise
    // enter copy-mode first so the user gets viewport scroll, not history nav.
    [
      'bind-key', '-n', 'WheelUpPane',
      'if-shell', '-Ft=', '#{pane_in_mode}',
      'send-keys -M',
      'select-pane -t=; copy-mode -e; send-keys -M',
    ],
    // Copy mouse-selected text to clipboard when the drag ends in copy-mode.
    [
      'bind-key', '-T', 'copy-mode', 'MouseDragEnd1Pane',
      'send-keys', '-X', 'copy-selection-and-cancel',
    ],
  ];
}

/**
 * Enable tmux mouse mode for a session so users can scroll pane content
 * (e.g. long agent output) with the mouse wheel instead of arrow keys.
 * Arrow keys remain reserved for Codex CLI input-history navigation.
 *
 * Also configures viewport scrolling via copy-mode on wheel-up and clipboard
 * copy on mouse selection, fixing scroll and copy issues in --xhigh and
 * --madmax modes. (closes #206)
 *
 * In WSL2, Windows Terminal uses the SGR mouse protocol but tmux will not
 * activate it unless the terminal advertises the XT capability. Without XT,
 * scroll wheel events are silently dropped. When a WSL2 environment is
 * detected the global terminal-overrides are extended with xterm*:XT so
 * that tmux negotiates the correct protocol with the host terminal. (closes #113)
 *
 * Returns true if the option was set successfully, false otherwise.
 */
export function enableMouseScrolling(sessionTarget: string): boolean {
  const result = runTmux(['set-option', '-t', sessionTarget, 'mouse', 'on']);
  if (!result.ok) return false;

  // Enable OSC 52 so copy-selection-and-cancel propagates selected text to
  // the terminal's clipboard without requiring xclip or pbcopy. (closes #206)
  runTmux(['set-option', '-t', sessionTarget, 'set-clipboard', 'on']);

  // Apply the scroll-into-copy-mode and mouse-copy bindings. (closes #206)
  for (const binding of buildScrollCopyBindings()) {
    runTmux(binding);
  }

  if (isWsl2()) {
    // Append the XT capability override globally (terminal-overrides is a
    // global-only option). -ga appends rather than replacing, preserving any
    // overrides the user may already have configured.
    runTmux(['set-option', '-ga', 'terminal-overrides', ',xterm*:XT']);
  }

  return true;
}

function paneTarget(sessionName: string, workerIndex: number, workerPaneId?: string): string {
  if (workerPaneId && workerPaneId.startsWith('%')) return workerPaneId;
  if (sessionName.includes(':')) {
    return `${sessionName}.${workerIndex}`;
  }
  return `${sessionName}:${workerIndex}`;
}

function paneLooksReady(captured: string): boolean {
  const content = captured.trimEnd();
  if (content === '') return false;

  const lines = content
    .split('\n')
    .map(l => l.replace(/\r/g, ''))
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '');

  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  if (/^\s*[›>❯]\s*/u.test(lastLine)) return true;

  // Codex TUI often renders a status bar/footer instead of a raw shell prompt.
  // Treat common Codex UI markers as "ready enough" for inbox-trigger dispatch.
  const hasCodexPromptLine = lines.some((line) => /^\s*›\s*/u.test(line));
  const hasCodexStatus = lines.some((line) => /\bgpt-[\w.-]+\b/i.test(line) || /\b\d+% left\b/i.test(line));
  const hasClaudePromptLine = lines.some((line) => /^\s*❯\s*/u.test(line));
  const hasClaudeStatus = lines.some((line) => /\bClaude Code v[\d.]+\b/i.test(line) || /\bclaude-[\w.-]+\b/i.test(line));
  if (hasCodexPromptLine || hasCodexStatus || hasClaudePromptLine || hasClaudeStatus) return true;

  return false;
}

function paneHasTrustPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((line) => /Do you trust the contents of this directory\?/i.test(line));
  const hasActiveChoices = tail.some((line) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(line));
  return hasQuestion && hasActiveChoices;
}

function paneHasActiveTask(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);

  const tail = lines.slice(-40);
  if (tail.some((line) => /esc to interrupt/i.test(line))) return true;
  if (tail.some((line) => /\bbackground terminal running\b/i.test(line))) return true;
  // Typical Codex activity line: "• Doing X (3m 12s • esc to interrupt)"
  if (tail.some((line) => /^•\s.+\(.+•\s*esc to interrupt\)$/i.test(line))) return true;
  return false;
}

function resolveSendStrategyFromEnv(): 'auto' | 'queue' | 'interrupt' {
  const raw = String(process.env.OMX_TEAM_SEND_STRATEGY || '')
    .trim()
    .toLowerCase();
  if (raw === 'interrupt' || raw === 'queue' || raw === 'auto') {
    return raw;
  }
  return 'auto';
}

export function shouldAttemptAdaptiveRetry(
  strategy: 'auto' | 'queue' | 'interrupt',
  paneBusyAtStart: boolean,
  allowAdaptiveRetry: boolean,
  latestCapture: string | null,
  text: string,
): boolean {
  if (!allowAdaptiveRetry) return false;
  if (strategy !== 'auto') return false;
  if (!paneBusyAtStart) return false;
  if (typeof latestCapture !== 'string') return false;

  const normalizedText = normalizeTmuxCapture(text);
  if (normalizedText === '') return false;

  const normalizedCapture = normalizeTmuxCapture(latestCapture);
  if (!normalizedCapture.includes(normalizedText)) return false;
  if (paneHasActiveTask(latestCapture)) return false;
  if (!paneLooksReady(latestCapture)) return false;
  return true;
}

function sendKeyOrThrow(target: string, key: string, label: string): void {
  const result = runTmux(['send-keys', '-t', target, key]);
  if (!result.ok) {
    throw new Error(`sendToWorker: failed to send ${label}: ${result.stderr}`);
  }
}

function sendLiteralTextOrThrow(target: string, text: string): void {
  const send = runTmux(['send-keys', '-t', target, '-l', '--', text]);
  if (!send.ok) {
    throw new Error(`sendToWorker: failed to send text: ${send.stderr}`);
  }
}

function attemptSubmitRounds(
  target: string,
  text: string,
  rounds: number,
  queueFirstRound: boolean,
): boolean {
  for (let round = 0; round < rounds; round++) {
    sleepFractionalSeconds(0.1);
    if (round === 0 && queueFirstRound) {
      sendKeyOrThrow(target, 'Tab', 'Tab');
      sleepFractionalSeconds(0.08);
      sendKeyOrThrow(target, 'C-m', 'C-m');
    } else {
      sendKeyOrThrow(target, 'C-m', 'C-m');
      sleepFractionalSeconds(0.2);
      sendKeyOrThrow(target, 'C-m', 'C-m');
    }
    sleepFractionalSeconds(0.14);
    if (!paneTailContainsLiteralLine(target, text)) return true;
    sleepFractionalSeconds(0.14);
  }
  return false;
}

// Poll tmux capture-pane for Codex prompt indicator (> or similar)
// Uses exponential backoff: 1s, 2s, 4s, 8s (total ~15s)
// Returns true if ready, false on timeout
export function waitForWorkerReady(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 15000,
  workerPaneId?: string,
): boolean {
  const initialBackoffMs = 300;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;

  const sendRobustEnter = (): void => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) instead of Enter for raw-mode compatibility.
    runTmux(['send-keys', '-t', target, 'C-m']);
    sleepFractionalSeconds(0.12);
    runTmux(['send-keys', '-t', target, 'C-m']);
  };

  const check = (): boolean => {
    const result = runTmux(['capture-pane', '-t', paneTarget(sessionName, workerIndex, workerPaneId), '-p']);
    if (!result.ok) return false;
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        sendRobustEnter();
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    return paneLooksReady(result.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    if (blockedByTrustPrompt) return false;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepSeconds(Math.max(0, Math.min(delayMs, remaining)) / 1000);
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

function paneTailContainsLiteralLine(target: string, text: string): boolean {
  const result = runTmux(['capture-pane', '-t', target, '-p', '-S', '-80']);
  if (!result.ok) return false;
  return normalizeTmuxCapture(result.stdout).includes(normalizeTmuxCapture(text));
}

export function normalizeTmuxCapture(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Send SHORT text (<200 chars) to worker via tmux send-keys
// Validates: text < 200 chars, no injection marker
// Throws on violation
export function sendToWorker(sessionName: string, workerIndex: number, text: string, workerPaneId?: string): void {
  if (text.length >= 200) {
    throw new Error('sendToWorker: text must be < 200 characters');
  }
  if (text.trim().length === 0) {
    throw new Error('sendToWorker: text must be non-empty');
  }
  if (text.includes(INJECTION_MARKER)) {
    throw new Error('sendToWorker: injection marker is not allowed');
  }

  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const strategy = resolveSendStrategyFromEnv();

  // Guard: if the trust prompt is still present, advance it first so our trigger text
  // doesn't get typed into the trust screen and ignored.
  const captured = runTmux(['capture-pane', '-t', target, '-p', '-S', '-80']);
  const paneBusy = captured.ok ? paneHasActiveTask(captured.stdout) : false;
  if (captured.ok && paneHasTrustPrompt(captured.stdout)) {
    sendKeyOrThrow(target, 'C-m', 'C-m');
    sleepFractionalSeconds(0.12);
    sendKeyOrThrow(target, 'C-m', 'C-m');
    sleepFractionalSeconds(0.2);
  }

  sendLiteralTextOrThrow(target, text);

  // Allow the input buffer to settle before sending Enter
  sleepFractionalSeconds(0.15);

  const shouldInterrupt = strategy === 'interrupt';
  const shouldQueueFirst = strategy === 'queue' || (strategy === 'auto' && paneBusy);
  const allowAutoInterruptRetry = process.env[OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV] !== '0';
  if (shouldInterrupt) {
    // Explicit interrupt mode: abort current turn first, then submit the new command.
    sendKeyOrThrow(target, 'C-c', 'C-c');
    sleepFractionalSeconds(0.1);
  }

  // Submit deterministically: C-m twice with short sleep between presses.
  // When worker is busy, first attempt uses Tab+C-m to leverage Codex queue semantics.
  // If that fails, fall back to legacy C-m-based submit rounds.
  if (attemptSubmitRounds(target, text, 6, shouldQueueFirst)) return;

  // Adaptive escalation for "likely unsent trigger text at ready prompt" cases:
  // clear line, re-send trigger, then re-submit with deterministic C-m rounds.
  const latestCaptureResult = runTmux(['capture-pane', '-t', target, '-p', '-S', '-80']);
  const latestCapture = latestCaptureResult.ok ? latestCaptureResult.stdout : null;
  if (shouldAttemptAdaptiveRetry(strategy, paneBusy, allowAutoInterruptRetry, latestCapture, text)) {
    // Keep this branch non-interrupting to avoid canceling active turns on false positives.
    sendKeyOrThrow(target, 'C-u', 'C-u');
    sleepFractionalSeconds(0.08);
    sendLiteralTextOrThrow(target, text);
    sleepFractionalSeconds(0.12);
    if (attemptSubmitRounds(target, text, 4, false)) return;
  }

  // Fail-open by default: Codex may keep the last submitted line visible even after executing it.
  // If you need strictness for debugging, set OMX_TEAM_STRICT_SUBMIT=1.
  const strict = process.env.OMX_TEAM_STRICT_SUBMIT === '1';
  if (strict) {
    throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');
  }

  // One last best-effort double C-m nudge, then continue.
  runTmux(['send-keys', '-t', target, 'C-m']);
  sleepFractionalSeconds(0.12);
  runTmux(['send-keys', '-t', target, 'C-m']);
}

export function notifyLeaderStatus(sessionName: string, message: string): boolean {
  if (!isTmuxAvailable()) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  const capped = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  const result = runTmux(['display-message', '-t', sessionName, '--', capped]);
  return result.ok;
}

// Get PID of the shell process in a worker's tmux pane
export function getWorkerPanePid(sessionName: string, workerIndex: number, workerPaneId?: string): number | null {
  const result = runTmux(['list-panes', '-t', paneTarget(sessionName, workerIndex, workerPaneId), '-F', '#{pane_pid}']);
  if (!result.ok) return null;

  const firstLine = result.stdout.split('\n')[0]?.trim();
  if (!firstLine) return null;

  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(pid)) return null;
  return pid;
}

// Check if worker's tmux pane has a running process
export function isWorkerAlive(sessionName: string, workerIndex: number, workerPaneId?: string): boolean {
  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex, workerPaneId),
    '-F',
    '#{pane_dead} #{pane_pid}',
  ]);
  if (!result.ok) return false;

  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;

  const parts = line.split(/\s+/);
  if (parts.length < 2) return false;

  const paneDead = parts[0];
  const pid = Number.parseInt(parts[1], 10);

  if (paneDead === '1') return false;
  if (!Number.isFinite(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill a specific worker: send C-c, then C-d, then kill-pane if still alive.
// leaderPaneId: when provided, the kill is skipped entirely if workerPaneId matches it.
export function killWorker(sessionName: string, workerIndex: number, workerPaneId?: string, leaderPaneId?: string): void {
  // Guard: never kill the leader's own pane.
  if (leaderPaneId && workerPaneId === leaderPaneId) return;

  runTmux(['send-keys', '-t', paneTarget(sessionName, workerIndex, workerPaneId), 'C-c']);
  sleepSeconds(1);

  if (isWorkerAlive(sessionName, workerIndex, workerPaneId)) {
    runTmux(['send-keys', '-t', paneTarget(sessionName, workerIndex, workerPaneId), 'C-d']);
    sleepSeconds(1);
  }

  if (isWorkerAlive(sessionName, workerIndex, workerPaneId)) {
    runTmux(['kill-pane', '-t', paneTarget(sessionName, workerIndex, workerPaneId)]);
  }
}

// leaderPaneId: when provided, the kill is skipped if workerPaneId matches it.
export function killWorkerByPaneId(workerPaneId: string, leaderPaneId?: string): void {
  if (!workerPaneId.startsWith('%')) return;
  // Guard: never kill the leader's own pane.
  if (leaderPaneId && workerPaneId === leaderPaneId) return;
  runTmux(['kill-pane', '-t', workerPaneId]);
}

// Kill entire tmux session. Tolerates already-dead sessions.
export function destroyTeamSession(sessionName: string): void {
  try {
    runTmux(['kill-session', '-t', sessionName]);
  } catch {
    // tolerate
  }
}

// List all tmux sessions matching omx-team-* pattern
export function listTeamSessions(): string[] {
  const result = runTmux(['list-sessions', '-F', '#{session_name}']);
  if (!result.ok) return [];

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(baseSessionName);
}
