import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { HookPluginLogContext } from './types.js';

export function hookLogPath(cwd: string, timestamp = new Date()): string {
  const date = timestamp.toISOString().slice(0, 10);
  return join(cwd, '.omx', 'logs', `hooks-${date}.jsonl`);
}

export async function appendHookPluginLog(cwd: string, entry: HookPluginLogContext): Promise<void> {
  const path = hookLogPath(cwd, entry.timestamp ? new Date(entry.timestamp) : new Date());
  await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
  const payload = {
    timestamp: entry.timestamp || new Date().toISOString(),
    ...entry,
  };
  await appendFile(path, JSON.stringify(payload) + '\n').catch(() => {});
}
