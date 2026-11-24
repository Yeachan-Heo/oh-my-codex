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
      explore: 'medium',
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
      critic: 'high',
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





  it('keeps the model tier split: frontier planner/architect/critic, spark explore/style-reviewer/vision, rest standard', () => {
    const frontier = ['planner', 'architect', 'critic'];
    const fast = ['explore', 'style-reviewer', 'vision'];
    for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
      const expected = frontier.includes(name) ? 'frontier' : fast.includes(name) ? 'fast' : 'standard';
      assert.equal(agent.modelClass, expected, name);
    }
    assert.equal(Object.values(AGENT_DEFINITIONS).some((agent) => 'exactModel' in agent), false);
  });

  it('keeps per-role reasoning efforts independent of the tier', () => {
    const efforts: Record<string, string> = {
      planner: 'medium',
      architect: 'xhigh',
      researcher: 'high',
      critic: 'high',
      explore: 'medium',
      'style-reviewer': 'low',
      vision: 'low',
      analyst: 'medium',
      'security-reviewer': 'medium',
      'test-engineer': 'medium',
      'code-reviewer': 'high',
      'code-simplifier': 'high',
      'team-executor': 'medium',
      executor: 'medium',
    };
    for (const [name, effort] of Object.entries(efforts)) {
      assert.equal(AGENT_DEFINITIONS[name].reasoningEffort, effort, name);
    }
  });
});
