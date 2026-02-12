/**
 * Agent role definitions for oh-my-codex
 * Each agent has a name, description, default model tier, and tool access pattern.
 * Prompt content is loaded from the prompts/ directory at runtime.
 */

export interface AgentDefinition {
  name: string;
  description: string;
  model: 'haiku' | 'sonnet' | 'opus';
  /** Tool access pattern */
  tools: 'read-only' | 'analysis' | 'execution' | 'data';
  /** Category for grouping */
  category: 'build' | 'review' | 'domain' | 'product' | 'coordination';
}

export const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  // Build/Analysis Lane
  'explore': {
    name: 'explore',
    description: 'Fast codebase search and file/symbol mapping',
    model: 'haiku',
    tools: 'read-only',
    category: 'build',
  },
  'analyst': {
    name: 'analyst',
    description: 'Requirements clarity, acceptance criteria, hidden constraints',
    model: 'opus',
    tools: 'analysis',
    category: 'build',
  },
  'planner': {
    name: 'planner',
    description: 'Task sequencing, execution plans, risk flags',
    model: 'opus',
    tools: 'analysis',
    category: 'build',
  },
  'architect': {
    name: 'architect',
    description: 'System design, boundaries, interfaces, long-horizon tradeoffs',
    model: 'opus',
    tools: 'read-only',
    category: 'build',
  },
  'debugger': {
    name: 'debugger',
    description: 'Root-cause analysis, regression isolation, failure diagnosis',
    model: 'sonnet',
    tools: 'analysis',
    category: 'build',
  },
  'executor': {
    name: 'executor',
    description: 'Code implementation, refactoring, feature work',
    model: 'sonnet',
    tools: 'execution',
    category: 'build',
  },
  'deep-executor': {
    name: 'deep-executor',
    description: 'Complex autonomous goal-oriented tasks',
    model: 'opus',
    tools: 'execution',
    category: 'build',
  },
  'verifier': {
    name: 'verifier',
    description: 'Completion evidence, claim validation, test adequacy',
    model: 'sonnet',
    tools: 'analysis',
    category: 'build',
  },

  // Review Lane
  'style-reviewer': {
    name: 'style-reviewer',
    description: 'Formatting, naming, idioms, lint conventions',
    model: 'haiku',
    tools: 'read-only',
    category: 'review',
  },
  'quality-reviewer': {
    name: 'quality-reviewer',
    description: 'Logic defects, maintainability, anti-patterns',
    model: 'sonnet',
    tools: 'read-only',
    category: 'review',
  },
  'api-reviewer': {
    name: 'api-reviewer',
    description: 'API contracts, versioning, backward compatibility',
    model: 'sonnet',
    tools: 'read-only',
    category: 'review',
  },
  'security-reviewer': {
    name: 'security-reviewer',
    description: 'Vulnerabilities, trust boundaries, authn/authz',
    model: 'sonnet',
    tools: 'read-only',
    category: 'review',
  },
  'performance-reviewer': {
    name: 'performance-reviewer',
    description: 'Hotspots, complexity, memory/latency optimization',
    model: 'sonnet',
    tools: 'read-only',
    category: 'review',
  },
  'code-reviewer': {
    name: 'code-reviewer',
    description: 'Comprehensive review across all concerns',
    model: 'opus',
    tools: 'read-only',
    category: 'review',
  },

  // Domain Specialists
  'dependency-expert': {
    name: 'dependency-expert',
    description: 'External SDK/API/package evaluation',
    model: 'sonnet',
    tools: 'analysis',
    category: 'domain',
  },
  'test-engineer': {
    name: 'test-engineer',
    description: 'Test strategy, coverage, flaky-test hardening',
    model: 'sonnet',
    tools: 'execution',
    category: 'domain',
  },
  'quality-strategist': {
    name: 'quality-strategist',
    description: 'Quality strategy, release readiness, risk assessment',
    model: 'sonnet',
    tools: 'analysis',
    category: 'domain',
  },
  'build-fixer': {
    name: 'build-fixer',
    description: 'Build/toolchain/type failures resolution',
    model: 'sonnet',
    tools: 'execution',
    category: 'domain',
  },
  'designer': {
    name: 'designer',
    description: 'UX/UI architecture, interaction design',
    model: 'sonnet',
    tools: 'execution',
    category: 'domain',
  },
  'writer': {
    name: 'writer',
    description: 'Documentation, migration notes, user guidance',
    model: 'haiku',
    tools: 'execution',
    category: 'domain',
  },
  'qa-tester': {
    name: 'qa-tester',
    description: 'Interactive CLI/service runtime validation',
    model: 'sonnet',
    tools: 'execution',
    category: 'domain',
  },
  'scientist': {
    name: 'scientist',
    description: 'Data/statistical analysis and hypothesis testing',
    model: 'sonnet',
    tools: 'data',
    category: 'domain',
  },
  'git-master': {
    name: 'git-master',
    description: 'Commit strategy, history hygiene, rebasing',
    model: 'sonnet',
    tools: 'execution',
    category: 'domain',
  },
  'researcher': {
    name: 'researcher',
    description: 'External documentation and reference research',
    model: 'sonnet',
    tools: 'analysis',
    category: 'domain',
  },

  // Product Lane
  'product-manager': {
    name: 'product-manager',
    description: 'Problem framing, personas/JTBD, PRDs',
    model: 'sonnet',
    tools: 'analysis',
    category: 'product',
  },
  'ux-researcher': {
    name: 'ux-researcher',
    description: 'Heuristic audits, usability, accessibility',
    model: 'sonnet',
    tools: 'analysis',
    category: 'product',
  },
  'information-architect': {
    name: 'information-architect',
    description: 'Taxonomy, navigation, findability',
    model: 'sonnet',
    tools: 'analysis',
    category: 'product',
  },
  'product-analyst': {
    name: 'product-analyst',
    description: 'Product metrics, funnel analysis, experiments',
    model: 'sonnet',
    tools: 'analysis',
    category: 'product',
  },

  // Coordination
  'critic': {
    name: 'critic',
    description: 'Plan/design critical challenge and review',
    model: 'opus',
    tools: 'read-only',
    category: 'coordination',
  },
  'vision': {
    name: 'vision',
    description: 'Image/screenshot/diagram analysis',
    model: 'sonnet',
    tools: 'read-only',
    category: 'coordination',
  },
};

/** Get agent definition by name */
export function getAgent(name: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS[name];
}

/** Get all agents in a category */
export function getAgentsByCategory(category: AgentDefinition['category']): AgentDefinition[] {
  return Object.values(AGENT_DEFINITIONS).filter(a => a.category === category);
}

/** Get all agent names */
export function getAgentNames(): string[] {
  return Object.keys(AGENT_DEFINITIONS);
}
