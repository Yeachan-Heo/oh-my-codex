import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverNotifyFallback, compactNotifyFallbackDeliveries, NOTIFY_FALLBACK_LEASE_MS, NOTIFY_FALLBACK_RETENTION_MS } from '../notify-fallback-delivery.js';
import { createHash } from 'node:crypto';

function deliveryKeyHash(threadId: string, turnId: string): string {
  const part = (value: string) => {
    const data = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, data]);
  };
  return createHash('sha256').update(Buffer.from('omx-notify-fallback-delivery-v1\0')).update(part(threadId)).update(part(turnId)).digest('hex');
}

async function withState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-delivery-'));
  try { await run(join(root, 'state')); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('notify fallback delivery', () => {
  it('allows only one simultaneous claimant to start a hook', async () => withState(async (stateDir) => {
    let starts = 0;
    const options = {
      stateDir,
      threadId: 'thread-a',
      turnId: 'turn-a',
      eventTimestampMs: 1_000,
      rolloutPath: '/rollout-a.jsonl',
      watcherMode: 'persistent' as const,
      deadlineAtMs: 100_000,
      now: () => 2_000,
      spawnHook: async () => {
        starts += 1;
        return { spawned: true, childPid: 42, status: 0, signal: null };
      },
    };
    const results = await Promise.all([deliverNotifyFallback(options), deliverNotifyFallback(options)]);
    assert.equal(starts, 1);
    assert.equal(results.filter((result) => result.kind === 'acquired_effect').length, 1);
  }));

  it('retries once after durable pre-spawn failure and makes attempt two terminal', async () => withState(async (stateDir) => {
    let clock = 10_000;
    const base = { stateDir, threadId: 'thread-b', turnId: 'turn-b', eventTimestampMs: 9_000, rolloutPath: '/rollout-b.jsonl', watcherMode: 'once' as const, deadlineAtMs: 100_000, now: () => clock };
    const first = await deliverNotifyFallback({ ...base, spawnHook: async () => ({ spawned: false, error: new Error('ENOENT') }) });
    assert.equal(first.kind, 'retry_eligible');
    clock += 251;
    const second = await deliverNotifyFallback({ ...base, spawnHook: async () => ({ spawned: false, error: new Error('ENOENT') }) });
    assert.equal(second.kind, 'terminal_failed');
    const third = await deliverNotifyFallback({ ...base, spawnHook: async () => { throw new Error('must not spawn attempt three'); } });
    assert.equal(third.kind, 'terminal_failed');
    await compactNotifyFallbackDeliveries(stateDir, Date.now() + NOTIFY_FALLBACK_RETENTION_MS + 1);
    const afterCompaction = await deliverNotifyFallback({ ...base, spawnHook: async () => ({ spawned: true, childPid: 77, status: 0 }) });
    assert.equal(afterCompaction.kind, 'acquired_effect');
  }));

  it('fails closed for malformed timestamps and expired authority', async () => withState(async (stateDir) => {
    const invalid = await deliverNotifyFallback({
      stateDir, threadId: 'thread-c', turnId: 'turn-c', eventTimestampMs: Number.NaN, rolloutPath: '/rollout-c.jsonl', watcherMode: 'once', deadlineAtMs: 1,
      now: () => 2, spawnHook: async () => ({ spawned: true, childPid: 1, status: 0 }),
    });
    assert.deepEqual(invalid, { kind: 'invalid_skip', reason: 'invalid_event_timestamp' });
    const deadline = await deliverNotifyFallback({
      stateDir, threadId: 'thread-d', turnId: 'turn-d', eventTimestampMs: 0, rolloutPath: '/rollout-d.jsonl', watcherMode: 'once', deadlineAtMs: NOTIFY_FALLBACK_LEASE_MS,
      now: () => NOTIFY_FALLBACK_LEASE_MS, spawnHook: async () => ({ spawned: true, childPid: 1, status: 0 }),
    });
    assert.deepEqual(deadline, { kind: 'deadline_skip', reason: 'authority_deadline' });
  }));

  it('isolates workspace roots and turns while retaining delivered authority', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'omx-notify-isolation-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'omx-notify-isolation-b-'));
    try {
      let starts = 0;
      const build = (stateDir: string, turnId: string, threadId = 'thread') => ({
        stateDir, threadId, turnId, eventTimestampMs: 1_000, rolloutPath: '/rollout.jsonl', watcherMode: 'persistent' as const,
        deadlineAtMs: 10_000, now: () => 2_000,
        spawnHook: async () => { starts += 1; return { spawned: true, childPid: starts, status: 0, signal: null }; },
      });
      assert.equal((await deliverNotifyFallback(build(join(rootA, 'state'), 'turn'))).kind, 'acquired_effect');
      assert.equal((await deliverNotifyFallback(build(join(rootB, 'state'), 'turn'))).kind, 'acquired_effect');
      assert.equal((await deliverNotifyFallback(build(join(rootA, 'state'), 'other-turn'))).kind, 'acquired_effect');
      assert.equal((await deliverNotifyFallback(build(join(rootA, 'state'), 'turn', 'other-thread'))).kind, 'acquired_effect');
      assert.equal((await deliverNotifyFallback(build(join(rootA, 'state'), 'turn'))).kind, 'terminal_delivered');
      assert.equal(starts, 4);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it('treats a spawned nonzero child as terminal ambiguity without retry', async () => withState(async (stateDir) => {
    const options = {
      stateDir, threadId: 'thread-e', turnId: 'turn-e', eventTimestampMs: 1_000, rolloutPath: '/rollout-e.jsonl', watcherMode: 'once' as const,
      deadlineAtMs: 20_000, now: () => 2_000,
      spawnHook: async () => ({ spawned: true, childPid: 55, status: 1, signal: null }),
    };
    assert.equal((await deliverNotifyFallback(options)).kind, 'acquired_effect');
    assert.equal((await deliverNotifyFallback(options)).kind, 'terminal_ambiguous');
  }));

  it('rejects event timestamps more than five minutes in the future', async () => withState(async (stateDir) => {
    const result = await deliverNotifyFallback({
      stateDir, threadId: 'thread-f', turnId: 'turn-f', eventTimestampMs: 302_001, rolloutPath: '/rollout-f.jsonl', watcherMode: 'persistent',
      deadlineAtMs: 400_000, now: () => 2_000, spawnHook: async () => ({ spawned: true, childPid: 99, status: 0 }),
    });
    assert.deepEqual(result, { kind: 'invalid_skip', reason: 'invalid_event_timestamp' });
  }));

  it('compacts terminal delivery authority after the 26 hour retention boundary', async () => withState(async (stateDir) => {
    let starts = 0;
    const options = {
      stateDir, threadId: 'thread-g', turnId: 'turn-g', eventTimestampMs: Date.now(), rolloutPath: '/rollout-g.jsonl', watcherMode: 'persistent' as const,
      deadlineAtMs: Date.now() + 100_000, now: () => Date.now(),
      spawnHook: async () => ({ spawned: true, childPid: ++starts, status: 0, signal: null }),
    };
    await deliverNotifyFallback(options);
    await compactNotifyFallbackDeliveries(stateDir, Date.now() + NOTIFY_FALLBACK_RETENTION_MS + 1);
    assert.equal((await deliverNotifyFallback(options)).kind, 'acquired_effect');
    assert.equal(starts, 2);
  }));

  it('does not retry a termination-unconfirmed hook outcome', async () => withState(async (stateDir) => {
    const options = {
      stateDir, threadId: 'thread-h', turnId: 'turn-h', eventTimestampMs: 1_000, rolloutPath: '/rollout-h.jsonl', watcherMode: 'once' as const,
      deadlineAtMs: 20_000, now: () => 2_000,
      spawnHook: async () => ({ spawned: true, childPid: 88, status: null, signal: null, terminationUnconfirmed: true }),
    };
    assert.equal((await deliverNotifyFallback(options)).kind, 'acquired_effect');
    assert.equal((await deliverNotifyFallback(options)).kind, 'terminal_ambiguous');
  }));
});
  it('fails closed when the delivery store root is a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-notify-symlink-'));
    const external = await mkdtemp(join(tmpdir(), 'omx-notify-external-'));
    try {
      const stateDir = join(root, 'state');
      await mkdir(stateDir, { recursive: true });
      await symlink(external, join(stateDir, 'notify-fallback-delivery-v1'), 'dir');
      let starts = 0;
      const result = await deliverNotifyFallback({
        stateDir, threadId: 'thread-link', turnId: 'turn-link', eventTimestampMs: 1_000, rolloutPath: '/rollout-link.jsonl', watcherMode: 'once', deadlineAtMs: 10_000, now: () => 2_000,
        spawnHook: async () => { starts += 1; return { spawned: true, childPid: 1, status: 0 }; },
      });
      assert.equal(result.kind, 'io_skip');
      assert.equal(starts, 0);
      await assert.rejects(() => compactNotifyFallbackDeliveries(stateDir, 100_000), /unsafe_directory_path/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it('rejects a retry authorization published before lease expiry', async () => withState(async (stateDir) => {
    const threadId = 'thread-premature';
    const turnId = 'turn-premature';
    const hash = deliveryKeyHash(threadId, turnId);
    const token = 'a'.repeat(64);
    const keyDir = join(stateDir, 'notify-fallback-delivery-v1', hash.slice(0, 2), `${hash}.key`);
    const attemptDir = join(keyDir, 'attempt-1');
    await mkdir(join(attemptDir, `owner-${token}`), { recursive: true });
    const identity = { schema_version: 1, key_hash: hash, thread_id: threadId, turn_id: turnId };
    await writeFile(join(keyDir, 'key.json'), JSON.stringify({ ...identity, created_at_ms: 1_000 }));
    await writeFile(join(attemptDir, `owner-${token}`, 'claim.json'), JSON.stringify({ ...identity, attempt: 1, owner_token: token, watcher_mode: 'once', claimed_at_ms: 1_000, lease_expires_at_ms: 1_000 + NOTIFY_FALLBACK_LEASE_MS, event_timestamp_ms: 1_000, rollout_path_hash: 'b'.repeat(64) }));
    await writeFile(join(attemptDir, 'decision'), JSON.stringify({ ...identity, attempt: 1, owner_token: token, publisher_token: 'c'.repeat(64), published_at_ms: 2_000, kind: 'retry_authorized', reason: 'pre_effect_lease_expired', observed_lease_expires_at_ms: 1_000 + NOTIFY_FALLBACK_LEASE_MS }));
    let starts = 0;
    const result = await deliverNotifyFallback({
      stateDir, threadId, turnId, eventTimestampMs: 1_000, rolloutPath: '/rollout-premature.jsonl', watcherMode: 'once', deadlineAtMs: 100_000, now: () => 32_000,
      spawnHook: async () => { starts += 1; return { spawned: true, childPid: 1, status: 0 }; },
    });
    assert.deepEqual(result, { kind: 'invalid_skip', reason: 'invalid_retry_proof' });
    assert.equal(starts, 0);
  }));
