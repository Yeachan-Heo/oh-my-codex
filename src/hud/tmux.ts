import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'node:path';
import {
  HUD_RESIZE_RECONCILE_DELAY_SECONDS,
  HUD_TMUX_HEIGHT_LINES,
  HUD_TMUX_MAX_HEIGHT_LINES,
  HUD_WATCH_REPAIR_TIMEOUT_MS,
} from './constants.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

const HUD_HOOK_NODE_STARTUP_GRACE_MS = 5_000;

export interface TmuxPaneSnapshot {
  paneId: string;
  sessionId?: string;
  windowId?: string;
  currentCommand: string;
  startCommand: string;
  panePid?: string;
  paneDead?: boolean;
  currentPath?: string;
  paneLeft?: number;
  paneTop?: number;
  paneWidth?: number;
  paneHeight?: number;
  paneBottom?: number;
  windowWidth?: number;
  windowHeight?: number;
}

/** Leave at least half the leader/HUD space for the leader, excluding the border. */
export function boundHudHeight(
  desiredHeight: number,
  panes: TmuxPaneSnapshot[],
  leaderPaneId?: string,
  hudPaneId?: string,
): number {
  const leader = panes.find(pane => pane.paneId === leaderPaneId);
  const hud = panes.find(pane => pane.paneId === hudPaneId);
  const windowHeight = leader?.windowHeight ?? hud?.windowHeight;
  const leaderHeight = leader?.paneHeight;
  const budgets: number[] = [];
  if (typeof windowHeight === 'number' && Number.isFinite(windowHeight) && windowHeight > 0) budgets.push(windowHeight - 1);
  if (typeof leaderHeight === 'number' && Number.isFinite(leaderHeight) && leaderHeight > 0) {
    const hudHeight = hud?.paneHeight;
    budgets.push(leaderHeight + (typeof hudHeight === 'number' && Number.isFinite(hudHeight) && hudHeight > 0 ? hudHeight : -1));
  }
  // Unknown geometry must not permit an unbounded roster expansion.
  const limit = budgets.length ? Math.max(1, Math.floor(Math.min(...budgets) / 2)) : HUD_TMUX_MAX_HEIGHT_LINES;
  return Math.min(desiredHeight, limit);
}

export const OMX_TMUX_HUD_LEADER_PANE_ENV = 'OMX_TMUX_HUD_LEADER_PANE';
const OMX_TMUX_HUD_OWNER_ENV = 'OMX_TMUX_HUD_OWNER';
export const TMUX_PANE_FIELD_SEPARATOR = '\x1f';
export const TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE = '\\037';

export interface HudPaneOwner {
  sessionId?: string;
  sessionIds?: string[];
  leaderPaneId?: string;
}

export interface HudTmuxMutationAuthority {
  leaderPaneId: string;
  leaderPanePid: string;
  ownerId: string;
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
const PSMUX_PANE_ID_MAX = 0xffff_ffffn;
const PSMUX_PANE_ID_MAX_DIGITS = PSMUX_PANE_ID_MAX.toString().length;

export function parseCanonicalTmuxPaneId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^%(0|[1-9]\d*)$/.exec(value);
  if (!match || match[1].length > PSMUX_PANE_ID_MAX_DIGITS) return null;
  try {
    return BigInt(match[1]) <= PSMUX_PANE_ID_MAX ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parses tmux output used as authority. Authority frames are deliberately
 * transport-strict: a nonempty body followed by exactly one LF or CRLF.
 */
export function parseExactTmuxAuthorityLines(output: string): string[] | null {
  if (typeof output !== 'string' || output.length < 2) return null;
  const terminator = output.endsWith('\r\n') ? '\r\n' : output.endsWith('\n') ? '\n' : null;
  if (!terminator) return null;
  const body = output.slice(0, -terminator.length);
  if (body === '' || body.endsWith('\n') || body.includes('\r')) return null;
  return body.split('\n');
}

/** Parses one exact, nonempty tmux authority scalar. */
export function parseExactTmuxAuthorityScalar(output: string): string | null {
  const lines = parseExactTmuxAuthorityLines(output);
  return lines?.length === 1 && lines[0] !== '' ? lines[0]! : null;
}

/**
 * Tolerant pane parsing is for display metadata only. Callers using its output
 * as authority MUST first validate framing with parseExactTmuxAuthorityLines.
 */

function canonicalizePaneSnapshotBatch(panes: readonly TmuxPaneSnapshot[]): TmuxPaneSnapshot[] | null {
  const paneIds = new Set<string>();
  const canonicalPanes: TmuxPaneSnapshot[] = [];
  for (const pane of panes) {
    const paneId = parseCanonicalTmuxPaneId(pane.paneId);
    if (!paneId || paneIds.has(paneId)) return null;
    paneIds.add(paneId);
    canonicalPanes.push({ ...pane, paneId });
  }
  return canonicalPanes;
}

function parseCanonicalPaneIdSnapshot(output: string): Set<string> | null {
  const lines = parseExactTmuxAuthorityLines(output);
  if (!lines) return null;

  const paneIds = new Set<string>();
  for (const line of lines) {
    const paneId = parseCanonicalTmuxPaneId(line);
    if (!paneId || paneIds.has(paneId)) return null;
    paneIds.add(paneId);
  }
  return paneIds;
}

export interface RegisterHudResizeHookOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

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

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 4_294_967_295 ? parsed : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function parseTmuxPaneSnapshot(
  output: string,
  authoritativePaneIds?: ReadonlySet<string>,
): TmuxPaneSnapshot[] {
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return [];

  const panes: TmuxPaneSnapshot[] = [];
  for (const line of lines) {
    if (line === '') return [];
    const fieldSeparator = line.includes(TMUX_PANE_FIELD_SEPARATOR)
      ? TMUX_PANE_FIELD_SEPARATOR
      : line.includes(TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE)
        ? TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE
        : '\t';
    const parts = line.split(fieldSeparator);
    const [rawPaneId = '', currentCommand = ''] = parts;
    const paneId = parseCanonicalTmuxPaneId(rawPaneId);
    if (!paneId) return [];
    const hasGeometryFields = parts.length >= 9;
    const paneLeft = parseNonNegativeInteger(parts[2]);
    const paneTop = parseNonNegativeInteger(parts[3]);
    const paneWidth = parsePositiveInteger(parts[4]);
    const paneHeight = parsePositiveInteger(parts[5]);
    const paneBottom = parseNonNegativeInteger(parts[6]);
    const windowWidth = parsePositiveInteger(parts[7]);
    const windowHeight = parsePositiveInteger(parts[8]);
    const hasGeometry = (
      paneLeft !== null
      && paneTop !== null
      && paneWidth !== null
      && paneHeight !== null
      && paneBottom !== null
      && windowWidth !== null
      && windowHeight !== null
    );
    if (hasGeometryFields && !hasGeometry) return [];
    const hasAuthorityFields = hasGeometry
      && isTmuxSessionId(parts[9] ?? '')
      && isTmuxWindowId(parts[10] ?? '')
      && /^(?:0|1)$/.test(parts[11] ?? '')
      && parsePositiveInteger(parts[12]) !== null;
    if (hasGeometry && fieldSeparator === TMUX_PANE_FIELD_SEPARATOR && parts.length >= 15 && !hasAuthorityFields) return [];
    const payloadParts = hasGeometry ? parts.slice(hasAuthorityFields ? 13 : 9) : parts.slice(2);
    const hasTrailingIncarnationFields = hasGeometry
      && payloadParts.length >= 4
      && /^(?:0|1)$/.test(payloadParts.at(-2) ?? '')
      && parsePositiveInteger(payloadParts.at(-1)) !== null;
    const hasIncarnationFields = hasAuthorityFields || hasTrailingIncarnationFields;
    const incarnationParts = hasAuthorityFields
      ? parts.slice(11, 13)
      : hasTrailingIncarnationFields ? payloadParts.slice(-2) : [];
    const commandParts = hasTrailingIncarnationFields ? payloadParts.slice(0, -2) : payloadParts;
    const hasCurrentPathColumn = commandParts.length >= 2;
    const currentPath = hasCurrentPathColumn ? (commandParts.at(-1) ?? '') : '';
    const startCommandParts = hasCurrentPathColumn ? commandParts.slice(0, -1) : commandParts;
    const trimmedCurrentPath = currentPath.trim();
    panes.push({
      paneId,
      ...(hasAuthorityFields ? { sessionId: parts[9]!, windowId: parts[10]! } : {}),
      currentCommand: currentCommand.trim(),
      startCommand: startCommandParts.join('\t').trim(),
      ...(trimmedCurrentPath ? { currentPath: trimmedCurrentPath } : {}),
      ...(hasIncarnationFields ? { paneDead: incarnationParts[0] === '1', panePid: incarnationParts[1]! } : {}),
      ...(hasGeometry
        ? {
            paneLeft,
            paneTop,
            paneWidth,
            paneHeight,
            paneBottom,
            windowWidth,
            windowHeight,
          }
        : {}),
    });
  }

  const canonicalPanes = canonicalizePaneSnapshotBatch(panes);
  if (!canonicalPanes) return [];
  if (
    authoritativePaneIds
    && (
      canonicalPanes.length !== authoritativePaneIds.size
      || canonicalPanes.some((pane) => !authoritativePaneIds.has(pane.paneId))
    )
  ) return [];
  return canonicalPanes;
}

export function isHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`.toLowerCase();
  return (
    /\bhud\b/.test(command)
    && /--watch\b/.test(command)
    && (/\bomx(?:\.js)?\b/.test(command) || /\bnode\b/.test(command))
  );
}


const HUD_OWNER_ENV_KEYS = [
  OMX_TMUX_HUD_OWNER_ENV,
  'OMX_SESSION_ID',
  OMX_TMUX_HUD_LEADER_PANE_ENV,
] as const;

function isHudOwnerEnvKey(key: string): boolean {
  return HUD_OWNER_ENV_KEYS.some((ownerKey) => ownerKey === key);
}

function isPowerShellHudOwnerEnvKey(key: string): boolean {
  return HUD_OWNER_ENV_KEYS.some((ownerKey) => ownerKey === key.toUpperCase());
}

interface PosixHudEnvAssignments {
  attempted: boolean;
  valid: boolean;
  values: Map<string, string[]>;
}

function lexPosixWords(command: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '')) index += 1;
    if (index >= command.length) break;
    if (command[index] === '#') break;

    let word = '';
    let quoted = false;
    while (index < command.length && !/\s/.test(command[index] ?? '')) {
      const char = command[index]!;
      if (';|&()<>`'.includes(char) || char === '\n' || char === '\r') return null;
      if (char === '\\') {
        index += 1;
        if (index >= command.length) return null;
        word += command[index]!;
        index += 1;
        continue;
      }
      if (char === "'") {
        quoted = true;
        index += 1;
        while (index < command.length && command[index] !== "'") {
          word += command[index]!;
          index += 1;
        }
        if (index >= command.length) return null;
        index += 1;
        continue;
      }
      if (char === '"') {
        quoted = true;
        index += 1;
        while (index < command.length && command[index] !== '"') {
          if (command[index] === '\\') {
            index += 1;
            if (index >= command.length) return null;
          }
          word += command[index]!;
          index += 1;
        }
        if (index >= command.length) return null;
        index += 1;
        continue;
      }
      word += char;
      index += 1;
    }
    if (!word && !quoted) return null;
    words.push(word);
  }
  return words;
}

function normalizeTmuxPaneStartCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length < 2 || trimmed[0] !== '"') return command;

  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      const body = trimmed.slice(1, index).replace(/\\(["\\])/g, '$1');
      return `${body}${trimmed.slice(index + 1)}`.trim();
    }
  }

  return command;
}

function parsePosixHudEnvAssignments(command: string): PosixHudEnvAssignments {
  const values = new Map<string, string[]>();
  const normalizedCommand = normalizeTmuxPaneStartCommand(command);
  const attempted = HUD_OWNER_ENV_KEYS.some((key) => normalizedCommand.includes(key));
  const words = lexPosixWords(normalizedCommand);
  if (!words) return { attempted, valid: false, values };

  const inspect = (tokens: string[]): boolean => {
    let commandStarted = false;
    let acceptsEnvAssignments = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
      if (assignment && isHudOwnerEnvKey(assignment[1]!) && (!commandStarted || acceptsEnvAssignments)) {
        const key = assignment[1]!;
        const existing = values.get(key) ?? [];
        existing.push(assignment[2]!);
        values.set(key, existing);
        continue;
      }
      if (assignment && (!commandStarted || acceptsEnvAssignments)) continue;
      if (token === '-c' && index + 1 < tokens.length) {
        const nested = lexPosixWords(tokens[index + 1]!);
        if (!nested || !inspect(nested)) return false;
        commandStarted = true;
        continue;
      }
      if (token === 'exec' && !commandStarted) continue;
      if (!commandStarted && token === 'env') {
        commandStarted = true;
        acceptsEnvAssignments = true;
        continue;
      }
      commandStarted = true;
      acceptsEnvAssignments = false;
    }
    return true;
  };
  return { attempted, valid: inspect(words), values };
}

function parseShellEnvAssignments(command: string, key: string): string[] {
  const parsed = parsePosixHudEnvAssignments(command);
  return parsed.valid ? (parsed.values.get(key) ?? []) : [];
}

function parseShellEnvAssignment(command: string, key: string): string | undefined {
  const values = parseShellEnvAssignments(command, key);
  return values.length === 1 && values[0] !== '' ? values[0] : undefined;
}


function containsPowerShellHudOwnerReferenceOutsideQuotes(command: string): boolean {
  let quote: 'single' | 'double' | null = null;
  let blockComment = false;
  let lineComment = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (blockComment) {
      if (char === '#' && next === '>') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (quote === 'single') {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (char === '`') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === '<' && next === '#') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '#') {
      lineComment = true;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === '`') {
      index += 1;
      continue;
    }
    if (command.slice(index, index + 5).toLowerCase() === '$env:') {
      const match = /^\$env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(command.slice(index));
      if (match && isPowerShellHudOwnerEnvKey(match[1]!)) return true;
    }
  }
  return false;
}

interface PowerShellHudEnvPrefix {
  present: boolean;
  valid: boolean;
  values: Map<string, string[]>;
  remainder: string;
}

function unwrapKnownPowerShellCommand(command: string): { command: string; remainder: string } | null {
  const match = /^\s*powershell(?:\.exe)?\s+-NoLogo\s+-NoExit\s+-Command\s+'((?:''|[^'])*)'(.*)$/i.exec(command);
  if (!match) return null;
  return { command: match[1]!.replace(/''/g, "'"), remainder: match[2]! };
}

function parsePowerShellHudEnvPrefix(command: string): PowerShellHudEnvPrefix {
  const unwrapped = unwrapKnownPowerShellCommand(command);
  const source = unwrapped?.command ?? command;
  const present = containsPowerShellHudOwnerReferenceOutsideQuotes(source);
  const values = new Map<string, string[]>();
  if (!present) return { present: false, valid: false, values, remainder: command };

  const prefixMatch = /^\s*((?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*'(?:''|[^'])*'\s*;\s*)+)&(?:\s|$)/i.exec(source);
  if (!prefixMatch) return { present: true, valid: false, values, remainder: command };
  const assignmentPattern = /\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'((?:''|[^'])*)'\s*;/gi;
  for (const match of prefixMatch[1]!.matchAll(assignmentPattern)) {
    const key = match[1]!.toUpperCase();
    const existing = values.get(key) ?? [];
    existing.push(match[2]!.replace(/''/g, "'"));
    values.set(key, existing);
  }
  const remainder = `${source.slice(prefixMatch[0].length)}${unwrapped?.remainder ?? ''}`;
  return { present: true, valid: true, values, remainder };
}

function hasHudOwnerMetadataAttempt(command: string): boolean {
  return parsePowerShellHudEnvPrefix(command).present || parsePosixHudEnvAssignments(command).attempted;
}

function isInvalidHudOwnerValue(key: string, value: string): boolean {
  return (key === OMX_TMUX_HUD_OWNER_ENV && value !== '1')
    || (key !== OMX_TMUX_HUD_LEADER_PANE_ENV && value === '');
}

function parseHudEnvAssignment(command: string, key: string): string | undefined {
  const posix = parsePosixHudEnvAssignments(command);
  const powerShellPrefix = parsePowerShellHudEnvPrefix(command);
  if (powerShellPrefix.present) return powerShellPrefix.valid ? (powerShellPrefix.values.get(key.toUpperCase())?.length === 1 ? powerShellPrefix.values.get(key.toUpperCase())![0] : undefined) : undefined;
  return posix.valid ? parseShellEnvAssignment(command, key) : undefined;
}

function hasAmbiguousHudOwnerMetadata(command: string): boolean {
  const posix = parsePosixHudEnvAssignments(command);
  const powerShellPrefix = parsePowerShellHudEnvPrefix(command);
  if (powerShellPrefix.present) {
    if (
      !powerShellPrefix.valid
      || posix.values.size > 0
      || containsPowerShellHudOwnerReferenceOutsideQuotes(powerShellPrefix.remainder)
      || parsePosixHudEnvAssignments(powerShellPrefix.remainder).attempted
    ) return true;
    return HUD_OWNER_ENV_KEYS.some((key) => {
      const values = powerShellPrefix.values.get(key) ?? [];
      return values.length > 1 || (values.length === 1 && isInvalidHudOwnerValue(key, values[0]!));
    });
  }
  if (posix.attempted && (!posix.valid || posix.values.size === 0)) return true;
  return HUD_OWNER_ENV_KEYS.some((key) => {
    const values = posix.values.get(key) ?? [];
    return values.length > 1 || (values.length === 1 && isInvalidHudOwnerValue(key, values[0]!));
  });
}

export function readHudPaneOwner(pane: TmuxPaneSnapshot): HudPaneOwner {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  const rawLeaderPaneId = parseHudEnvAssignment(command, OMX_TMUX_HUD_LEADER_PANE_ENV);
  if (
    hasAmbiguousHudOwnerMetadata(command)
    || (rawLeaderPaneId !== undefined && !parseCanonicalTmuxPaneId(rawLeaderPaneId))
  ) {
    return { sessionId: undefined, leaderPaneId: undefined };
  }
  return {
    sessionId: parseHudEnvAssignment(command, 'OMX_SESSION_ID'),
    leaderPaneId: rawLeaderPaneId ? parseCanonicalTmuxPaneId(rawLeaderPaneId) ?? undefined : undefined,
  };
}

function hasHudPaneOwnerMetadata(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  return hasHudOwnerMetadataAttempt(command) && !hasAmbiguousHudOwnerMetadata(command);
}

export function hasValidHudOwnerMarker(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  if (hasAmbiguousHudOwnerMetadata(command)) return false;
  return parseHudEnvAssignment(command, OMX_TMUX_HUD_OWNER_ENV) === '1';
}

function hasOmxCliToken(command: string): boolean {
  return /(?:^|[\s'"])(?:[^\s'"]*\/)?omx(?:\.js)?(?=$|[\s'"])/.test(command);
}

function hasPowerShellEnvironmentAssignmentPrefix(command: string): boolean {
  return /^\s*(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'(?:''|[^'])*'|"(?:`.|[^"])*")\s*;\s*)+&(?:\s|$)/i.test(command);
}

function isLegacyFocusedHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  // Migration-only heuristic for prompt-submit auto-HUD reconciliation: older
  // focused auto-HUD panes lacked owner metadata, so keep this deliberately
  // narrower than general HUD ownership/reaping.
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  if (
    !isHudWatchPane(pane)
    || hasHudOwnerMetadataAttempt(command)
    || hasPowerShellEnvironmentAssignmentPrefix(command)
  ) return false;
  return hasOmxCliToken(command)
    && !/(?:^|[\s'"])--tmux(?:[\s'"]|$)/.test(command)
    && /(?:^|[\s'"])--preset=focused(?:[\s'"]|$)/.test(command);
}

export function findLegacyFocusedHudWatchPaneIds(
  panes: TmuxPaneSnapshot[],
  currentPaneId?: string,
): string[] {
  const canonicalPanes = canonicalizePaneSnapshotBatch(panes);
  const canonicalCurrentPaneId = currentPaneId ? parseCanonicalTmuxPaneId(currentPaneId) : null;
  if (!canonicalPanes || (currentPaneId && !canonicalCurrentPaneId)) return [];
  return canonicalPanes
    .filter((pane) => pane.paneId !== canonicalCurrentPaneId)
    .filter((pane) => isLegacyFocusedHudWatchPane(pane))
    .map((pane) => pane.paneId);
}

export function hudPaneMatchesOwner(pane: TmuxPaneSnapshot, owner: HudPaneOwner = {}): boolean {
  if (!parseCanonicalTmuxPaneId(pane.paneId) || !isHudWatchPane(pane)) return false;
  const wantedSessionIds = [
    typeof owner.sessionId === 'string' ? owner.sessionId.trim() : '',
    ...(Array.isArray(owner.sessionIds) ? owner.sessionIds : []),
  ]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId, index, sessionIds) => sessionId !== '' && sessionIds.indexOf(sessionId) === index);
  const rawWantedLeaderPaneId = typeof owner.leaderPaneId === 'string' ? owner.leaderPaneId : '';
  const wantedLeaderPaneId = rawWantedLeaderPaneId ? parseCanonicalTmuxPaneId(rawWantedLeaderPaneId) : null;
  if (rawWantedLeaderPaneId && !wantedLeaderPaneId) return false;
  const wantsSession = wantedSessionIds.length > 0;
  const wantsLeaderPane = wantedLeaderPaneId !== null;
  if (!wantsSession && !wantsLeaderPane) return true;
  if (hasAmbiguousHudOwnerMetadata(`${pane.startCommand} ${pane.currentCommand}`)) return false;

  const paneOwner = readHudPaneOwner(pane);
  const sessionMatches = wantsSession && wantedSessionIds.includes(paneOwner.sessionId ?? '');
  const leaderPaneMatches = wantsLeaderPane && paneOwner.leaderPaneId === wantedLeaderPaneId;
  const hasLeaderTag = paneOwner.leaderPaneId !== undefined && paneOwner.leaderPaneId !== '';

  if (wantsSession && wantsLeaderPane) {
    if (hasLeaderTag) return sessionMatches && leaderPaneMatches;
    return sessionMatches;
  }
  if (wantsSession) return sessionMatches;
  return leaderPaneMatches;
}


export function findHudWatchPaneIds(
  panes: TmuxPaneSnapshot[],
  currentPaneId?: string,
  owner: HudPaneOwner = {},
): string[] {
  const canonicalPanes = canonicalizePaneSnapshotBatch(panes);
  const canonicalCurrentPaneId = currentPaneId ? parseCanonicalTmuxPaneId(currentPaneId) : null;
  if (!canonicalPanes || (currentPaneId && !canonicalCurrentPaneId)) return [];
  return canonicalPanes
    .filter((pane) => pane.paneId !== canonicalCurrentPaneId)
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
  // owner-tagged panes whose canonical leader is gone.
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  const rawLeaderPaneId = parseHudEnvAssignment(command, OMX_TMUX_HUD_LEADER_PANE_ENV);
  if (
    !hasHudPaneOwnerMetadata(pane)
    || !hasDeletedTmuxPaneMarker(pane.currentPath)
    || hasAmbiguousHudOwnerMetadata(command)
    || (rawLeaderPaneId !== undefined && !parseCanonicalTmuxPaneId(rawLeaderPaneId))
  ) return false;
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
  const canonicalPanes = canonicalizePaneSnapshotBatch(panes);
  if (!canonicalPanes) return { reaped: [], preserved: panes.map((pane) => pane.paneId) };
  const livePaneIds = new Set(canonicalPanes.map((pane) => pane.paneId));
  const isLivePane = opts.isLivePane ?? ((paneId: string) => livePaneIds.has(paneId));
  const killPane = opts.killPane ?? ((paneId: string) => killTmuxPane(paneId));
  const reaped: string[] = [];
  const preserved: string[] = [];

  for (const pane of canonicalPanes) {
    if (!isHudWatchPane(pane)) continue;

    if (shouldReapDeletedCwdHudPane(pane, isLivePane) && killPane(pane.paneId)) {
      reaped.push(pane.paneId);
      continue;
    }

    // Never let HUD-looking command text authorize a destructive pane mutation.
    // Only metadata accepted by the strict owner parsers may do so.
    if (!hasHudPaneOwnerMetadata(pane)) {
      preserved.push(pane.paneId);
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
  const lines = rawOutput.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length === 1 ? parseCanonicalTmuxPaneId(lines[0]) : null;
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


export function buildHudResizeHookName(sessionId: string, windowId: string, leaderPaneId: string): string {
  return [
    'omx_hud_resize',
    normalizeTmuxHookToken(sessionId),
    normalizeTmuxHookToken(windowId),
    normalizeTmuxHookToken(leaderPaneId),
  ].join('_');
}


export function buildHudResizeHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-resized[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export function buildHudLayoutHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `window-layout-changed[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export function buildHudSplitHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `after-split-window[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

function hudHookIdentityOption(hookSlot: string): string {
  const match = /^(client-resized|window-layout-changed|after-split-window)\[([0-9]+)\]$/.exec(hookSlot);
  if (!match) throw new Error('invalid_tmux_hook_slot');
  return `@omx_hook_identity_${match[1].replaceAll('-', '_')}_${match[2]}`;
}

function hudHookIdentityToken(hookName: string, hookSlot: string): string {
  let hash = 2166136261;
  for (const char of `${hookName}:${hookSlot}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `omx-${(hash >>> 0).toString(16)}`;
}

function hudHookExpectedCommandOption(hookSlot: string): string {
  return hudHookIdentityOption(hookSlot).replace('@omx_hook_identity_', '@omx_hook_expected_');
}

function hudHookConfigurationOption(hookSlot: string): string {
  return hudHookIdentityOption(hookSlot).replace('@omx_hook_identity_', '@omx_hook_configuration_');
}

function canonicalHudHookCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
    throw error;
  }
}

function hudHookConfigurationToken(context: HudResizeHookContext, hookSlot: string, heightLines: number, cwd: string): string {
  return createHash('sha256').update(JSON.stringify([
    'hud-hook-v2', context.sessionId, context.windowId, context.leaderPaneId, context.leaderPanePid,
    context.hudPaneId, context.hudPanePid, context.ownerId ?? '', hookSlot, String(heightLines), canonicalHudHookCwd(cwd),
  ])).digest('hex');
}

function buildHudHookRegistrationSuffix(
  context: HudResizeHookContext,
  hookSlot: string,
  heightLines: number,
  cwd: string,
): string[] {
  const formatTarget = hookSlot.startsWith('window-layout-changed[') ? context.windowId : context.sessionId;
  return [
    ';', 'set-option', '-t', context.sessionId,
    hudHookIdentityOption(hookSlot), hudHookIdentityToken(context.hookName, hookSlot),
    ';', 'set-option', '-F', '-t', formatTarget,
    hudHookExpectedCommandOption(hookSlot), `#{${hookSlot}}`,
    ';', 'set-option', '-t', context.sessionId,
    hudHookConfigurationOption(hookSlot), hudHookConfigurationToken(context, hookSlot, heightLines, cwd),
  ];
}

function buildHudHookUnsetCommand(context: HudResizeHookContext, hookSlot: string): string {
  const unsetHook = hookSlot.startsWith('window-layout-changed[')
    ? `set-hook -u -w -t ${context.windowId} ${hookSlot}`
    : `set-hook -u -t ${context.sessionId} ${hookSlot}`;
  return `${unsetHook} ; set-option -u -t ${context.sessionId} ${hudHookExpectedCommandOption(hookSlot)} ; set-option -u -t ${context.sessionId} ${hudHookConfigurationOption(hookSlot)}`;
}

function buildGuardedHudHookUnregisterArgs(
  context: HudResizeHookContext,
  hookSlot: string,
  marker: string,
  authority?: HudTmuxMutationAuthority,
): string[] {
  const identityOption = hudHookIdentityOption(hookSlot);
  const identityCondition = `#{==:#{${identityOption}},${hudHookIdentityToken(context.hookName, hookSlot)}}`;
  const rejected = `display-message -p __omx_hud_unregister_failed_${marker}`;
  const absentOrForeign = [
    'if-shell', '-F', '-t', context.leaderPaneId,
    `#{==:#{${identityOption}},}`,
    `display-message -p ${marker}`,
    rejected,
  ].map(shellEscapeSingle).join(' ');
  const ownedOrAbsent = [
    'if-shell', '-F', '-t', context.leaderPaneId,
    identityCondition,
    `${buildHudHookUnsetCommand(context, hookSlot)} ; set-option -u -t ${context.sessionId} ${identityOption} ; display-message -p ${marker}`,
    absentOrForeign,
  ].map(shellEscapeSingle).join(' ');
  return [
    'if-shell', '-F', '-t', context.leaderPaneId,
    authority
      ? buildHudMutationAuthorityCondition(authority)
      : combineTmuxConditions(`#{==:#{pane_id},${context.leaderPaneId}}`, '#{==:#{pane_dead},0}'),
    ownedOrAbsent,
    rejected,
  ];
}

export interface HudResizeHookContext {
  sessionId: string;
  windowId: string;
  ownerId?: string;
  leaderPaneId: string;
  leaderPanePid: string;
  hudPaneId: string;
  hudPanePid: string;
  hookName: string;
  hookSlot: string;
  layoutHookSlot: string;
  splitHookSlot: string;
}

export type HudHookHealth = 'healthy' | 'repair_needed' | 'unknown' | 'owner_mismatch';

export function readHudLeaderOwnerIdentity(
  leaderPaneId: string,
  expectedOwnerId: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): 'current' | 'mismatch' | 'unknown' {
  const paneId = parseCanonicalTmuxPaneId(leaderPaneId);
  if (!paneId || !expectedOwnerId.trim()) return 'unknown';
  try {
    const output = parseExactTmuxAuthorityScalar(execTmuxSync([
      'display-message', '-p', '-t', paneId, '#{pane_id}|#{pane_dead}|#{@omx_instance_id}',
    ]));
    if (!output) return 'unknown';
    const fields = output.split('|');
    if (fields.length !== 3 || fields[0] !== paneId || fields[1] !== '0') return 'unknown';
    if (!fields[2] || !/^\S+$/.test(fields[2])) return 'unknown';
    return fields[2] === expectedOwnerId ? 'current' : 'mismatch';
  } catch {
    return 'unknown';
  }
}

export interface ReadHudHookHealthInput extends RegisterHudResizeHookOptions {
  sessionId: string;
  windowId: string;
  leaderPaneId: string;
  leaderPanePid: string;
  hudPaneId: string;
  hudPanePid: string;
  heightLines: number;
}

function readHudResizeHookPaneIncarnations(
  hudPaneId: string,
  leaderPaneId: string,
  execTmuxSync: TmuxExecSync,
): { leaderPanePid: string; hudPanePid: string } | null {
  try {
    const lines = parseExactTmuxAuthorityLines(execTmuxSync(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']));
    if (!lines) return null;
    const seen = new Set<string>();
    let leaderPanePid: string | null = null;
    let hudPanePid: string | null = null;
    for (const line of lines) {
      const match = /^(%\S+) ([01]) ([1-9][0-9]*)$/.exec(line);
      const paneId = match ? parseCanonicalTmuxPaneId(match[1]) : null;
      if (!match || !paneId || paneId !== match[1] || seen.has(paneId)) return null;
      seen.add(paneId);
      if (match[2] === '1') continue;
      if (paneId === leaderPaneId) leaderPanePid = match[3]!;
      if (paneId === hudPaneId) hudPanePid = match[3]!;
    }
    return leaderPanePid && hudPanePid ? { leaderPanePid, hudPanePid } : null;
  } catch {
    return null;
  }
}

export function parseHudResizeHookContext(
  output: string,
  leaderPaneId: string,
  hudPaneId: string = leaderPaneId,
  incarnations: { leaderPanePid: string; hudPanePid: string } = { leaderPanePid: '1', hudPanePid: '1' },
): HudResizeHookContext | null {
  const line = parseExactTmuxAuthorityScalar(output);
  if (line === null) return null;
  const parts = line.includes('|') ? line.split('|') : line.split('\t');
  if (parts.length !== 2 || parts.some((part) => part.trim() !== part || part === '')) return null;
  const [sessionId = '', windowId = ''] = parts;
  const normalizedLeaderPaneId = parseCanonicalTmuxPaneId(leaderPaneId);
  const normalizedHudPaneId = parseCanonicalTmuxPaneId(hudPaneId);
  if (!isTmuxSessionId(sessionId) || !isTmuxWindowId(windowId) || !normalizedLeaderPaneId || !normalizedHudPaneId) return null;
  const hookName = buildHudResizeHookName(sessionId, windowId, normalizedLeaderPaneId);
  return {
    sessionId,
    windowId,
    leaderPaneId: normalizedLeaderPaneId,
    leaderPanePid: incarnations.leaderPanePid,
    hudPaneId: normalizedHudPaneId,
    hudPanePid: incarnations.hudPanePid,
    hookName,
    hookSlot: buildHudResizeHookSlot(hookName),
    layoutHookSlot: buildHudLayoutHookSlot(hookName),
    splitHookSlot: buildHudSplitHookSlot(hookName),
  };
}

export function readHudResizeHookContext(
  hudPaneId: string | undefined,
  leaderPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): HudResizeHookContext | null {
  const canonicalLeaderPaneId = parseCanonicalTmuxPaneId(leaderPaneId);
  const canonicalHudPaneId = parseCanonicalTmuxPaneId(hudPaneId);
  if (!canonicalLeaderPaneId || !canonicalHudPaneId) return null;
  const incarnations = readHudResizeHookPaneIncarnations(canonicalHudPaneId, canonicalLeaderPaneId, execTmuxSync);
  if (!incarnations) return null;
  try {
    return parseHudResizeHookContext(
      execTmuxSync([
        'display-message',
        '-p',
        '-t',
        canonicalLeaderPaneId,
        '#{session_id}|#{window_id}',
      ]),
      canonicalLeaderPaneId,
      canonicalHudPaneId,
      incarnations,
    );
  } catch {
    return null;
  }
}


function buildNestedTmuxCommand(tmuxBin: string, args: string[], tmuxEnv?: string): string {
  const command = [tmuxBin, ...args].map((part) => shellEscapeSingle(part)).join(' ');
  return `${buildEnvPrefix({ TMUX: tmuxEnv })}${command}`;
}

function quoteHudHookShellArgument(value: string): string {
  return process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : shellEscapeSingle(value);
}

function buildHudHookIncarnationCondition(paneId: string, panePid: string): string {
  return `#{&&:#{==:#{pane_id},${paneId}},#{&&:#{==:#{pane_dead},0},#{==:#{pane_pid},${panePid}}}}`;
}

function combineTmuxConditions(...conditions: string[]): string {
  return conditions.reduce((combined, condition) => combined ? `#{&&:${combined},${condition}}` : condition, '');
}

function normalizeHudMutationAuthority(authority: HudTmuxMutationAuthority): HudTmuxMutationAuthority | null {
  const leaderPaneId = parseCanonicalTmuxPaneId(authority.leaderPaneId);
  const leaderPanePid = parsePositiveInteger(authority.leaderPanePid);
  const ownerId = authority.ownerId.trim();
  if (!leaderPaneId || !leaderPanePid || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ownerId)) return null;
  return { leaderPaneId, leaderPanePid: String(leaderPanePid), ownerId };
}

function buildHudMutationAuthorityCondition(authority: HudTmuxMutationAuthority): string {
  return combineTmuxConditions(
    buildHudHookIncarnationCondition(authority.leaderPaneId, authority.leaderPanePid),
    `#{==:#{@omx_instance_id},${authority.ownerId}}`,
  );
}

function executeHudCommandUnderAuthority(
  authority: HudTmuxMutationAuthority,
  command: string,
  execTmuxSync: TmuxExecSync,
): boolean {
  const marker = `__omx_hud_authority_${randomUUID()}`;
  try {
    return parseExactTmuxAuthorityScalar(execTmuxSync([
      'if-shell', '-F', '-t', authority.leaderPaneId,
      buildHudMutationAuthorityCondition(authority),
      `${command} ; display-message -p ${marker}`,
      `display-message -p __omx_hud_authority_failed_${marker}`,
    ])) === marker;
  } catch {
    return false;
  }
}

function buildHudHookRegistrationCommand(
  targetArgs: string[],
  hookSlot: string,
  registrationCommand: string,
  context: HudResizeHookContext,
  heightLines: number,
  cwd: string,
): string {
  return [
    'set-hook', ...targetArgs, hookSlot, shellEscapeSingle(registrationCommand),
    ...buildHudHookRegistrationSuffix(context, hookSlot, heightLines, cwd)
      .map(token => token === `#{${hookSlot}}` ? shellEscapeSingle(token) : token),
  ].join(' ');
}

function deferTmuxHookFormatExpansion(command: string): string {
  return command.replaceAll('#{', '##{');
}

function buildHudHookSelfUnregister(context: HudResizeHookContext): string {
  const identityOption = hudHookIdentityOption(context.hookSlot);
  return `if-shell -F -t ${context.sessionId} ${quoteHudHookShellArgument(`#{==:#{${identityOption}},${hudHookIdentityToken(context.hookName, context.hookSlot)}}`)} ${quoteHudHookShellArgument(`${buildHudHookUnsetCommand(context, context.hookSlot)} ; set-option -u -t ${context.sessionId} ${identityOption}`)} ''`;
}

function buildAtomicHudHookCommand(
  tmuxBin: string,
  context: HudResizeHookContext,
  success: string,
  tmuxEnv?: string,
): string {
  const unregister = buildHudHookSelfUnregister(context);
  const hudConditional = [
    'if-shell', '-F', '-t', context.hudPaneId,
    quoteHudHookShellArgument(buildHudHookIncarnationCondition(context.hudPaneId, context.hudPanePid)),
    quoteHudHookShellArgument(success),
    quoteHudHookShellArgument(unregister),
  ].join(' ');
  const args = [
    'if-shell', '-F', '-t', context.leaderPaneId,
    [
      buildHudHookIncarnationCondition(context.leaderPaneId, context.leaderPanePid),
      ...(context.ownerId ? [`#{==:#{@omx_instance_id},${context.ownerId}}`] : []),
    ].reduce((combined, condition) => `#{&&:${combined},${condition}}`),
    hudConditional,
    unregister,
  ];
  if (process.platform === 'win32') {
    const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const invoke = `& ${quotePowerShell(tmuxBin)} ${args.map(quotePowerShell).join(' ')}`;
    const command = tmuxEnv
      ? `& { $env:TMUX = ${quotePowerShell(tmuxEnv)}; ${invoke} } | Out-Null`
      : `${invoke} | Out-Null`;
    return deferTmuxHookFormatExpansion(command);
  }
  const command = buildNestedTmuxCommand(tmuxBin, args, tmuxEnv);
  return `${deferTmuxHookFormatExpansion(command)} >/dev/null 2>&1 || true`;
}

function buildAtomicHudResizeCommand(
  tmuxBin: string,
  hudPaneId: string,
  height: string,
  context: HudResizeHookContext,
  tmuxEnv?: string,
): string {
  // On client resize, never regrow a roster using a stale pre-resize height.
  // The watch/reconcile paths remeasure the leader before allowing expansion.
  const safeHeight = Number(height) > HUD_TMUX_MAX_HEIGHT_LINES
    ? `"#{?#{<:#{pane_height},${height}},#{pane_height},${height}}"` : height;
  return buildAtomicHudHookCommand(tmuxBin, context, `resize-pane -t ${hudPaneId} -y ${safeHeight}`, tmuxEnv);
}

function buildHudResizeHookCommand(
  tmuxBin: string,
  hudPaneId: string,
  height: string,
  context: HudResizeHookContext,
  tmuxEnv?: string,
): string {
  const atomicResize = buildAtomicHudResizeCommand(tmuxBin, hudPaneId, height, context, tmuxEnv);
  return process.platform === 'win32'
    ? `${atomicResize}; Start-Sleep -Seconds ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${atomicResize}`
    : `${atomicResize}; sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${atomicResize}`;
}


export function buildHudLayoutReconcileHookCommand(
  tmuxBin: string,
  omxBin: string,
  leaderPaneId: string,
  context: HudResizeHookContext,
  hookSlot: string,
  options: RegisterHudResizeHookOptions = {},
  platform: NodeJS.Platform = process.platform,
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd?.trim() || process.cwd();
  const reconcileRuntimeEnv = {
    TMUX: env.TMUX,
    TMUX_PANE: leaderPaneId,
    OMX_TMUX_HUD_OWNER: '1',
    OMX_HUD_WATCH_REPAIR: '1',
    OMX_HUD_WATCH_LEADER_PID: context.leaderPanePid,
    OMX_ENTRY_PATH: omxBin,
    OMX_SESSION_ID: env.OMX_SESSION_ID,
    OMX_ROOT: env.OMX_ROOT,
    OMX_STATE_ROOT: env.OMX_STATE_ROOT,
    OMX_TEAM_STATE_ROOT: env.OMX_TEAM_STATE_ROOT,
  };
  const reconcileEnv = buildEnvPrefix(reconcileRuntimeEnv);
  const reconcile = [
    'cd',
    shellEscapeSingle(cwd),
    '&&',
    `exec ${reconcileEnv}${shellEscapeSingle(process.execPath)}`,
    shellEscapeSingle(omxBin),
    'hud',
    '--reconcile-tmux',
    `--reconcile-timeout-ms=${HUD_WATCH_REPAIR_TIMEOUT_MS}`,
  ].join(' ');
  const layoutContext = { ...context, hookSlot };
  if (platform === 'win32') {
    const powerShellEnv = Object.entries(reconcileRuntimeEnv)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
      .map(([key, value]) => `$env:${key} = '${value.replace(/'/g, "''")}' `)
      .join('; ');
    const nativeReconcile = `${powerShellEnv}; Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${buildWindowsHudReconcileSupervisorCommand(process.execPath, omxBin, cwd, HUD_WATCH_REPAIR_TIMEOUT_MS + HUD_HOOK_NODE_STARTUP_GRACE_MS)}`;
    const success = `${buildHudHookSelfUnregister(layoutContext)} ; run-shell -b ${quoteHudHookShellArgument(nativeReconcile)}`;
    return buildAtomicHudHookCommand(tmuxBin, layoutContext, success, env.TMUX);
  }
  const supervisor = buildPosixHudReconcileSupervisorCommand(
    reconcile,
    HUD_WATCH_REPAIR_TIMEOUT_MS + HUD_HOOK_NODE_STARTUP_GRACE_MS,
  );
  const success = `${buildHudHookSelfUnregister(layoutContext)} ; run-shell -b ${quoteHudHookShellArgument(`(${supervisor}) >/dev/null 2>&1 || true`)}`;
  return buildAtomicHudHookCommand(tmuxBin, layoutContext, success, env.TMUX);
}

export function buildPosixHudReconcileSupervisorCommand(command: string, timeoutMs: number): string {
  const shutdownGraceSeconds = 2;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000) - shutdownGraceSeconds);
  return `watchdog_dir=$(mktemp -d "\${TMPDIR:-/tmp}/omx-hud-watchdog.XXXXXX") || exit 0; ready_fifo=$watchdog_dir/ready; mkfifo "$ready_fifo" || { rmdir "$watchdog_dir"; exit 0; }; ${command} & child=$!; (trap 'kill "$s" 2>/dev/null || :; wait "$s" 2>/dev/null || :; exit' TERM; sleep ${timeoutSeconds} & s=$!; printf 'ready\\n' > "$ready_fifo"; wait "$s" && { kill -TERM "$child" 2>/dev/null || :; sleep ${shutdownGraceSeconds} & s=$!; wait "$s" || :; kill -KILL "$child" 2>/dev/null || :; } || :) & watchdog=$!; IFS= read -r _ < "$ready_fifo"; wait "$child"; status=$?; kill -TERM "$watchdog" 2>/dev/null || :; wait "$watchdog" 2>/dev/null || :; rm -f "$ready_fifo"; rmdir "$watchdog_dir" 2>/dev/null || :; exit "$status"`;
}

export function buildWindowsHudReconcileSupervisorCommand(
  nodePath: string,
  omxBinary: string,
  cwd: string,
  timeoutMs: number,
): string {
  const quotePowerShellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const childArguments = `"${omxBinary}" hud --reconcile-tmux --reconcile-timeout-ms=${HUD_WATCH_REPAIR_TIMEOUT_MS}`;
  return [
    `try { $child = Start-Process -FilePath ${quotePowerShellLiteral(nodePath)} -ArgumentList ${quotePowerShellLiteral(childArguments)} -WorkingDirectory ${quotePowerShellLiteral(cwd)} -PassThru -WindowStyle Hidden -ErrorAction Stop } catch { exit 0 }`,
    `if ($child.WaitForExit(${timeoutMs})) { exit 0 }`,
    'try { & taskkill.exe /PID $child.Id /T /F | Out-Null } catch { try { $child.Kill() } catch {} }',
    'exit 0',
  ].join('; ');
}

export function readHudHookHealth(
  input: ReadHudHookHealthInput,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): HudHookHealth {
  const leaderPaneId = parseCanonicalTmuxPaneId(input.leaderPaneId);
  const hudPaneId = parseCanonicalTmuxPaneId(input.hudPaneId);
  const leaderPanePid = parsePositiveInteger(input.leaderPanePid);
  const hudPanePid = parsePositiveInteger(input.hudPanePid);
  if (
    !leaderPaneId
    || !hudPaneId
    || !leaderPanePid
    || !hudPanePid
    || !isTmuxSessionId(input.sessionId)
    || !isTmuxWindowId(input.windowId)
    || !Number.isFinite(input.heightLines)
    || input.heightLines < 1
  ) return 'unknown';

  const hookName = buildHudResizeHookName(input.sessionId, input.windowId, leaderPaneId);
  const context: HudResizeHookContext = {
    sessionId: input.sessionId,
    windowId: input.windowId,
    leaderPaneId,
    leaderPanePid: String(leaderPanePid),
    hudPaneId,
    hudPanePid: String(hudPanePid),
    hookName,
    hookSlot: buildHudResizeHookSlot(hookName),
    layoutHookSlot: buildHudLayoutHookSlot(hookName),
    splitHookSlot: buildHudSplitHookSlot(hookName),
  };
  const slots = [context.hookSlot, context.layoutHookSlot, context.splitHookSlot] as const;
  const identityOptions = slots.map(hudHookIdentityOption);
  const ownerId = (input.env?.OMX_SESSION_ID ?? process.env.OMX_SESSION_ID)?.trim();
  if (!ownerId) return 'unknown';
  const ownedContext = { ...context, ownerId };
  const format = [
    '#{pane_id}',
    '#{pane_dead}',
    '#{pane_pid}',
    '#{session_id}',
    '#{window_id}',
    '#{@omx_instance_id}',
    ...slots.map(slot => `#{?#{&&:#{==:#{${slot}},#{${hudHookExpectedCommandOption(slot)}}},#{==:#{${hudHookConfigurationOption(slot)}},${hudHookConfigurationToken(ownedContext, slot, input.heightLines, input.cwd?.trim() || process.cwd())}}},1,0}`),
    ...identityOptions.map(option => `#{${option}}`),
  ].join('|');

  let fields: string[];
  try {
    const output = parseExactTmuxAuthorityScalar(execTmuxSync([
      'display-message', '-p', '-t', leaderPaneId, format,
    ]));
    if (output === null) return 'unknown';
    fields = output.split('|');
  } catch {
    return 'unknown';
  }
  if (fields.length !== 12) return 'unknown';

  const [
    observedLeaderPaneId,
    observedLeaderDead,
    observedLeaderPanePid,
    observedSessionId,
    observedWindowId,
    observedOwnerId,
    ...observedHooksAndIdentities
  ] = fields;
  if (
    parseCanonicalTmuxPaneId(observedLeaderPaneId) !== observedLeaderPaneId
    || !/^[01]$/.test(observedLeaderDead ?? '')
    || parsePositiveInteger(observedLeaderPanePid) === null
    || !isTmuxSessionId(observedSessionId ?? '')
    || !isTmuxWindowId(observedWindowId ?? '')
    || (observedOwnerId !== '' && !/^\S+$/.test(observedOwnerId ?? ''))
  ) return 'unknown';
  if (
    observedLeaderPaneId !== leaderPaneId
    || observedLeaderDead !== '0'
    || observedLeaderPanePid !== String(leaderPanePid)
    || observedSessionId !== input.sessionId
    || observedWindowId !== input.windowId
  ) return 'repair_needed';
  if (!observedOwnerId) return 'unknown';
  if (observedOwnerId !== ownerId) return 'owner_mismatch';

  const expectedHealthAndIdentities = [
    '1', '1', '1',
    ...slots.map(slot => hudHookIdentityToken(hookName, slot)),
  ];
  return observedHooksAndIdentities.every((value, index) => value === expectedHealthAndIdentities[index])
      ? 'healthy'
      : 'repair_needed';
}

function unregisterLegacyHudResizeHook(
  context: HudResizeHookContext,
  execTmuxSync: TmuxExecSync,
): void {
  // Legacy registrations predate identity metadata. Leaving them untouched is
  // safer than clearing a slot that may now belong to another registration.
  void context;
  void execTmuxSync;
}

function buildEnvPrefix(env: Record<string, string | undefined>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => [key, typeof value === 'string' ? value : ''] as const)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${shellEscapeSingle(value)}`);
  return assignments.length > 0 ? `env ${assignments.join(' ')} ` : '';
}

export interface HudCommandWriterOptions {
  omxEntry: string;
  runtimeEnv: Record<string, string>;
  nodeCommand: string;
  preset?: string;
  platform?: NodeJS.Platform;
  powerShellEnvelope?: boolean;
  quoteOwnerValue?: boolean;
}

/** The sole platform-aware serializer for tmux HUD watch commands. */
export function writeHudWatchCommand(options: HudCommandWriterOptions): string {
  const safePreset = options.preset === 'minimal' || options.preset === 'focused' || options.preset === 'full'
    ? `--preset=${options.preset}`
    : undefined;
  const platform = options.platform ?? process.platform;
  const presetArgument = safePreset ? ` ${shellEscapeSingle(safePreset)}` : '';
  if (platform === 'win32') {
    const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const assignments = Object.entries(options.runtimeEnv)
      .map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`)
      .join('; ');
    const invocation = ['&', quotePowerShell(options.nodeCommand), quotePowerShell(options.omxEntry), 'hud', '--watch', ...(safePreset ? [safePreset] : [])].join(' ');
    const script = `${assignments}; ${invocation}`;
    return options.powerShellEnvelope
      ? `powershell.exe -NoLogo -NoExit -Command ${quotePowerShell(script)}`
      : script;
  }
  const assignments = Object.entries(options.runtimeEnv)
    .map(([key, value]) => `${key}=${key === OMX_TMUX_HUD_OWNER_ENV && !options.quoteOwnerValue ? value : shellEscapeSingle(value)}`)
    .join(' ');
  const nodeCommand = options.nodeCommand === 'node' ? 'node' : shellEscapeSingle(options.nodeCommand);
  return `exec ${assignments ? `env ${assignments} ` : ''}${nodeCommand} ${shellEscapeSingle(options.omxEntry)} hud --watch${presetArgument}`;
}
export function buildHudRuntimeEnv(input: HudRuntimeEnvInput = {}): HudRuntimeEnvOutput {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const rawLeaderPaneId = typeof input.leaderPaneId === 'string' ? input.leaderPaneId : '';
  const leaderPaneId = rawLeaderPaneId ? parseCanonicalTmuxPaneId(rawLeaderPaneId) : null;
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
  platform: NodeJS.Platform = process.platform,
): string {
  const runtimeEnv = buildHudRuntimeEnv({
    sessionId,
    leaderPaneId,
    omxRoot,
    ...(rootEnv ?? { rootSource: 'omx-root-env' }),
  }).env;
  return writeHudWatchCommand({
    omxEntry: omxBin,
    runtimeEnv,
    nodeCommand: process.execPath,
    preset,
    platform,
    powerShellEnvelope: platform === 'win32',
    quoteOwnerValue: true,
  });
}

export function listCurrentWindowPanes(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  currentPaneId?: string,
): TmuxPaneSnapshot[] {
  const canonicalCurrentPaneId = currentPaneId ? parseCanonicalTmuxPaneId(currentPaneId) : null;
  if (currentPaneId && !canonicalCurrentPaneId) return [];

  const targetArgs = canonicalCurrentPaneId ? ['-t', canonicalCurrentPaneId] : [];
  try {
    const paneIds = parseCanonicalPaneIdSnapshot(execTmuxSync([
      'list-panes',
      ...targetArgs,
      '-F',
      '#{pane_id}',
    ]));
    if (!paneIds) return [];
    const paneSnapshotOutput = execTmuxSync([
      'list-panes',
      ...targetArgs,
      '-F',
      [
        '#{pane_id}',
        '#{pane_current_command}',
        '#{pane_left}',
        '#{pane_top}',
        '#{pane_width}',
        '#{pane_height}',
        '#{pane_bottom}',
        '#{window_width}',
        '#{window_height}',
        '#{session_id}',
        '#{window_id}',
        '#{pane_dead}',
        '#{pane_pid}',
        '#{pane_start_command}',
        '#{pane_current_path}',
      ].join(TMUX_PANE_FIELD_SEPARATOR),
    ]);
    if (!parseExactTmuxAuthorityLines(paneSnapshotOutput)) return [];
    return parseTmuxPaneSnapshot(paneSnapshotOutput, paneIds);
  } catch {
    return [];
  }
}

export function readActiveTmuxPaneId(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  try {
    const paneId = parseExactTmuxAuthorityScalar(execTmuxSync(['display-message', '-p', '#{pane_id}']));
    return parseCanonicalTmuxPaneId(paneId);
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
  const canonicalCurrentPaneId = currentPaneId ? parseCanonicalTmuxPaneId(currentPaneId) : null;
  if (currentPaneId && !canonicalCurrentPaneId) return { width: null, height: null };

  try {
    const raw = execTmuxSync([
      'display-message',
      '-p',
      ...(canonicalCurrentPaneId ? ['-t', canonicalCurrentPaneId] : []),
      '#{window_width}|#{window_height}',
    ]);
    const framed = parseExactTmuxAuthorityScalar(raw);
    if (framed === null) return { width: null, height: null };
    const fields = framed.split('|');
    if (fields.length !== 2) return { width: null, height: null };
    const width = parsePositiveInteger(fields[0]);
    const height = parsePositiveInteger(fields[1]);
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}

interface HudSplitAuthority {
  proofOption: string;
  proofValue: string;
  operationMarker: string;
  panePid: string;
  sessionId: string;
  windowId: string;
  targetPaneId?: string;
}

interface HudSplitSourceAuthority {
  paneId: string;
  panePid: string;
  sessionId: string;
  windowId: string;
}

function readHudSplitSourceAuthority(
  targetPaneId: string | null,
  execTmuxSync: TmuxExecSync,
): HudSplitSourceAuthority | null {
  try {
    const source = parseExactTmuxAuthorityScalar(execTmuxSync([
      'display-message',
      '-p',
      ...(targetPaneId ? ['-t', targetPaneId] : []),
      '#{pane_id}|#{pane_dead}|#{pane_pid}|#{session_id}|#{window_id}',
    ]));
    if (!source) return null;
    const fields = source.split('|');
    if (fields.length !== 5) return null;
    const paneId = parseCanonicalTmuxPaneId(fields[0]);
    const paneDead = fields[1];
    const panePid = fields[2];
    const sessionId = fields[3];
    const windowId = fields[4];
    if (
      !paneId
      || (targetPaneId && paneId !== targetPaneId)
      || paneDead !== '0'
      || !/^[1-9][0-9]*$/.test(panePid ?? '')
      || !isTmuxSessionId(sessionId ?? '')
      || !isTmuxWindowId(windowId ?? '')
    ) return null;
    return { paneId, panePid: panePid!, sessionId: sessionId!, windowId: windowId! };
  } catch {
    return null;
  }
}

function buildHudSplitSourceCondition(source: HudSplitSourceAuthority): string {
  return `#{&&:#{==:#{pane_id},${source.paneId}},#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{pane_pid},${source.panePid}},#{&&:#{==:#{session_id},${source.sessionId}},#{==:#{window_id},${source.windowId}}}}}}`;
}


const hudSplitAuthorities = new Map<string, HudSplitAuthority>();

function readCanonicalPaneIdSnapshot(execTmuxSync: TmuxExecSync, targetPaneId?: string, global = false): Set<string> | null {
  try {
    return parseCanonicalPaneIdSnapshot(execTmuxSync([
      'list-panes',
      ...(global ? ['-a'] : targetPaneId ? ['-t', targetPaneId] : []),
      '-F',
      '#{pane_id}',
    ]));
  } catch {
    return null;
  }
}

function deriveSingleNewPane(before: ReadonlySet<string>, after: ReadonlySet<string>): string | null {
  if (after.size !== before.size + 1 || ![...before].every((paneId) => after.has(paneId))) return null;
  const created = [...after].filter((paneId) => !before.has(paneId));
  return created.length === 1 ? created[0] ?? null : null;
}




const OMX_TMUX_SPLIT_OPERATION_MARKER_ENV = 'OMX_TMUX_SPLIT_OPERATION_MARKER';

function writeHudSplitOperationMarkedCommand(command: string, marker: string): string {
  if (process.platform === 'win32') return `$env:${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV} = '${marker}'; ${command}`;
  return `${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}='${marker}' ${command}`;
}

function hasHudSplitOperationMarker(startCommand: string, marker: string): boolean {
  // tmux 3.2a wraps `pane_start_command` values containing special characters
  // in double quotes (e.g. `"OMX_TMUX_SPLIT_OPERATION_MARKER='<marker>' node omx.js hud --watch"`).
  // The marker must sit at the very start of the command, optionally inside that
  // wrapper, followed by a `;` (old export form) or ` ` (command-scoped assignment).
  // Mid-command mentions and marker-prefix collisions are never accepted.
  const posixMarker = `${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}='${marker}'`;
  const powerShellMarker = `$env:${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV} = '${marker}'`;
  return [posixMarker, `"${posixMarker}`].some((prefix) => (
    startCommand === `${prefix}`
    || startCommand === `${prefix}"`
    || startCommand.startsWith(`${prefix};`)
    || startCommand.startsWith(`${prefix} `)
  ))
    || [powerShellMarker, `"${powerShellMarker}`].some((prefix) => (
      startCommand === `${prefix}`
      || startCommand === `${prefix}"`
      || startCommand.startsWith(`${prefix};`)
    ));
}

export function findHudSplitOperationMarkerPaneId(marker: string, execTmuxSync: TmuxExecSync): string | null {
  try {
    const format = '#{pane_id}|#{pane_start_command}';
    const lines = parseExactTmuxAuthorityLines(execTmuxSync(['list-panes', '-a', '-F', format]));
    if (!lines) return null;
    let candidate: string | null = null;
    const seen = new Set<string>();
    for (const rawLine of lines) {
      const separatorIndex = rawLine.indexOf('|');
      if (separatorIndex < 1) return null;
      const rawPaneId = rawLine.slice(0, separatorIndex);
      const paneId = parseCanonicalTmuxPaneId(rawPaneId);
      if (!paneId || paneId !== rawPaneId || seen.has(paneId)) return null;
      seen.add(paneId);
      const command = rawLine.slice(separatorIndex + 1);
      if (!hasHudSplitOperationMarker(command, marker)) continue;
      if (candidate) return null;
      candidate = paneId;
    }
    return candidate;
  } catch {
    return null;
  }
}

function recoverHudSplitPaneId(
  globalBefore: ReadonlySet<string>,
  targetBefore: ReadonlySet<string> | null,
  targetPaneId: string | null,
  marker: string,
  execTmuxSync: TmuxExecSync,
): string | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const globalAfter = readCanonicalPaneIdSnapshot(execTmuxSync, undefined, true);
    const targetAfter = targetPaneId ? readCanonicalPaneIdSnapshot(execTmuxSync, targetPaneId) : null;
    const globalCandidate = globalAfter ? deriveSingleNewPane(globalBefore, globalAfter) : null;
    const targetCandidate = targetPaneId ? (targetAfter ? deriveSingleNewPane(targetBefore!, targetAfter) : null) : globalCandidate;
    const markerCandidate = findHudSplitOperationMarkerPaneId(marker, execTmuxSync);
    if (globalCandidate && globalCandidate === targetCandidate && markerCandidate === globalCandidate) return globalCandidate;
    if (markerCandidate && !globalBefore.has(markerCandidate)) return markerCandidate;
    if (attempt < 2) sleepSync(50);
  }
  return null;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readTmuxOptionExactly(execTmuxSync: TmuxExecSync, option: string): string | null {
  try {
    return parseExactTmuxAuthorityScalar(execTmuxSync(['show-options', '-g', '-v', option]));
  } catch {
    return null;
  }
}

function hasHudSplitAuthority(paneId: string, execTmuxSync: TmuxExecSync = defaultExecTmuxSync): boolean {
  const authority = hudSplitAuthorities.get(paneId);
  if (!authority) return false;
  const globalPanes = readCanonicalPaneIdSnapshot(execTmuxSync, undefined, true);
  if (!globalPanes?.has(paneId)) return false;
  if (authority.targetPaneId) {
    const targetPanes = readCanonicalPaneIdSnapshot(execTmuxSync, authority.targetPaneId);
    if (!targetPanes?.has(paneId)) return false;
  }
  const location = readHudPaneSessionAndWindow(paneId, execTmuxSync);
  return (
    findHudSplitOperationMarkerPaneId(authority.operationMarker, execTmuxSync) === paneId
    && readHudPaneIncarnation(paneId, execTmuxSync)?.panePid === authority.panePid
    && location?.sessionId === authority.sessionId
    && location?.windowId === authority.windowId
    && readTmuxOptionExactly(execTmuxSync, authority.proofOption) === authority.proofValue
  );
}

function readHudPaneIncarnation(paneId: string, execTmuxSync: TmuxExecSync): { paneDead: boolean; panePid: string } | null {
  try {
    const lines = parseExactTmuxAuthorityLines(execTmuxSync(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']));
    if (!lines) return null;
    const seenPaneIds = new Set<string>();
    let incarnation: { paneDead: boolean; panePid: string } | null = null;
    for (const line of lines) {
      const match = /^(%\S+) ([01]) ([0-9]+)$/.exec(line);
      const observedPaneId = match ? parseCanonicalTmuxPaneId(match[1]) : null;
      if (!match || !observedPaneId || observedPaneId !== match[1] || seenPaneIds.has(observedPaneId)) return null;
      seenPaneIds.add(observedPaneId);
      if (match[2] === '1') continue;
      if (!/^[1-9][0-9]*$/.test(match[3])) return null;
      if (observedPaneId === paneId) incarnation = { paneDead: false, panePid: match[3]! };
    }
    return incarnation;
  } catch {
    return null;
  }
}
function isPaneLiveInStrictGlobalProbe(paneId: string, expectedPid: string | undefined, execTmuxSync: TmuxExecSync): boolean {
  const incarnation = readHudPaneIncarnation(paneId, execTmuxSync);
  return Boolean(incarnation && !incarnation.paneDead && (!expectedPid || incarnation.panePid === expectedPid));
}

/** Freshly validates retained split proof and sustained global liveness before a HUD mutation sink. */
export function verifyHudWatchPaneAuthority(paneId: string, execTmuxSync: TmuxExecSync = defaultExecTmuxSync): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || !hasHudSplitAuthority(canonicalPaneId, execTmuxSync)) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) sleepSync(100);
    if (
      !hasHudSplitAuthority(canonicalPaneId, execTmuxSync)
      || !isPaneLiveInStrictGlobalProbe(canonicalPaneId, hudSplitAuthorities.get(canonicalPaneId)?.panePid, execTmuxSync)
    ) return false;
  }
  return true;
}

/** Kills only a pane still bound to this process's exact split proof. */
export function rollbackHudWatchPaneAuthority(paneId: string, execTmuxSync: TmuxExecSync = defaultExecTmuxSync): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  const authority = canonicalPaneId ? hudSplitAuthorities.get(canonicalPaneId) : undefined;
  if (!canonicalPaneId || !authority) return false;
  const killed = mutateHudWatchPaneIfCurrent(canonicalPaneId, authority.panePid, `kill-pane -t ${canonicalPaneId}`, execTmuxSync);
  if (killed) hudSplitAuthorities.delete(canonicalPaneId);
  return killed;

}

function rollbackRecoveredHudSplitPane(
  paneId: string,
  proofOption: string,
  proofValue: string,
  operationMarker: string,
  panePid?: string,
  sessionId?: string,
  windowId?: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || canonicalPaneId !== paneId) return false;
  const pidCondition = panePid && /^[1-9][0-9]*$/.test(panePid) ? `#{&&:#{==:#{pane_pid},${panePid}},` : '';
  const sessionCondition = sessionId && /^\$[0-9]+$/.test(sessionId) ? `#{&&:#{==:#{session_id},${sessionId}},` : '';
  const windowCondition = windowId && /^@[0-9]+$/.test(windowId) ? `#{&&:#{==:#{window_id},${windowId}},` : '';
  const closes = `${pidCondition ? '}' : ''}${sessionCondition ? '}' : ''}${windowCondition ? '}' : ''}`;
  const receipt = `__omx_hud_rollback_${randomUUID()}`;
  const condition = `#{&&:#{==:#{pane_id},${paneId}},#{&&:#{==:#{pane_dead},0},${pidCondition}${sessionCondition}${windowCondition}#{&&:#{==:#{${proofOption}},${proofValue}},#{m:*${operationMarker}*,#{pane_start_command}}}${closes}}`;
  try {
    return parseExactTmuxAuthorityScalar(execTmuxSync([
      'if-shell', '-F', '-t', paneId,
      condition,
      `kill-pane -t ${paneId} ; display-message -p ${receipt}`,
      `display-message -p __omx_hud_rollback_rejected_${receipt}`,
    ])) === receipt;
  } catch {
    return false;
  }
}


export function createHudWatchPane(
  cwd: string,
  hudCmd: string,
  options: {
    heightLines?: number;
    fullWidth?: boolean;
    targetPaneId?: string;
    authority?: HudTmuxMutationAuthority;
  } = {},
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  const canonicalTargetPaneId = options.targetPaneId ? parseCanonicalTmuxPaneId(options.targetPaneId) : null;
  if (options.targetPaneId && !canonicalTargetPaneId) return null;
  const sourceAuthority = readHudSplitSourceAuthority(canonicalTargetPaneId, execTmuxSync);
  if (!sourceAuthority) return null;
  const mutationAuthority = options.authority ? normalizeHudMutationAuthority(options.authority) : null;
  if (
    options.authority
    && (
      !mutationAuthority
      || mutationAuthority.leaderPaneId !== sourceAuthority.paneId
      || mutationAuthority.leaderPanePid !== sourceAuthority.panePid
    )
  ) return null;
  const sourcePaneId = sourceAuthority.paneId;
  const globalBefore = readCanonicalPaneIdSnapshot(execTmuxSync, undefined, true);
  const targetBefore = readCanonicalPaneIdSnapshot(execTmuxSync, sourcePaneId);
  if (!globalBefore || !targetBefore) return null;
  const operationMarker = randomUUID();
  const heightLines = Number.isFinite(options.heightLines) && (options.heightLines ?? 0) > 0
    ? Math.floor(options.heightLines ?? HUD_TMUX_HEIGHT_LINES)
    : HUD_TMUX_HEIGHT_LINES;
  const args = [
    'split-window', '-v', ...(options.fullWidth ? ['-f'] : []), '-l', String(heightLines), '-d',
    '-t', sourcePaneId, '-c', shellEscapeSingle(cwd), shellEscapeSingle(writeHudSplitOperationMarkedCommand(hudCmd, operationMarker)),
  ];
  let paneId: string | null = null;
  const nonce = randomUUID();
  const proofOption = `@omx_hud_split_owner_nonce_${nonce}`;
  const provisionalProof = `pending:${nonce}`;
  const receipt = `__omx_hud_split_${randomUUID()}`;
  const splitCommand = args.join(' ');
  try {
    execTmuxSync(['set-option', '-g', proofOption, provisionalProof]);
    if (readTmuxOptionExactly(execTmuxSync, proofOption) !== provisionalProof) return null;

    const splitOutput = execTmuxSync([
      'if-shell', '-F', '-t', sourcePaneId,
      combineTmuxConditions(
        buildHudSplitSourceCondition(sourceAuthority),
        ...(mutationAuthority ? [buildHudMutationAuthorityCondition(mutationAuthority)] : []),
      ),
      `${splitCommand} ; display-message -p ${receipt}`,
      `display-message -p __omx_hud_split_rejected_${receipt}`,
    ]);
    if (parseExactTmuxAuthorityScalar(splitOutput) !== receipt) return null;
    paneId = recoverHudSplitPaneId(
      globalBefore,
      targetBefore,
      sourcePaneId,
      operationMarker,
      execTmuxSync,
    );
    const incarnation = paneId ? readHudPaneIncarnation(paneId, execTmuxSync) : null;
    const location = paneId ? readHudPaneSessionAndWindow(paneId, execTmuxSync) : null;
    if (
      !paneId
      || !incarnation
      || !location
      || location.sessionId !== sourceAuthority.sessionId
      || location.windowId !== sourceAuthority.windowId
    ) {
      if (paneId) {
        rollbackRecoveredHudSplitPane(
          paneId,
          proofOption,
          provisionalProof,
          operationMarker,
          incarnation?.panePid,
          location?.sessionId ?? sourceAuthority.sessionId,
          location?.windowId ?? sourceAuthority.windowId,
          execTmuxSync,
        );
      }
      return null;
    }

    hudSplitAuthorities.set(paneId, {
      proofOption,
      proofValue: provisionalProof,
      operationMarker,
      panePid: incarnation.panePid,
      sessionId: location.sessionId,
      windowId: location.windowId,
      targetPaneId: sourcePaneId,
    });

    if (!hasHudSplitAuthority(paneId, execTmuxSync)) {
      rollbackHudWatchPaneAuthority(paneId, execTmuxSync);
      return null;
    }
    const proofValue = `${paneId}:split:${nonce}`;
    execTmuxSync(['set-option', '-g', proofOption, proofValue]);
    hudSplitAuthorities.set(paneId, { proofOption, proofValue, operationMarker, panePid: incarnation.panePid, sessionId: location.sessionId, windowId: location.windowId, targetPaneId: sourcePaneId });
    if (readTmuxOptionExactly(execTmuxSync, proofOption) !== proofValue) {
      rollbackHudWatchPaneAuthority(paneId, execTmuxSync);
      return null;
    }

    if (!verifyHudWatchPaneAuthority(paneId, execTmuxSync)) {
      rollbackHudWatchPaneAuthority(paneId, execTmuxSync);
      return null;
    }
    return paneId;
  } catch {
    if (paneId) {
      rollbackHudWatchPaneAuthority(paneId, execTmuxSync);
    } else {
      const recoveredPaneId = recoverHudSplitPaneId(
        globalBefore,
        targetBefore,
        sourcePaneId,
        operationMarker,
        execTmuxSync,
      );
      if (recoveredPaneId) {
        rollbackRecoveredHudSplitPane(
          recoveredPaneId,
          proofOption,
          provisionalProof,
          operationMarker,
          undefined,
          sourceAuthority.sessionId,
          sourceAuthority.windowId,
          execTmuxSync,
        );
      }
    }
    return null;
  }
}

function readHudPaneSessionAndWindow(
  paneId: string,
  execTmuxSync: TmuxExecSync,
): { sessionId: string; windowId: string } | null {
  try {
    const value = parseExactTmuxAuthorityScalar(execTmuxSync([
      'display-message', '-p', '-t', paneId, '#{session_id}|#{window_id}',
    ]));
    if (!value) return null;
    const [sessionId, windowId, ...extra] = value.split('|');
    return !extra.length && isTmuxSessionId(sessionId ?? '') && isTmuxWindowId(windowId ?? '')
      ? { sessionId: sessionId!, windowId: windowId! }
      : null;
  } catch {
    return null;
  }
}

/** Executes a split-owned pane mutation only while its immutable owner proof and exact incarnation remain current. */
export function mutateHudWatchPaneIfCurrent(
  paneId: string,
  expectedPanePid: string,
  mutation: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  const authority = canonicalPaneId ? hudSplitAuthorities.get(canonicalPaneId) : undefined;
  if (
    !canonicalPaneId
    || !authority
    || authority.panePid !== expectedPanePid
    || !/^[1-9][0-9]*$/.test(expectedPanePid)
    || !/^(?:kill-pane|resize-pane) -t %(?:0|[1-9][0-9]*)(?: -y [1-9][0-9]*)?$/.test(mutation)
  ) return false;
  const marker = `__omx_hud_mutation_${randomUUID()}`;
  const condition = `#{&&:#{==:#{pane_id},${canonicalPaneId}},#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{pane_pid},${expectedPanePid}},#{&&:#{==:#{session_id},${authority.sessionId}},#{&&:#{==:#{window_id},${authority.windowId}},#{&&:#{==:#{${authority.proofOption}},${authority.proofValue}},#{m:*${authority.operationMarker}*,#{pane_start_command}}}}}}}`;
  try {
    const output = execTmuxSync([
      'if-shell', '-F', '-t', canonicalPaneId,
      condition,
      `${mutation} ; display-message -p ${marker}`,
      `display-message -p __omx_hud_mutation_failed_${marker}`,
    ]);
    return parseExactTmuxAuthorityScalar(output) === marker;
  } catch {
    return false;
  }
}

/** Executes a retained pane mutation only while the exact target incarnation remains live. */
function mutateTmuxPaneIfCurrent(
  paneId: string,
  expectedPanePid: string,
  mutation: string,
  authority: HudTmuxMutationAuthority | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  const normalizedAuthority = authority ? normalizeHudMutationAuthority(authority) : null;
  if (!canonicalPaneId || !/^[1-9][0-9]*$/.test(expectedPanePid) || (authority && !normalizedAuthority)) return false;
  const marker = `__omx_hud_mutation_${randomUUID()}`;
  try {
    const targetMutation = [
      'if-shell', '-F', '-t', canonicalPaneId,
      buildHudHookIncarnationCondition(canonicalPaneId, expectedPanePid),
      `${mutation} ; display-message -p ${marker}`,
      `display-message -p __omx_hud_mutation_failed_${marker}`,
    ];
    const output = execTmuxSync(normalizedAuthority ? [
      'if-shell', '-F', '-t', normalizedAuthority.leaderPaneId,
      buildHudMutationAuthorityCondition(normalizedAuthority),
      targetMutation.map(shellEscapeSingle).join(' '),
      `display-message -p __omx_hud_mutation_failed_${marker}`,
    ] : targetMutation);
    return parseExactTmuxAuthorityScalar(output) === marker;
  } catch {
    return false;
  }
}

/** Kills a pane only while its exact live incarnation remains the target. */
export function killTmuxPaneIfCurrent(
  paneId: string,
  expectedPanePid: string,
  authorityOrExecTmuxSync?: HudTmuxMutationAuthority | TmuxExecSync,
  maybeExecTmuxSync?: TmuxExecSync,
): boolean {
  const authority = typeof authorityOrExecTmuxSync === 'function' ? undefined : authorityOrExecTmuxSync;
  const execTmuxSync = typeof authorityOrExecTmuxSync === 'function'
    ? authorityOrExecTmuxSync
    : (maybeExecTmuxSync ?? defaultExecTmuxSync);
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  return canonicalPaneId
    ? mutateTmuxPaneIfCurrent(canonicalPaneId, expectedPanePid, `kill-pane -t ${canonicalPaneId}`, authority, execTmuxSync)
    : false;
}

/** Resizes a pane only while its exact live incarnation remains the target. */
export function resizeTmuxPaneIfCurrent(
  paneId: string,
  expectedPanePid: string,
  heightLines: number,
  authorityOrExecTmuxSync?: HudTmuxMutationAuthority | TmuxExecSync,
  maybeExecTmuxSync?: TmuxExecSync,
): boolean {
  const authority = typeof authorityOrExecTmuxSync === 'function' ? undefined : authorityOrExecTmuxSync;
  const execTmuxSync = typeof authorityOrExecTmuxSync === 'function'
    ? authorityOrExecTmuxSync
    : (maybeExecTmuxSync ?? defaultExecTmuxSync);
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId) return false;
  const height = Number.isFinite(heightLines) && heightLines > 0
    ? Math.floor(heightLines)
    : HUD_TMUX_HEIGHT_LINES;
  return mutateTmuxPaneIfCurrent(canonicalPaneId, expectedPanePid, `resize-pane -t ${canonicalPaneId} -y ${height}`, authority, execTmuxSync);
}

/** 仅在 HUD 与 leader authority 仍匹配时清理 history。 */
export function clearTmuxPaneHistoryIfCurrent(
  paneId: string,
  expectedPanePid: string,
  authorityOrExecTmuxSync?: HudTmuxMutationAuthority | TmuxExecSync,
  maybeExecTmuxSync?: TmuxExecSync,
): boolean {
  const authority = typeof authorityOrExecTmuxSync === 'function' ? undefined : authorityOrExecTmuxSync;
  const execTmuxSync = typeof authorityOrExecTmuxSync === 'function'
    ? authorityOrExecTmuxSync
    : (maybeExecTmuxSync ?? defaultExecTmuxSync);
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  return canonicalPaneId
    ? mutateTmuxPaneIfCurrent(canonicalPaneId, expectedPanePid, `clear-history -t ${canonicalPaneId}`, authority, execTmuxSync)
    : false;
}

export function killTmuxPane(
  paneId: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId) return false;
  try {
    execTmuxSync(['kill-pane', '-t', canonicalPaneId]);
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
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId) return false;
  const height = Number.isFinite(heightLines) && heightLines > 0
    ? Math.floor(heightLines)
    : HUD_TMUX_HEIGHT_LINES;
  try {
    execTmuxSync(['resize-pane', '-t', canonicalPaneId, '-y', String(height)]);
    return true;
  } catch {
    return false;
  }
}

/** Clears scrollback for an OMX-owned HUD pane after a height reflow. */
export function clearTmuxPaneHistory(
  paneId: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId) return false;
  try {
    execTmuxSync(['clear-history', '-t', canonicalPaneId]);
    return true;
  } catch {
    return false;
  }
}

export function registerHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  heightLines: number,
  optionsOrExecTmuxSync: RegisterHudResizeHookOptions | TmuxExecSync = {},
  maybeExecTmuxSync?: TmuxExecSync,
): boolean {
  const options = typeof optionsOrExecTmuxSync === 'function' ? {} : optionsOrExecTmuxSync;
  const execTmuxSync = typeof optionsOrExecTmuxSync === 'function'
    ? optionsOrExecTmuxSync
    : (maybeExecTmuxSync ?? defaultExecTmuxSync);
  const canonicalHudPaneId = parseCanonicalTmuxPaneId(hudPaneId);
  const canonicalLeaderPaneId = parseCanonicalTmuxPaneId(leaderPaneId);
  if (!canonicalHudPaneId || !canonicalLeaderPaneId) return false;
  const context = readHudResizeHookContext(canonicalHudPaneId, canonicalLeaderPaneId, execTmuxSync);
  if (!context) return false;
  const expectedOwnerId = (options.env?.OMX_SESSION_ID ?? process.env.OMX_SESSION_ID)?.trim();
  const repairRegistration = (options.env?.OMX_HUD_WATCH_REPAIR ?? process.env.OMX_HUD_WATCH_REPAIR) === '1';
  const expectedRepairLeaderPid = options.env?.OMX_HUD_WATCH_LEADER_PID ?? process.env.OMX_HUD_WATCH_LEADER_PID;
  if (
    repairRegistration
    && (!expectedRepairLeaderPid || parsePositiveInteger(expectedRepairLeaderPid) !== Number(context.leaderPanePid))
  ) return false;
  let ownerId = expectedOwnerId;
  let observedOwnerId: string | null = null;
  try {
    const observedOwner = parseExactTmuxAuthorityScalar(execTmuxSync([
      'display-message', '-p', '-t', canonicalLeaderPaneId, '#{@omx_instance_id}',
    ]));
    if (observedOwner && /^\S+$/.test(observedOwner)) {
      if (expectedOwnerId && observedOwner !== expectedOwnerId) return false;
      observedOwnerId = observedOwner;
      ownerId = observedOwner;
    }
  } catch {
    // Owner fencing remains available from the launch environment when tmux
    // does not expose the session option through this probe.
  }
  if (repairRegistration && (!expectedOwnerId || observedOwnerId !== expectedOwnerId)) return false;
  const ownedContext = ownerId ? { ...context, ownerId } : context;
  const mutationAuthority = repairRegistration && ownerId ? normalizeHudMutationAuthority({
    leaderPaneId: context.leaderPaneId,
    leaderPanePid: context.leaderPanePid,
    ownerId,
  }) ?? undefined : undefined;
  if (repairRegistration && !mutationAuthority) return false;
  const tmuxBin = resolveTmuxBinaryForPlatform() || 'tmux';
  const height = String(Math.max(1, Math.floor(heightLines)));
  const registrationCwd = options.cwd?.trim() || process.cwd();
  const resizeCmd = shellEscapeSingle(buildHudResizeHookCommand(tmuxBin, canonicalHudPaneId, height, ownedContext, options.env?.TMUX));
  const omxBin = resolveOmxCliEntryPath({ cwd: options.cwd, env: options.env });
  try {
    const resizeRegistrationCommand = `run-shell -b ${resizeCmd}`;
    if (mutationAuthority) {
      if (!executeHudCommandUnderAuthority(
        mutationAuthority,
        buildHudHookRegistrationCommand(
          ['-t', ownedContext.sessionId],
          ownedContext.hookSlot,
          resizeRegistrationCommand,
          ownedContext,
          Number(height),
          registrationCwd,
        ),
        execTmuxSync,
      )) return false;
    } else {
      execTmuxSync(['set-hook', '-t', ownedContext.sessionId, ownedContext.hookSlot, resizeRegistrationCommand, ...buildHudHookRegistrationSuffix(ownedContext, ownedContext.hookSlot, Number(height), registrationCwd)]);
    }
    unregisterLegacyHudResizeHook(ownedContext, execTmuxSync);
  } catch {
    return false;
  }
  if (omxBin) {
    try {
      for (const hookSlot of [ownedContext.splitHookSlot, ownedContext.layoutHookSlot]) {
        const reconcileCmd = shellEscapeSingle(
          buildHudLayoutReconcileHookCommand(tmuxBin, omxBin, canonicalLeaderPaneId, ownedContext, hookSlot, options),
        );
        const targetArgs = hookSlot === ownedContext.layoutHookSlot
          ? ['-w', '-t', ownedContext.windowId]
          : ['-t', ownedContext.sessionId];
        const registrationCommand = `run-shell -b ${reconcileCmd}`;
        if (mutationAuthority) {
          if (!executeHudCommandUnderAuthority(
            mutationAuthority,
            buildHudHookRegistrationCommand(targetArgs, hookSlot, registrationCommand, ownedContext, Number(height), registrationCwd),
            execTmuxSync,
          )) return false;
        } else {
          execTmuxSync(['set-hook', ...targetArgs, hookSlot, registrationCommand, ...buildHudHookRegistrationSuffix(ownedContext, hookSlot, Number(height), registrationCwd)]);
        }
      }
    } catch {
      // Keep the resize hook installed so older tmux builds still recover on
      // client resize even when layout-change hook registration is unavailable.
      return false;
    }
  }
  return true;
}

export function isHudOwnerCurrent(
  leaderPaneId: string,
  expectedOwnerId: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const paneId = parseCanonicalTmuxPaneId(leaderPaneId);
  const ownerId = expectedOwnerId.trim();
  if (!paneId || !ownerId) return false;
  try {
    const observedOwner = parseExactTmuxAuthorityScalar(execTmuxSync([
      'display-message', '-p', '-t', paneId, '#{@omx_instance_id}',
    ]));
    return !observedOwner || observedOwner === ownerId;
  } catch {
    return false;
  }
}

export function unregisterHudResizeHook(
  leaderPaneId: string | undefined,
  authorityOrExecTmuxSync?: HudTmuxMutationAuthority | TmuxExecSync,
  maybeExecTmuxSync?: TmuxExecSync,
): boolean {
  const authority = typeof authorityOrExecTmuxSync === 'function' ? undefined : authorityOrExecTmuxSync;
  const execTmuxSync = typeof authorityOrExecTmuxSync === 'function'
    ? authorityOrExecTmuxSync
    : (maybeExecTmuxSync ?? defaultExecTmuxSync);
  const canonicalLeaderPaneId = parseCanonicalTmuxPaneId(leaderPaneId);
  const normalizedAuthority = authority ? normalizeHudMutationAuthority(authority) ?? undefined : undefined;
  if (
    !canonicalLeaderPaneId
    || (authority && !normalizedAuthority)
    || (normalizedAuthority && normalizedAuthority.leaderPaneId !== canonicalLeaderPaneId)
  ) return false;
  let contextOutput: string;
  try {
    contextOutput = execTmuxSync(['display-message', '-p', '-t', canonicalLeaderPaneId, '#{session_id}|#{window_id}']);
  } catch {
    return false;
  }
  const context = parseHudResizeHookContext(
    contextOutput,
    canonicalLeaderPaneId,
    canonicalLeaderPaneId,
    { leaderPanePid: '1', hudPanePid: '1' },
  );
  if (!context) return false;
  let ok = true;
  try {
    unregisterLegacyHudResizeHook(context, execTmuxSync);
    const marker = `__omx_hud_unregister_${randomUUID()}`;
    if (parseExactTmuxAuthorityScalar(execTmuxSync(
      buildGuardedHudHookUnregisterArgs(context, context.hookSlot, marker, normalizedAuthority),
    )) !== marker) ok = false;
  } catch {
    ok = false;
  }
  for (const hookSlot of [context.splitHookSlot, context.layoutHookSlot]) {
    try {
      const marker = `__omx_hud_unregister_${randomUUID()}`;
      if (parseExactTmuxAuthorityScalar(execTmuxSync(
        buildGuardedHudHookUnregisterArgs(context, hookSlot, marker, normalizedAuthority),
      )) !== marker) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok;
}
