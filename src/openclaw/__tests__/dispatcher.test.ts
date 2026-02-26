/**
 * Tests for OpenClaw gateway dispatcher.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGatewayUrl,
  shellEscapeArg,
  interpolateInstruction,
  isCommandGateway,
} from '../dispatcher.js';

describe('validateGatewayUrl', () => {
  it('accepts https URLs', () => {
    assert.equal(validateGatewayUrl('https://example.com/hook'), true);
  });

  it('accepts http for localhost', () => {
    assert.equal(validateGatewayUrl('http://localhost:3000/hook'), true);
  });

  it('accepts http for 127.0.0.1', () => {
    assert.equal(validateGatewayUrl('http://127.0.0.1:8080/hook'), true);
  });

  it('accepts http for ::1', () => {
    assert.equal(validateGatewayUrl('http://[::1]:9000/hook'), true);
  });

  it('rejects http for non-localhost', () => {
    assert.equal(validateGatewayUrl('http://example.com/hook'), false);
  });

  it('rejects invalid URLs', () => {
    assert.equal(validateGatewayUrl('not-a-url'), false);
  });

  it('rejects empty string', () => {
    assert.equal(validateGatewayUrl(''), false);
  });
});

describe('shellEscapeArg', () => {
  it('wraps value in single quotes', () => {
    const result = shellEscapeArg('hello world');
    assert.equal(result, "'hello world'");
  });

  it('escapes embedded single quotes', () => {
    const result = shellEscapeArg("it's fine");
    assert.equal(result, "'it'\\''s fine'");
  });

  it('preserves double quotes without escaping', () => {
    const result = shellEscapeArg('say "hello"');
    assert.equal(result, "'say \"hello\"'");
  });

  it('handles empty string', () => {
    const result = shellEscapeArg('');
    assert.equal(result, "''");
  });
});

describe('interpolateInstruction', () => {
  it('replaces known variables', () => {
    const result = interpolateInstruction('Session {{sessionId}} ended', { sessionId: 'abc' });
    assert.equal(result, 'Session abc ended');
  });

  it('leaves unknown variables as-is (not empty)', () => {
    const result = interpolateInstruction('{{unknownVar}} text', {});
    assert.equal(result, '{{unknownVar}} text');
  });

  it('leaves undefined variables as-is', () => {
    const result = interpolateInstruction('{{sessionId}}', { sessionId: undefined });
    assert.equal(result, '{{sessionId}}');
  });

  it('replaces multiple variables', () => {
    const result = interpolateInstruction('{{event}} in {{projectName}}', {
      event: 'session-end',
      projectName: 'my-proj',
    });
    assert.equal(result, 'session-end in my-proj');
  });
});

describe('isCommandGateway', () => {
  it('returns true for command gateway', () => {
    assert.equal(isCommandGateway({ type: 'command', command: 'notify-send test' }), true);
  });

  it('returns false for http gateway', () => {
    assert.equal(isCommandGateway({ url: 'https://example.com' }), false);
  });

  it('returns false for http gateway with explicit type', () => {
    assert.equal(isCommandGateway({ type: 'http', url: 'https://example.com' }), false);
  });
});

describe('wakeCommandGateway - command gate', () => {
  afterEach(() => {
    delete process.env.OMX_OPENCLAW_COMMAND;
  });

  it('returns error when OMX_OPENCLAW_COMMAND is not set', async () => {
    const { wakeCommandGateway } = await import('../dispatcher.js');
    delete process.env.OMX_OPENCLAW_COMMAND;
    const result = await wakeCommandGateway('test', { type: 'command', command: 'echo hi' }, {});
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('OMX_OPENCLAW_COMMAND'));
  });

  it('succeeds when OMX_OPENCLAW_COMMAND=1 and command exits 0', async () => {
    const { wakeCommandGateway } = await import('../dispatcher.js');
    process.env.OMX_OPENCLAW_COMMAND = '1';
    const result = await wakeCommandGateway('test', { type: 'command', command: 'true' }, {});
    assert.equal(result.success, true);
  });

  it('returns error when command exits non-zero', async () => {
    const { wakeCommandGateway } = await import('../dispatcher.js');
    process.env.OMX_OPENCLAW_COMMAND = '1';
    const result = await wakeCommandGateway('test', { type: 'command', command: 'false' }, {});
    assert.equal(result.success, false);
  });
});
