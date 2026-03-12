import { describe, it } from 'bun:test';
import { CATALOG_CONTRACTS, LEGACY_PROMPT_CONTRACTS, SPECIALIZED_PROMPT_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface } from './prompt-guidance-test-helpers.js';

describe('prompt guidance catalog coverage', () => {
  for (const contract of [...CATALOG_CONTRACTS, ...LEGACY_PROMPT_CONTRACTS, ...SPECIALIZED_PROMPT_CONTRACTS]) {
    it(`${contract.id} satisfies catalog prompt-guidance coverage`, () => {
      assertContractSurface(contract);
    });
  }
});
