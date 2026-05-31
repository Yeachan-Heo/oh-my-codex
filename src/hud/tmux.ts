import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_HEIGHT_LINES } from './constants.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

export interface TmuxPaneSnapshot {
  paneId: string;
  currentCommand: string;
  startCommand: string;
  currentPath?: string;
}

export const OMX_TMUX_HUD_LEADER_PANE_ENV = 'OMX_TMUX_HUD_LEADER_PANE';
const OMX_TMUX_HUD_OWNER_ENV = 'OMX_TMUX_HUD_OWNER';
export const TMUX_PANE_FIELD_SEPARATOR = '\x1f';
export const TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE = '\\037';

export interface HudPaneOwner {
  sessionId?: string;
  leaderPaneId?: string;
}
export type HudRuntimeRootSource = 'team-env' | 'omx-root-env' | 'omx-state-root-env' | 'cwd-default';

export interface HudRuntimeEnvInput {
  sessionId?: string;
  leaderPaneId?: string;
  omxRoot?: string;
  omxStateRoot?: string;
  omxTeamStateRoot?: string;
  rootSource?: HudRuntimeRootSource;
}

export interface HudRuntimeEnvOutput {
  env: Record<string, string>;
  owner: HudPaneOwner;
}

type TmuxExecSync = (args: string[]) => string;

/** Upper bound for tmux hook indices (signed 32-bit max). */
const TMUX_HOOK_INDEX_MAX = 2147483647;

function defaultExecTmuxSync(args: string[]): string {
  try {
    return execFileSync(resolveTmuxBinaryForPlatform() || 'tmux', args, {
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
  } catch (error) {
    const maybeSpawnError = error as { status?: unknown; stdout?: unknown };
    if (maybeSpawnError.status === 0 && typeof maybeSpawnError.stdout === 'string') {
      return maybeSpawnError.stdout;
    }
    throw error;
  }
}

export function parseTmuxPaneSnapshot(output: string): TmuxPaneSnapshot[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fieldSeparator = line.includes(TMUX_PANE_FIELD_SEPARATOR)
        ? TMUX_PANE_FIELD_SEPARATOR
        : line.includes(TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE)
          ? TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE
          : '\t';
      const parts = line.split(fieldSeparator);
      const [paneId = '', currentCommand = ''] = parts;
      const hasCurrentPathColumn = parts.length >= 4;
      const currentPath = hasCurrentPathColumn ? (parts.at(-1) ?? '') : '';
      const startCommandParts = hasCurrentPathColumn ? parts.slice(2, -1) : parts.slice(2);
      const trimmedCurrentPath = currentPath.trim();
      return {
        paneId: paneId.trim(),
        currentCommand: currentCommand.trim(),
        startCommand: startCommandParts.join('\t').trim(),
        ...(trimmedCurrentPath ? { currentPath: trimmedCurrentPath } : {}),
      };
    })
    .filter((pane) => pane.paneId.startsWith('%'));
}

export function isHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`.toLowerCase();
  return (
    /\bhud\b/.test(command)
    && /--watch\b/.test(command)
    && (/\bomx(?:\.js)?\b/.test(command) || /\bnode\b/.test(command))
  );
}


function parseShellEnvAssignment(command: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(
    new RegExp(
      `(?:^|\\s)(?:'${escapedKey}=([^']*)'|${escapedKey}=(?:'((?:'\\\\''|[^'])*)'|([^\\s]+)))`,
    ),
  );
  const fallbackMatch = match
    ? null
    : command.match(new RegExp(`(?:^|[\\s'])${escapedKey}=([^'\\s]+)`));
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? fallbackMatch?.[1];
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/'\\''/g, "'").trim();
  return value === '' ? undefined : value;
}

export function readHudPaneOwner(pane: TmuxPaneSnapshot): HudPaneOwner {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  return {
    sessionId: parseShellEnvAssignment(command, 'OMX_SESSION_ID'),
    leaderPaneId: parseShellEnvAssignment(command, OMX_TMUX_HUD_LEADER_PANE_ENV),
  };
}


function hasHudPaneOwnerMetadata(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  const owner = readHudPaneOwner(pane);
  return parseShellEnvAssignment(command, OMX_TMUX_HUD_OWNER_ENV) === '1'
    || Boolean(owner.sessionId || owner.leaderPaneId);
}

function hasOmxCliToken(command: string): boolean {
  return /(?:^|[\s'"])(?:[^\s'"]*\/)?omx(?:\.js)?(?=$|[\s'"])/.test(command);
}

function isLegacyFocusedHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  // Migration-only heuristic for prompt-submit auto-HUD reconciliation: older
  // focused auto-HUD panes lacked owner metadata, so keep this deliberately
  // narrower than general HUD ownership/reaping.
  if (!isHudWatchPane(pane) || hasHudPaneOwnerMetadata(pane)) return false;
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  return hasOmxCliToken(command)
    && !/(?:^|[\s'"])--tmux(?:[\s'"]|$)/.test(command)
    && /(?:^|[\s'"])--preset=focused(?:[\s'"]|$)/.test(command);
}

export function findLegacyFocusedHudWatchPaneIds(
  panes: TmuxPaneSnapshot[],
  currentPaneId?: string,
): string[] {
  return panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => isLegacyFocusedHudWatchPane(pane))
    .map((pane) => pane.paneId);
}

export function hudPaneMatchesOwner(pane: TmuxPaneSnapshot, owner: HudPaneOwner = {}): boolean {
  if (!isHudWatchPane(pane)) return false;
  const wantedSessionId = typeof owner.sessionId === 'string' ? owner.sessionId.trim() : '';
  const wantedLeaderPaneId = typeof owner.leaderPaneId === 'string' ? owner.leaderPaneId.trim() : '';
  const wantsSession = wantedSessionId !== '';
  const wantsLeaderPane = wantedLeaderPaneId !== '';
  if (!wantsSession && !wantsLeaderPane) return true;

  const paneOwner = readHudPaneOwner(pane);
  const sessionMatches = wantsSession && paneOwner.sessionId === wantedSessionId;
  const leaderPaneMatches = wantsLeaderPane && paneOwner.leaderPaneId === wantedLeaderPaneId;

  if (wantsSession && wantsLeaderPane) {
    if (!sessionMatches) return false;
    return !paneOwner.leaderPaneId || leaderPaneMatches;
  }
  if (wantsSession) return sessionMatches;
  return leaderPaneMatches && !paneOwner.sessionId;
}

export function findHudWatchPaneIds(
  panes: TmuxPaneSnapshot[],
  currentPaneId?: string,
  owner: HudPaneOwner = {},
): string[] {
  return panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => hudPaneMatchesOwner(pane, owner))
    .map((pane) => pane.paneId);
}

function isDeletedTmuxPanePath(path: string | undefined): boolean {
  const currentPath = path?.trim();
  return Boolean(currentPath && /(?:^|\s)\(deleted\)\s*$/.test(currentPath) && !existsSync(currentPath));
}

function hasDeletedTmuxPaneMarker(path: string | undefined): boolean {
  const currentPath = path?.trim();
  return Boolean(currentPath && /(?:^|\s)\(deleted\)\s*$/.test(currentPath));
}

function isDoctorSmokeSessionId(sessionId: string | undefined): boolean {
  return /^(?:doctor-smoke|omx-doctor-[a-z0-9-]+-smoke)$/i.test(sessionId ?? '');
}

function shouldReapDeletedCwdHudPane(pane: TmuxPaneSnapshot, isLivePane: (paneId: string) => boolean): boolean {
  // A deleted tmux launch cwd is not enough to prove a HUD is dead: watch mode can
  // keep serving from a resolved live cwd. Reap only explicit doctor smoke panes or
  // owner-tagged panes whose leader is gone.
  if (!hasHudPaneOwnerMetadata(pane) || !hasDeletedTmuxPaneMarker(pane.currentPath)) return false;
  const owner = readHudPaneOwner(pane);
  if (isDoctorSmokeSessionId(owner.sessionId)) return true;
  if (!isDeletedTmuxPanePath(pane.currentPath)) return false;
  return !owner.leaderPaneId || !isLivePane(owner.leaderPaneId);
}

export function reapDeadHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    isLivePane?: (paneId: string) => boolean;
    killPane?: (paneId: string) => boolean;
  } = {},
): { reaped: string[]; preserved: string[] } {
  const livePaneIds = new Set(panes.map((pane) => pane.paneId));
  const isLivePane = opts.isLivePane ?? ((paneId: string) => livePaneIds.has(paneId));
  const killPane = opts.killPane ?? ((paneId: string) => killTmuxPane(paneId));
  const reaped: string[] = [];
  const preserved: string[] = [];

  for (const pane of panes) {
    if (!isHudWatchPane(pane)) continue;

    if (shouldReapDeletedCwdHudPane(pane, isLivePane) && killPane(pane.paneId)) {
      reaped.push(pane.paneId);
      continue;
    }

    const leaderPaneId = readHudPaneOwner(pane).leaderPaneId;
    if (!leaderPaneId) {
      preserved.push(pane.paneId);
      continue;
    }

    if (isLivePane(leaderPaneId)) {
      preserved.push(pane.paneId);
      continue;
    }

    if (killPane(pane.paneId)) {
      reaped.push(pane.paneId);
    } else {
      preserved.push(pane.paneId);
    }
  }

  return { reaped, preserved };
}

export function parsePaneIdFromTmuxOutput(rawOutput: string): string | null {
  const paneId = rawOutput.split('\n')[0]?.trim() || '';
  return paneId.startsWith('%') ? paneId : null;
}

export function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTmuxHookToken(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'unknown';
}

function isTmuxSessionId(value: string): boolean {
  return /^\$\d+$/.test(value);
}

function isTmuxWindowId(value: string): boolean {
  return /^@\d+$/.test(value);
}

function isTmuxPaneId(value: string): boolean {
  return /^%\d+$/.test(value);
}

export function buildHudResizeHookName(sessionId: string, windowId: string, leaderPaneId: string): string {
  return [
    'omx_hud_resize',
    normalizeTmuxHookToken(sessionId),
    normalizeTmuxHookToken(windowId),
    normalizeTmuxHookToken(leaderPaneId),
  ].join('_');
}

function buildLegacyHudResizeHookName(sessionId: string, windowId: string): string {
  return [
    'omx_hud_resize',
    normalizeTmuxHookToken(sessionId),
    normalizeTmuxHookToken(windowId),
  ].join('_');
}

export function buildHudResizeHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-resized[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export interface HudResizeHookContext {
  sessionId: string;
  windowId: string;
  leaderPaneId: string;
  hookName: string;
  hookSlot: string;
}

export function parseHudResizeHookContext(output: string, leaderPaneId: string): HudResizeHookContext | null {
  const [sessionId = '', windowId = ''] = output
    .split('\n')[0]
    ?.split('\t')
    .map((part) => part.trim()) ?? [];
  const normalizedLeaderPaneId = leaderPaneId.trim();
  if (!isTmuxSessionId(sessionId) || !isTmuxWindowId(windowId) || !isTmuxPaneId(normalizedLeaderPaneId)) return null;
  const hookName = buildHudResizeHookName(sessionId, windowId, normalizedLeaderPaneId);
  return {
    sessionId,
    windowId,
    leaderPaneId: normalizedLeaderPaneId,
    hookName,
    hookSlot: buildHudResizeHookSlot(hookName),
  };
}

export function readHudResizeHookContext(
  leaderPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): HudResizeHookContext | null {
  if (!leaderPaneId || !isTmuxPaneId(leaderPaneId)) return null;
  try {
    return parseHudResizeHookContext(
      execTmuxSync([
        'display-message',
        '-p',
        '-t',
        leaderPaneId,
        '#{session_id}\t#{window_id}',
      ]),
      leaderPaneId,
    );
  } catch {
    return null;
  }
}

function buildNestedTmuxCommand(tmuxBin: string, args: string[]): string {
  return [tmuxBin, ...args].map((part) => shellEscapeSingle(part)).join(' ');
}

function buildHudResizeHookCommand(
  tmuxBin: string,
  hudPaneId: string,
  height: string,
  context: HudResizeHookContext,
): string {
  const resize = buildNestedTmuxCommand(tmuxBin, ['resize-pane', '-t', hudPaneId, '-y', height]);
  const unregister = buildNestedTmuxCommand(tmuxBin, ['set-hook', '-u', '-t', context.sessionId, context.hookSlot]);
  const resizeOrUnregister = `${resize} >/dev/null 2>&1 || ${unregister} >/dev/null 2>&1 || true`;
  return `${resizeOrUnregister}; sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${resizeOrUnregister}`;
}

function unregisterLegacyHudResizeHook(
  context: HudResizeHookContext,
  execTmuxSync: TmuxExecSync,
): void {
  const legacyHookSlot = buildHudResizeHookSlot(buildLegacyHudResizeHookName(context.sessionId, context.windowId));
  if (legacyHookSlot === context.hookSlot) return;
  try {
    execTmuxSync(['set-hook', '-u', '-t', context.sessionId, legacyHookSlot]);
  } catch {
    // Best-effort migration cleanup: failure should not prevent the new
    // leader-scoped hook from being registered or unregistered.
  }
}

function buildEnvPrefix(env: Record<string, string | undefined>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => [key, typeof value === 'string' ? value : ''] as const)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${shellEscapeSingle(value)}`);
  return assignments.length > 0 ? `env ${assignments.join(' ')} ` : '';
}
export function buildHudRuntimeEnv(input: HudRuntimeEnvInput = {}): HudRuntimeEnvOutput {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const leaderPaneId = typeof input.leaderPaneId === 'string' ? input.leaderPaneId.trim() : '';
  const env: Record<string, string> = {};
  if (sessionId) env.OMX_SESSION_ID = sessionId;
  env[OMX_TMUX_HUD_OWNER_ENV] = '1';
  if (leaderPaneId) env[OMX_TMUX_HUD_LEADER_PANE_ENV] = leaderPaneId;
  if (input.rootSource === 'team-env' && input.omxTeamStateRoot?.trim()) {
    env.OMX_TEAM_STATE_ROOT = input.omxTeamStateRoot.trim();
  } else if (input.rootSource === 'omx-state-root-env' && input.omxStateRoot?.trim()) {
    env.OMX_STATE_ROOT = input.omxStateRoot.trim();
  } else if (input.omxRoot?.trim()) {
    env.OMX_ROOT = input.omxRoot.trim();
  }
  return {
    env,
    owner: {
      ...(sessionId ? { sessionId } : {}),
      ...(leaderPaneId ? { leaderPaneId } : {}),
    },
  };
}

export function buildHudWatchCommand(
  omxBin: string,
  preset?: string,
  sessionId?: string,
  omxRoot?: string,
  leaderPaneId?: string,
  rootEnv?: Pick<HudRuntimeEnvInput, 'omxStateRoot' | 'omxTeamStateRoot' | 'rootSource'>,
): string {
  const safePreset = preset === 'minimal' || preset === 'focused' || preset === 'full'
    ? ` --preset=${preset}`
    : '';
  const envPrefix = buildEnvPrefix(buildHudRuntimeEnv({
    sessionId,
    leaderPaneId,
    omxRoot,
    ...(rootEnv ?? { rootSource: 'omx-root-env' }),
  }).env);
  return `exec ${envPrefix}${shellEscapeSingle(process.execPath)} ${shellEscapeSingle(omxBin)} hud --watch${safePreset}`;
}

export function listCurrentWindowPanes(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  currentPaneId?: string,
): TmuxPaneSnapshot[] {
  try {
    return parseTmuxPaneSnapshot(
      execTmuxSync([
        'list-panes',
        ...(currentPaneId ? ['-t', currentPaneId] : []),
        '-F',
        `#{pane_id}${TMUX_PANE_FIELD_SEPARATOR}#{pane_current_command}${TMUX_PANE_FIELD_SEPARATOR}#{pane_start_command}${TMUX_PANE_FIELD_SEPARATOR}#{pane_current_path}`,
      ]),
    );
  } catch {
    return [];
  }
}

export function readActiveTmuxPaneId(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  try {
    return parsePaneIdFromTmuxOutput(execTmuxSync(['display-message', '-p', '#{pane_id}']));
  } catch {
    return null;
  }
}

export function listCurrentWindowHudPaneIds(
  currentPaneId?: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  owner: HudPaneOwner = {},
): string[] {
  return findHudWatchPaneIds(listCurrentWindowPanes(execTmuxSync, currentPaneId), currentPaneId, owner);
}

export function readCurrentWindowSize(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  currentPaneId?: string,
): { width: number | null; height: number | null } {
  try {
    const raw = execTmuxSync([
      'display-message',
      '-p',
      ...(currentPaneId ? ['-t', currentPaneId] : []),
      '#{window_width}\t#{window_height}',
    ]);
    const [widthRaw = '', heightRaw = ''] = raw.split('\t');
    const width = Number.parseInt(widthRaw.trim(), 10);
    const height = Number.parseInt(heightRaw.trim(), 10);
    return {
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

export function createHudWatchPane(
  cwd: string,
  hudCmd: string,
  options: {
    heightLines?: number;
    fullWidth?: boolean;
    targetPaneId?: string;
  } = {},
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  const heightLines = Number.isFinite(options.heightLines) && (options.heightLines ?? 0) > 0
    ? Math.floor(options.heightLines ?? HUD_TMUX_HEIGHT_LINES)
    : HUD_TMUX_HEIGHT_LINES;
  const args = [
    'split-window',
    '-v',
    ...(options.fullWidth ? ['-f'] : []),
    '-l',
    String(heightLines),
    '-d',
    ...(options.targetPaneId ? ['-t', options.targetPaneId] : []),
    '-c',
    cwd,
    '-P',
    '-F',
    '#{pane_id}',
    hudCmd,
  ];
  try {
    return parsePaneIdFromTmuxOutput(execTmuxSync(args));
  } catch {
    return null;
  }
}

export function killTmuxPane(
  paneId: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  if (!paneId.startsWith('%')) return false;
  try {
    execTmuxSync(['kill-pane', '-t', paneId]);
    return true;
  } catch {
    return false;
  }
}

export function resizeTmuxPane(
  paneId: string,
  heightLines: number,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  if (!paneId.startsWith('%')) return false;
  const height = Number.isFinite(heightLines) && heightLines > 0
    ? Math.floor(heightLines)
    : HUD_TMUX_HEIGHT_LINES;
  try {
    execTmuxSync(['resize-pane', '-t', paneId, '-y', String(height)]);
    return true;
  } catch {
    return false;
  }
}

export function registerHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  heightLines: number,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  if (!hudPaneId.startsWith('%')) return false;
  const context = readHudResizeHookContext(leaderPaneId, execTmuxSync);
  if (!context) return false;
  const tmuxBin = resolveTmuxBinaryForPlatform() || 'tmux';
  const height = String(Math.max(1, Math.floor(heightLines)));
  const resizeCmd = shellEscapeSingle(buildHudResizeHookCommand(tmuxBin, hudPaneId, height, context));
  try {
    execTmuxSync(['set-hook', '-t', context.sessionId, context.hookSlot, `run-shell -b ${resizeCmd}`]);
    unregisterLegacyHudResizeHook(context, execTmuxSync);
    return true;
  } catch {
    return false;
  }
}

export function unregisterHudResizeHook(
  leaderPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const context = readHudResizeHookContext(leaderPaneId, execTmuxSync);
  if (!context) return false;
  try {
    unregisterLegacyHudResizeHook(context, execTmuxSync);
    execTmuxSync(['set-hook', '-u', '-t', context.sessionId, context.hookSlot]);
    return true;
  } catch {
    return false;
  }
}
