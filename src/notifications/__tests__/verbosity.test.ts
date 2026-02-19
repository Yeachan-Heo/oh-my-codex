import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getVerbosity,
  isEventAllowedByVerbosity,
  shouldIncludeTmuxTail,
  isEventEnabled,
} from '../config.js';
import { formatSessionEnd, formatSessionIdle, formatSessionStop } from '../formatter.js';
import type { FullNotificationConfig, FullNotificationPayload, VerbosityLevel } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FullNotificationConfig> = {}): FullNotificationConfig {
  return {
    enabled: true,
    discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/test' },
    ...overrides,
  };
}

const basePayload: FullNotificationPayload = {
  event: 'session-end',
  sessionId: 'test-session-1',
  message: '',
  timestamp: '2026-02-19T12:00:00.000Z',
  projectPath: '/home/user/my-project',
  projectName: 'my-project',
};

// ---------------------------------------------------------------------------
// getVerbosity
// ---------------------------------------------------------------------------

describe('getVerbosity', () => {
  const origEnv = process.env.OMX_NOTIFY_VERBOSITY;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.OMX_NOTIFY_VERBOSITY;
    } else {
      process.env.OMX_NOTIFY_VERBOSITY = origEnv;
    }
  });

  it('defaults to "session" when no config or env var', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    assert.equal(getVerbosity(makeConfig()), 'session');
  });

  it('reads verbosity from config', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    assert.equal(getVerbosity(makeConfig({ verbosity: 'minimal' })), 'minimal');
  });

  it('env var overrides config', () => {
    process.env.OMX_NOTIFY_VERBOSITY = 'verbose';
    assert.equal(getVerbosity(makeConfig({ verbosity: 'minimal' })), 'verbose');
  });

  it('ignores invalid env var and falls back to config', () => {
    process.env.OMX_NOTIFY_VERBOSITY = 'invalid';
    assert.equal(getVerbosity(makeConfig({ verbosity: 'agent' })), 'agent');
  });

  it('ignores invalid config value and falls back to default', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    assert.equal(getVerbosity(makeConfig({ verbosity: 'bogus' as VerbosityLevel })), 'session');
  });

  it('handles null config gracefully', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    assert.equal(getVerbosity(null), 'session');
  });
});

// ---------------------------------------------------------------------------
// isEventAllowedByVerbosity
// ---------------------------------------------------------------------------

describe('isEventAllowedByVerbosity', () => {
  // Minimal: start, stop, end only
  it('minimal allows session-start', () => {
    assert.equal(isEventAllowedByVerbosity('minimal', 'session-start'), true);
  });
  it('minimal allows session-stop', () => {
    assert.equal(isEventAllowedByVerbosity('minimal', 'session-stop'), true);
  });
  it('minimal allows session-end', () => {
    assert.equal(isEventAllowedByVerbosity('minimal', 'session-end'), true);
  });
  it('minimal rejects session-idle', () => {
    assert.equal(isEventAllowedByVerbosity('minimal', 'session-idle'), false);
  });
  it('minimal rejects ask-user-question', () => {
    assert.equal(isEventAllowedByVerbosity('minimal', 'ask-user-question'), false);
  });

  // Session: includes idle
  it('session allows session-idle', () => {
    assert.equal(isEventAllowedByVerbosity('session', 'session-idle'), true);
  });
  it('session rejects ask-user-question', () => {
    assert.equal(isEventAllowedByVerbosity('session', 'ask-user-question'), false);
  });

  // Agent: includes ask-user-question
  it('agent allows ask-user-question', () => {
    assert.equal(isEventAllowedByVerbosity('agent', 'ask-user-question'), true);
  });
  it('agent allows session-idle', () => {
    assert.equal(isEventAllowedByVerbosity('agent', 'session-idle'), true);
  });

  // Verbose: allows everything
  it('verbose allows all events', () => {
    assert.equal(isEventAllowedByVerbosity('verbose', 'session-start'), true);
    assert.equal(isEventAllowedByVerbosity('verbose', 'session-stop'), true);
    assert.equal(isEventAllowedByVerbosity('verbose', 'session-end'), true);
    assert.equal(isEventAllowedByVerbosity('verbose', 'session-idle'), true);
    assert.equal(isEventAllowedByVerbosity('verbose', 'ask-user-question'), true);
  });
});

// ---------------------------------------------------------------------------
// shouldIncludeTmuxTail
// ---------------------------------------------------------------------------

describe('shouldIncludeTmuxTail', () => {
  it('returns false for minimal', () => {
    assert.equal(shouldIncludeTmuxTail('minimal'), false);
  });
  it('returns true for session', () => {
    assert.equal(shouldIncludeTmuxTail('session'), true);
  });
  it('returns true for agent', () => {
    assert.equal(shouldIncludeTmuxTail('agent'), true);
  });
  it('returns true for verbose', () => {
    assert.equal(shouldIncludeTmuxTail('verbose'), true);
  });
});

// ---------------------------------------------------------------------------
// isEventEnabled with verbosity
// ---------------------------------------------------------------------------

describe('isEventEnabled with verbosity', () => {
  const origEnv = process.env.OMX_NOTIFY_VERBOSITY;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.OMX_NOTIFY_VERBOSITY;
    } else {
      process.env.OMX_NOTIFY_VERBOSITY = origEnv;
    }
  });

  it('minimal config blocks session-idle', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    const config = makeConfig({ verbosity: 'minimal' });
    assert.equal(isEventEnabled(config, 'session-idle'), false);
  });

  it('minimal config allows session-end', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    const config = makeConfig({ verbosity: 'minimal' });
    assert.equal(isEventEnabled(config, 'session-end'), true);
  });

  it('session config allows session-idle', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    const config = makeConfig({ verbosity: 'session' });
    assert.equal(isEventEnabled(config, 'session-idle'), true);
  });

  it('session config blocks ask-user-question', () => {
    delete process.env.OMX_NOTIFY_VERBOSITY;
    const config = makeConfig({ verbosity: 'session' });
    assert.equal(isEventEnabled(config, 'ask-user-question'), false);
  });

  it('env var override takes precedence', () => {
    process.env.OMX_NOTIFY_VERBOSITY = 'verbose';
    const config = makeConfig({ verbosity: 'minimal' });
    assert.equal(isEventEnabled(config, 'ask-user-question'), true);
  });
});

// ---------------------------------------------------------------------------
// Formatter tmux tail inclusion
// ---------------------------------------------------------------------------

describe('formatter tmux tail inclusion', () => {
  it('formatSessionEnd includes tmux tail when present', () => {
    const msg = formatSessionEnd({
      ...basePayload,
      durationMs: 60000,
      reason: 'session_exit',
      tmuxTail: '$ npm test\nAll tests passed\n$',
    });
    assert.ok(msg.includes('Recent output:'));
    assert.ok(msg.includes('npm test'));
    assert.ok(msg.includes('All tests passed'));
  });

  it('formatSessionEnd omits tmux tail when absent', () => {
    const msg = formatSessionEnd({
      ...basePayload,
      durationMs: 60000,
      reason: 'session_exit',
    });
    assert.ok(!msg.includes('Recent output:'));
  });

  it('formatSessionIdle includes tmux tail when present', () => {
    const msg = formatSessionIdle({
      ...basePayload,
      event: 'session-idle',
      tmuxTail: 'waiting for input...',
    });
    assert.ok(msg.includes('Recent output:'));
    assert.ok(msg.includes('waiting for input...'));
  });

  it('formatSessionStop includes tmux tail when present', () => {
    const msg = formatSessionStop({
      ...basePayload,
      event: 'session-stop',
      tmuxTail: 'iteration 3/10 complete',
    });
    assert.ok(msg.includes('Recent output:'));
    assert.ok(msg.includes('iteration 3/10 complete'));
  });
});
