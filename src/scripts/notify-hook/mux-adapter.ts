/**
 * Runtime multiplexer adapter selection for notify-hook surfaces.
 *
 * The hook code still calls many helpers named "tmux" for compatibility.
 * This module provides the small bridge that lets those call sites target
 * cmux when OMX_MUX=cmux, or when OMX_MUX=auto and a cmux terminal
 * environment is present.
 */

export type MuxKind = 'tmux' | 'cmux';
export type MuxPreference = MuxKind | 'auto';

export interface MuxInvocation {
  command: string;
  args: string[];
  kind: MuxKind | null;
  translated: boolean;
  usingTestBinary: boolean;
  relaxTimeout: boolean;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeMuxPreference(value: unknown): MuxPreference | null {
  const normalized = safeString(value).trim().toLowerCase();
  if (normalized === 'tmux' || normalized === 'cmux' || normalized === 'auto') return normalized;
  return null;
}

export function isCmuxEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    safeString(env.CMUX_SURFACE_ID).trim()
    || safeString(env.CMUX_WORKSPACE_ID).trim(),
  );
}

export function resolveMuxKind(env: NodeJS.ProcessEnv = process.env): MuxKind {
  const preference = normalizeMuxPreference(env.OMX_MUX);
  if (preference === 'tmux' || preference === 'cmux') return preference;
  if (preference === 'auto' && isCmuxEnv(env)) return 'cmux';
  return 'tmux';
}

export function currentMuxPaneTarget(env: NodeJS.ProcessEnv = process.env): string {
  const kind = resolveMuxKind(env);
  const cmuxSurface = safeString(env.CMUX_SURFACE_ID).trim();
  const tmuxPane = safeString(env.TMUX_PANE).trim();
  return kind === 'cmux'
    ? (cmuxSurface || tmuxPane)
    : tmuxPane;
}

export function currentMuxSessionTarget(env: NodeJS.ProcessEnv = process.env): string {
  const kind = resolveMuxKind(env);
  const cmuxWorkspace = safeString(env.CMUX_WORKSPACE_ID).trim();
  const tmuxSession = safeString(env.TMUX).trim();
  return kind === 'cmux'
    ? (cmuxWorkspace || tmuxSession)
    : tmuxSession;
}

function resolveMuxBinary(kind: MuxKind, env: NodeJS.ProcessEnv): { command: string; usingTestBinary: boolean } {
  if (kind === 'cmux') {
    const testBinary = safeString(env.OMX_TEST_CMUX_BIN || env.OMX_TEST_MUX_BIN).trim();
    if (testBinary) return { command: testBinary, usingTestBinary: true };
    const configured = safeString(env.OMX_CMUX_BIN || env.OMX_MUX_BIN).trim();
    return { command: configured || 'cmux', usingTestBinary: false };
  }

  const testBinary = safeString(env.OMX_TEST_TMUX_BIN || env.OMX_TEST_MUX_BIN).trim();
  if (testBinary) return { command: testBinary, usingTestBinary: true };
  const configured = safeString(env.OMX_TMUX_BIN || env.OMX_MUX_BIN).trim();
  return { command: configured || 'tmux', usingTestBinary: false };
}

function valueAfterFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index === -1) return '';
  return safeString(args[index + 1]).trim();
}

function trailingFormat(args: string[]): string {
  return safeString(args[args.length - 1]).trim();
}

function tailLinesFromTmuxCaptureArgs(args: string[]): string {
  const start = valueAfterFlag(args, '-S');
  const numeric = start.startsWith('-') ? start.slice(1) : start;
  return /^\d+$/.test(numeric) && numeric !== '0' ? numeric : '80';
}

function cmuxTargetArgs(target: string): string[] {
  return target ? ['--surface', target] : [];
}

/**
 * Translate the tmux argv subset used by OMX prompt injection to cmux CLI argv.
 * Unknown tmux-compatible commands are passed through so cmux can handle any
 * native compatibility aliases it already implements.
 */
export function translateTmuxArgvForCmux(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const command = safeString(args[0]).trim();
  const target = valueAfterFlag(args, '-t') || currentMuxPaneTarget(env);

  if (command === 'send-keys') {
    const literalIndex = args.indexOf('-l');
    if (literalIndex !== -1) {
      return ['send', ...cmuxTargetArgs(target), safeString(args[literalIndex + 1])];
    }

    const key = safeString(args[args.length - 1]).trim();
    const cmuxKey = key === 'C-m' ? 'Enter' : key;
    return ['send-key', ...cmuxTargetArgs(target), cmuxKey];
  }

  if (command === 'capture-pane') {
    return [
      'capture-pane',
      ...cmuxTargetArgs(target),
      '--scrollback',
      '--lines',
      tailLinesFromTmuxCaptureArgs(args),
    ];
  }

  if (command === 'display-message') {
    const format = trailingFormat(args);
    if (format === '#{pane_in_mode}') return ['display-message', '-p', '0'];
    if (
      format === '#{pane_current_command}'
      || format === '#{pane_start_command}'
      || format === '#{pane_current_path}'
    ) {
      return ['display-message', '-p', ''];
    }
    if (format === '#{pane_id}') {
      const pane = target || currentMuxPaneTarget(env);
      return ['display-message', '-p', pane];
    }
    if (format === '#S') {
      const session = currentMuxSessionTarget(env);
      return session
        ? ['display-message', '-p', session]
        : ['current-workspace'];
    }
    return ['display-message', '-p', format];
  }

  if (command === 'list-panes') {
    const workspace = valueAfterFlag(args, '-t') || currentMuxSessionTarget(env);
    return workspace
      ? ['list-pane-surfaces', '--workspace', workspace]
      : ['list-pane-surfaces'];
  }

  return [...args];
}

export function resolveMuxInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): MuxInvocation {
  if (command !== 'tmux') {
    return {
      command,
      args: [...args],
      kind: null,
      translated: false,
      usingTestBinary: false,
      relaxTimeout: false,
    };
  }

  const kind = resolveMuxKind(env);
  const binary = resolveMuxBinary(kind, env);
  const translatedArgs = kind === 'cmux' ? translateTmuxArgvForCmux(args, env) : [...args];
  const relaxTimeout = kind === 'tmux'
    ? env.OMX_TEST_RELAX_TMUX_TIMEOUT === '1'
    : env.OMX_TEST_RELAX_CMUX_TIMEOUT === '1';

  return {
    command: binary.command,
    args: translatedArgs,
    kind,
    translated: kind === 'cmux',
    usingTestBinary: binary.usingTestBinary,
    relaxTimeout,
  };
}
