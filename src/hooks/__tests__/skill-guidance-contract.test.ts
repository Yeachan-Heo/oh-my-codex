import { describe, it } from 'node:test';
import {
  LEAN_MODE_SKILL_CONTRACTS,
  MODULAR_TRACER_SKILL_CONTRACTS,
  SKILL_CONTRACTS,
} from '../prompt-guidance-contract.js';
import { assertContractSurface } from './prompt-guidance-test-helpers.js';

describe('execution-heavy skill guidance contract', () => {
  for (const contract of [
    ...SKILL_CONTRACTS,
    ...MODULAR_TRACER_SKILL_CONTRACTS,
    ...LEAN_MODE_SKILL_CONTRACTS,
  ]) {
    it(`${contract.id} satisfies the execution-heavy skill guidance contract`, () => {
      assertContractSurface(contract);
    });
  }
});
