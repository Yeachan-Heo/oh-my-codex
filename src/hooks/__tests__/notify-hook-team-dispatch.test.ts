import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initTeamState,
  enqueueDispatchRequest,
  readDispatchRequest,
  listMailboxMessages,
  sendDirectMessage,
} from '../../team/state.js';
import { pathToFileURL } from 'node:url';

describe('notify-hook team dispatch consumer', () => {
  it('marks pending request as notified and preserves mailbox notified_at semantics', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'worker-1', 'hello', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'worker-1',
        worker_index: 1,
        message_id: msg.message_id,
        trigger_message: 'check mailbox',
      }, cwd);

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
      const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
      assert.ok(mailbox[0]?.notified_at);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('is idempotent across repeated ticks (no duplicate processing)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      const second = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(second.processed, 0);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips non-hook transport preferences in hook consumer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
        transport_preference: 'transport_direct',
        fallback_allowed: false,
      }, cwd);

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 0);
      assert.equal(result.failed, 0);
      assert.ok(result.skipped >= 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
