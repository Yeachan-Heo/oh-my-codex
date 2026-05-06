export interface GuidanceSurfaceContract {
  id: string;
  path: string;
  requiredPatterns: RegExp[];
}

function rx(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

const ROOT_TEMPLATE_PATTERNS = [
  rx('outcome-first.*quality-focused responses'),
  rx('target result.*success criteria.*constraints.*available evidence.*expected output.*stop condition'),
  rx('concise visible preamble|visible preamble'),
  rx('clear, low-risk, reversible next steps'),
  rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
  rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
  rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
  rx('do not ask or instruct humans.*ordinary non-destructive.*reversible actions'),
  rx('OMX runtime manipulation.*agent responsibilities'),
  rx('Keep going unless blocked'),
  rx('Ask only when blocked|Ask only when progress is impossible'),
  rx('local overrides?.*non-conflicting instructions'),
  rx('smallest useful tool loop|reflexive web/tool escalation'),
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
  rx('coding work.*targeted tests|targeted tests for changed behavior'),
  rx('validation.*cannot run|validation gap'),
];

const CORE_ROLE_PATTERNS = {
  executor: [
    rx('outcome-first.*quality-focused execution'),
    rx('target result.*constraints.*success criteria.*validation path.*stop condition'),
    rx('concise preamble'),
    rx('smallest useful tool loop|reflexive web/tool escalation'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('task is grounded and verified'),
    rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
    rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
    rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
    rx('Keep going unless blocked'),
    rx('Ask only when progress is impossible|Ask only when blocked'),
  ],
  planner: [
    rx('outcome-first.*execution-ready plans'),
    rx('desired result.*success criteria.*constraints.*evidence.*validation path.*stop condition'),
    rx('concise visible preamble'),
    rx('smallest useful tool loop|reflexive web/tool escalation'),
    rx('local overrides?.*non-conflicting constraints'),
    rx('plan is grounded|requirements.*affected resources.*validation commands.*failure behavior'),
    rx('AUTO-CONTINUE.*clear.*already-requested.*low-risk.*reversible.*local'),
    rx('ASK only.*destructive.*irreversible.*credential-gated.*external-production.*materially scope-changing'),
    rx('AUTO-CONTINUE branches.*permission-handoff phrasing'),
    rx('Keep advancing the current planning branch unless blocked'),
    rx('Ask only when a real planning blocker|Ask only when blocked'),
  ],
  verifier: [
    rx('outcome-first, evidence-dense verdicts'),
    rx('claim.*success criteria.*validation evidence.*gaps.*stop condition'),
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
  rx('Default final-output shape: outcome-first and evidence-dense'),
  rx('Treat newer user task updates as local overrides'),
  rx('user says `continue`'),
];

const CATALOG_PATTERNS = [
  rx('Default final-output shape: outcome-first and evidence-dense'),
  rx('Treat newer user task updates as local overrides'),
  rx('user says `continue`'),
];

const SKILL_PATTERNS = [
  rx('outcome-first.*progress and completion reporting|outcome-first framing'),
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
      rx('outcome-first.*quality-focused outputs'),
      rx('target result.*success criteria.*evidence.*output shape.*stop condition'),
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
    'code-review',
    'plan',
    'ralph',
    'ralplan',
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

export const PROMPT_REFACTOR_MARKER_CONTRACTS = [
  {
    id: 'runtime-overlay-markers',
    markers: ['<!-- OMX:RUNTIME:START -->', '<!-- OMX:RUNTIME:END -->'],
    requiredPaths: ['templates/AGENTS.md', 'src/hooks/agents-overlay.ts'],
  },
  {
    id: 'team-worker-overlay-markers',
    markers: ['<!-- OMX:TEAM:WORKER:START -->', '<!-- OMX:TEAM:WORKER:END -->'],
    requiredPaths: ['templates/AGENTS.md', 'src/team/worker-bootstrap.ts', 'src/hooks/agents-overlay.ts'],
  },
  {
    id: 'model-table-markers',
    markers: ['<!-- OMX:MODELS:START -->', '<!-- OMX:MODELS:END -->'],
    requiredPaths: ['templates/AGENTS.md', 'src/utils/agents-model-table.ts'],
  },
  {
    id: 'generated-agents-marker',
    markers: ['<!-- omx:generated:agents-md -->'],
    requiredPaths: ['src/utils/agents-md.ts'],
  },
];

export const PROMPT_REFACTOR_INVARIANT_CONTRACTS: GuidanceSurfaceContract[] = [
  {
    id: 'team-skill-state-machine',
    path: 'skills/team/SKILL.md',
    requiredPatterns: [
      rx('Current Runtime Behavior'),
      rx('tasks/task-<id>\\.json'),
      rx('claim-task'),
      rx('transition-task-status'),
    ],
  },
  {
    id: 'worker-skill-state-machine',
    path: 'skills/worker/SKILL.md',
    requiredPatterns: [
      rx('Send a startup ACK'),
      rx('claim-task'),
      rx('transition-task-status'),
      rx('release-task-claim.*pending'),
      rx('mailbox-mark-delivered'),
    ],
  },
  {
    id: 'ralph-planning-gate',
    path: 'skills/ralph/SKILL.md',
    requiredPatterns: [
      rx('PRD'),
      rx('snapshot grounding|pre-context intake'),
      rx('Do not begin Ralph execution work|do not begin implementation|must not implement|no implementation'),
    ],
  },
  {
    id: 'ralplan-consensus-sequence',
    path: 'skills/ralplan/SKILL.md',
    requiredPatterns: [rx('Planner'), rx('Architect'), rx('Critic'), rx('ADR')],
  },
  {
    id: 'deep-interview-question-gate',
    path: 'skills/deep-interview/SKILL.md',
    requiredPatterns: [rx('omx\\s+question'), rx('Socratic|interview'), rx('ambiguity')],
  },
  {
    id: 'cancel-safety-boundary',
    path: 'skills/cancel/SKILL.md',
    requiredPatterns: [rx('Strip AGENTS\\.md'), rx('shutdown'), rx('state')],
  },
  {
    id: 'ultraqa-verification-loop',
    path: 'skills/ultraqa/SKILL.md',
    requiredPatterns: [rx('test'), rx('verify'), rx('fix'), rx('repeat|loop')],
  },
  {
    id: 'autopilot-strict-3phase-loop',
    path: 'skills/autopilot/SKILL.md',
    requiredPatterns: [
      rx('\\$ralplan\\s*->\\s*\\$ralph\\s*->\\s*\\$code-review'),
      rx('return[s]? to `?\\$ralplan`?|current_phase.*ralplan'),
      rx('review_cycle'),
      rx('review_verdict'),
      rx('return_to_ralplan_reason'),
    ],
  },
  {
    id: 'explore-read-only-role-boundary',
    path: 'prompts/explore.md',
    requiredPatterns: [rx('read-only'), rx('cannot create, modify, or delete files')],
  },
  {
    id: 'researcher-source-boundary',
    path: 'prompts/researcher.md',
    requiredPatterns: [rx('source|citation|cite'), rx('official documentation|primary source')],
  },
];
