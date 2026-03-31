export interface GuidanceSurfaceContract {
  id: string;
  path: string;
  requiredPatterns: RegExp[];
}

function rx(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

const ROOT_TEMPLATE_PATTERNS = [
  rx('compact, information-dense responses'),
  rx('clear, low-risk, reversible next steps'),
  rx('local overrides?.*non-conflicting instructions'),
  rx('Outside active `team`/`swarm` mode, use `executor`'),
  rx('Reserve `worker` strictly for active `team`/`swarm` sessions'),
  rx('do not skip prerequisites|task is grounded and verified'),
  rx('concise evidence summaries'),
];

const CORE_ROLE_PATTERNS = {
  executor: [
    rx('compact, information-dense outputs'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('task is grounded and verified'),
  ],
  planner: [
    rx('compact, information-dense plan summaries'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('plan is grounded in evidence'),
  ],
  verifier: [
    rx('concise, evidence-dense summaries'),
    rx('verdict is grounded'),
    rx('non-conflicting acceptance criteria'),
  ],
};

const WAVE_TWO_PATTERNS = [
  rx('Default final-output shape: concise and evidence-dense'),
  rx('Treat newer user task updates as local overrides'),
  rx('user says `continue`'),
];

const CATALOG_PATTERNS = [
  rx('Default final-output shape: concise and evidence-dense'),
  rx('Treat newer user task updates as local overrides'),
  rx('user says `continue`'),
];

const SKILL_PATTERNS = [
  rx('concise, evidence-dense progress and completion reporting'),
  rx('local overrides for the active workflow branch'),
  rx('user says `continue`'),
];

export const ROOT_TEMPLATE_CONTRACTS: GuidanceSurfaceContract[] = [
  { id: 'agents-root', path: 'AGENTS.md', requiredPatterns: ROOT_TEMPLATE_PATTERNS },
  { id: 'agents-template', path: 'templates/AGENTS.md', requiredPatterns: ROOT_TEMPLATE_PATTERNS },
];

export const CORE_ROLE_CONTRACTS: GuidanceSurfaceContract[] = [
  { id: 'executor', path: 'skills/executor/SKILL.md', requiredPatterns: CORE_ROLE_PATTERNS.executor },
  { id: 'planner', path: 'skills/planner/SKILL.md', requiredPatterns: CORE_ROLE_PATTERNS.planner },
  { id: 'verifier', path: 'skills/verifier/SKILL.md', requiredPatterns: CORE_ROLE_PATTERNS.verifier },
];

export const SCENARIO_ROLE_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'executor-scenarios',
    path: 'skills/executor/SKILL.md',
    requiredPatterns: [
      rx('user says `continue`'),
      rx('make a PR targeting dev'),
      rx('merge to dev if CI green'),
      rx('confirm CI is green, then merge'),
    ],
  },
  {
    id: 'planner-scenarios',
    path: 'skills/planner/SKILL.md',
    requiredPatterns: [
      rx('user says `continue`'),
      rx('user says `make a PR`'),
      rx('user says `merge if CI green`'),
      rx('scoped condition on the next operational step'),
    ],
  },
  {
    id: 'verifier-scenarios',
    path: 'skills/verifier/SKILL.md',
    requiredPatterns: [
      rx('user says `merge if CI green`'),
      rx('confirm they are green'),
      rx('user says `continue`'),
      rx('keep gathering the required evidence'),
    ],
  },
];

export const WAVE_TWO_CONTRACTS: GuidanceSurfaceContract[] = [
  'architect',
  'critic',
  'debugger',
  'test-engineer',
  'code-reviewer',
  'quality-reviewer',
  'security-reviewer',
  'researcher',
  'explore',
].map((name) => ({
  id: name,
  path: `skills/${name}/SKILL.md`,
  requiredPatterns: WAVE_TWO_PATTERNS,
}));

export const CATALOG_CONTRACTS: GuidanceSurfaceContract[] = [
  'analyst',
  'api-reviewer',
  'build-fixer',
  'dependency-expert',
  'designer',
  'git-master',
  'information-architect',
  'performance-reviewer',
  'product-analyst',
  'product-manager',
  'qa-tester',
  'quality-strategist',
  'style-reviewer',
  'ux-researcher',
  'vision',
  'writer',
].map((name) => ({
  id: name,
  path: `skills/${name}/SKILL.md`,
  requiredPatterns: CATALOG_PATTERNS,
}));

export const LEGACY_PROMPT_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'code-simplifier',
    path: 'skills/code-simplifier/SKILL.md',
    requiredPatterns: [
      rx('local overrides for the active simplification scope'),
      rx('simplification result is grounded'),
      rx('<Scenario_Examples>'),
    ],
  },
];

export const SPECIALIZED_PROMPT_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'sisyphus-lite',
    path: 'skills/sisyphus-lite/SKILL.md',
    requiredPatterns: [
      rx('compact, information-dense outputs'),
      rx('Treat newer user instructions as local overrides'),
      rx('No evidence = not complete'),
      rx('specialized worker behavior prompt|worker behavior prompt'),
    ],
  },
];

export const SKILL_CONTRACTS: GuidanceSurfaceContract[] = [
  'analyze',
  'autopilot',
  'build-fix',
  'code-review',
  'plan',
  'ralph',
  'ralplan',
  'security-review',
  'team',
  'ultraqa',
].map((name) => ({
  id: name,
  path: `skills/${name}/SKILL.md`,
  requiredPatterns: SKILL_PATTERNS,
}));
