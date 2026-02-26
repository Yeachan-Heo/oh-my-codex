import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_DEFINITIONS,
  getAgent,
  getAgentNames,
  getAgentsByCategory,
  type AgentDefinition,
} from '../definitions.js';

describe('agents/definitions', () => {
  it('returns known agents and undefined for unknown names', () => {
    assert.equal(getAgent('executor'), AGENT_DEFINITIONS.executor);
    assert.equal(getAgent('does-not-exist'), undefined);
  });

  it('keeps key/name contract aligned', () => {
    const names = getAgentNames();
    assert.ok(names.length > 20, 'expected non-trivial agent catalog');

    for (const name of names) {
      const agent = AGENT_DEFINITIONS[name];
      assert.equal(agent.name, name);
      assert.ok(agent.description.length > 0);
    }
  });

  it('filters agents by category', () => {
    const buildAgents = getAgentsByCategory('build');
    assert.ok(buildAgents.length > 0);
    assert.ok(buildAgents.some((agent) => agent.name === 'executor'));

    const allowed: AgentDefinition['category'][] = [
      'build',
      'review',
      'domain',
      'product',
      'coordination',
    ];

    for (const category of allowed) {
      const agents = getAgentsByCategory(category);
      assert.ok(agents.every((agent) => agent.category === category));
    }
  });
});
