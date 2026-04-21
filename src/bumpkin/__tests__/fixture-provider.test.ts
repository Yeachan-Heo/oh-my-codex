import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hashRequest, type ModelRequest, type ModelResponse } from '../model/provider.js';
import {
  FixtureModelProvider,
  UnrecordedPromptError,
  recordEntry,
} from '../model/fixture-provider.js';

const RESPONSE: ModelResponse = {
  content: 'hello',
  stopReason: 'end_turn',
  inputTokens: 10,
  outputTokens: 3,
};

function sampleRequest(): ModelRequest {
  return {
    system: 'you are bumpkin',
    messages: [{ role: 'user', content: 'fix this breakage' }],
  };
}

describe('bumpkin/fixture-provider', () => {
  it('hashRequest is stable for identical inputs', () => {
    const a = hashRequest(sampleRequest());
    const b = hashRequest(sampleRequest());
    assert.equal(a, b);
  });

  it('hashRequest is order-insensitive for object keys', () => {
    const a = hashRequest({
      system: 'S',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const b = hashRequest({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'S',
    });
    assert.equal(a, b);
  });

  it('hashRequest differs when content differs', () => {
    const a = hashRequest({ messages: [{ role: 'user', content: 'a' }] });
    const b = hashRequest({ messages: [{ role: 'user', content: 'b' }] });
    assert.notEqual(a, b);
  });

  it('returns the recorded response for matching request', async () => {
    const req = sampleRequest();
    const provider = new FixtureModelProvider({ recordings: [recordEntry(req, RESPONSE)] });
    const out = await provider.call(req);
    assert.equal(out.content, 'hello');
    assert.equal(out.inputTokens, 10);
  });

  it('throws UnrecordedPromptError when request has no recording', async () => {
    const provider = new FixtureModelProvider({ recordings: [] });
    await assert.rejects(
      () => provider.call(sampleRequest()),
      (err: unknown) => {
        assert.ok(err instanceof UnrecordedPromptError);
        assert.match((err as Error).message, /no recording found for prompt hash/);
        return true;
      },
    );
  });

  it('logs every call for later inspection', async () => {
    const req = sampleRequest();
    const provider = new FixtureModelProvider({ recordings: [recordEntry(req, RESPONSE)] });
    await provider.call(req);
    await provider.call(req);
    assert.equal(provider.calls().length, 2);
  });

  it('invokes onUnrecorded fallback when provided', async () => {
    let seenHash = '';
    const provider = new FixtureModelProvider({
      recordings: [],
      onUnrecorded: (hash) => {
        seenHash = hash;
        return { content: 'fallback', stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 };
      },
    });
    const out = await provider.call(sampleRequest());
    assert.equal(out.content, 'fallback');
    assert.equal(seenHash.length, 64);
  });
});
