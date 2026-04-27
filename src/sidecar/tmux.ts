import { execFileSync } from 'node:child_process';
import { parsePaneIdFromTmuxOutput, shellEscapeSingle } from '../hud/tmux.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export interface SidecarTmuxOptions {
  cwd: string;
  teamName: string;
  width?: number;
  sessionId?: string;
  omxBin?: string;
}

type TmuxExecSync = (args: string[]) => string;

function sidecarWidth(width: number | undefined): number {
  return Number.isFinite(width) && (width ?? 0) >= 30 ? Math.floor(width ?? 48) : 48;
}

export function buildSidecarWatchCommand(options: SidecarTmuxOptions): string {
  const omxBin = options.omxBin ?? resolveOmxCliEntryPath();
  if (!omxBin) throw new Error('Failed to resolve OMX launcher path for sidecar startup.');
  const prefix = options.sessionId ? `OMX_SESSION_ID=${shellEscapeSingle(options.sessionId)} ` : '';
  return `${prefix}node ${shellEscapeSingle(omxBin)} sidecar ${shellEscapeSingle(options.teamName)} --watch --width ${sidecarWidth(options.width)}`;
}

export function buildSidecarTmuxSplitArgs(options: SidecarTmuxOptions): string[] {
  return [
    'split-window',
    '-h',
    '-d',
    '-l',
    String(sidecarWidth(options.width)),
    '-c',
    options.cwd,
    '-P',
    '-F',
    '#{pane_id}',
    buildSidecarWatchCommand(options),
  ];
}

function defaultExecTmuxSync(args: string[]): string {
  return execFileSync(resolveTmuxBinaryForPlatform() || 'tmux', args, {
    encoding: 'utf-8',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
}

export function launchSidecarTmuxPane(
  options: SidecarTmuxOptions,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  try {
    return parsePaneIdFromTmuxOutput(execTmuxSync(buildSidecarTmuxSplitArgs(options)));
  } catch {
    return null;
  }
}
