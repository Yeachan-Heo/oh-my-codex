import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
      assert.ok(agent.reasoningEffort.length > 0);
      assert.ok(agent.posture.length > 0);
      assert.ok(agent.modelClass.length > 0);
      assert.ok(agent.routingRole.length > 0);
    }
  });

  it('filters agents by category', () => {
    const buildAgents = getAgentsByCategory('build');
    assert.ok(buildAgents.length > 0);
    assert.ok(buildAgents.some((agent) => agent.name === 'executor'));
    assert.ok(buildAgents.some((agent) => agent.name === 'team-executor'));

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

  it('keeps the installable agent model split aligned with the OMX subagent matrix', () => {
    assert.equal(AGENT_DEFINITIONS.architect.modelClass, 'frontier');
    assert.equal(AGENT_DEFINITIONS['security-reviewer'].modelClass, 'frontier');
    assert.equal(AGENT_DEFINITIONS['test-engineer'].modelClass, 'frontier');
    assert.equal(AGENT_DEFINITIONS['team-executor'].modelClass, 'frontier');
    assert.equal(AGENT_DEFINITIONS.vision.modelClass, 'frontier');

    assert.equal(AGENT_DEFINITIONS.explore.modelClass, 'fast');

    for (const name of [
      'researcher',
      'debugger',
      'designer',
      'writer',
      'git-master',
      'build-fixer',
      'executor',
      'verifier',
      'dependency-expert',
    ] as const) {
      assert.equal(AGENT_DEFINITIONS[name].modelClass, 'standard');
      assert.equal(AGENT_DEFINITIONS[name].reasoningEffort, name === 'executor' ? 'medium' : 'high');
    }
  });
});
