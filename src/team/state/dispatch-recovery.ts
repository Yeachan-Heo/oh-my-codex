import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDefaultBridge, type RuntimeCommand } from '../../runtime/bridge.js';

function hasRuntimeAuthority(stateDir: string): boolean {
  return ['events.json', 'snapshot.json', 'mailbox.json'].some((name) => existsSync(join(stateDir, name)));
}

// Callers hold the team dispatch lock across journal and projection updates.
export function recordRuntimeFinalization(stateDir: string, teamName: string, command: Extract<RuntimeCommand, { command: 'MarkNotified' | 'MarkFailed' }>): void {
  // Compatibility rows can be JSON fallback even alongside existing runtime state.
  let events: unknown;
  try { events = JSON.parse(readFileSync(join(stateDir, 'events.json'), 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  if (!Array.isArray(events)) throw new Error('invalid runtime event history');
  if (!events.some((event) => event?.event === 'DispatchQueued'
    && event.request_id === command.request_id && event.metadata?.team_name === teamName)) return;
  const journal = join(stateDir, 'team', teamName, 'dispatch', 'runtime-finalizations.jsonl');
  mkdirSync(dirname(journal), { recursive: true });
  appendFileSync(journal, `${JSON.stringify(command)}\n`);
}

export async function reconcileRuntimeFinalizations(stateDir: string, teamName: string): Promise<void> {
  const journal = join(stateDir, 'team', teamName, 'dispatch', 'runtime-finalizations.jsonl');
  let raw: string;
  try { raw = await readFile(journal, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  const commands = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (commands.length > 0) {
    if (process.env.OMX_RUNTIME_BRIDGE === '0') throw new Error('runtime finalizations require the runtime bridge');
    if (commands.some((command) => !command || typeof command.request_id !== 'string'
      || !((command.command === 'MarkNotified' && typeof command.channel === 'string')
        || (command.command === 'MarkFailed' && typeof command.reason === 'string')))) {
      throw new Error('invalid runtime finalization journal');
    }
    if (!hasRuntimeAuthority(stateDir)) throw new Error('runtime finalization authority is unavailable');
    const bridge = getDefaultBridge(stateDir);
    // Refresh from events before trusting compatibility state written by fallback.
    bridge.execCommand({ command: 'CaptureSnapshot' });
    for (const command of commands) {
      const record = bridge.readDispatchRecordsStrict().find((entry) => entry.request_id === command.request_id);
      if (!record) continue; // Authoritative removal must not resurrect a request.
      if (record.metadata?.team_name !== teamName) throw new Error('runtime finalization team mismatch');
      if (record.status === 'delivered' || record.status === 'failed'
        || (command.command === 'MarkNotified' && record.status === 'notified')) continue;
      bridge.execCommand(command);
      const updated = bridge.readDispatchRecordsStrict().find((entry) => entry.request_id === command.request_id);
      const expected = command.command === 'MarkNotified' ? 'notified' : 'failed';
      if (updated?.status !== expected) throw new Error('runtime finalization verification failed');
    }
  }
  await rm(journal);
}

