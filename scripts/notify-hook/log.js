/**
 * Structured event logging for notify-hook modules.
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';

export async function logTmuxHookEvent(logsDir, event) {
  const file = join(logsDir, `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(file, JSON.stringify(event) + '\n').catch(() => {});
}
