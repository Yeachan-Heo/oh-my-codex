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

  it('requires a four-valued reasoning default on every AgentDefinition', () => {
    const definitionShape = {
      name: 'type-contract',
      description: 'Type contract fixture',
      posture: 'deep-worker',
      modelClass: 'standard',
      routingRole: 'executor',
      tools: 'execution',
      category: 'build',
    } as const;
    const validDefinition: AgentDefinition = {
      ...definitionShape,
      reasoningEffort: 'high',
    };
    const reasoningEffortIsRequired:
      undefined extends AgentDefinition['reasoningEffort'] ? false : true = true;
    void validDefinition;
    void reasoningEffortIsRequired;

    // @ts-expect-error AgentDefinition.reasoningEffort is required.
    const missingReasoningEffort: AgentDefinition = definitionShape;
    const invalidUndefinedDefinition = {
      ...definitionShape,
      reasoningEffort: undefined,
    } as const;
    const invalidMaxDefinition = {
      ...definitionShape,
      reasoningEffort: 'max',
    } as const;
    const invalidUltraDefinition = {
      ...definitionShape,
      reasoningEffort: 'ultra',
    } as const;
    // @ts-expect-error AgentDefinition.reasoningEffort excludes undefined.
    const undefinedReasoningEffort: AgentDefinition = invalidUndefinedDefinition;
    // @ts-expect-error AgentDefinition.reasoningEffort excludes per-agent max.
    const maxReasoningEffort: AgentDefinition = invalidMaxDefinition;
    // @ts-expect-error AgentDefinition.reasoningEffort excludes ultra.
    const ultraReasoningEffort: AgentDefinition = invalidUltraDefinition;
    void missingReasoningEffort;
    void undefinedReasoningEffort;
    void maxReasoningEffort;
    void ultraReasoningEffort;
  });

  it('keeps every built-in reasoning default unchanged', () => {
    const expectedReasoningEfforts = {
      explore: 'low',
      analyst: 'medium',
      planner: 'medium',
      architect: 'xhigh',
      debugger: 'high',
      executor: 'medium',
      'team-executor': 'medium',
      verifier: 'high',
      'style-reviewer': 'low',
      'quality-reviewer': 'medium',
      'api-reviewer': 'medium',
      'security-reviewer': 'medium',
      'performance-reviewer': 'medium',
      'code-reviewer': 'high',
      'dependency-expert': 'high',
      'test-engineer': 'medium',
      'quality-strategist': 'medium',
      'build-fixer': 'high',
      designer: 'high',
      writer: 'high',
      'qa-tester': 'low',
      'git-master': 'high',
      'code-simplifier': 'high',
      researcher: 'high',
      'product-manager': 'medium',
      'ux-researcher': 'medium',
      'information-architect': 'low',
      'product-analyst': 'low',
      'prometheus-strict-metis': 'high',
      'prometheus-strict-momus': 'high',
      'prometheus-strict-oracle': 'high',
      critic: 'high',
      scholastic: 'high',
      vision: 'low',
    } as const satisfies Record<string, AgentDefinition['reasoningEffort']>;

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(AGENT_DEFINITIONS).map(([name, agent]) => [name, agent.reasoningEffort]),
      ),
      expectedReasoningEfforts,
    );
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

  it('defines the Prometheus Strict clean-room planner panel agents', () => {
    const panel = [
      AGENT_DEFINITIONS['prometheus-strict-metis'],
      AGENT_DEFINITIONS['prometheus-strict-momus'],
      AGENT_DEFINITIONS['prometheus-strict-oracle'],
    ];

    assert.deepEqual(panel.map((agent) => agent.name), [
      'prometheus-strict-metis',
      'prometheus-strict-momus',
      'prometheus-strict-oracle',
    ]);
    assert.ok(panel.every((agent) => agent.category === 'coordination'));
    assert.ok(panel.every((agent) => agent.routingRole === 'leader'));
  });

  it('defines the Scholastic ontology reviewer as a first-class coordination agent', () => {
    const scholastic = AGENT_DEFINITIONS.scholastic;

    assert.equal(scholastic.name, 'scholastic');
    assert.equal(scholastic.category, 'coordination');
    assert.equal(scholastic.routingRole, 'leader');
    assert.equal(scholastic.modelClass, 'frontier');
    assert.equal(scholastic.tools, 'read-only');
    assert.match(scholastic.description, /Ontology-first reasoning reviewer/);
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

  it('pins ralplan thesis and antithesis to exact gpt-5.6-sol with role-specific reasoning', () => {
    assert.equal(AGENT_DEFINITIONS.planner.exactModel, 'gpt-5.6-sol');
    assert.equal(AGENT_DEFINITIONS.planner.reasoningEffort, 'medium');
    assert.equal(AGENT_DEFINITIONS.planner.modelClass, 'frontier');

    assert.equal(AGENT_DEFINITIONS.architect.exactModel, 'gpt-5.6-sol');
    assert.equal(AGENT_DEFINITIONS.architect.reasoningEffort, 'xhigh');
    assert.equal(AGENT_DEFINITIONS.architect.modelClass, 'frontier');

    assert.equal(AGENT_DEFINITIONS.critic.exactModel, undefined);
    assert.equal(AGENT_DEFINITIONS.critic.reasoningEffort, 'high');
    assert.equal(AGENT_DEFINITIONS.critic.modelClass, 'frontier');
  });
});
