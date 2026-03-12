import { describe, it } from 'bun:test';
import { CORE_ROLE_CONTRACTS, ROOT_TEMPLATE_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface } from './prompt-guidance-test-helpers.js';

describe('prompt guidance contract', () => {
  for (const contract of [...ROOT_TEMPLATE_CONTRACTS, ...CORE_ROLE_CONTRACTS]) {
    it(`${contract.id} satisfies the core prompt-guidance contract`, () => {
      assertContractSurface(contract);
    });
  }
});
