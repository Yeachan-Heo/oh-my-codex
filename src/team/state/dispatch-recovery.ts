import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDefaultBridge, type RuntimeCommand } from '../../runtime/bridge.js';

export function hasRuntimeAuthority(stateDir: string): boolean {
  return ['events.json', 'snapshot.json', 'mailbox.json', 'dispatch-seen.json'].some((name) => existsSync(join(stateDir, name)));
}

function readRuntimeDispatchRequestIds(stateDir: string): string[] | null {
  let ledger: unknown;
  try { ledger = JSON.parse(readFileSync(join(stateDir, 'dispatch-seen.json'), 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  if (!ledger || typeof ledger !== 'object') throw new Error('invalid runtime dispatch identity ledger');
  const value = ledger as { schema_version?: unknown; ledger_epoch?: unknown; request_ids?: unknown };
  if (!(value.schema_version === 1 || (value.schema_version === 2 && value.ledger_epoch === 1))
    || !Array.isArray(value.request_ids) || value.request_ids.some((id) => typeof id !== 'string' || !id)
    || new Set(value.request_ids).size !== value.request_ids.length) throw new Error('invalid runtime dispatch identity ledger');
  return value.request_ids as string[];
}

export function hasRuntimeDispatchIdentity(stateDir: string, requestId: string): boolean {
  return readRuntimeDispatchRequestIds(stateDir)?.includes(requestId) ?? false;
}

type RuntimeFinalizationCommand = Extract<RuntimeCommand, { command: 'MarkNotified' | 'MarkDelivered' | 'MarkFailed' }>;

/**
 * The journal is append-only, so a crash can leave a torn trailing line.
 * Skip incomplete or non-object lines instead of letting one bad append block
 * every later read and reconciliation.
 */
export function parseRuntimeFinalizationJournal(raw: string): RuntimeFinalizationCommand[] {
  const commands: RuntimeFinalizationCommand[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      commands.push(parsed as RuntimeFinalizationCommand);
    }
  }
  return commands;
}

/** Load the dispatch identity ledger once into a Set for efficient batch lookups. Returns null if the ledger doesn't exist. */
export function loadRuntimeDispatchIdentitySet(stateDir: string): Set<string> | null {
  const ids = readRuntimeDispatchRequestIds(stateDir);
  return ids ? new Set(ids) : null;
}

// Callers select the team's request and hold its dispatch lock across journal and projection updates.
export function recordRuntimeFinalization(stateDir: string, teamName: string, command: Extract<RuntimeCommand, { command: 'MarkNotified' | 'MarkDelivered' | 'MarkFailed' }>): void {
  // The identity ledger is atomically published; events and projections can be mid-write.
  const requestIds = readRuntimeDispatchRequestIds(stateDir);
  if (!requestIds?.includes(command.request_id)) return;
  const journal = join(stateDir, 'team', teamName, 'dispatch', 'runtime-finalizations.jsonl');
  mkdirSync(dirname(journal), { recursive: true });
  // A leading newline isolates this receipt from any crash-truncated tail.
  appendFileSync(journal, `\n${JSON.stringify(command)}\n`);
}

export async function reconcileRuntimeFinalizations(stateDir: string, teamName: string): Promise<void> {
  const journal = join(stateDir, 'team', teamName, 'dispatch', 'runtime-finalizations.jsonl');
  let raw: string;
  try { raw = await readFile(journal, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  const commands = parseRuntimeFinalizationJournal(raw);
  if (commands.length > 0) {
    if (process.env.OMX_RUNTIME_BRIDGE === '0') throw new Error('runtime finalizations require the runtime bridge');
    if (commands.some((command) => !command || typeof command.request_id !== 'string'
      || !((command.command === 'MarkNotified' && typeof command.channel === 'string')
        || command.command === 'MarkDelivered'
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
      if (command.command === 'MarkDelivered' && record.status === 'pending') {
        bridge.execCommand({ command: 'MarkNotified', request_id: command.request_id, channel: 'recovered_delivery' });
      }
      bridge.execCommand(command);
      const updated = bridge.readDispatchRecordsStrict().find((entry) => entry.request_id === command.request_id);
      const expected = command.command === 'MarkNotified' ? 'notified'
        : command.command === 'MarkDelivered' ? 'delivered' : 'failed';
      if (updated?.status !== expected) throw new Error('runtime finalization verification failed');
    }
  }
  await rm(journal);
}

