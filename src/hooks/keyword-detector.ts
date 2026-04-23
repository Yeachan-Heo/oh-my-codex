/**
 * Keyword Detection Engine
 *
 * In OMC/legacy OMX flows, this logic detects workflow keywords and can inject
 * prompt-side routing guidance.
 *
 * In current OMX, native `UserPromptSubmit` is the canonical execution surface:
 * this module owns the keyword registry, runtime gating, and hook-seeded
 * skill/workflow state. AGENTS.md now carries the behavioral fallback contract
 * rather than the full keyword/state table.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { withModeRuntimeContext } from '../state/mode-state-context.js';
import { dirname, join } from 'node:path';
import { classifyTaskSize, isHeavyMode, type TaskSizeResult, type TaskSizeThresholds } from './task-size-detector.js';
import { isApprovedExecutionFollowupShortcut, type FollowupMode } from '../team/followup-planner.js';
import { isPlanningComplete, readPlanningArtifacts } from '../planning/artifacts.js';
import { KEYWORD_TRIGGER_DEFINITIONS, compareKeywordMatches } from './keyword-registry.js';
import {
  SKILL_ACTIVE_STATE_FILE,
  listActiveSkills,
  writeSkillActiveStateCopies,
  type SkillActiveEntry,
} from '../state/skill-active.js';
import {
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  isTrackedWorkflowMode,
  type TrackedWorkflowMode,
} from '../state/workflow-transition.js';
import { reconcileWorkflowTransition } from '../state/workflow-transition-reconcile.js';
import {
  clearDeepInterviewQuestionObligation,
  type DeepInterviewQuestionEnforcementState,
} from '../question/deep-interview.js';

export interface KeywordMatch {
  keyword: string;
  skill: string;
  priority: number;
}

const ACTIVE_SKILL_CONTINUATION_PATTERNS: RegExp[] = [
  /^[\\/]?\s*keep going(?:\s+now)?[.!]?\s*$/i,
  /^[\\/]?\s*continue(?:\s+now)?[.!]?\s*$/i,
  /^[\\/]?\s*resume(?:\s+now)?[.!]?\s*$/i,
];

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type SkillActivePhase = 'planning' | 'executing' | 'reviewing' | 'completing';

export interface DeepInterviewInputLock {
  active: boolean;
  scope: 'deep-interview-auto-approval';
  acquired_at: string;
  released_at?: string;
  exit_reason?: 'success' | 'error' | 'abort' | 'handoff';
  blocked_inputs: string[];
  message: string;
}

export interface SkillActiveState {
  version: 1;
  active: boolean;
  skill: string;
  keyword: string;
  phase: string;
  activated_at: string;
  updated_at: string;
  source: 'keyword-detector';
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  input_lock?: DeepInterviewInputLock;
  active_skills?: SkillActiveEntry[];
  initialized_mode?: string;
  initialized_state_path?: string;
  transition_error?: string;
  transition_message?: string;
  transition_messages?: string[];
  requested_skills?: string[];
  deferred_skills?: string[];
  [key: string]: unknown;
}

export interface RecordSkillActivationInput {
  stateDir: string;
  text: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  nowIso?: string;
}

export interface DeepInterviewModeStatePersistenceInput {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
}

export const DEEP_INTERVIEW_STATE_FILE = 'deep-interview-state.json';
export const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'] as const;
export const DEEP_INTERVIEW_INPUT_LOCK_MESSAGE = 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.';

type StatefulSkillMode = 'deep-interview' | 'autopilot' | 'ralph' | 'ralplan' | 'ultrawork' | 'ultraqa' | 'team' | 'autoresearch';

interface StatefulSkillSeedConfig {
  mode: StatefulSkillMode;
  initialPhase: string;
  includeIteration?: boolean;
  scope?: 'session' | 'root';
}

const PLANNING_LIKE_WORKFLOW_SKILLS = new Set<TrackedWorkflowMode>([
  'deep-interview',
  'ralplan',
]);

const EXECUTION_LIKE_WORKFLOW_SKILLS = new Set<TrackedWorkflowMode>([
  'autopilot',
  'autoresearch',
  'ralph',
  'team',
  'ultrawork',
  'ultraqa',
]);

const STATEFUL_SKILL_SEED_CONFIG: Record<StatefulSkillMode, StatefulSkillSeedConfig> = {
  'deep-interview': { mode: 'deep-interview', initialPhase: 'intent-first' },
  autopilot: { mode: 'autopilot', initialPhase: 'planning' },
  autoresearch: { mode: 'autoresearch', initialPhase: 'executing' },
  ralph: { mode: 'ralph', initialPhase: 'starting', includeIteration: true },
  ralplan: { mode: 'ralplan', initialPhase: 'planning' },
  team: { mode: 'team', initialPhase: 'starting', scope: 'root' },
  ultrawork: { mode: 'ultrawork', initialPhase: 'planning' },
  ultraqa: { mode: 'ultraqa', initialPhase: 'planning' },
};

export interface DeepInterviewModeState {
  active: boolean;
  mode: 'deep-interview';
  tmux_pane_id?: string;
  tmux_pane_set_at?: string;
  current_phase: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  input_lock?: DeepInterviewInputLock;
  question_enforcement?: DeepInterviewQuestionEnforcementState;
  [key: string]: unknown;
}

function createDeepInterviewInputLock(nowIso: string, previous?: DeepInterviewInputLock): DeepInterviewInputLock {
  return {
    active: true,
    scope: 'deep-interview-auto-approval',
    acquired_at: previous?.active ? previous.acquired_at : nowIso,
    blocked_inputs: [...DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS],
    message: DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
  };
}

function preserveCompletedDeepInterviewPhase(previousModeState: DeepInterviewModeState | null): string {
  if (!previousModeState || previousModeState.active !== false) return '';
  return safeString(previousModeState.current_phase).trim();
}

function releaseDeepInterviewInputLock(
  previous: DeepInterviewInputLock | undefined,
  nowIso: string,
  reason: DeepInterviewInputLock['exit_reason'] = 'handoff',
): DeepInterviewInputLock | undefined {
  if (!previous) return undefined;
  return {
    ...previous,
    active: false,
    released_at: nowIso,
    exit_reason: reason,
  };
}

async function readExistingSkillState(statePath: string): Promise<SkillActiveState | null> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    return JSON.parse(raw) as SkillActiveState;
  } catch {
    return null;
  }
}

function buildActiveSkills(state: SkillActiveState): SkillActiveEntry[] | undefined {
  if (!state.active) return undefined;
  if (Array.isArray(state.active_skills) && state.active_skills.length > 0) {
    return state.active_skills.filter((entry) => entry.active !== false);
  }
  return [{
    skill: state.skill,
    phase: state.phase,
    active: true,
    activated_at: state.activated_at,
    updated_at: state.updated_at,
    session_id: state.session_id,
    thread_id: state.thread_id,
    turn_id: state.turn_id,
  }];
}

async function readExistingDeepInterviewState(statePath: string): Promise<DeepInterviewModeState | null> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    return JSON.parse(raw) as DeepInterviewModeState;
  } catch {
    return null;
  }
}

async function readJsonStateIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function persistDeepInterviewModeState(
  stateDir: string,
  nextSkill: SkillActiveState | null,
  nowIso: string,
  previousSkill: SkillActiveState | null,
  input: DeepInterviewModeStatePersistenceInput,
): Promise<void> {
  const statePath = resolveSeedStateFilePath(
    stateDir,
    'deep-interview',
    nextSkill?.session_id ?? previousSkill?.session_id ?? input.sessionId,
  ).absolutePath;
  await mkdir(dirname(statePath), { recursive: true });
  const previousModeState = await readExistingDeepInterviewState(statePath);

  if (nextSkill?.skill === 'deep-interview' && nextSkill.active) {
    const nextQuestionEnforcement = clearDeepInterviewQuestionObligation(
      previousModeState?.question_enforcement,
      'handoff',
      new Date(nowIso),
    );
    const nextState = withModeRuntimeContext<DeepInterviewModeState>(
      previousModeState ?? {},
      {
        ...(previousModeState?.tmux_pane_id ? { tmux_pane_id: previousModeState.tmux_pane_id } : {}),
        ...(previousModeState?.tmux_pane_set_at ? { tmux_pane_set_at: previousModeState.tmux_pane_set_at } : {}),
        active: true,
        mode: 'deep-interview',
        current_phase: previousModeState?.active ? previousModeState.current_phase || 'intent-first' : 'intent-first',
        started_at: previousModeState?.active ? previousModeState.started_at || nowIso : nowIso,
        updated_at: nowIso,
        session_id: input.sessionId ?? previousModeState?.session_id,
        thread_id: input.threadId ?? previousModeState?.thread_id,
        turn_id: input.turnId ?? previousModeState?.turn_id,
        ...(nextSkill.input_lock ? { input_lock: nextSkill.input_lock } : {}),
        ...(nextQuestionEnforcement ? { question_enforcement: nextQuestionEnforcement } : {}),
      },
      { nowIso },
    );
    await writeFile(statePath, JSON.stringify(nextState, null, 2));
    return;
  }

  const hadActiveDeepInterview = previousSkill?.skill === 'deep-interview' && previousSkill.active === true;
  if (!previousModeState?.active && !hadActiveDeepInterview) return;

  const releasedInputLock = nextSkill?.skill === 'deep-interview' ? nextSkill.input_lock : previousSkill?.input_lock;
  const questionExitReason = nextSkill?.skill === 'deep-interview' && nextSkill.active === false ? 'abort' : 'handoff';
  const nextState: DeepInterviewModeState = {
    ...(previousModeState?.tmux_pane_id ? { tmux_pane_id: previousModeState.tmux_pane_id } : {}),
    ...(previousModeState?.tmux_pane_set_at ? { tmux_pane_set_at: previousModeState.tmux_pane_set_at } : {}),
    active: false,
    mode: 'deep-interview',
    current_phase: preserveCompletedDeepInterviewPhase(previousModeState) || 'completing',
    started_at: previousModeState?.started_at || previousSkill?.activated_at || nowIso,
    updated_at: nowIso,
    completed_at: nowIso,
    session_id: input.sessionId ?? previousModeState?.session_id ?? previousSkill?.session_id,
    thread_id: input.threadId ?? previousModeState?.thread_id ?? previousSkill?.thread_id,
    turn_id: input.turnId ?? previousModeState?.turn_id ?? previousSkill?.turn_id,
    ...(releasedInputLock ? { input_lock: releasedInputLock } : {}),
    ...(previousModeState?.question_enforcement
      ? {
          question_enforcement: clearDeepInterviewQuestionObligation(
            previousModeState.question_enforcement,
            questionExitReason,
            new Date(nowIso),
          ),
        }
      : {}),
  };
  await writeFile(statePath, JSON.stringify(nextState, null, 2));
}

function resolveSeedStateFilePath(
  stateDir: string,
  mode: StatefulSkillMode,
  sessionId?: string,
  scope: 'session' | 'root' = 'session',
): {
  absolutePath: string;
  relativePath: string;
} {
  if (scope !== 'root' && sessionId?.trim()) {
    return {
      absolutePath: join(stateDir, 'sessions', sessionId, `${mode}-state.json`),
      relativePath: `.omx/state/sessions/${sessionId}/${mode}-state.json`,
    };
  }

  return {
    absolutePath: join(stateDir, `${mode}-state.json`),
    relativePath: `.omx/state/${mode}-state.json`,
  };
}

async function persistStatefulSkillSeedState(
  stateDir: string,
  nextSkill: SkillActiveState,
  nowIso: string,
  previousSkill: SkillActiveState | null,
): Promise<SkillActiveState> {
  const config = STATEFUL_SKILL_SEED_CONFIG[nextSkill.skill as StatefulSkillMode];
  if (!config) return nextSkill;

  const { absolutePath, relativePath } = resolveSeedStateFilePath(
    stateDir,
    config.mode,
    nextSkill.session_id,
    config.scope,
  );
  const existingModeState = await readJsonStateIfExists(absolutePath);
  const sameActiveSkill = previousSkill?.skill === nextSkill.skill && previousSkill.active;
  const existingModeMatches = safeString(existingModeState?.mode).trim() === config.mode;
  const existingPhase = safeString(existingModeState?.current_phase).trim();
  const preserveExistingModeState = existingModeMatches
    && existingPhase !== ''
    && (
      sameActiveSkill
      || (config.mode === 'team' && existingModeState?.active === true)
    );
  const startedAt = previousSkill?.skill === nextSkill.skill && previousSkill.active
    ? safeString(existingModeState?.started_at).trim() || previousSkill.activated_at || nowIso
    : preserveExistingModeState
      ? safeString(existingModeState?.started_at).trim() || nowIso
    : nowIso;

  const baseState: Record<string, unknown> = withModeRuntimeContext(
    (preserveExistingModeState ? existingModeState : {}) ?? {},
    {
      ...(preserveExistingModeState ? existingModeState : {}),
      ...(existingModeState?.tmux_pane_id ? { tmux_pane_id: existingModeState.tmux_pane_id } : {}),
      ...(existingModeState?.tmux_pane_set_at ? { tmux_pane_set_at: existingModeState.tmux_pane_set_at } : {}),
      active: true,
      mode: config.mode,
      current_phase: preserveExistingModeState
        ? existingPhase || config.initialPhase
        : config.initialPhase,
      started_at: startedAt,
      updated_at: nowIso,
      session_id: nextSkill.session_id || safeString(existingModeState?.session_id).trim() || undefined,
      thread_id: nextSkill.thread_id || safeString(existingModeState?.thread_id).trim() || undefined,
      turn_id: nextSkill.turn_id || safeString(existingModeState?.turn_id).trim() || undefined,
    },
    { nowIso },
  );

  if (config.includeIteration) {
    baseState.iteration = typeof existingModeState?.iteration === 'number' ? existingModeState.iteration : 0;
    baseState.max_iterations = typeof existingModeState?.max_iterations === 'number' ? existingModeState.max_iterations : 50;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(baseState, null, 2));

  return {
    ...nextSkill,
    initialized_mode: config.mode,
    initialized_state_path: relativePath,
  };
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

const KEYWORDS_REQUIRING_INTENT = new Set(['ralph', 'team', 'swarm', 'stop', 'abort', 'parallel', 'autoresearch']);

type IntentKeyword = 'ralph' | 'team' | 'swarm' | 'stop' | 'abort' | 'parallel' | 'autoresearch';

const DEEP_INTERVIEW_ACTIVATION_PATTERNS: RegExp[] = [
  /(?:^|[^\w])\$(?:deep-interview)\b/i,
  /\/prompts:deep-interview\b/i,
  /\b(?:use|run|start|enable|launch|invoke|activate|do|begin)\s+(?:a\s+|an\s+|the\s+)?deep(?:[- ]+)interview\b/i,
  /^(?:please\s+)?deep(?:[- ]+)interview\b/i,
  /\bdeep(?:[- ]+)interview\s+(?:this|first|before|me|now)\b/i,
  /\binterview\s+(?:me|this|the\s+(?:request|task|problem))\b/i,
];

const DEEP_INTERVIEW_MANAGEMENT_MENTION_PATTERN = /\b(?:clear|cleanup|clean\s+up|remove|reset|delete|fix|debug|report|reported|status|state|lock|unlock|active|inactive|session(?:-scoped)?|scope|scoped|global|legacy|root|mode|workflow)\b/i;

/**
 * Per-keyword intent patterns used when a keyword is in KEYWORDS_REQUIRING_INTENT.
 *
 * "team" / "swarm" require explicit orchestration phrasing so a generic
 * reference in prose doesn't spin up the skill.
 *
 * "stop" / "abort" require a bare imperative or explicit OMX mode reference so
 * test-log lines like "stop retrying" or "request aborted" do not trigger cancel.
 *
 * "parallel" requires an explicit instruction to run in parallel mode so that
 * CI output like "running 8 tests in parallel" does not trigger ultrawork.
 */
const KEYWORD_INTENT_PATTERNS: Record<IntentKeyword, RegExp[]> = {
  ralph: [
    /(?:^|[^\w])\$(?:ralph)\b/i,
    /\/prompts:ralph\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|resume|continue)\s+(?:a\s+|an\s+|the\s+)?ralph\b/i,
    /^(?:please\s+)?ralph\s+(?:continue|resume|start|run|go|keep\s+going|ship|fix|implement|execute|verify|complete)\b/i,
    /\bralph\s+(?:mode|workflow|loop)\b/i,
  ],
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
  stop: [
    /^(?:please\s+)?stop(?:\s+now)?\s*[.!]?\s*$/i,
    /\bcancelomx\b/i,
    /(?:^|[^\w])\$(?:stop|cancel|abort)\b/i,
    /\/(?:cancel|stop|abort)\b/i,
    /\bstop\s+(?:the\s+)?(?:agent|ralph|autopilot|team|ultrawork|execution|current\s+(?:mode|task|run))\b/i,
    /\b(?:cancel|stop)\s+(?:the\s+)?(?:active|running|current)\s+(?:mode|task|run|execution)\b/i,
  ],
  abort: [
    /^(?:please\s+)?abort(?:\s+now)?\s*[.!]?\s*$/i,
    /\bcancelomx\b/i,
    /(?:^|[^\w])\$(?:stop|cancel|abort)\b/i,
    /\/(?:cancel|stop|abort)\b/i,
    /\babort\s+(?:the\s+)?(?:agent|ralph|autopilot|team|ultrawork|execution|current\s+(?:mode|task|run))\b/i,
  ],
  parallel: [
    /(?:^|[^\w])\$(?:parallel|ultrawork|ulw)\b/i,
    /\/(?:parallel|ultrawork)\b/i,
    /\bultrawork\b/i,
    /\bulw\b/i,
    /\b(?:use|run|enable|start|activate|launch)\s+(?:in\s+)?parallel\b/i,
    /\bparallel\s+(?:mode|execution|workers?|agents?|tasks?)\b/i,
    /\brun\s+(?:tasks?|agents?|workers?)\s+in\s+parallel\b/i,
  ],
  autoresearch: [
    /(?:^|[^\w])\$(?:autoresearch)\b/i,
    /\/autoresearch\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate)\s+(?:the\s+)?autoresearch\b/i,
    /\bautoresearch\s+(?:mode|workflow|skill|loop)\b/i,
  ],
};

function hasExplicitPromptsInvocation(text: string): boolean {
  return /(?:^|\s)\/prompts:[\w.-]+(?=[\s.,!?;:]|$)/i.test(text);
}

/**
 * Korean 2-set keyboard typo aliases for workflow keywords.
 *
 * Keep this intentionally narrow: only the `ulw` ultrawork shorthand is
 * normalized so users who forget to switch IMEs get the same activation path
 * as the canonical keyword without introducing broad transliteration surprises.
 */
function normalizeWorkflowKeyboardTypos(text: string): string {
  return text.replace(/ㅕㅣㅈ/g, 'ulw');
}

interface ExplicitSkillParseResult {
  matches: KeywordMatch[];
  sawExplicitLikeInvocation: boolean;
}

function normalizeExplicitSkillToken(token: string): string {
  return token === 'swarm' ? 'team' : token === 'ulw' ? 'ultrawork' : token;
}

function parseExplicitSkillInvocations(text: string): ExplicitSkillParseResult {
  const results: KeywordMatch[] = [];
  const regex = /(?:^|[^\w])\$(?:(?:oh-my-codex:)?([a-z][a-z0-9-]*))\b/gi;
  let match: RegExpExecArray | null;
  let captureStarted = false;
  let lastMatchEnd = -1;

  while ((match = regex.exec(text)) !== null) {
    const token = (match[1] ?? '').toLowerCase();
    if (!token) continue;
    const rawKeyword = match[0].slice(match[0].lastIndexOf('$')).toLowerCase();
    const normalizedSkill = normalizeExplicitSkillToken(token);
    const registryEntry = KEYWORD_TRIGGER_DEFINITIONS.find((entry) => entry.skill.toLowerCase() === normalizedSkill);
    const matchStart = match.index + match[0].lastIndexOf('$');
    if (captureStarted) {
      const between = text.slice(lastMatchEnd, matchStart);
      if (!/^\s*$/.test(between)) break;
    }

    captureStarted = true;
    lastMatchEnd = matchStart + rawKeyword.length;
    if (!registryEntry) continue;

    if (results.some((item) => item.skill === normalizedSkill)) continue;

    results.push({
      keyword: rawKeyword,
      skill: normalizedSkill,
      priority: registryEntry.priority,
    });
  }

  return {
    matches: results,
    sawExplicitLikeInvocation: captureStarted,
  };
}

function hasIntentContextForKeyword(text: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  if (
    (k === 'deep interview' || k === 'interview')
    && DEEP_INTERVIEW_MANAGEMENT_MENTION_PATTERN.test(text)
    && !DEEP_INTERVIEW_ACTIVATION_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return false;
  }
  if (!KEYWORDS_REQUIRING_INTENT.has(k)) return true;
  const patterns = KEYWORD_INTENT_PATTERNS[k as IntentKeyword];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Detect keywords in user input text
 * Returns explicit `$skill` matches first (left-to-right),
 * then appends implicit keyword matches sorted by priority.
 */
export function detectKeywords(text: string): KeywordMatch[] {
  const normalizedText = normalizeWorkflowKeyboardTypos(text);
  const explicitParse = parseExplicitSkillInvocations(normalizedText);
  const explicit = explicitParse.matches;
  if (hasExplicitPromptsInvocation(normalizedText) && explicit.length === 0) {
    return [];
  }
  if (explicit.length === 0 && explicitParse.sawExplicitLikeInvocation) {
    return [];
  }
  if (explicit.length > 0) {
    return explicit;
  }

  const implicit: KeywordMatch[] = [];

  for (const { pattern, skill, priority } of KEYWORD_MAP) {
    const match = normalizedText.match(pattern);
    if (match) {
      if (!hasIntentContextForKeyword(normalizedText, match[0].toLowerCase())) continue;
      implicit.push({
        keyword: match[0],
        skill,
        priority,
      });
    }
  }

  const merged: KeywordMatch[] = [...explicit];
  const sortedImplicit = implicit.sort(compareKeywordMatches);
  for (const item of sortedImplicit) {
    if (merged.some((existing) => existing.skill === item.skill)) continue;
    merged.push(item);
  }

  return merged;
}

/**
 * Get the highest-priority keyword match
 */
export function detectPrimaryKeyword(text: string): KeywordMatch | null {
  const matches = detectKeywords(text);
  return matches.length > 0 ? matches[0] : null;
}

function isActiveSkillContinuationPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return ACTIVE_SKILL_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isNamedActiveSkillContinuationPrompt(text: string, skill: string): boolean {
  const normalizedSkill = escapeRegex(skill.trim());
  if (!normalizedSkill) return false;
  return new RegExp(
    `^[\\\\/]?\\s*${normalizedSkill}\\b(?:\\s+(?:keep\\s+going|continue|resume))(?:\\s+now)?[.!]?\\s*$`,
    'i',
  ).test(text.trim());
}

function shouldReusePreviousSkillForContinuation(
  text: string,
  previous: SkillActiveState | null,
): boolean {
  const previousSkill = safeString(previous?.skill).trim();
  if (!previousSkill || previous?.active !== true || !isTrackedWorkflowMode(previousSkill)) {
    return false;
  }

  return isActiveSkillContinuationPrompt(text)
    || isNamedActiveSkillContinuationPrompt(text, previousSkill);
}

function resolveContinuationKeywordMatch(
  text: string,
  previous: SkillActiveState | null,
  fallbackMatch: KeywordMatch | null,
): KeywordMatch | null {
  const previousSkill = safeString(previous?.skill).trim();
  if (!previousSkill || previous?.active !== true || !isTrackedWorkflowMode(previousSkill)) {
    return fallbackMatch;
  }

  if (parseExplicitSkillInvocations(normalizeWorkflowKeyboardTypos(text)).sawExplicitLikeInvocation) {
    return fallbackMatch;
  }

  if (!shouldReusePreviousSkillForContinuation(text, previous) && !safeString(fallbackMatch?.keyword).trim().startsWith('$')) {
    return fallbackMatch;
  }

  return {
    keyword: safeString(previous?.keyword).trim() || `$${previousSkill}`,
    skill: previousSkill,
    priority: fallbackMatch?.priority ?? 0,
  };
}

function initialWorkflowPhaseForMode(mode: TrackedWorkflowMode): SkillActivePhase {
  return mode === 'autoresearch' ? 'executing' : 'planning';
}

function resolveRequestedWorkflowSkills(requestedWorkflowSkills: TrackedWorkflowMode[]): {
  requestedSkills: TrackedWorkflowMode[];
  deferredSkills: TrackedWorkflowMode[];
} {
  const firstPlanningSkill = requestedWorkflowSkills.find((skill) => PLANNING_LIKE_WORKFLOW_SKILLS.has(skill));
  const hasExecutionSkill = requestedWorkflowSkills.some((skill) => EXECUTION_LIKE_WORKFLOW_SKILLS.has(skill));

  if (!firstPlanningSkill || !hasExecutionSkill) {
    return {
      requestedSkills: requestedWorkflowSkills,
      deferredSkills: [],
    };
  }

  return {
    requestedSkills: [firstPlanningSkill],
    deferredSkills: requestedWorkflowSkills.filter((skill) => skill !== firstPlanningSkill),
  };
}

function selectRootSkillStateCopy(
  previousRoot: SkillActiveState | null,
  nextState: SkillActiveState,
  sessionId?: string,
): SkillActiveState | null | undefined {
  if (!sessionId) return nextState;
  if (previousRoot) return previousRoot;
  if (nextState.skill === 'ralph') return null;
  return nextState;
}

export async function recordSkillActivation(input: RecordSkillActivationInput): Promise<SkillActiveState | null> {
  const rootStatePath = join(input.stateDir, SKILL_ACTIVE_STATE_FILE);
  const sessionStatePath = input.sessionId
    ? join(input.stateDir, 'sessions', input.sessionId, SKILL_ACTIVE_STATE_FILE)
    : null;
  const previousRoot = await readExistingSkillState(rootStatePath);
  const previousSession = sessionStatePath ? await readExistingSkillState(sessionStatePath) : null;
  const previous = previousSession ?? previousRoot;
  const match = resolveContinuationKeywordMatch(
    input.text,
    previous,
    detectPrimaryKeyword(input.text),
  );
  if (!match) return null;

  const nowIso = input.nowIso ?? new Date().toISOString();
  const hadDeepInterviewLock = previous?.skill === 'deep-interview' && previous?.input_lock?.active === true;
  const matches = detectKeywords(input.text);
  const hasCancelIntent = matches.some((entry) => entry.skill === 'cancel');

  if (hasCancelIntent && hadDeepInterviewLock) {
    const state: SkillActiveState = {
      version: 1,
      active: false,
      skill: 'deep-interview',
      keyword: previous?.keyword || 'deep interview',
      phase: 'completing',
      activated_at: previous?.activated_at || nowIso,
      updated_at: nowIso,
      source: 'keyword-detector',
      session_id: input.sessionId ?? previous?.session_id,
      thread_id: input.threadId ?? previous?.thread_id,
      turn_id: input.turnId ?? previous?.turn_id,
      active_skills: [],
      ...(previous?.input_lock ? { input_lock: releaseDeepInterviewInputLock(previous.input_lock, nowIso, 'abort') } : {}),
    };

    try {
      await writeSkillActiveStateCopies(
        dirname(dirname(input.stateDir)),
        state,
        input.sessionId,
        selectRootSkillStateCopy(previousRoot, state, input.sessionId),
      );
      await persistDeepInterviewModeState(input.stateDir, state, nowIso, previous, input);
    } catch (error) {
      console.warn('[omx] warning: failed to persist keyword activation state', error);
    }

    return state;
  }

  const sameSkill = previous?.active === true && previous.skill === match.skill;
  const sameKeyword = previous?.keyword?.toLowerCase() === match.keyword.toLowerCase();
  const sameSkillContinuation = sameSkill && shouldReusePreviousSkillForContinuation(input.text, previous);
  const preserveActivatedAt = sameSkill && (sameKeyword || sameSkillContinuation);
  const previousEntries = listActiveSkills(previous ?? {});
  const previousWorkflowEntries = previousEntries.filter((entry) => (
    isTrackedWorkflowMode(entry.skill)
    && (
      !input.sessionId
      || !safeString(entry.session_id).trim()
      || safeString(entry.session_id).trim() === safeString(input.sessionId).trim()
    )
  ));

  const deepInterviewInputLock = match.skill === 'deep-interview'
    ? createDeepInterviewInputLock(nowIso, previous?.input_lock)
    : releaseDeepInterviewInputLock(previous?.input_lock, nowIso);

  if (isTrackedWorkflowMode(match.skill)) {
    const normalizedInputText = normalizeWorkflowKeyboardTypos(input.text);
    const workflowMatches = parseExplicitSkillInvocations(normalizedInputText).matches
      .map((entry) => entry.skill)
      .filter(isTrackedWorkflowMode);
    const { requestedSkills: requestedWorkflowSkills, deferredSkills } = resolveRequestedWorkflowSkills(
      workflowMatches.length > 0 ? workflowMatches : [match.skill],
    );

    let nextWorkflowEntries = previousWorkflowEntries.map((entry) => ({ ...entry }));
    const transitionMessages: string[] = [];
    for (const requestedMode of requestedWorkflowSkills) {
      const decision = evaluateWorkflowTransition(
        nextWorkflowEntries.map((entry) => entry.skill),
        requestedMode,
      );
      if (!decision.allowed) {
        return {
          ...(previous ?? {}),
          version: 1,
          active: previous?.active ?? nextWorkflowEntries.length > 0,
          skill: previous?.skill || match.skill,
          keyword: previous?.keyword || match.keyword,
          phase: previous?.phase || initialWorkflowPhaseForMode(match.skill),
          activated_at: previous?.activated_at || nowIso,
          updated_at: nowIso,
          source: 'keyword-detector',
          session_id: input.sessionId ?? previous?.session_id,
          thread_id: input.threadId ?? previous?.thread_id,
          turn_id: input.turnId ?? previous?.turn_id,
          active_skills: previousEntries,
          ...(previous?.input_lock ? { input_lock: previous.input_lock } : {}),
          transition_error: buildWorkflowTransitionError(
            nextWorkflowEntries.map((entry) => entry.skill),
            requestedMode,
            'activate',
          ),
        };
      }

      if (decision.autoCompleteModes.length > 0) {
        const transition = await reconcileWorkflowTransition(
          dirname(dirname(input.stateDir)),
          requestedMode,
          {
            action: 'activate',
            sessionId: input.sessionId,
            source: 'keyword-detector',
            currentModes: nextWorkflowEntries.map((entry) => entry.skill),
          },
        );
        if (transition.transitionMessage) {
          transitionMessages.push(transition.transitionMessage);
        }
      }

      const survivingSkills = new Set(decision.resultingModes);
      nextWorkflowEntries = nextWorkflowEntries.filter((entry) => (
        isTrackedWorkflowMode(entry.skill) && survivingSkills.has(entry.skill)
      ));

      const existingEntry = nextWorkflowEntries.find((entry) => entry.skill === requestedMode);
      if (existingEntry) {
        existingEntry.phase = requestedMode === match.skill && !sameSkill
          ? initialWorkflowPhaseForMode(requestedMode)
          : existingEntry.phase;
        existingEntry.active = true;
        existingEntry.activated_at = requestedMode === match.skill
          ? (preserveActivatedAt ? existingEntry.activated_at || previous?.activated_at || nowIso : nowIso)
          : existingEntry.activated_at;
        existingEntry.updated_at = nowIso;
        existingEntry.session_id = input.sessionId ?? existingEntry.session_id;
        existingEntry.thread_id = input.threadId ?? existingEntry.thread_id;
        existingEntry.turn_id = input.turnId ?? existingEntry.turn_id;
        continue;
      }

      nextWorkflowEntries = [
        ...nextWorkflowEntries,
        {
          skill: requestedMode,
          phase: requestedMode === match.skill ? initialWorkflowPhaseForMode(requestedMode) : undefined,
          active: true,
          activated_at: requestedMode === match.skill && preserveActivatedAt
            ? previous?.activated_at
            : nowIso,
          updated_at: nowIso,
          session_id: input.sessionId,
          thread_id: input.threadId,
          turn_id: input.turnId,
        },
      ];
    }

    const primaryEntry = nextWorkflowEntries.find((entry) => entry.skill === match.skill) ?? nextWorkflowEntries[0];
    const primarySkill = (primaryEntry?.skill || match.skill) as TrackedWorkflowMode;
    const workflowState: SkillActiveState = {
      version: 1,
      active: true,
      skill: primarySkill,
      keyword: primarySkill === match.skill ? match.keyword : `$${primarySkill}`,
      phase: primaryEntry?.phase || initialWorkflowPhaseForMode(primarySkill),
      activated_at: primaryEntry?.activated_at || nowIso,
      updated_at: nowIso,
      source: 'keyword-detector',
      session_id: input.sessionId,
      thread_id: input.threadId,
      turn_id: input.turnId,
      active_skills: nextWorkflowEntries,
      ...(transitionMessages[0] ? { transition_message: transitionMessages[0] } : {}),
      ...(transitionMessages.length > 0 ? { transition_messages: [...new Set(transitionMessages)] } : {}),
      ...(requestedWorkflowSkills.length > 1 ? { requested_skills: requestedWorkflowSkills } : {}),
      ...(deferredSkills.length > 0 ? { deferred_skills: deferredSkills } : {}),
      ...(deepInterviewInputLock ? { input_lock: deepInterviewInputLock } : {}),
    };

    try {
      let nextState: SkillActiveState = { ...workflowState };
      for (const requestedEntry of nextWorkflowEntries) {
        const seeded = await persistStatefulSkillSeedState(
          input.stateDir,
          {
            ...workflowState,
            skill: requestedEntry.skill,
            keyword: requestedEntry.skill === workflowState.skill ? workflowState.keyword : `$${requestedEntry.skill}`,
            phase: requestedEntry.phase || workflowState.phase,
            activated_at: requestedEntry.activated_at || workflowState.activated_at,
            updated_at: requestedEntry.updated_at || workflowState.updated_at,
          },
          nowIso,
          previous,
        );
        if (requestedEntry.skill === workflowState.skill) {
          nextState = {
            ...workflowState,
            initialized_mode: seeded.initialized_mode,
            initialized_state_path: seeded.initialized_state_path,
          };
        }
      }
      nextState.active_skills = buildActiveSkills(nextState);
      await writeSkillActiveStateCopies(
        dirname(dirname(input.stateDir)),
        nextState,
        input.sessionId,
        selectRootSkillStateCopy(previousRoot, nextState, input.sessionId),
      );
      await persistDeepInterviewModeState(input.stateDir, nextState, nowIso, previous, input);
      return nextState;
    } catch (error) {
      console.warn('[omx] warning: failed to persist keyword activation state', error);
    }

    return workflowState;
  }

  const state: SkillActiveState = {
    version: 1,
    active: true,
    skill: match.skill,
    keyword: match.keyword,
    phase: initialWorkflowPhaseForMode(match.skill as TrackedWorkflowMode),
    activated_at: preserveActivatedAt ? previous.activated_at : nowIso,
    updated_at: nowIso,
    source: 'keyword-detector',
    session_id: input.sessionId,
    thread_id: input.threadId,
    turn_id: input.turnId,
    active_skills: [{
      skill: match.skill,
      phase: initialWorkflowPhaseForMode(match.skill as TrackedWorkflowMode),
      active: true,
      activated_at: preserveActivatedAt ? previous?.activated_at : nowIso,
      updated_at: nowIso,
      session_id: input.sessionId,
      thread_id: input.threadId,
      turn_id: input.turnId,
    }],
    ...(deepInterviewInputLock ? { input_lock: deepInterviewInputLock } : {}),
  };

  try {
    const nextState = await persistStatefulSkillSeedState(input.stateDir, state, nowIso, previous);
    nextState.active_skills = buildActiveSkills(nextState);
    await writeSkillActiveStateCopies(
      dirname(dirname(input.stateDir)),
      nextState,
      input.sessionId,
      selectRootSkillStateCopy(previousRoot, nextState, input.sessionId),
    );
    await persistDeepInterviewModeState(input.stateDir, nextState, nowIso, previous, input);
    return nextState;
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
export interface ApplyRalplanGateOptions {
  cwd?: string;
  priorSkill?: string | null;
}

export function applyRalplanGate(
  keywords: string[],
  text: string,
  options: ApplyRalplanGateOptions = {},
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

  const planningComplete = isPlanningComplete(readPlanningArtifacts(options.cwd ?? process.cwd()));
  const shortFollowupBypasses = executionKeywords.filter((keyword) => {
    const normalizedKeyword = keyword === 'swarm' ? 'team' : keyword;
    if (normalizedKeyword !== 'team' && normalizedKeyword !== 'ralph') return false;
    return isApprovedExecutionFollowupShortcut(
      normalizedKeyword as FollowupMode,
      text,
      {
        planningComplete,
        priorSkill: options.priorSkill,
      },
    );
  });
  if (shortFollowupBypasses.length > 0) {
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
