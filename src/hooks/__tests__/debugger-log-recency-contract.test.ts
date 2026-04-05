import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSurface } from './prompt-guidance-test-helpers.js';

describe('debugger log recency guidance contract', () => {
  it('root guidance prioritizes newer same-thread evidence over stale context', () => {
    for (const surface of ['AGENTS.md', 'templates/AGENTS.md']) {
      const content = loadSurface(surface);
      assert.match(content, /newer same-thread evidence/i);
      assert.match(content, /current source of truth/i);
      assert.match(content, /do not anchor on older evidence unless the user reaffirms it/i);
    }
  });

  it('debugger guidance prioritizes the latest logs in the current turn', () => {
    const content = loadSurface('prompts/debugger.md');
    assert.match(content, /newly provided logs, stack traces, and diagnostics in the current turn/i);
    assert.match(content, /primary evidence/i);
    assert.match(content, /instead of anchoring on older logs/i);
  });
});
