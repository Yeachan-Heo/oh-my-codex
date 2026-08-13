export interface KeywordTriggerDefinition {
  keyword: string;
  skill: string;
  priority: number;
  guidance: string;
}

export const KEYWORD_TRIGGER_DEFINITIONS: readonly KeywordTriggerDefinition[] = [
  { keyword: '$ralph', skill: 'ralph', priority: 9, guidance: 'Sunset: $ralph was removed in OMX 0.21; use $ultragoal (stub)' },
  { keyword: "don't stop", skill: 'ralph', priority: 9, guidance: 'Sunset: ralph was removed in OMX 0.21; use $ultragoal (stub)' },
  { keyword: 'must complete', skill: 'ralph', priority: 9, guidance: 'Sunset: ralph was removed in OMX 0.21; use $ultragoal (stub)' },
  { keyword: 'keep going', skill: 'ralph', priority: 9, guidance: 'Sunset: ralph was removed in OMX 0.21; use $ultragoal (stub)' },

  { keyword: '$autopilot', skill: 'autopilot', priority: 10, guidance: 'Activate the canonical Autopilot orchestrator: $deep-interview -> $ralplan -> $ultragoal' },
  { keyword: 'autopilot', skill: 'autopilot', priority: 10, guidance: 'Activate the canonical Autopilot orchestrator: $deep-interview -> $ralplan -> $ultragoal' },
  { keyword: 'build me', skill: 'autopilot', priority: 10, guidance: 'Activate the canonical Autopilot orchestrator: $deep-interview -> $ralplan -> $ultragoal' },
  { keyword: 'I want a', skill: 'autopilot', priority: 10, guidance: 'Activate the canonical Autopilot orchestrator: $deep-interview -> $ralplan -> $ultragoal' },

  { keyword: '$ultrawork', skill: 'ultrawork', priority: 10, guidance: 'Sunset: $ultrawork was removed in OMX 0.21; use $team (stub)' },
  { keyword: 'ulw', skill: 'ultrawork', priority: 10, guidance: 'Sunset: ultrawork was removed in OMX 0.21; use $team (stub)' },
  { keyword: 'parallel', skill: 'ultrawork', priority: 10, guidance: 'Sunset: ultrawork was removed in OMX 0.21; use $team (stub)' },
  { keyword: '$ultragoal', skill: 'ultragoal', priority: 10, guidance: 'Activate durable ultragoal planning/execution over Codex goal mode artifacts' },
  { keyword: 'ultragoal', skill: 'ultragoal', priority: 10, guidance: 'Activate durable ultragoal planning/execution over Codex goal mode artifacts' },
  { keyword: '$ultraqa', skill: 'ultraqa', priority: 8, guidance: 'Activate UltraQA cycling workflow' },
  { keyword: '$analyze', skill: 'analyze', priority: 7, guidance: 'Activate deep analysis workflow' },
  { keyword: 'investigate', skill: 'analyze', priority: 7, guidance: 'Activate deep analysis workflow' },


  { keyword: '$deep-interview', skill: 'deep-interview', priority: 8, guidance: 'Activate Socratic deep interview with ambiguity gating before planning or execution' },
  { keyword: 'deep interview', skill: 'deep-interview', priority: 8, guidance: 'Activate Socratic deep interview with ambiguity gating before planning or execution' },
  { keyword: 'gather requirements', skill: 'deep-interview', priority: 8, guidance: 'Activate Socratic requirements interview before planning or execution' },
  { keyword: 'interview me', skill: 'deep-interview', priority: 8, guidance: 'Activate Socratic deep interview with ambiguity gating before planning or execution' },
  { keyword: "don't assume", skill: 'deep-interview', priority: 8, guidance: 'Activate Socratic deep interview to clear assumptions before planning or execution' },
  { keyword: 'ouroboros', skill: 'deep-interview', priority: 8, guidance: 'Activate Ouroboros-style Socratic deep interview with ambiguity gating' },
  { keyword: 'interview', skill: 'deep-interview', priority: 8, guidance: 'Activate Socratic deep interview with ambiguity gating before planning or execution' },

  { keyword: '$plan', skill: 'plan', priority: 8, guidance: 'Activate planning skill' },
  { keyword: 'plan this', skill: 'plan', priority: 8, guidance: 'Activate planning skill' },
  { keyword: 'plan the', skill: 'plan', priority: 8, guidance: 'Activate planning skill' },
  { keyword: "let's plan", skill: 'plan', priority: 8, guidance: 'Activate planning skill' },

  { keyword: '$ralplan', skill: 'ralplan', priority: 11, guidance: 'Activate Planner -> Architect -> Critic consensus planning with durable handoff to $ultragoal' },
  { keyword: 'consensus plan', skill: 'ralplan', priority: 11, guidance: 'Activate Planner -> Architect -> Critic consensus planning with durable handoff to $ultragoal' },

  { keyword: '$autoresearch', skill: 'autoresearch', priority: 10, guidance: 'Activate autoresearch validator-gated research loop' },
  { keyword: '$best-practice-research', skill: 'best-practice-research', priority: 8, guidance: 'Activate bounded best-practice research wrapper' },

  { keyword: '$design', skill: 'design', priority: 6, guidance: 'Activate canonical DESIGN.md design-source-of-truth workflow' },
  { keyword: '$team', skill: 'team', priority: 8, guidance: 'Activate coordinated team mode' },
  { keyword: 'coordinated team', skill: 'team', priority: 8, guidance: 'Activate coordinated team mode' },

  { keyword: '$cancel', skill: 'cancel', priority: 5, guidance: 'Cancel active execution modes' },
  { keyword: 'stop', skill: 'cancel', priority: 5, guidance: 'Cancel active execution modes' },
  { keyword: 'abort', skill: 'cancel', priority: 5, guidance: 'Cancel active execution modes' },

  { keyword: '$wiki', skill: 'wiki', priority: 5, guidance: 'Activate the project wiki skill' },
  { keyword: 'wiki query', skill: 'wiki', priority: 5, guidance: 'Activate the project wiki skill for search' },
  { keyword: 'wiki add', skill: 'wiki', priority: 5, guidance: 'Activate the project wiki skill for page creation' },
  { keyword: 'wiki lint', skill: 'wiki', priority: 5, guidance: 'Activate the project wiki skill for wiki health checks' },

  { keyword: 'code review', skill: 'code-review', priority: 6, guidance: 'Activate code-review workflow' },
  { keyword: '$code-review', skill: 'code-review', priority: 6, guidance: 'Activate code-review workflow' },
  { keyword: 'review code', skill: 'code-review', priority: 6, guidance: 'Activate code-review workflow' },
] as const;

export interface ExplicitSkillAlias {
  readonly source: string;
  readonly target: string;
}

export interface ExplicitSkillDefinition {
  readonly skill: string;
  readonly priority: number;
}

export const EXPLICIT_SKILL_ALIASES: readonly ExplicitSkillAlias[] = Object.freeze([
  Object.freeze({ source: 'ulw', target: 'ultrawork' }),
]);

function createExplicitSkillLookup(): Readonly<Record<string, ExplicitSkillDefinition>> {
  const canonical = Object.create(null) as Record<string, ExplicitSkillDefinition>;
  for (const definition of KEYWORD_TRIGGER_DEFINITIONS) {
    if (!definition.keyword.startsWith('$')) continue;
    const token = definition.keyword.slice(1).toLowerCase();
    const existing = canonical[token];
    if (existing && (existing.skill !== definition.skill || existing.priority !== definition.priority)) {
      throw new Error(`Conflicting canonical explicit skill definition for ${token}`);
    }
    canonical[token] = Object.freeze({ skill: definition.skill, priority: definition.priority });
  }

  const aliases = new Set<string>();
  for (const alias of EXPLICIT_SKILL_ALIASES) {
    const source = alias.source.toLowerCase();
    const target = alias.target.toLowerCase();
    if (!aliases.add(source)) throw new Error(`Duplicate explicit skill alias source: ${source}`);

    const targetDefinition = canonical[target];
    if (!targetDefinition) throw new Error(`Missing explicit skill alias target: ${target}`);

    const sourceDefinition = canonical[source];
    if (sourceDefinition && sourceDefinition.skill !== targetDefinition.skill) {
      throw new Error(`Explicit skill alias shadows another skill: ${source}`);
    }

    canonical[source] = Object.freeze({
      skill: targetDefinition.skill,
      priority: targetDefinition.priority,
    });
  }

  return Object.freeze(canonical);
}

/** Exact lower-case explicit-token lookup, including immutable aliases. */
export const EXPLICIT_SKILL_LOOKUP = createExplicitSkillLookup();

export function getExplicitSkillDefinition(token: string): ExplicitSkillDefinition | undefined {
  return EXPLICIT_SKILL_LOOKUP[token.toLowerCase()];
}

export function compareKeywordMatches(a: { priority: number; keyword: string }, b: { priority: number; keyword: string }): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (b.keyword.length !== a.keyword.length) return b.keyword.length - a.keyword.length;
  return a.keyword.localeCompare(b.keyword);
}
