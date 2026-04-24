import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parsePaneIdFromTmuxOutput } from '../hud/tmux.js';
import { buildSendPaneArgvs } from '../notifications/tmux-detector.js';
import { sleepSync } from '../utils/sleep.js';
import { sanitizeReplyInput } from '../notifications/reply-listener.js';
import { getCurrentTmuxPaneId } from '../notifications/tmux.js';
import { getStatePath } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from '../state/workflow-transition.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import type { QuestionAnswer, QuestionRendererState } from './types.js';

export type QuestionRendererStrategy = 'inside-tmux' | 'detached-tmux' | 'test-noop' | 'unsupported';

export interface LaunchQuestionRendererOptions {
  cwd: string;
  recordPath: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
}

export type ExecTmuxSync = (args: string[]) => string;
export type SleepSync = (ms: number) => void;

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

export function resolveQuestionRendererStrategy(
  env: NodeJS.ProcessEnv = process.env,
  // Kept for callers/tests that used to pass detected tmux availability; default
  // strategy selection now depends only on renderer visibility signals.
  _tmuxBinary?: string | null,
  options?: {
    cwd?: string;
    sessionId?: string;
  },
): QuestionRendererStrategy {
  if (safeString(env.OMX_QUESTION_TEST_RENDERER).trim() === 'noop') return 'test-noop';
  if (safeString(env.TMUX).trim() !== '') return 'inside-tmux';
  if (hasExplicitQuestionPaneTarget(env)) return 'inside-tmux';
  if (options?.cwd && readPersistedQuestionReturnTarget(options.cwd, options.sessionId)) return 'inside-tmux';
  return 'unsupported';
}

function buildQuestionUiTmuxArgs(
  recordPath: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
    returnTarget?: string;
  },
): string[] {
  const omxBin = resolveOmxCliEntryPath({
    argv1: process.argv[1],
    cwd: options.cwd,
    env: options.env,
  }) || process.argv[1];
  if (!omxBin) throw new Error('Unable to resolve OMX CLI entry path for question UI launch.');
  return [
    ...(options.sessionId ? ['-e', `OMX_SESSION_ID=${options.sessionId}`] : []),
    ...(options.returnTarget ? [
      '-e',
      `OMX_QUESTION_RETURN_TARGET=${options.returnTarget}`,
      '-e',
      'OMX_QUESTION_RETURN_TRANSPORT=tmux-send-keys',
    ] : []),
    process.execPath,
    omxBin,
    'question',
    '--ui',
    '--state-path',
    recordPath,
  ];
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
): boolean {
  const paneTarget = safeString(env.TMUX_PANE).trim();
  const targetArgs = isPaneId(paneTarget) ? ['-t', paneTarget] : [];
  try {
    const attached = execTmux(['display-message', '-p', ...targetArgs, '#{session_attached}']).trim();
    return Number.parseInt(attached, 10) > 0;
  } catch {
    return false;
  }
}

function isLaunchedQuestionPaneAlive(
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

function isLaunchedQuestionSessionAlive(
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

export function launchQuestionRenderer(
  options: LaunchQuestionRendererOptions,
  deps: {
    strategy?: QuestionRendererStrategy;
    execTmux?: ExecTmuxSync;
    sleepSync?: SleepSync;
  } = {},
): QuestionRendererState {
  const strategy = deps.strategy ?? resolveQuestionRendererStrategy(options.env ?? process.env, undefined, {
    cwd: options.cwd,
    sessionId: options.sessionId,
  });
  const execTmux = deps.execTmux ?? defaultExecTmux;
  const sleepImpl = deps.sleepSync ?? sleepSync;
  const launchedAt = options.nowIso ?? new Date().toISOString();
  const env = options.env ?? process.env;

  if (strategy === 'unsupported') {
    throw new Error(
      'omx question cannot open a visible renderer because this process is not running inside an attached tmux pane. Run omx question from inside tmux.',
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
  });

  if (strategy === 'inside-tmux') {
    const splitTarget = returnTarget && !safeString(env.TMUX).trim()
      ? ['-t', returnTarget]
      : [];
    if (splitTarget.length === 0 && !isCurrentTmuxSessionAttached(execTmux, env)) {
      throw new Error(
        'omx question cannot open a visible renderer because this tmux session has no attached client. Run omx question from an attached tmux pane.',
      );
    }

    const rawPane = execTmux([
      'split-window',
      '-v',
      '-l',
      '12',
      ...splitTarget,
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      options.cwd,
      ...commandArgs,
    ]);
    const paneId = parsePaneIdFromTmuxOutput(rawPane);
    if (!paneId) throw new Error('Failed to create tmux split pane for omx question UI.');
    sleepImpl(QUESTION_RENDERER_PANE_SETTLE_MS);
    if (!isLaunchedQuestionPaneAlive(paneId, execTmux)) {
      throw new Error(`Question UI pane ${paneId} disappeared immediately after launch.`);
    }
    return {
      renderer: 'tmux-pane',
      target: paneId,
      launched_at: launchedAt,
      ...(returnTarget ? { return_target: returnTarget, return_transport: 'tmux-send-keys' } : {}),
    };
  }

  if (strategy === 'detached-tmux') {
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
