import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { WAVE_TWO_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface, loadSurface } from './prompt-guidance-test-helpers.js';

describe('prompt guidance wave two contract', () => {
  for (const contract of WAVE_TWO_CONTRACTS) {
    it(`${contract.id} satisfies the wave-two contract`, () => {
      assertContractSurface(contract);
    });
  }

  it('wave-two prompts encode role-appropriate grounded-evidence wording', () => {
    assert.match(loadSurface('prompts/architect.md'), /analysis is grounded/i);
    assert.match(loadSurface('prompts/critic.md'), /verdict is grounded/i);
    assert.match(loadSurface('prompts/debugger.md'), /diagnosis is grounded/i);
    assert.match(loadSurface('prompts/test-engineer.md'), /recommendation is grounded/i);
    assert.match(loadSurface('prompts/code-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/quality-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/security-reviewer.md'), /security verdict is grounded/i);
    assert.match(loadSurface('prompts/researcher.md'), /answer is grounded/i);
    assert.match(loadSurface('prompts/explore.md'), /answer is grounded/i);
  });

  it('security and verifier-adjacent prompts preserve merge-if-green as downstream context', () => {
    assert.match(loadSurface('prompts/security-reviewer.md'), /merge if CI green/i);
    assert.match(loadSurface('prompts/critic.md'), /later workflow condition|downstream context/i);
    assert.match(loadSurface('prompts/test-engineer.md'), /merge if CI green/i);
  });
});
