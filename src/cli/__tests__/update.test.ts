import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerVersion, shouldCheckForUpdates } from '../update.js';

describe('isNewerVersion', () => {
  it('returns true when latest has higher major', () => {
    assert.equal(isNewerVersion('1.0.0', '2.0.0'), true);
  });

  it('returns true when latest has higher minor', () => {
    assert.equal(isNewerVersion('1.0.0', '1.1.0'), true);
  });

  it('returns true when latest has higher patch', () => {
    assert.equal(isNewerVersion('1.0.0', '1.0.1'), true);
  });

  it('returns false when versions are equal', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
  });

  it('returns false when current is ahead', () => {
    assert.equal(isNewerVersion('2.0.0', '1.9.9'), false);
  });

  it('returns false for invalid current version', () => {
    assert.equal(isNewerVersion('invalid', '1.0.0'), false);
  });

  it('returns false for invalid latest version', () => {
    assert.equal(isNewerVersion('1.0.0', 'invalid'), false);
  });

  it('handles v-prefixed versions', () => {
    assert.equal(isNewerVersion('v1.0.0', 'v1.0.1'), true);
  });

  it('returns false when major is lower even if minor/patch higher', () => {
    assert.equal(isNewerVersion('2.5.5', '1.9.9'), false);
  });
});

describe('shouldCheckForUpdates', () => {
  const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

  it('returns true when state is null', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), null), true);
  });

  it('returns true when last_checked_at is missing', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), {} as never), true);
  });

  it('returns true when last_checked_at is invalid', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), { last_checked_at: 'not-a-date' }), true);
  });

  it('returns false when checked within interval', () => {
    const now = Date.now();
    const recentCheck = new Date(now - INTERVAL_MS + 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: recentCheck }), false);
  });

  it('returns true when check is overdue', () => {
    const now = Date.now();
    const oldCheck = new Date(now - INTERVAL_MS - 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: oldCheck }), true);
  });

  it('returns true when exactly at interval boundary', () => {
    const now = Date.now();
    const exactCheck = new Date(now - INTERVAL_MS).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: exactCheck }), true);
  });

  it('respects custom interval', () => {
    const now = Date.now();
    const customInterval = 60 * 1000; // 1 min
    const recentCheck = new Date(now - 30 * 1000).toISOString(); // 30s ago
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: recentCheck }, customInterval), false);
  });
});
