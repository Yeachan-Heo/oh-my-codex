/**
 * OMX HUD - ANSI Color Utilities
 *
 * Terminal color codes for statusline rendering.
 * Ported from oh-my-claudecode.
 */

// ANSI escape codes
export const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

let colorOutputEnabled = true;

type ColorEnv = Record<string, string | undefined>;

export function shouldEnableColorOutput(
  isTTY: boolean | undefined = process.stdout.isTTY,
  env: ColorEnv = process.env as ColorEnv,
): boolean {
  if (!isTTY) return false;
  if (typeof env.NO_COLOR === 'string') return false;
  if ((env.TERM || '').toLowerCase() === 'dumb') return false;
  return true;
}

export function setColorEnabled(enabled: boolean): void {
  colorOutputEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorOutputEnabled;
}

function wrap(color: string, text: string): string {
  if (!colorOutputEnabled) return text;
  return `${color}${text}${RESET}`;
}

export function green(text: string): string {
  return wrap(GREEN, text);
}

export function yellow(text: string): string {
  return wrap(YELLOW, text);
}

export function red(text: string): string {
  return wrap(RED, text);
}

export function cyan(text: string): string {
  return wrap(CYAN, text);
}

export function dim(text: string): string {
  return wrap(DIM, text);
}

export function bold(text: string): string {
  return wrap(BOLD, text);
}

/**
 * Get color code based on ralph iteration progress.
 */
export function getRalphColor(iteration: number, maxIterations: number): string {
  if (!colorOutputEnabled) return '';
  const warningThreshold = Math.floor(maxIterations * 0.7);
  const criticalThreshold = Math.floor(maxIterations * 0.9);

  if (iteration >= criticalThreshold) return RED;
  if (iteration >= warningThreshold) return YELLOW;
  return GREEN;
}

/**
 * Get color for todo/turn progress.
 */
export function getTodoColor(completed: number, total: number): string {
  if (!colorOutputEnabled) return '';
  if (total === 0) return DIM;
  const percent = (completed / total) * 100;
  if (percent >= 80) return GREEN;
  if (percent >= 50) return YELLOW;
  return CYAN;
}

/**
 * Create a colored progress bar.
 */
export function coloredBar(percent: number, width: number = 10): string {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  const safePercent = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0;

  const filled = Math.round((safePercent / 100) * safeWidth);
  const empty = safeWidth - filled;

  const color = safePercent >= 85 ? RED : safePercent >= 70 ? YELLOW : GREEN;
  if (!colorOutputEnabled) {
    return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
  }
  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}
