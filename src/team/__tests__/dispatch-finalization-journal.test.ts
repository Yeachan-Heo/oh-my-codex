import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDispatchRequests } from '../state.js';
import { parseRuntimeFinalizationJournal, recordRuntimeFinalization, reconcileRuntimeFinalizations } from '../state/dispatch-recovery.js';
import { getDefaultBridge } from '../../runtime/bridge.js';

const TEAM = 'alpha';
const JOURNAL_FILE = 'runtime-finalizations.jsonl';

async function writeCompatRuntimeFixture(runtimePath: string, runtimeLogPath: string): Promise<void> {
  await writeFile(
    runtimePath,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(runtimeLogPath)}, argv.join(' ') + '\\n');

function argValue(prefix) {
  const entry = argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function stateDir() {
  return argValue('--state-dir=') || process.cwd();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n');
}

function nowIso() {
  return new Date().toISOString();
}

if (argv[0] === 'schema') {
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    capabilities: ['team-mailbox-scope-v1'],
    commands: [
      'acquire-authority',
      'renew-authority',
      'queue-dispatch',
      'mark-notified',
      'mark-delivered',
      'mark-failed',
      'request-replay',
      'remove-dispatch-records',
      'capture-snapshot',
    ],
    events: [],
    transport: 'tmux',
  }) + '\\n');
  process.exit(0);
}

if (argv[0] !== 'exec' && argv[0] !== 'exec-scoped') process.exit(1);

const command = JSON.parse(argv[1] || '{}');
const dir = stateDir();
const dispatchPath = path.join(dir, 'dispatch.json');
const mailboxPath = path.join(dir, 'mailbox.json');
const dispatch = readJson(dispatchPath, { records: [] });
const mailbox = readJson(mailboxPath, { records: [] });
const timestamp = nowIso();

switch (command.command) {
  case 'QueueDispatch': {
    writeJson(path.join(dir, 'events.json'), [...readJson(path.join(dir, 'events.json'), []), { event: 'DispatchQueued', request_id: command.request_id, metadata: command.metadata }]);
    writeJson(path.join(dir, 'dispatch-seen.json'), { schema_version: 2, ledger_epoch: 1, request_ids: [...readJson(path.join(dir, 'dispatch-seen.json'), { request_ids: [] }).request_ids, command.request_id] });
    dispatch.records.push({
      request_id: command.request_id,
      target: command.target,
      status: 'pending',
      created_at: timestamp,
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: command.metadata ?? null,
    });
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchQueued', request_id: command.request_id, target: command.target, metadata: command.metadata ?? null }) + '\\n');
    process.exit(0);
  }
  case 'MarkNotified': {
    const record = dispatch.records.find((r) => r.request_id === command.request_id);
    if (record) {
      record.status = 'notified';
      record.notified_at = timestamp;
    }
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchNotified', request_id: command.request_id, channel: command.channel }) + '\\n');
    process.exit(0);
  }
  case 'MarkDelivered': {
    const record = dispatch.records.find((r) => r.request_id === command.request_id);
    if (record) {
      record.status = 'delivered';
      record.delivered_at = timestamp;
    }
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchDelivered', request_id: command.request_id }) + '\\n');
    process.exit(0);
  }
  case 'CaptureSnapshot': {
    process.stdout.write(JSON.stringify({ event: 'SnapshotCaptured', dispatch: dispatch.records, mailbox: mailbox.records }) + '\\n');
    process.exit(0);
  }
  default:
    process.exit(1);
}`,
  );
  await chmod(runtimePath, 0o755);
}

async function withJournal(
  contents: string,
  run: (stateDir: string, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-finalization-journal-'));
  const stateDir = join(cwd, '.omx', 'state');
  try {
    await mkdir(join(stateDir, 'team', TEAM, 'dispatch'), { recursive: true });
    await writeFile(join(stateDir, 'events.json'), '[]');
    await writeFile(join(stateDir, 'team', TEAM, 'dispatch', 'requests.json'), '[]');
    await writeFile(join(stateDir, 'team', TEAM, 'dispatch', JOURNAL_FILE), contents);
    await run(stateDir, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('runtime finalization journal corruption', () => {
  it('reads dispatch requests past torn, null and array lines', async () => {
    await withJournal(
      '{"command":"MarkDelivered","request_id":"abc"\nnull\n[1]\n',
      async (stateDir, cwd) => {
        assert.deepEqual(await readDispatchRequests(TEAM, cwd, [], stateDir), []);
      },
    );
  });

  it('reconciles and removes a journal containing only torn lines', async () => {
    await withJournal(
      '{"command":"MarkDelivered","request_id":"abc"\nnull\n',
      async (stateDir) => {
        await reconcileRuntimeFinalizations(stateDir, TEAM);
        assert.equal(existsSync(join(stateDir, 'team', TEAM, 'dispatch', JOURNAL_FILE)), false);
      },
    );
  });

  it('preserves and replays commands appended after an unterminated tail', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-finalization-preserve-'));
    const runtimePath = join(cwd, 'runtime');
    const runtimeLogPath = join(cwd, 'runtime.log');
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
    process.env.OMX_RUNTIME_BINARY = runtimePath;
    process.env.OMX_RUNTIME_BRIDGE = '1';
    const notified = { command: 'MarkNotified' as const, request_id: 'abc', channel: 'test' };
    const delivered = { command: 'MarkDelivered' as const, request_id: 'abc' };
    try {
      for (const tail of ['', '{"command":"MarkNotified","request_id":"abc"', JSON.stringify(notified)]) {
        await withJournal(tail, async (stateDir) => {
          const bridge = getDefaultBridge(stateDir);
          bridge.execCommand({
            command: 'QueueDispatch', request_id: 'abc', target: 'worker-1', metadata: { team_name: TEAM },
          });
          recordRuntimeFinalization(stateDir, TEAM, notified);
          recordRuntimeFinalization(stateDir, TEAM, delivered);
          const journal = join(stateDir, 'team', TEAM, 'dispatch', JOURNAL_FILE);
          assert.deepEqual(
            parseRuntimeFinalizationJournal(await readFile(journal, 'utf8')),
            tail === JSON.stringify(notified) ? [notified, notified, delivered] : [notified, delivered],
          );
          await reconcileRuntimeFinalizations(stateDir, TEAM);
          assert.equal(bridge.readDispatchRecordsStrict().find((record) => record.request_id === 'abc')?.status, 'delivered');
          assert.equal(existsSync(journal), false);
        });
      }
    } finally {
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps valid commands while skipping malformed lines', () => {
    assert.deepEqual(
      parseRuntimeFinalizationJournal(
        '{"command":"MarkNotified","request_id":"a","channel":"test"}\n{"torn\nnull\n[]\n',
      ),
      [{ command: 'MarkNotified', request_id: 'a', channel: 'test' }],
    );
  });
});
