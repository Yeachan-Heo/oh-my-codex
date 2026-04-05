/**
 * Tests for idle notification cooldown module.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getIdleNotificationCooldownSeconds,
  shouldSendIdleNotification,
  recordIdleNotificationSent,
  shouldSendSessionIdleHookEvent,
  recordSessionIdleHookEventSent,
} from '../idle-cooldown.js';

function makeTmpStateDir(): string {
  const dir = join(tmpdir(), `omx-cooldown-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('getIdleNotificationCooldownSeconds', () => {
  afterEach(() => {
    delete process.env.OMX_IDLE_COOLDOWN_SECONDS;
  });

  it('returns default 60 when no env or config', () => {
    delete process.env.OMX_IDLE_COOLDOWN_SECONDS;
    assert.equal(getIdleNotificationCooldownSeconds(), 60);
  });

  it('uses OMX_IDLE_COOLDOWN_SECONDS env var', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '120';
    assert.equal(getIdleNotificationCooldownSeconds(), 120);
  });

  it('returns 0 when cooldown is disabled via env', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '0';
    assert.equal(getIdleNotificationCooldownSeconds(), 0);
  });

  it('ignores invalid env values and falls back to default', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = 'not-a-number';
    assert.equal(getIdleNotificationCooldownSeconds(), 60);
  });
});

describe('shouldSendIdleNotification', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpStateDir();
    delete process.env.OMX_IDLE_COOLDOWN_SECONDS;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OMX_IDLE_COOLDOWN_SECONDS;
  });

  it('returns true when no cooldown file exists', () => {
    assert.equal(shouldSendIdleNotification(stateDir), true);
  });

  it('returns true when cooldown is 0 (disabled)', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '0';
    recordIdleNotificationSent(stateDir, 'sess1');
    assert.equal(shouldSendIdleNotification(stateDir, 'sess1'), true);
  });

  it('returns true when cooldown is 0 even for unchanged fingerprints', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '0';
    const sessionId = 'test-session-disabled-fingerprint';
    const fingerprint = '{"phase":"idle","summary":"Waiting for input"}';

    recordIdleNotificationSent(stateDir, sessionId, fingerprint);

    assert.equal(shouldSendIdleNotification(stateDir, sessionId, fingerprint), true);
  });

  it('returns false when cooldown has NOT elapsed', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '60';
    recordIdleNotificationSent(stateDir, 'sess2');
    assert.equal(shouldSendIdleNotification(stateDir, 'sess2'), false);
  });

  it('returns true when cooldown HAS elapsed (stale timestamp)', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '1';
    const oldTs = new Date(Date.now() - 5000).toISOString();
    const cooldownPath = join(stateDir, 'idle-notif-cooldown.json');
    writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: oldTs }));
    assert.equal(shouldSendIdleNotification(stateDir), true);
  });

  it('uses session-scoped path, global path unaffected', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '60';
    const sessionId = 'test-session-abc123';
    recordIdleNotificationSent(stateDir, sessionId);
    assert.equal(shouldSendIdleNotification(stateDir, sessionId), false);
    assert.equal(shouldSendIdleNotification(stateDir), true);
  });

  it('returns true when cooldown file has malformed JSON', () => {
    const cooldownPath = join(stateDir, 'idle-notif-cooldown.json');
    writeFileSync(cooldownPath, 'invalid json {{{');
    assert.equal(shouldSendIdleNotification(stateDir), true);
  });

  it('suppresses repeated unchanged idle fingerprints', () => {
    const sessionId = 'test-session-unchanged';
    const fingerprint = '{"phase":"idle","summary":"Waiting for input"}';

    recordIdleNotificationSent(stateDir, sessionId, fingerprint);

    assert.equal(shouldSendIdleNotification(stateDir, sessionId, fingerprint), false);
  });

  it('allows a changed summary fingerprint immediately', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '60';
    const sessionId = 'test-session-summary-change';

    recordIdleNotificationSent(stateDir, sessionId, '{"phase":"idle","summary":"Waiting on review"}');

    assert.equal(
      shouldSendIdleNotification(stateDir, sessionId, '{"phase":"idle","summary":"Waiting on user input"}'),
      true,
    );
  });

  it('allows a progress transition to clear prior idle suppression', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '60';
    const sessionId = 'test-session-progress-reset';
    const blockedFingerprint = '{"phase":"idle","summary":"Blocked on dependency"}';
    const progressFingerprint = '{"phase":"progress","summary":"Applied fix and running tests"}';

    recordIdleNotificationSent(stateDir, sessionId, blockedFingerprint);
    assert.equal(shouldSendIdleNotification(stateDir, sessionId, blockedFingerprint), false);

    recordIdleNotificationSent(stateDir, sessionId, progressFingerprint);
    assert.equal(shouldSendIdleNotification(stateDir, sessionId, blockedFingerprint), true);
  });

  it('allows terminal transitions to clear prior idle suppression', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '60';
    const sessionId = 'test-session-terminal-reset';
    const blockedFingerprint = '{"phase":"idle","summary":"Awaiting next step"}';

    recordIdleNotificationSent(stateDir, sessionId, blockedFingerprint);
    recordIdleNotificationSent(stateDir, sessionId, '{"phase":"finished","summary":"Completed and waiting for input"}');
    assert.equal(shouldSendIdleNotification(stateDir, sessionId, blockedFingerprint), true);

    recordIdleNotificationSent(stateDir, sessionId, blockedFingerprint);
    recordIdleNotificationSent(stateDir, sessionId, '{"phase":"failed","summary":"Command failed"}');
    assert.equal(shouldSendIdleNotification(stateDir, sessionId, blockedFingerprint), true);
  });

  it('still honors cooldown-only behavior when no fingerprint is provided', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '60';
    const sessionId = 'test-session-cooldown-only';

    recordIdleNotificationSent(stateDir, sessionId);

    assert.equal(shouldSendIdleNotification(stateDir, sessionId), false);
  });
});

describe('recordIdleNotificationSent', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpStateDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes a cooldown file with lastSentAt timestamp', () => {
    recordIdleNotificationSent(stateDir);
    const content = JSON.parse(readFileSync(join(stateDir, 'idle-notif-cooldown.json'), 'utf-8')) as { lastSentAt: string };
    assert.equal(typeof content.lastSentAt, 'string');
    assert.ok(new Date(content.lastSentAt).getTime() > Date.now() - 2000);
  });

  it('creates session-scoped subdirectory when sessionId is provided', () => {
    const sessionId = 'my-session-xyz';
    recordIdleNotificationSent(stateDir, sessionId);
    const sessionFile = join(stateDir, 'sessions', sessionId, 'idle-notif-cooldown.json');
    assert.ok(existsSync(sessionFile));
  });

  it('persists the idle fingerprint when provided', () => {
    const sessionId = 'fingerprint-session';
    const fingerprint = '{"phase":"idle","summary":"Waiting for input"}';

    recordIdleNotificationSent(stateDir, sessionId, fingerprint);

    const sessionFile = join(stateDir, 'sessions', sessionId, 'idle-notif-cooldown.json');
    const content = JSON.parse(readFileSync(sessionFile, 'utf-8')) as { lastSentAt: string; fingerprint?: string };
    assert.equal(content.fingerprint, fingerprint);
    assert.equal(typeof content.lastSentAt, 'string');
  });
});

describe('session-idle hook event dedupe', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpStateDir();
    delete process.env.OMX_IDLE_COOLDOWN_SECONDS;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OMX_IDLE_COOLDOWN_SECONDS;
  });

  it('suppresses unchanged hook fingerprints even when lifecycle cooldown is disabled', () => {
    process.env.OMX_IDLE_COOLDOWN_SECONDS = '0';
    const sessionId = 'test-session-hook-zero-cooldown';
    const fingerprint = '{"phase":"idle","summary":"Waiting for input"}';

    recordSessionIdleHookEventSent(stateDir, sessionId, fingerprint);

    assert.equal(shouldSendSessionIdleHookEvent(stateDir, sessionId, fingerprint), false);
  });

  it('re-emits when the hook fingerprint changes', () => {
    const sessionId = 'test-session-hook-change';
    recordSessionIdleHookEventSent(stateDir, sessionId, '{"phase":"idle","summary":"Waiting on review"}');

    assert.equal(
      shouldSendSessionIdleHookEvent(stateDir, sessionId, '{"phase":"idle","summary":"Waiting on user input"}'),
      true,
    );
  });
});
