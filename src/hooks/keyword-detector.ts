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

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
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

  return matches.sort(compareKeywordMatches);
}

/**
 * Get the highest-priority keyword match
 */
export function detectPrimaryKeyword(text: string): KeywordMatch | null {
  const matches = detectKeywords(text);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Persist active skill state when a keyword activation is detected.
 * Returns null when no keyword is detected.
 */
export async function recordSkillActivation(input: RecordSkillActivationInput): Promise<SkillActiveState | null> {
  const match = detectPrimaryKeyword(input.text);
  if (!match) return null;

  const nowIso = input.nowIso ?? new Date().toISOString();
  const statePath = join(input.stateDir, SKILL_ACTIVE_STATE_FILE);
  const previous = await readJsonIfExists<Partial<SkillActiveState> | null>(statePath, null);
  const activatedAt = typeof previous?.activated_at === 'string' && previous.activated_at !== ''
    ? previous.activated_at
    : nowIso;

  const state: SkillActiveState = {
    version: 1,
    active: true,
    skill: match.skill,
    keyword: match.keyword,
    phase: 'planning',
    activated_at: activatedAt,
    updated_at: nowIso,
    source: 'keyword-detector',
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.threadId ? { thread_id: input.threadId } : {}),
    ...(input.turnId ? { turn_id: input.turnId } : {}),
  };

  await writeFile(statePath, JSON.stringify(state, null, 2)).catch(() => {});
  return state;
}

async function readJsonIfExists<T>(path: string, fallback: T): Promise<T> {
  return readFile(path, 'utf-8')
    .then((content) => JSON.parse(content) as T)
    .catch(() => fallback);
}
