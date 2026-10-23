import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDispatchRequests } from '../state.js';
import { parseRuntimeFinalizationJournal, recordRuntimeFinalization, reconcileRuntimeFinalizations } from '../state/dispatch-recovery.js';
import { getDefaultBridge } from '../../runtime/bridge.js';

const TEAM = 'alpha';
const JOURNAL_FILE = 'runtime-finalizations.jsonl';

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
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    process.env.OMX_RUNTIME_BRIDGE = '1';
    const notified = { command: 'MarkNotified' as const, request_id: 'abc', channel: 'test' };
    const delivered = { command: 'MarkDelivered' as const, request_id: 'abc' };
    try {
      for (const tail of ['', '{"command":"MarkNotified","request_id":"abc"', JSON.stringify(notified)]) {
        await withJournal(tail, async (stateDir) => {
          await rm(join(stateDir, 'events.json'));
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
