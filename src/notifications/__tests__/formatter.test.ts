import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSessionIdle,
  formatSessionStart,
  formatSessionEnd,
  formatSessionStop,
  formatAskUserQuestion,
  formatNotification,
  parseTmuxTail,
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

describe('parseTmuxTail', () => {
  it('strips ANSI escape codes', () => {
    const raw = '\x1b[32mHello\x1b[0m world';
    assert.strictEqual(parseTmuxTail(raw), 'Hello world');
  });

  it('removes lines starting with spinner characters ●⎿✻·◼', () => {
    const raw = [
      '● Thinking...',
      '⎿ Processing files',
      '✻ Loading',
      '· waiting',
      '◼ stopped',
      'Actual output line',
    ].join('\n');
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('●'));
    assert.ok(!result.includes('⎿'));
    assert.ok(!result.includes('✻'));
    assert.ok(!result.includes('·'));
    assert.ok(!result.includes('◼'));
    assert.ok(result.includes('Actual output line'));
  });

  it('removes ctrl+o to expand markers (case-insensitive)', () => {
    const raw = 'some output\nctrl+o to expand\nmore output\nCTRL+O TO EXPAND';
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('ctrl+o'));
    assert.ok(!result.includes('CTRL+O'));
    assert.ok(result.includes('some output'));
    assert.ok(result.includes('more output'));
  });

  it('caps output at 10 meaningful lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const result = parseTmuxTail(lines.join('\n'));
    const resultLines = result.split('\n');
    assert.strictEqual(resultLines.length, 10);
    // Should keep the last 10 lines
    assert.strictEqual(resultLines[0], 'line 11');
    assert.strictEqual(resultLines[9], 'line 20');
  });

  it('returns empty string when all lines are filtered out', () => {
    const raw = '● spinner\n⎿ spinner\nctrl+o to expand';
    assert.strictEqual(parseTmuxTail(raw), '');
  });

  it('trims trailing whitespace from individual lines', () => {
    const raw = '  leading spaces  \n\t tabbed line \t';
    const result = parseTmuxTail(raw);
    assert.ok(result.includes('leading spaces'));
    assert.ok(result.includes('tabbed line'));
    // Trailing whitespace should be removed
    assert.ok(!result.endsWith(' '));
    assert.ok(!result.endsWith('\t'));
  });

  it('handles combined ANSI codes and spinner lines', () => {
    const raw = '\x1b[33m● Thinking...\x1b[0m\nReal output\n\x1b[32mDone\x1b[0m';
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('Thinking'));
    assert.ok(result.includes('Real output'));
    assert.ok(result.includes('Done'));
  });

  it('removes lines composed entirely of box-drawing characters', () => {
    const raw = [
      '─────────────────────',
      '╔══════════╗',
      '│ content  │',
      '└──────────┘',
      'Actual output',
    ].join('\n');
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('─────'));
    assert.ok(!result.includes('╔'));
    assert.ok(!result.includes('└'));
    assert.ok(result.includes('Actual output'));
  });

  it('removes OMX HUD status lines', () => {
    const raw = [
      '[OMX#3] ultrawork active',
      '[OMX] idle',
      'Normal output line',
    ].join('\n');
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('[OMX'));
    assert.ok(result.includes('Normal output line'));
  });

  it('removes bypass-permissions indicator lines starting with ⏵', () => {
    const raw = '⏵ bypass active\nNormal output';
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('⏵'));
    assert.ok(result.includes('Normal output'));
  });

  it('removes bare shell prompt lines', () => {
    const raw = '>\n$\n%\n#\n❯\nsome command output';
    const result = parseTmuxTail(raw);
    assert.ok(!result.split('\n').some(l => /^[❯>$%#]+$/.test(l.trim())));
    assert.ok(result.includes('some command output'));
  });

  it('drops lines with low alphanumeric density (< 15%) for long lines', () => {
    // A line of 10 chars with 0 alphanumeric = 0% density
    const raw = '!@#$%^&*()  \nNormal line with words';
    const result = parseTmuxTail(raw);
    assert.ok(!result.includes('!@#$%^&*()'));
    assert.ok(result.includes('Normal line with words'));
  });

  it('keeps short lines (< 8 chars) even with low alphanumeric density', () => {
    // "---" is 3 chars, below the 8-char threshold for density check
    const raw = '---\nNormal output';
    const result = parseTmuxTail(raw);
    assert.ok(result.includes('---'));
    assert.ok(result.includes('Normal output'));
  });

  it('buildTmuxTailBlock uses parseTmuxTail output', () => {
    const raw = '● spinner\nreal work done\nctrl+o to expand';
    const result = formatSessionIdle({ ...basePayload, tmuxTail: raw });
    assert.ok(result.includes('real work done'));
    assert.ok(!result.includes('spinner'));
    assert.ok(!result.includes('ctrl+o'));
  });

  it('buildTmuxTailBlock omits block when all lines filtered', () => {
    const raw = '● spinner only\n⎿ more spinner';
    const result = formatSessionIdle({ ...basePayload, tmuxTail: raw });
    assert.ok(!result.includes('Recent output'));
  });
});
