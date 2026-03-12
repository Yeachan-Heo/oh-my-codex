/**
 * Tests for dispatch notification cooldown module.
 */

import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getDispatchNotificationCooldownSeconds,
  shouldSendDispatchNotification,
  recordDispatchNotificationSent,
} from '../dispatch-cooldown.js';

function makeTmpStateDir(): string {
  const dir = join(tmpdir(), `omx-dispatch-cooldown-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('getDispatchNotificationCooldownSeconds', () => {
  afterEach(() => {
    delete process.env.OMX_DISPATCH_COOLDOWN_SECONDS;
  });

  it('returns default 60 when no env or config', () => {
    delete process.env.OMX_DISPATCH_COOLDOWN_SECONDS;
    assert.equal(getDispatchNotificationCooldownSeconds(), 60);
  });

  it('uses OMX_DISPATCH_COOLDOWN_SECONDS env var', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = '120';
    assert.equal(getDispatchNotificationCooldownSeconds(), 120);
  });

  it('returns 0 when cooldown is disabled via env', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = '0';
    assert.equal(getDispatchNotificationCooldownSeconds(), 0);
  });

  it('ignores invalid env values and falls back to default', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = 'not-a-number';
    assert.equal(getDispatchNotificationCooldownSeconds(), 60);
  });
});

describe('shouldSendDispatchNotification', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpStateDir();
    delete process.env.OMX_DISPATCH_COOLDOWN_SECONDS;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OMX_DISPATCH_COOLDOWN_SECONDS;
  });

  it('returns true when no cooldown file exists', () => {
    assert.equal(shouldSendDispatchNotification(stateDir), true);
  });

  it('returns true when cooldown is 0 (disabled)', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = '0';
    recordDispatchNotificationSent(stateDir, 'sess1');
    assert.equal(shouldSendDispatchNotification(stateDir, 'sess1'), true);
  });

  it('returns false when cooldown has NOT elapsed', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = '60';
    recordDispatchNotificationSent(stateDir, 'sess2');
    assert.equal(shouldSendDispatchNotification(stateDir, 'sess2'), false);
  });

  it('returns true when cooldown HAS elapsed (stale timestamp)', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = '1';
    const oldTs = new Date(Date.now() - 5000).toISOString();
    const cooldownPath = join(stateDir, 'dispatch-notif-cooldown.json');
    writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: oldTs }));
    assert.equal(shouldSendDispatchNotification(stateDir), true);
  });

  it('uses session-scoped path, global path unaffected', () => {
    process.env.OMX_DISPATCH_COOLDOWN_SECONDS = '60';
    const sessionId = 'test-session-abc123';
    recordDispatchNotificationSent(stateDir, sessionId);
    assert.equal(shouldSendDispatchNotification(stateDir, sessionId), false);
    assert.equal(shouldSendDispatchNotification(stateDir), true);
  });

  it('returns true when cooldown file has malformed JSON', () => {
    const cooldownPath = join(stateDir, 'dispatch-notif-cooldown.json');
    writeFileSync(cooldownPath, 'invalid json {{{');
    assert.equal(shouldSendDispatchNotification(stateDir), true);
  });
});

describe('recordDispatchNotificationSent', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpStateDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes a cooldown file with lastSentAt timestamp', () => {
    recordDispatchNotificationSent(stateDir);
    const content = JSON.parse(readFileSync(join(stateDir, 'dispatch-notif-cooldown.json'), 'utf-8')) as { lastSentAt: string };
    assert.equal(typeof content.lastSentAt, 'string');
    assert.ok(new Date(content.lastSentAt).getTime() > Date.now() - 2000);
  });

  it('creates session-scoped subdirectory when sessionId is provided', () => {
    const sessionId = 'my-session-xyz';
    recordDispatchNotificationSent(stateDir, sessionId);
    const sessionFile = join(stateDir, 'sessions', sessionId, 'dispatch-notif-cooldown.json');
    assert.ok(existsSync(sessionFile));
  });
});
