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

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyTaskSize, isHeavyMode, type TaskSizeResult, type TaskSizeThresholds } from './task-size-detector.js';
import { KEYWORD_TRIGGER_DEFINITIONS, compareKeywordMatches } from './keyword-registry.js';

export interface KeywordMatch {
  keyword: string;
  skill: string;
  priority: number;
}

export type SkillActivePhase = 'planning' | 'executing' | 'reviewing' | 'completing';

export interface SkillActiveState {
  version: 1;
  active: boolean;
  skill: string;
  keyword: string;
  phase: SkillActivePhase;
  activated_at: string;
  updated_at: string;
  source: 'keyword-detector';
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
}

export interface RecordSkillActivationInput {
  stateDir: string;
  text: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  nowIso?: string;
}

export const SKILL_ACTIVE_STATE_FILE = 'skill-active-state.json';

async function readExistingSkillState(statePath: string): Promise<SkillActiveState | null> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    return JSON.parse(raw) as SkillActiveState;
  } catch {
    return null;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_]/.test(ch));
}

function keywordToPattern(keyword: string): RegExp {
  const escaped = escapeRegex(keyword);
  const startsWithWord = isWordChar(keyword[0]);
  const endsWithWord = isWordChar(keyword[keyword.length - 1]);
  const prefix = startsWithWord ? '\\b' : '';
  const suffix = endsWithWord ? '\\b' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

const KEYWORD_MAP: Array<{ pattern: RegExp; skill: string; priority: number }> = KEYWORD_TRIGGER_DEFINITIONS.map((entry) => ({
  pattern: keywordToPattern(entry.keyword),
  skill: entry.skill,
  priority: entry.priority,
}));

const KEYWORDS_REQUIRING_INTENT = new Set(['team', 'swarm']);

const TEAM_SWARM_INTENT_PATTERNS: Record<'team' | 'swarm', RegExp[]> = {
  team: [
    /(?:^|[^\w])\$(?:team)\b/i,
    /\/prompts:team\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|orchestrate|coordinate)\s+(?:a\s+|an\s+|the\s+)?team\b/i,
    /\bteam\s+(?:mode|orchestration|workflow|agents?)\b/i,
  ],
  swarm: [
    /(?:^|[^\w])\$(?:swarm)\b/i,
    /\/prompts:swarm\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|orchestrate|coordinate)\s+(?:a\s+|an\s+|the\s+)?swarm\b/i,
    /\bswarm\s+(?:mode|orchestration|workflow|agents?)\b/i,
  ],
};

function hasIntentContextForKeyword(text: string, keyword: string): boolean {
  if (!KEYWORDS_REQUIRING_INTENT.has(keyword.toLowerCase())) return true;
  const k = keyword.toLowerCase() as 'team' | 'swarm';
  return TEAM_SWARM_INTENT_PATTERNS[k].some((pattern) => pattern.test(text));
}

/**
 * Detect keywords in user input text
 * Returns matching skills sorted by priority (highest first)
 */
export function detectKeywords(text: string): KeywordMatch[] {
  const matches: KeywordMatch[] = [];

  for (const { pattern, skill, priority } of KEYWORD_MAP) {
    const match = text.match(pattern);
    if (match) {
      if (!hasIntentContextForKeyword(text, match[0].toLowerCase())) continue;
      matches.push({
        keyword: match[0],
        skill,
        priority,
      });
    }
  }

  return matches.sort(compareKeywordMatches);
}

/**
 * Get the highest-priority keyword match
 */
export function detectPrimaryKeyword(text: string): KeywordMatch | null {
  const matches = detectKeywords(text);
  return matches.length > 0 ? matches[0] : null;
}

export async function recordSkillActivation(input: RecordSkillActivationInput): Promise<SkillActiveState | null> {
  const match = detectPrimaryKeyword(input.text);
  if (!match) return null;

  const nowIso = input.nowIso ?? new Date().toISOString();
  const statePath = join(input.stateDir, SKILL_ACTIVE_STATE_FILE);
  const previous = await readExistingSkillState(statePath);
  const sameSkill = previous?.active === true && previous.skill === match.skill;
  const sameKeyword = previous?.keyword?.toLowerCase() === match.keyword.toLowerCase();

  const state: SkillActiveState = {
    version: 1,
    active: true,
    skill: match.skill,
    keyword: match.keyword,
    phase: 'planning',
    activated_at: sameSkill && sameKeyword ? previous.activated_at : nowIso,
    updated_at: nowIso,
    source: 'keyword-detector',
    session_id: input.sessionId,
    thread_id: input.threadId,
    turn_id: input.turnId,
  };

  try {
    await writeFile(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn('[omx] warning: failed to persist keyword activation state', error);
  }

  return state;
}

/**
 * Pre-execution gate — ported from OMC src/hooks/keyword-detector/index.ts
 *
 * In OMC these functions run at prompt time in bridge.ts (mandatory enforcement).
 * In OMX they generate AGENTS.md instructions and serve as test infrastructure.
 * See task-size-detector.ts for full advisory-nature documentation.
 */

/**
 * Execution mode keywords subject to the ralplan-first gate.
 * These modes spin up heavy orchestration and should not run on vague requests.
 */
export const EXECUTION_GATE_KEYWORDS = new Set<string>([
  'ralph',
  'autopilot',
  'team',
  'ultrawork',
]);

/**
 * Escape hatch prefixes that bypass the ralplan gate.
 */
export const GATE_BYPASS_PREFIXES = ['force:', '!'];

/**
 * Positive signals that the prompt IS well-specified enough for direct execution.
 * If ANY of these are present, the prompt auto-passes the gate (fast path).
 */
export const WELL_SPECIFIED_SIGNALS: RegExp[] = [
  // References specific files by extension
  /\b[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx|vue|svelte|rb|c|cpp|h|css|scss|html|json|yaml|yml|toml)\b/,
  // References specific paths with directory separators
  /(?:src|lib|test|spec|app|pages|components|hooks|utils|services|api|dist|build|scripts)\/\w+/,
  // References specific functions/classes/methods by keyword
  /\b(?:function|class|method|interface|type|const|let|var|def|fn|struct|enum)\s+\w{2,}/i,
  // CamelCase identifiers (likely symbol names: processKeyword, getUserById)
  /\b[a-z]+(?:[A-Z][a-z]+)+\b/,
  // PascalCase identifiers (likely class/type names: KeywordDetector, UserModel)
  /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/,
  // snake_case identifiers with 2+ segments (likely symbol names: user_model, get_user)
  /\b[a-z]+(?:_[a-z]+)+\b/,
  // Bare issue/PR number (#123, #42)
  /(?:^|\s)#\d+\b/,
  // Has numbered steps or bullet list (structured request)
  /(?:^|\n)\s*(?:\d+[.)]\s|-\s+\S|\*\s+\S)/m,
  // Has acceptance criteria or test spec keywords
  /\b(?:acceptance\s+criteria|test\s+(?:spec|plan|case)|should\s+(?:return|throw|render|display|create|delete|update))\b/i,
  // Has specific error or issue reference
  /\b(?:error:|bug\s*#?\d+|issue\s*#\d+|stack\s*trace|exception|TypeError|ReferenceError|SyntaxError)\b/i,
  // Has a code block with substantial content
  /```[\s\S]{20,}?```/,
  // PR or commit reference
  /\b(?:PR\s*#\d+|commit\s+[0-9a-f]{7}|pull\s+request)\b/i,
  // "in <specific-path>" pattern
  /\bin\s+[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx)\b/,
  // Test runner commands (explicit test target)
  /\b(?:npm\s+test|npx\s+(?:vitest|jest)|pytest|cargo\s+test|go\s+test|make\s+test)\b/i,
];

/**
 * Check if a prompt is underspecified for direct execution.
 * Returns true if the prompt lacks enough specificity for heavy execution modes.
 *
 * Conservative: only gates clearly vague prompts. Borderline cases pass through.
 */
export function isUnderspecifiedForExecution(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Escape hatch: force: or ! prefix bypasses the gate
  for (const prefix of GATE_BYPASS_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false;
  }

  // If any well-specified signal is present, pass through
  if (WELL_SPECIFIED_SIGNALS.some(p => p.test(trimmed))) return false;

  // Strip mode keywords for effective word counting
  const stripped = trimmed
    .replace(/\b(?:ralph|autopilot|team|ultrawork|ulw|swarm)\b/gi, '')
    .trim();
  const effectiveWords = stripped.split(/\s+/).filter(w => w.length > 0).length;

  // Short prompts without well-specified signals are underspecified
  if (effectiveWords <= 15) return true;

  return false;
}

/**
 * Apply the ralplan-first gate: if execution keywords are present
 * but the prompt is underspecified, redirect to ralplan.
 *
 * Returns the modified keyword list and gate metadata.
 */
export function applyRalplanGate(
  keywords: string[],
  text: string,
): { keywords: string[]; gateApplied: boolean; gatedKeywords: string[] } {
  if (keywords.length === 0) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Don't gate if cancel is present (cancel always wins)
  if (keywords.includes('cancel')) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Don't gate if ralplan is already in the list
  if (keywords.includes('ralplan')) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Check if any execution keywords are present
  const executionKeywords = keywords.filter(k => EXECUTION_GATE_KEYWORDS.has(k));
  if (executionKeywords.length === 0) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Check if prompt is underspecified
  if (!isUnderspecifiedForExecution(text)) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Gate: replace execution keywords with ralplan
  const filtered = keywords.filter(k => !EXECUTION_GATE_KEYWORDS.has(k));
  if (!filtered.includes('ralplan')) {
    filtered.push('ralplan');
  }

  return { keywords: filtered, gateApplied: true, gatedKeywords: executionKeywords };
}

/**
 * Options for task-size-aware keyword filtering
 */
export interface TaskSizeFilterOptions {
  /** Enable task-size detection. Default: true */
  enabled?: boolean;
  /** Word count threshold for small tasks. Default: 50 */
  smallWordLimit?: number;
  /** Word count threshold for large tasks. Default: 200 */
  largeWordLimit?: number;
  /** Suppress heavy modes for small tasks. Default: true */
  suppressHeavyModesForSmallTasks?: boolean;
}

/**
 * Get all keywords with task-size-based filtering applied.
 * For small tasks, heavy orchestration modes (ralph/autopilot/team/ultrawork etc.)
 * are suppressed to avoid over-orchestration.
 */
export function getAllKeywordsWithSizeCheck(
  text: string,
  options: TaskSizeFilterOptions = {},
): { keywords: string[]; taskSizeResult: TaskSizeResult | null; suppressedKeywords: string[] } {
  const {
    enabled = true,
    smallWordLimit = 50,
    largeWordLimit = 200,
    suppressHeavyModesForSmallTasks = true,
  } = options;

  const keywords = detectKeywords(text).map(m => m.skill);

  if (!enabled || !suppressHeavyModesForSmallTasks || keywords.length === 0) {
    return { keywords, taskSizeResult: null, suppressedKeywords: [] };
  }

  const thresholds: TaskSizeThresholds = { smallWordLimit, largeWordLimit };
  const taskSizeResult = classifyTaskSize(text, thresholds);

  // Only suppress heavy modes for small tasks
  if (taskSizeResult.size !== 'small') {
    return { keywords, taskSizeResult, suppressedKeywords: [] };
  }

  const suppressedKeywords: string[] = [];
  const filteredKeywords = keywords.filter(keyword => {
    if (isHeavyMode(keyword)) {
      suppressedKeywords.push(keyword);
      return false;
    }
    return true;
  });

  return {
    keywords: filteredKeywords,
    taskSizeResult,
    suppressedKeywords,
  };
}
