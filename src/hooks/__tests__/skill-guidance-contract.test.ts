import { describe, it } from 'bun:test';
import { SKILL_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface } from './prompt-guidance-test-helpers.js';

describe('execution-heavy skill guidance contract', () => {
  for (const contract of SKILL_CONTRACTS) {
    it(`${contract.id} satisfies the execution-heavy skill guidance contract`, () => {
      assertContractSurface(contract);
    });
  }
});
