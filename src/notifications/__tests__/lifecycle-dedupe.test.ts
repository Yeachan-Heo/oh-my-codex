import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldSendLifecycleNotification,
  recordLifecycleNotificationSent,
  shouldSendLifecycleHookBroadcast,
  recordLifecycleHookBroadcastSent,
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
  it('preserves concurrent hook receipts across processes', async () => {
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
    const children: Array<{ child: ReturnType<typeof spawn>; donePath: string; exit: Promise<void> }> = [];

    try {
      await waitForFiles([readyPath]);
      for (const childId of ['child-a', 'child-b']) {
        const startedPath = join(stateDir, `${childId}.started`);
        const donePath = join(stateDir, `${childId}.done`);
        const eventKey = `subagent-stop:${JSON.stringify([childId, 'turn-1'])}`;
        const writerSource = `
          import { writeFileSync } from 'node:fs';
          import { recordLifecycleHookBroadcastSent } from ${JSON.stringify(lifecycleModuleUrl)};
          writeFileSync(${JSON.stringify(startedPath)}, 'started');
          recordLifecycleHookBroadcastSent(${JSON.stringify(stateDir)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(eventKey)}, ${JSON.stringify(childId)});
          writeFileSync(${JSON.stringify(donePath)}, 'done');
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', writerSource], { stdio: 'ignore' });
        children.push({ child, donePath, exit: waitForChildExit(child) });
      }
      await waitForFiles(children.map(({ donePath }) => donePath.replace(/\.done$/, '.started')));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(children.map(({ donePath }) => existsSync(donePath)), [false, false]);

      await writeFile(releasePath, 'release');
      await Promise.all(children.map(({ exit }) => exit));
      await holderExit;

      const state = JSON.parse(await readFile(statePath, 'utf8'));
      for (const childId of ['child-a', 'child-b']) {
        const eventKey = `subagent-stop:${JSON.stringify([childId, 'turn-1'])}`;
        assert.equal(state.hookEvents[eventKey].fingerprint, childId);
      }
    } finally {
      await writeFile(releasePath, 'release').catch(() => {});
      for (const { child } of children) child.kill();
      holder.kill();
      await Promise.allSettled([...children.map(({ exit }) => exit), holderExit]);
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
