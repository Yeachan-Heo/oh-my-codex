import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimLifecycleHookBroadcast,
  completeLifecycleHookBroadcast,
  shouldSendLifecycleNotification,
  recordLifecycleNotificationSent,
  shouldSendLifecycleHookBroadcast,
  recordLifecycleHookBroadcastSent,
  renewLifecycleHookBroadcastClaim,
  releaseLifecycleHookBroadcast,
} from '../lifecycle-dedupe.js';
import type { FullNotificationPayload } from '../types.js';

function buildPayload(overrides: Partial<FullNotificationPayload> = {}): FullNotificationPayload {
  return {
    event: 'session-end',
    sessionId: 'session-1475',
    message: 'done',
    timestamp: '2026-04-11T00:00:00.000Z',
    projectPath: '/tmp/project',
    projectName: 'project',
    reason: 'session_exit',
    ...overrides,
  };
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for files: ${paths.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Child process exited with ${code ?? signal}`));
    });
  });
}

describe('lifecycle notification dedupe', () => {
  it('atomically claims duplicate child-hook deliveries and preserves other children across processes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-concurrent-hook-'));
    const sessionId = 'parallel-session';
    const statePath = join(stateDir, 'sessions', sessionId, 'lifecycle-notif-state.json');
    const readyPath = join(stateDir, 'lock-ready');
    const releasePath = join(stateDir, 'lock-release');
    const trackerModuleUrl = new URL('../../subagents/tracker.js', import.meta.url).href;
    const lifecycleModuleUrl = new URL('../lifecycle-dedupe.js', import.meta.url).href;
    const holderSource = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { withCrossProcessFileLockSync } from ${JSON.stringify(trackerModuleUrl)};
      withCrossProcessFileLockSync(${JSON.stringify(statePath)}, () => {
        writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        const waitArray = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10_000;
        while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) {
          Atomics.wait(waitArray, 0, 0, 5);
        }
      });
    `;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSource], { stdio: 'ignore' });
    const holderExit = waitForChildExit(holder);
    const children: Array<{
      child: ReturnType<typeof spawn>;
      childId: string;
      startedPath: string;
      donePath: string;
      exit: Promise<void>;
    }> = [];

    try {
      await waitForFiles([readyPath]);
      const writers = [
        { writerId: 'child-a-first', childId: 'child-a' },
        { writerId: 'child-a-replay', childId: 'child-a' },
        { writerId: 'child-b-first', childId: 'child-b' },
      ];
      for (const { writerId, childId } of writers) {
        const startedPath = join(stateDir, `${writerId}.started`);
        const donePath = join(stateDir, `${writerId}.done`);
        const eventKey = `subagent-stop:${JSON.stringify([childId, 'turn-1'])}`;
        const writerSource = `
          import { writeFileSync } from 'node:fs';
          import { claimLifecycleHookBroadcast } from ${JSON.stringify(lifecycleModuleUrl)};
          writeFileSync(${JSON.stringify(startedPath)}, 'started');
          const claim = claimLifecycleHookBroadcast(${JSON.stringify(stateDir)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(eventKey)}, ${JSON.stringify(childId)});
          writeFileSync(${JSON.stringify(donePath)}, JSON.stringify(claim));
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', writerSource], { stdio: 'ignore' });
        children.push({ child, childId, startedPath, donePath, exit: waitForChildExit(child) });
      }
      await waitForFiles(children.map(({ startedPath }) => startedPath));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(children.map(({ donePath }) => existsSync(donePath)), [false, false, false]);

      await writeFile(releasePath, 'release');
      await Promise.all(children.map(({ exit }) => exit));
      await holderExit;

      const results = await Promise.all(children.map(async (writer) => ({
        ...writer,
        ...(JSON.parse(await readFile(writer.donePath, 'utf8')) as { acquired: boolean }),
      })));
      assert.equal(results.filter(({ childId, acquired }) => childId === 'child-a' && acquired).length, 1);
      assert.equal(results.filter(({ childId, acquired }) => childId === 'child-b' && acquired).length, 1);
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      for (const childId of ['child-a', 'child-b']) {
        const eventKey = `subagent-stop:${JSON.stringify([childId, 'turn-1'])}`;
        assert.equal(state.hookEvents[eventKey].fingerprint, childId);
        assert.ok(state.hookEvents[eventKey].claimId);
      }
    } finally {
      await writeFile(releasePath, 'release').catch(() => {});
      for (const { child } of children) child.kill();
      holder.kill();
      await Promise.allSettled([...children.map(({ exit }) => exit), holderExit]);
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('releases failed child-hook claims and records successful dispatches', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-hook-claim-'));
    const sessionId = 'claim-session';
    const eventKey = 'subagent-stop:["child-a","turn-1"]';
    const startMs = Date.parse('2026-04-12T00:00:00.000Z');
    try {
      const failedDispatchClaim = claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs);
      assert.equal(failedDispatchClaim.acquired, true);
      assert.ok(failedDispatchClaim.claimId);
      assert.equal(claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 1).acquired, false);

      releaseLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', failedDispatchClaim.claimId!, startMs + 2);
      const retryClaim = claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 3);
      assert.equal(retryClaim.acquired, true);
      assert.ok(retryClaim.claimId);

      completeLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', retryClaim.claimId!, startMs + 4);
      assert.equal(claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 5).acquired, false);
      assert.equal(shouldSendLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 5_003), false);
      assert.equal(shouldSendLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 5_004), true);
      assert.equal(claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 5_004).acquired, true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('allows a replay to reclaim a child-hook receipt after an abandoned claim expires', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-hook-claim-expiry-'));
    const sessionId = 'claim-expiry-session';
    const eventKey = 'subagent-stop:["child-a","turn-1"]';
    const startMs = Date.parse('2026-04-12T00:00:00.000Z');
    try {
      const abandonedClaim = claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs);
      assert.equal(abandonedClaim.acquired, true);
      assert.equal(claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 119_999).acquired, false);

      const recoveredClaim = claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 120_000);
      assert.equal(recoveredClaim.acquired, true);
      assert.ok(recoveredClaim.claimId);
      releaseLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', recoveredClaim.claimId!, startMs + 120_001);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('fails closed on non-record lifecycle receipt state', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-invalid-hook-state-'));
    const sessionId = 'invalid-hook-state-session';
    const statePath = join(stateDir, 'sessions', sessionId, 'lifecycle-notif-state.json');
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      for (const contents of ['[]', JSON.stringify({ hookEvents: [] })]) {
        await writeFile(statePath, contents);
        assert.deepEqual(
          claimLifecycleHookBroadcast(
            stateDir,
            sessionId,
            'subagent-stop:["child-a","turn-1"]',
            'fingerprint',
          ),
          { acquired: false, reason: 'unavailable' },
        );
        assert.equal(await readFile(statePath, 'utf8'), contents);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('renews an active child-hook claim and rejects renewal by a stale owner', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-hook-claim-renewal-'));
    const sessionId = 'claim-renewal-session';
    const eventKey = 'subagent-stop:["child-a","turn-1"]';
    const startMs = Date.parse('2026-04-12T00:00:00.000Z');
    try {
      const claim = claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs);
      assert.equal(claim.acquired, true);
      assert.ok(claim.claimId);
      assert.equal(renewLifecycleHookBroadcastClaim(
        stateDir, sessionId, eventKey, 'fingerprint', 'stale-claim', startMs + 60_000,
      ), false);
      assert.equal(renewLifecycleHookBroadcastClaim(
        stateDir, sessionId, eventKey, 'fingerprint', claim.claimId!, startMs + 60_000,
      ), true);
      assert.deepEqual(
        claimLifecycleHookBroadcast(stateDir, sessionId, eventKey, 'fingerprint', startMs + 120_000),
        { acquired: false, reason: 'duplicate' },
      );

      const expiredClaim = claimLifecycleHookBroadcast(
        stateDir, sessionId, eventKey, 'fingerprint', startMs + 180_000,
      );
      assert.equal(expiredClaim.acquired, true);
      assert.ok(expiredClaim.claimId);
      releaseLifecycleHookBroadcast(
        stateDir, sessionId, eventKey, 'fingerprint', expiredClaim.claimId!, startMs + 180_001,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('prunes expired child-turn keys while retaining live keys and other lifecycle state', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-child-expiry-'));
    try {
      const payload = buildPayload();
      const startMs = Date.parse('2026-04-12T00:00:00.000Z');
      const oldKey = 'subagent-stop:["child-a","turn-1"]';
      const liveKey = 'subagent-stop:["child-b","turn-1"]';
      const nextKey = 'subagent-stop:["child-a","turn-2"]';
      recordLifecycleNotificationSent(stateDir, payload, startMs);
      recordLifecycleHookBroadcastSent(stateDir, payload.sessionId, 'stop', 'leader', startMs);
      recordLifecycleHookBroadcastSent(stateDir, payload.sessionId, oldKey, 'old', startMs);
      recordLifecycleHookBroadcastSent(stateDir, payload.sessionId, liveKey, 'live', startMs + 1_000);
      recordLifecycleHookBroadcastSent(stateDir, payload.sessionId, nextKey, 'next', startMs + 5_000);
      const state = JSON.parse(await readFile(join(stateDir, 'sessions', payload.sessionId!, 'lifecycle-notif-state.json'), 'utf8'));
      assert.equal(state.hookEvents[oldKey], undefined);
      assert.equal(state.hookEvents[liveKey].fingerprint, 'live');
      assert.equal(state.hookEvents[nextKey].fingerprint, 'next');
      assert.equal(state.hookEvents.stop.fingerprint, 'leader');
      assert.ok(state.events['session-end']);
      assert.equal(shouldSendLifecycleHookBroadcast(stateDir, payload.sessionId, liveKey, 'live', startMs + 5_999), false);
      assert.equal(shouldSendLifecycleHookBroadcast(stateDir, payload.sessionId, liveKey, 'live', startMs + 6_000), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('suppresses duplicate session lifecycle notifications for the same session transition', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-'));
    try {
      const payload = buildPayload();
      assert.equal(shouldSendLifecycleNotification(stateDir, payload), true);
      recordLifecycleNotificationSent(stateDir, payload);
      assert.equal(shouldSendLifecycleNotification(stateDir, payload), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('re-emits when the lifecycle fingerprint changes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-change-'));
    try {
      const payload = buildPayload();
      recordLifecycleNotificationSent(stateDir, payload);
      assert.equal(shouldSendLifecycleNotification(stateDir, buildPayload({ reason: 'completed' })), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stores dedupe state per session id', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-session-'));
    try {
      const payload = buildPayload({ sessionId: 'session-a', event: 'session-start' });
      recordLifecycleNotificationSent(stateDir, payload);

      const sessionFile = join(stateDir, 'sessions', 'session-a', 'lifecycle-notif-state.json');
      const state = JSON.parse(await readFile(sessionFile, 'utf-8')) as {
        events?: Record<string, { fingerprint?: string }>;
      };

      assert.equal(typeof state.events?.['session-start']?.fingerprint, 'string');
      assert.equal(shouldSendLifecycleNotification(stateDir, buildPayload({ sessionId: 'session-b', event: 'session-start' })), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('re-emits the same lifecycle fingerprint after the dedupe window elapses', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-window-'));
    try {
      const payload = buildPayload({ event: 'session-start' });
      const startMs = Date.parse('2026-04-12T00:00:00.000Z');

      recordLifecycleNotificationSent(stateDir, payload, startMs);

      assert.equal(shouldSendLifecycleNotification(stateDir, payload, startMs + 4_999), false);
      assert.equal(shouldSendLifecycleNotification(stateDir, payload, startMs + 5_000), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('tracks hook dedupe separately from notification dedupe state', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-hook-'));
    try {
      const payload = buildPayload({ event: 'session-start', sessionId: 'hook-session' });
      const hookFingerprint = 'fp:keyword-detector:turn-1';

      recordLifecycleNotificationSent(stateDir, payload);
      assert.equal(
        shouldSendLifecycleHookBroadcast(stateDir, payload.sessionId, 'keyword-detector', hookFingerprint),
        true,
      );

      recordLifecycleHookBroadcastSent(stateDir, payload.sessionId, 'keyword-detector', hookFingerprint);
      assert.equal(
        shouldSendLifecycleHookBroadcast(stateDir, payload.sessionId, 'keyword-detector', hookFingerprint),
        false,
      );
      assert.equal(shouldSendLifecycleNotification(stateDir, payload), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
