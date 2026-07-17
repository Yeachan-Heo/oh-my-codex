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
  rx('Choose the lane before acting'),
  rx('Solo execute'),
  rx('Outside active `team`/`swarm` mode, use `executor`'),
  rx('Reserve `worker` strictly for active `team`/`swarm` sessions'),
  rx('Leader responsibilities'),
  rx('Worker responsibilities'),
  rx('Stop / escalate'),
  rx('Default update/final shape'),
  rx('do not skip prerequisites|task is grounded and verified'),
  rx('concise evidence summaries'),
  rx('modular tracer bullets'),
  rx('public contract.*allowed dependencies'),
  rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
  rx('audit recent session calls.*plugin caches'),
  rx('user-owned unprefixed workflow overlays'),
  rx('writing-plans.*test-driven-development.*subagent-driven-development'),
  rx('executing-plans.*dispatching-parallel-agents.*verification-before-completion'),
  rx('writing-plans.*dispatching-parallel-agents.*load their matching namespaced Superpowers skills'),
  rx('test-driven-development.*subagent-driven-development.*executing-plans.*verification-before-completion.*standalone owned policy'),
  rx('one capable owner'),
  rx('caller-visible behaviour.*invalidating assumptions'),
  rx('Escalate only for independent lanes.*failed grounded acceptance'),
  rx('Re-localise.*same failure repeats twice'),
  rx('compact task packet'),
  rx('Do not use an all-turn fork.*mature task'),
  rx('RED author.*fresh context'),
  rx('implementer must not weaken'),
  rx('verifier.*fresh context'),
  rx('Proportional assurance and execution shape'),
  rx('direct artifact route.*article copy.*wiki notes.*exploratory mockups'),
  rx('brainstorming.*materially unresolved'),
  rx('does not apply.*bounded direct artifact'),
  rx('target.*adjustment.*constraints.*acceptance surface'),
  rx('File count is not a router'),
  rx('Local observable behaviour changes retain one right-reason RED/GREEN'),
  rx('generated screenshot.*at least one reference image'),
  rx('text-only.*source.*DOM'),
  rx('show the changed surface.*does not.*rendered output'),
  rx('one bounded fallback'),
  rx('do not cascade.*Playwright.*Computer Use'),
  rx('tests pass where tests apply'),
  rx('Route cleanup/refactor/deslop work proportionally'),
  rx('Implicit keyword matches require affirmative invocation intent'),
];

const CORE_ROLE_PATTERNS = {
  executor: [
    rx('compact, information-dense outputs'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('task is grounded and verified'),
    rx('preserve.*module contracts'),
    rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
  ],
  planner: [
    rx('compact, information-dense plan summaries'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('plan is grounded in evidence'),
    rx('observable tracer.*modules crossed'),
    rx('module contract card'),
    rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
  ],
  testEngineer: [
    rx('public module contracts'),
    rx('thin tracer'),
    rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
  ],
  verifier: [
    rx('concise, evidence-dense summaries'),
    rx('verdict is grounded'),
    rx('non-conflicting acceptance criteria'),
    rx('module-contract drift'),
    rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
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
  { id: 'executor', path: 'prompts/executor.md', requiredPatterns: CORE_ROLE_PATTERNS.executor },
  { id: 'planner', path: 'prompts/planner.md', requiredPatterns: CORE_ROLE_PATTERNS.planner },
  { id: 'test-engineer-modular-tracer', path: 'prompts/test-engineer.md', requiredPatterns: CORE_ROLE_PATTERNS.testEngineer },
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

export const MODULAR_TRACER_SKILL_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'plan-modular-tracer',
    path: 'skills/plan/SKILL.md',
    requiredPatterns: [
      rx('observable tracer.*modules crossed'),
      rx('module contract card'),
      rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
    ],
  },
  {
    id: 'ralplan-modular-tracer',
    path: 'skills/ralplan/SKILL.md',
    requiredPatterns: [
      rx('observable tracer.*modules crossed'),
      rx('module contract card'),
      rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
    ],
  },
  {
    id: 'team-modular-tracer',
    path: 'skills/team/SKILL.md',
    requiredPatterns: [
      rx('stable module contracts'),
      rx('shared contracts.*serialized'),
      rx('changed-module tests.*boundary contract.*tracer acceptance.*broad regression'),
    ],
  },
];

export const LEAN_MODE_SKILL_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'ralph-lean-mode',
    path: 'skills/ralph/SKILL.md',
    requiredPatterns: [
      rx('start with one owner'),
      rx('ultrawork.*only.*independent'),
      rx('architect.*(security|shared public|weak oracle|risk)'),
      rx('ai-slop-cleaner.*conditional'),
      rx('same failure.*twice|re-localise'),
      rx('fresh authority separation'),
      rx('if cleanup runs.*re-run.*affected tests.*build.*lint'),
    ],
  },
  {
    id: 'autopilot-lean-mode',
    path: 'skills/autopilot/SKILL.md',
    requiredPatterns: [
      rx('reuse.*approved spec'),
      rx('one planning owner'),
      rx('execute solo.*one owned lane'),
      rx('reviewer.*risk|risk-matched reviewer'),
    ],
  },
  {
    id: 'ecomode-lean-mode',
    path: 'skills/ecomode/SKILL.md',
    requiredPatterns: [
      rx('compact context'),
      rx('minimal fan-out'),
      rx('interaction count|rework'),
      rx('reuse approved artifacts'),
    ],
  },
  {
    id: 'help-evidence-aware-recommendations',
    path: 'skills/help/SKILL.md',
    requiredPatterns: [
      rx('~/.omx/state/token-tracking.jsonl'),
      rx('input_tokens[\\s\\S]*cached_input_tokens[\\s\\S]*uncached_input_tokens[\\s\\S]*output_tokens[\\s\\S]*reasoning_output_tokens'),
      rx('observed task shape.*outcome evidence'),
      rx('reviewer yield'),
      rx('do not recommend Team or any reviewer merely because its usage count is zero'),
      rx('Recommend Team only when repeated tasks show two or more independent owned lanes'),
      rx('Recommend a reviewer when risk-matched findings changed outcomes, not merely when reviewer usage is zero'),
      rx('Prefer the model with the best accepted outcome per billable-equivalent token; cheap per-call price is not sufficient'),
    ],
  },
];
