export interface GuidanceSurfaceContract {
  id: string;
  path: string;
  requiredPatterns: RegExp[];
}

function rx(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

const ROOT_TEMPLATE_PATTERNS = [
  rx('quality-first.*intent-deepening responses'),
  rx('clear, low-risk, reversible next steps'),
  rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
  rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
  rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
  rx('do not ask or instruct humans.*ordinary non-destructive.*reversible actions'),
  rx('OMX runtime manipulation.*agent responsibilities'),
  rx('Keep going unless blocked'),
  rx('Ask only when blocked|Ask only when progress is impossible'),
  rx('local overrides?.*non-conflicting instructions'),
  rx('reflexive web/tool escalation'),
  rx('Choose the lane before acting'),
  rx('Solo execute'),
  rx('Outside active `team`/`swarm` mode, use `executor`'),
  rx('Reserve `worker` strictly for active `team`/`swarm` sessions'),
  rx('Leader responsibilities'),
  rx('Worker responsibilities'),
  rx('Route to `explore` for repo-local file / symbol / pattern / relationship lookup'),
  rx('explore` owns facts about this repo'),
  rx('Route to `researcher` when the main need is official docs'),
  rx('technology is already chosen'),
  rx('Route to `dependency-expert` when the main need is package / SDK selection'),
  rx('whether / which package, SDK, or framework to adopt, upgrade, replace, or migrate'),
  rx('Use mixed routing deliberately'),
  rx('boundary crossings upward'),
  rx('Stop / escalate'),
  rx('Default update/final shape'),
  rx('do not skip prerequisites|task is grounded and verified'),
  rx('quality-first evidence summaries'),
];

const CORE_ROLE_PATTERNS = {
  executor: [
    rx('quality-first.*intent-deepening outputs'),
    rx('reflexive web/tool escalation'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('task is grounded and verified'),
    rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
    rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
    rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
    rx('Keep going unless blocked'),
    rx('Ask only when progress is impossible|Ask only when blocked'),
  ],
  planner: [
    rx('quality-first.*intent-deepening plan summaries'),
    rx('reflexive web/tool escalation'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('plan is grounded in evidence'),
    rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
    rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
    rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
    rx('Keep advancing the current planning branch unless blocked'),
    rx('Ask only when a real planning blocker|Ask only when blocked'),
  ],
  verifier: [
    rx('quality-first, evidence-dense summaries'),
    rx('proof that matters|tool churn'),
    rx('verdict is grounded'),
    rx('non-conflicting acceptance criteria'),
    rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
    rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
    rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
    rx('Keep gathering evidence until the verdict is grounded or blocked'),
    rx('Ask only when the acceptance target is materially unclear|Ask only when blocked'),
  ],
};

const WAVE_TWO_PATTERNS = [
  rx('Default final-output shape: quality-first and evidence-dense'),
  rx('Treat newer user task updates as local overrides'),
  rx('user says `continue`'),
];

const CATALOG_PATTERNS = [
  rx('Default final-output shape: quality-first and evidence-dense'),
  rx('Treat newer user task updates as local overrides'),
  rx('user says `continue`'),
];

const SKILL_PATTERNS = [
  rx('concise, evidence-dense progress and completion reporting'),
  rx('local overrides for the active workflow branch'),
  rx('user says `continue`'),
];

const ULTRAWORK_SKILL_PATTERNS = [
  ...SKILL_PATTERNS,
  rx('Gather enough context before implementation'),
  rx('Define pass/fail acceptance criteria before launching execution lanes'),
  rx('run a direct-tool lane and one or more background evidence lanes'),
  rx('Choose self vs delegate deliberately'),
  rx('Manual QA notes are recorded when the task needs a human-visible or behavior-level check'),
  rx('Ralph owns persistence, architect verification, deslop, and the full verified-completion promise'),
];

export const ROOT_TEMPLATE_CONTRACTS: GuidanceSurfaceContract[] = [
  { id: 'agents-template', path: 'templates/AGENTS.md', requiredPatterns: ROOT_TEMPLATE_PATTERNS },
];

export const CORE_ROLE_CONTRACTS: GuidanceSurfaceContract[] = [
  { id: 'executor', path: 'prompts/executor.md', requiredPatterns: CORE_ROLE_PATTERNS.executor },
  { id: 'planner', path: 'prompts/planner.md', requiredPatterns: CORE_ROLE_PATTERNS.planner },
  { id: 'verifier', path: 'prompts/verifier.md', requiredPatterns: CORE_ROLE_PATTERNS.verifier },
];

export const SCENARIO_ROLE_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'executor-scenarios',
    path: 'prompts/executor.md',
    requiredPatterns: [
      rx('user says `continue`'),
      rx('make a PR targeting dev'),
      rx('merge to dev if CI green'),
      rx('confirm CI is green, then merge'),
    ],
  },
  {
    id: 'planner-scenarios',
    path: 'prompts/planner.md',
    requiredPatterns: [
      rx('user says `continue`'),
      rx('user says `make a PR`'),
      rx('user says `merge if CI green`'),
      rx('scoped condition on the next operational step'),
    ],
  },
  {
    id: 'verifier-scenarios',
    path: 'prompts/verifier.md',
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
  path: `prompts/${name}.md`,
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
  path: `prompts/${name}.md`,
  requiredPatterns: CATALOG_PATTERNS,
}));

export const LEGACY_PROMPT_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'code-simplifier',
    path: 'prompts/code-simplifier.md',
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
    path: 'prompts/sisyphus-lite.md',
    requiredPatterns: [
      rx('quality-first.*intent-deepening outputs'),
      rx('Treat newer user instructions as local overrides'),
      rx('No evidence = not complete'),
      rx('specialized worker behavior prompt|worker behavior prompt'),
    ],
  },
];

export const SKILL_CONTRACTS: GuidanceSurfaceContract[] = [
  ...[
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
  })),
  {
    id: 'ultrawork',
    path: 'skills/ultrawork/SKILL.md',
    requiredPatterns: ULTRAWORK_SKILL_PATTERNS,
  },
];
