/**
 * tmux Pane Interaction Utilities for Reply Listener
 *
 * Provides functions to capture pane content, analyze whether a pane is running
 * Codex CLI, and inject text into panes. Used by the reply-listener daemon.
 */

import { execSync, execFileSync, spawnSync } from 'child_process';

export function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the argv array for `tmux capture-pane`.
 * Keeping args separate (never interpolated into a shell string) prevents
 * command injection through a malicious paneId value (issue #156).
 */
export function buildCapturePaneArgv(paneId: string, lines: number): string[] {
  return ['capture-pane', '-t', paneId, '-p', '-S', `-${lines}`];
}

export function capturePaneContent(paneId: string, lines: number = 15): string {
  try {
    return execFileSync('tmux', buildCapturePaneArgv(paneId, lines), {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
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

export function sendToPane(paneId: string, text: string, pressEnter: boolean = true): boolean {
  for (const argv of buildSendPaneArgvs(paneId, text, pressEnter)) {
    const result = spawnSync('tmux', argv, {
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (result.error || result.status !== 0) return false;
  }
  return true;
}
