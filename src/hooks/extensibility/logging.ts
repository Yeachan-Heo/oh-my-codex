import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { HookPluginLogContext } from './types.js';

function resolveLogDir(cwd: string): string {
  return join(cwd, '.omx', 'logs');
}

export function hookLogPath(cwd: string, timestamp: Date = new Date()): string {
  const safeTimestamp = isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const date = safeTimestamp.toISOString().slice(0, 10);
  return join(resolveLogDir(cwd), `hooks-${date}.jsonl`);
}

export async function appendHookPluginLog(
  cwd: string,
  entry: HookPluginLogContext
): Promise<void> {
  const timestamp = entry.timestamp
    ? new Date(entry.timestamp)
    : new Date();

  const logDir = resolveLogDir(cwd);
  const filePath = hookLogPath(cwd, timestamp);

  try {
    await mkdir(logDir, { recursive: true });

    const payload = {
      ...entry,
      timestamp: entry.timestamp || timestamp.toISOString(),
    };

    const line = JSON.stringify(payload) + '\n';

    await appendFile(filePath, line, { encoding: 'utf8' });
  } catch (error) {
    
    process.stderr.write(
      `[omx:hook-log-error] Failed to write hook log: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }
}
