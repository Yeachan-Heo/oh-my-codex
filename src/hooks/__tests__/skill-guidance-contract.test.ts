import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface, loadSurface } from './prompt-guidance-test-helpers.js';

describe('execution-heavy skill guidance contract', () => {
  for (const contract of SKILL_CONTRACTS) {
    it(`${contract.id} satisfies the execution-heavy skill guidance contract`, () => {
      assertContractSurface(contract);
    });
  }

  it('ultrawork guidance stays OMX-native and avoids upstream-only runtime taxonomy', () => {
    const content = loadSurface('skills/ultrawork/SKILL.md');
    assert.doesNotMatch(content, /@opencode-ai\/plugin|bun:sqlite|\.sisyphus/i);
    assert.doesNotMatch(content, /\boracle\b|\blibrarian\b|\bartistry\b|\bPrometheus\b/i);
    assert.match(content, /Ralph owns persistence, architect verification, deslop, and the full verified-completion promise/i);
  });
});
