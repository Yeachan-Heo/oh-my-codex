import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import {
  RateLimiter,
  captureReplyAcknowledgementSummary,
  formatReplyAcknowledgement,
  sanitizeReplyInput,
  isReplyListenerProcess,
  normalizeReplyListenerConfig,
  pollDiscordOnce,
  pollTelegramOnce,
  resetReplyListenerTransientState,
} from '../reply-listener.js';
import type { ReplyListenerDaemonConfig, ReplyListenerState } from '../reply-listener.js';
import type { SessionMapping } from '../session-registry.js';

function createBaseConfig(overrides: Partial<ReplyListenerDaemonConfig> = {}): ReplyListenerDaemonConfig {
  return {
    enabled: true,
    pollIntervalMs: 3000,
    maxMessageLength: 500,
    rateLimitPerMinute: 10,
    includePrefix: true,
    authorizedDiscordUserIds: ['discord-user-1'],
    discordEnabled: true,
    discordBotToken: 'discord-token',
    discordChannelId: 'discord-channel',
    telegramEnabled: true,
    telegramBotToken: '123456:telegram-token',
    telegramChatId: '777',
    ...overrides,
  };
}

function createBaseState(): ReplyListenerState {
  return {
    isRunning: true,
    pid: 123,
    startedAt: '2026-03-20T00:00:00.000Z',
    lastPollAt: null,
    telegramLastUpdateId: null,
    discordLastMessageId: null,
    messagesInjected: 0,
    errors: 0,
  };
}

function cloneState(state: ReplyListenerState): ReplyListenerState {
  return JSON.parse(JSON.stringify(state)) as ReplyListenerState;
}

function createMapping(platform: SessionMapping['platform']): SessionMapping {
  return {
    platform,
    messageId: platform === 'discord-bot' ? 'orig-discord-msg' : '222',
    sessionId: 'session-1',
    tmuxPaneId: '%9',
    tmuxSessionName: 'omx-session',
    event: 'session-idle',
    createdAt: '2026-03-20T00:00:00.000Z',
    projectPath: '/tmp/project',
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

type HttpsRouteHandler = (body: string, options: ClientRequestArgs) => {
  statusCode: number;
  body?: unknown;
};

function createHttpsRequestMock(routes: Record<string, HttpsRouteHandler>): typeof import('node:https').request {
  return ((options: ClientRequestArgs, callback?: (res: IncomingMessage) => void) => {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let requestBody = '';

    const emit = (event: string, value?: unknown) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(value);
      }
    };

    const request = {
      on(event: string, handler: (value?: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return request;
      },
      write(chunk: string | Buffer) {
        requestBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
        return true;
      },
      end() {
        queueMicrotask(() => {
          try {
            const key = `${options.method ?? 'GET'} ${options.path ?? ''}`;
            const route = routes[key];
            assert.ok(route, `Unexpected https request: ${key}`);
            const result = route(requestBody, options);
            const response = new PassThrough() as PassThrough & IncomingMessage;
            (response as { statusCode?: number }).statusCode = result.statusCode;
            callback?.(response);
            if (result.body !== undefined) {
              response.write(
                typeof result.body === 'string'
                  ? result.body
                  : JSON.stringify(result.body),
              );
            }
            response.end();
          } catch (error) {
            emit('error', error);
          }
        });
        return request;
      },
      destroy() {
        return request;
      },
    };

    return request;
  }) as typeof import('node:https').request;
}

describe('sanitizeReplyInput', () => {
  it('passes through normal text', () => {
    assert.equal(sanitizeReplyInput('hello world'), 'hello world');
  });

  it('strips control characters', () => {
    assert.equal(sanitizeReplyInput('hello\x00world'), 'helloworld');
    assert.equal(sanitizeReplyInput('test\x07bell'), 'testbell');
    assert.equal(sanitizeReplyInput('test\x1bescseq'), 'testescseq');
  });

  it('replaces newlines with spaces', () => {
    assert.equal(sanitizeReplyInput('line1\nline2'), 'line1 line2');
    assert.equal(sanitizeReplyInput('line1\r\nline2'), 'line1 line2');
  });

  it('escapes backslashes', () => {
    assert.equal(sanitizeReplyInput('path\\to\\file'), 'path\\\\to\\\\file');
  });

  it('escapes backticks', () => {
    assert.equal(sanitizeReplyInput('run `cmd`'), 'run \\`cmd\\`');
  });

  it('escapes $( command substitution', () => {
    assert.equal(sanitizeReplyInput('$(whoami)'), '\\$(whoami)');
  });

  it('escapes ${ variable expansion', () => {
    assert.equal(sanitizeReplyInput('${HOME}'), '\\${HOME}');
  });

  it('trims whitespace', () => {
    assert.equal(sanitizeReplyInput('  hello  '), 'hello');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeReplyInput(''), '');
  });

  it('handles whitespace-only string', () => {
    assert.equal(sanitizeReplyInput('   '), '');
  });

  it('handles combined dangerous patterns', () => {
    const input = '$(rm -rf /) && `evil` ${PATH}\nmore';
    const result = sanitizeReplyInput(input);
    assert.ok(!result.includes('\n'));
    assert.ok(result.includes('\\$('));
    assert.ok(result.includes('\\${'));
    assert.ok(result.includes('\\`'));
  });

  it('preserves normal special characters', () => {
    assert.equal(sanitizeReplyInput('hello! @user #tag'), 'hello! @user #tag');
  });

  it('handles unicode text', () => {
    const result = sanitizeReplyInput('Hello world');
    assert.ok(result.length > 0);
  });
});

describe('isReplyListenerProcess', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('returns false for the current process (test runner has no daemon marker)', () => {
    assert.equal(isReplyListenerProcess(process.pid), false);
  });

  it('returns false on native Windows instead of shelling out to ps', (_, done) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const child = spawn(
      process.execPath,
      ['-e', 'const pollLoop = () => {}; setInterval(pollLoop, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, false);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns true for a process whose command line contains the daemon marker', (_, done) => {
    const child = spawn(
      process.execPath,
      ['-e', 'const pollLoop = () => {}; setInterval(pollLoop, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, true);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a process whose command line lacks the daemon marker', (_, done) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, false);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a non-existent PID', () => {
    assert.equal(isReplyListenerProcess(0), false);
  });
});

describe('normalizeReplyListenerConfig', () => {
  it('clamps invalid runtime numeric values and sanitizes authorized users', () => {
    const normalized = normalizeReplyListenerConfig({
      enabled: true,
      pollIntervalMs: 0,
      maxMessageLength: -10,
      rateLimitPerMinute: -1,
      includePrefix: false,
      authorizedDiscordUserIds: ['123', '', '  ', '456'],
      discordEnabled: true,
      discordBotToken: 'bot-token',
      discordChannelId: 'channel-id',
    });

    assert.equal(normalized.pollIntervalMs, 500);
    assert.equal(normalized.maxMessageLength, 1);
    assert.equal(normalized.rateLimitPerMinute, 1);
    assert.equal(normalized.includePrefix, false);
    assert.deepEqual(normalized.authorizedDiscordUserIds, ['123', '456']);
  });

  it('infers enabled flags from credentials when omitted', () => {
    const normalized = normalizeReplyListenerConfig({
      enabled: true,
      pollIntervalMs: 3000,
      maxMessageLength: 500,
      rateLimitPerMinute: 10,
      includePrefix: true,
      authorizedDiscordUserIds: [],
      telegramBotToken: 'tg-token',
      telegramChatId: 'tg-chat',
    });

    assert.equal(normalized.telegramEnabled, true);
    assert.equal(normalized.discordEnabled, false);
  });
});

describe('captureReplyAcknowledgementSummary', () => {
  it('captures a cleaned recent-output summary via tmux-tail parsing', () => {
    const summary = captureReplyAcknowledgementSummary('%9', {
      capturePaneContentImpl: (paneId, lines) => {
        assert.equal(paneId, '%9');
        assert.equal(lines, 200);
        return [
          '● spinner',
          'Meaningful output line',
          '  continuation line',
          '',
        ].join('\n');
      },
    });

    assert.equal(summary, 'Meaningful output line\n  continuation line');
  });

  it('returns null when the captured pane tail has no meaningful lines', () => {
    const summary = captureReplyAcknowledgementSummary('%9', {
      capturePaneContentImpl: () => '● spinner\nctrl+o to expand',
    });

    assert.equal(summary, null);
  });

  it('truncates oversized summaries without cutting the acknowledgment prefix logic', () => {
    const longLine = 'x'.repeat(900);
    const summary = captureReplyAcknowledgementSummary('%9', {
      capturePaneContentImpl: () => longLine,
      parseTmuxTailImpl: () => longLine,
    });

    assert.equal(summary?.length, 700);
    assert.ok(summary?.endsWith('…'));
  });
});

describe('formatReplyAcknowledgement', () => {
  it('includes recent output when a summary is available', () => {
    const message = formatReplyAcknowledgement('Line 1\nLine 2');

    assert.equal(
      message,
      'Injected into Codex CLI session.\n\nRecent output:\nLine 1\nLine 2',
    );
  });

  it('falls back when no summary is available', () => {
    const message = formatReplyAcknowledgement(null);

    assert.equal(
      message,
      'Injected into Codex CLI session.\n\nRecent output summary unavailable.',
    );
  });
});

describe('pollDiscordOnce', () => {
  it('injects authorized replies and posts a threaded acknowledgement with recent output', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ discordMention: '<@123>' });
    const state = createBaseState();
    const writes: ReplyListenerState[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/messages?limit=10')) {
        return jsonResponse([
          {
            id: 'discord-reply-1',
            author: { id: 'discord-user-1' },
            content: 'run status',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]);
      }
      if (url.includes('/reactions/')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/messages')) {
        return jsonResponse({ id: 'ack-1' });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    };

    await pollDiscordOnce(
      config,
      state,
      new RateLimiter(10),
      {
        fetchImpl,
        lookupByMessageIdImpl: () => createMapping('discord-bot'),
        injectReplyImpl: (paneId, text, platform, activeConfig) => {
          assert.equal(paneId, '%9');
          assert.equal(text, 'run status');
          assert.equal(platform, 'discord');
          assert.equal(activeConfig, config);
          return true;
        },
        captureReplyAcknowledgementSummaryImpl: () => 'Recent pane output',
        parseMentionAllowedMentionsImpl: (mention) => {
          assert.equal(mention, '<@123>');
          return { users: ['123'] } as ReturnType<typeof import('../config.js').parseMentionAllowedMentions>;
        },
        writeDaemonStateImpl: (nextState) => {
          writes.push(cloneState(nextState));
        },
      },
    );

    assert.equal(state.messagesInjected, 1);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-reply-1');
    assert.ok(writes.length >= 1);
    assert.equal(fetchCalls.length, 3);

    const acknowledgementCall = fetchCalls[2];
    assert.ok(acknowledgementCall.url.endsWith('/messages'));
    const acknowledgementBody = JSON.parse(String(acknowledgementCall.init?.body));
    assert.equal(
      acknowledgementBody.content,
      'Injected into Codex CLI session.\n\nRecent output:\nRecent pane output',
    );
    assert.deepEqual(acknowledgementBody.message_reference, { message_id: 'discord-reply-1' });
    assert.deepEqual(acknowledgementBody.allowed_mentions, { users: ['123'] });
  });

  it('ignores unauthorized Discord replies while still advancing the last message id', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      new RateLimiter(10),
      {
        fetchImpl: async () => jsonResponse([
          {
            id: 'discord-reply-2',
            author: { id: 'intruder' },
            content: 'malicious',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]),
        lookupByMessageIdImpl: () => {
          throw new Error('lookup should not be called for unauthorized replies');
        },
        injectReplyImpl: () => {
          throw new Error('injectReply should not be called for unauthorized replies');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-reply-2');
  });

  it('drops mapped Discord replies when the rate limiter rejects them', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();
    let injectCalled = false;

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      { canProceed: () => false, reset: () => {} },
      {
        fetchImpl: async () => jsonResponse([
          {
            id: 'discord-reply-3',
            author: { id: 'discord-user-1' },
            content: 'status?',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]),
        lookupByMessageIdImpl: () => createMapping('discord-bot'),
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.discordLastMessageId, 'discord-reply-3');
  });
});

describe('pollTelegramOnce', () => {
  it('injects Telegram replies and sends a reply acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const writes: ReplyListenerState[] = [];
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 44,
                  message: {
                    message_id: 333,
                    chat: { id: 777 },
                    text: 'continue',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 444 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: (paneId, text, platform) => {
          assert.equal(paneId, '%9');
          assert.equal(text, 'continue');
          assert.equal(platform, 'telegram');
          return true;
        },
        captureReplyAcknowledgementSummaryImpl: () => 'Recent telegram output',
        writeDaemonStateImpl: (nextState) => {
          writes.push(cloneState(nextState));
        },
      },
    );

    assert.equal(state.messagesInjected, 1);
    assert.equal(state.errors, 0);
    assert.equal(state.telegramLastUpdateId, 44);
    assert.ok(writes.length >= 1);

    const parsedBody = JSON.parse(sendMessageBody) as {
      chat_id: string;
      text: string;
      reply_to_message_id: number;
    };
    assert.equal(parsedBody.chat_id, config.telegramChatId);
    assert.equal(parsedBody.reply_to_message_id, 333);
    assert.equal(
      parsedBody.text,
      'Injected into Codex CLI session.\n\nRecent output:\nRecent telegram output',
    );
  });

  it('ignores Telegram replies from the wrong chat', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageAttempted = false;

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 45,
                  message: {
                    message_id: 334,
                    chat: { id: 999 },
                    text: 'wrong chat',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            sendMessageAttempted = true;
            return { statusCode: 200, body: { ok: true, result: { message_id: 445 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for wrong-chat messages');
        },
      },
    );

    assert.equal(sendMessageAttempted, false);
  });

  it('records an error when Telegram injection fails and does not send an acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageAttempted = false;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 46,
                  message: {
                    message_id: 335,
                    chat: { id: 777 },
                    text: 'blocked',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            sendMessageAttempted = true;
            return { statusCode: 200, body: { ok: true, result: { message_id: 446 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => false,
      },
    );

    assert.equal(sendMessageAttempted, false);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.telegramLastUpdateId, 46);
  });
});
