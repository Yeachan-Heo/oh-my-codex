import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSessionStart,
  formatSessionEnd,
  formatSessionIdle,
} from '../../notifications/formatter.js';
import type { FullNotificationPayload } from '../../notifications/types.js';

describe('lifecycle notification payload formatting', () => {
  const basePayload: FullNotificationPayload = {
    event: 'session-start',
    sessionId: 'omx-test-456',
    message: '',
    timestamp: '2026-02-16T12:00:00.000Z',
    projectPath: '/home/user/my-project',
    projectName: 'my-project',
  };

  it('session-start includes session ID and project name', () => {
    const msg = formatSessionStart(basePayload);
    assert.ok(msg.includes('Session Started'));
    assert.ok(msg.includes('omx-test-456'));
    assert.ok(msg.includes('my-project'));
  });

  it('session-end includes duration and reason', () => {
    const msg = formatSessionEnd({
      ...basePayload,
      event: 'session-end',
      durationMs: 3661000, // 1h 1m 1s
      reason: 'session_exit',
    });
    assert.ok(msg.includes('Session Ended'));
    assert.ok(msg.includes('1h 1m 1s'));
    assert.ok(msg.includes('session_exit'));
  });

  it('session-end shows unknown duration when durationMs is missing', () => {
    const msg = formatSessionEnd({
      ...basePayload,
      event: 'session-end',
      reason: 'session_exit',
    });
    assert.ok(msg.includes('unknown'));
  });

  it('session-idle includes idle message and project', () => {
    const msg = formatSessionIdle({
      ...basePayload,
      event: 'session-idle',
    });
    assert.ok(msg.includes('Session Idle'));
    assert.ok(msg.includes('waiting for input'));
    assert.ok(msg.includes('my-project'));
  });
});
