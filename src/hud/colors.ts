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

export function green(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

export function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

/**
 * Get color code based on ralph iteration progress.
 */
export function getRalphColor(iteration: number, maxIterations: number): string {
  const warningThreshold = Math.floor(maxIterations * 0.7);
  const criticalThreshold = Math.floor(maxIterations * 0.9);

  if (iteration >= criticalThreshold) return RED;
  if (iteration >= warningThreshold) return YELLOW;
  return GREEN;
}
