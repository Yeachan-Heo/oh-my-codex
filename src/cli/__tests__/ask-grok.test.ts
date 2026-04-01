import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskArgs } from '../ask.js';

describe('parseAskArgs with grok provider', () => {
  it('parses grok positional prompt form', () => {
    assert.deepEqual(parseAskArgs(['grok', 'explain', 'this', 'code']), {
      provider: 'grok',
      prompt: 'explain this code',
    });
  });

  it('parses grok -p prompt form', () => {
    assert.deepEqual(parseAskArgs(['grok', '-p', 'brainstorm', 'ideas']), {
      provider: 'grok',
      prompt: 'brainstorm ideas',
    });
  });

  it('parses grok --prompt form', () => {
    assert.deepEqual(parseAskArgs(['grok', '--prompt', 'help me debug']), {
      provider: 'grok',
      prompt: 'help me debug',
    });
  });

  it('parses grok with --agent-prompt', () => {
    const result = parseAskArgs(['grok', '--agent-prompt', 'executor', 'run tests']);
    assert.equal(result.provider, 'grok');
    assert.equal(result.prompt, 'run tests');
    assert.equal(result.agentPromptRole, 'executor');
  });

  it('rejects invalid provider', () => {
    assert.throws(
      () => parseAskArgs(['invalid-provider', 'hello']),
      /Invalid provider/,
    );
  });

  it('rejects empty prompt', () => {
    assert.throws(
      () => parseAskArgs(['grok']),
      /Missing prompt text/,
    );
  });
});
