export interface KeywordTriggerDefinition {
  keyword: string;
  skill: string;
  priority: number;
  guidance: string;
}

export const KEYWORD_TRIGGER_DEFINITIONS: readonly KeywordTriggerDefinition[] = [
  { keyword: 'ralph', skill: 'ralph', priority: 9, guidance: 'Activate ralph persistence loop with verification' },
  { keyword: "don't stop", skill: 'ralph', priority: 9, guidance: 'Activate ralph persistence loop with verification' },
  { keyword: 'must complete', skill: 'ralph', priority: 9, guidance: 'Activate ralph persistence loop with verification' },
  { keyword: 'keep going', skill: 'ralph', priority: 9, guidance: 'Activate ralph persistence loop with verification' },

  { keyword: 'autopilot', skill: 'autopilot', priority: 10, guidance: 'Activate autopilot skill for autonomous execution' },
  { keyword: 'build me', skill: 'autopilot', priority: 10, guidance: 'Activate autopilot skill for autonomous execution' },
  { keyword: 'I want a', skill: 'autopilot', priority: 10, guidance: 'Activate autopilot skill for autonomous execution' },

  { keyword: 'ultrawork', skill: 'ultrawork', priority: 10, guidance: 'Activate ultrawork parallel execution mode' },
  { keyword: 'ulw', skill: 'ultrawork', priority: 10, guidance: 'Activate ultrawork parallel execution mode' },
  { keyword: 'parallel', skill: 'ultrawork', priority: 10, guidance: 'Activate ultrawork parallel execution mode' },

  { keyword: 'plan this', skill: 'plan', priority: 8, guidance: 'Activate planning skill' },
  { keyword: 'plan the', skill: 'plan', priority: 8, guidance: 'Activate planning skill' },
  { keyword: "let's plan", skill: 'plan', priority: 8, guidance: 'Activate planning skill' },

  { keyword: 'ralplan', skill: 'ralplan', priority: 11, guidance: 'Activate consensus planning (planner + architect + critic)' },
  { keyword: 'consensus plan', skill: 'ralplan', priority: 11, guidance: 'Activate consensus planning (planner + architect + critic)' },

  { keyword: 'team', skill: 'team', priority: 8, guidance: 'Activate coordinated team mode' },
  { keyword: 'swarm', skill: 'team', priority: 8, guidance: 'Activate coordinated team mode (swarm is a compatibility alias for team)' },
  { keyword: 'coordinated team', skill: 'team', priority: 8, guidance: 'Activate coordinated team mode' },
  { keyword: 'coordinated swarm', skill: 'team', priority: 8, guidance: 'Activate coordinated team mode (swarm is a compatibility alias for team)' },

  { keyword: 'ecomode', skill: 'ecomode', priority: 10, guidance: 'Activate ecomode for token-efficient execution' },
  { keyword: 'eco', skill: 'ecomode', priority: 10, guidance: 'Activate ecomode for token-efficient execution' },
  { keyword: 'budget', skill: 'ecomode', priority: 10, guidance: 'Activate ecomode for token-efficient execution' },

  { keyword: 'cancel', skill: 'cancel', priority: 5, guidance: 'Cancel active execution modes' },
  { keyword: 'stop', skill: 'cancel', priority: 5, guidance: 'Cancel active execution modes' },
  { keyword: 'abort', skill: 'cancel', priority: 5, guidance: 'Cancel active execution modes' },

  { keyword: 'tdd', skill: 'tdd', priority: 6, guidance: 'Activate test-driven workflow' },
  { keyword: 'test first', skill: 'tdd', priority: 6, guidance: 'Activate test-driven workflow' },

  { keyword: 'fix build', skill: 'build-fix', priority: 6, guidance: 'Activate build-fix workflow' },
  { keyword: 'type errors', skill: 'build-fix', priority: 6, guidance: 'Activate build-fix workflow' },

  { keyword: 'review code', skill: 'code-review', priority: 6, guidance: 'Activate code-review workflow' },
  { keyword: 'security review', skill: 'security-review', priority: 6, guidance: 'Activate security-review workflow' },
] as const;

export function compareKeywordMatches(a: { priority: number; keyword: string }, b: { priority: number; keyword: string }): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (b.keyword.length !== a.keyword.length) return b.keyword.length - a.keyword.length;
  return a.keyword.localeCompare(b.keyword);
}
