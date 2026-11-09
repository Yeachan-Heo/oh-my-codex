/**
 * tmux Pane Interaction Utilities for Reply Listener
 *
 * Provides functions to capture pane content, analyze whether a pane is running
 * Codex CLI, and inject text into panes. Used by the reply-listener daemon.
 */

import { execFileSync, spawnSync } from 'child_process';
import { sleepSync } from '../utils/sleep.js';
import { resolveCommandPathForPlatform, resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { buildCapturePaneArgv as sharedBuildCapturePaneArgv } from '../scripts/tmux-hook-engine.js';
import { readExactPaneProofSync } from '../team/exact-pane.js';
import { shellEscapeSingle } from '../hud/tmux.js';

export interface ReplyPaneIdentity {
  panePid: number;
  sessionId: string;
  sessionCreated: string;
  sessionName: string;
  sessionOwner: string;
  paneOwner: string;
  paneInstanceId: string;
}

export function readReplyPaneIdentity(paneId: string, sessionId: string): ReplyPaneIdentity | null {
  const proof = readExactPaneProofSync(paneId);
  if (proof.status !== 'live') return null;
  try {
    const snapshot = execFileSync(resolveTmuxBinaryForPlatform() || 'tmux', [
      'display-message', '-p', '-t', paneId,
      '#{pane_id}\t#{pane_pid}\t#{session_id}\t#{session_created}\t#{session_name}\t#{@omx_instance_id}\t#{@omx_team_pane_owner_id}\t#{@omx_pane_instance_id}\tEND',
    ], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const fields = snapshot.split('\t');
    if (fields.length !== 9 || fields[8] !== 'END' || fields[0] !== paneId
      || Number(fields[1]) !== proof.pid || !/^\$\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])
      || !fields[4] || !/^[A-Za-z0-9_.:/-]*$/.test(fields[5]) || !/^[A-Za-z0-9_.:/-]*$/.test(fields[6])
      || !/^[A-Za-z0-9_.:/-]*$/.test(fields[7])) return null;
    // Match managed-tmux's pane-first ownership rule; a live pane alone cannot authorize an old session's reply.
    if (!sessionId || (fields[7] || fields[5]) !== sessionId) return null;
    return { panePid: proof.pid, sessionId: fields[2], sessionCreated: fields[3], sessionName: fields[4], sessionOwner: fields[5], paneOwner: fields[6], paneInstanceId: fields[7] };
  } catch {
    return null;
  }
}

export function isTmuxAvailable(): boolean {
  return resolveCommandPathForPlatform('tmux') !== null;
}

/**
 * Builds the argv array for `tmux capture-pane`.
 * Keeping args separate (never interpolated into a shell string) prevents
 * command injection through a malicious paneId value (issue #156).
 */
export function buildCapturePaneArgv(paneId: string, lines: number): string[] {
  return sharedBuildCapturePaneArgv(paneId, lines);
}

export function capturePaneContent(paneId: string, lines: number = 15): string {
  try {
    return execFileSync(resolveTmuxBinaryForPlatform() || 'tmux', buildCapturePaneArgv(paneId, lines), {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
  } catch {
    return '';
  }
}

export interface PaneAnalysis {
  hasCodex: boolean;
  hasRateLimitMessage: boolean;
  isBlocked: boolean;
  confidence: number;
}

export function analyzePaneContent(content: string): PaneAnalysis {
  const lower = content.toLowerCase();

  const hasCodex =
    lower.includes('codex') ||
    lower.includes('omx') ||
    lower.includes('oh-my-codex') ||
    lower.includes('openai');

  const hasRateLimitMessage =
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('429');

  const isBlocked =
    lower.includes('waiting') ||
    lower.includes('blocked') ||
    lower.includes('paused');

  let confidence = 0;
  if (hasCodex) confidence += 0.5;
  if (lower.includes('>') || lower.includes('$')) confidence += 0.1;
  if (lower.includes('agent') || lower.includes('task')) confidence += 0.1;
  if (content.trim().length > 0) confidence += 0.1;

  return { hasCodex, hasRateLimitMessage, isBlocked, confidence: Math.min(confidence, 1) };
}

/**
 * Builds the ordered list of tmux send-keys argv arrays needed to type text
 * into a pane and optionally submit it.
 *
 * C-m (carriage return) is always sent in its own dedicated send-keys call, never
 * bundled with the text payload. This prevents newline/submit injection: without
 * this isolation a C-m (or any other tmux key name) embedded in the text
 * could be interpreted as a key press by tmux when sent without -l (issue #107).
 *
 * @param paneId     tmux pane identifier, e.g. "%3"
 * @param text       text to type; embedded newlines are replaced with spaces
 *                   to prevent them from acting as submit keypresses when sent literally
 * @param pressEnter when true, appends two isolated C-m submit calls
 * @returns          array of argv arrays, one per send-keys invocation
 */
export function buildSendPaneArgvs(
  paneId: string,
  text: string,
  pressEnter: boolean = true,
): string[][] {
  // Replace newlines with spaces so they cannot act as submit keypresses when the text
  // is delivered byte-for-byte via -l (literal) mode.
  const safe = text.replace(/\r?\n/g, ' ');

  // Use -l (literal) so tmux key names inside the text are never interpreted
  // as key presses. Use -- to prevent text starting with '-' from being
  // parsed as tmux flags.
  const argvs: string[][] = [['send-keys', '-t', paneId, '-l', '--', safe]];

  if (pressEnter) {
    // Codex CLI uses raw input mode; send C-m (carriage return) twice
    // for reliable prompt submission.
    // Each C-m is an isolated send-keys call — never bundled with the text
    // above (issue #107).
    argvs.push(['send-keys', '-t', paneId, 'C-m']);
    argvs.push(['send-keys', '-t', paneId, 'C-m']);
  }

  return argvs;
}

const TMUX_TEXT_SETTLE_MS = 120;
const TMUX_SUBMIT_REPEAT_DELAY_MS = 100;

/**
 * Returns the number of C-m (submit) key presses needed for a given worker CLI.
 * Source of truth: Rust runtime's submit_presses_for_worker_cli (Claude=1, Codex/Other=2).
 * Mirrors the Rust logic inline to avoid shelling out for a trivial mapping.
 */
export function getSubmitPresses(workerCli: string): number {
  if (process.env.OMX_RUNTIME_BRIDGE === '0') {
    return workerCli.toLowerCase() === 'claude' ? 1 : 2;
  }
  // Rust-owned mapping: Claude=1, Codex/Other=2
  return workerCli.toLowerCase() === 'claude' ? 1 : 2;
}

type SpawnSyncImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options?: {
    timeout?: number;
    stdio?: ['pipe', 'pipe', 'pipe'];
    encoding?: 'utf-8';
    windowsHide?: boolean;
  },
) => { error?: Error; status: number | null; stdout?: string | Buffer };

interface SendToPaneDeps {
  spawnSyncImpl?: SpawnSyncImpl;
  sleepImpl?: (ms: number) => void;
  expectedIdentity?: ReplyPaneIdentity;
}

export function sendToPane(
  paneId: string,
  text: string,
  pressEnter: boolean = true,
  deps: SendToPaneDeps = {},
): boolean {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const sleepImpl = deps.sleepImpl ?? sleepSync;
  const argvs = buildSendPaneArgvs(paneId, text, pressEnter);
  const tmuxCommand = resolveTmuxBinaryForPlatform() || 'tmux';
  const expected = deps.expectedIdentity;
  if (expected && (!/^%\d+$/.test(paneId) || !Number.isSafeInteger(expected.panePid) || expected.panePid <= 0
    || !/^\$\d+$/.test(expected.sessionId) || !/^\d+$/.test(expected.sessionCreated)
    || !/^[A-Za-z0-9_.:/-]*$/.test(expected.sessionOwner) || !/^[A-Za-z0-9_.:/-]*$/.test(expected.paneOwner)
    || !/^[A-Za-z0-9_.:/-]*$/.test(expected.paneInstanceId))) return false;
  const predicate = expected ? [
    `#{==:#{pane_id},${paneId}}`, '#{==:#{pane_dead},0}',
    `#{==:#{pane_pid},${expected.panePid}}`, `#{==:#{session_id},${expected.sessionId}}`,
    `#{==:#{session_created},${expected.sessionCreated}}`,
    ...(expected.paneInstanceId ? [] : [`#{==:#{@omx_instance_id},${expected.sessionOwner}}`]),
    `#{==:#{@omx_team_pane_owner_id},${expected.paneOwner}}`,
    `#{==:#{@omx_pane_instance_id},${expected.paneInstanceId}}`,
  ].reduce((left, right) => `#{&&:${left},${right}}`) : '';

  for (const [index, argv] of argvs.entries()) {
    const guardedArgv = expected ? [
      'if-shell', '-F', '-t', paneId, predicate,
      `${argv.map(shellEscapeSingle).join(' ')} ; display-message -p __omx_reply_sent__`, '',
    ] : argv;
    const result = spawnSyncImpl(tmuxCommand, guardedArgv, {
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      windowsHide: process.platform === 'win32',
    });
    if (result.error || result.status !== 0 || (expected && String(result.stdout).trim() !== '__omx_reply_sent__')) return false;

    const hasNextArgv = index < argvs.length - 1;
    if (!hasNextArgv) continue;

    sleepImpl(index === 0 ? TMUX_TEXT_SETTLE_MS : TMUX_SUBMIT_REPEAT_DELAY_MS);
  }
  return true;
}
