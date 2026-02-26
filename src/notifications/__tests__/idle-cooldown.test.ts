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
});
