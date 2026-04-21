import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { FetchLike } from '../model/http.js';
import { HttpProviderError } from '../model/http.js';
import { AnthropicProvider } from '../model/anthropic-provider.js';
import {
  groqProvider,
  openaiProvider,
  OpenAICompatibleProvider,
} from '../model/openai-compatible-provider.js';

function recordingFetch(
  response: { status: number; body: string; headers?: Record<string, string> },
): { fetcher: FetchLike; calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return {
      status: response.status,
      headers: response.headers ?? {},
      async text() {
        return response.body;
      },
    };
  };
  return { fetcher, calls };
}

describe('bumpkin/anthropic-provider', () => {
  it('posts to /v1/messages with the anthropic auth headers', async () => {
    const { fetcher, calls } = recordingFetch({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    });
    const provider = new AnthropicProvider({
      apiKey: 'sk-abc',
      model: 'claude-sonnet-4-6',
      fetcher,
    });
    const result = await provider.call({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.content, 'hi');
    assert.equal(result.inputTokens, 12);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0]?.headers['x-api-key'], 'sk-abc');
    assert.equal(calls[0]?.headers['anthropic-version'], '2023-06-01');
    const reqBody = JSON.parse(calls[0]?.body ?? '{}');
    assert.equal(reqBody.model, 'claude-sonnet-4-6');
    assert.equal(reqBody.system, 'be helpful');
    assert.deepEqual(reqBody.messages, [{ role: 'user', content: 'hello' }]);
  });

  it('concatenates multiple text content blocks', async () => {
    const { fetcher } = recordingFetch({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'text', text: 'part1 ' },
          { type: 'text', text: 'part2' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    });
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetcher });
    const result = await provider.call({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(result.content, 'part1 part2');
  });

  it('exposes tool_use blocks when present', async () => {
    const { fetcher } = recordingFetch({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', name: 'search', input: { q: 'bumpkin' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetcher });
    const result = await provider.call({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(result.stopReason, 'tool_use');
    assert.equal(result.toolUse?.length, 1);
    assert.equal(result.toolUse?.[0]?.name, 'search');
  });

  it('throws HttpProviderError on non-2xx', async () => {
    const { fetcher } = recordingFetch({ status: 401, body: '{"error": "unauthorized"}' });
    const provider = new AnthropicProvider({ apiKey: 'bad', model: 'm', fetcher });
    await assert.rejects(
      () => provider.call({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof HttpProviderError && (err as HttpProviderError).status === 401,
    );
  });
});

describe('bumpkin/openai-compatible-provider', () => {
  it('posts to /chat/completions with bearer auth', async () => {
    const { fetcher, calls } = recordingFetch({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
      model: 'qwen-3',
      baseUrl: 'https://api.groq.com/openai/v1',
      fetcher,
    });
    const result = await provider.call({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
    });
    assert.equal(result.content, 'ok');
    assert.equal(result.inputTokens, 20);
    assert.equal(result.outputTokens, 5);
    assert.equal(calls[0]?.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[0]?.headers['authorization'], 'Bearer k');
    const reqBody = JSON.parse(calls[0]?.body ?? '{}');
    assert.equal(reqBody.messages[0].role, 'system');
  });

  it('maps finish_reason=length to max_tokens stopReason', async () => {
    const { fetcher } = recordingFetch({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }],
      }),
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://x.example',
      fetcher,
    });
    const result = await provider.call({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(result.stopReason, 'max_tokens');
  });

  it('groqProvider and openaiProvider configure base URLs correctly', async () => {
    const { fetcher: groqFetch, calls: groqCalls } = recordingFetch({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'g' }, finish_reason: 'stop' }] }),
    });
    const { fetcher: oaiFetch, calls: oaiCalls } = recordingFetch({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'o' }, finish_reason: 'stop' }] }),
    });
    const g = groqProvider({ apiKey: 'k', model: 'x', fetcher: groqFetch });
    const o = openaiProvider({ apiKey: 'k', model: 'x', fetcher: oaiFetch });
    await g.call({ messages: [{ role: 'user', content: 'u' }] });
    await o.call({ messages: [{ role: 'user', content: 'u' }] });
    assert.match(groqCalls[0]?.url ?? '', /groq/);
    assert.match(oaiCalls[0]?.url ?? '', /openai\.com/);
    assert.equal(g.id, 'groq:x');
    assert.equal(o.id, 'openai:x');
  });
});
