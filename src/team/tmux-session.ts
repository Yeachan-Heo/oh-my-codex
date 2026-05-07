import { spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import {
  CODEX_BYPASS_FLAG,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  MADMAX_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
  MODEL_FLAG,
} from '../cli/constants.js';
import { getAgent } from '../agents/definitions.js';
import {
  buildCapturePaneArgv as sharedBuildCapturePaneArgv,
  buildVisibleCapturePaneArgv as sharedBuildVisibleCapturePaneArgv,
  normalizeTmuxCapture as sharedNormalizeTmuxCapture,
  paneHasActiveTask as sharedPaneHasActiveTask,
  paneIsBootstrapping as sharedPaneIsBootstrapping,
  paneShowsCodexViewport as sharedPaneShowsCodexViewport,
  paneLooksReady as sharedPaneLooksReady,
} from '../scripts/tmux-hook-engine.js';
import { readActiveProviderEnvOverrides } from '../config/models.js';
import { extractModelProviderOverrideValue } from './model-contract.js';
import { sleep, sleepSync } from '../utils/sleep.js';
import {
  buildPlatformCommandSpec,
  classifySpawnError,
  resolveCommandPathForPlatform,
  spawnPlatformCommandSync,
} from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

const execFileAsync = promisify(execFile);
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_TEAM_HEIGHT_LINES } from '../hud/constants.js';
import { OMX_TMUX_HUD_OWNER_ENV } from '../hud/reconcile.js';

const OMX_INSTANCE_OPTION = '@omx_instance_id';
const OMX_PANE_INSTANCE_OPTION = '@omx_pane_instance_id';

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
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = 'OMX_BYPASS_DEFAULT_SYSTEM_PROMPT';
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const OMX_TEAM_WORKER_CLI_ENV = 'OMX_TEAM_WORKER_CLI';
const OMX_TEAM_WORKER_CLI_MAP_ENV = 'OMX_TEAM_WORKER_CLI_MAP';
const OMX_TEAM_WORKER_LAUNCH_MODE_ENV = 'OMX_TEAM_WORKER_LAUNCH_MODE';
const OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV = 'OMX_TEAM_AUTO_INTERRUPT_RETRY';
const CODEX_SQLITE_HOME_ENV = 'CODEX_SQLITE_HOME';
const GEMINI_PROMPT_INTERACTIVE_FLAG = '-i';
const GEMINI_APPROVAL_MODE_FLAG = '--approval-mode';
const GEMINI_APPROVAL_MODE_YOLO = 'yolo';
const OMX_LEADER_NODE_PATH_ENV = 'OMX_LEADER_NODE_PATH';
const OMX_LEADER_CLI_PATH_ENV = 'OMX_LEADER_CLI_PATH';
const TMUX_WORKER_AMBIENT_ENV_ALLOWLIST = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;
const TMUX_NO_UNDERLINE_STYLE_FLAGS = [
  'nounderscore',
  'nodouble-underscore',
  'nocurly-underscore',
  'nodotted-underscore',
  'nodashed-underscore',
] as const;
const TMUX_COPY_MODE_STYLE_OPTIONS = [
  'mode-style',
  'copy-mode-selection-style',
] as const;
const TMUX_PANE_STABILITY_POLL_MS = 60;
const TMUX_PANE_STABILITY_POLLS_REQUIRED = 2;
const TMUX_PANE_STABILITY_TIMEOUT_MS = 750;

export type TeamWorkerCli = 'codex' | 'claude' | 'gemini';
type TeamWorkerCliMode = 'auto' | TeamWorkerCli;
export type TeamWorkerLaunchMode = 'interactive' | 'prompt';

export interface WorkerSubmitPlan {
  shouldInterrupt: boolean;
  queueFirstRound: boolean;
  rounds: number;
  submitKeyPressesPerRound: number;
  allowAdaptiveRetry: boolean;
}

interface WorkerLaunchSpec {
  shell: string;
  rcFile: string | null;
}

export interface WorkerProcessLaunchSpec {
  workerCli: TeamWorkerCli;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface TmuxPaneInfo {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

type SpawnSyncLike = typeof spawnSync;

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const { result } = spawnPlatformCommandSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
}

function appendNoUnderlineStyleFlags(style: string): string {
  const normalized = style
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const combined = [...normalized];
  for (const flag of TMUX_NO_UNDERLINE_STYLE_FLAGS) {
    if (!combined.includes(flag)) combined.push(flag);
  }
  return combined.join(',');
}

function sanitizeTmuxStyleOption(sessionTarget: string, optionName: string): boolean {
  const shown = runTmux(['show-options', '-gv', '-t', sessionTarget, optionName]);
  if (!shown.ok) return false;

  const current = shown.stdout.trim();
  if (current === '') return false;

  const sanitized = appendNoUnderlineStyleFlags(current);
  if (sanitized === current) return true;

  const result = runTmux(['set-option', '-t', sessionTarget, optionName, sanitized]);
  return result.ok;
}

function tagPaneInstance(paneTarget: string, instanceId: string): void {
  const target = paneTarget.trim();
  const sanitized = instanceId.trim();
  if (!target || !sanitized) return;
  const result = runTmux(['set-option', '-p', '-t', target, OMX_PANE_INSTANCE_OPTION, sanitized]);
  if (!result.ok) {
    throw new Error(`failed to tag tmux pane ${target}: ${result.stderr}`);
  }
}

export function mitigateCopyModeUnderlineArtifacts(sessionTarget: string): boolean {
  const normalizedTarget = sessionTarget.trim();
  if (normalizedTarget === '') return false;

  let applied = false;
  for (const optionName of TMUX_COPY_MODE_STYLE_OPTIONS) {
    if (sanitizeTmuxStyleOption(normalizedTarget, optionName)) {
      applied = true;
    }
  }
  return applied;
}

export function hasCurrentTmuxClientContext(): boolean {
  const tmuxPaneTarget = process.env.TMUX_PANE?.trim();
  const displayArgs = tmuxPaneTarget
    ? ['display-message', '-p', '-t', tmuxPaneTarget, '#S:#I #{pane_id}']
    : ['display-message', '-p', '#S:#I #{pane_id}'];
  const context = runTmux(displayArgs);
  if (!context.ok) return false;
  const [sessionAndWindow = '', detectedLeaderPaneId = ''] = context.stdout.split(' ');
  const [sessionName, windowIndex] = sessionAndWindow.split(':');
  return Boolean(sessionName && windowIndex && detectedLeaderPaneId.startsWith('%'));
}

export function isMsysOrGitBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const msystem = String(env.MSYSTEM ?? '').trim();
  if (msystem !== '') return true;
  const ostype = String(env.OSTYPE ?? '').trim();
  if (/(msys|mingw|cygwin)/i.test(ostype)) return true;
  return false;
}

function fallbackMsysPathTranslation(value: string): string {
  const drivePathMatch = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!drivePathMatch) return value;
  const drive = drivePathMatch[1]?.toLowerCase();
  const tail = drivePathMatch[2]?.replace(/\\/g, '/');
  if (!drive || !tail) return value;
  return `/${drive}/${tail}`;
}

export function translatePathForMsys(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: SpawnSyncLike = spawnSync,
): string {
  if (typeof value !== 'string' || value.trim() === '') return value;
  if (!isMsysOrGitBash(env, platform)) return value;

  const result = spawnImpl('cygpath', ['-u', value], { encoding: 'utf-8' });
  if (!result.error && result.status === 0) {
    const translated = (result.stdout || '').trim();
    if (translated !== '') return translated;
  }

  return fallbackMsysPathTranslation(value);
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

export function listPaneIds(target: string): string[] {
  return listPanes(target).map((pane) => pane.paneId);
}

function paneExistsInTarget(target: string, paneId: string): boolean {
  if (!paneId.startsWith('%')) return false;
  return listPaneIds(target).includes(paneId);
}

function waitForPaneToRemainPresent(
  target: string,
  paneId: string,
  timeoutMs: number = TMUX_PANE_STABILITY_TIMEOUT_MS,
): boolean {
  if (!paneId.startsWith('%')) return false;

  const stablePollsRequired = Math.max(1, TMUX_PANE_STABILITY_POLLS_REQUIRED);
  const startedAt = Date.now();
  let stablePolls = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    if (paneExistsInTarget(target, paneId)) {
      stablePolls += 1;
      if (stablePolls >= stablePollsRequired) return true;
    } else {
      stablePolls = 0;
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepFractionalSeconds(Math.max(0, Math.min(TMUX_PANE_STABILITY_POLL_MS, remaining)) / 1000);
  }

  return false;
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
  sleepImpl: (ms: number) => void = sleepSync,
): void {
  const ms = toFractionalSleepMs(seconds);
  if (ms <= 0) return;
  sleepImpl(ms);
}

// ── Async tmux helpers ──────────────────────────────────────────────────────

async function runTmuxAsync(args: string[]): Promise<{ok: true; stdout: string} | {ok: false; stderr: string}> {
  try {
    const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf-8' });
    return { ok: true, stdout: (stdout || '').trim() };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, stderr: (err.stderr || err.message || '').trim() || 'tmux command failed' };
  }
}

async function sendKeyAsync(target: string, key: string): Promise<void> {
  const result = await runTmuxAsync(['send-keys', '-t', target, key]);
  if (!result.ok) {
    throw new Error(`sendKeyAsync: failed to send ${key}: ${result.stderr}`);
  }
}

async function capturePaneAsync(target: string): Promise<string> {
  const result = await runTmuxAsync(sharedBuildCapturePaneArgv(target, 80));
  if (!result.ok) return '';
  return result.stdout;
}

async function captureVisiblePaneAsync(target: string): Promise<string> {
  const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return '';
  return result.stdout;
}

async function isWorkerAliveAsync(sessionName: string, workerIndex: number, workerPaneId?: string): Promise<boolean> {
  const result = await runTmuxAsync([
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

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(commandText: string): string {
  return Buffer.from(commandText, 'utf16le').toString('base64');
}

function resolveNativeWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const rootCandidates = [
    env.SystemRoot,
    env.SYSTEMROOT,
    env.windir,
    env.WINDIR,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value, index, values) => value !== '' && values.indexOf(value) === index);
  const systemPowerShellCandidates = rootCandidates.map(
    (root) => `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  );
  const resolvedFromPath = resolveCommandPathForPlatform('powershell', process.platform, env);
  const existingCandidates = [
    ...systemPowerShellCandidates,
    resolvedFromPath,
  ].filter((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

  return existingCandidates.find((candidate) => !/\s/.test(candidate))
    ?? existingCandidates[0]
    ?? resolvedFromPath
    ?? 'powershell.exe';
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

function resolveHudHeightLines(heightLines: number): number {
  if (!Number.isFinite(heightLines)) return HUD_TMUX_TEAM_HEIGHT_LINES;
  const normalized = Math.floor(heightLines);
  return normalized > 0 ? normalized : HUD_TMUX_TEAM_HEIGHT_LINES;
}

function buildHudResizeCommand(hudPaneId: string, heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES): string {
  return `resize-pane -t ${buildHudPaneTarget(hudPaneId)} -y ${resolveHudHeightLines(heightLines)}`;
}

function buildHudResizeArgs(
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  return ['resize-pane', '-t', buildHudPaneTarget(hudPaneId), '-y', String(resolveHudHeightLines(heightLines))];
}

function buildNestedTmuxShellCommand(command: string): string {
  if (process.platform !== 'win32') {
    return `tmux ${command}`;
  }

  const resolvedTmuxPath = resolveAbsoluteBinaryPath('tmux');
  if (resolvedTmuxPath === 'tmux') {
    return `tmux ${command}`;
  }

  return `${shellQuoteSingle(resolvedTmuxPath.replace(/\\/g, '/'))} ${command}`;
}

function buildBestEffortShellCommand(command: string): string {
  return `${command} >/dev/null 2>&1 || true`;
}

/** Upper bound for tmux hook indices (signed 32-bit max). */
const TMUX_HOOK_INDEX_MAX = 2147483647;

function buildResizeHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-resized[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

function buildClientAttachedHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-attached[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export function buildRegisterResizeHookArgs(
  hookTarget: string,
  hookName: string,
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const resizeCommand = shellQuoteSingle(
    buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, heightLines))),
  );
  return ['set-hook', '-t', hookTarget, buildResizeHookSlot(hookName), `run-shell -b ${resizeCommand}`];
}

export function buildUnregisterResizeHookArgs(hookTarget: string, hookName: string): string[] {
  return ['set-hook', '-u', '-t', hookTarget, buildResizeHookSlot(hookName)];
}

export function buildClientAttachedReconcileHookName(
  teamName: string,
  sessionName: string,
  windowIndex: string,
  hudPaneId: string,
): string {
  return [
    'omx_attached',
    normalizeTmuxHookToken(teamName),
    normalizeTmuxHookToken(sessionName),
    normalizeTmuxHookToken(windowIndex),
    normalizeHudPaneToken(hudPaneId),
  ].join('_');
}

export function buildRegisterClientAttachedReconcileArgs(
  hookTarget: string,
  hookName: string,
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const hookSlot = buildClientAttachedHookSlot(hookName);
  const oneShotCommand = shellQuoteSingle(
    `${buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, heightLines)))}; ${buildNestedTmuxShellCommand(`set-hook -u -t ${hookTarget} ${hookSlot}`)}`,
  );
  return ['set-hook', '-t', hookTarget, hookSlot, `run-shell -b ${oneShotCommand}`];
}

export function buildUnregisterClientAttachedReconcileArgs(hookTarget: string, hookName: string): string[] {
  return ['set-hook', '-u', '-t', hookTarget, buildClientAttachedHookSlot(hookName)];
}

export function unregisterResizeHook(hookTarget: string, hookName: string): boolean {
  const result = runTmux(buildUnregisterResizeHookArgs(hookTarget, hookName));
  return result.ok;
}

export function buildScheduleDelayedHudResizeArgs(
  hudPaneId: string,
  delaySeconds: number = HUD_RESIZE_RECONCILE_DELAY_SECONDS,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const delay = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : HUD_RESIZE_RECONCILE_DELAY_SECONDS;
  return ['run-shell', '-b', `sleep ${delay}; ${buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, heightLines)))}`];
}

export function buildReconcileHudResizeArgs(
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  return ['run-shell', buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, heightLines)))];
}

const ZSH_CANDIDATE_PATHS = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/local/bin/zsh', '/opt/homebrew/bin/zsh'];
const BASH_CANDIDATE_PATHS = ['/bin/bash', '/usr/bin/bash'];

function buildShellLaunchSpec(shell: string, rcFile: string | null): WorkerLaunchSpec {
  return { shell, rcFile };
}

function resolveSupportedShellAffinity(shellPath: string | undefined): WorkerLaunchSpec | null {
  if (!shellPath || shellPath.trim() === '' || !existsSync(shellPath)) return null;
  if (/\/zsh$/i.test(shellPath)) return buildShellLaunchSpec(shellPath, '~/.zshrc');
  if (/\/bash$/i.test(shellPath)) return buildShellLaunchSpec(shellPath, '~/.bashrc');
  return null;
}

function resolveShellFromCandidates(paths: string[], rcFile: string): WorkerLaunchSpec | null {
  for (const shellPath of paths) {
    if (existsSync(shellPath)) return buildShellLaunchSpec(shellPath, rcFile);
  }
  return null;
}

function buildWorkerLaunchSpec(shellPath: string | undefined): WorkerLaunchSpec {
  if (isMsysOrGitBash()) {
    return buildShellLaunchSpec('/bin/sh', null);
  }

  const affinitySpec = resolveSupportedShellAffinity(shellPath);
  if (affinitySpec) return affinitySpec;

  const zshSpec = resolveShellFromCandidates(ZSH_CANDIDATE_PATHS, '~/.zshrc');
  if (zshSpec) return zshSpec;

  const bashSpec = resolveShellFromCandidates(BASH_CANDIDATE_PATHS, '~/.bashrc');
  if (bashSpec) return bashSpec;

  return buildShellLaunchSpec('/bin/sh', null);
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
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') return normalized;
  throw new Error(`Invalid ${sourceEnv} value "${raw}". Expected: auto, codex, claude, gemini`);
}

export function resolveTeamWorkerLaunchMode(
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerLaunchMode {
  const raw = String(env[OMX_TEAM_WORKER_LAUNCH_MODE_ENV] ?? 'interactive').trim().toLowerCase();
  if (raw === '' || raw === 'interactive') return 'interactive';
  if (raw === 'prompt') return 'prompt';
  throw new Error(`Invalid ${OMX_TEAM_WORKER_LAUNCH_MODE_ENV} value "${env[OMX_TEAM_WORKER_LAUNCH_MODE_ENV]}". Expected: interactive, prompt`);
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
  if (model && /claude/i.test(model)) return 'claude';
  if (model && /gemini/i.test(model)) return 'gemini';
  return 'codex';
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
        + `Expected comma-separated values: auto|codex|claude|gemini.`,
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

function shouldGrantExecutionBypassForRole(workerRole?: string): boolean {
  const normalizedRole = workerRole?.trim().toLowerCase();
  if (!normalizedRole) return true;
  const agent = getAgent(normalizedRole);
  if (!agent) return true;
  return agent.tools === 'execution';
}

export function translateWorkerLaunchArgsForCli(
  workerCli: TeamWorkerCli,
  args: string[],
  initialPrompt?: string,
  workerRole?: string,
): string[] {
  if (workerCli === 'codex') return [...args];
  if (workerCli === 'gemini') {
    const model = extractModelOverride(args);
    const geminiModel = model && /gemini/i.test(model) ? model : null;
    const translatedArgs = shouldGrantExecutionBypassForRole(workerRole)
      ? [GEMINI_APPROVAL_MODE_FLAG, GEMINI_APPROVAL_MODE_YOLO]
      : [];
    const trimmedPrompt = initialPrompt?.trim();
    if (trimmedPrompt) translatedArgs.push(GEMINI_PROMPT_INTERACTIVE_FLAG, trimmedPrompt);
    if (geminiModel) translatedArgs.push(MODEL_FLAG, geminiModel);
    return translatedArgs;
  }

  // Claude workers must launch with exactly one permissions bypass flag.
  // All other launch args are dropped to avoid Codex-only flags and model/config overrides.
  void args;
  return shouldGrantExecutionBypassForRole(workerRole) ? [CLAUDE_SKIP_PERMISSIONS_FLAG] : [];
}

function commandExists(binary: string): boolean {
  const { result } = spawnPlatformCommandSync(binary, ['--version'], { encoding: 'utf-8' });
  if (result.error) {
    return classifySpawnError(result.error as NodeJS.ErrnoException) !== 'missing';
  }
  return true;
}

/**
 * Resolve the absolute path of a binary from the leader's current environment.
 * Returns the absolute path or the bare command name as fallback.
 */
function resolveAbsoluteBinaryPath(binary: string): string {
  return resolveCommandPathForPlatform(binary) || binary;
}

/**
 * Resolve the leader's node binary path.
 * Caches results for the process lifetime.
 */
let _leaderPaths: { node: string; } | null = null;
function resolveLeaderNodePath(): string {
  const envOverride = process.env[OMX_LEADER_NODE_PATH_ENV];
  if (typeof envOverride === 'string' && envOverride.trim() !== '') {
    return envOverride.trim();
  }
  if (!_leaderPaths) {
    _leaderPaths = { node: resolveAbsoluteBinaryPath('node') };
  }
  return _leaderPaths.node;
}

export function assertTeamWorkerCliBinaryAvailable(
  workerCli: TeamWorkerCli,
  existsImpl: (binary: string) => boolean = commandExists,
): void {
  if (existsImpl(workerCli)) return;
  throw new Error(
    `Selected team worker CLI "${workerCli}" is not available on PATH. `
      + `Install "${workerCli}" or set ${OMX_TEAM_WORKER_CLI_ENV}=codex|claude|gemini.`,
  );
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== '0';
}

function buildModelInstructionsOverride(cwd: string, env: NodeJS.ProcessEnv): string {
  const filePath = translatePathForMsys(env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] || join(cwd, 'AGENTS.md'));
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

function readTmuxWorkerAmbientEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of TMUX_WORKER_AMBIENT_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    inherited[key] = value;
  }
  return inherited;
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
  initialPrompt?: string,
  workerRole?: string,
): string {
  const processSpec = buildWorkerProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
  const startupEnv = {
    ...readTmuxWorkerAmbientEnv(process.env),
    ...processSpec.env,
  };
  const resolvedLeaderNodePath = processSpec.env[OMX_LEADER_NODE_PATH_ENV]?.trim() || resolveLeaderNodePath();
  const leaderNodeDir = /[\\/]/.test(resolvedLeaderNodePath)
    ? resolvedLeaderNodePath.replace(/[\\/][^\\/]+$/, '')
    : '';
  if (isNativeWindows()) {
    const powershellPath = resolveNativeWindowsPowerShellPath();
    const pathBootstrap = leaderNodeDir
      ? `$env:PATH = ${quotePowerShellArg(`${leaderNodeDir};`)} + $env:PATH`
      : '';
    const envAssignments = Object.entries(startupEnv)
      .map(([key, value]) => `$env:${key} = ${quotePowerShellArg(value)}`)
      .join('; ');
    const invocation = ['&', quotePowerShellArg(processSpec.command), ...processSpec.args.map(quotePowerShellArg)].join(' ');
    const encodedCommand = encodePowerShellCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        pathBootstrap,
        envAssignments,
        invocation,
      ].filter(Boolean).join('; '),
    );
    return `${powershellPath} -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
  }

  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
  const pathPrefix = leaderNodeDir ? `export PATH=${shellQuoteSingle(leaderNodeDir)}:$PATH; ` : '';
  const quotedArgs = processSpec.args.map(shellQuoteSingle).join(' ');
  const quotedCommand = shellQuoteSingle(processSpec.command);
  const cliInvocation = quotedArgs.length > 0 ? `exec ${quotedCommand} ${quotedArgs}` : `exec ${quotedCommand}`;
  const rcPrefix = launchSpec.rcFile ? `if [ -f ${launchSpec.rcFile} ]; then source ${launchSpec.rcFile}; fi; ` : '';
  const inner = `${rcPrefix}${pathPrefix}${cliInvocation}`;
  const envParts = Object.entries(startupEnv).map(([key, value]) => `${key}=${value}`);

  return `env ${envParts.map(shellQuoteSingle).join(' ')} ${shellQuoteSingle(launchSpec.shell)} -c ${shellQuoteSingle(inner)}`;
}

export function buildWorkerProcessLaunchSpec(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const fullLaunchArgs = resolveWorkerLaunchArgs(launchArgs, cwd, effectiveEnv);
  const workerCli = workerCliOverride ?? resolveTeamWorkerCli(fullLaunchArgs, effectiveEnv);
  const cliLaunchArgs = translateWorkerLaunchArgsForCli(workerCli, fullLaunchArgs, initialPrompt, workerRole);
  const effectiveCliLaunchArgs = workerCli === 'codex'
    && shouldGrantExecutionBypassForRole(workerRole)
    && !cliLaunchArgs.includes(CODEX_BYPASS_FLAG)
    ? [...cliLaunchArgs, CODEX_BYPASS_FLAG]
    : cliLaunchArgs;
  const workerCodexHomeOverride = typeof effectiveEnv.CODEX_HOME === 'string'
    ? effectiveEnv.CODEX_HOME.trim()
    : undefined;
  const workerSqliteHomeOverride = typeof effectiveEnv[CODEX_SQLITE_HOME_ENV] === 'string'
    ? effectiveEnv[CODEX_SQLITE_HOME_ENV].trim()
    : undefined;
  const providerLookupCodexHome = workerCodexHomeOverride
    ? (isAbsolute(workerCodexHomeOverride) ? workerCodexHomeOverride : resolve(cwd, workerCodexHomeOverride))
    : undefined;

  const resolvedCliPath = resolveAbsoluteBinaryPath(workerCli);
  const platformSpec = isNativeWindows()
    ? buildPlatformCommandSpec(workerCli, effectiveCliLaunchArgs, process.platform, effectiveEnv)
    : { command: resolvedCliPath, args: effectiveCliLaunchArgs };
  const resolvedLauncherPath = platformSpec.resolvedPath || resolvedCliPath;
  const modelProviderOverride = workerCli === 'codex'
    ? extractModelProviderOverrideValue(effectiveCliLaunchArgs)
    : undefined;
  const codexProviderEnv = workerCli === 'codex'
    ? readActiveProviderEnvOverrides(
        effectiveEnv,
        providerLookupCodexHome,
        modelProviderOverride,
      )
    : {};
  const internalWorkerIdentity = `${teamName}/worker-${workerIndex}`;
  const displayTeamName = typeof extraEnv.OMX_TEAM_DISPLAY_NAME === 'string'
    ? extraEnv.OMX_TEAM_DISPLAY_NAME.trim()
    : '';
  const publicWorkerIdentity = displayTeamName
    ? `${displayTeamName}/worker-${workerIndex}`
    : internalWorkerIdentity;
  const workerEnv: Record<string, string> = {
    OMX_TEAM_WORKER: publicWorkerIdentity,
    OMX_TEAM_INTERNAL_WORKER: internalWorkerIdentity,
    [OMX_LEADER_NODE_PATH_ENV]: resolveLeaderNodePath(),
    [OMX_LEADER_CLI_PATH_ENV]: resolvedLauncherPath,
    [OMX_TMUX_HUD_OWNER_ENV]: '1',
    ...(workerCli === 'codex' && workerCodexHomeOverride
      ? { CODEX_HOME: workerCodexHomeOverride }
      : {}),
    ...(workerCli === 'codex' && workerSqliteHomeOverride
      ? { [CODEX_SQLITE_HOME_ENV]: workerSqliteHomeOverride }
      : {}),
    ...codexProviderEnv,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    workerEnv[key] = value;
  }

  return {
    workerCli,
    command: platformSpec.command,
    args: platformSpec.args,
    env: workerEnv,
  };
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
  return process.platform === 'win32' && !isWsl2() && !isMsysOrGitBash();
}

// Check if tmux is available
export function isTmuxAvailable(): boolean {
  const { result } = spawnPlatformCommandSync('tmux', ['-V'], { encoding: 'utf-8' });
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
  workerStartups: Array<{
    cwd?: string;
    env?: Record<string, string>;
    initialPrompt?: string;
    launchArgs?: string[];
    workerCli?: TeamWorkerCli;
    workerRole?: string;
  }> = [],
): TeamSession {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!hasCurrentTmuxClientContext()) {
    throw new Error('team mode requires running inside tmux leader pane');
  }
  const normalizedWorkerLaunchArgs = resolveWorkerLaunchArgs(workerLaunchArgs, cwd);
  const defaultWorkerCliPlan = resolveTeamWorkerCliPlan(workerCount, normalizedWorkerLaunchArgs, process.env);
  const workerCliPlan = workerStartups.length > 0
    ? workerStartups.map((startup, index) => startup.workerCli ?? defaultWorkerCliPlan[index]!)
    : defaultWorkerCliPlan;
  for (const workerCli of new Set(workerCliPlan)) {
    assertTeamWorkerCliBinaryAvailable(workerCli);
  }

  const safeTeamName = sanitizeTeamName(teamName);
  let registeredResizeHook: { name: string; target: string } | null = null;
  let registeredClientAttachedHook: { name: string; target: string } | null = null;
  const rollbackPaneIds: string[] = [];
  try {
    const tmuxPaneTarget = process.env.TMUX_PANE;
    const displayArgs = tmuxPaneTarget
      ? ['display-message', '-p', '-t', tmuxPaneTarget, '#S:#I #{pane_id}']
      : ['display-message', '-p', '#S:#I #{pane_id}'];
    const context = runTmux(displayArgs);
    if (!context.ok) {
      const paneHint = tmuxPaneTarget ? ` (TMUX_PANE=${tmuxPaneTarget})` : '';
      throw new Error(`failed to detect current tmux target${paneHint}: ${context.stderr}`);
    }
    const [sessionAndWindow = '', detectedLeaderPaneId = ''] = context.stdout.split(' ');
    const [sessionName, windowIndex] = (sessionAndWindow || '').split(':');
    if (!sessionName || !windowIndex || !detectedLeaderPaneId || !detectedLeaderPaneId.startsWith('%')) {
      throw new Error(`failed to parse current tmux target: ${context.stdout}`);
    }
    const teamTarget = `${sessionName}:${windowIndex}`;
    const instanceId = (process.env.OMX_SESSION_ID || '').trim();
    if (instanceId) {
      const tagResult = runTmux(['set-option', '-t', sessionName, OMX_INSTANCE_OPTION, instanceId]);
      if (!tagResult.ok) {
        throw new Error(`failed to tag tmux session ${sessionName}: ${tagResult.stderr}`);
      }
    }
    const panes = listPanes(teamTarget);
    const leaderPaneId = chooseTeamLeaderPaneId(panes, detectedLeaderPaneId);
    tagPaneInstance(leaderPaneId, instanceId);
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
      const tmuxWorkerCwd = translatePathForMsys(workerCwd);
      const workerEnv = startup.env || {};
      const launchArgsForWorker = startup.launchArgs || workerLaunchArgs;
      const cmd = buildWorkerStartupCommand(
        safeTeamName,
        i,
        launchArgsForWorker,
        workerCwd,
        workerEnv,
        workerCliPlan[i - 1],
        startup.initialPrompt,
        startup.workerRole,
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
        tmuxWorkerCwd,
        cmd,
      ]);
      if (!split.ok) {
        throw new Error(`failed to create worker pane ${i}: ${split.stderr}`);
      }
      const paneId = split.stdout.split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        throw new Error(`failed to capture worker pane id for worker ${i}`);
      }
      rollbackPaneIds.push(paneId);
      if (isNativeWindows() && !waitForPaneToRemainPresent(teamTarget, paneId)) {
        throw new Error(`worker pane ${i} did not remain present after tmux split-window returned ${paneId}`);
      }
      tagPaneInstance(paneId, instanceId);
      workerPaneIds.push(paneId);
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

    // Re-create a single team HUD as a full-width bottom strip spanning both
    // leader + worker columns. Keep this after layout sizing so the main
    // leader/worker topology stays readable and the HUD remains compact.
    // Capture the HUD pane ID so it can be tracked and excluded from worker cleanup.
    let hudPaneId: string | null = null;
    let resizeHookName: string | null = null;
    let resizeHookTarget: string | null = null;
    const omxEntry = resolveOmxCliEntryPath();
    if (omxEntry && omxEntry.trim() !== '') {
      const hudCmd = `env ${OMX_TMUX_HUD_OWNER_ENV}=1 node ${shellQuoteSingle(translatePathForMsys(omxEntry))} hud --watch`;
      const hudCwd = translatePathForMsys(cwd);
      const hudResult = runTmux([
        'split-window', '-v', '-f', '-l', String(HUD_TMUX_TEAM_HEIGHT_LINES), '-t', teamTarget, '-d', '-P', '-F', '#{pane_id}', '-c', hudCwd, hudCmd,
      ]);
      if (hudResult.ok) {
        const id = hudResult.stdout.split('\n')[0]?.trim() ?? '';
        if (id.startsWith('%')) {
          rollbackPaneIds.push(id);
          if (isNativeWindows() && !waitForPaneToRemainPresent(teamTarget, id)) {
            throw new Error(`HUD pane did not remain present after tmux split-window returned ${id}`);
          }
          tagPaneInstance(id, instanceId);
          hudPaneId = id;

          if (isNativeWindows()) {
            // Native Windows tmux support may flow through psmux; issuing a
            // direct control-plane resize avoids nested run-shell PATH drift.
            const reconcile = runTmux(buildHudResizeArgs(hudPaneId));
            if (!reconcile.ok) {
              throw new Error(`failed to reconcile HUD resize: ${reconcile.stderr}`);
            }
          } else {
            resizeHookTarget = buildResizeHookTarget(sessionName, windowIndex);
            resizeHookName = buildResizeHookName(safeTeamName, sessionName, windowIndex, hudPaneId);
            const registerHook = runTmux(buildRegisterResizeHookArgs(resizeHookTarget, resizeHookName, hudPaneId));
            if (!registerHook.ok) {
              throw new Error(`failed to register resize hook ${resizeHookName}: ${registerHook.stderr}`);
            }
            registeredResizeHook = { name: resizeHookName, target: resizeHookTarget };

            const clientAttachedHookName = buildClientAttachedReconcileHookName(
              safeTeamName,
              sessionName,
              windowIndex,
              hudPaneId,
            );
            const registerClientAttachedHook = runTmux(
              buildRegisterClientAttachedReconcileArgs(resizeHookTarget, clientAttachedHookName, hudPaneId),
            );
            if (!registerClientAttachedHook.ok) {
              throw new Error(
                `failed to register client-attached reconcile hook ${clientAttachedHookName}: ${registerClientAttachedHook.stderr}`,
              );
            }
            registeredClientAttachedHook = { name: clientAttachedHookName, target: resizeHookTarget };

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
    if (registeredClientAttachedHook) {
      runTmux(
        buildUnregisterClientAttachedReconcileArgs(
          registeredClientAttachedHook.target,
          registeredClientAttachedHook.name,
        ),
      );
    }
    if (registeredResizeHook) {
      runTmux(buildUnregisterResizeHookArgs(registeredResizeHook.target, registeredResizeHook.name));
    }
    for (const paneId of rollbackPaneIds) {
      runTmux(['kill-pane', '-t', paneId]);
    }
    throw error;
  }
}

export function restoreStandaloneHudPane(
  leaderPaneId: string | null | undefined,
  cwd: string,
): string | null {
  const normalizedLeaderPaneId = normalizePaneTarget(leaderPaneId);
  if (!normalizedLeaderPaneId) return null;

  const omxEntry = resolveOmxCliEntryPath();
  if (!omxEntry || omxEntry.trim() === '') return null;

  const hudCmd = `env ${OMX_TMUX_HUD_OWNER_ENV}=1 ${shellQuoteSingle(translatePathForMsys(resolveLeaderNodePath()))} ${shellQuoteSingle(translatePathForMsys(omxEntry))} hud --watch`;
  const hudCwd = translatePathForMsys(cwd);
  const hudResult = runTmux([
    'split-window',
    '-v',
    '-l',
    String(HUD_TMUX_TEAM_HEIGHT_LINES),
    '-t',
    normalizedLeaderPaneId,
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    hudCwd,
    hudCmd,
  ]);
  if (!hudResult.ok) return null;

  const paneId = hudResult.stdout.split('\n')[0]?.trim() ?? '';
  if (!paneId.startsWith('%')) return null;

  if (isNativeWindows()) {
    runTmux(buildHudResizeArgs(paneId));
  } else {
    runTmux(buildScheduleDelayedHudResizeArgs(paneId));
    runTmux(buildReconcileHudResizeArgs(paneId));
  }
  runTmux(['select-pane', '-t', normalizedLeaderPaneId]);
  return paneId;
}

/**
 * Enable tmux mouse mode for a session so users can scroll pane content
 * (e.g. long agent output) with the mouse wheel instead of arrow keys.
 *
 * This helper is intentionally limited to session-scoped options so OMX
 * does not overwrite server-global tmux bindings/options owned by users,
 * oh-my-tmux, or other sessions. Returns true if the session mouse option
 * was set successfully, false otherwise.
 */
export function enableMouseScrolling(sessionTarget: string): boolean {
  const result = runTmux(['set-option', '-t', sessionTarget, 'mouse', 'on']);
  if (!result.ok) return false;

  // Enable OSC 52 so copy-selection-and-cancel propagates selected text to
  // the terminal's clipboard without requiring xclip or pbcopy. (closes #206)
  runTmux(['set-option', '-t', sessionTarget, 'set-clipboard', 'on']);

  // Mouse selection enters tmux copy-mode. Keep the mitigation session-scoped
  // so OMX does not mutate users' global tmux style defaults. (issue #1448)
  mitigateCopyModeUnderlineArtifacts(sessionTarget);

  return true;
}

function paneTarget(sessionName: string, workerIndex: number, workerPaneId?: string): string {
  if (workerPaneId && workerPaneId.startsWith('%')) return workerPaneId;
  if (sessionName.includes(':')) {
    return `${sessionName}.${workerIndex}`;
  }
  return `${sessionName}:${workerIndex}`;
}

export const paneIsBootstrapping = sharedPaneIsBootstrapping;
export const paneLooksReady = sharedPaneLooksReady;

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

function paneHasClaudeBypassPermissionsPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-20);
  const hasWarning = tail.some((line) => /Bypass Permissions mode/i.test(line));
  const hasChoices = tail.some((line) => /No,\s*exit/i.test(line))
    && tail.some((line) => /Yes,\s*I\s*accept/i.test(line))
    && tail.some((line) => /Enter\s*to\s*confirm/i.test(line));
  return hasWarning && hasChoices;
}


export type StartupDirectTriggerSafety =
  | { safe: true; reason: 'ready_prompt' | 'codex_viewport' }
  | { safe: false; reason: 'tmux_unavailable' | 'capture_failed' | 'trust_prompt' | 'claude_bypass_prompt' | 'bootstrapping' | 'not_agent_viewport' };

export function evaluateStartupDirectTriggerSafetyCapture(captured: string, workerCli?: TeamWorkerCli): StartupDirectTriggerSafety {
  if (paneHasTrustPrompt(captured)) return { safe: false, reason: 'trust_prompt' };
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return { safe: false, reason: 'claude_bypass_prompt' };
  if (paneLooksReady(captured)) return { safe: true, reason: 'ready_prompt' };
  if (paneIsBootstrapping(captured)) return { safe: false, reason: 'bootstrapping' };
  if (workerCli === 'codex' && sharedPaneShowsCodexViewport(captured)) return { safe: true, reason: 'codex_viewport' };
  return { safe: false, reason: 'not_agent_viewport' };
}

export async function evaluateStartupDirectTriggerSafety(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  workerCli?: TeamWorkerCli,
): Promise<StartupDirectTriggerSafety> {
  if (!isTmuxAvailable()) return { safe: false, reason: 'tmux_unavailable' };
  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return { safe: false, reason: 'capture_failed' };
  return evaluateStartupDirectTriggerSafetyCapture(result.stdout, workerCli);
}

function acceptClaudeBypassPermissionsPrompt(target: string): void {
  runTmux(['send-keys', '-t', target, '-l', '--', '2']);
  sleepFractionalSeconds(0.12);
  runTmux(['send-keys', '-t', target, 'C-m']);
}

function dismissClaudeBypassPermissionsPromptIfPresent(target: string, captured: string): boolean {
  if (process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS === '0') return false;
  if (!paneHasClaudeBypassPermissionsPrompt(captured)) return false;
  acceptClaudeBypassPermissionsPrompt(target);
  return true;
}

export const paneHasActiveTask = sharedPaneHasActiveTask;

export type WorkerStartupInjectSafety =
  | 'safe'
  | 'trust_prompt'
  | 'claude_bypass_prompt'
  | 'bootstrapping'
  | 'active_task'
  | 'not_ready';

export function classifyWorkerStartupInjectSafety(captured: string): WorkerStartupInjectSafety {
  if (paneHasTrustPrompt(captured)) return 'trust_prompt';
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return 'claude_bypass_prompt';
  if (paneIsBootstrapping(captured)) return 'bootstrapping';
  if (paneHasActiveTask(captured)) return 'active_task';
  if (!paneLooksReady(captured)) return 'not_ready';
  return 'safe';
}

export async function checkWorkerStartupInjectSafety(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
): Promise<{ safe: true; reason: 'safe' } | { safe: false; reason: Exclude<WorkerStartupInjectSafety, 'safe'> }> {
  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const visibleCapture = await captureVisiblePaneAsync(target);
  const visibleSafety = classifyWorkerStartupInjectSafety(visibleCapture);
  if (visibleSafety === 'safe') return { safe: true, reason: 'safe' };
  if (visibleSafety !== 'not_ready') return { safe: false, reason: visibleSafety };

  if (!sharedPaneShowsCodexViewport(visibleCapture)) {
    return { safe: false, reason: visibleSafety };
  }

  const scrollbackCapture = await capturePaneAsync(target);
  const scrollbackSafety = classifyWorkerStartupInjectSafety(scrollbackCapture);
  return scrollbackSafety === 'safe'
    ? { safe: true, reason: 'safe' }
    : { safe: false, reason: scrollbackSafety };
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

function resolveWorkerCliFromMapForSend(
  workerIndex: number,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli | null {
  const rawMap = String(env[OMX_TEAM_WORKER_CLI_MAP_ENV] ?? '').trim();
  if (rawMap === '') return null;
  const entries = rawMap.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) return null;
  const selectedRaw = entries.length === 1 ? entries[0] : entries[workerIndex - 1];
  if (!selectedRaw) return null;
  try {
    const mode = normalizeTeamWorkerCliMode(selectedRaw, OMX_TEAM_WORKER_CLI_MAP_ENV);
    return mode === 'auto' ? resolveTeamWorkerCliFromLaunchArgs(launchArgs) : mode;
  } catch {
    return null;
  }
}

/**
 * Worker CLI resolution contract for submit routing:
 * 1) explicit workerCli param from caller
 * 2) per-worker OMX_TEAM_WORKER_CLI_MAP entry (worker index aware)
 * 3) global/default OMX_TEAM_WORKER_CLI behavior
 */
export function resolveWorkerCliForSend(
  workerIndex: number,
  workerCli?: TeamWorkerCli,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli {
  if (workerCli) return workerCli;
  const mapped = resolveWorkerCliFromMapForSend(workerIndex, launchArgs, env);
  if (mapped) return mapped;
  return resolveTeamWorkerCli(launchArgs, env);
}

export function buildWorkerSubmitPlan(
  strategy: 'auto' | 'queue' | 'interrupt',
  workerCli: TeamWorkerCli,
  paneBusyAtStart: boolean,
  allowAdaptiveRetry: boolean,
): WorkerSubmitPlan {
  const queueRequested = strategy === 'queue' || (strategy === 'auto' && paneBusyAtStart);
  return {
    shouldInterrupt: strategy === 'interrupt',
    queueFirstRound: workerCli === 'codex' && queueRequested,
    rounds: 6,
    submitKeyPressesPerRound: workerCli === 'claude' ? 1 : 2,
    allowAdaptiveRetry: workerCli === 'codex' && allowAdaptiveRetry,
  };
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

function sendLiteralTextOrThrow(target: string, text: string): void {
  const send = runTmux(['send-keys', '-t', target, '-l', '--', text]);
  if (!send.ok) {
    throw new Error(`sendToWorker: failed to send text: ${send.stderr}`);
  }
}

function paneHasQueuedCodexSubmission(captured: string | null | undefined): boolean {
  const normalized = normalizeTmuxCapture(captured ?? '');
  if (normalized === '') return false;
  return /messages to be submitted after next tool call/i.test(normalized)
    || /press esc to interrupt and send immediately/i.test(normalized);
}

async function attemptSubmitRounds(
  target: string,
  text: string,
  rounds: number,
  queueFirstRound: boolean,
  submitKeyPressesPerRound: number,
): Promise<boolean> {
  const presses = Math.max(1, Math.floor(submitKeyPressesPerRound));
  for (let round = 0; round < rounds; round++) {
    await sleep(100);
    if (round === 0 && queueFirstRound) {
      await sendKeyAsync(target, 'Tab');
      await sleep(80);
      await sendKeyAsync(target, 'C-m');
    } else {
      for (let press = 0; press < presses; press++) {
        await sendKeyAsync(target, 'C-m');
        if (press < presses - 1) {
          await sleep(200);
        }
      }
    }
    await sleep(140);
    const [captured, visibleCapture] = await Promise.all([
      capturePaneAsync(target),
      captureVisiblePaneAsync(target),
    ]);
    const normalizedCapture = normalizeTmuxCapture(captured);
    if (
      !normalizedCapture.includes(normalizeTmuxCapture(text))
      && !paneHasQueuedCodexSubmission(visibleCapture)
    ) {
      return true;
    }
    await sleep(140);
  }
  return false;
}

export function waitForWorkerReady(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 30_000,
  workerPaneId?: string,
): boolean {
  const initialBackoffMs = 150;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let promptDismissed = false;

  const sendRobustEnter = (): void => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) for raw-mode compatibility.
    runTmux(['send-keys', '-t', target, 'C-m']);
    sleepFractionalSeconds(0.12);
    runTmux(['send-keys', '-t', target, 'C-m']);
  };

  const check = (): boolean => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    const result = runTmux(sharedBuildVisibleCapturePaneArgv(target));
    if (!result.ok) return false;
    if (dismissClaudeBypassPermissionsPromptIfPresent(target, result.stdout)) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        sendRobustEnter();
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    // Keep startup safety checks anchored to the visible pane. Only if the
    // visible slice already proves a live Codex viewport do we consult recent
    // scrollback for the prompt/helper text that may have slipped below the fold.
    if (!sharedPaneShowsCodexViewport(result.stdout)) return false;

    const scrollbackResult = runTmux(sharedBuildCapturePaneArgv(target, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    if (blockedByTrustPrompt) return false;
    // After dismissing a trust prompt, reset backoff so we re-check quickly
    // instead of sleeping 2s/4s/8s while the worker is starting up.
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepSeconds(Math.max(0, Math.min(delayMs, remaining)) / 1000);
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

// Async twin of waitForWorkerReady for team startup fan-out. Keep the readiness
// semantics mirrored with the synchronous helper above, but yield between polls
// so one slow worker pane cannot block later workers' startup attempts.
export async function waitForWorkerReadyAsync(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 30_000,
  workerPaneId?: string,
): Promise<boolean> {
  const initialBackoffMs = 150;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let promptDismissed = false;

  const sendRobustEnter = async (): Promise<void> => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) for raw-mode compatibility.
    await runTmuxAsync(['send-keys', '-t', target, 'C-m']);
    await sleep(120);
    await runTmuxAsync(['send-keys', '-t', target, 'C-m']);
  };

  const check = async (): Promise<boolean> => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
    if (!result.ok) return false;
    if (dismissClaudeBypassPermissionsPromptIfPresent(target, result.stdout)) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        await sendRobustEnter();
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    // Keep startup safety checks anchored to the visible pane. Only if the
    // visible slice already proves a live Codex viewport do we consult recent
    // scrollback for the prompt/helper text that may have slipped below the fold.
    if (!sharedPaneShowsCodexViewport(result.stdout)) return false;

    const scrollbackResult = await runTmuxAsync(sharedBuildCapturePaneArgv(target, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    if (blockedByTrustPrompt) return false;
    // After dismissing a trust prompt, reset backoff so we re-check quickly
    // instead of sleeping 2s/4s/8s while the worker is starting up.
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.max(0, Math.min(delayMs, remaining)));
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

/**
 * Detect and auto-dismiss a Codex "Trust this directory?" prompt in a worker pane.
 * Returns true if a trust prompt was found and dismissed, false otherwise.
 * Opt-out: set OMX_TEAM_AUTO_TRUST=0 to disable auto-dismissal.
 */
export function dismissTrustPromptIfPresent(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
): boolean {
  if (process.env.OMX_TEAM_AUTO_TRUST === '0') return false;
  if (!isTmuxAvailable()) return false;
  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const result = runTmux(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return false;
  if (!paneHasTrustPrompt(result.stdout)) return false;
  // Trust prompt detected; send C-m twice to dismiss (trust + follow-up splash)
  runTmux(['send-keys', '-t', target, 'C-m']);
  sleepFractionalSeconds(0.12);
  runTmux(['send-keys', '-t', target, 'C-m']);
  return true;
}

export const normalizeTmuxCapture = sharedNormalizeTmuxCapture;

function assertWorkerTriggerText(text: string): void {
  if (text.length >= 200) {
    throw new Error('sendToWorker: text must be < 200 characters');
  }
  if (text.trim().length === 0) {
    throw new Error('sendToWorker: text must be non-empty');
  }
  if (text.includes(INJECTION_MARKER)) {
    throw new Error('sendToWorker: injection marker is not allowed');
  }
}

export function sendToWorkerStdin(
  stdin: Pick<NodeJS.WritableStream, 'write' | 'writable'> | null | undefined,
  text: string,
): void {
  assertWorkerTriggerText(text);
  if (!stdin || !stdin.writable) {
    throw new Error('sendToWorkerStdin: stdin is not writable');
  }
  stdin.write(`${text}\n`);
}

// Send SHORT text (<200 chars) to worker via tmux send-keys
// Validates: text < 200 chars, no injection marker
// Throws on violation
export async function sendToWorker(
  sessionName: string,
  workerIndex: number,
  text: string,
  workerPaneId?: string,
  workerCli?: TeamWorkerCli,
): Promise<void> {
  assertWorkerTriggerText(text);

  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const strategy = resolveSendStrategyFromEnv();
  const resolvedWorkerCli = resolveWorkerCliForSend(workerIndex, workerCli);

  // Guard: if the trust prompt is still present, advance it first so our trigger text
  // doesn't get typed into the trust screen and ignored.
  const capturedStr = await capturePaneAsync(target);
  const paneBusy = paneHasActiveTask(capturedStr);
  if (dismissClaudeBypassPermissionsPromptIfPresent(target, capturedStr)) {
    await sleep(200);
  }
  if (paneHasTrustPrompt(capturedStr)) {
    await sendKeyAsync(target, 'C-m');
    await sleep(120);
    await sendKeyAsync(target, 'C-m');
    await sleep(200);
  }

  sendLiteralTextOrThrow(target, text);

  // Allow the input buffer to settle before sending C-m
  await sleep(150);

  const allowAutoInterruptRetry = process.env[OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV] !== '0';
  const submitPlan = buildWorkerSubmitPlan(strategy, resolvedWorkerCli, paneBusy, allowAutoInterruptRetry);
  if (submitPlan.shouldInterrupt) {
    // Explicit interrupt mode: abort current turn first, then submit the new command.
    await sendKeyAsync(target, 'C-c');
    await sleep(100);
  }

  // Submit deterministically using CLI-specific plan:
  // - Codex: queue-first Tab+C-m when configured/busy, then double C-m rounds.
  // - Claude: direct C-m rounds only (never queue-first Tab).
  if (await attemptSubmitRounds(
    target,
    text,
    submitPlan.rounds,
    submitPlan.queueFirstRound,
    submitPlan.submitKeyPressesPerRound,
  )) return;

  // Adaptive escalation for "likely unsent trigger text at ready prompt" cases:
  // clear line, re-send trigger, then re-submit with deterministic C-m rounds.
  const latestCapture = await capturePaneAsync(target);
  if (shouldAttemptAdaptiveRetry(strategy, paneBusy, submitPlan.allowAdaptiveRetry, latestCapture || null, text)) {
    // Keep this branch non-interrupting to avoid canceling active turns on false positives.
    await sendKeyAsync(target, 'C-u');
    await sleep(80);
    sendLiteralTextOrThrow(target, text);
    await sleep(120);
    if (await attemptSubmitRounds(target, text, 4, false, submitPlan.submitKeyPressesPerRound)) return;
  }

  // Fail-open by default: Codex may keep the last submitted line visible even after executing it.
  // If you need strictness for debugging, set OMX_TEAM_STRICT_SUBMIT=1.
  const strict = process.env.OMX_TEAM_STRICT_SUBMIT === '1';
  if (strict) {
    throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');
  }

  // One last best-effort double C-m nudge, then verify.
  await sendKeyAsync(target, 'C-m');
  await sleep(120);
  await sendKeyAsync(target, 'C-m');

  // Post-submit verification: wait briefly and confirm the worker consumed the
  // trigger (draft disappeared or active-task indicator appeared). Fixes #391.
  await sleep(300);
  const [verifyCapture, verifyVisibleCapture] = await Promise.all([
    capturePaneAsync(target),
    captureVisiblePaneAsync(target),
  ]);
  if (verifyCapture) {
    if (paneHasActiveTask(verifyCapture)) return;
    if (
      !normalizeTmuxCapture(verifyCapture).includes(normalizeTmuxCapture(text))
      && !paneHasQueuedCodexSubmission(verifyVisibleCapture)
    ) {
      return;
    }
    // Draft still visible and no active task — one more C-m attempt.
    await sendKeyAsync(target, 'C-m');
    await sleep(150);
    await sendKeyAsync(target, 'C-m');
    const finalVisibleCapture = await captureVisiblePaneAsync(target);
    if (paneHasQueuedCodexSubmission(finalVisibleCapture)) {
      throw new Error('sendToWorker: submit_queued_after_tool_call');
    }
  }
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

export function isWorkerPaneOpen(sessionName: string, workerIndex: number, workerPaneId?: string): boolean {
  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex, workerPaneId),
    '-F',
    '#{pane_dead}',
  ]);
  if (!result.ok) return false;
  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;
  return line !== '1';
}

// Kill a specific worker: send C-c, then C-d, then kill-pane if still alive.
// leaderPaneId: when provided, the kill is skipped entirely if workerPaneId matches it.
export async function killWorker(sessionName: string, workerIndex: number, workerPaneId?: string, leaderPaneId?: string): Promise<void> {
  // Guard: never kill the leader's own pane.
  if (leaderPaneId && workerPaneId === leaderPaneId) return;

  await runTmuxAsync(['send-keys', '-t', paneTarget(sessionName, workerIndex, workerPaneId), 'C-c']);
  await sleep(1000);

  if (await isWorkerAliveAsync(sessionName, workerIndex, workerPaneId)) {
    await runTmuxAsync(['send-keys', '-t', paneTarget(sessionName, workerIndex, workerPaneId), 'C-d']);
    await sleep(1000);
  }

  if (await isWorkerAliveAsync(sessionName, workerIndex, workerPaneId)) {
    await runTmuxAsync(['kill-pane', '-t', paneTarget(sessionName, workerIndex, workerPaneId)]);
  }
}

// leaderPaneId: when provided, the kill is skipped if workerPaneId matches it.
export function killWorkerByPaneId(workerPaneId: string, leaderPaneId?: string): void {
  if (!workerPaneId.startsWith('%')) return;
  // Guard: never kill the leader's own pane.
  if (leaderPaneId && workerPaneId === leaderPaneId) return;
  runTmux(['kill-pane', '-t', workerPaneId]);
}

export async function killWorkerByPaneIdAsync(workerPaneId: string, leaderPaneId?: string): Promise<void> {
  if (!workerPaneId.startsWith('%')) return;
  // Guard: never kill the leader's own pane.
  if (leaderPaneId && workerPaneId === leaderPaneId) return;
  await runTmuxAsync(['kill-pane', '-t', workerPaneId]);
}

export interface PaneTeardownSummary {
  attemptedPaneIds: string[];
  excluded: {
    leader: number;
    hud: number;
    invalid: number;
  };
  kill: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
}

export interface PaneTeardownOptions {
  leaderPaneId?: string | null;
  hudPaneId?: string | null;
  graceMs?: number;
}

export interface SharedSessionShutdownTopology {
  livePaneIds: string[];
  leaderPaneId: string | null;
  hudPaneIds: string[];
}

function normalizePaneTarget(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('%')) return null;
  return trimmed;
}

function normalizePaneTargets(
  paneIds: string[],
  options: PaneTeardownOptions = {},
): { killablePaneIds: string[]; excluded: PaneTeardownSummary['excluded'] } {
  const leaderPaneId = normalizePaneTarget(options.leaderPaneId);
  const hudPaneId = normalizePaneTarget(options.hudPaneId);
  const excluded = { leader: 0, hud: 0, invalid: 0 };
  const deduped = new Set<string>();
  const killablePaneIds: string[] = [];

  for (const paneId of paneIds) {
    const normalized = normalizePaneTarget(paneId);
    if (!normalized) {
      excluded.invalid += 1;
      continue;
    }
    if (leaderPaneId && normalized === leaderPaneId) {
      excluded.leader += 1;
      continue;
    }
    if (hudPaneId && normalized === hudPaneId) {
      excluded.hud += 1;
      continue;
    }
    if (deduped.has(normalized)) continue;
    deduped.add(normalized);
    killablePaneIds.push(normalized);
  }

  return { killablePaneIds, excluded };
}

export function resolveSharedSessionShutdownTopology(
  sessionName: string,
  preferredLeaderPaneId?: string | null,
): SharedSessionShutdownTopology {
  const panes = listPanes(sessionName);
  const livePaneIds = panes
    .map((pane) => normalizePaneTarget(pane.paneId))
    .filter((paneId): paneId is string => Boolean(paneId));
  const fallbackLeaderPaneId = normalizePaneTarget(preferredLeaderPaneId);
  if (panes.length === 0) {
    return {
      livePaneIds,
      leaderPaneId: fallbackLeaderPaneId,
      hudPaneIds: [],
    };
  }

  const resolvedLeaderPaneId = normalizePaneTarget(
    chooseTeamLeaderPaneId(panes, fallbackLeaderPaneId ?? ''),
  ) ?? fallbackLeaderPaneId;
  const hudPaneIds = panes
    .filter((pane) => pane.paneId !== resolvedLeaderPaneId)
    .filter((pane) => isHudWatchPane(pane))
    .map((pane) => pane.paneId)
    .filter((paneId) => paneId.startsWith('%'));

  return {
    livePaneIds,
    leaderPaneId: resolvedLeaderPaneId,
    hudPaneIds,
  };
}

/**
 * Shared pane-id-direct teardown primitive for worker pane cleanup.
 * Must remain liveness-agnostic: do not gate on isWorkerAlive/killWorker.
 */
export async function teardownWorkerPanes(
  paneIds: string[],
  options: PaneTeardownOptions = {},
): Promise<PaneTeardownSummary> {
  const { killablePaneIds, excluded } = normalizePaneTargets(paneIds, options);
  const graceMs = options.graceMs ?? 2000;
  const perPaneGrace = killablePaneIds.length > 0
    ? Math.max(100, Math.floor(graceMs / killablePaneIds.length))
    : 0;

  const summary: PaneTeardownSummary = {
    attemptedPaneIds: killablePaneIds,
    excluded,
    kill: {
      attempted: killablePaneIds.length,
      succeeded: 0,
      failed: 0,
    },
  };

  for (const paneId of killablePaneIds) {
    const result = await runTmuxAsync(['kill-pane', '-t', paneId]);
    if (result.ok) summary.kill.succeeded += 1;
    else summary.kill.failed += 1;
    await sleep(perPaneGrace);
  }

  return summary;
}

export async function killWorkerPanes(
  paneIds: string[],
  leaderPaneId: string,
  graceMs: number = 2000,
  hudPaneId?: string,
): Promise<PaneTeardownSummary> {
  return teardownWorkerPanes(paneIds, { leaderPaneId, hudPaneId: hudPaneId ?? null, graceMs });
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

/**
 * Notify the leader through durable mailbox state only.
 *
 * Team leaders are a coordination endpoint, not a direct tmux control target:
 * workers and runtime paths may message `leader-fixed` via `omx team api`
 * / mailbox persistence, but team code must not inject text or control keys
 * into the leader pane. This is the async mailbox-based replacement for
 * `notifyLeaderStatus()`.
 */
export async function notifyLeaderMailboxAsync(
  teamName: string,
  fromWorker: string,
  message: string,
  cwd: string,
): Promise<boolean> {
  try {
    const { sendDirectMessage } = await import('./state.js');
    await sendDirectMessage(teamName, fromWorker, 'leader-fixed', message, cwd);
    return true;
  } catch {
    return false;
  }
}
