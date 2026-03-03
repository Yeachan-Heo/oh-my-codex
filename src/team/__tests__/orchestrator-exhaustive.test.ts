import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPhaseAgents, getPhaseInstructions } from '../orchestrator.js';

describe('orchestrator phase functions', () => {
  const validPhases = ['team-plan', 'team-prd', 'team-exec', 'team-verify', 'team-fix'];

  for (const phase of validPhases) {
    it(`getPhaseAgents returns array for ${phase}`, () => {
      const result = getPhaseAgents(phase as any);
      assert.ok(Array.isArray(result));
    });

    it(`getPhaseInstructions returns string for ${phase}`, () => {
      const result = getPhaseInstructions(phase as any);
      assert.ok(typeof result === 'string');
    });
  }

  it('getPhaseAgents throws on unknown phase', () => {
    assert.throws(() => getPhaseAgents('unknown-phase' as any), /Unknown team phase/);
  });

  it('getPhaseInstructions throws on unknown phase', () => {
    assert.throws(() => getPhaseInstructions('unknown-phase' as any), /Unknown team phase/);
  });
});
