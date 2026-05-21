/**
 * Tests for OpenClaw gateway dispatcher.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGatewayUrl,
  shellEscapeArg,
  interpolateInstruction,
  isCommandGateway,
  resolveCommandTimeoutMs,
  wakeGateway,
} from '../dispatcher.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} should exit before timeout`);
}


describe('wakeGateway proxy routing', () => {
  const ORIGINAL_ENV = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    ALL_PROXY: process.env.ALL_PROXY,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };

  afterEach(() => {
    for (const key of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  it('uses HTTP_PROXY for OpenClaw HTTP gateways', async () => {
    const seen: string[] = [];
    await withServer((_req, res) => {
      res.statusCode = 500;
      res.end('direct path should not be used');
    }, async (targetUrl) => {
      await withServer((req, res) => {
        seen.push(req.url ?? '');
        res.end('ok');
      }, async (proxyUrl) => {
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;
        delete process.env.ALL_PROXY;
        delete process.env.all_proxy;
        process.env.HTTP_PROXY = proxyUrl;
        delete process.env.http_proxy;
        const result = await wakeGateway('local', { url: `${targetUrl}/wake` }, {
          event: 'session-idle',
          instruction: 'wake',
          text: 'wake',
          timestamp: '2026-05-05T00:00:00.000Z',
          context: {},
        });
        assert.equal(result.success, true);
        assert.deepEqual(seen, [`${targetUrl}/wake`]);
      });
    });
  });
});

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

  it('replaces unknown variables with empty string', () => {
    const result = interpolateInstruction('{{unknownVar}} text', {});
    assert.equal(result, ' text');
  });

  it('replaces undefined variables with empty string', () => {
    const result = interpolateInstruction('{{sessionId}}', { sessionId: undefined });
    assert.equal(result, '');
  });

  it('replaces undefined tmuxSession with empty string', () => {
    const result = interpolateInstruction('tmux:{{tmuxSession}}', { tmuxSession: undefined });
    assert.equal(result, 'tmux:');
  });

  it('replaces multiple variables', () => {
    const result = interpolateInstruction('{{event}} in {{projectName}}', {
      event: 'session-end',
      projectName: 'my-proj',
    });
    assert.equal(result, 'session-end in my-proj');
  });
});

describe('interpolateInstruction - reply context variables', () => {
  it('replaces {{replyChannel}} variable', () => {
    const result = interpolateInstruction('channel: {{replyChannel}}', { replyChannel: 'general' });
    assert.equal(result, 'channel: general');
  });

  it('replaces {{replyTarget}} variable', () => {
    const result = interpolateInstruction('to: {{replyTarget}}', { replyTarget: '@bot' });
    assert.equal(result, 'to: @bot');
  });

  it('replaces {{replyThread}} variable', () => {
    const result = interpolateInstruction('thread: {{replyThread}}', { replyThread: 'thread-123' });
    assert.equal(result, 'thread: thread-123');
  });

  it('replaces reply variables with empty string when undefined', () => {
    const result = interpolateInstruction(
      '{{replyChannel}} {{replyTarget}} {{replyThread}}',
      { replyChannel: undefined, replyTarget: undefined, replyThread: undefined },
    );
    assert.equal(result, '  ');
  });

  it('replaces all reply variables together', () => {
    const result = interpolateInstruction(
      'notify {{replyTarget}} in {{replyChannel}} thread {{replyThread}}',
      { replyChannel: '#dev', replyTarget: 'user42', replyThread: 'ts-999' },
    );
    assert.equal(result, 'notify user42 in #dev thread ts-999');
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

describe('resolveCommandTimeoutMs', () => {
  afterEach(() => {
    delete process.env.OMX_OPENCLAW_COMMAND_TIMEOUT_MS;
  });

  it('uses default timeout when gateway and env timeouts are absent', () => {
    assert.equal(resolveCommandTimeoutMs(undefined, undefined), 5000);
  });

  it('uses env timeout when gateway timeout is absent', () => {
    assert.equal(resolveCommandTimeoutMs(undefined, '120000'), 120000);
  });

  it('uses gateway timeout over env timeout', () => {
    assert.equal(resolveCommandTimeoutMs(45000, '120000'), 45000);
  });

  it('clamps timeout to minimum bound', () => {
    assert.equal(resolveCommandTimeoutMs(10, undefined), 100);
  });

  it('clamps timeout to maximum bound', () => {
    assert.equal(resolveCommandTimeoutMs(999999, undefined), 300000);
  });

  it('ignores invalid env timeout and falls back to default', () => {
    assert.equal(resolveCommandTimeoutMs(undefined, 'not-a-number'), 5000);
  });
});

describe('wakeCommandGateway - command gate', () => {
  afterEach(() => {
    delete process.env.OMX_OPENCLAW_COMMAND;
    delete process.env.OMX_OPENCLAW_COMMAND_TIMEOUT_MS;
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

  it('uses env timeout when gateway timeout is not set', async () => {
    const { wakeCommandGateway } = await import('../dispatcher.js');
    process.env.OMX_OPENCLAW_COMMAND = '1';
    process.env.OMX_OPENCLAW_COMMAND_TIMEOUT_MS = '100';
    const result = await wakeCommandGateway(
      'test',
      { type: 'command', command: "node -e \"setTimeout(() => {}, 250)\"" },
      {},
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timed out'));
  });

  it('kills shell-command descendants on timeout to avoid bash process leaks', async () => {
    const { wakeCommandGateway } = await import('../dispatcher.js');
      const cwd = await mkdtemp(join(tmpdir(), 'omx-openclaw-process-leak-'));
    try {
      const pidFile = join(cwd, 'grandchild.pid');
      const scriptFile = join(cwd, 'spawn-grandchild.cjs');
      const script = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore'
        });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        setInterval(() => {}, 1000);
      `;
      await writeFile(scriptFile, script);
      process.env.OMX_OPENCLAW_COMMAND = '1';

      const result = await wakeCommandGateway(
        'test',
        { type: 'command', command: `${process.execPath} ${scriptFile}; true`, timeout: 500 },
        {},
      );
      const pid = Number(await readFile(pidFile, 'utf8'));

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('timed out'));
      await waitForProcessExit(pid);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses gateway timeout over env timeout', async () => {
    const { wakeCommandGateway } = await import('../dispatcher.js');
    process.env.OMX_OPENCLAW_COMMAND = '1';
    process.env.OMX_OPENCLAW_COMMAND_TIMEOUT_MS = '100';
    const result = await wakeCommandGateway(
      'test',
      { type: 'command', command: "node -e \"setTimeout(() => {}, 250)\"", timeout: 5000 },
      {},
    );
    assert.equal(result.success, true);
  });
});
