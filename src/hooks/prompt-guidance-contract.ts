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
    rx('task is grounded and verified'),
  ],
  planner: [
    rx('outcome-first.*execution-ready plans'),
    rx('desired result.*success criteria.*constraints.*evidence.*validation path.*stop condition'),
    rx('plan is grounded|requirements.*affected resources.*validation commands.*failure behavior'),
  ],
  verifier: [
    rx('outcome-first, evidence-dense verdicts'),
    rx('claim.*success criteria.*validation evidence.*gaps.*stop condition'),
    rx('proof that matters|tool churn'),
    rx('verdict is grounded'),
  ],
};

const WAVE_TWO_PATTERNS = [
  rx('output|report|verdict'),
  rx('evidence'),
];

const CATALOG_PATTERNS = [
  rx('output|report|deliverable'),
  rx('evidence|findings|results'),
];

const SKILL_PATTERNS = [
  rx('evidence|output|report'),
];

// Textual guidance contract only: these patterns prevent prompt-surface drift;
// they do not enforce runtime harness behavior.
const ULTRAQA_SKILL_PATTERNS = [
  ...SKILL_PATTERNS,
  rx('adversarial dynamic e2e'),
  rx('not satisfied by a shallow build/lint/typecheck/test checklist|build/lint/typecheck/test.*not sufficient'),
  rx('malicious/hostile user behavior|hostile user modeling|User/attacker model'),
  rx('temporary tests.*harnesses|temporary harnesses'),
  rx('Use absolute repo imports[^\\n]*pathToFileURL\\(join\\(repoRoot, \"dist\", \\.\\.\\.\\)\\)\\.href[^\\n]*Never rely on[^\\n]*\\./dist'),
  rx('Use a safe file writer[^\\n]*non-interpolating file-write mechanism[^\\n]*do not use interpolating heredocs'),
  rx('Sanitize OMX runtime env for isolated probes[^\\n]*OMX_ROOT[^\\n]*OMX_STATE_ROOT[^\\n]*unset[^\\n]*env -u OMX_ROOT -u OMX_STATE_ROOT'),
  rx('Classify harness setup failures separately[^\\n]*record it as harness debris[^\\n]*fix the harness[^\\n]*rerun the scenario[^\\n]*before declaring a product defect'),
  rx('malformed input'),
  rx('repeated interruptions'),
  rx('prompt injection'),
  rx('cancel/resume'),
  rx('stale state'),
  rx('dirty worktree'),
  rx('hung or long-running commands|hung-command'),
  rx('flaky tests'),
  rx('misleading success output'),
  rx('Scenario matrix'),
  rx('Commands run'),
  rx('Failures found'),
  rx('Fixes applied'),
  rx('Residual risks'),
  rx('Evidence'),
  rx('Cleanup and rollback|cleanup/rollback'),
  rx('No destructive commands|Safety Bounds'),
  rx('secret exfiltration'),
  rx('bounded runtimes|No unbounded waits'),
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
      rx('make a PR targeting dev'),
      rx('merge to dev if CI green'),
      rx('verify the exact CI condition before merging'),
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
      rx('user says `continue`'),
      rx('gather.*evidence|validation evidence'),
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

export const SPECIALIZED_PROMPT_CONTRACTS: GuidanceSurfaceContract[] = [];

export const SKILL_CONTRACTS: GuidanceSurfaceContract[] = [
  ...[
    'analyze',
    'code-review',
    'plan',
    'team',
  ].map((name) => ({
    id: name,
    path: `skills/${name}/SKILL.md`,
    requiredPatterns: SKILL_PATTERNS,
  })),
  {
    id: 'ultraqa',
    path: 'skills/ultraqa/SKILL.md',
    requiredPatterns: ULTRAQA_SKILL_PATTERNS,
  },
  {
    id: 'ultraqa-plugin',
    path: 'plugins/oh-my-codex/skills/ultraqa/SKILL.md',
    requiredPatterns: ULTRAQA_SKILL_PATTERNS,
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
      rx('tasks/task-<id>\.json'),
      rx('claim-task|worker card defines ACK, claim'),
      rx('transition-task-status'),
    ],
  },
  {
    id: 'worker-skill-state-machine',
    path: 'skills/worker/SKILL.md',
    requiredPatterns: [
      rx('startup ACK|send-message'),
      rx('claim-task'),
      rx('transition-task-status'),
      rx('release-task-claim.*pending'),
      rx('mailbox-mark-delivered'),
    ],
  },
  {
    id: 'ralph-sunset-stub',
    path: 'skills/ralph/SKILL.md',
    requiredPatterns: [rx('was removed'), rx('\\$ultragoal')],
  },
  {
    id: 'ralplan-consensus-sequence',
    path: 'skills/ralplan/SKILL.md',
    requiredPatterns: [
      rx('canonical consensus-planning stage'),
      rx('Planner.*Architect.*Critic'),
      rx('await.*Architect.*before.*Critic|Architect result before invoking.*Critic'),
      rx('ralplan_execution_handoff'),
      rx('missing host provenance must not terminalize Ralplan'),
    ],
  },
  {
    id: 'deep-interview-question-gate',
    path: 'skills/deep-interview/SKILL.md',
    requiredPatterns: [
      rx('Socratic'),
      rx('ambiguity'),
      rx('omx question'),
      rx('omx state write/read'),
      rx('Do NOT implement directly'),
    ],
  },
  {
    id: 'cancel-safety-boundary',
    path: 'skills/cancel/SKILL.md',
    requiredPatterns: [rx('AGENTS\.md'), rx('shutdown'), rx('state')],
  },
  {
    id: 'ultraqa-verification-loop',
    path: 'skills/ultraqa/SKILL.md',
    requiredPatterns: [
      rx('test'),
      rx('verify'),
      rx('fix'),
      rx('repeat|loop'),
      rx('adversarial dynamic e2e'),
      rx('Scenario matrix'),
      rx('malformed input'),
      rx('prompt injection'),
      rx('misleading success output'),
    ],
  },
  {
    id: 'autopilot-canonical-orchestrator',
    path: 'skills/autopilot/SKILL.md',
    requiredPatterns: [
      rx('first-class canonical orchestrator'),
      rx('\\$deep-interview -> \\$ralplan -> \\$ultragoal'),
      rx('not a list of optional hints'),
      rx('authority-decreasing operations are always recoverable'),
      rx('must not reintroduce the retired unrecoverable host-receipt lock|do not reintroduce the retired unrecoverable host-receipt lock'),
    ],
  },
  {
    id: 'pipeline-sunset-stub',
    path: 'skills/pipeline/SKILL.md',
    requiredPatterns: [rx('was removed'), rx('\\$plan.*\\$team')],
  },
  {
    id: 'ultrawork-sunset-stub',
    path: 'skills/ultrawork/SKILL.md',
    requiredPatterns: [rx('was removed'), rx('\\$team')],
  },
  {
    id: 'autoresearch-goal-sunset-stub',
    path: 'skills/autoresearch-goal/SKILL.md',
    requiredPatterns: [rx('was removed'), rx('\\$autoresearch')],
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
