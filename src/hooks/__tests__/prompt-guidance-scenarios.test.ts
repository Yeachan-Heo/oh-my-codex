import { describe, it } from 'bun:test';
import { SCENARIO_ROLE_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface } from './prompt-guidance-test-helpers.js';

describe('prompt guidance scenario examples', () => {
  for (const contract of SCENARIO_ROLE_CONTRACTS) {
    it(`${contract.id} documents the expected scenario examples`, () => {
      assertContractSurface(contract);
    });
  }
});
