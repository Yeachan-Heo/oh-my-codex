import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initTeamState,
  listMailboxMessages,
} from '../state.js';
import {
  queueInboxInstruction,
  queueDirectMailboxMessage,
  queueBroadcastMailboxMessage,
} from '../mcp-comm.js';

describe('mcp-comm', () => {
  it('queueInboxInstruction writes inbox before notifying', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mcp-comm-'));
    try {
      await initTeamState('alpha', 't', 'executor', 1, cwd);

      const events: string[] = [];
      const ok = await queueInboxInstruction({
        teamName: 'alpha',
        workerName: 'worker-1',
        workerIndex: 1,
        inbox: '# hi',
        triggerMessage: 'trigger',
        cwd,
        notify: async () => {
          events.push('notify');
          const inboxPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'workers', 'worker-1', 'inbox.md');
          const content = await readFile(inboxPath, 'utf-8');
          assert.match(content, /# hi/);
          return true;
        },
      });
      assert.equal(ok, true);
      assert.deepEqual(events, ['notify']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queueDirectMailboxMessage writes message and marks notified only on successful notify', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mcp-comm-'));
    try {
      await initTeamState('alpha', 't', 'executor', 2, cwd);

      await queueDirectMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        toWorker: 'worker-2',
        toWorkerIndex: 2,
        body: 'hello',
        triggerMessage: 'check mailbox',
        cwd,
        notify: async () => true,
      });

      const mailbox = await listMailboxMessages('alpha', 'worker-2', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.body, 'hello');
      assert.ok(mailbox[0]?.notified_at);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queueBroadcastMailboxMessage notifies and marks notified per recipient', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mcp-comm-'));
    try {
      await initTeamState('alpha', 't', 'executor', 2, cwd);

      // Pre-seed a broadcast message set by calling state-layer broadcast through the helper.
      // The helper will call broadcastMessage internally.
      const notified: string[] = [];
      await queueBroadcastMailboxMessage({
        teamName: 'alpha',
        fromWorker: 'worker-1',
        recipients: [
          { workerName: 'worker-1', workerIndex: 1 },
          { workerName: 'worker-2', workerIndex: 2 },
        ],
        body: 'broadcast-body',
        cwd,
        triggerFor: (workerName) => `check mailbox ${workerName}`,
        notify: async (target) => {
          notified.push(target.workerName);
          return true;
        },
      });

      const m1 = await listMailboxMessages('alpha', 'worker-1', cwd);
      const m2 = await listMailboxMessages('alpha', 'worker-2', cwd);
      assert.equal(m1.length, 0);
      assert.equal(m2.length, 1);
      assert.ok(m2[0]?.notified_at);
      assert.deepEqual(notified.sort(), ['worker-2']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
