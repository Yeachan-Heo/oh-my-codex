import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

describe('lifecycle notification dedupe', () => {
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
