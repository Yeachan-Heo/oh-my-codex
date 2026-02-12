/**
 * Keyword Detection Engine
 *
 * In OMC, this runs as a UserPromptSubmit hook that detects magic keywords
 * and injects skill prompts via system-reminder.
 *
 * In OMX, this logic is embedded in the AGENTS.md orchestration brain,
 * and can also be used by the notify hook for state tracking.
 *
 * When Codex CLI adds pre-hook support, this module can be promoted
 * to an external hook handler.
 */

export interface KeywordMatch {
  keyword: string;
  skill: string;
  priority: number;
}

const KEYWORD_MAP: Array<{ pattern: RegExp; skill: string; priority: number }> = [
  // Execution modes
  { pattern: /\bautopilot\b/i, skill: 'autopilot', priority: 10 },
  { pattern: /\bralph\b/i, skill: 'ralph', priority: 10 },
  { pattern: /\bultrawork\b|\bulw\b/i, skill: 'ultrawork', priority: 10 },
  { pattern: /\becomode\b|\beco\b/i, skill: 'ecomode', priority: 10 },
  { pattern: /\bultrapilot\b/i, skill: 'ultrapilot', priority: 10 },

  // Planning
  { pattern: /\bralplan\b/i, skill: 'ralplan', priority: 9 },
  { pattern: /\bplan\s+(?:this|the)\b/i, skill: 'plan', priority: 8 },

  // Coordination
  { pattern: /\bteam\b.*\bagent/i, skill: 'team', priority: 8 },
  { pattern: /\bpipeline\b/i, skill: 'pipeline', priority: 8 },
  { pattern: /\bresearch\b/i, skill: 'research', priority: 7 },

  // Shortcuts
  { pattern: /\banalyze\b|\bdebug\b|\binvestigate\b/i, skill: 'analyze', priority: 6 },
  { pattern: /\bdeepsearch\b|\bsearch.*codebase\b/i, skill: 'deepsearch', priority: 6 },
  { pattern: /\btdd\b|\btest.first\b/i, skill: 'tdd', priority: 6 },
  { pattern: /\bfix.build\b|\btype.errors?\b/i, skill: 'build-fix', priority: 6 },
  { pattern: /\breview.code\b|\bcode.review\b/i, skill: 'code-review', priority: 6 },
  { pattern: /\bsecurity.review\b/i, skill: 'security-review', priority: 6 },
  { pattern: /\bdeepinit\b/i, skill: 'deepinit', priority: 6 },

  // Utilities
  { pattern: /\bcancel\b.*\b(?:mode|all)\b/i, skill: 'cancel', priority: 5 },
];

/**
 * Detect keywords in user input text
 * Returns matching skills sorted by priority (highest first)
 */
export function detectKeywords(text: string): KeywordMatch[] {
  const matches: KeywordMatch[] = [];

  for (const { pattern, skill, priority } of KEYWORD_MAP) {
    const match = text.match(pattern);
    if (match) {
      matches.push({
        keyword: match[0],
        skill,
        priority,
      });
    }
  }

  return matches.sort((a, b) => b.priority - a.priority);
}

/**
 * Get the highest-priority keyword match
 */
export function detectPrimaryKeyword(text: string): KeywordMatch | null {
  const matches = detectKeywords(text);
  return matches.length > 0 ? matches[0] : null;
}
