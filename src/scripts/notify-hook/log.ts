/**
 * Structured event logging for notify-hook modules.
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';

async function safeAppend(file: string, line: string): Promise<void> {
  try {
    await appendFile(file, line);
  } catch {
    // Fall through — log writes should never crash the caller
  }
}

export async function logTmuxHookEvent(
  logsDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  const file = join(logsDir, `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await safeAppend(file, JSON.stringify(event) + '\n');
}

export async function logNotifyHookEvent(
  logsDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  const file = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await safeAppend(file, JSON.stringify(event) + '\n');
}
