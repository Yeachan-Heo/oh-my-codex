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
  originalCommand: string;
  originalArgs: string[];
}

export const CMUX_METADATA_UNAVAILABLE_CURRENT_COMMAND = 'sh';
export const CMUX_METADATA_UNAVAILABLE_START_COMMAND = 'cmux metadata unavailable';
export const CMUX_METADATA_UNAVAILABLE_CURRENT_PATH = '__omx_cmux_current_path_unavailable__';
export const CMUX_METADATA_UNAVAILABLE_SESSION = '__omx_cmux_session_unavailable__';
export const CMUX_METADATA_UNAVAILABLE_WINDOW_ID = '__omx_cmux_window_id_unavailable__';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringifyField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => stringifyField(item)).filter(Boolean).join(' ');
  return '';
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

function cmuxWorkspaceArgs(workspace: string): string[] {
  return workspace ? ['--workspace', workspace] : [];
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
    if (format === '#{pane_in_mode}') {
      return ['surface-health', ...cmuxWorkspaceArgs(currentMuxSessionTarget(env))];
    }
    if (
      format === '#{pane_current_command}'
      || format === '#{pane_start_command}'
      || format === '#{pane_current_path}'
    ) {
      return [
        'identify',
        ...cmuxWorkspaceArgs(currentMuxSessionTarget(env)),
        ...cmuxTargetArgs(target || currentMuxPaneTarget(env)),
      ];
    }
    if (format === '#{pane_id}') {
      const pane = target || currentMuxPaneTarget(env);
      return ['display-message', '-p', pane];
    }
    if (format === '#S') {
      if (target || currentMuxPaneTarget(env)) {
        return [
          'identify',
          ...cmuxWorkspaceArgs(currentMuxSessionTarget(env)),
          ...cmuxTargetArgs(target || currentMuxPaneTarget(env)),
        ];
      }
      const session = currentMuxSessionTarget(env);
      return session
        ? ['display-message', '-p', session]
        : ['current-workspace'];
    }
    if (target || currentMuxPaneTarget(env)) {
      return [
        'identify',
        ...cmuxWorkspaceArgs(currentMuxSessionTarget(env)),
        ...cmuxTargetArgs(target || currentMuxPaneTarget(env)),
      ];
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
      originalCommand: command,
      originalArgs: [...args],
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
    originalCommand: command,
    originalArgs: [...args],
  };
}

interface CmuxSurfaceMeta {
  id: string;
  active: boolean;
  currentCommand: string;
  startCommand: string;
  currentPath: string;
  sessionName: string;
  windowId: string;
}

function truthyText(value: unknown): boolean | null {
  const normalized = safeString(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'active', 'focused', 'selected', 'current'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'inactive', 'blurred', 'none'].includes(normalized)) return false;
  return null;
}

function objectString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringifyField(record[key]).trim();
    if (value) return value;
  }
  return '';
}

function objectBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const parsed = truthyText(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractSurfaceObjects(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ['surfaces', 'pane_surfaces', 'paneSurfaces', 'items', 'panes']) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
      }
    }
    const nested = [record];
    for (const key of ['surface', 'caller', 'context', 'terminal', 'pane']) {
      const value = record[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        nested.push(value as Record<string, unknown>);
      }
    }
    return nested;
  }
  return [];
}

function metaFromObject(record: Record<string, unknown>, env: NodeJS.ProcessEnv): CmuxSurfaceMeta | null {
  const id = objectString(record, ['surface', 'surface_id', 'surfaceId', 'surfaceID', 'surface_ref', 'surfaceRef', 'id', 'ref', 'handle']);
  if (!id) return null;
  const active = objectBoolean(record, ['active', 'focused', 'selected', 'current', 'is_active', 'isActive']);
  const currentSurface = currentMuxPaneTarget(env);
  return {
    id,
    active: active ?? (!!currentSurface && id === currentSurface),
    currentCommand: objectString(record, ['pane_current_command', 'current_command', 'currentCommand', 'command', 'process', 'program']),
    startCommand: objectString(record, ['pane_start_command', 'start_command', 'startCommand', 'startCommandLine', 'argv']),
    currentPath: objectString(record, ['pane_current_path', 'current_path', 'currentPath', 'cwd', 'working_directory', 'workingDirectory', 'path']),
    sessionName: objectString(record, ['session_name', 'sessionName', 'session', 'workspace_id', 'workspaceId', 'workspace_ref', 'workspaceRef', 'workspace']),
    windowId: objectString(record, ['window_id', 'windowId', 'window', 'window_ref', 'windowRef']),
  };
}

function keyValueFromLine(line: string, keys: string[]): string {
  for (const key of keys) {
    const match = line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    if (match?.[1]) return match[1];
  }
  return '';
}

function metaFromPlainLine(line: string, env: NodeJS.ProcessEnv): CmuxSurfaceMeta | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tabParts = trimmed.split('\t');
  if (tabParts.length >= 2) {
    const [id = '', activeRaw = '', currentCommand = '', startCommand = '', currentPath = '', windowId = '', sessionName = ''] = tabParts;
    if (!id.trim()) return null;
    const currentSurface = currentMuxPaneTarget(env);
    return {
      id: id.trim(),
      active: truthyText(activeRaw) ?? (!!currentSurface && id.trim() === currentSurface),
      currentCommand: currentCommand.trim(),
      startCommand: startCommand.trim(),
      currentPath: currentPath.trim(),
      sessionName: sessionName.trim(),
      windowId: windowId.trim(),
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    const [meta] = extractSurfaceObjects(parsed)
      .map((record) => metaFromObject(record, env))
      .filter((item): item is CmuxSurfaceMeta => item !== null);
    if (meta) return meta;
  } catch {
    // Plain cmux output; parse below.
  }

  const [id = ''] = trimmed.split(/\s+/, 1);
  if (!id) return null;
  const explicitActive = truthyText(
    keyValueFromLine(trimmed, ['active', 'focused', 'selected', 'current', 'is_active']),
  );
  const currentSurface = currentMuxPaneTarget(env);
  return {
    id,
    active: explicitActive ?? (!!currentSurface && id === currentSurface),
    currentCommand: keyValueFromLine(trimmed, ['pane_current_command', 'current_command', 'command', 'process', 'program']),
    startCommand: keyValueFromLine(trimmed, ['pane_start_command', 'start_command', 'startCommand', 'argv']),
    currentPath: keyValueFromLine(trimmed, ['pane_current_path', 'current_path', 'cwd', 'working_directory', 'path']),
    sessionName: keyValueFromLine(trimmed, ['session_name', 'sessionName', 'session', 'workspace_id', 'workspaceId', 'workspace_ref', 'workspace']),
    windowId: keyValueFromLine(trimmed, ['window_id', 'windowId', 'window', 'window_ref']),
  };
}

function parseCmuxSurfaceRows(stdout: string, env: NodeJS.ProcessEnv): CmuxSurfaceMeta[] {
  const trimmed = safeString(stdout).trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    const rows = extractSurfaceObjects(parsed)
      .map((record) => metaFromObject(record, env))
      .filter((item): item is CmuxSurfaceMeta => item !== null);
    if (rows.length > 0) return finalizeCmuxRows(rows, env);
  } catch {
    // Not a single JSON payload; try line-oriented output.
  }

  return finalizeCmuxRows(
    trimmed
      .split('\n')
      .map((line) => metaFromPlainLine(line, env))
      .filter((item): item is CmuxSurfaceMeta => item !== null),
    env,
  );
}

function finalizeCmuxRows(rows: CmuxSurfaceMeta[], env: NodeJS.ProcessEnv): CmuxSurfaceMeta[] {
  const currentSurface = currentMuxPaneTarget(env);
  const hasActive = rows.some((row) => row.active);
  return rows.map((row, index) => {
    const active = row.active || (!hasActive && (currentSurface ? row.id === currentSurface : rows.length === 1 || index === 0));
    return {
      ...row,
      active,
      currentCommand: row.currentCommand,
      startCommand: row.startCommand,
      currentPath: row.currentPath,
      sessionName: row.sessionName,
      windowId: row.windowId,
    };
  });
}

function renderTmuxFormat(format: string, row: CmuxSurfaceMeta): string {
  return format
    .replaceAll('#{pane_id}', row.id)
    .replaceAll('#{pane_active}', row.active ? '1' : '0')
    .replaceAll('#{pane_current_command}', row.currentCommand)
    .replaceAll('#{pane_start_command}', row.startCommand)
    .replaceAll('#{pane_current_path}', row.currentPath)
    .replaceAll('#{window_id}', row.windowId)
    .replaceAll('#S', row.sessionName)
    .replaceAll('#{pane_pid}', '');
}

function normalizeCmuxListPanesStdout(invocation: MuxInvocation, stdout: string, env: NodeJS.ProcessEnv): string {
  const format = valueAfterFlag(invocation.originalArgs, '-F');
  if (!format) return stdout;
  const rows = parseCmuxSurfaceRows(stdout, env);
  return rows.map((row) => renderTmuxFormat(format, row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

function cmuxHealthBodiesForTarget(lines: string[], target: string, env: NodeJS.ProcessEnv): string[] {
  if (!target) return lines;

  const bodies: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      for (const record of extractSurfaceObjects(parsed)) {
        const meta = metaFromObject(record, env);
        if (meta?.id === target) bodies.push(JSON.stringify(record));
      }
      continue;
    } catch {
      // Plain cmux health output; parse below.
    }

    const meta = metaFromPlainLine(line, env);
    if (meta?.id === target) bodies.push(line);
  }

  return bodies;
}

function normalizeCmuxPaneInModeStdout(invocation: MuxInvocation, stdout: string, env: NodeJS.ProcessEnv): string {
  const target = valueAfterFlag(invocation.originalArgs, '-t') || currentMuxPaneTarget(env);
  const lines = safeString(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  const inspected = cmuxHealthBodiesForTarget(lines, target, env);
  const body = inspected.join('\n').toLowerCase();
  if (/(?:scroll|copy|mode|in_mode)[^=\n:]*[=:]\s*(?:1|true|active|copy|scroll)/i.test(body)) return '1\n';
  if (/(?:scroll|copy|mode|in_mode)[^=\n:]*[=:]\s*(?:0|false|inactive|none)/i.test(body)) return '0\n';
  if (/\b(copy-mode|scrollback-active|scroll_active|copy_active)\b/i.test(body)) return '1\n';
  return '0\n';
}

function selectCmuxTargetMeta(rows: CmuxSurfaceMeta[], target: string): CmuxSurfaceMeta | null {
  if (target) {
    const exact = rows.find((row) => row.id === target);
    if (exact) return exact;
  }
  return rows.find((row) => row.active) || rows[0] || null;
}

function normalizeCmuxDisplayMessageStdout(invocation: MuxInvocation, stdout: string, env: NodeJS.ProcessEnv): string {
  const format = trailingFormat(invocation.originalArgs);
  const target = valueAfterFlag(invocation.originalArgs, '-t') || currentMuxPaneTarget(env);
  const row = selectCmuxTargetMeta(parseCmuxSurfaceRows(stdout, env), target);

  if (format === '#{pane_current_command}') {
    return `${row?.currentCommand || CMUX_METADATA_UNAVAILABLE_CURRENT_COMMAND}\n`;
  }
  if (format === '#{pane_start_command}') {
    return `${row?.startCommand || CMUX_METADATA_UNAVAILABLE_START_COMMAND}\n`;
  }
  if (format === '#{pane_current_path}') {
    return `${row?.currentPath || CMUX_METADATA_UNAVAILABLE_CURRENT_PATH}\n`;
  }
  if (format === '#S') {
    return `${row?.sessionName || CMUX_METADATA_UNAVAILABLE_SESSION}\n`;
  }
  if (format === '#{window_id}') {
    return `${row?.windowId || CMUX_METADATA_UNAVAILABLE_WINDOW_ID}\n`;
  }

  return stdout;
}

export function normalizeMuxStdout(
  invocation: MuxInvocation,
  stdout: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (invocation.kind !== 'cmux' || !invocation.translated) return stdout;

  const originalCommand = safeString(invocation.originalArgs[0]).trim();
  if (originalCommand === 'list-panes') {
    return normalizeCmuxListPanesStdout(invocation, stdout, env);
  }

  if (originalCommand === 'display-message') {
    const format = trailingFormat(invocation.originalArgs);
    if (format === '#{pane_in_mode}') return normalizeCmuxPaneInModeStdout(invocation, stdout, env);
    if (
      format === '#{pane_current_command}'
      || format === '#{pane_start_command}'
      || format === '#{pane_current_path}'
      || format === '#{window_id}'
      || (format === '#S' && invocation.args[0] === 'identify')
    ) {
      return normalizeCmuxDisplayMessageStdout(invocation, stdout, env);
    }
  }

  return stdout;
}
