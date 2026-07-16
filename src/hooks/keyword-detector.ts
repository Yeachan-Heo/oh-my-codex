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

import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { withModeRuntimeContext } from '../state/mode-state-context.js';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { classifyTaskSize, isHeavyMode, type TaskSizeResult, type TaskSizeThresholds } from './task-size-detector.js';
import { isApprovedExecutionFollowupShortcut, type FollowupMode } from '../team/followup-planner.js';
import { isPlanningComplete, readPlanningArtifacts } from '../planning/artifacts.js';
import { hasDurableRalplanConsensusEvidenceForCwd } from '../ralplan/consensus-gate.js';
import { getExplicitSkillDefinition, KEYWORD_TRIGGER_DEFINITIONS, compareKeywordMatches } from './keyword-registry.js';

import { readTeamModeConfig } from '../config/team-mode.js';
import {
  SKILL_ACTIVE_STATE_FILE,
  listActiveSkills,
  writeSkillActiveStateCopiesForStateDir,
  type SkillActiveEntry,
} from '../state/skill-active.js';
import {
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  isTrackedWorkflowMode,
  type DownstreamAuthority,
  type TrackedWorkflowMode,
} from '../state/workflow-transition.js';
import { reconcileWorkflowTransition } from '../state/workflow-transition-reconcile.js';
import {
  clearDeepInterviewQuestionObligation,
  type DeepInterviewQuestionEnforcementState,
} from '../question/deep-interview.js';
import {
  buildDeepInterviewConfigStateFields,
  resolveDeepInterviewRuntimeConfig,
  type DeepInterviewRuntimeConfig,
} from '../config/deep-interview.js';
import { inferTerminalLifecycleOutcome } from '../runtime/run-outcome.js';
import { resolveAutopilotPlannerRouting } from '../autopilot/planner-routing.js';
import { deriveAutopilotChildPhase, AUTOPILOT_CHILD_PHASES } from '../autopilot/fsm.js';
import { canAdvanceAutopilotDeepInterviewToRalplan } from '../autopilot/deep-interview-gate.js';
import { canAdvanceAutopilotRalplanToUltragoal } from '../autopilot/ralplan-gate.js';
import { validateAutopilotCompletionTransition } from '../autopilot/completion-gate.js';
import {
  preflightSelectedTargetOwner,
  extractSelectedTargetOwnerEvidence,
  type PromptDiagnosticDescriptor,
  type ResolvedPromptTurnContext,
} from './prompt-session-provenance.js';

export interface KeywordMatch {
  keyword: string;
  skill: string;
  priority: number;
}

export type KeywordReservedInput = 'omx-question-answered' | 'prompts' | null;

/** Stable diagnostic precedence for explicit candidates. */
export const KEYWORD_INERT_DIAGNOSTIC_ORDER = Object.freeze([
  'fenced-code',
  'indented-code',
  'blockquote',
  'inline-code',
  'quote',
  'escaped',
  'not-leading-region',
] as const);

export type KeywordInertDiagnostic = (typeof KEYWORD_INERT_DIAGNOSTIC_ORDER)[number];


export interface ExplicitSkillCandidate {
  readonly rawKeyword: string;
  readonly normalizedToken: string;
  readonly skill: string | null;
  readonly priority: number | null;
  readonly reasons: readonly KeywordInertDiagnostic[];
}

export interface KeywordInputClassification {
  readonly originalText: string;
  readonly normalizedText: string;
  readonly candidates: readonly ExplicitSkillCandidate[];
  readonly explicitMatches: readonly KeywordMatch[];
  readonly hasExplicitLikeInvocation: boolean;
  readonly reservedInput: KeywordReservedInput;
  readonly implicitMatches: readonly KeywordMatch[];
  readonly matches: readonly KeywordMatch[];
}


const ACTIVE_SKILL_CONTINUATION_PATTERNS: RegExp[] = [
  /^[\\/]?\s*keep going(?:\s+now)?[.!]?\s*$/i,
  /^[\\/]?\s*continue(?:\s+now)?[.!]?\s*$/i,
  /^[\\/]?\s*resume(?:\s+now)?[.!]?\s*$/i,
];

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type SkillActivePhase = 'planning' | 'executing' | 'reviewing' | 'completing' | 'ralplan' | 'deep-interview';

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
  deep_interview_config?: DeepInterviewRuntimeConfig;
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
  sourceCwd?: string;
  text: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  nowIso?: string;
  classification?: KeywordInputClassification;
  allowSecondaryTeam?: boolean;
  allowSecondaryAutopilot?: boolean;
  resolvedPromptTurnContext?: ResolvedPromptTurnContext;
  onProvenanceRejected?: (diagnostic: PromptDiagnosticDescriptor) => void | Promise<void>;
}

export interface DeepInterviewModeStatePersistenceInput {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
}

export const DEEP_INTERVIEW_STATE_FILE = 'deep-interview-state.json';
export const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'] as const;
export const DEEP_INTERVIEW_INPUT_LOCK_MESSAGE = 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.';

type StatefulSkillMode = 'deep-interview' | 'autopilot' | 'ralph' | 'ralplan' | 'ultragoal' | 'ultrawork' | 'ultraqa' | 'team' | 'autoresearch';

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
  'ultragoal',
  'ultrawork',
  'ultraqa',
]);

const STATEFUL_SKILL_SEED_CONFIG: Record<StatefulSkillMode, StatefulSkillSeedConfig> = {
  'deep-interview': { mode: 'deep-interview', initialPhase: 'intent-first' },
  autopilot: { mode: 'autopilot', initialPhase: 'deep-interview', includeIteration: true },
  autoresearch: { mode: 'autoresearch', initialPhase: 'executing' },
  ralph: { mode: 'ralph', initialPhase: 'starting', includeIteration: true },
  ralplan: { mode: 'ralplan', initialPhase: 'planning' },
  team: { mode: 'team', initialPhase: 'starting', scope: 'root' },
  ultragoal: { mode: 'ultragoal', initialPhase: 'planning' },
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
  downstream_authority?: DownstreamAuthority;
  bypass_planning_gate_until?: string;
  [key: string]: unknown;
}

function slugifyAutopilotTask(text: string): string {
  const slug = text
    .replace(/(?:^|\s)\$?(?:oh-my-codex:)?autopilot\b/gi, ' ')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'autopilot-task';
}

function utcCompactTimestamp(nowIso: string): string {
  const parsed = new Date(nowIso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Autopilot context timestamp: ${nowIso}`);
  }
  return parsed.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isSafeAutopilotContextSnapshotPath(value: unknown): value is string {
  const path = safeString(value).trim();
  const contextPrefix = '.omx/context/';
  const snapshotName = path.startsWith(contextPrefix) ? path.slice(contextPrefix.length) : '';
  return path.startsWith('.omx/context/')
    && path.endsWith('.md')
    && !isAbsolute(path)
    && !path.split('/').includes('..')
    && !path.includes('\\')
    && snapshotName !== ''
    && !snapshotName.includes('/');
}

function isAutopilotRecoverySnapshotPath(path: string): boolean {
  return path.startsWith('.omx/context/autopilot-recovery-');
}

const MAX_REUSABLE_AUTOPILOT_CONTEXT_SNAPSHOT_BYTES = 1024 * 1024;

async function isReadableAutopilotContextSnapshotPath(sourceCwd: string, value: unknown): Promise<boolean> {
  if (!isSafeAutopilotContextSnapshotPath(value)) return false;
  const contextDir = await ensureSafeAutopilotContextDir(sourceCwd);
  const absolutePath = join(sourceCwd, value);
  try {
    const snapshotStat = await lstat(absolutePath);
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) return false;
    if (snapshotStat.size > MAX_REUSABLE_AUTOPILOT_CONTEXT_SNAPSHOT_BYTES) return false;
    const contextRealPath = await realpath(contextDir);
    const snapshotRealPath = await realpath(absolutePath);
    const relativeToContext = relative(contextRealPath, snapshotRealPath);
    if (relativeToContext === '' || relativeToContext.startsWith('..') || isAbsolute(relativeToContext)) return false;
    await access(absolutePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

type AutopilotContextSnapshotKind = 'canonical' | 'legacy' | 'recovery';

type AutopilotContextRecoveryReason =
  | 'missing-or-unsafe-legacy-context-snapshot'
  | 'missing-autopilot-mode-state'
  | 'malformed-autopilot-mode-state'
  | 'nonpreservable-autopilot-mode-state-missing-current-phase';

interface AutopilotContextSnapshotDescriptor {
  path: string;
  kind: AutopilotContextSnapshotKind;
  recovery?: Record<string, unknown>;
}

interface AutopilotContextSnapshotCandidate {
  value: unknown;
  kind?: AutopilotContextSnapshotKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeAutopilotContextSnapshotCandidate(candidate: AutopilotContextSnapshotCandidate): AutopilotContextSnapshotDescriptor | null {
  if (isRecord(candidate.value)) {
    const path = safeString(candidate.value.path).trim();
    const kind = safeString(candidate.value.kind).trim() as AutopilotContextSnapshotKind;
    if (!path || !['canonical', 'legacy', 'recovery'].includes(kind)) return null;
    if (kind === 'recovery' || isAutopilotRecoverySnapshotPath(path)) return null;
    return { path, kind };
  }

  const path = safeString(candidate.value).trim();
  if (!path) return null;
  if (isAutopilotRecoverySnapshotPath(path)) return null;
  return { path, kind: candidate.kind ?? 'legacy' };
}

async function findReusableAutopilotContextSnapshotPath(
  sourceCwd: string,
  candidates: AutopilotContextSnapshotCandidate[],
): Promise<AutopilotContextSnapshotDescriptor | undefined> {
  for (const candidate of candidates) {
    const normalized = normalizeAutopilotContextSnapshotCandidate(candidate);
    if (!normalized || isAutopilotRecoverySnapshotPath(normalized.path) || !isSafeAutopilotContextSnapshotPath(normalized.path)) continue;
    if (await isReadableAutopilotContextSnapshotPath(sourceCwd, normalized.path)) return normalized;
  }
  return undefined;
}

interface AutopilotContextSnapshotResult {
  path: string;
  kind: AutopilotContextSnapshotKind;
  original_task_status?: 'activation-prompt' | 'legacy-unverified' | 'unavailable';
  recovery?: Record<string, unknown>;
}

const AUTOPILOT_CONTEXT_RECOVERY_REASON_MESSAGES: Record<AutopilotContextRecoveryReason, string> = {
  'missing-or-unsafe-legacy-context-snapshot': 'no safe legacy Autopilot context snapshot path was available during continuation.',
  'missing-autopilot-mode-state': 'active Autopilot skill state existed but no matching Autopilot mode state was available during continuation.',
  'malformed-autopilot-mode-state': 'active Autopilot mode state could not be parsed during continuation.',
  'nonpreservable-autopilot-mode-state-missing-current-phase': 'active Autopilot mode state was missing current_phase during continuation.',
};

async function ensureSafeAutopilotContextDir(sourceCwd: string): Promise<string> {
  const rootRealPath = await realpath(sourceCwd);
  const omxDir = join(sourceCwd, '.omx');
  await mkdir(omxDir, { recursive: true });
  if ((await lstat(omxDir)).isSymbolicLink()) {
    throw new Error('Unsafe Autopilot context directory: .omx is a symbolic link');
  }

  const contextDir = join(omxDir, 'context');
  await mkdir(contextDir, { recursive: true });
  if ((await lstat(contextDir)).isSymbolicLink()) {
    throw new Error('Unsafe Autopilot context directory: .omx/context is a symbolic link');
  }

  const contextRealPath = await realpath(contextDir);
  const relativeToRoot = relative(rootRealPath, contextRealPath);
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error('Unsafe Autopilot context directory: resolved path escapes repository root');
  }
  return contextDir;
}

async function writeUniqueAutopilotContextSnapshot(
  sourceCwd: string,
  slug: string,
  nowIso: string,
  body: string,
): Promise<string> {
  const contextDir = await ensureSafeAutopilotContextDir(sourceCwd);
  const timestamp = utcCompactTimestamp(nowIso);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const filename = `${slug}-${timestamp}${suffix}.md`;
    const relativePath = `.omx/context/${filename}`;
    const absolutePath = resolve(contextDir, filename);
    try {
      await writeFile(absolutePath, body, { encoding: 'utf-8', flag: 'wx' });
      return relativePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`Unable to allocate unique Autopilot context snapshot for ${slug}`);
}

async function ensureAutopilotContextSnapshot(
  sourceCwd: string,
  nowIso: string,
  activationText: string,
  existingSnapshot?: AutopilotContextSnapshotDescriptor,
  options: { allowTaskSnapshotCreation?: boolean; recoveryReason?: AutopilotContextRecoveryReason } = {},
): Promise<AutopilotContextSnapshotResult> {
  if (existingSnapshot) {
    if (isSafeAutopilotContextSnapshotPath(existingSnapshot.path)) {
      return {
        path: existingSnapshot.path,
        kind: existingSnapshot.kind,
        original_task_status: existingSnapshot.kind === 'legacy' ? 'legacy-unverified' : 'activation-prompt',
      };
    }
    throw new Error(`Unsafe Autopilot context snapshot path: ${existingSnapshot.path}`);
  }

  if (options.allowTaskSnapshotCreation === false) {
    const slug = 'autopilot-recovery';
    const continuationInput = activationText.trim() || '<empty>';
    const reason = options.recoveryReason ?? 'missing-or-unsafe-legacy-context-snapshot';
    const body = [
      '# Autopilot context recovery',
      '',
      '- recovery status: degraded',
      `- recovery reason: ${reason}`,
      `- reason detail: ${AUTOPILOT_CONTEXT_RECOVERY_REASON_MESSAGES[reason]}`,
      `- continuation input: ${continuationInput}`,
      '- original task status: unavailable',
      '- original task seed: unavailable; do not treat the continuation input as the task seed.',
      '- required follow-up: re-establish or confirm the intended task context before downstream handoff.',
      '',
    ].join('\n');
    const path = await writeUniqueAutopilotContextSnapshot(sourceCwd, slug, nowIso, body);
    return {
      path,
      kind: 'recovery',
      original_task_status: 'unavailable',
      recovery: {
        status: 'degraded',
        reason,
        recovered_at: nowIso,
        source: 'keyword-detector',
      },
    };
  }

  const slug = slugifyAutopilotTask(activationText);
  const taskSeed = activationText.trim() || '$autopilot';
  const body = [
    `# Autopilot task seed: ${slug}`,
    '',
    `- activation prompt / task seed: ${taskSeed}`,
    '- original task status: activation-prompt',
    '- scope note: this seed captures the Autopilot activation prompt and is not guaranteed to include prior conversation context.',
    '- desired outcome: complete the requested Autopilot workflow correctly with durable gate evidence.',
    '- known facts/evidence: Autopilot was activated from a UserPromptSubmit keyword.',
    '- constraints: follow deep-interview -> ralplan -> ultragoal -> code-review -> ultraqa; do not skip gates without persisted evidence.',
    '- unknowns/open questions: to be resolved by the deep-interview gate.',
    '- likely codebase touchpoints: to be discovered during pre-context intake and planning.',
    '',
  ].join('\n');
  return {
    path: await writeUniqueAutopilotContextSnapshot(sourceCwd, slug, nowIso, body),
    kind: 'canonical',
    original_task_status: 'activation-prompt',
  };
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
  return (await readJsonStateWithStatus(path)).state;
}

async function readJsonStateWithStatus(path: string): Promise<{
  state: Record<string, unknown> | null;
  status: 'ok' | 'missing' | 'malformed';
}> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { state: null, status: 'malformed' };
    return { state: parsed, status: 'ok' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: null, status: 'missing' };
    }
    return { state: null, status: 'malformed' };
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
    const configStateFields = buildDeepInterviewConfigStateFields(nextSkill.deep_interview_config);
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
        owner_codex_session_id: nextSkill.owner_codex_session_id ?? previousModeState?.owner_codex_session_id,
        thread_id: input.threadId ?? previousModeState?.thread_id,
        turn_id: input.turnId ?? previousModeState?.turn_id,
        ...configStateFields,
        ...(nextSkill.input_lock ? { input_lock: nextSkill.input_lock } : {}),
        ...(nextQuestionEnforcement ? { question_enforcement: nextQuestionEnforcement } : {}),
        ...(previousModeState?.downstream_authority ? { downstream_authority: previousModeState.downstream_authority } : {}),
        ...(previousModeState?.bypass_planning_gate_until ? { bypass_planning_gate_until: previousModeState.bypass_planning_gate_until } : {}),
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
    owner_codex_session_id: nextSkill?.owner_codex_session_id ?? previousModeState?.owner_codex_session_id ?? previousSkill?.owner_codex_session_id,
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
    ...(previousModeState?.downstream_authority ? { downstream_authority: previousModeState.downstream_authority } : {}),
    ...(previousModeState?.bypass_planning_gate_until ? { bypass_planning_gate_until: previousModeState.bypass_planning_gate_until } : {}),
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

function isResettableTerminalModeState(state: Record<string, unknown> | null, expectedMode: string): boolean {
  if (!state || safeString(state.mode).trim() !== expectedMode) return false;

  const phase = safeString(state.current_phase).trim().toLowerCase().replace(/_/g, '-');
  const terminalPhases = expectedMode === 'ralph'
    ? ['blocked-on-user', 'complete', 'completed', 'failed', 'cancelled', 'canceled', 'stopped', 'user-stopped']
    : ['complete', 'completed', 'failed', 'cancelled', 'canceled', 'stopped', 'user-stopped'];
  if (terminalPhases.includes(phase)) return true;

  const lifecycleOutcome = inferTerminalLifecycleOutcome(state, { includeQuestionEnforcement: false });
  return lifecycleOutcome === 'finished'
    || lifecycleOutcome === 'failed'
    || lifecycleOutcome === 'userinterlude'
    || (expectedMode === 'ralph' && lifecycleOutcome === 'blocked');
}

async function persistStatefulSkillSeedState(
  stateDir: string,
  nextSkill: SkillActiveState,
  nowIso: string,
  previousSkill: SkillActiveState | null,
  activationText: string,
  sourceCwd: string,
  options: { activeContinuation?: boolean; forceSessionScope?: boolean } = {},
): Promise<SkillActiveState> {
  const config = STATEFUL_SKILL_SEED_CONFIG[nextSkill.skill as StatefulSkillMode];
  if (!config) return nextSkill;

  const { absolutePath, relativePath } = resolveSeedStateFilePath(
    stateDir,
    config.mode,
    nextSkill.session_id,
    options.forceSessionScope ? 'session' : config.scope,
  );
  const existingModeStateResult = await readJsonStateWithStatus(absolutePath);
  const existingModeState = existingModeStateResult.state;
  const sameActiveSkill = previousSkill?.skill === nextSkill.skill && previousSkill.active;
  const existingModeMatches = safeString(existingModeState?.mode).trim() === config.mode;
  const existingPhase = safeString(existingModeState?.current_phase).trim();
  const existingModeTerminal = existingModeMatches
    && isResettableTerminalModeState(existingModeState as Record<string, unknown>, config.mode);
  const preserveExistingModeState = existingModeMatches
    && existingPhase !== ''
    && !existingModeTerminal
    && (
      sameActiveSkill
      || (config.mode === 'team' && existingModeState?.active === true)
    );
  const startedAt = previousSkill?.skill === nextSkill.skill && previousSkill.active && !existingModeTerminal
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
      owner_codex_session_id: nextSkill.owner_codex_session_id || safeString(existingModeState?.owner_codex_session_id).trim() || undefined,
      thread_id: nextSkill.thread_id || safeString(existingModeState?.thread_id).trim() || undefined,
      turn_id: nextSkill.turn_id || safeString(existingModeState?.turn_id).trim() || undefined,
    },
    { nowIso },
  );

  if (config.includeIteration) {
    const defaultIteration = config.mode === 'autopilot' ? 1 : 0;
    const defaultMaxIterations = config.mode === 'autopilot' ? 10 : 50;
    const reusableModeState = preserveExistingModeState ? existingModeState : null;
    baseState.iteration = typeof reusableModeState?.iteration === 'number' ? reusableModeState.iteration : defaultIteration;
    baseState.max_iterations = typeof reusableModeState?.max_iterations === 'number' ? reusableModeState.max_iterations : defaultMaxIterations;
  }

  if (config.mode === 'deep-interview') {
    Object.assign(baseState, buildDeepInterviewConfigStateFields(nextSkill.deep_interview_config));
  }

  if (config.mode === 'autopilot') {
    const reusableModeState = preserveExistingModeState ? existingModeState : null;
    const existingStateRaw = (reusableModeState?.state && typeof reusableModeState.state === 'object')
      ? reusableModeState.state as Record<string, unknown>
      : {};
    const {
      context_snapshot_path: legacyStateContextSnapshotPath,
      context_snapshot_recovery: _legacyContextSnapshotRecovery,
      ...existingState
    } = existingStateRaw;
    const existingHandoffs = (existingState.handoff_artifacts && typeof existingState.handoff_artifacts === 'object')
      ? existingState.handoff_artifacts as Record<string, unknown>
      : {};
    let recoveryReason: AutopilotContextRecoveryReason = 'missing-or-unsafe-legacy-context-snapshot';
    if (options.activeContinuation === true && !preserveExistingModeState) {
      if (existingModeStateResult.status === 'missing') {
        recoveryReason = 'missing-autopilot-mode-state';
      } else if (existingModeStateResult.status === 'malformed') {
        recoveryReason = 'malformed-autopilot-mode-state';
      } else if (existingModeMatches && existingPhase === '') {
        recoveryReason = 'nonpreservable-autopilot-mode-state-missing-current-phase';
      }
    }
    const existingContextSnapshotPath = await findReusableAutopilotContextSnapshotPath(sourceCwd, [
      { value: existingHandoffs.context_snapshot },
      { value: existingHandoffs.context_snapshot_path, kind: 'legacy' },
      { value: legacyStateContextSnapshotPath, kind: 'legacy' },
      { value: reusableModeState?.context_snapshot_path, kind: 'legacy' },
    ]);
    const contextSnapshot = await ensureAutopilotContextSnapshot(
      sourceCwd,
      nowIso,
      activationText || safeString(nextSkill.keyword) || '$autopilot',
      existingContextSnapshotPath,
      {
        allowTaskSnapshotCreation: !(preserveExistingModeState || options.activeContinuation === true),
        recoveryReason,
      },
    );
    const contextSnapshotPath = contextSnapshot.path;
    baseState.review_cycle = typeof reusableModeState?.review_cycle === 'number' ? reusableModeState.review_cycle : 0;
    delete baseState.context_snapshot_path;
    baseState.state = {
      ...existingState,
      phase_cycle: Array.isArray(existingState.phase_cycle) ? existingState.phase_cycle : ['deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa'],
      handoff_artifacts: {
        deep_interview: null,
        ralplan: null,
        ralplan_consensus_gate: {
          required: true,
          sequence: ['architect-review', 'critic-review'],
          planning_artifacts_are_not_consensus: true,
          required_review_roles: ['architect', 'critic'],
          ralplan_architect_review: null,
          ralplan_critic_review: null,
          complete: false,
        },
        ultragoal: null,
        code_review: null,
        ultraqa: null,
        ...existingHandoffs,
        context_snapshot_path: contextSnapshotPath,
        context_snapshot: {
          path: contextSnapshotPath,
          kind: contextSnapshot.kind,
          ...(contextSnapshot.original_task_status ? { original_task_status: contextSnapshot.original_task_status } : {}),
          ...(contextSnapshot.recovery ? { recovery: contextSnapshot.recovery } : {}),
        },
      },
      review_verdict: Object.prototype.hasOwnProperty.call(existingState, 'review_verdict')
        ? existingState.review_verdict
        : null,
      qa_verdict: Object.prototype.hasOwnProperty.call(existingState, 'qa_verdict')
        ? existingState.qa_verdict
        : null,
      return_to_ralplan_reason: Object.prototype.hasOwnProperty.call(existingState, 'return_to_ralplan_reason')
        ? existingState.return_to_ralplan_reason
        : null,
      ...(contextSnapshot.recovery ? { context_snapshot_recovery: contextSnapshot.recovery } : {}),
      deep_interview_gate: (existingState.deep_interview_gate && typeof existingState.deep_interview_gate === 'object')
        ? existingState.deep_interview_gate
        : {
            status: 'required',
            skip_reason: null,
            rationale: 'Autopilot starts at the deep-interview gate by default; clear bounded tasks may skip only with an explicit persisted skip reason.',
          },
      planning_routing: existingState.planning_routing && typeof existingState.planning_routing === 'object'
        ? existingState.planning_routing
        : resolveAutopilotPlannerRouting(process.env.CODEX_HOME),
    };
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

const KEYWORD_MAP: Array<{ keyword: string; pattern: RegExp; skill: string; priority: number }> = KEYWORD_TRIGGER_DEFINITIONS.map((entry) => ({
  keyword: entry.keyword,
  pattern: keywordToPattern(entry.keyword),
  skill: entry.skill,
  priority: entry.priority,
}));

const KEYWORDS_REQUIRING_INTENT = new Set(['ralph', 'team', 'stop', 'abort', 'parallel', 'autoresearch', 'ultragoal', 'autopilot']);

type IntentKeyword = 'ralph' | 'team' | 'stop' | 'abort' | 'parallel' | 'autoresearch' | 'ultragoal' | 'autopilot';

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
 * "team" requires explicit orchestration phrasing so a generic
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
  stop: [
    /^(?:please\s+)?stop(?:\s+now)?\s*[.!]?\s*$/i,
    /\bcancelomx\b/i,
    /(?:^|[^\w])\$(?:stop|cancel|abort)\b/i,
    /(?:^|\s)\/(?:cancel|stop|abort)(?=[\s,!?;]|$)/i,
    /\bstop\s+(?:the\s+)?(?:agent|ralph|autopilot|team|ultrawork|execution|current\s+(?:mode|task|run))\b/i,
    /\b(?:cancel|stop)\s+(?:the\s+)?(?:active|running|current)\s+(?:mode|task|run|execution)\b/i,
  ],
  abort: [
    /^(?:please\s+)?abort(?:\s+now)?\s*[.!]?\s*$/i,
    /\bcancelomx\b/i,
    /(?:^|[^\w])\$(?:stop|cancel|abort)\b/i,
    /(?:^|\s)\/(?:cancel|stop|abort)(?=[\s,!?;]|$)/i,
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
  ultragoal: [
    /(?:^|[^\w])\$(?:ultragoal)\b/i,
    /^\s*\/ultragoal\b/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|resume|continue)\s+(?:the\s+)?ultragoal\b/i,
    /\bultragoal\s+(?:mode|workflow|skill|loop|plan|goals?)\b/i,
  ],
  autopilot: [
    /(?:^|[^\w])\$(?:autopilot)\b/i,
    /^\s*\/autopilot\b/i,
    /^\s*(?:please\s+)?autopilot(?:\s+(?:this|mode|workflow|skill|loop|now))?\s*[.!]?\s*$/i,
    /\b(?:use|run|start|enable|launch|invoke|activate|resume|continue)\s+(?:the\s+)?autopilot(?:\s+(?:mode|workflow|skill|loop|now))?\s*[.!]?\s*$/i,
    /\bautopilot\s+(?:mode|workflow|skill|loop)\b/i,
  ],
};

const EXPLICIT_TOKEN_START = /\$(?:(?:[Oo][Hh]-[Mm][Yy]-[Cc][Oo][Dd][Ee][Xx]):)?([A-Za-z][A-Za-z0-9_-]*)/gyu;
const TOKEN_CONTINUATION = /[\p{L}\p{N}\p{M}\p{Pc}\p{Pd}]/u;
const SAFE_TOKEN_WHITESPACE = /[\p{Zs}\t\n\r\f\v\u2028\u2029]/u;
const EXPLICIT_TOKEN_BOUNDARY_PUNCTUATION = /[,;؛!?:؟)\]}"'”’»›」』—–…。、،]/u;
const DIRECTIVE_PUNCTUATION = /[,;؛:!?؟？、،]/u;
const CLAUSE_BOUNDARY_PUNCTUATION = /[,;؛.!?؟？。！？：،、\r\n\u2013\u2014\u2028\u2029]/u;
const LOGICAL_SENTENCE_BOUNDARY_PUNCTUATION = /[;؛.!?؟？。！？]/u;
function asciiCaseWordPattern(word: string): string {
  return [...word].map((character) => `[${character.toUpperCase()}${character.toLowerCase()}]`).join('');
}
const ASCII_DIRECTIVE_VERB = `(?:${['use', 'run', 'start', 'enable', 'launch', 'invoke', 'activate', 'resume', 'continue'].map(asciiCaseWordPattern).join('|')})`;
const ASCII_PLEASE = asciiCaseWordPattern('please');
const ASCII_INSTEAD = asciiCaseWordPattern('instead');
const ASCII_AND = asciiCaseWordPattern('and');
const ASCII_BUT = asciiCaseWordPattern('but');
const ASCII_THEN = asciiCaseWordPattern('then');
const ASCII_NOW = asciiCaseWordPattern('now');
const ASCII_THE = asciiCaseWordPattern('the');
const ASCII_WITH = asciiCaseWordPattern('with');
const ASCII_JUMP = asciiCaseWordPattern('jump');
const ASCII_STRAIGHT = asciiCaseWordPattern('straight');
const ASCII_TO = asciiCaseWordPattern('to');
const ASCII_ADVANCE = asciiCaseWordPattern('advance');
const ASCII_DIRECTIVE_COMMAND = `(?:${asciiCaseWordPattern('continue')}\\s+${ASCII_WITH}|${ASCII_JUMP}\\s+${ASCII_STRAIGHT}\\s+${ASCII_TO}|${ASCII_ADVANCE}\\s+${ASCII_TO}|${ASCII_DIRECTIVE_VERB})`;
const DIRECTIVE_COMMAND_PREFIX_SOURCE = `(?:(?:${ASCII_PLEASE}\\s+)?(?:(?:${ASCII_INSTEAD}|${ASCII_THEN}|${ASCII_NOW})\\s+)?${ASCII_DIRECTIVE_COMMAND}\\s+|(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}|${ASCII_THEN}|${ASCII_NOW}|${ASCII_PLEASE})\\s+|(?:${ASCII_AND}|${ASCII_BUT})\\s+(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}\\s+)?${ASCII_DIRECTIVE_COMMAND}\\s+)(?:${ASCII_THE}\\s+)?`;
const DIRECTIVE_COMMAND_PREFIX_AT = new RegExp(DIRECTIVE_COMMAND_PREFIX_SOURCE, 'yu');

const EXCLUSION_PREFIX = `(?:${['ignore', 'discard', 'skip', 'omit', 'forget', 'disregard', 'except'].map(asciiCaseWordPattern).join('|')}|${asciiCaseWordPattern('exclude')}(?:${asciiCaseWordPattern('ing')})?)`;
const ASCII_NEGATIVE_PREFIX = `(?:${asciiCaseWordPattern('do')}\\s+${asciiCaseWordPattern('not')}|${asciiCaseWordPattern('don')}'${asciiCaseWordPattern('t')}|${asciiCaseWordPattern('without')}|${asciiCaseWordPattern('never')}|${asciiCaseWordPattern('not')}|${asciiCaseWordPattern('no')}|${asciiCaseWordPattern('neither')}|${asciiCaseWordPattern('nor')}|${asciiCaseWordPattern('avoid')}(?:${asciiCaseWordPattern('ing')})?|${asciiCaseWordPattern('cannot')}|${asciiCaseWordPattern('can')}'${asciiCaseWordPattern('t')}|${EXCLUSION_PREFIX})`;
const NEGATIVE_PREFIX_PATTERN = new RegExp(`(?:${ASCII_NEGATIVE_PREFIX}|[Нн][Ее]\\s+(?:[Зз]апускай|[Ии]спользуй)|実行しないで|使わないで)`, 'u');
const LIST_DOCUMENTATION_SUFFIX = /^(?:\s*(?::|：|[—–])\s*\S|\s+(?:is|are|means|refer(?:s)?\s+to|denote(?:s)?)\b.*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b)/i;
const EXPLICIT_DOCUMENTATION_SUFFIX_SOURCE = String.raw`\s+(?:(?:is|are|means|refer(?:s)?\s+to|denote(?:s)?)\b.*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b|(?:is|are)\s+(?:(?:also|still)\s+)?(?:(?:its|an?|the)\s+)?alias(?:es)?\b|(?:is|are)\s+(?:(?:also|still)\s+)?(?:documented|described)\b|(?:appears?|occurs?|is\s+(?:also\s+)?mentioned)\b.*\b(?:docs?|documentation|examples?|references?|guide|manual)\b)`;
const EXPLICIT_DOCUMENTATION_SUFFIX_AT = new RegExp(EXPLICIT_DOCUMENTATION_SUFFIX_SOURCE, 'iyu');
const IMPLICIT_WORKFLOW_NOUN = '(?:modes?|workflows?|skills?|loops?)';
const POSTPOSED_NEGATIVE_PREDICATE = /\s+(?:(?:is|are|was|were|should|must|can|could|may|will|would)\s+(?:(?:also|still)\s+)?(?:not|never)\b|(?:isn't|aren't|wasn't|weren't|cannot|can't|shouldn't|mustn't|won't|wouldn't|couldn't)\b|(?:is|are|was|were)\s+(?:(?:also|still)\s+)?(?:inert|prohibited|forbidden|disabled|disallowed|unsupported)\b|(?:should|must|can|could|may|will|would)\s+(?:(?:also|still)\s+)?(?:not\s+)?be\s+(?:inert|avoided|prohibited|forbidden|disabled|disallowed|unsupported)\b|(?:is|are|was|were)\s+(?:(?:also|still)\s+)?to\s+be\s+(?:inert|avoided|prohibited|forbidden|disabled|disallowed|unsupported)\b)/iu;
const PROMPTS_TOKEN_PATTERN = /\/[Pp][Rr][Oo][Mm][Pp][Tt][Ss]:[\w.-]+/gu;
const COORDINATED_WORKFLOW_SUBJECT = '(?:(?:the|a|an)\\s+)?(?:autopilot|deep(?:[- ]+)interview|ralph|ralplan|ultrawork|ulw|ultragoal|ultraqa|autoresearch|coordinated\\s+team|team|consensus\\s+plan|code\\s+review|wiki|prometheus(?:-strict)?)';
const COORDINATED_SUBJECT_JOINER = '(?:and|or|nor|as\\s+well\\s+as|along\\s+with|together\\s+with|&)';
const EXPLICIT_POSTPOSED_SUBJECT = '\\$(?:oh-my-codex:)?[A-Za-z][A-Za-z0-9_-]*';
const COORDINATED_POSTPOSED_SEPARATOR_SOURCE = `\\s*(?:(?:[,，،、]|/)\\s*(?:${COORDINATED_SUBJECT_JOINER}\\s+)?|${COORDINATED_SUBJECT_JOINER}\\s+)`;
const COORDINATED_EXPLICIT_POSTPOSED_SEPARATOR = new RegExp(COORDINATED_POSTPOSED_SEPARATOR_SOURCE, 'iyu');
const COORDINATED_EXPLICIT_POSTPOSED_SUBJECT = new RegExp(
  `(?:(?:the|a|an)\\s+)?(?:${EXPLICIT_POSTPOSED_SUBJECT}|${COORDINATED_WORKFLOW_SUBJECT})`,
  'iyu',
);
const COORDINATED_IMPLICIT_DOCUMENTATION_SUBJECT = new RegExp(
  `${COORDINATED_WORKFLOW_SUBJECT}(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?`,
  'iyu',
);
const COORDINATED_SUBJECT_QUANTIFIER = new RegExp(asciiCaseWordPattern('both'), 'yu');
const POSTPOSED_SUBJECT_NOUN = new RegExp(`\\s+${IMPLICIT_WORKFLOW_NOUN}`, 'iyu');
const IMPLICIT_POSTPOSED_SUBJECT_CHAIN = new RegExp(
  `^\\s*(?:${asciiCaseWordPattern('both')}\\s+)?${COORDINATED_WORKFLOW_SUBJECT}(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?(?:${COORDINATED_POSTPOSED_SEPARATOR_SOURCE}${COORDINATED_WORKFLOW_SUBJECT}(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?)*\\s*[,，،、]?\\s*$`,
  'iu',
);
const IMPLICIT_DOCUMENTATION_SUBJECT_PATTERN = new RegExp(
  `^\\s*${COORDINATED_WORKFLOW_SUBJECT}(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?(?:\\s+(?:(?:is|are|means|refer(?:s)?\\s+to|denote(?:s)?)\\b.*\\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\\b|(?:is|are)\\s+(?:(?:documented|described)\\b|(?:(?:also|still)\\s+)?(?:(?:its|an?|the)\\s+)?alias(?:es)?\\b)|(?:appears?|occurs?|is\\s+(?:also\\s+)?mentioned)\\b.*\\b(?:docs?|documentation|examples?|references?|guide|manual)\\b)|\\s*(?::|：|[—–-]|\\/)\\s*\\S.*\\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\\b)[.!?]?`,
  'iu',
);
const DOCUMENTATION_LEADING_PATTERN = new RegExp(
  `^\\s*(?:(?:the|a|an)\\s+)?(?:docs?|documentation|examples?|references?|guide|manual)\\b.*\\b(?:mention(?:s|ed|ing)?|document(?:s|ed|ing)?|describ(?:e|es|ed|ing)|explain(?:s|ed|ing)|refer(?:s|red|ring)?\\s+to)\\b.*\\b${COORDINATED_WORKFLOW_SUBJECT}(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?\\b`,
  'iu',
);

function hasImplicitDocumentationSubjectPrefix(text: string): boolean {
  return IMPLICIT_DOCUMENTATION_SUBJECT_PATTERN.test(text);
}

function normalizeGrammarApostrophes(text: string): string {
  return text.replace(/[’＇]/gu, "'");
}

function latestPositiveContrastStart(text: string): number {
  const pattern = new RegExp(`${ASCII_BUT}\\s+(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}\\s+)?(?=${ASCII_DIRECTIVE_COMMAND})`, 'gu');
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (hasUnicodeGrammarTokenStart(text, match.index)) start = match.index;
  }
  return start;
}

function hasAsciiDirectiveCommand(text: string): boolean {
  const scanner = new RegExp(ASCII_DIRECTIVE_COMMAND, 'gu');
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (hasUnicodeGrammarTokenBoundaries(text, match.index, scanner.lastIndex)) return true;
  }
  return false;
}

function isDiscourseNegation(text: string, start: number, end: number): boolean {
  const suffix = text.slice(end);
  if (/^\s+worries\s*[,，،、]/iu.test(suffix)) return true;
  return /(?:^|\s)i'm\s+$/iu.test(text.slice(0, start))
    && /^\s+sure\s*[,，،、]/iu.test(suffix);
}

function hasUnicodeBoundedNegativePrefix(text: string): boolean {
  const scanner = new RegExp(NEGATIVE_PREFIX_PATTERN.source, 'gu');
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (hasUnicodeGrammarTokenBoundaries(text, match.index, scanner.lastIndex)
      && !isDiscourseNegation(text, match.index, scanner.lastIndex)) return true;
  }
  return false;
}


function isNegativePrefixExemptImplicitKeyword(keyword: string): boolean {
  const normalized = keyword.toLowerCase();
  return normalized === "don't stop" || normalized === "don't assume";
}


function normalizedPunctuation(character: string): string {
  return character.normalize('NFKC');
}

function isDirectivePunctuation(character: string): boolean {
  return DIRECTIVE_PUNCTUATION.test(normalizedPunctuation(character));
}

function isClauseBoundaryAt(text: string, index: number): boolean {
  const character = codePointAt(text, index);
  const normalized = normalizedPunctuation(character);
  if (!CLAUSE_BOUNDARY_PUNCTUATION.test(normalized)) return false;
  if (normalized !== '.') return true;
  const next = codePointAt(text, index + character.length);
  return !next || SAFE_TOKEN_WHITESPACE.test(next) || /["'”’»›」』）)\]}]/u.test(next);
}

function isLogicalSentenceBoundaryAt(text: string, index: number): boolean {
  const character = codePointAt(text, index);
  const normalized = normalizedPunctuation(character);
  return LOGICAL_SENTENCE_BOUNDARY_PUNCTUATION.test(normalized) && isClauseBoundaryAt(text, index);
}

function documentationSuffixLimit(text: string, start: number, limit: number): number {
  for (let cursor = start; cursor < limit;) {
    if (isStrongDocumentationClauseSeparatorAt(text, cursor)) return cursor;
    cursor += codePointAt(text, cursor).length;
  }
  return limit;
}

function hasExplicitDocumentationSuffixAt(text: string, start: number, limit: number): boolean {
  const clauseLimit = documentationSuffixLimit(text, start, limit);
  EXPLICIT_DOCUMENTATION_SUFFIX_AT.lastIndex = 0;
  return EXPLICIT_DOCUMENTATION_SUFFIX_AT.exec(text.slice(start, clauseLimit)) !== null;
}

function isAbbreviationDotAt(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 8), index + 1);
  return /(?:^|[^A-Za-z0-9_])(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|sr|jr|st|no|fig|ver|v)\.$/i.test(context);
}

function hasLogicalSentenceBoundary(text: string): boolean {
  for (let cursor = 0; cursor < text.length;) {
    const character = codePointAt(text, cursor);
    if (character === '\r' || character === '\n' || character === '\u2028' || character === '\u2029') return true;
    if (isLogicalSentenceBoundaryAt(text, cursor)) {
      if (normalizedPunctuation(character) !== '.' || !isAbbreviationDotAt(text, cursor)) return true;
    }
    cursor += character.length;
  }
  return false;
}

function codePointAt(text: string, index: number): string {
  const value = text.codePointAt(index);
  return value === undefined ? '' : String.fromCodePoint(value);
}
function codePointBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const trailing = text.charCodeAt(index - 1);
  if (trailing >= 0xDC00 && trailing <= 0xDFFF && index >= 2) {
    const leading = text.charCodeAt(index - 2);
    if (leading >= 0xD800 && leading <= 0xDBFF) return text.slice(index - 2, index);
  }
  return text[index - 1] ?? '';
}

function hasUnicodeGrammarTokenStart(text: string, start: number): boolean {
  const previous = codePointBefore(text, start);
  return !previous || !TOKEN_CONTINUATION.test(previous);
}

/** ASCII grammar words cannot begin or end inside a Unicode identifier-like token. */
function hasUnicodeGrammarTokenBoundaries(text: string, start: number, end: number): boolean {
  const next = codePointAt(text, end);
  return hasUnicodeGrammarTokenStart(text, start)
    && (!next || !TOKEN_CONTINUATION.test(next));
}

function firstGrammarTokenStart(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && SAFE_TOKEN_WHITESPACE.test(codePointAt(text, cursor))) cursor += codePointAt(text, cursor).length;
  return cursor;
}

function hasAsciiGrammarTokenCharacters(text: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end;) {
    const character = codePointAt(text, cursor);
    if (TOKEN_CONTINUATION.test(character) && !/^[A-Za-z0-9_-]$/u.test(character)) return false;
    cursor += character.length;
  }
  return true;
}

function isExplicitTokenBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const character = codePointAt(text, index);
  if (SAFE_TOKEN_WHITESPACE.test(character)) return true;
  const compatibility = character.normalize('NFKC');
  if (compatibility === '.') {
    const next = codePointAt(text, index + character.length);
    return !next || SAFE_TOKEN_WHITESPACE.test(next) || next === '$';
  }
  if (character === "'" || character === '’' || compatibility === "'") {
    const next = codePointAt(text, index + character.length);
    return !next || !TOKEN_CONTINUATION.test(next);
  }
  if ([...compatibility].length === 1 && EXPLICIT_TOKEN_BOUNDARY_PUNCTUATION.test(compatibility)) return true;
  return EXPLICIT_TOKEN_BOUNDARY_PUNCTUATION.test(character);
}

function maximalExplicitTokenEnd(text: string, initialEnd: number): number {
  let cursor = initialEnd;
  while (cursor < text.length && !isExplicitTokenBoundary(text, cursor)) {
    cursor += codePointAt(text, cursor).length;
  }
  return cursor;
}

/**
 * Korean 2-set keyboard typo aliases for workflow keywords.
 *
 * Keep this intentionally narrow: only the `ulw` ultrawork shorthand is
 * normalized so users who forget to switch IMEs get the same activation path
 * as the canonical keyword without introducing broad transliteration surprises.
 */
function normalizeWorkflowKeyboardTypos(text: string): string {
  return text.replace(/\$ㅕㅣㅈ(?=로)/g, '$ulw ').replace(/ㅕㅣㅈ/g, 'ulw');
}


type StructuralInertDiagnostic = Exclude<KeywordInertDiagnostic, 'escaped' | 'not-leading-region'>;

const STRUCTURAL_INERT_DIAGNOSTICS: readonly StructuralInertDiagnostic[] = [
  'fenced-code',
  'indented-code',
  'blockquote',
  'inline-code',
  'quote',
];

const QUOTE_CLOSERS: Readonly<Record<string, string>> = Object.freeze({
  '“': '”',
  '‘': '’',
  '„': '“',
  '‚': '‘',
  '«': '»',
  '‹': '›',
  '「': '」',
  '『': '』',
});
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

interface ExplicitCandidateScan {
  rawKeyword: string;
  normalizedToken: string;
  skill: string | null;
  priority: number | null;
  start: number;
  end: number;
  reasons: Set<KeywordInertDiagnostic>;
}

interface InertRange {
  start: number;
  end: number;
  reason: StructuralInertDiagnostic;
  bounded: boolean;
}

interface InertRangeIndex {
  starts: number[];
  maximumEnds: number[];
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
  blockquoteDepth: number;
  listItem: boolean;
  indent: number;
  closingEligible: boolean;
}

function lineEnd(text: string, start: number): number {
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '\r' || character === '\n' || character === '\u2028' || character === '\u2029') return cursor;
  }
  return text.length;
}

function nextLineStart(text: string, end: number): number {
  return text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;
}

function advanceSpaces(text: string, start: number, maximum: number): number {
  let cursor = start;
  while (cursor - start < maximum && text[cursor] === ' ') cursor += 1;
  return cursor;
}

interface MarkdownContainerPrefix {
  cursor: number;
  blockquoteDepth: number;
  listDepth: number;
}

function markdownContainerPrefix(line: string, maximumLeadingSpaces = 3): MarkdownContainerPrefix {
  let cursor = advanceSpaces(line, 0, maximumLeadingSpaces);
  let blockquoteDepth = 0;
  let listDepth = 0;
  while (cursor < line.length) {
    if (line[cursor] === '>') {
      blockquoteDepth += 1;
      cursor += 1;
      if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
      cursor = advanceSpaces(line, cursor, 3);
      continue;
    }
    const listMarker = /^(?:(?:[-*+])|(?:\d{1,9}[.)]))[\t ]+/u.exec(line.slice(cursor));
    if (!listMarker) break;
    listDepth += 1;
    cursor += listMarker[0].length;
    cursor = advanceSpaces(line, cursor, 3);
  }
  return { cursor, blockquoteDepth, listDepth };
}

function markdownFenceAtStart(line: string, maximumLeadingSpaces = 3): MarkdownFence | null {
  const container = markdownContainerPrefix(line, maximumLeadingSpaces);
  let cursor = container.cursor;

  const marker = line[cursor];
  if (marker !== '`' && marker !== '~') return null;
  const start = cursor;
  while (line[cursor] === marker) cursor += 1;
  const length = cursor - start;
  return length >= 3
    ? { marker, length, blockquoteDepth: container.blockquoteDepth, listItem: container.listDepth > 0, indent: start, closingEligible: /^[\t ]*$/.test(line.slice(cursor)) }
    : null;
}

function isBlockquoteLine(line: string): boolean {
  return markdownContainerPrefix(line).blockquoteDepth > 0;
}

function hasMarkdownCodeIndent(line: string): boolean {
  let columns = 0;
  for (const character of line) {
    if (character === ' ') columns += 1;
    else if (character === '\t') columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

function hasListContainedCodeIndent(line: string): boolean {
  const leading = /^[ \t]{0,3}/u.exec(line)?.[0] ?? '';
  let cursor = leading.length;
  let column = 0;
  for (const character of leading) column += character === '\t' ? 4 - (column % 4) : 1;

  while (cursor < line.length) {
    const marker = /^(?:[-+*]|\d{1,9}[.)])/u.exec(line.slice(cursor));
    if (!marker) return false;
    for (const character of marker[0]) column += character === '\t' ? 4 - (column % 4) : 1;
    cursor += marker[0].length;

    const gap = /^[ \t]+/u.exec(line.slice(cursor))?.[0];
    if (!gap) return false;
    const markerEndColumn = column;
    for (const character of gap) column += character === '\t' ? 4 - (column % 4) : 1;
    cursor += gap.length;
    if (column - markerEndColumn > 4) return true;
  }
  return false;
}

function collectIndentedCodeRanges(text: string): InertRange[] {
  const ranges: InertRange[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const end = lineEnd(text, lineStart);
    const line = text.slice(lineStart, end);
    if (hasMarkdownCodeIndent(line) || hasListContainedCodeIndent(line)) {
      ranges.push({ start: lineStart, end, reason: 'indented-code', bounded: true });
    }
    if (end === text.length) break;
    lineStart = nextLineStart(text, end);
  }
  return ranges;
}

function collectFencedCodeRanges(text: string): InertRange[] {
  const ranges: InertRange[] = [];
  let lineStart = 0;
  let fence: { definition: MarkdownFence; start: number } | null = null;

  while (lineStart <= text.length) {
    const end = lineEnd(text, lineStart);
    const line = text.slice(lineStart, end);
    if (fence) {
      const closer = markdownFenceAtStart(line, fence.definition.listItem ? fence.definition.indent + 3 : 3);
      if (
        closer?.marker === fence.definition.marker
        && closer.length >= fence.definition.length
        && closer.blockquoteDepth === fence.definition.blockquoteDepth
        && !closer.listItem
        && (!fence.definition.listItem || closer.indent >= fence.definition.indent)
        && closer.closingEligible
      ) {
        ranges.push({ start: fence.start, end, reason: 'fenced-code', bounded: true });
        fence = null;
      } else if (fence.definition.listItem) {
        const rootFence = markdownFenceAtStart(line);
        if (rootFence && rootFence.indent < fence.definition.indent) {
          ranges.push({ start: fence.start, end: lineStart, reason: 'fenced-code', bounded: true });
          fence = { definition: rootFence, start: lineStart };
        }
      }
    } else {
      const opener = markdownFenceAtStart(line);
      if (opener) fence = { definition: opener, start: lineStart };
    }
    if (end === text.length) break;
    lineStart = nextLineStart(text, end);
  }

  if (fence) ranges.push({ start: fence.start, end: text.length, reason: 'fenced-code', bounded: false });
  return ranges;
}

function collectInlineCodeRanges(text: string): InertRange[] {
  const ranges: InertRange[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const end = lineEnd(text, lineStart);
    let cursor = lineStart;
    let opener: { start: number; length: number } | null = null;
    while (cursor < end) {
      if (text[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let runEnd = cursor + 1;
      while (runEnd < end && text[runEnd] === '`') runEnd += 1;
      const length = runEnd - cursor;
      if (!opener) opener = { start: cursor, length };
      else if (opener.length === length) {
        ranges.push({ start: opener.start, end: runEnd, reason: 'inline-code', bounded: true });
        opener = null;
      }
      cursor = runEnd;
    }
    if (opener) ranges.push({ start: opener.start, end, reason: 'inline-code', bounded: false });
    if (end === text.length) break;
    lineStart = nextLineStart(text, end);
  }
  return ranges;
}

function collectQuoteRanges(text: string): InertRange[] {
  const ranges: InertRange[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const end = lineEnd(text, lineStart);
    let opener: { start: number; closing: string } | null = null;
    for (let cursor = lineStart; cursor < end; cursor += 1) {
      const character = text[cursor];
      const previous = text[cursor - 1] ?? '';
      const next = text[cursor + 1] ?? '';
      if ((character === "'" || character === '’' || character === '＇') && LETTER_OR_NUMBER.test(previous) && LETTER_OR_NUMBER.test(next)) continue;
      if (!opener && (character === "'" || character === '’' || character === '＇') && /[sS]/u.test(previous) && (!next || SAFE_TOKEN_WHITESPACE.test(next) || /[.,;:!?)}\]”’»›」』]/u.test(next))) continue;
      if (hasOddImmediateBackslashes(text, cursor)) continue;

      if (opener && character === opener.closing) {
        ranges.push({ start: opener.start, end: cursor + 1, reason: 'quote', bounded: true });
        opener = null;
        continue;
      }
      if (!opener && (character === '"' || character === "'" || character === '＂' || character === '＇')) {
        opener = { start: cursor, closing: character };
        continue;
      }
      if (!opener && QUOTE_CLOSERS[character]) opener = { start: cursor, closing: QUOTE_CLOSERS[character] };
    }
    if (opener) ranges.push({ start: opener.start, end, reason: 'quote', bounded: false });
    if (end === text.length) break;
    lineStart = nextLineStart(text, end);
  }
  return ranges;
}

function collectBlockquoteRanges(text: string): InertRange[] {
  const ranges: InertRange[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const end = lineEnd(text, lineStart);
    if (isBlockquoteLine(text.slice(lineStart, end))) {
      ranges.push({ start: lineStart, end, reason: 'blockquote', bounded: true });
    }
    if (end === text.length) break;
    lineStart = nextLineStart(text, end);
  }
  return ranges;
}

function createInertRangeIndex(ranges: Array<{ start: number; end: number }>): InertRangeIndex {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const starts = new Array<number>(ranges.length);
  const maximumEnds = new Array<number>(ranges.length);
  let maximumEnd = -1;
  for (const [index, range] of ranges.entries()) {
    starts[index] = range.start;
    maximumEnd = Math.max(maximumEnd, range.end);
    maximumEnds[index] = maximumEnd;
  }
  return { starts, maximumEnds };
}

function collectInertRangeIndexes(text: string): Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>> {
  return {
    'indented-code': createInertRangeIndex(collectIndentedCodeRanges(text)),
    'fenced-code': createInertRangeIndex(collectFencedCodeRanges(text)),
    blockquote: createInertRangeIndex(collectBlockquoteRanges(text)),
    'inline-code': createInertRangeIndex(collectInlineCodeRanges(text)),
    quote: createInertRangeIndex(collectQuoteRanges(text)),
  };
}

function inertRangeEndAt(index: InertRangeIndex, position: number): number | null {
  let lower = 0;
  let upper = index.starts.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (index.starts[middle] <= position) lower = middle + 1;
    else upper = middle;
  }
  if (lower === 0) return null;
  const end = index.maximumEnds[lower - 1];
  return end > position ? end : null;
}

function isInInertRange(index: InertRangeIndex, position: number): boolean {
  return inertRangeEndAt(index, position) !== null;
}

function isStructurallyInert(
  indexes: Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>>,
  position: number,
): boolean {
  return STRUCTURAL_INERT_DIAGNOSTICS.some((reason) => isInInertRange(indexes[reason], position));
}

function structuralInertRangeEnd(
  indexes: Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>>,
  position: number,
): number | null {
  let end = -1;
  for (const reason of STRUCTURAL_INERT_DIAGNOSTICS) end = Math.max(end, inertRangeEndAt(indexes[reason], position) ?? -1);
  return end >= 0 ? end : null;
}

function lineStartForPosition(text: string, position: number): number {
  for (let cursor = position - 1; cursor >= 0; cursor -= 1) {
    const character = text[cursor];
    if (character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029') return cursor + 1;
  }
  return 0;
}

function leadingDirectiveCursor(text: string, regionStart: number, allowLineBreaks: boolean): { cursor: number; listItem: boolean } {
  const whitespacePattern = allowLineBreaks ? /^\s*/u : /^[^\S\r\n\u2028\u2029]*/u;
  const cursor = regionStart + (whitespacePattern.exec(text.slice(regionStart))?.[0].length ?? 0);
  const container = markdownContainerPrefix(text.slice(cursor, lineEnd(text, cursor)));
  if (container.blockquoteDepth > 0) return { cursor, listItem: false };
  return { cursor: cursor + container.cursor, listItem: container.listDepth > 0 };
}

function directiveCommandTargetStart(text: string, cursor: number, limit = text.length): number | null {
  DIRECTIVE_COMMAND_PREFIX_AT.lastIndex = cursor;
  const prefix = DIRECTIVE_COMMAND_PREFIX_AT.exec(text);
  const targetStart = prefix?.index === cursor ? cursor + prefix[0].length : null;
  return targetStart !== null && targetStart <= limit ? targetStart : null;
}


function promptLeadingExplicitCandidateStart(text: string): number {
  const leading = leadingDirectiveCursor(text, 0, true);
  if (text[leading.cursor] === '$') return leading.cursor;
  const commandTarget = directiveCommandTargetStart(text, leading.cursor);
  return commandTarget !== null && text[commandTarget] === '$' ? commandTarget : leading.cursor;
}


function punctuationSeparatedCandidateStart(text: string, cursor: number): number | null {
  let next = boundedHorizontalCursor(text, cursor, text.length);
  if (text[next] === '$') return next;
  const punctuationStart = next;
  while (next < text.length) {
    const character = codePointAt(text, next);
    if (!isDirectivePunctuation(character)) break;
    next += character.length;
  }
  if (next === punctuationStart) return null;
  next = boundedHorizontalCursor(text, next, text.length);
  return text[next] === '$' ? next : null;
}

function coordinatedDocumentationCandidateStart(text: string, cursor: number): number | null {
  const scanner = /(?:[^\S\r\n\u2028\u2029]+(?:[Aa][Nn][Dd]|[Oo][Rr])\s+|[^\S\r\n\u2028\u2029]*[,，،、]\s*(?:[Aa][Nn][Dd]|[Oo][Rr])\s+|[^\S\r\n\u2028\u2029]*\/[^\S\r\n\u2028\u2029]*)/uy;
  scanner.lastIndex = cursor;
  const separator = scanner.exec(text);
  if (!separator) return null;
  const next = cursor + separator[0].length;
  return text[next] === '$' ? next : null;
}

function clauseDirectiveStart(text: string, predecessorEnd: number, candidateStart: number): boolean {
  if (predecessorEnd > candidateStart) return false;
  let clauseStart = predecessorEnd;
  for (let cursor = predecessorEnd; cursor < candidateStart;) {
    const character = codePointAt(text, cursor);
    if (isClauseBoundaryAt(text, cursor) || normalizedPunctuation(character) === ':') clauseStart = cursor + character.length;
    cursor += character.length;
  }
  const directiveStart = boundedHorizontalCursor(text, clauseStart, candidateStart);
  return hasAdjacentPredecessorSeparator(text, predecessorEnd, directiveStart)
    && directiveCommandTargetStart(text, directiveStart, candidateStart) === candidateStart;
}

function hasAdjacentPredecessorSeparator(text: string, predecessorEnd: number, candidateStart: number): boolean {
  if (predecessorEnd > candidateStart) return false;
  for (let cursor = predecessorEnd; cursor < candidateStart;) {
    const character = codePointAt(text, cursor);
    if (!SAFE_TOKEN_WHITESPACE.test(character)
      && !isClauseBoundaryAt(text, cursor)
      && normalizedPunctuation(character) !== ':'
      && !/[—–-]/u.test(character)) return false;
    cursor += character.length;
  }
  return true;
}

interface PostposedExplicitNegationIndex {
  ends: ReadonlyMap<number, number>;
  prefixNegatedStarts: ReadonlySet<number>;
  implicitBlocks: InertRangeIndex;
}

interface ExplicitPrefixNegationIndex {
  negatedStarts: ReadonlySet<number>;
  postposedSubjectStarts: ReadonlyMap<number, number>;
  firstPostposedSubjectCandidates: ReadonlySet<number>;
}

interface MatchPosition {
  start: number;
  end: number;
}

function isPostposedSubjectBoundaryAt(text: string, index: number): boolean {
  if (!isClauseBoundaryAt(text, index)) return false;
  return !/[,،、]/u.test(normalizedPunctuation(codePointAt(text, index)));
}

function collectLineMatchPositions(
  pattern: RegExp,
  text: string,
  start: number,
  end: number,
  requireEndBoundary = true,
): MatchPosition[] {
  const matches: MatchPosition[] = [];
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && match.index < end) {
    if (pattern.lastIndex <= end
      && hasUnicodeGrammarTokenStart(text, match.index)
      && (!requireEndBoundary || hasUnicodeGrammarTokenBoundaries(text, match.index, pattern.lastIndex))) {
      matches.push({ start: match.index, end: pattern.lastIndex });
    }
  }
  return matches;
}

function hasExclusionPrefixAt(text: string, start: number): boolean {
  const pattern = new RegExp(`\\s*(?:${ASCII_PLEASE}\\s+)?${EXCLUSION_PREFIX}`, 'yu');
  pattern.lastIndex = start;
  const match = pattern.exec(text);
  return match?.index === start && hasUnicodeGrammarTokenBoundaries(text, start, pattern.lastIndex);
}



function collectExplicitPrefixNegationIndex(text: string, candidates: readonly ExplicitCandidateScan[]): ExplicitPrefixNegationIndex {
  const negatedStarts = new Set<number>();
  const postposedSubjectStarts = new Map<number, number>();
  const firstPostposedSubjectCandidates = new Set<number>();
  const normalizedText = normalizeGrammarApostrophes(text);
  const negativeScanner = new RegExp(NEGATIVE_PREFIX_PATTERN.source, 'gu');
  const contrastScanner = new RegExp(`${ASCII_BUT}\\s+(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}\\s+)?(?=${ASCII_DIRECTIVE_COMMAND})`, 'gu');
  const directiveScanner = new RegExp(`(?:${ASCII_AND}|${ASCII_THEN})\\s+(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}\\s+)?(?=${ASCII_DIRECTIVE_COMMAND})`, 'gu');
  let firstCandidateIndex = 0;

  while (firstCandidateIndex < candidates.length) {
    const lineStart = lineStartForPosition(text, candidates[firstCandidateIndex].start);
    const lineLimit = lineEnd(text, candidates[firstCandidateIndex].end);
    let afterLineCandidateIndex = firstCandidateIndex;
    while (afterLineCandidateIndex < candidates.length && candidates[afterLineCandidateIndex].start < lineLimit) afterLineCandidateIndex += 1;

    const negativeMatches = collectLineMatchPositions(negativeScanner, normalizedText, lineStart, lineLimit);
    const contrastMatches = collectLineMatchPositions(contrastScanner, text, lineStart, lineLimit, false);
    const directiveMatches = collectLineMatchPositions(directiveScanner, text, lineStart, lineLimit, false);
    let negativeMatchIndex = 0;
    let contrastMatchIndex = 0;
    let directiveMatchIndex = 0;
    let latestNegativeStart = -1;
    let latestContrastStart = -1;
    let latestCoordinatedDirectiveStart = -1;
    let latestPunctuationDirectiveStart = -1;
    let cursor = lineStart;
    let clauseStart = lineStart;
    let punctuationStart = lineStart;
    let postposedSubjectStart = lineStart;
    let hasPostposedSubjectCandidate = false;

    for (let candidateIndex = firstCandidateIndex; candidateIndex < afterLineCandidateIndex; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      while (cursor < candidate.start) {
        const character = codePointAt(text, cursor);
        if (isLogicalSentenceBoundaryAt(text, cursor)) clauseStart = cursor + character.length;
        if (isClauseBoundaryAt(text, cursor)) punctuationStart = cursor + character.length;
        if (isPostposedSubjectBoundaryAt(text, cursor)) {
          postposedSubjectStart = cursor + character.length;
          hasPostposedSubjectCandidate = false;
        }
        cursor += character.length;
      }
      while (negativeMatchIndex < negativeMatches.length && negativeMatches[negativeMatchIndex].end <= candidate.start) {
        latestNegativeStart = negativeMatches[negativeMatchIndex].start;
        negativeMatchIndex += 1;
      }
      while (contrastMatchIndex < contrastMatches.length && contrastMatches[contrastMatchIndex].end <= candidate.start) {
        latestContrastStart = contrastMatches[contrastMatchIndex].start;
        contrastMatchIndex += 1;
      }
      while (directiveMatchIndex < directiveMatches.length && directiveMatches[directiveMatchIndex].end <= candidate.start) {
        latestCoordinatedDirectiveStart = directiveMatches[directiveMatchIndex].start;
        directiveMatchIndex += 1;
      }

      const punctuationDirectiveStart = boundedHorizontalCursor(text, punctuationStart, candidate.start);
      if (directiveCommandTargetStart(text, punctuationDirectiveStart, candidate.start) === candidate.start) {
        latestPunctuationDirectiveStart = Math.max(latestPunctuationDirectiveStart, punctuationDirectiveStart);
      }

      let effectiveClauseStart = clauseStart;
      if (latestContrastStart >= effectiveClauseStart) effectiveClauseStart = latestContrastStart;
      if (latestPunctuationDirectiveStart >= effectiveClauseStart && latestPunctuationDirectiveStart > latestNegativeStart) {
        effectiveClauseStart = latestPunctuationDirectiveStart;
      }
      if (latestCoordinatedDirectiveStart >= effectiveClauseStart && hasExclusionPrefixAt(text, effectiveClauseStart)) {
        effectiveClauseStart = latestCoordinatedDirectiveStart;
      }
      if (latestNegativeStart >= effectiveClauseStart) negatedStarts.add(candidate.start);
      postposedSubjectStarts.set(candidate.start, postposedSubjectStart);
      if (!hasPostposedSubjectCandidate) firstPostposedSubjectCandidates.add(candidate.start);
      hasPostposedSubjectCandidate = true;
    }

    firstCandidateIndex = afterLineCandidateIndex;
  }

  return { negatedStarts, postposedSubjectStarts, firstPostposedSubjectCandidates };
}

function directivePrefixAfter(text: string, start: number, limit: number): { start: number; targetStart: number } | null {
  let cursor = boundedHorizontalCursor(text, start, limit);
  const transitionStart = cursor;
  if (cursor >= limit) return null;
  if (isClauseBoundaryAt(text, cursor)) {
    cursor += codePointAt(text, cursor).length;
    cursor = boundedHorizontalCursor(text, cursor, limit);
  } else {
    const coordinator = new RegExp(`(?:${ASCII_AND}|${ASCII_BUT}|${ASCII_INSTEAD}|${ASCII_THEN}|${ASCII_NOW})`, 'yu');
    coordinator.lastIndex = cursor;
    const match = coordinator.exec(text);
    if (match?.index !== cursor || !hasUnicodeGrammarTokenBoundaries(text, cursor, coordinator.lastIndex)) return null;
  }
  const targetStart = directiveCommandTargetStart(text, cursor, limit);
  return targetStart === null ? null : { start: transitionStart, targetStart };
}

function isExclusionPrefixDirectiveTransitionAt(
  text: string,
  prefixStart: number,
  transitionStart: number,
  limit: number,
): boolean {
  if (!hasExclusionPrefixAt(text, prefixStart)) return false;
  const punctuationTransition = isClauseBoundaryAt(text, transitionStart);
  let coordinatedTransition = false;
  if (!punctuationTransition) {
    const coordinator = new RegExp(`(?:${ASCII_AND}|${ASCII_THEN})`, 'yu');
    coordinator.lastIndex = transitionStart;
    const match = coordinator.exec(text);
    coordinatedTransition = match?.index === transitionStart
      && hasUnicodeGrammarTokenBoundaries(text, transitionStart, coordinator.lastIndex);
  }
  if (!punctuationTransition && !coordinatedTransition) return false;

  const directive = directivePrefixAfter(text, transitionStart, limit);
  if (directive?.start !== transitionStart) return false;
  return !punctuationTransition || clauseDirectiveStart(text, transitionStart, directive.targetStart);
}

function exclusionPrefixDirectiveTransitionStart(
  text: string,
  prefixStart: number,
  start: number,
  limit: number,
): number | null {
  if (!hasExclusionPrefixAt(text, prefixStart)) return null;
  for (let cursor = start; cursor < limit;) {
    if (isExclusionPrefixDirectiveTransitionAt(text, prefixStart, cursor, limit)) return cursor;
    cursor += codePointAt(text, cursor).length;
  }
  return null;
}

function documentationDirectiveTransitionStart(text: string, start: number, limit: number): number | null {
  const scanner = new RegExp(`(?:${ASCII_AND}|${ASCII_BUT}|${ASCII_THEN}|${ASCII_INSTEAD}|${ASCII_NOW})`, 'gu');
  scanner.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null && match.index < limit) {
    if (scanner.lastIndex <= limit
      && hasUnicodeGrammarTokenBoundaries(text, match.index, scanner.lastIndex)
      && directiveCommandTargetStart(text, match.index, limit) !== null) return match.index;
  }
  return null;
}

function postposedNegationClauseEnd(text: string, start: number, limit: number): number {
  for (let cursor = start; cursor < limit;) {
    if (isClauseBoundaryAt(text, cursor)) return cursor;
    cursor += codePointAt(text, cursor).length;
  }
  return limit;
}

function stickyMatchEnd(pattern: RegExp, text: string, start: number, limit: number): number | null {
  pattern.lastIndex = start;
  const match = pattern.exec(text);
  return match && match.index === start && pattern.lastIndex <= limit ? pattern.lastIndex : null;
}
interface DocumentationSubjectChain {
  start: number;
  explicitIndexes: number[];
  end: number;
}

function coordinatedSubjectAt(
  text: string,
  start: number,
  limit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
): { end: number; explicitIndex?: number } | null {
  const articlePrefix = /(?:the|a|an)/iyu;
  articlePrefix.lastIndex = start;
  const article = articlePrefix.exec(text);
  const articleSubjectStart = article?.index === start
    ? boundedHorizontalCursor(text, articlePrefix.lastIndex, limit)
    : start;
  const candidateStart = article?.index === start
    && articlePrefix.lastIndex <= limit
    && articleSubjectStart > articlePrefix.lastIndex
    && hasUnicodeGrammarTokenBoundaries(text, start, articlePrefix.lastIndex)
    ? articleSubjectStart
    : start;
  const explicitIndex = candidateIndexByStart.get(candidateStart);
  if (explicitIndex !== undefined && candidates[explicitIndex].reasons.size === 0) {
    return { end: candidates[explicitIndex].end, explicitIndex };
  }
  const implicitEnd = stickyMatchEnd(COORDINATED_IMPLICIT_DOCUMENTATION_SUBJECT, text, start, limit);
  return implicitEnd === null ? null : { end: implicitEnd };
}

function collectMixedSubjectChain(
  text: string,
  start: number,
  limit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
): DocumentationSubjectChain | null {
  const chainStart = boundedHorizontalCursor(text, start, limit);
  let cursor = chainStart;
  const quantifierEnd = stickyMatchEnd(COORDINATED_SUBJECT_QUANTIFIER, text, cursor, limit);
  const quantifiedSubjectStart = quantifierEnd === null ? cursor : boundedHorizontalCursor(text, quantifierEnd, limit);
  if (quantifierEnd !== null
    && quantifiedSubjectStart > quantifierEnd
    && hasUnicodeGrammarTokenBoundaries(text, cursor, quantifierEnd)) cursor = quantifiedSubjectStart;
  const firstSubject = coordinatedSubjectAt(text, cursor, limit, candidates, candidateIndexByStart);
  if (!firstSubject) return null;

  const explicitIndexes = firstSubject.explicitIndex === undefined ? [] : [firstSubject.explicitIndex];
  cursor = firstSubject.end;
  while (cursor < limit) {
    const separatorEnd = stickyMatchEnd(COORDINATED_EXPLICIT_POSTPOSED_SEPARATOR, text, cursor, limit);
    if (separatorEnd === null) break;
    const subject = coordinatedSubjectAt(text, separatorEnd, limit, candidates, candidateIndexByStart);
    if (!subject) break;
    if (subject.explicitIndex !== undefined) explicitIndexes.push(subject.explicitIndex);
    cursor = subject.end;
  }
  return { start: chainStart, explicitIndexes, end: cursor };
}

function hasCoordinatedExplicitPostposedTail(text: string, start: number, end: number): boolean {
  let cursor = stickyMatchEnd(POSTPOSED_SUBJECT_NOUN, text, start, end) ?? start;
  while (cursor < end) {
    const trailingStart = boundedHorizontalCursor(text, cursor, end);
    if (trailingStart === end) return true;
    if (/[,，،、]/u.test(text[trailingStart] ?? '')
      && boundedHorizontalCursor(text, trailingStart + 1, end) === end) return true;

    const separatorEnd = stickyMatchEnd(COORDINATED_EXPLICIT_POSTPOSED_SEPARATOR, text, cursor, end);
    if (separatorEnd === null) return false;
    const subjectEnd = stickyMatchEnd(COORDINATED_EXPLICIT_POSTPOSED_SUBJECT, text, separatorEnd, end);
    if (subjectEnd === null) return false;
    cursor = stickyMatchEnd(POSTPOSED_SUBJECT_NOUN, text, subjectEnd, end) ?? subjectEnd;
  }
  return true;
}

function coordinatedPostposedSubjectGroupStartIndex(
  text: string,
  candidates: readonly ExplicitCandidateScan[],
  firstIndex: number,
  lastIndex: number,
): number {
  let groupStartIndex = lastIndex;
  while (
    groupStartIndex > firstIndex
    && hasCoordinatedExplicitPostposedTail(text, candidates[groupStartIndex - 1].end, candidates[groupStartIndex].end)
  ) {
    groupStartIndex -= 1;
  }
  return groupStartIndex;
}

function mixedImplicitPostposedSubjectStart(
  text: string,
  candidate: ExplicitCandidateScan,
  prefixNegations: ExplicitPrefixNegationIndex,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
  predicateStart: number,
): number {
  if (!prefixNegations.firstPostposedSubjectCandidates.has(candidate.start)) return candidate.start;
  const candidateIndex = candidateIndexByStart.get(candidate.start);
  const start = prefixNegations.postposedSubjectStarts.get(candidate.start) ?? candidate.start;
  const chain = collectMixedSubjectChain(text, start, predicateStart, candidates, candidateIndexByStart);
  return chain
    && candidateIndex !== undefined
    && chain.explicitIndexes.includes(candidateIndex)
    && boundedHorizontalCursor(text, chain.end, predicateStart) === predicateStart
    ? chain.start
    : candidate.start;
}

function collectPostposedExplicitNegationIndex(text: string, candidates: readonly ExplicitCandidateScan[]): PostposedExplicitNegationIndex {
  const ends = new Map<number, number>();
  const implicitBlocks: InertPromptRange[] = [];
  const prefixNegations = collectExplicitPrefixNegationIndex(text, candidates);
  const candidateIndexByStart = new Map<number, number>();
  for (const [index, candidate] of candidates.entries()) candidateIndexByStart.set(candidate.start, index);
  let firstCandidateIndex = 0;

  while (firstCandidateIndex < candidates.length) {
    const start = lineStartForPosition(text, candidates[firstCandidateIndex].start);
    const end = lineEnd(text, candidates[firstCandidateIndex].end);
    let afterLineCandidateIndex = firstCandidateIndex;
    while (afterLineCandidateIndex < candidates.length && candidates[afterLineCandidateIndex].start < end) afterLineCandidateIndex += 1;

    const predicateScanner = new RegExp(POSTPOSED_NEGATIVE_PREDICATE.source, 'giu');
    const normalizedLine = normalizeGrammarApostrophes(text.slice(start, end));
    let predicate: RegExpExecArray | null;
    let lastCandidateIndex = firstCandidateIndex - 1;
    const groupStartIndexesByEndpoint = new Map<number, number>();
    let lastEvaluatedCandidateIndex = -1;

    while ((predicate = predicateScanner.exec(normalizedLine)) !== null) {
      const predicateTokenStart = firstGrammarTokenStart(normalizedLine, predicate.index, predicateScanner.lastIndex);
      if (!hasUnicodeGrammarTokenBoundaries(normalizedLine, predicateTokenStart, predicateScanner.lastIndex)
        || !hasAsciiGrammarTokenCharacters(normalizedLine, predicateTokenStart, predicateScanner.lastIndex)) continue;
      const predicateStart = start + predicate.index;
      while (lastCandidateIndex + 1 < afterLineCandidateIndex && candidates[lastCandidateIndex + 1].end <= predicateStart) {
        lastCandidateIndex += 1;
      }
      if (lastCandidateIndex < firstCandidateIndex) continue;
      if (lastCandidateIndex === lastEvaluatedCandidateIndex) continue;
      lastEvaluatedCandidateIndex = lastCandidateIndex;

      const groupEndpoint = candidates[lastCandidateIndex].end;
      let groupStartIndex = groupStartIndexesByEndpoint.get(groupEndpoint);
      if (groupStartIndex === undefined) {
        groupStartIndex = coordinatedPostposedSubjectGroupStartIndex(
          text,
          candidates,
          firstCandidateIndex,
          lastCandidateIndex,
        );
        groupStartIndexesByEndpoint.set(groupEndpoint, groupStartIndex);
      }

      if (!hasCoordinatedExplicitPostposedTail(text, candidates[groupStartIndex].end, predicateStart)) continue;

      const predicateEnd = start + predicateScanner.lastIndex;
      const positiveTransition = directivePrefixAfter(text, predicateEnd, end);
      const negationEnd = positiveTransition?.start ?? postposedNegationClauseEnd(text, predicateEnd, end);
      for (let index = groupStartIndex; index <= lastCandidateIndex; index += 1) ends.set(candidates[index].start, negationEnd);
      const subjectStart = mixedImplicitPostposedSubjectStart(
        text,
        candidates[groupStartIndex],
        prefixNegations,
        candidates,
        candidateIndexByStart,
        predicateStart,
      );
      implicitBlocks.push({
        start: subjectStart,
        end: positiveTransition?.start ?? postposedNegationClauseEnd(text, predicateEnd, end),
      });
    }

    firstCandidateIndex = afterLineCandidateIndex;
  }

  return {
    ends,
    prefixNegatedStarts: prefixNegations.negatedStarts,
    implicitBlocks: createInertRangeIndex(implicitBlocks),
  };
}

function postposedExplicitNegationEnd(index: PostposedExplicitNegationIndex, candidate: ExplicitCandidateScan): number | null {
  return index.ends.get(candidate.start) ?? null;
}

function hasPostposedExplicitNegation(index: PostposedExplicitNegationIndex, candidate: ExplicitCandidateScan): boolean {
  return postposedExplicitNegationEnd(index, candidate) !== null;
}

function isNegativeExplicitMention(candidate: ExplicitCandidateScan, postposedNegations: PostposedExplicitNegationIndex): boolean {
  return hasPostposedExplicitNegation(postposedNegations, candidate)
    || postposedNegations.prefixNegatedStarts.has(candidate.start);
}

function isInertOrNegativeMention(candidate: ExplicitCandidateScan, postposedNegations: PostposedExplicitNegationIndex): boolean {
  return [...candidate.reasons].some((reason) => reason !== 'not-leading-region') || isNegativeExplicitMention(candidate, postposedNegations);
}

interface ListDocumentationTokenRange {
  start: number;
  end: number;
}

function listItemDocumentationTokenRange(text: string, candidateStart: number, blockEnd: number): ListDocumentationTokenRange | null {
  const lineStart = lineStartForPosition(text, candidateStart);
  const leading = leadingDirectiveCursor(text, lineStart, false);
  if (!leading.listItem) return null;
  const end = lineEnd(text, blockEnd);
  const directiveTarget = directiveCommandTargetStart(text, leading.cursor);
  const tokenStart = directiveTarget !== null && directiveTarget < end && text[directiveTarget] === '$'
    ? directiveTarget
    : leading.cursor;
  const tokenSequence = /^(?:(?:\$(?:oh-my-codex:)?[A-Za-z][A-Za-z0-9_-]*)|(?:\/prompts:[\w.-]+))(?:(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+|\s*\/\s*)(?:(?:\$(?:oh-my-codex:)?[A-Za-z][A-Za-z0-9_-]*)|(?:\/prompts:[\w.-]+)))*/iu.exec(text.slice(tokenStart, end));
  if (!tokenSequence || !LIST_DOCUMENTATION_SUFFIX.test(text.slice(tokenStart + tokenSequence[0].length, end))) return null;
  return { start: tokenStart, end: tokenStart + tokenSequence[0].length };
}

function isListItemDocumentation(text: string, candidateStart: number, blockEnd: number): boolean {
  return listItemDocumentationTokenRange(text, candidateStart, blockEnd) !== null;
}


function hasActivePromptsTokenBoundary(text: string, start: number, end: number): boolean {
  if (hasOddImmediateBackslashes(text, start)) return false;
  const previous = codePointBefore(text, start);
  const validPrevious = !previous || SAFE_TOKEN_WHITESPACE.test(previous) || /[(\[{]/u.test(previous);
  return validPrevious && isExplicitTokenBoundary(text, end);
}

function isMarkdownTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|');
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function collectMarkdownTableRanges(text: string): InertPromptRange[] {
  const ranges: InertPromptRange[] = [];
  let start = 0;
  while (start < text.length) {
    const headerEnd = lineEnd(text, start);
    const delimiterStart = headerEnd < text.length ? nextLineStart(text, headerEnd) : text.length;
    const delimiterEnd = delimiterStart < text.length ? lineEnd(text, delimiterStart) : text.length;
    if (text.slice(start, headerEnd).includes('|') && isMarkdownTableDelimiter(text.slice(delimiterStart, delimiterEnd))) {
      let tableEnd = delimiterEnd;
      let rowStart = delimiterEnd < text.length ? nextLineStart(text, delimiterEnd) : text.length;
      while (rowStart < text.length) {
        const rowEnd = lineEnd(text, rowStart);
        if (!text.slice(rowStart, rowEnd).includes('|')) break;
        tableEnd = rowEnd;
        rowStart = rowEnd < text.length ? nextLineStart(text, rowEnd) : text.length;
      }
      ranges.push({ start, end: tableEnd });
      if (tableEnd === text.length) break;
      start = nextLineStart(text, tableEnd);
      continue;
    }
    if (headerEnd === text.length) break;
    start = nextLineStart(text, headerEnd);
  }
  return ranges;
}

interface MarkdownReferenceIndex {
  labels: ReadonlySet<string>;
  destinationRanges: InertRangeIndex;
  tableRanges: InertRangeIndex;
  tablePredecessorRanges: readonly InertPromptRange[];
  predecessorRanges: readonly InertPromptRange[];
}

function normalizeMarkdownReferenceLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/gu, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

function markdownLabelClosingIndex(text: string, start: number, limit: number): number {
  for (let cursor = start; cursor < limit; cursor += 1) {
    if (text[cursor] === ']' && !hasOddImmediateBackslashes(text, cursor)) return cursor;
  }
  return -1;
}

function referenceDestinationEnd(text: string, start: number, end: number): number | null {
  if (/["'(`]/u.test(text[start] ?? '')) return null;
  const destination = /^(?:<[^>\r\n]*>|\S+)/u.exec(text.slice(start, end));
  return destination ? start + destination[0].length : null;
}

function referenceTitleStartAfterDestination(text: string, start: number, end: number): number | null {
  const destinationEnd = referenceDestinationEnd(text, start, end);
  if (destinationEnd === null) return null;
  const titlePrefix = /^[ \t]+(["'(])/u.exec(text.slice(destinationEnd, end));
  return titlePrefix ? destinationEnd + titlePrefix[0].length - 1 : null;
}

function referenceTitleRange(text: string, start: number): InertPromptRange {
  const opening = text[start];
  const closing = opening === '(' ? ')' : opening;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === closing && !hasOddImmediateBackslashes(text, cursor)) {
      return { start, end: cursor + 1 };
    }
  }
  return { start, end: text.length };
}

function collectMarkdownReferenceIndex(text: string): MarkdownReferenceIndex {
  const labels = new Set<string>();
  const destinationRanges: InertPromptRange[] = [];
  const predecessorRanges: InertPromptRange[] = [];
  const codeIndex = createInertRangeIndex([...collectFencedCodeRanges(text), ...collectIndentedCodeRanges(text)]);
  const tablePredecessorRanges = collectMarkdownTableRanges(text);
  const tableRanges = createInertRangeIndex([...tablePredecessorRanges]);
  let titleMaskEnd = -1;
  let start = 0;
  while (start <= text.length) {
    if (start < titleMaskEnd) {
      const maskedLineEnd = lineEnd(text, start);
      if (maskedLineEnd === text.length) break;
      start = nextLineStart(text, maskedLineEnd);
      continue;
    }
    const end = lineEnd(text, start);
    const line = text.slice(start, end);
    const containerPrefix = /^[ \t]{0,3}(?:(?:>[ \t]{0,4})|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))*/u.exec(line)?.[0] ?? '';
    const labelStart = start + containerPrefix.length;
    if (!isInInertRange(codeIndex, labelStart) && text[labelStart] === '[') {
      const closing = markdownLabelClosingIndex(text, labelStart + 1, end);
      if (closing > labelStart) {
        const colon = /^\s*:\s*/u.exec(text.slice(closing + 1, end));
        if (colon) {
          const inlineDestinationStart = closing + 1 + colon[0].length;
          let destinationStart = inlineDestinationStart;
          let destinationLineEnd = end;
          let destinationEnd = destinationStart < end && !isInInertRange(codeIndex, destinationStart)
            ? referenceDestinationEnd(text, destinationStart, destinationLineEnd)
            : null;
          if (destinationEnd === null && inlineDestinationStart === end && end < text.length) {
            const continuationStart = nextLineStart(text, end);
            destinationLineEnd = lineEnd(text, continuationStart);
            const indentation = /^[ \t]{0,3}/u.exec(text.slice(continuationStart, destinationLineEnd))?.[0].length ?? 0;
            destinationStart = continuationStart + indentation;
            destinationEnd = destinationStart < destinationLineEnd && !isInInertRange(codeIndex, destinationStart)
              ? referenceDestinationEnd(text, destinationStart, destinationLineEnd)
              : null;
          }
          if (destinationEnd !== null) {
            const destinationRange = { start: destinationStart, end: destinationEnd };
            destinationRanges.push(destinationRange);
            predecessorRanges.push(destinationRange);
            let titleStart = referenceTitleStartAfterDestination(text, destinationStart, destinationLineEnd);
            if (titleStart === null && destinationLineEnd < text.length) {
              const titleLineStart = nextLineStart(text, destinationLineEnd);
              const titleLineEnd = lineEnd(text, titleLineStart);
              const titleIndent = /^[ \t]{0,3}/u.exec(text.slice(titleLineStart, titleLineEnd));
              const candidateStart = titleLineStart + (titleIndent?.[0].length ?? 0);
              if (titleIndent && /["'(]/u.test(text[candidateStart] ?? '')) titleStart = candidateStart;
            }
            if (titleStart !== null) {
              const titleRange = referenceTitleRange(text, titleStart);
              destinationRanges.push(titleRange);
              if (text[titleRange.end - 1] === (text[titleStart] === '(' ? ')' : text[titleStart])) predecessorRanges.push(titleRange);
              titleMaskEnd = Math.max(titleMaskEnd, titleRange.end);
            }
            labels.add(normalizeMarkdownReferenceLabel(text.slice(labelStart + 1, closing)));
          }
        }
      }
    }
    if (end === text.length) break;
    start = nextLineStart(text, end);
  }
  return {
    labels,
    destinationRanges: createInertRangeIndex(destinationRanges),
    tableRanges,
    tablePredecessorRanges,
    predecessorRanges,
  };
}

function hasMarkdownReferenceDefinition(index: MarkdownReferenceIndex, label: string): boolean {
  return index.labels.has(normalizeMarkdownReferenceLabel(label));
}

function balancedMarkdownLinkRange(text: string, labelStart: number, destinationStart: number, lineLimit: number): InertPromptRange | null {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let cursor = destinationStart + 2; cursor < lineLimit; cursor += 1) {
    if (hasOddImmediateBackslashes(text, cursor)) continue;
    const character = text[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if ((character === '"' || character === "'") && /\s/u.test(text[cursor - 1] ?? '')) {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return { start: labelStart, end: cursor + 1 };
    }
  }
  return null;
}

function enclosingMarkdownLinkRange(text: string, start: number, end: number): InertPromptRange | null {
  const lineStart = lineStartForPosition(text, start);
  const lineLimit = lineEnd(text, end);
  const destinationStart = text.lastIndexOf('](', start);
  if (destinationStart < lineStart) return null;
  const labelStart = text.lastIndexOf('[', destinationStart);
  if (labelStart < lineStart) return null;
  const range = balancedMarkdownLinkRange(text, labelStart, destinationStart, lineLimit);
  return range && start >= destinationStart + 2 && end <= range.end ? range : null;
}

function markdownDocumentationRange(text: string, start: number, end: number, referenceIndex: MarkdownReferenceIndex): InertPromptRange | null {
  const lineStart = lineStartForPosition(text, start);
  const lineLimit = lineEnd(text, end);
  const line = text.slice(lineStart, lineLimit);
  const tableEnd = inertRangeEndAt(referenceIndex.tableRanges, start);
  if (tableEnd !== null) return { start: lineStart, end: tableEnd };
  if (/^(?:#{1,6}\s|\|)/u.test(line.trimStart())) return { start: lineStart, end: lineLimit };
  const enclosingLink = enclosingMarkdownLinkRange(text, start, end);
  if (enclosingLink) return enclosingLink;

  const labelStart = text.lastIndexOf('[', start);
  if (labelStart >= lineStart) {
    const inlineLabelEnd = text.indexOf('](', end);
    if (inlineLabelEnd >= end && inlineLabelEnd < lineLimit) {
      return balancedMarkdownLinkRange(text, labelStart, inlineLabelEnd, lineLimit)
        ?? { start: labelStart, end: inlineLabelEnd + 2 };
    }
    const referenceLabelEnd = text.indexOf('][', end);
    if (referenceLabelEnd >= end && referenceLabelEnd < lineLimit) {
      const closingBracket = text.indexOf(']', referenceLabelEnd + 2);
      return closingBracket >= 0 && closingBracket < lineLimit
        ? { start: labelStart, end: closingBracket + 1 }
        : { start: labelStart, end: referenceLabelEnd + 2 };
    }
    const closingLabel = markdownLabelClosingIndex(text, end, lineLimit);
    if (closingLabel >= end && closingLabel < lineLimit) {
      const beforeLabel = text.slice(lineStart, labelStart);
      const afterLabel = text.slice(closingLabel + 1, lineLimit);
      if (!beforeLabel.trim() && (/^\s*:\s*\S/u.test(afterLabel) || !afterLabel.trim())) {
        return { start: lineStart, end: lineLimit };
      }
      const label = text.slice(labelStart + 1, closingLabel);
      if (hasMarkdownReferenceDefinition(referenceIndex, label)) return { start: labelStart, end: closingLabel + 1 };
    }
  }

  if (lineLimit < text.length) {
    const followingStart = nextLineStart(text, lineLimit);
    const followingEnd = lineEnd(text, followingStart);
    const followingLine = text.slice(followingStart, followingEnd);
    if (/^\s*(?:={3,}|-{3,})\s*$/u.test(followingLine) || (line.includes('|') && isMarkdownTableDelimiter(followingLine))) {
      return { start: lineStart, end: followingEnd };
    }
  }
  return null;
}

function isMarkdownDocumentationMention(text: string, start: number, end: number, referenceIndex: MarkdownReferenceIndex): boolean {
  return markdownDocumentationRange(text, start, end, referenceIndex) !== null;
}

function isInactivePromptsMention(
  text: string,
  start: number,
  end: number,
  inertRangeIndexes: Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>>,
  referenceIndex: MarkdownReferenceIndex,
): boolean {
  return !hasActivePromptsTokenBoundary(text, start, end)
    || isMarkdownDocumentationMention(text, start, end, referenceIndex)
    || isStructurallyInert(inertRangeIndexes, start)
    || isInInertRange(referenceIndex.destinationRanges, start)
    || isListItemDocumentation(text, start, end);
}

function hasDirectPromptsInvocation(
  text: string,
  inertRangeIndexes: Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>>,
  referenceIndex: MarkdownReferenceIndex,
): boolean {
  const leading = leadingDirectiveCursor(text, 0, true);
  if (isStructurallyInert(inertRangeIndexes, leading.cursor)) return false;
  const pattern = new RegExp(PROMPTS_TOKEN_PATTERN.source, PROMPTS_TOKEN_PATTERN.flags);
  pattern.lastIndex = leading.cursor;
  const match = pattern.exec(text);
  if (!match || match.index !== leading.cursor) return false;
  const matchEnd = match.index + match[0].length;
  if (!hasActivePromptsTokenBoundary(text, match.index, matchEnd)) return false;
  return (!leading.listItem || !isListItemDocumentation(text, leading.cursor, matchEnd))
    && !isMarkdownDocumentationMention(text, match.index, matchEnd, referenceIndex);
}

interface InertPromptRange {
  start: number;
  end: number;
}

function boundedPredecessorRanges(text: string, referenceIndex: MarkdownReferenceIndex): InertPromptRange[] {
  const inertRangeIndexes = collectInertRangeIndexes(text);
  const structuralRanges = [
    ...collectIndentedCodeRanges(text),
    ...collectFencedCodeRanges(text),
    ...collectBlockquoteRanges(text),
    ...collectInlineCodeRanges(text),
    ...collectQuoteRanges(text),
  ];
  const unboundedStructuralRanges = structuralRanges.filter((range) => !range.bounded);
  const unboundedStructuralIndex = createInertRangeIndex(unboundedStructuralRanges);
  const isOutsideUnboundedStructuralParent = (range: InertPromptRange): boolean => {
    const parentEnd = inertRangeEndAt(unboundedStructuralIndex, range.start);
    return parentEnd === null || range.end > parentEnd;
  };
  const ranges: InertPromptRange[] = [
    ...referenceIndex.predecessorRanges.filter(isOutsideUnboundedStructuralParent),
    ...referenceIndex.tablePredecessorRanges.filter(isOutsideUnboundedStructuralParent),
    ...structuralRanges
      .filter((range) => range.bounded && isOutsideUnboundedStructuralParent(range))
      .map(({ start, end }) => ({ start, end })),
  ];
  const pattern = new RegExp(PROMPTS_TOKEN_PATTERN.source, PROMPTS_TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isExplicitTokenBoundary(text, end)) continue;
    if (isInInertRange(unboundedStructuralIndex, start)) continue;
    const inactive = isInactivePromptsMention(text, start, end, inertRangeIndexes, referenceIndex);
    const lineStart = lineStartForPosition(text, start);
    const leading = leadingDirectiveCursor(text, lineStart, false);
    if (!inactive && directiveCommandTargetStart(text, leading.cursor) !== start) continue;
    const markdownRange = inactive ? markdownDocumentationRange(text, start, end, referenceIndex) : null;
    const referenceEnd = inactive ? inertRangeEndAt(referenceIndex.destinationRanges, start) : null;
    ranges.push({
      start: markdownRange?.start ?? start,
      end: inactive && isListItemDocumentation(text, start, end) ? lineEnd(text, end) : Math.max(markdownRange?.end ?? end, referenceEnd ?? end),
    });
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function hasOddImmediateBackslashes(text: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function scanExplicitCandidates(text: string): ExplicitCandidateScan[] {
  const inertRangeIndexes = collectInertRangeIndexes(text);
  const candidates: ExplicitCandidateScan[] = [];
  const dollarScanner = /\$/gu;
  let dollar: RegExpExecArray | null;
  while ((dollar = dollarScanner.exec(text)) !== null) {
    const start = dollar.index;
    EXPLICIT_TOKEN_START.lastIndex = start;
    const canonicalMatch = EXPLICIT_TOKEN_START.exec(text);
    const canonicalEnd = canonicalMatch?.index === start ? start + canonicalMatch[0].length : null;
    const firstCharacter = codePointAt(text, start + 1);
    if (canonicalEnd === null && (!firstCharacter || SAFE_TOKEN_WHITESPACE.test(firstCharacter) || isExplicitTokenBoundary(text, start + 1))) continue;

    const initialEnd = canonicalEnd ?? start + 1;
    const end = maximalExplicitTokenEnd(text, initialEnd);
    const rawKeyword = text.slice(start, end);
    dollarScanner.lastIndex = Math.max(end, start + 1);
    const reasons = new Set<KeywordInertDiagnostic>();
    for (const reason of STRUCTURAL_INERT_DIAGNOSTICS) {
      if (isInInertRange(inertRangeIndexes[reason], start)) reasons.add(reason);
    }
    if (hasOddImmediateBackslashes(text, start)) reasons.add('escaped');
    const canonicalToken = canonicalEnd === end ? (canonicalMatch?.[1] ?? '').toLowerCase() : '';
    const normalizedToken = canonicalToken || rawKeyword.replace(/^\$(?:(?:[Oo][Hh]-[Mm][Yy]-[Cc][Oo][Dd][Ee][Xx]):)?/u, '').toLowerCase();
    const definition = canonicalToken ? getExplicitSkillDefinition(canonicalToken) : undefined;
    candidates.push({
      rawKeyword,
      normalizedToken,
      skill: definition?.skill ?? null,
      priority: definition?.priority ?? null,
      start,
      end,
      reasons,
    });
  }
  return candidates;
}

interface DirectCandidateIndexResult {
  directIndexes: Set<number>;
  documentationRanges: InertRangeIndex;
  documentationBlocks: readonly InertPromptRange[];
}

type AddedDirectBlock = 'none' | 'documentation' | 'direct';

function boundedHorizontalCursor(text: string, start: number, limit: number): number {
  let cursor = start;
  while (cursor < limit && /[^\S\r\n\u2028\u2029]/u.test(text[cursor] ?? '')) cursor += 1;
  return cursor;
}

interface DocumentationFollowup {
  end: number;
  reopenable: boolean;
}

function documentationFollowupAt(
  text: string,
  start: number,
  lineLimit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
  cache: Map<number, DocumentationFollowup | null>,
): DocumentationFollowup | null {
  const cached = cache.get(start);
  if (cached !== undefined) return cached;

  let cursor = boundedHorizontalCursor(text, start, lineLimit);
  const commandTarget = directiveCommandTargetStart(text, cursor, lineLimit);
  if (commandTarget !== null) cursor = commandTarget;
  const chain = collectMixedSubjectChain(text, cursor, lineLimit, candidates, candidateIndexByStart);
  const followup = chain
    ? {
      end: chain.end,
      reopenable: chain.explicitIndexes.length > 0
        ? !hasExplicitDocumentationSuffixAt(text, chain.end, lineLimit)
        : !hasImplicitDocumentationSubjectPrefix(text.slice(chain.start, lineLimit)),
    }
    : null;
  cache.set(start, followup);
  return followup;
}

function isDocumentationClauseSeparatorAt(text: string, index: number): boolean {
  const character = codePointAt(text, index);
  const normalized = normalizedPunctuation(character);
  return /[,;؛.!?？؟。！？:：،、]/u.test(normalized)
    && (normalized !== '.' || !isAbbreviationDotAt(text, index));
}

function isStrongDocumentationClauseSeparatorAt(text: string, index: number): boolean {
  const normalized = normalizedPunctuation(codePointAt(text, index));
  return /[;؛.!?？؟。！？:：]/u.test(normalized)
    && (normalized !== '.' || !isAbbreviationDotAt(text, index));
}

function explicitDocumentationClauseEnd(
  text: string,
  start: number,
  lineLimit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
  followups: Map<number, DocumentationFollowup | null>,
): number {
  for (let cursor = start; cursor < lineLimit;) {
    if (isDocumentationClauseSeparatorAt(text, cursor)) {
      const followup = documentationFollowupAt(
        text,
        cursor + codePointAt(text, cursor).length,
        lineLimit,
        candidates,
        candidateIndexByStart,
        followups,
      );
      if (followup?.reopenable) return cursor;
      if (followup) {
        cursor = followup.end;
        continue;
      }
    }
    cursor += codePointAt(text, cursor).length;
  }
  return documentationDirectiveTransitionStart(text, start, lineLimit) ?? lineLimit;
}

function explicitDocumentationSuffixClauseEnd(
  text: string,
  start: number,
  lineLimit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
  followups: Map<number, DocumentationFollowup | null>,
): number {
  for (let cursor = start; cursor < lineLimit;) {
    if (isDocumentationClauseSeparatorAt(text, cursor)) {
      if (isStrongDocumentationClauseSeparatorAt(text, cursor)) return cursor;
      const followup = documentationFollowupAt(
        text,
        cursor + codePointAt(text, cursor).length,
        lineLimit,
        candidates,
        candidateIndexByStart,
        followups,
      );
      if (followup?.reopenable) return cursor;
      if (followup) {
        cursor = followup.end;
        continue;
      }
    }
    cursor += codePointAt(text, cursor).length;
  }
  return documentationDirectiveTransitionStart(text, start, lineLimit) ?? lineLimit;
}

function hasStrongDocumentationClauseBoundary(text: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end;) {
    if (isStrongDocumentationClauseSeparatorAt(text, cursor)) return true;
    cursor += codePointAt(text, cursor).length;
  }
  return false;
}

function isCompactSlashDocumentationCandidate(candidate: ExplicitCandidateScan): boolean {
  const parts = candidate.rawKeyword.split('/');
  if (parts.length < 2) return false;
  return parts.every((part) => {
    const match = /^\$(?:(?:[Oo][Hh]-[Mm][Yy]-[Cc][Oo][Dd][Ee][Xx]):)?([A-Za-z][A-Za-z0-9_-]*)$/u.exec(part);
    return match !== null && getExplicitSkillDefinition((match[1] ?? '').toLowerCase()) !== undefined;
  });
}

function documentationSubjectChainAtClauseStart(
  text: string,
  start: number,
  lineLimit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
): DocumentationSubjectChain | null {
  const contentStart = boundedHorizontalCursor(text, start, lineLimit);
  const commandTarget = directiveCommandTargetStart(text, contentStart, lineLimit);
  return collectMixedSubjectChain(text, commandTarget ?? contentStart, lineLimit, candidates, candidateIndexByStart);
}

function independentDocumentaryClauseStart(
  text: string,
  clauseStart: number,
  chain: DocumentationSubjectChain,
  lineLimit: number,
  candidateIndexByStart: ReadonlyMap<number, number>,
): number | null {
  const contentStart = boundedHorizontalCursor(text, clauseStart, lineLimit);
  const directiveTarget = directiveCommandTargetStart(text, contentStart, lineLimit);
  if (directiveTarget === null || directiveTarget !== chain.start || candidateIndexByStart.has(directiveTarget)) return null;

  const coordinator = new RegExp(
    `[,，،、]\\s*(?:${ASCII_AND}|${asciiCaseWordPattern('or')}|${asciiCaseWordPattern('nor')})\\s+`,
    'u',
  ).exec(text.slice(chain.start, chain.end));
  return coordinator
    ? boundedHorizontalCursor(text, chain.start + coordinator.index + coordinator[0].length, lineLimit)
    : null;
}

function findMixedSubjectChainInDocumentationClause(
  text: string,
  start: number,
  limit: number,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
): DocumentationSubjectChain | null {
  for (let cursor = boundedHorizontalCursor(text, start, limit); cursor < limit;) {
    const chain = collectMixedSubjectChain(text, cursor, limit, candidates, candidateIndexByStart);
    if (chain) {
      if (chain.explicitIndexes.length > 0) return chain;
      cursor = chain.end;
      continue;
    }
    cursor += codePointAt(text, cursor).length;
  }

  return null;
}

function collectImplicitDocumentationLineRanges(
  text: string,
  candidates: readonly ExplicitCandidateScan[],
  candidateIndexByStart: ReadonlyMap<number, number>,
): InertPromptRange[] {
  const ranges: InertPromptRange[] = [];
  const followups = new Map<number, DocumentationFollowup | null>();
  let lineStart = 0;
  while (lineStart < text.length) {
    const lineLimit = lineEnd(text, lineStart);
    let clauseStart = lineStart;
    while (clauseStart < lineLimit) {
      const clauseLimit = documentationSuffixLimit(text, clauseStart, lineLimit);
      const clauseText = text.slice(clauseStart, clauseLimit);
      let subjectChain = documentationSubjectChainAtClauseStart(text, clauseStart, clauseLimit, candidates, candidateIndexByStart);
      const directDocumentation = Boolean(
        subjectChain
        && (subjectChain.explicitIndexes.length > 0
          ? hasExplicitDocumentationSuffixAt(text, subjectChain.end, clauseLimit)
          : hasImplicitDocumentationSubjectPrefix(text.slice(subjectChain.start, clauseLimit))),
      );
      const leadingDocumentation = DOCUMENTATION_LEADING_PATTERN.test(clauseText);
      if (directDocumentation || leadingDocumentation) {
        if (!subjectChain && leadingDocumentation) {
          subjectChain = findMixedSubjectChainInDocumentationClause(
            text,
            clauseStart,
            clauseLimit,
            candidates,
            candidateIndexByStart,
          );
        }
        const rangeStart = subjectChain
          ? independentDocumentaryClauseStart(text, clauseStart, subjectChain, lineLimit, candidateIndexByStart) ?? clauseStart
          : clauseStart;
        const rangeEnd = subjectChain
          ? explicitDocumentationClauseEnd(text, subjectChain.end, lineLimit, candidates, candidateIndexByStart, followups)
          : clauseLimit;
        ranges.push({ start: rangeStart, end: rangeEnd });
        if (rangeEnd >= lineLimit) break;
        clauseStart = rangeEnd + codePointAt(text, rangeEnd).length;
        continue;
      }
      if (clauseLimit >= lineLimit) break;
      clauseStart = clauseLimit + codePointAt(text, clauseLimit).length;
    }
    const next = nextLineStart(text, lineLimit);
    if (next <= lineStart) break;
    lineStart = next;
  }
  return ranges;
}

function directCandidateIndexes(
  text: string,
  candidates: ExplicitCandidateScan[],
  referenceIndex: MarkdownReferenceIndex,
  postposedNegations: PostposedExplicitNegationIndex,
): DirectCandidateIndexResult {
  const inertRangeIndexes = collectInertRangeIndexes(text);
  const candidateIndexByStart = new Map<number, number>();
  for (const [index, candidate] of candidates.entries()) candidateIndexByStart.set(candidate.start, index);
  const embeddedPathOrUrlIndex = collectEmbeddedPathOrUrlMentionIndex(text, candidates);

  const indexes = new Set<number>();
  const implicitDocumentationRanges = collectImplicitDocumentationLineRanges(text, candidates, candidateIndexByStart);
  const documentationRanges: InertPromptRange[] = [...implicitDocumentationRanges];
  const documentationFollowups = new Map<number, DocumentationFollowup | null>();
  let capturedBlock = false;
  let latestInertEnd = -1;
  let latestDocumentationEnd = -1;
  const recordDocumentationRange = (range: InertPromptRange): void => {
    documentationRanges.push(range);
    latestInertEnd = Math.max(latestInertEnd, range.end);
    latestDocumentationEnd = Math.max(latestDocumentationEnd, range.end);
  };
  let candidateDocumentationLineStart = -1;
  let candidateDocumentationLineEnd = -1;
  let candidateListDocumentationRange: ListDocumentationTokenRange | null = null;
  let candidateLineMayContainMarkdownDocumentation = false;
  const ensureCandidateDocumentationLine = (candidate: ExplicitCandidateScan): void => {
    if (candidate.start >= candidateDocumentationLineStart && candidate.start < candidateDocumentationLineEnd) return;
    candidateDocumentationLineStart = lineStartForPosition(text, candidate.start);
    candidateDocumentationLineEnd = lineEnd(text, candidate.end);
    candidateListDocumentationRange = listItemDocumentationTokenRange(text, candidate.start, candidate.end);
    const line = text.slice(candidateDocumentationLineStart, candidateDocumentationLineEnd);
    const followingStart = candidateDocumentationLineEnd < text.length
      ? nextLineStart(text, candidateDocumentationLineEnd)
      : text.length;
    const followingLine = followingStart < text.length
      ? text.slice(followingStart, lineEnd(text, followingStart))
      : '';
    candidateLineMayContainMarkdownDocumentation = /[\[\]|]/u.test(line)
      || /^\s*#{1,6}\s/u.test(line)
      || /^\s*(?:={3,}|-{3,})\s*$/u.test(followingLine)
      || (line.includes('|') && isMarkdownTableDelimiter(followingLine));
  };
  const cachedCandidateDocumentationRange = (candidate: ExplicitCandidateScan): InertPromptRange | null => {
    ensureCandidateDocumentationLine(candidate);
    const destinationEnd = inertRangeEndAt(referenceIndex.destinationRanges, candidate.start);
    if (destinationEnd !== null) return { start: candidate.start, end: destinationEnd };
    if (candidateListDocumentationRange
      && candidate.start >= candidateListDocumentationRange.start
      && candidate.end <= candidateListDocumentationRange.end) {
      return { start: candidate.start, end: candidateDocumentationLineEnd };
    }
    if (candidateLineMayContainMarkdownDocumentation) {
      const markdownRange = markdownDocumentationRange(text, candidate.start, candidate.end, referenceIndex);
      if (markdownRange) return markdownRange;
    }
    return isEmbeddedPathOrUrlMention(embeddedPathOrUrlIndex, candidate.start) ? { start: candidate.start, end: candidate.end } : null;
  };
  const addBlock = (start: number): AddedDirectBlock => {
    let candidateIndex = candidateIndexByStart.get(start);
    if (candidateIndex === undefined || candidates[candidateIndex].reasons.size > 0 || isNegativeExplicitMention(candidates[candidateIndex], postposedNegations)) return 'none';
    const added: number[] = [];
    const checkedPostposedSkills = new Set<string>();
    let blockEnd = start;
    const blockLineLimit = lineEnd(text, start);
    while (candidateIndex !== undefined && candidates[candidateIndex].reasons.size === 0) {
      const candidate = candidates[candidateIndex];
      if (added.length > 0 && hasStrongDocumentationClauseBoundary(text, blockEnd, candidate.start)) {
        const candidateClauseEnd = explicitDocumentationSuffixClauseEnd(
          text,
          candidate.end,
          blockLineLimit,
          candidates,
          candidateIndexByStart,
          documentationFollowups,
        );
        if (hasExplicitDocumentationSuffixAt(text, candidate.end, candidateClauseEnd)) break;
      }
      const candidateDocumentationRange = cachedCandidateDocumentationRange(candidate);
      if (candidateDocumentationRange) {
        recordDocumentationRange(candidateDocumentationRange);
        if (added.length === 0) return 'documentation';
        break;
      }
      if (added.length > 0 && candidate.skill && !checkedPostposedSkills.has(candidate.skill) && hasPostposedExplicitNegation(postposedNegations, candidate)) break;
      if (candidate.skill) checkedPostposedSkills.add(candidate.skill);
      indexes.add(candidateIndex);
      added.push(candidateIndex);
      blockEnd = candidates[candidateIndex].end;
      const nextStart = punctuationSeparatedCandidateStart(text, blockEnd);
      if (nextStart === null) break;
      candidateIndex = candidateIndexByStart.get(nextStart);
    }

    if (added.length === 0) return 'none';
    const documentationLineEnd = blockLineLimit;
    const subjectChain = collectMixedSubjectChain(
      text,
      candidates[added[0]].start,
      documentationLineEnd,
      candidates,
      candidateIndexByStart,
    ) ?? { start: candidates[added[0]].start, explicitIndexes: [], end: blockEnd };
    const addedSet = new Set(added);
    const documentationAdded = [...new Set([...added, ...subjectChain.explicitIndexes])];
    const coordinatedDocumentationAdded = subjectChain.explicitIndexes.filter((index) => !addedSet.has(index));
    let documentationBlockEnd = Math.max(blockEnd, subjectChain.end);
    let coordinatedStart = coordinatedDocumentationCandidateStart(text, documentationBlockEnd);
    while (coordinatedStart !== null) {
      const coordinatedIndex = candidateIndexByStart.get(coordinatedStart);
      if (coordinatedIndex === undefined || candidates[coordinatedIndex].reasons.size > 0) break;
      documentationAdded.push(coordinatedIndex);
      coordinatedDocumentationAdded.push(coordinatedIndex);
      documentationBlockEnd = candidates[coordinatedIndex].end;
      coordinatedStart = coordinatedDocumentationCandidateStart(text, documentationBlockEnd);
    }

    const documentationSuffixEnd = explicitDocumentationSuffixClauseEnd(
      text,
      documentationBlockEnd,
      documentationLineEnd,
      candidates,
      candidateIndexByStart,
      documentationFollowups,
    );
    const documentationSuffix = documentationAdded.some((index) => candidates[index].skill !== null || isCompactSlashDocumentationCandidate(candidates[index]))
      && hasExplicitDocumentationSuffixAt(text, documentationBlockEnd, documentationSuffixEnd);
    let documentationRange: InertPromptRange | null = null;
    if (documentationSuffix) {
      const documentationRangeEnd = explicitDocumentationClauseEnd(
        text,
        documentationBlockEnd,
        documentationLineEnd,
        candidates,
        candidateIndexByStart,
        documentationFollowups,
      );
      documentationRange = {
        start,
        end: documentationRangeEnd,
      };
    } else if (isListItemDocumentation(text, start, documentationBlockEnd)) {
      documentationRange = { start, end: documentationLineEnd };
    } else {
      for (const index of coordinatedDocumentationAdded) {
        const markdownRange = markdownDocumentationRange(text, candidates[index].start, candidates[index].end, referenceIndex);
        if (!markdownRange) continue;
        documentationRange = documentationRange
          ? { start: Math.min(documentationRange.start, markdownRange.start), end: Math.max(documentationRange.end, markdownRange.end) }
          : markdownRange;
      }
    }
    if (documentationRange) {
      for (const index of documentationAdded) indexes.delete(index);
      recordDocumentationRange(documentationRange);
      return 'documentation';
    }
    if (added.length > 0) {
      capturedBlock = true;
      return 'direct';
    }
    return 'none';
  };

  addBlock(promptLeadingExplicitCandidateStart(text));
  const inertPromptRanges = boundedPredecessorRanges(text, referenceIndex);
  let inertPromptCursor = 0;
  let implicitDocumentationCursor = 0;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    ensureCandidateDocumentationLine(candidate);
    while (inertPromptCursor < inertPromptRanges.length && inertPromptRanges[inertPromptCursor].start < candidate.start) {
      latestInertEnd = Math.max(latestInertEnd, inertPromptRanges[inertPromptCursor].end);
      inertPromptCursor += 1;
    }
    while (implicitDocumentationCursor < implicitDocumentationRanges.length && implicitDocumentationRanges[implicitDocumentationCursor].start < candidate.start) {
      latestInertEnd = Math.max(latestInertEnd, implicitDocumentationRanges[implicitDocumentationCursor].end);
      latestDocumentationEnd = Math.max(latestDocumentationEnd, implicitDocumentationRanges[implicitDocumentationCursor].end);
      implicitDocumentationCursor += 1;
    }
    if (candidate.start < latestDocumentationEnd) continue;
    if (indexes.has(candidateIndex)) {
      latestInertEnd = -1;
      latestDocumentationEnd = -1;
      continue;
    }
    if (capturedBlock) continue;
    if (isInertOrNegativeMention(candidate, postposedNegations)) {
      const structuralEnd = structuralInertRangeEnd(inertRangeIndexes, candidate.start);
      let predecessorEnd = structuralEnd ?? candidate.end;
      predecessorEnd = Math.max(predecessorEnd, postposedExplicitNegationEnd(postposedNegations, candidate) ?? -1);
      if (candidateLineMayContainMarkdownDocumentation
        && text.lastIndexOf('[', candidate.start) >= candidateDocumentationLineStart
        && text.indexOf(']', candidate.end) < candidateDocumentationLineEnd) {
        predecessorEnd = Math.max(predecessorEnd, markdownDocumentationRange(text, candidate.start, candidate.end, referenceIndex)?.end ?? -1);
      }
      latestInertEnd = Math.max(latestInertEnd, predecessorEnd);
      continue;
    }
    const documentationRange = cachedCandidateDocumentationRange(candidate);
    if (documentationRange) {
      recordDocumentationRange(documentationRange);
      continue;
    }

    if (!capturedBlock && latestInertEnd >= 0 && !isNegativeExplicitMention(candidate, postposedNegations)) {
      const lineLeading = leadingDirectiveCursor(text, candidateDocumentationLineStart, false).cursor === candidate.start;
      const documentationSeparated = latestDocumentationEnd >= 0
        && hasAdjacentPredecessorSeparator(text, latestDocumentationEnd, candidate.start);
      if (documentationSeparated || (lineLeading && hasAdjacentPredecessorSeparator(text, latestInertEnd, candidate.start)) || clauseDirectiveStart(text, latestInertEnd, candidate.start)) {
        const addedBlock = addBlock(candidate.start);
        if (addedBlock !== 'documentation') {
          latestInertEnd = -1;
          latestDocumentationEnd = -1;
        }
      } else {
        latestInertEnd = -1;
        latestDocumentationEnd = -1;
      }
    }
  }
  return {
    directIndexes: indexes,
    documentationRanges: createInertRangeIndex(documentationRanges),
    documentationBlocks: documentationRanges,
  };
}

function freezeMatches(matches: KeywordMatch[]): readonly KeywordMatch[] {
  return Object.freeze(matches.map((match) => Object.freeze({ ...match })));
}

function freezeCandidates(candidates: ExplicitCandidateScan[]): readonly ExplicitSkillCandidate[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    rawKeyword: candidate.rawKeyword,
    normalizedToken: candidate.normalizedToken,
    skill: candidate.skill,
    priority: candidate.priority,
    reasons: Object.freeze(KEYWORD_INERT_DIAGNOSTIC_ORDER.filter((reason) => candidate.reasons.has(reason))),
  })));
}

interface ImplicitClauseRange {
  start: number;
  frameStart: number;
  end: number;
  governingDocumentationFrame: boolean;
}

interface ImplicitClauseIndex {
  lineStarts: readonly number[];
  lineEnds: readonly number[];
  subjectStarts: readonly number[];
  clauseEnds: readonly number[];
  strongClauseEnds: readonly number[];
  documentationBlocks: InertRangeIndex;
  negativeBlocks: InertRangeIndex;
}

function lowerBound(values: readonly number[], value: number): number {
  let lower = 0;
  let upper = values.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (values[middle] < value) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function upperBound(values: readonly number[], value: number): number {
  let lower = 0;
  let upper = values.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (values[middle] <= value) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function lineIndexAt(lineStarts: readonly number[], position: number): number {
  return Math.max(0, upperBound(lineStarts, position) - 1);
}

function implicitLineIndexAt(index: ImplicitClauseIndex, position: number): number {
  return lineIndexAt(index.lineStarts, position);
}

function indexedBoundaryAtOrAfter(values: readonly number[], position: number, fallback: number): number {
  return values[lowerBound(values, position)] ?? fallback;
}

function positiveContrastStartInRange(contrasts: readonly number[], start: number, end: number): number | null {
  const contrast = contrasts[lowerBound(contrasts, start)];
  return contrast !== undefined && contrast < end ? contrast : null;
}

function collectImplicitClauseIndex(text: string, documentationBlocks: readonly InertPromptRange[]): ImplicitClauseIndex {
  const lineStarts: number[] = [];
  const lineEnds: number[] = [];
  const subjectStarts: number[] = [];
  const clauseEnds: number[] = [];
  const strongClauseEnds: number[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const lineLimit = lineEnd(text, lineStart);
    lineStarts.push(lineStart);
    lineEnds.push(lineLimit);
    subjectStarts.push(lineStart);
    for (let cursor = lineStart; cursor < lineLimit;) {
      const character = codePointAt(text, cursor);
      if (isClauseBoundaryAt(text, cursor)) {
        clauseEnds.push(cursor);
        if (isPostposedSubjectBoundaryAt(text, cursor)) {
          strongClauseEnds.push(cursor);
          subjectStarts.push(cursor + character.length);
        }
      }
      cursor += character.length;
    }
    if (lineLimit === text.length) break;
    lineStart = nextLineStart(text, lineLimit);
  }

  const positiveContrasts: number[] = [];
  const contrastScanner = new RegExp(
    `${ASCII_BUT}\\s+(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}\\s+)?(?=${ASCII_DIRECTIVE_COMMAND})`,
    'gu',
  );
  let contrast: RegExpExecArray | null;
  while ((contrast = contrastScanner.exec(text)) !== null) {
    if (hasUnicodeGrammarTokenStart(text, contrast.index)) positiveContrasts.push(contrast.index);
  }

  const negativeBlocks: InertPromptRange[] = [];
  const normalizedText = normalizeGrammarApostrophes(text);
  const prefixScanner = new RegExp(NEGATIVE_PREFIX_PATTERN.source, 'gu');
  let prefix: RegExpExecArray | null;
  let prefixCoveredUntil = -1;
  while ((prefix = prefixScanner.exec(normalizedText)) !== null) {
    if (!hasUnicodeGrammarTokenBoundaries(normalizedText, prefix.index, prefixScanner.lastIndex)
      || isDiscourseNegation(normalizedText, prefix.index, prefixScanner.lastIndex)) continue;
    if (prefix.index < prefixCoveredUntil) continue;
    const lineIndex = lineIndexAt(lineStarts, prefix.index);
    const lineLimit = lineEnds[lineIndex] ?? text.length;
    const clauseEnd = Math.min(indexedBoundaryAtOrAfter(strongClauseEnds, prefixScanner.lastIndex, lineLimit), lineLimit);
    const positiveContrast = positiveContrastStartInRange(positiveContrasts, prefixScanner.lastIndex, clauseEnd);
    const exclusionTransition = exclusionPrefixDirectiveTransitionStart(text, prefix.index, prefixScanner.lastIndex, clauseEnd);
    const end = Math.min(positiveContrast ?? clauseEnd, exclusionTransition ?? clauseEnd);
    negativeBlocks.push({ start: prefix.index, end });
    prefixCoveredUntil = end;
  }

  const predicateScanner = new RegExp(POSTPOSED_NEGATIVE_PREDICATE.source, 'giu');
  const checkedSubjectStarts = new Set<number>();
  let predicate: RegExpExecArray | null;
  while ((predicate = predicateScanner.exec(normalizedText)) !== null) {
    const predicateTokenStart = firstGrammarTokenStart(normalizedText, predicate.index, predicateScanner.lastIndex);
    if (!hasUnicodeGrammarTokenBoundaries(normalizedText, predicateTokenStart, predicateScanner.lastIndex)
      || !hasAsciiGrammarTokenCharacters(normalizedText, predicateTokenStart, predicateScanner.lastIndex)) continue;
    const subjectStart = subjectStarts[Math.max(0, upperBound(subjectStarts, predicate.index) - 1)] ?? 0;
    if (checkedSubjectStarts.has(subjectStart)) continue;
    checkedSubjectStarts.add(subjectStart);
    const lineIndex = lineIndexAt(lineStarts, predicate.index);
    const lineLimit = lineEnds[lineIndex] ?? text.length;
    const clauseEnd = Math.min(indexedBoundaryAtOrAfter(strongClauseEnds, predicateScanner.lastIndex, lineLimit), lineLimit);
    const subject = text.slice(subjectStart, predicate.index);
    if (hasAsciiDirectiveCommand(subject) || !IMPLICIT_POSTPOSED_SUBJECT_CHAIN.test(subject)) continue;
    const positiveContrast = positiveContrastStartInRange(positiveContrasts, predicateScanner.lastIndex, clauseEnd);
    negativeBlocks.push({ start: subjectStart, end: positiveContrast ?? clauseEnd });
  }

  return {
    lineStarts,
    lineEnds,
    subjectStarts,
    clauseEnds,
    strongClauseEnds,
    documentationBlocks: createInertRangeIndex([...documentationBlocks]),
    negativeBlocks: createInertRangeIndex(negativeBlocks),
  };
}

function hasImplicitDocumentationFrame(text: string): boolean {
  return /(?:^|[\s([{])(?:docs?|documentation|examples?|references?|guide|manual|document(?:s|ed|ing)?|describ(?:e|es|ed|ing)|mention(?:s|ed|ing)|explain(?:s|ed|ing)?)(?:\b|\s*:)/iu.test(text);
}
function hasIntroductoryDocumentationFrame(text: string): boolean {
  return /^\s*(?:for\s+(?:example|instance|reference)|as\s+an?\s+example|according\s+to\s+(?:the\s+)?(?:docs?|documentation|guide|manual|reference)|(?:in|per)\s+(?:the\s+)?(?:docs?|documentation|guide|manual|reference))\s*(?:[,，،、:：]|[—–-])\s*$/iu.test(text);
}
function implicitClauseRange(
  text: string,
  candidateStart: number,
  candidateEnd: number,
  clauses: ImplicitClauseIndex,
): ImplicitClauseRange {
  const lineIndex = implicitLineIndexAt(clauses, candidateStart);
  const lineStart = clauses.lineStarts[lineIndex] ?? 0;
  const logicalLineEnd = clauses.lineEnds[lineIndex] ?? text.length;
  let start = clauses.subjectStarts[Math.max(0, upperBound(clauses.subjectStarts, candidateStart) - 1)] ?? lineStart;
  let frameStart = start;
  const introductoryPrefix = /^[^\r\n,:，：،、—–-]*(?:[,，،、:：]|[—–-])\s*/u.exec(text.slice(lineStart, candidateStart))?.[0];
  const introductoryRemainder = introductoryPrefix
    ? text.slice(lineStart + introductoryPrefix.length, candidateStart)
    : '';
  const hasGoverningIntroductoryFrame = Boolean(
    introductoryPrefix
    && hasIntroductoryDocumentationFrame(introductoryPrefix)
    && !hasLogicalSentenceBoundary(introductoryRemainder),
  );
  if (hasGoverningIntroductoryFrame) frameStart = lineStart;
  const discardFrame = new RegExp(`^\\s*(?:${ASCII_PLEASE}\\s+)?${EXCLUSION_PREFIX}`, 'u');

  const contrastText = text.slice(start, candidateStart);
  const contrastStart = latestPositiveContrastStart(contrastText);
  if (contrastStart >= 0) {
    const transitionStart = start + contrastStart;
    const discardMatch = discardFrame.exec(text.slice(start, transitionStart));
    if (!hasGoverningIntroductoryFrame
      && discardMatch
      && hasUnicodeGrammarTokenBoundaries(text, start + discardMatch.index, start + discardMatch.index + discardMatch[0].length)) {
      frameStart = transitionStart;
    }
    start = transitionStart;
  }
  const directivePrefix = text.slice(start, candidateStart);
  const directiveTransition = new RegExp(`(?:${ASCII_AND}|${ASCII_THEN})\\s+(?=(?:${ASCII_PLEASE}\\s+)?(?:${ASCII_INSTEAD}\\s+)?${ASCII_DIRECTIVE_COMMAND})[^\\r\\n\\u2028\\u2029]*$`, 'u').exec(directivePrefix);
  if (directiveTransition
    && hasUnicodeGrammarTokenBoundaries(directivePrefix, directiveTransition.index, directiveTransition.index + directiveTransition[0].length)) {
    const transitionStart = start + directiveTransition.index;
    const hasNegativePrefix = hasUnicodeBoundedNegativePrefix(normalizeGrammarApostrophes(text.slice(frameStart, transitionStart)));
    const exclusionTransition = isExclusionPrefixDirectiveTransitionAt(
      text,
      frameStart,
      transitionStart,
      candidateStart,
    );
    if (!hasGoverningIntroductoryFrame && (!hasNegativePrefix || exclusionTransition)) {
      frameStart = transitionStart;
      start = transitionStart;
    }
  }
  let punctuationDirectiveStart = -1;
  for (let cursor = start; cursor < candidateStart;) {
    const character = codePointAt(text, cursor);
    if (isClauseBoundaryAt(text, cursor) || normalizedPunctuation(character) === ':') {
      const directiveStart = boundedHorizontalCursor(text, cursor + character.length, candidateStart);
      if (directiveCommandTargetStart(text, directiveStart, candidateStart) === candidateStart) {
        punctuationDirectiveStart = directiveStart;
      }
    }
    cursor += character.length;
  }
  if (punctuationDirectiveStart >= 0) {
    if (!hasGoverningIntroductoryFrame) frameStart = punctuationDirectiveStart;
    start = punctuationDirectiveStart;
  }

  const end = Math.min(indexedBoundaryAtOrAfter(clauses.clauseEnds, candidateEnd, logicalLineEnd), logicalLineEnd);
  return { start, frameStart, end, governingDocumentationFrame: hasGoverningIntroductoryFrame };
}

function isImplicitListDocumentation(text: string, candidateStart: number): boolean {
  const start = lineStartForPosition(text, candidateStart);
  const leading = leadingDirectiveCursor(text, start, false);
  if (!leading.listItem || leading.cursor > candidateStart) return false;
  const content = text.slice(leading.cursor, lineEnd(text, candidateStart));
  return /(?:\s*(?::|：|[—–])\s*\S|\b(?:is|are|means|refer(?:s)?\s+to|denote(?:s)?)\b).*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b/iu.test(content);
}

function isImplicitDocumentationClause(
  text: string,
  matchStart: number,
  matchEnd: number,
  clause: ImplicitClauseRange,
  referenceIndex: MarkdownReferenceIndex,
): boolean {
  const prefix = text.slice(clause.frameStart, matchStart);
  if (clause.governingDocumentationFrame) return true;
  if (hasImplicitDocumentationFrame(prefix)) return true;
  const introductoryFrame = /^[^,，،、\r\n\u2028\u2029]*[,，،、]\s*/u.exec(prefix)?.[0];
  if (introductoryFrame && hasIntroductoryDocumentationFrame(introductoryFrame)) return true;
  if (hasImplicitDocumentationSubjectPrefix(text.slice(matchStart, clause.end))) return true;
  const suffix = text.slice(matchEnd, clause.end);
  if (/^(?:(?:\s+(?:mode|workflow|skill|loop))?\s+(?:(?:is|are|means|refer(?:s)?\s+to|denote(?:s)?)\b.*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b|(?:is|are)\s+(?:(?:(?:also|still)\s+)?(?:(?:its|an?|the)\s+)?alias(?:es)?|documented|described)\b|(?:appears?|occurs?|is\s+(?:also\s+)?mentioned)\b.*\b(?:docs?|documentation|examples?|references?|guide|manual)\b|(?:docs?|documentation|examples?|references?|guide|manual)\b)|(?:\s+(?:mode|workflow|skill|loop))?\s*\/\s*.*\b(?:is|are|means|refer(?:s)?\s+to|denote(?:s)?)\b.*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b|(?:\s+(?:mode|workflow|skill|loop))?\s*(?::|[—–-])\s*\S.*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b)/iu.test(suffix)) return true;
  const lineStart = lineStartForPosition(text, matchStart);
  const line = text.slice(lineStart, lineEnd(text, matchEnd));
  const localEnd = matchEnd - lineStart;
  if (/^(?:\s+(?:mode|workflow|skill|loop))?\s*[—–-]\s*\S.*\b(?:commands?|workflows?|skills?|modes?|files?|documentation)\b/iu.test(line.slice(localEnd))) return true;
  if (isMarkdownDocumentationMention(text, matchStart, matchEnd, referenceIndex)) return true;
  return false;
}
function hasPostposedImplicitNegation(suffix: string, prefix: string): boolean {
  const normalizedSuffix = normalizeGrammarApostrophes(suffix);
  const predicate = POSTPOSED_NEGATIVE_PREDICATE.exec(normalizedSuffix);
  const predicateTokenStart = predicate
    ? firstGrammarTokenStart(normalizedSuffix, predicate.index, predicate.index + predicate[0].length)
    : -1;
  if (!predicate
    || !hasUnicodeGrammarTokenBoundaries(normalizedSuffix, predicateTokenStart, predicate.index + predicate[0].length)
    || !hasAsciiGrammarTokenCharacters(normalizedSuffix, predicateTokenStart, predicate.index + predicate[0].length)) return false;
  const subjectTail = suffix.slice(0, predicate.index);
  if (hasAsciiDirectiveCommand(subjectTail)) return false;
  const coordinatedSubject = new RegExp(
    `^(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?(?:\\s*(?:(?:[,，،、]|/)\\s*(?:${COORDINATED_SUBJECT_JOINER}\\s+)?|${COORDINATED_SUBJECT_JOINER}\\s+)${COORDINATED_WORKFLOW_SUBJECT}(?:\\s+${IMPLICIT_WORKFLOW_NOUN})?)*\\s*[,，、،]?\\s*$`,
    'iu',
  );
  if (!coordinatedSubject.test(subjectTail)) return false;
  const independentCoordinatedClause = /^\s+(?:modes?|workflows?|skills?|loops?)?\s*[,，،、]\s*(?:and|or|nor)\b/iu.test(subjectTail)
    && hasAsciiDirectiveCommand(prefix);
  return !independentCoordinatedClause;
}
interface EmbeddedPathOrUrlMentionIndex {
  tokenStarts: ReadonlyMap<number, number>;
  embeddedCandidateStarts: ReadonlySet<number>;
}

function collectEmbeddedPathOrUrlMentionIndex(
  text: string,
  candidates: readonly ExplicitCandidateScan[],
): EmbeddedPathOrUrlMentionIndex {
  const tokenStarts = new Map<number, number>();
  const embeddedCandidateStarts = new Set<number>();
  let candidateIndex = 0;
  let tokenStart = 0;
  let penultimateTokenCharacter = '';
  let previousTokenCharacter = '';
  let tokenContainsUrlScheme = false;

  for (let cursor = 0; cursor < text.length;) {
    while (candidateIndex < candidates.length && candidates[candidateIndex].start === cursor) {
      tokenStarts.set(cursor, tokenStart);
      if (tokenContainsUrlScheme || /[\\/?#=&]/u.test(previousTokenCharacter)) embeddedCandidateStarts.add(cursor);
      candidateIndex += 1;
    }

    const character = codePointAt(text, cursor);
    if (SAFE_TOKEN_WHITESPACE.test(character)) {
      tokenStart = cursor + character.length;
      penultimateTokenCharacter = '';
      previousTokenCharacter = '';
      tokenContainsUrlScheme = false;
    } else {
      if (penultimateTokenCharacter === ':' && previousTokenCharacter === '/' && character === '/') {
        tokenContainsUrlScheme = true;
      }
      penultimateTokenCharacter = previousTokenCharacter;
      previousTokenCharacter = character;
    }
    cursor += character.length;
  }

  return { tokenStarts, embeddedCandidateStarts };
}

function isEmbeddedPathOrUrlMention(index: EmbeddedPathOrUrlMentionIndex, start: number): boolean {
  return index.tokenStarts.has(start) && index.embeddedCandidateStarts.has(start);
}

function hasActiveExplicitLikeInvocation(
  candidates: readonly ExplicitCandidateScan[],
  documentationRanges: InertRangeIndex,
  postposedNegations: PostposedExplicitNegationIndex,
): boolean {
  return candidates.some((candidate) => {
    if (isInInertRange(documentationRanges, candidate.start)) return false;
    if ([...candidate.reasons].some((reason) => reason !== 'not-leading-region')) return false;
    if (isNegativeExplicitMention(candidate, postposedNegations)) return false;
    return true;
  });
}

function hasActivePromptsInvocation(
  text: string,
  start: number,
  end: number,
  inertRangeIndexes: Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>>,
  referenceIndex: MarkdownReferenceIndex,
): boolean {
  const pattern = new RegExp(PROMPTS_TOKEN_PATTERN.source, PROMPTS_TOKEN_PATTERN.flags);
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && match.index < end) {
    const matchEnd = match.index + match[0].length;
    if (!isInactivePromptsMention(text, match.index, matchEnd, inertRangeIndexes, referenceIndex)) return true;
  }
  return false;
}
function hasImplicitKeywordBoundaries(text: string, start: number, end: number): boolean {
  const previous = codePointBefore(text, start);
  const next = codePointAt(text, end);
  return (!previous || (previous !== '$' && !TOKEN_CONTINUATION.test(previous))) && (!next || !TOKEN_CONTINUATION.test(next));
}

function isActiveImplicitMatch(
  text: string,
  matchStart: number,
  matchEnd: number,
  matchedKeyword: string,
  inertRangeIndexes: Readonly<Record<StructuralInertDiagnostic, InertRangeIndex>>,
  referenceIndex: MarkdownReferenceIndex,
  clauses: ImplicitClauseIndex,
  postposedNegations: PostposedExplicitNegationIndex,
): ImplicitClauseRange | null {
  if (isStructurallyInert(inertRangeIndexes, matchStart)
    || isInInertRange(referenceIndex.destinationRanges, matchStart)
    || isInInertRange(clauses.documentationBlocks, matchStart)
    || (!isNegativePrefixExemptImplicitKeyword(matchedKeyword) && isInInertRange(clauses.negativeBlocks, matchStart))
    || isInInertRange(postposedNegations.implicitBlocks, matchStart)
    || isImplicitListDocumentation(text, matchStart)) return null;
  if (hasOddImmediateBackslashes(text, matchStart)) return null;
  const clause = implicitClauseRange(text, matchStart, matchEnd, clauses);
  const lineStart = clauses.lineStarts[implicitLineIndexAt(clauses, matchStart)] ?? 0;
  const prefix = text.slice(clause.start, matchStart);
  const effectivePrefix = prefix.trim() || text.slice(lineStart, Math.max(lineStart, clause.start - 1));
  if (!isNegativePrefixExemptImplicitKeyword(matchedKeyword) && hasUnicodeBoundedNegativePrefix(normalizeGrammarApostrophes(effectivePrefix))) return null;
  const suffix = text.slice(matchEnd, clause.end);
  const lineEnd = clauses.lineEnds[implicitLineIndexAt(clauses, matchStart)] ?? text.length;
  const lineSuffix = text.slice(matchEnd, lineEnd);
  if (hasPostposedImplicitNegation(lineSuffix, effectivePrefix)) return null;
  if (/^(?:\s+(?:mode|workflow|skill|loop))?(?:는|은|이|가)?\s*(?:사용하지\s*마세요|사용하지\s*마|쓰지\s*마세요|쓰지\s*마)/u.test(suffix)) return null;
  if (hasActivePromptsInvocation(text, clause.start, clause.end, inertRangeIndexes, referenceIndex)) return null;
  if (isImplicitDocumentationClause(text, matchStart, matchEnd, clause, referenceIndex)) return null;
  return clause;
}

function detectImplicitKeywords(
  normalizedText: string,
  explicitCandidates: readonly ExplicitCandidateScan[],
  referenceIndex: MarkdownReferenceIndex,
  clauses: ImplicitClauseIndex,
  postposedNegations: PostposedExplicitNegationIndex,
): KeywordMatch[] {
  const implicit: KeywordMatch[] = [];
  const inertRangeIndexes = collectInertRangeIndexes(normalizedText);
  const explicitCandidateRanges = createInertRangeIndex(explicitCandidates.map((candidate) => ({ start: candidate.start, end: candidate.end })));
  for (const { keyword, pattern, skill, priority } of KEYWORD_MAP) {
    if (keyword.startsWith('$')) continue;
    const scanner = new RegExp(pattern.source, `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(normalizedText)) !== null) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      if ((inertRangeEndAt(explicitCandidateRanges, matchStart) ?? -1) >= matchEnd) continue;
      if (match[0].toLowerCase() !== 'ulw' && !hasImplicitKeywordBoundaries(normalizedText, matchStart, matchEnd)) continue;
      const clause = isActiveImplicitMatch(normalizedText, matchStart, matchEnd, match[0], inertRangeIndexes, referenceIndex, clauses, postposedNegations);
      if (!clause) continue;
      const clauseText = normalizedText.slice(clause.start, clause.end);
      if (!hasIntentContextForKeyword(clauseText, match[0].toLowerCase())) continue;
      implicit.push({ keyword: match[0], skill, priority });
      break;
    }
  }

  const seenSkills = new Set<string>();
  return implicit.sort(compareKeywordMatches).filter((match) => {
    if (seenSkills.has(match.skill)) return false;
    seenSkills.add(match.skill);
    return true;
  });
}

function hasOmxQuestionAnsweredPrefix(text: string): boolean {
  return /^\s*\[omx question answered\]/i.test(text);
}

function hasIntentContextForKeyword(text: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  if (k === 'deep interview' || k === 'interview') {
    if (DEEP_INTERVIEW_MANAGEMENT_MENTION_PATTERN.test(text)
      && !DEEP_INTERVIEW_ACTIVATION_PATTERNS.some((pattern) => pattern.test(text))) {
      return false;
    }
    return DEEP_INTERVIEW_ACTIVATION_PATTERNS.some((pattern) => pattern.test(text));
  }
  if (!KEYWORDS_REQUIRING_INTENT.has(k)) return true;
  const patterns = KEYWORD_INTENT_PATTERNS[k as IntentKeyword];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classify one prompt with the direct-only explicit grammar and immutable
 * diagnostics. Consumers must share this result rather than re-detecting.
 */
export function classifyKeywordInput(text: string): KeywordInputClassification {
  const normalizedText = normalizeWorkflowKeyboardTypos(text);
  const referenceIndex = collectMarkdownReferenceIndex(normalizedText);
  const candidates = scanExplicitCandidates(normalizedText);
  const postposedNegations = collectPostposedExplicitNegationIndex(normalizedText, candidates);
  const { directIndexes, documentationRanges, documentationBlocks } = directCandidateIndexes(normalizedText, candidates, referenceIndex, postposedNegations);
  const implicitClauses = collectImplicitClauseIndex(normalizedText, documentationBlocks);
  for (const [index, candidate] of candidates.entries()) {
    if (!directIndexes.has(index)) candidate.reasons.add('not-leading-region');
  }

  const explicitMatches: KeywordMatch[] = [];
  const explicitSkills = new Set<string>();
  for (const index of directIndexes) {
    const candidate = candidates[index];
    if (!candidate.skill || candidate.priority === null || explicitSkills.has(candidate.skill)) continue;
    explicitSkills.add(candidate.skill);
    explicitMatches.push({
      keyword: candidate.rawKeyword,
      skill: candidate.skill,
      priority: candidate.priority,
    });
  }

  const markedQuestionAnswer = hasOmxQuestionAnsweredPrefix(normalizedText);
  const directPromptsInvocation = hasDirectPromptsInvocation(normalizedText, collectInertRangeIndexes(normalizedText), referenceIndex);
  const reservedInput: KeywordReservedInput = markedQuestionAnswer
    ? 'omx-question-answered'
    : directPromptsInvocation
      ? 'prompts'
      : null;
  const hasExplicitLikeInvocation = candidates.length > 0;
  const hasActiveExplicitLike = hasActiveExplicitLikeInvocation(candidates, documentationRanges, postposedNegations);
  const finalMatches = reservedInput
    ? []
    : explicitMatches.length > 0
      ? explicitMatches
      : hasActiveExplicitLike
        ? []
        : detectImplicitKeywords(normalizedText, candidates, referenceIndex, implicitClauses, postposedNegations);
  const implicitMatches = reservedInput || hasActiveExplicitLike
    ? []
    : finalMatches;

  return Object.freeze({
    originalText: text,
    normalizedText,
    candidates: freezeCandidates(candidates),
    explicitMatches: freezeMatches(explicitMatches),
    hasExplicitLikeInvocation,
    reservedInput,
    implicitMatches: freezeMatches(implicitMatches),
    matches: freezeMatches(finalMatches),
  });
}

/** Detect workflow matches using a fresh immutable input classification. */
export function detectKeywords(text: string): KeywordMatch[] {
  return [...classifyKeywordInput(text).matches];
}

/** Get the first match in classification order. */
export function detectPrimaryKeyword(text: string): KeywordMatch | null {
  return classifyKeywordInput(text).matches[0] ?? null;
}

function filterMatchesForTeamMode(matches: readonly KeywordMatch[], teamEnabled: boolean): KeywordMatch[] {
  return teamEnabled ? [...matches] : matches.filter((entry) => entry.skill !== 'team');
}

function detectPrimaryKeywordForTeamMode(classification: KeywordInputClassification, teamEnabled: boolean): KeywordMatch | null {
  return filterMatchesForTeamMode(classification.matches, teamEnabled)[0] ?? null;
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
  classification: KeywordInputClassification,
): boolean {
  const previousSkill = safeString(previous?.skill).trim();
  if (!previousSkill || previous?.active !== true || !isTrackedWorkflowMode(previousSkill)) {
    return false;
  }

  return isActiveSkillContinuationPrompt(text)
    || isNamedActiveSkillContinuationPrompt(text, previousSkill)
    || (
      classification.reservedInput === 'omx-question-answered'
      && (previousSkill === 'autopilot' || previousSkill === 'deep-interview')
    );
}


function isAutopilotSupervisedChildSkill(skill: string): boolean {
  return skill === 'code-review'
    || skill === 'ultraqa'
    || skill === 'ralplan'
    || skill === 'ultragoal'
    || skill === 'deep-interview';
}

const AUTOPILOT_SUPERVISED_TRACKED_CHILD_SKILLS: TrackedWorkflowMode[] = [
  'deep-interview',
  'ralplan',
  'ultragoal',
  'ultraqa',
];

// Mirror the `state_write` backend: an Autopilot phase advance across a planning
// gate boundary (deep-interview -> ralplan, ralplan -> ultragoal) must satisfy
// the same gate regardless of transport. The keyword handoff previously wrote
// `current_phase` directly here, bypassing the gate that CLI/MCP `state_write`
// enforces. When the gate is not satisfied we keep the current phase (do not
// advance) so a `$child` keyword alone cannot skip the gate.
async function resolveGatedSupervisedChildPhase(
  cwd: string,
  stateDir: string,
  sessionId: string | undefined,
  existing: Record<string, unknown> | null,
  requestedChildSkill: string,
): Promise<string> {
  if (!existing) return requestedChildSkill;
  const currentChildPhase = deriveAutopilotChildPhase(existing);
  const heldPhase = safeString(existing.current_phase).trim() || requestedChildSkill;
  const nextState = { ...existing, current_phase: requestedChildSkill };

  // Reuse the same semantic completion-gate the state_write backend enforces, so
  // the keyword path can't skip it either — e.g. an implementation phase
  // (ultragoal/rework/team/ralph) may not jump straight to ultraqa; code-review
  // must run first.
  if (validateAutopilotCompletionTransition(existing, nextState)) {
    return heldPhase;
  }

  if (currentChildPhase === 'deep-interview' && requestedChildSkill === 'ralplan') {
    const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd,
      sessionId,
      baseStateDir: stateDir,
      currentState: existing,
      nextState,
    });
    return gate.allowed ? requestedChildSkill : heldPhase;
  }

  if (currentChildPhase === 'ralplan' && requestedChildSkill === 'ultragoal') {
    const gate = canAdvanceAutopilotRalplanToUltragoal({
      cwd,
      sessionId,
      currentState: existing,
      nextState,
    });
    return gate.allowed ? requestedChildSkill : heldPhase;
  }

  // From a gated planning phase, the only forward advance is the immediate next
  // gated phase (handled above). A keyword that jumps further ahead would skip a
  // gate the state_write backend enforces, so hold the current phase.
  if (
    (currentChildPhase === 'deep-interview' || currentChildPhase === 'ralplan')
    && isForwardChildPhaseSkip(currentChildPhase, requestedChildSkill)
  ) {
    return heldPhase;
  }

  return requestedChildSkill;
}

// True when `requestedChildSkill` is a child phase strictly beyond the immediate
// next phase after `currentChildPhase` in the canonical Autopilot order — i.e. a
// forward jump that skips at least one phase.
function isForwardChildPhaseSkip(currentChildPhase: string, requestedChildSkill: string): boolean {
  const currentIndex = (AUTOPILOT_CHILD_PHASES as readonly string[]).indexOf(currentChildPhase);
  const requestedIndex = (AUTOPILOT_CHILD_PHASES as readonly string[]).indexOf(requestedChildSkill);
  return currentIndex >= 0 && requestedIndex > currentIndex + 1;
}

// Returns the phase actually written to autopilot-state.json (the gate-held
// phase when an advance was blocked), so callers can keep skill-active-state in
// sync with it.
async function resolveAutopilotSupervisedChildPhaseState(
  cwd: string,
  stateDir: string,
  sessionId: string | undefined,
  childSkill: string,
): Promise<string> {
  const { absolutePath } = resolveSeedStateFilePath(stateDir, 'autopilot', sessionId);
  const existingResult = await readJsonStateWithStatus(absolutePath);
  const existing = existingResult.state;
  const existingMode = safeString(existing?.mode).trim();

  if (existingResult.status === 'malformed') {
    throw new Error('Cannot advance supervised Autopilot child phase: autopilot detail state is malformed');
  }
  if (existing && existingMode !== 'autopilot') {
    throw new Error(`Cannot advance supervised Autopilot child phase: expected autopilot detail state, found ${existingMode || 'unknown'}`);
  }

  return resolveGatedSupervisedChildPhase(
    cwd,
    stateDir,
    sessionId,
    existing,
    childSkill,
  );
}

async function persistAutopilotSupervisedChildPhaseState(
  cwd: string,
  stateDir: string,
  sessionId: string | undefined,
  childSkill: string,
  nowIso: string,
  options: { threadId?: string; turnId?: string } = {},
): Promise<string> {
  const { absolutePath } = resolveSeedStateFilePath(stateDir, 'autopilot', sessionId);
  const existingResult = await readJsonStateWithStatus(absolutePath);
  const existing = existingResult.state;
  const existingMode = safeString(existing?.mode).trim();

  if (existingResult.status === 'malformed') {
    throw new Error('Cannot advance supervised Autopilot child phase: autopilot detail state is malformed');
  }
  if (existing && existingMode !== 'autopilot') {
    throw new Error(`Cannot advance supervised Autopilot child phase: expected autopilot detail state, found ${existingMode || 'unknown'}`);
  }

  const effectivePhase = await resolveGatedSupervisedChildPhase(
    cwd,
    stateDir,
    sessionId,
    existing,
    childSkill,
  );

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(withModeRuntimeContext(
    existing ?? {},
    {
      ...(existing ?? {}),
      active: true,
      mode: 'autopilot',
      current_phase: effectivePhase,
      started_at: safeString(existing?.started_at).trim() || nowIso,
      updated_at: nowIso,
      session_id: (sessionId ?? safeString(existing?.session_id).trim()) || undefined,
      thread_id: (options.threadId ?? safeString(existing?.thread_id).trim()) || undefined,
      turn_id: (options.turnId ?? safeString(existing?.turn_id).trim()) || undefined,
    },
    { nowIso },
  ), null, 2));

  return effectivePhase;
}

async function reconcileAutopilotSupervisedChildModeStates(
  cwd: string,
  stateDir: string,
  sessionId: string | undefined,
  childSkill: string,
  nowIso: string,
  options: { threadId?: string; turnId?: string } = {},
): Promise<{ completedPaths: string[]; effectivePhase: string }> {
  if (!isTrackedWorkflowMode(childSkill)) {
    const effectivePhase = await persistAutopilotSupervisedChildPhaseState(cwd, stateDir, sessionId, childSkill, nowIso, options);
    return { completedPaths: [], effectivePhase };
  }

  const effectivePhase = await resolveAutopilotSupervisedChildPhaseState(cwd, stateDir, sessionId, childSkill);
  if (effectivePhase !== childSkill) {
    return { completedPaths: [], effectivePhase };
  }

  const activeChildModes: TrackedWorkflowMode[] = [];
  for (const mode of AUTOPILOT_SUPERVISED_TRACKED_CHILD_SKILLS) {
    const candidatePaths = [
      resolveSeedStateFilePath(stateDir, mode as StatefulSkillMode, sessionId).absolutePath,
    ];
    for (const candidatePath of candidatePaths) {
      const existing = await readJsonStateIfExists(candidatePath);
      if (!existing || existing.active !== true || safeString(existing.mode).trim() !== mode) continue;
      activeChildModes.push(mode);
      break;
    }
  }

  const transition = await reconcileWorkflowTransition(cwd, childSkill, {
    action: 'activate',
    baseStateDir: stateDir,
    currentModes: activeChildModes,
    nowIso,
    sessionId,
    source: 'autopilot-supervised-child',
  });
  await persistAutopilotSupervisedChildPhaseState(cwd, stateDir, sessionId, childSkill, nowIso, options);
  return { completedPaths: transition.completedPaths, effectivePhase };
}

function isDeepInterviewRuntimeConfig(value: unknown): value is DeepInterviewRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<DeepInterviewRuntimeConfig>;
  return (
    (candidate.profile === 'quick' || candidate.profile === 'standard' || candidate.profile === 'deep')
    && typeof candidate.threshold === 'number'
    && Number.isFinite(candidate.threshold)
    && typeof candidate.maxRounds === 'number'
    && Number.isInteger(candidate.maxRounds)
    && typeof candidate.enableChallengeModes === 'boolean'
    && typeof candidate.sourcePath === 'string'
    && candidate.sourcePath.trim().length > 0
  );
}

function resolveContinuationKeywordMatch(
  text: string,
  previous: SkillActiveState | null,
  fallbackMatch: KeywordMatch | null,
  classification: KeywordInputClassification,
): KeywordMatch | null {
  const previousSkill = safeString(previous?.skill).trim();
  if (!previousSkill || previous?.active !== true || !isTrackedWorkflowMode(previousSkill)) {
    return fallbackMatch;
  }

  const markedQuestionAnswerContinuation = classification.reservedInput === 'omx-question-answered'
    && (previousSkill === 'autopilot' || previousSkill === 'deep-interview');
  if (classification.reservedInput || (!markedQuestionAnswerContinuation && classification.hasExplicitLikeInvocation)) {
    return markedQuestionAnswerContinuation
      ? {
          keyword: safeString(previous.keyword).trim() || `$${previousSkill}`,
          skill: previousSkill,
          priority: 0,
        }
      : fallbackMatch;
  }

  if (!shouldReusePreviousSkillForContinuation(text, previous, classification) && !safeString(fallbackMatch?.keyword).trim().startsWith('$')) {
    return fallbackMatch;
  }

  return {
    keyword: safeString(previous.keyword).trim() || `$${previousSkill}`,
    skill: previousSkill,
    priority: fallbackMatch?.priority ?? 0,
  };
}

function initialWorkflowPhaseForMode(mode: TrackedWorkflowMode): SkillActivePhase {
  if (mode === 'autoresearch') return 'executing';
  if (mode === 'autopilot') return 'deep-interview';
  return 'planning';
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
  suppressRootMutation = false,
): SkillActiveState | null | undefined {
  if (suppressRootMutation) return null;
  if (!sessionId) return nextState;
  if (previousRoot) return previousRoot;
  return null;
}

async function preflightKeywordTargetState(
  stateDir: string,
  sessionId: string,
  context: ResolvedPromptTurnContext,
  nowIso: string,
): Promise<ResolvedPromptTurnContext> {
  const targetDir = join(stateDir, 'sessions', sessionId);
  const evidence: Array<{ ownerCodexSessionId?: unknown; targetSessionId?: unknown }> = [];
  let filenames: string[];
  try {
    filenames = await readdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context;
    return preflightSelectedTargetOwner(context, [{ ownerCodexSessionId: {} }], 'native', nowIso);
  }
  for (const filename of filenames) {
    if (!filename.endsWith('-state.json') && filename !== SKILL_ACTIVE_STATE_FILE) continue;
    try {
      const value = JSON.parse(await readFile(join(targetDir, filename), 'utf8')) as unknown;
      evidence.push(...extractSelectedTargetOwnerEvidence(value));
    } catch {
      evidence.push({ ownerCodexSessionId: {} });
    }
  }
  return preflightSelectedTargetOwner(context, evidence, 'native', nowIso);
}

export async function recordSkillActivation(input: RecordSkillActivationInput): Promise<SkillActiveState | null> {
  const classification = input.classification ?? classifyKeywordInput(input.text);
  if (classification.originalText !== input.text) {
    throw new Error('Keyword input classification text does not match activation text');
  }

  const resolvedPromptTurnContext = input.resolvedPromptTurnContext;
  if (resolvedPromptTurnContext && resolvedPromptTurnContext.status !== 'authorized') return null;
  if (resolvedPromptTurnContext && input.sessionId !== resolvedPromptTurnContext.authorization.targetSessionId) return null;
  const suppressRootMutation = resolvedPromptTurnContext?.authorization.globalSideEffects === 'suppress';
  const provenanceOwnerCodexSessionId = resolvedPromptTurnContext?.authorization.ownerCodexSessionId;
  const applyProvenanceOwner = (state: SkillActiveState): SkillActiveState => (
    provenanceOwnerCodexSessionId
      ? {
        ...state,
        owner_codex_session_id: provenanceOwnerCodexSessionId,
        active_skills: state.active_skills?.map((entry) => ({ ...entry, owner_codex_session_id: provenanceOwnerCodexSessionId })),
      }
      : state
  );
  const sourceCwd = input.sourceCwd ?? dirname(dirname(input.stateDir));
  const rootStatePath = join(input.stateDir, SKILL_ACTIVE_STATE_FILE);
  const sessionStatePath = input.sessionId
    ? join(input.stateDir, 'sessions', input.sessionId, SKILL_ACTIVE_STATE_FILE)
    : null;
  if (resolvedPromptTurnContext && input.sessionId) {
    const preflight = await preflightKeywordTargetState(
      input.stateDir,
      input.sessionId,
      resolvedPromptTurnContext,
      input.nowIso ?? new Date().toISOString(),
    );
    if (preflight.status === 'rejected') {
      await input.onProvenanceRejected?.(preflight.diagnostic);
      return null;
    }
  }
  const previousRoot = suppressRootMutation ? null : await readExistingSkillState(rootStatePath);
  const previousSession = sessionStatePath ? await readExistingSkillState(sessionStatePath) : null;
  const previous = input.sessionId ? previousSession : previousRoot;
  const teamMode = readTeamModeConfig(sourceCwd);
  const match = resolveContinuationKeywordMatch(
    input.text,
    previous,
    detectPrimaryKeywordForTeamMode(classification, teamMode.enabled),
    classification,
  );
  if (!match) return null;


  const nowIso = input.nowIso ?? new Date().toISOString();
  const hadDeepInterviewLock = previous?.skill === 'deep-interview' && previous?.input_lock?.active === true;
  const matches = filterMatchesForTeamMode(classification.matches, teamMode.enabled);

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
      await writeSkillActiveStateCopiesForStateDir(
        input.stateDir,
        applyProvenanceOwner(state),
        input.sessionId,
        selectRootSkillStateCopy(previousRoot, state, input.sessionId, suppressRootMutation),
      );
      await persistDeepInterviewModeState(input.stateDir, applyProvenanceOwner(state), nowIso, previous, input);
    } catch (error) {
      console.warn('[omx] warning: failed to persist keyword activation state', error);
    }

    return applyProvenanceOwner(state);
  }

  const sameSkill = previous?.active === true && previous.skill === match.skill;
  const sameKeyword = previous?.keyword?.toLowerCase() === match.keyword.toLowerCase();
  const sameSkillContinuation = sameSkill && shouldReusePreviousSkillForContinuation(input.text, previous, classification);

  const matchedSeedConfig = STATEFUL_SKILL_SEED_CONFIG[match.skill as StatefulSkillMode];
  const matchedModeState = matchedSeedConfig
    ? await readJsonStateIfExists(resolveSeedStateFilePath(
      input.stateDir,
      matchedSeedConfig.mode,
      input.sessionId,
      matchedSeedConfig.scope,
    ).absolutePath)
    : null;
  const matchedModeTerminal = matchedSeedConfig
    ? isResettableTerminalModeState(matchedModeState as Record<string, unknown> | null, matchedSeedConfig.mode)
    : false;
  if (classification.reservedInput === 'omx-question-answered' && matchedModeTerminal) return null;
  const preserveActivatedAt = sameSkill && !matchedModeTerminal && (sameKeyword || sameSkillContinuation);
  const previousEntries = listActiveSkills(previous ?? {});
  const previousWorkflowEntries = previousEntries.filter((entry) => (
    isTrackedWorkflowMode(entry.skill)
    && (input.allowSecondaryAutopilot !== false || entry.skill !== 'autopilot' || entry.skill === match.skill)
    && (
      !input.sessionId
      || !safeString(entry.session_id).trim()
      || safeString(entry.session_id).trim() === safeString(input.sessionId).trim()
    )
  ));

  const isTrackedWorkflowMatch = isTrackedWorkflowMode(match.skill);
  const trackedMatchSkill = isTrackedWorkflowMatch ? match.skill : null;
  const markedQuestionAnswerContinuation = sameSkill
    && (match.skill === 'autopilot' || match.skill === 'deep-interview')
    && classification.reservedInput === 'omx-question-answered';
  const workflowMatches: TrackedWorkflowMode[] = isTrackedWorkflowMatch && !markedQuestionAnswerContinuation
    ? classification.explicitMatches
      .map((entry) => entry.skill)
      .filter((skill) => teamMode.enabled || skill !== 'team')
      .filter((skill) => input.allowSecondaryTeam !== false || skill !== 'team' || skill === trackedMatchSkill)
      .filter((skill) => input.allowSecondaryAutopilot !== false || skill !== 'autopilot' || skill === trackedMatchSkill)
      .filter(isTrackedWorkflowMode)
    : [];
  const resolvedWorkflowRequest = isTrackedWorkflowMatch
    ? resolveRequestedWorkflowSkills(workflowMatches.length > 0 ? workflowMatches : [trackedMatchSkill as TrackedWorkflowMode])
    : null;
  const requestedWorkflowSkills = resolvedWorkflowRequest?.requestedSkills ?? [];
  const deferredSkills = resolvedWorkflowRequest?.deferredSkills ?? [];
  const willActivateDeepInterview = match.skill === 'deep-interview'
    || requestedWorkflowSkills.includes('deep-interview');

  const deepInterviewInputLock = willActivateDeepInterview
    ? createDeepInterviewInputLock(nowIso, previous?.input_lock)
    : releaseDeepInterviewInputLock(previous?.input_lock, nowIso);
  const reusableDeepInterviewConfig = sameSkillContinuation && isDeepInterviewRuntimeConfig(previous?.deep_interview_config)
    ? previous.deep_interview_config
    : null;
  const deepInterviewConfig = willActivateDeepInterview
    ? reusableDeepInterviewConfig ?? resolveDeepInterviewRuntimeConfig({ cwd: sourceCwd, text: input.text })
    : null;

  if (input.allowSecondaryAutopilot !== false && previous?.active === true && previous.skill === 'autopilot' && isAutopilotSupervisedChildSkill(match.skill)) {
    try {
      // Reconcile first so skill-active phase reflects the gate-held phase the
      // autopilot detail state actually advanced to (a blocked advance keeps the
      // current phase).
      const { effectivePhase } = await reconcileAutopilotSupervisedChildModeStates(
        sourceCwd,
        input.stateDir,
        input.sessionId ?? previous.session_id,
        match.skill,
        nowIso,
        { threadId: input.threadId, turnId: input.turnId },
      );
      const nextState: SkillActiveState = {
        ...previous,
        version: 1,
        active: true,
        updated_at: nowIso,
        source: 'keyword-detector',
        session_id: input.sessionId ?? previous.session_id,
        thread_id: input.threadId ?? previous.thread_id,
        turn_id: input.turnId ?? previous.turn_id,
        phase: effectivePhase,
        active_skills: listActiveSkills(previous).map((entry) => (
          entry.skill === 'autopilot'
            ? {
                ...entry,
                phase: effectivePhase,
                active: true,
                updated_at: nowIso,
                session_id: input.sessionId ?? entry.session_id,
                thread_id: input.threadId ?? entry.thread_id,
                turn_id: input.turnId ?? entry.turn_id,
              }
            : entry
        )),
        supervised_child_keyword: match.keyword,
        supervised_child_skill: match.skill,
      };
      await writeSkillActiveStateCopiesForStateDir(
        input.stateDir,
        applyProvenanceOwner(nextState),
        input.sessionId,
        selectRootSkillStateCopy(previousRoot, nextState, input.sessionId, suppressRootMutation),
      );
      return applyProvenanceOwner(nextState);
    } catch (error) {
      return {
        ...previous,
        version: 1,
        active: true,
        updated_at: nowIso,
        source: 'keyword-detector',
        session_id: input.sessionId ?? previous.session_id,
        thread_id: input.threadId ?? previous.thread_id,
        turn_id: input.turnId ?? previous.turn_id,
        active_skills: listActiveSkills(previous),
        transition_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (isTrackedWorkflowMatch) {
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
          phase: previous?.phase || initialWorkflowPhaseForMode(trackedMatchSkill as TrackedWorkflowMode),
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
        let transition: Awaited<ReturnType<typeof reconcileWorkflowTransition>>;
        try {
          transition = await reconcileWorkflowTransition(
            sourceCwd,
            requestedMode,
            {
              action: 'activate',
              sessionId: input.sessionId,
              source: 'keyword-detector',
              baseStateDir: input.stateDir,
              currentModes: nextWorkflowEntries.map((entry) => entry.skill),
            },
          );
        } catch (error) {
          return {
            ...(previous ?? {}),
            version: 1,
            active: previous?.active ?? nextWorkflowEntries.length > 0,
            skill: previous?.skill || match.skill,
            keyword: previous?.keyword || match.keyword,
            phase: previous?.phase || initialWorkflowPhaseForMode(trackedMatchSkill as TrackedWorkflowMode),
            activated_at: previous?.activated_at || nowIso,
            updated_at: nowIso,
            source: 'keyword-detector',
            session_id: input.sessionId ?? previous?.session_id,
            thread_id: input.threadId ?? previous?.thread_id,
            turn_id: input.turnId ?? previous?.turn_id,
            active_skills: previousEntries,
            ...(previous?.input_lock ? { input_lock: previous.input_lock } : {}),
            transition_error: error instanceof Error ? error.message : String(error),
          };
        }
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
        existingEntry.phase = requestedMode === match.skill && (!sameSkill || matchedModeTerminal)
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
      ...(primarySkill === 'deep-interview' && deepInterviewConfig ? { deep_interview_config: deepInterviewConfig } : {}),
    };

    try {
      const ownedWorkflowState = applyProvenanceOwner(workflowState);
      let nextState: SkillActiveState = { ...ownedWorkflowState };
      for (const requestedEntry of nextWorkflowEntries) {
        const seeded = await persistStatefulSkillSeedState(
          input.stateDir,
          {
            ...ownedWorkflowState,
            skill: requestedEntry.skill,
            keyword: requestedEntry.skill === workflowState.skill ? workflowState.keyword : `$${requestedEntry.skill}`,
            phase: requestedEntry.phase || workflowState.phase,
            activated_at: requestedEntry.activated_at || workflowState.activated_at,
            updated_at: requestedEntry.updated_at || workflowState.updated_at,
            ...(requestedEntry.skill === 'deep-interview' && deepInterviewConfig ? { deep_interview_config: deepInterviewConfig } : {}),
          },
          nowIso,
          previous,
          input.text,
          sourceCwd,
          {
            activeContinuation: requestedEntry.skill === 'autopilot' && sameSkillContinuation,
            forceSessionScope: suppressRootMutation,
          },
        );
        if (requestedEntry.skill === workflowState.skill) {
          nextState = {
            ...ownedWorkflowState,
            initialized_mode: seeded.initialized_mode,
            initialized_state_path: seeded.initialized_state_path,
          };
        }
      }
      nextState = applyProvenanceOwner(nextState);
      nextState.active_skills = buildActiveSkills(nextState);
      await writeSkillActiveStateCopiesForStateDir(
        input.stateDir,
        nextState,
        input.sessionId,
        selectRootSkillStateCopy(previousRoot, nextState, input.sessionId, suppressRootMutation),
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
    ...(match.skill === 'deep-interview' && deepInterviewConfig ? { deep_interview_config: deepInterviewConfig } : {}),
  };

  try {
    const ownedState = applyProvenanceOwner(state);
    const nextState = await persistStatefulSkillSeedState(
      input.stateDir,
      ownedState,
      nowIso,
      previous,
      input.text,
      sourceCwd,
      {
        activeContinuation: match.skill === 'autopilot' && sameSkillContinuation,
        forceSessionScope: suppressRootMutation,
      },
    );
    const ownedNextState = applyProvenanceOwner(nextState);
    ownedNextState.active_skills = buildActiveSkills(ownedNextState);
    await writeSkillActiveStateCopiesForStateDir(
      input.stateDir,
      ownedNextState,
      input.sessionId,
      selectRootSkillStateCopy(previousRoot, ownedNextState, input.sessionId, suppressRootMutation),
    );
    await persistDeepInterviewModeState(input.stateDir, ownedNextState, nowIso, previous, input);
    return ownedNextState;
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
    .replace(/\b(?:ralph|autopilot|team|ultrawork|ulw)\b/gi, '')
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
  requireNativeSubagents?: boolean;
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
  const consensusComplete = hasDurableRalplanConsensusEvidenceForCwd(options.cwd ?? process.cwd(), {
    requireNativeSubagents: options.requireNativeSubagents,
  });
  const shortFollowupBypasses = executionKeywords.filter((keyword) => {
    if (keyword !== 'team' && keyword !== 'ralph') return false;
    return isApprovedExecutionFollowupShortcut(
      keyword as FollowupMode,
      text,
      {
        planningComplete: planningComplete && consensusComplete,
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
