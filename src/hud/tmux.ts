import { execFileSync } from 'child_process';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_HEIGHT_LINES } from './constants.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

export interface TmuxPaneSnapshot {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

export const OMX_TMUX_HUD_LEADER_PANE_ENV = 'OMX_TMUX_HUD_LEADER_PANE';

export interface HudPaneOwner {
  sessionId?: string;
  leaderPaneId?: string;
}

type TmuxExecSync = (args: string[]) => string;

/** Upper bound for tmux hook indices (signed 32-bit max). */
const TMUX_HOOK_INDEX_MAX = 2147483647;

function defaultExecTmuxSync(args: string[]): string {
  return execFileSync(resolveTmuxBinaryForPlatform() || 'tmux', args, {
    encoding: 'utf-8',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
}

export function parseTmuxPaneSnapshot(output: string): TmuxPaneSnapshot[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId = '', currentCommand = '', ...startCommandParts] = line.split('\t');
      return {
        paneId: paneId.trim(),
        currentCommand: currentCommand.trim(),
        startCommand: startCommandParts.join('\t').trim(),
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

export function hudPaneMatchesOwner(pane: TmuxPaneSnapshot, owner: HudPaneOwner = {}): boolean {
  if (!isHudWatchPane(pane)) return false;
  const wantsSession = typeof owner.sessionId === 'string' && owner.sessionId.trim() !== '';
  const wantsLeaderPane = typeof owner.leaderPaneId === 'string' && owner.leaderPaneId.trim() !== '';
  if (!wantsSession && !wantsLeaderPane) return true;
  const paneOwner = readHudPaneOwner(pane);
  if (wantsSession && paneOwner.sessionId !== owner.sessionId?.trim()) return false;
  if (wantsSession && wantsLeaderPane && !paneOwner.leaderPaneId) return true;
  if (wantsLeaderPane && paneOwner.leaderPaneId !== owner.leaderPaneId?.trim()) return false;
  return true;
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

export function buildHudResizeHookName(sessionId: string, windowId: string): string {
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
  hookName: string;
  hookSlot: string;
}

export function parseHudResizeHookContext(output: string): HudResizeHookContext | null {
  const [sessionId = '', windowId = ''] = output
    .split('\n')[0]
    ?.split('\t')
    .map((part) => part.trim()) ?? [];
  if (!sessionId || !windowId) return null;
  const hookName = buildHudResizeHookName(sessionId, windowId);
  return {
    sessionId,
    windowId,
    hookName,
    hookSlot: buildHudResizeHookSlot(hookName),
  };
}

export function readHudResizeHookContext(
  currentPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): HudResizeHookContext | null {
  if (!currentPaneId?.startsWith('%')) return null;
  try {
    return parseHudResizeHookContext(
      execTmuxSync([
        'display-message',
        '-p',
        '-t',
        currentPaneId,
        '#{session_id}\t#{window_id}',
      ]),
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

function buildEnvPrefix(env: Record<string, string | undefined>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => [key, typeof value === 'string' ? value : ''] as const)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${shellEscapeSingle(value)}`);
  return assignments.length > 0 ? `env ${assignments.join(' ')} ` : '';
}

export function buildHudWatchCommand(
  omxBin: string,
  preset?: string,
  sessionId?: string,
  omxRoot?: string,
  leaderPaneId?: string,
): string {
  const safePreset = preset === 'minimal' || preset === 'focused' || preset === 'full'
    ? ` --preset=${preset}`
    : '';
  const safeSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const safeOmxRoot = typeof omxRoot === 'string' ? omxRoot : '';
  const safeLeaderPaneId = typeof leaderPaneId === 'string' ? leaderPaneId.trim() : '';
  const envPrefix = buildEnvPrefix({
    OMX_SESSION_ID: safeSessionId,
    [OMX_TMUX_HUD_LEADER_PANE_ENV]: safeLeaderPaneId,
    OMX_ROOT: safeOmxRoot,
  });
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
        '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}',
      ]),
    );
  } catch {
    return [];
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
  currentPaneId: string | undefined,
  heightLines: number,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  if (!hudPaneId.startsWith('%')) return false;
  const context = readHudResizeHookContext(currentPaneId, execTmuxSync);
  if (!context) return false;
  const tmuxBin = resolveTmuxBinaryForPlatform() || 'tmux';
  const height = String(Math.max(1, Math.floor(heightLines)));
  const resizeCmd = shellEscapeSingle(buildHudResizeHookCommand(tmuxBin, hudPaneId, height, context));
  try {
    execTmuxSync(['set-hook', '-t', context.sessionId, context.hookSlot, `run-shell -b ${resizeCmd}`]);
    return true;
  } catch {
    return false;
  }
}

export function unregisterHudResizeHook(
  currentPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const context = readHudResizeHookContext(currentPaneId, execTmuxSync);
  if (!context) return false;
  try {
    execTmuxSync(['set-hook', '-u', '-t', context.sessionId, context.hookSlot]);
    return true;
  } catch {
    return false;
  }
}
