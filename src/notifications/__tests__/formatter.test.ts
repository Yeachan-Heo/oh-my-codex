import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSessionIdle,
  formatSessionStart,
  formatSessionEnd,
  formatSessionStop,
  formatAskUserQuestion,
  formatNotification,
} from '../formatter.js';
import type { FullNotificationPayload } from '../types.js';

const basePayload: FullNotificationPayload = {
  event: 'session-idle',
  sessionId: 'test-session-123',
  message: '',
  timestamp: new Date('2025-01-15T12:00:00Z').toISOString(),
  projectPath: '/home/user/my-project',
  projectName: 'my-project',
};

describe('formatSessionIdle', () => {
  it('should include idle header and waiting message', () => {
    const result = formatSessionIdle(basePayload);
    assert.ok(result.includes('# Session Idle'));
    assert.ok(result.includes('Codex has finished and is waiting for input.'));
  });

  it('should include project info in footer', () => {
    const result = formatSessionIdle(basePayload);
    assert.ok(result.includes('`my-project`'));
  });

  it('should include reason when provided', () => {
    const result = formatSessionIdle({ ...basePayload, reason: 'task_complete' });
    assert.ok(result.includes('**Reason:** task_complete'));
  });

  it('should include modes when provided', () => {
    const result = formatSessionIdle({ ...basePayload, modesUsed: ['ultrawork', 'ralph'] });
    assert.ok(result.includes('**Modes:** ultrawork, ralph'));
  });

  it('should include tmux session in footer when available', () => {
    const result = formatSessionIdle({ ...basePayload, tmuxSession: 'dev-session' });
    assert.ok(result.includes('`dev-session`'));
  });
});

describe('formatSessionStart', () => {
  it('should include start header and session info', () => {
    const result = formatSessionStart({ ...basePayload, event: 'session-start' });
    assert.ok(result.includes('# Session Started'));
    assert.ok(result.includes('`test-session-123`'));
    assert.ok(result.includes('`my-project`'));
  });

  it('should include tmux session when available', () => {
    const result = formatSessionStart({ ...basePayload, event: 'session-start', tmuxSession: 'main' });
    assert.ok(result.includes('`main`'));
  });
});

describe('formatSessionEnd', () => {
  it('should include end header and duration', () => {
    const result = formatSessionEnd({ ...basePayload, event: 'session-end', durationMs: 125000 });
    assert.ok(result.includes('# Session Ended'));
    assert.ok(result.includes('2m 5s'));
  });

  it('should include agents count', () => {
    const result = formatSessionEnd({ ...basePayload, event: 'session-end', agentsSpawned: 5, agentsCompleted: 3 });
    assert.ok(result.includes('3/5 completed'));
  });

  it('should include modes and summary', () => {
    const result = formatSessionEnd({
      ...basePayload,
      event: 'session-end',
      modesUsed: ['ralph'],
      contextSummary: 'Fixed auth bug',
    });
    assert.ok(result.includes('**Modes:** ralph'));
    assert.ok(result.includes('**Summary:** Fixed auth bug'));
  });
});

describe('formatSessionStop', () => {
  it('should include continuing header and mode info', () => {
    const result = formatSessionStop({
      ...basePayload,
      event: 'session-stop',
      activeMode: 'ralph',
      iteration: 3,
      maxIterations: 10,
    });
    assert.ok(result.includes('# Session Continuing'));
    assert.ok(result.includes('**Mode:** ralph'));
    assert.ok(result.includes('3/10'));
  });
});

describe('formatAskUserQuestion', () => {
  it('should include question text', () => {
    const result = formatAskUserQuestion({
      ...basePayload,
      event: 'ask-user-question',
      question: 'Which approach should I use?',
    });
    assert.ok(result.includes('# Input Needed'));
    assert.ok(result.includes('Which approach should I use?'));
    assert.ok(result.includes('Codex is waiting for your response.'));
  });
});

describe('formatNotification routing', () => {
  it('should route each event type correctly', () => {
    assert.ok(formatNotification({ ...basePayload, event: 'session-idle' }).includes('# Session Idle'));
    assert.ok(formatNotification({ ...basePayload, event: 'session-start' }).includes('# Session Started'));
    assert.ok(formatNotification({ ...basePayload, event: 'session-end' }).includes('# Session Ended'));
    assert.ok(formatNotification({ ...basePayload, event: 'session-stop' }).includes('# Session Continuing'));
    assert.ok(formatNotification({ ...basePayload, event: 'ask-user-question' }).includes('# Input Needed'));
  });
});
