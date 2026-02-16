/**
 * tmux Pane Interaction Utilities for Reply Listener
 *
 * Provides functions to capture pane content, analyze whether a pane is running
 * Codex CLI, and inject text into panes. Used by the reply-listener daemon.
 */

import { execSync } from 'child_process';

export function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function capturePaneContent(paneId: string, lines: number = 15): string {
  try {
    return execSync(`tmux capture-pane -t ${paneId} -p -S -${lines}`, {
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
 * Sanitize text for safe injection into tmux via send-keys.
 */
function sanitizeForTmux(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/;/g, '\\;')
    .replace(/\n/g, ' ');
}

export function sendToPane(paneId: string, text: string, pressEnter: boolean = true): boolean {
  try {
    const sanitized = sanitizeForTmux(text);
    const enterSuffix = pressEnter ? ' Enter' : '';
    execSync(`tmux send-keys -t ${paneId} "${sanitized}"${enterSuffix}`, {
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
