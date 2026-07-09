import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { parsePaneIdFromTmuxOutput, shellEscapeSingle } from '../hud/tmux.js';
import { buildSendPaneArgvs } from '../notifications/tmux-detector.js';
import { sleepSync } from '../utils/sleep.js';
import { sanitizeReplyInput } from '../notifications/reply-listener.js';
import { getCurrentTmuxPaneId } from '../notifications/tmux.js';
import { getStateDir, getStatePath } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from '../state/workflow-transition.js';
import { isRunningUnderCmux, resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import { createInitialInteractiveSelectionState, createInitialQuestionWizardState, renderInteractiveQuestionFrame, renderQuestionWizardFrame } from './ui.js';
import type { NormalizedQuestionItem, QuestionAnswer, QuestionRecord, QuestionRendererState } from './types.js';

export type QuestionRendererStrategy = 'inside-tmux' | 'detached-tmux' | 'inline-tty' | 'windows-console' | 'windows-psmux-shell-pane' | 'test-noop' | 'unsupported';


export interface LaunchQuestionRendererOptions {
  cwd: string;
  recordPath: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export type ExecTmuxSync = (args: string[]) => string;
export type SleepSync = (ms: number) => void;
export type SpawnDetachedRenderer = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'pid' | 'unref'>;

const QUESTION_TEXT_SETTLE_MS = 120;
const QUESTION_SUBMIT_REPEAT_DELAY_MS = 100;
const QUESTION_RENDERER_PANE_SETTLE_MS = 120;
const QUESTION_RENDERER_SESSION_SETTLE_MS = 120;

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isPaneId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^%\d+$/.test(value.trim());
}

function hasExplicitQuestionPaneTarget(env: NodeJS.ProcessEnv): boolean {
  return isPaneId(safeString(env.OMX_QUESTION_RETURN_PANE || env.OMX_LEADER_PANE_ID).trim());
}

function hasInteractiveQuestionTty(options?: {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}): boolean {
  const stdinIsTTY = options?.stdinIsTTY ?? Boolean(processStdin.isTTY);
  const stdoutIsTTY = options?.stdoutIsTTY ?? Boolean(processStdout.isTTY);
  return stdinIsTTY && stdoutIsTTY;
}

function hasNativeWindowsPsmuxBridge(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32') return false;
  const tmux = safeString(env.TMUX).trim().toLowerCase();
  if (!tmux) return false;
  const tmuxPane = safeString(env.TMUX_PANE).trim();
  return tmux.includes('psmux') || isPaneId(tmuxPane);
}

function hasWindowsConsoleReturnBridge(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32') return false;
  return hasExplicitQuestionPaneTarget(env);
}


export function resolveQuestionRendererStrategy(
  env: NodeJS.ProcessEnv = process.env,
  // Kept for callers/tests that used to pass detected tmux availability; default
  // strategy selection now depends only on renderer visibility signals.
  _tmuxBinary?: string | null,
  options?: {
    cwd?: string;
    sessionId?: string;
    platform?: NodeJS.Platform;
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
  },
): QuestionRendererStrategy {
  const platform = options?.platform ?? process.platform;
  if (safeString(env.OMX_QUESTION_TEST_RENDERER).trim() === 'noop') return 'test-noop';
  if (hasNativeWindowsPsmuxBridge(env, platform)) return 'windows-psmux-shell-pane';
  if (hasWindowsConsoleReturnBridge(env, platform)) return 'windows-console';
  if (safeString(env.TMUX).trim() !== '') return 'inside-tmux';
  if (hasExplicitQuestionPaneTarget(env)) return 'inside-tmux';
  if (options?.cwd && readPersistedQuestionReturnTarget(options.cwd, options.sessionId)) return 'inside-tmux';
  if (platform === 'win32' && hasInteractiveQuestionTty(options)) {
    return 'inline-tty';
  }
  return 'unsupported';
}


function isCombiningMark(codePoint: number): boolean {
  return /\p{Mark}/u.test(String.fromCodePoint(codePoint));
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) continue;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (isCombiningMark(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function wrappedDisplayLineCount(value: string | undefined, paneWidth: number): number {
  if (!value) return 0;
  const safeWidth = Number.isFinite(paneWidth) && paneWidth > 0 ? Math.floor(paneWidth) : 80;
  return value
    .split('\n')
    .reduce((count, line) => count + Math.max(1, Math.ceil(displayWidth(line) / safeWidth)), 0);
}

export function estimateQuestionRenderFootprint(
  record: QuestionRecord | null | undefined,
  paneWidth: number,
): number {
  if (!record) return 24;
  const questions = recordQuestionsForSizing(record);
  if (questions.length === 1) {
    const frame = renderInteractiveQuestionFrame(record, createInitialInteractiveSelectionState());
    return wrappedDisplayLineCount(frame, paneWidth);
  }

  const wizardState = buildWorstCaseReviewWizardState(record);
  let maxFootprint = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const frame = renderQuestionWizardFrame(record, { ...wizardState, currentQuestionIndex: index });
    maxFootprint = Math.max(maxFootprint, wrappedDisplayLineCount(frame, paneWidth));
  }
  const reviewFrame = renderQuestionWizardFrame(record, { ...wizardState, mode: 'review' as const });
  maxFootprint = Math.max(maxFootprint, wrappedDisplayLineCount(reviewFrame, paneWidth));
  return maxFootprint;
}

export function computeAdaptiveQuestionPaneHeight(availableHeight: number, estimatedContentLines: number): number {
  const safeAvailable = Number.isFinite(availableHeight) && availableHeight > 0 ? Math.floor(availableHeight) : 40;
  const maxHeight = Math.max(1, safeAvailable - 2);
  const minLarge = Math.min(Math.max(18, Math.floor(safeAvailable * 0.60)), maxHeight);
  const requested = Number.isFinite(estimatedContentLines) && estimatedContentLines > 0 ? Math.ceil(estimatedContentLines) : 24;
  return Math.min(Math.max(Math.max(requested, minLarge), Math.min(8, maxHeight)), maxHeight);
}

export function shouldOpenQuestionInNewWindow(availableHeight: number, estimatedRenderFootprint: number): boolean {
  const safeAvailable = Number.isFinite(availableHeight) && availableHeight > 0 ? Math.floor(availableHeight) : 40;
  const maxSplitHeight = Math.max(1, safeAvailable - 2);
  const requested = Number.isFinite(estimatedRenderFootprint) && estimatedRenderFootprint > 0 ? Math.ceil(estimatedRenderFootprint) : 24;
  return requested > maxSplitHeight;
}

function readQuestionRecordForSizing(recordPath: string): QuestionRecord | null {
  return readJsonFileIfExists(recordPath) as QuestionRecord | null;
}

function recordQuestionsForSizing(record: QuestionRecord): NormalizedQuestionItem[] {
  if (record.questions?.length) return record.questions;
  return [{
    header: record.header,
    question: record.question,
    options: record.options,
    allow_other: record.allow_other,
    other_label: record.other_label,
    multi_select: record.multi_select,
    type: record.type ?? (record.multi_select ? 'multi-answerable' : 'single-answerable'),
    id: 'q-1',
  }];
}

function buildWorstCaseReviewWizardState(record: QuestionRecord) {
  const questions = recordQuestionsForSizing(record);
  const baseState = createInitialQuestionWizardState(record);
  return {
    ...baseState,
    selections: questions.map((question) => {
      if (question.multi_select || question.type === 'multi-answerable') {
        return {
          cursorIndex: 0,
          selectedIndices: question.options.map((_, index) => index),
        };
      }

      let bestIndex = 0;
      let bestWidth = -1;
      question.options.forEach((option, index) => {
        const width = displayWidth(option.label);
        if (width > bestWidth) {
          bestWidth = width;
          bestIndex = index;
        }
      });
      return {
        cursorIndex: bestIndex,
        selectedIndices: [],
      };
    }),
  };
}

function resolveAvailablePaneHeight(
  execTmux: ExecTmuxSync,
  target: string | undefined,
): number {
  const format = '#{pane_height}';
  const attempts = target ? [['display-message', '-p', '-t', target, format], ['display-message', '-p', format]] : [['display-message', '-p', format]];
  for (const args of attempts) {
    try {
      const parsed = Number.parseInt(execTmux(args).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // Try the next source, then fall back.
    }
  }
  return 40;
}

function resolveAvailablePaneWidth(
  execTmux: ExecTmuxSync,
  target: string | undefined,
): { width: number; probeFailed: boolean } {
  const format = '#{pane_width}';
  if (target) {
    try {
      const parsed = Number.parseInt(execTmux(['display-message', '-p', '-t', target, format]).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return { width: parsed, probeFailed: false };
    } catch {
      // Keep the width probe target-scoped. If the explicit target cannot be
      // queried, fall back to the conservative default instead of measuring the
      // current pane width for a different destination.
    }
    return { width: 80, probeFailed: true };
  }
  try {
    const parsed = Number.parseInt(execTmux(['display-message', '-p', format]).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return { width: parsed, probeFailed: false };
  } catch {
    // Try the default tmux query, then fall back.
  }
  // Keep a documented fallback so renderer launches remain usable even when
  // tmux width probing is unavailable or transiently fails.
  return { width: 80, probeFailed: false };
}

function resolveNewWindowTarget(
  execTmux: ExecTmuxSync,
  returnTarget: string | undefined,
): string | undefined {
  if (!returnTarget) return undefined;

  const attempts = [
    ['display-message', '-p', '-t', returnTarget, '#{session_id}'],
    ['display-message', '-p', '-t', returnTarget, '#{window_id}'],
  ] as const;

  for (const args of attempts) {
    try {
      const resolved = execTmux([...args]).trim();
      if (resolved) return resolved;
    } catch {
      // Try the next tmux target form.
    }
  }

  return undefined;
}

function launchQuestionPane(
  execTmux: ExecTmuxSync,
  sleepImpl: SleepSync,
  args: string[],
  launchedAt: string,
  returnTarget: string | undefined,
): {
  renderer: 'tmux-pane';
  target: string;
  launched_at: string;
  return_target?: string;
  return_transport?: 'tmux-send-keys';
} {
  const rawPane = execTmux(args);
  const paneId = parsePaneIdFromTmuxOutput(rawPane);
  if (!paneId) throw new Error('Failed to create tmux question renderer container.');
  sleepImpl(QUESTION_RENDERER_PANE_SETTLE_MS);
  if (!isLaunchedQuestionPaneAlive(paneId, execTmux)) {
    throw new Error(`Question UI pane ${paneId} disappeared immediately after launch.`);
  }
  return {
    renderer: 'tmux-pane',
    target: paneId,
    launched_at: launchedAt,
    ...(returnTarget ? { return_target: returnTarget, return_transport: 'tmux-send-keys' as const } : {}),
  };
}

function resolveQuestionUiProcessArgs(
  recordPath: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): string[] {
  const omxBin = resolveOmxCliEntryPath({
    argv1: process.argv[1],
    cwd: options.cwd,
    env: options.env,
  }) || process.argv[1];
  if (!omxBin) throw new Error('Unable to resolve OMX CLI entry path for question UI launch.');
  return [omxBin, 'question', '--ui', '--state-path', recordPath];
}

export function buildQuestionUiTmuxArgs(
  recordPath: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
    returnTarget?: string;
    underCmux?: boolean;
  },
): string[] {
  const envEntries: Array<[string, string]> = [];
  if (options.sessionId) envEntries.push(['OMX_SESSION_ID', options.sessionId]);
  if (options.returnTarget) {
    envEntries.push(['OMX_QUESTION_RETURN_TARGET', options.returnTarget]);
    envEntries.push(['OMX_QUESTION_RETURN_TRANSPORT', 'tmux-send-keys']);
  }
  const command = [process.execPath, ...resolveQuestionUiProcessArgs(recordPath, options)];

  if (options.underCmux) {
    // cmux's tmux-compat shim does not consume `split-window -e KEY=VALUE`; it leaks
    // the flags into the spawned pane's shell command, which fails with
    // `command not found: -e`. Deliver env through an `env KEY=VALUE ...` prefix on
    // the pane command instead.
    //
    // Two properties keep this robust:
    //  1. `env` (not an `export ... &&` prefix) is shell-neutral. The pane shell may
    //     be fish or another non-POSIX shell where `export FOO=bar` is a syntax error
    //     parsed before node ever starts; `env FOO=bar cmd` is just arguments to the
    //     external `env` binary and works in every shell.
    //  2. The command is returned as a SINGLE shell-command argument. tmux runs a
    //     one-argument command through the shell, so this stays correct on both the
    //     cmux shim (which prepends `cd -- '<cwd>' &&` from `-c`) and a real tmux that
    //     happens to inherit cmux env vars (e.g. a nested native tmux), where it runs
    //     via `sh -c`. Multiple arguments would instead be exec'd directly with the
    //     single quotes intact. Every value and command token is single-quoted to
    //     survive shell word-splitting.
    const envPrefix = envEntries.length > 0
      ? `env ${envEntries.map(([key, value]) => `${key}=${shellEscapeSingle(value)}`).join(' ')} `
      : '';
    return [envPrefix + command.map((token) => shellEscapeSingle(token)).join(' ')];
  }

  return [
    ...envEntries.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...command,
  ];
}

function buildQuestionUiProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: {
    sessionId?: string;
    returnTarget?: string;
  },
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(options.sessionId ? { OMX_SESSION_ID: options.sessionId } : {}),
    ...(options.returnTarget ? {
      OMX_QUESTION_RETURN_TARGET: options.returnTarget,
      OMX_QUESTION_RETURN_TRANSPORT: 'tmux-send-keys',
    } : {}),
  };
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildWindowsConsoleStartCommand(command: string, args: string[]): string {
  return [
    'start',
    '"OMX Question"',
    '/wait',
    quoteCmdArg(command),
    ...args.map(quoteCmdArg),
  ].join(' ');
}

function quoteWindowsInteractiveCmdArg(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function buildWindowsPsmuxQuestionUiCommand(
  recordPath: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
    returnTarget?: string;
  },
): string {
  const envEntries: Array<[string, string]> = [];
  if (options.sessionId) envEntries.push(['OMX_SESSION_ID', options.sessionId]);
  if (options.returnTarget) {
    envEntries.push(['OMX_QUESTION_RETURN_TARGET', options.returnTarget]);
    envEntries.push(['OMX_QUESTION_RETURN_TRANSPORT', 'tmux-send-keys']);
  }
  const envPrefix = envEntries.map(([key, value]) => `set "${key}=${value.replace(/%/g, '%%').replace(/"/g, '""')}"`).join(' && ');
  const command = [process.execPath, ...resolveQuestionUiProcessArgs(recordPath, options)]
    .map((token) => quoteWindowsInteractiveCmdArg(token))
    .join(' ');
  return envPrefix ? `${envPrefix} && ${command}` : command;
}

function launchWindowsPsmuxShellQuestionPane(
  execTmux: ExecTmuxSync,
  sleepImpl: SleepSync,
  recordPath: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
    returnTarget?: string;
    launchedAt: string;
  },
): QuestionRendererState {
  const rawPane = execTmux([
    'new-window',
    '-n',
    'OMX Question',
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    options.cwd,
  ]);
  const paneId = parsePaneIdFromTmuxOutput(rawPane);
  if (!paneId) throw new Error('Failed to create psmux question renderer shell pane.');
  sleepImpl(QUESTION_RENDERER_PANE_SETTLE_MS);
  if (!isLaunchedQuestionPaneAlive(paneId, execTmux)) {
    throw new Error(`Question UI psmux pane ${paneId} disappeared immediately after launch.`);
  }

  const command = buildWindowsPsmuxQuestionUiCommand(recordPath, options);
  for (const argv of buildSendPaneArgvs(paneId, command, false)) {
    execTmux(argv);
  }
  sleepImpl(QUESTION_TEXT_SETTLE_MS);
  execTmux(['send-keys', '-t', paneId, 'C-m']);

  return {
    renderer: 'tmux-pane',
    target: paneId,
    launched_at: options.launchedAt,
    ...(options.returnTarget ? { return_target: options.returnTarget, return_transport: 'tmux-send-keys' as const } : {}),
  };
}

function defaultSpawnDetachedRenderer(command: string, args: string[], options: SpawnOptions): Pick<ChildProcess, 'pid' | 'unref'> {
  return spawn(command, args, options);
}

function defaultExecTmux(args: string[]): string {
  const tmux = resolveTmuxBinaryForPlatform();
  if (!tmux) throw new Error('tmux is unavailable; omx question requires tmux for OMX-owned question UI rendering.');
  return execFileSync(tmux, args, {
    encoding: 'utf-8',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
}

function readJsonFileIfExists(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readPersistedQuestionReturnTarget(
  cwd: string,
  sessionId?: string,
): string | undefined {
  const candidatePaths: string[] = [];
  if (sessionId) {
    for (const mode of TRACKED_WORKFLOW_MODES) {
      try {
        candidatePaths.push(getStatePath(mode, cwd, sessionId));
      } catch {
        // Ignore invalid/absent state scopes and keep best-effort fallbacks.
      }
    }
  }
  for (const mode of TRACKED_WORKFLOW_MODES) {
    try {
      candidatePaths.push(getStatePath(mode, cwd));
    } catch {
      // Ignore invalid/absent state scopes and keep best-effort fallbacks.
    }
  }

  const seen = new Set<string>();
  for (const path of candidatePaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const state = readJsonFileIfExists(path);
    if (state?.active !== true) continue;
    const pane = safeString(state.tmux_pane_id).trim();
    if (isPaneId(pane)) return pane;
  }

  return undefined;
}

function resolveReturnTarget(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
}): string | undefined {
  const env = options.env ?? process.env;
  const explicitPane = safeString(env.OMX_QUESTION_RETURN_PANE || env.OMX_LEADER_PANE_ID).trim();
  if (isPaneId(explicitPane)) return explicitPane;

  const envPane = safeString(env.TMUX_PANE).trim();
  if (isPaneId(envPane)) return envPane;

  const persistedPane = readPersistedQuestionReturnTarget(options.cwd, options.sessionId);
  if (persistedPane) return persistedPane;

  const detectedPane = getCurrentTmuxPaneId();
  return isPaneId(detectedPane) ? detectedPane : undefined;
}

function isCurrentTmuxSessionAttached(
  execTmux: ExecTmuxSync = defaultExecTmux,
  env: NodeJS.ProcessEnv = process.env,
  targetPane?: string,
): boolean {
  const paneTarget = targetPane ?? safeString(env.TMUX_PANE).trim();
  const targetArgs = isPaneId(paneTarget) ? ['-t', paneTarget] : [];
  try {
    const attached = execTmux(['display-message', '-p', ...targetArgs, '#{session_attached}']).trim();
    return Number.parseInt(attached, 10) > 0;
  } catch {
    return false;
  }
}

export function isLaunchedQuestionPaneAlive(
  paneId: string,
  execTmux: ExecTmuxSync,
): boolean {
  if (!isPaneId(paneId)) return false;
  try {
    const status = execTmux(['list-panes', '-t', paneId, '-F', '#{pane_dead}\t#{pane_id}']);
    return status
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        const [paneDead = '', resolvedPaneId = ''] = line.split('\t');
        return resolvedPaneId === paneId && paneDead !== '1';
      });
  } catch {
    return false;
  }
}

export function isLaunchedQuestionSessionAlive(
  sessionName: string,
  execTmux: ExecTmuxSync,
): boolean {
  if (!safeString(sessionName).trim()) return false;
  try {
    execTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

export function isWindowsConsoleRendererAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function isQuestionRendererAlive(
  renderer: QuestionRendererState | undefined,
  execTmux: ExecTmuxSync = defaultExecTmux,
): boolean {
  if (!renderer) return true;
  if (renderer.renderer === 'tmux-pane') return isLaunchedQuestionPaneAlive(renderer.target, execTmux);
  if (renderer.renderer === 'tmux-session') {
    if (renderer.target === 'test-noop-renderer') return true;
    return isLaunchedQuestionSessionAlive(renderer.target, execTmux);
  }
  if (renderer.renderer === 'windows-console') return isWindowsConsoleRendererAlive(renderer.pid);
  return true;
}

export function closeQuestionRenderer(
  renderer: QuestionRendererState | undefined,
  execTmux: ExecTmuxSync = defaultExecTmux,
): boolean {
  if (!renderer) return false;
  try {
    if (renderer.renderer === 'tmux-pane' && isPaneId(renderer.target)) {
      execTmux(['kill-pane', '-t', renderer.target]);
      return true;
    }
    if (renderer.renderer === 'tmux-session' && renderer.target !== 'test-noop-renderer' && safeString(renderer.target).trim()) {
      execTmux(['kill-session', '-t', renderer.target]);
      return true;
    }
    if (renderer.renderer === 'windows-console') {
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

export function formatQuestionAnswerForInjection(answer: QuestionAnswer): string {
  const prefix = '[omx question answered]';
  if (answer.kind === 'other') {
    return sanitizeReplyInput(`${prefix} ${answer.other_text ?? String(answer.value)}`);
  }
  if (answer.kind === 'multi') {
    const raw = Array.isArray(answer.value) ? answer.value.join(', ') : String(answer.value);
    return sanitizeReplyInput(`${prefix} ${raw}`);
  }
  return sanitizeReplyInput(`${prefix} ${String(answer.value)}`);
}

export function formatQuestionAnswersForInjection(answers: Array<{ question_id: string; answer: QuestionAnswer }>): string {
  const prefix = '[omx question answered]';
  const body = answers
    .map((entry) => {
      const value = Array.isArray(entry.answer.value) ? entry.answer.value.join(', ') : String(entry.answer.value);
      return `${entry.question_id}: ${value}`;
    })
    .join('; ');
  return sanitizeReplyInput(`${prefix} ${body}`);
}

export function injectQuestionAnswerToPane(
  paneId: string,
  answer: QuestionAnswer,
  execTmux: ExecTmuxSync = defaultExecTmux,
  sleepImpl: SleepSync = sleepSync,
): boolean {
  if (!isPaneId(paneId)) return false;
  const text = formatQuestionAnswerForInjection(answer);
  if (!text) return false;

  const argvs = buildSendPaneArgvs(paneId, text, true);
  for (const [index, argv] of argvs.entries()) {
    execTmux(argv);
    const hasNextArgv = index < argvs.length - 1;
    if (!hasNextArgv) continue;
    sleepImpl(index === 0 ? QUESTION_TEXT_SETTLE_MS : QUESTION_SUBMIT_REPEAT_DELAY_MS);
  }
  return true;
}

export function injectQuestionAnswersToPane(
  paneId: string,
  answers: Array<{ question_id: string; answer: QuestionAnswer }>,
  execTmux: ExecTmuxSync = defaultExecTmux,
  sleepImpl: SleepSync = sleepSync,
): boolean {
  if (!isPaneId(paneId) || answers.length === 0) return false;
  if (answers.length === 1) return injectQuestionAnswerToPane(paneId, answers[0]!.answer, execTmux, sleepImpl);
  const text = formatQuestionAnswersForInjection(answers);
  if (!text) return false;

  const argvs = buildSendPaneArgvs(paneId, text, true);
  for (const [index, argv] of argvs.entries()) {
    execTmux(argv);
    const hasNextArgv = index < argvs.length - 1;
    if (!hasNextArgv) continue;
    sleepImpl(index === 0 ? QUESTION_TEXT_SETTLE_MS : QUESTION_SUBMIT_REPEAT_DELAY_MS);
  }
  return true;
}


export interface LiveQuestionRecord {
  recordPath: string;
  record: QuestionRecord;
}

function getQuestionStateDirForRenderer(cwd: string, sessionId?: string): string {
  return join(getStateDir(cwd, sessionId), 'questions');
}

function isQuestionRecord(value: unknown): value is QuestionRecord {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as { kind?: unknown }).kind === 'omx.question/v1'
      && typeof (value as { question_id?: unknown }).question_id === 'string',
  );
}

function writeQuestionRecordSync(recordPath: string, record: QuestionRecord): void {
  const tempPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, recordPath);
}

export function findLiveQuestionsForSession(
  cwd: string,
  sessionId: string | undefined,
  execTmux: ExecTmuxSync = defaultExecTmux,
  options: { excludeRecordPath?: string } = {},
): LiveQuestionRecord[] {
  const questionsDir = getQuestionStateDirForRenderer(cwd, sessionId);
  if (!existsSync(questionsDir)) return [];
  const live: LiveQuestionRecord[] = [];
  const excludeRecordPath = options.excludeRecordPath;
  for (const entry of readdirSync(questionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const recordPath = join(questionsDir, entry.name);
    if (excludeRecordPath && recordPath === excludeRecordPath) continue;
    const record = readJsonFileIfExists(recordPath);
    if (!isQuestionRecord(record)) continue;
    if (record.status !== 'prompting') continue;
    if (!isQuestionRendererAlive(record.renderer, execTmux)) continue;
    live.push({ recordPath, record });
  }
  return live.sort((left, right) => left.record.created_at.localeCompare(right.record.created_at));
}

export function supersedeLiveQuestionsForSession(
  cwd: string,
  sessionId: string | undefined,
  execTmux: ExecTmuxSync = defaultExecTmux,
  options: { excludeRecordPath?: string; nowIso?: string } = {},
): LiveQuestionRecord[] {
  const live = findLiveQuestionsForSession(cwd, sessionId, execTmux, options);
  const nowIso = options.nowIso ?? new Date().toISOString();
  for (const item of live) {
    writeQuestionRecordSync(item.recordPath, {
      ...item.record,
      status: 'superseded',
      updated_at: nowIso,
      error: {
        code: 'question_superseded',
        message: 'Question was superseded by a newer omx question launch for the same session.',
        at: nowIso,
      },
    });
    closeQuestionRenderer(item.record.renderer, execTmux);
  }
  return live;
}

export function launchQuestionRenderer(
  options: LaunchQuestionRendererOptions,
  deps: {
    strategy?: QuestionRendererStrategy;
    execTmux?: ExecTmuxSync;
    sleepSync?: SleepSync;
    spawnDetachedRenderer?: SpawnDetachedRenderer;
  } = {},
): QuestionRendererState {
  const strategy = deps.strategy ?? resolveQuestionRendererStrategy(options.env ?? process.env, undefined, {
    cwd: options.cwd,
    sessionId: options.sessionId,
    platform: options.platform,
    stdinIsTTY: options.stdinIsTTY,
    stdoutIsTTY: options.stdoutIsTTY,
  });
  const execTmux = deps.execTmux ?? defaultExecTmux;
  const sleepImpl = deps.sleepSync ?? sleepSync;
  const spawnDetachedRenderer = deps.spawnDetachedRenderer ?? defaultSpawnDetachedRenderer;
  const launchedAt = options.nowIso ?? new Date().toISOString();
  const env = options.env ?? process.env;

  if (strategy === 'unsupported') {
    throw new Error(
      'omx question cannot open a visible renderer because this process is outside an attached tmux pane and has no explicit tmux return bridge. Codex App/outside-tmux sessions need an attached tmux OMX CLI session or OMX_QUESTION_RETURN_PANE bridge. Run omx question from inside tmux.',
    );
  }

  const returnTarget = resolveReturnTarget({
    cwd: options.cwd,
    env,
    sessionId: options.sessionId,
  });
  const commandArgs = buildQuestionUiTmuxArgs(options.recordPath, {
    cwd: options.cwd,
    env: options.env,
    sessionId: options.sessionId,
    returnTarget,
    underCmux: isRunningUnderCmux(env),
  });

  if (strategy === 'windows-psmux-shell-pane') {
    supersedeLiveQuestionsForSession(options.cwd, options.sessionId, execTmux, {
      excludeRecordPath: options.recordPath,
      nowIso: launchedAt,
    });
    return launchWindowsPsmuxShellQuestionPane(execTmux, sleepImpl, options.recordPath, {
      cwd: options.cwd,
      env: options.env,
      sessionId: options.sessionId,
      returnTarget,
      launchedAt,
    });
  }

  if (strategy === 'inside-tmux') {
    const splitTarget = returnTarget ? ['-t', returnTarget] : [];
    const attachedCheckTarget = safeString(env.TMUX).trim()
      ? returnTarget || safeString(env.TMUX_PANE).trim() || undefined
      : undefined;
    if (safeString(env.TMUX).trim() && !isCurrentTmuxSessionAttached(execTmux, env, attachedCheckTarget)) {
      throw new Error(
        'omx question cannot open a visible renderer because this tmux session has no attached client. Run omx question from an attached tmux pane.',
      );
    }

    supersedeLiveQuestionsForSession(options.cwd, options.sessionId, execTmux, {
      excludeRecordPath: options.recordPath,
      nowIso: launchedAt,
    });

    const sizingTarget = returnTarget || safeString(env.TMUX_PANE).trim() || undefined;
    const availableWidthInfo = resolveAvailablePaneWidth(execTmux, sizingTarget);
    const newWindowTarget = resolveNewWindowTarget(execTmux, returnTarget);
    const newWindowTargetArgs = newWindowTarget ? ['-t', newWindowTarget] : [];
    if (sizingTarget && availableWidthInfo.probeFailed) {
      return launchQuestionPane(
        execTmux,
        sleepImpl,
        [
          'new-window',
          '-n',
          'OMX Question',
          ...newWindowTargetArgs,
          '-P',
          '-F',
          '#{pane_id}',
          '-c',
          options.cwd,
          ...commandArgs,
        ],
        launchedAt,
        returnTarget,
      );
    }

    const availableHeight = resolveAvailablePaneHeight(execTmux, sizingTarget);
    const availableWidth = availableWidthInfo.width;
    const estimatedRenderFootprint = estimateQuestionRenderFootprint(
      readQuestionRecordForSizing(options.recordPath),
      availableWidth,
    );
    const questionNeedsFullWindow = shouldOpenQuestionInNewWindow(
      availableHeight,
      estimatedRenderFootprint,
    );
    const requestedHeight = computeAdaptiveQuestionPaneHeight(
      availableHeight,
      estimatedRenderFootprint,
    );
    return launchQuestionPane(
      execTmux,
      sleepImpl,
      questionNeedsFullWindow
        ? [
            'new-window',
            '-n',
            'OMX Question',
            ...newWindowTargetArgs,
            '-P',
            '-F',
            '#{pane_id}',
            '-c',
            options.cwd,
            ...commandArgs,
          ]
        : [
            'split-window',
            '-v',
            '-l',
            String(requestedHeight),
            ...splitTarget,
            '-P',
            '-F',
            '#{pane_id}',
            '-c',
            options.cwd,
            ...commandArgs,
          ],
      launchedAt,
      returnTarget,
    );
  }

  if (strategy === 'windows-console') {
    const uiArgs = resolveQuestionUiProcessArgs(options.recordPath, { cwd: options.cwd, env: options.env });
    const child = spawnDetachedRenderer(
      env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', buildWindowsConsoleStartCommand(process.execPath, uiArgs)],
      {
        cwd: options.cwd,
        env: buildQuestionUiProcessEnv(env, { sessionId: options.sessionId, returnTarget }),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
    return {
      renderer: 'windows-console',
      target: child.pid ? `pid:${child.pid}` : 'windows-console',
      launched_at: launchedAt,
      ...(Number.isInteger(child.pid) ? { pid: child.pid } : {}),
      ...(returnTarget ? { return_target: returnTarget, return_transport: 'tmux-send-keys' } : {}),
    };
  }

  if (strategy === 'inline-tty') {
    return {
      renderer: 'inline-tty',
      target: 'inline-tty',
      launched_at: launchedAt,
    };
  }

  if (strategy === 'detached-tmux') {
    supersedeLiveQuestionsForSession(options.cwd, options.sessionId, execTmux, {
      excludeRecordPath: options.recordPath,
      nowIso: launchedAt,
    });
    const baseName = basename(options.recordPath, '.json').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || 'question';
    const sessionName = `omx-question-${baseName}`;
    const output = execTmux([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{session_name}',
      '-s',
      sessionName,
      '-c',
      options.cwd,
      ...commandArgs,
    ]).trim();
    const target = output || sessionName;
    sleepImpl(QUESTION_RENDERER_SESSION_SETTLE_MS);
    if (!isLaunchedQuestionSessionAlive(target, execTmux)) {
      throw new Error(`Question UI session ${target} disappeared immediately after launch.`);
    }
    return {
      renderer: 'tmux-session',
      target,
      launched_at: launchedAt,
    };
  }

  if (strategy === 'test-noop') {
    return {
      renderer: 'tmux-session',
      target: 'test-noop-renderer',
      launched_at: launchedAt,
    };
  }

  const exhaustiveStrategy: never = strategy;
  throw new Error(`Unsupported omx question renderer strategy: ${exhaustiveStrategy}`);
}
