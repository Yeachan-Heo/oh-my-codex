import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withModeRuntimeContext } from './mode-state-context.js';
import {
  getAllScopedStatePaths,
  getAuthoritativeActiveStateDirs,
  getBaseStateDir,
  getBaseStateDirWithSource,
  getReadScopedStateDirs,
  getReadScopedStatePaths,
  getStateDir,
  getStatePath,
  resolveRuntimeStateScope,
  resolveWritableStateScope,
  resolveWorkingDirectoryForState,
  validateSessionId,
  validateStateModeSegment,
  type StateRootSource,
} from '../mcp/state-paths.js';
import { evaluateRalphCompletionAuditEvidence } from '../ralph/completion-audit.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';
import { RALPH_PHASES, validateAndNormalizeRalphState } from '../ralph/contract.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { normalizeTerminalWorkflowState } from './terminal-normalization.js';
import {
  hasCleanAutopilotReviewAndQaEvidence,
  isAutopilotSuccessfulTerminalState,
  validateAutopilotCompletionTransition,
} from '../autopilot/completion-gate.js';
import { readUltragoalState } from '../hud/state.js';
import {
  SKILL_ACTIVE_STATE_MODE,
  clearTerminalSkillActiveMarkers,
  getSkillActiveStatePathsForStateDir,
  isTerminalSkillActiveState,
  isTransitionCanonicalStateOwned,
  listActiveSkills,
  listTransitionActiveSkills,
  readSkillActiveState,
  readVisibleSkillActiveStateForStateDir,
  syncCanonicalSkillStateForMode,
  type SkillActiveEntry,
  type SkillActiveStateLike,
  writeSkillActiveStateCopiesForStateDir,
} from './skill-active.js';
import {
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  isTrackedWorkflowMode,
  type TrackedWorkflowMode,
} from './workflow-transition.js';
import { reconcileWorkflowTransition } from './workflow-transition-reconcile.js';
import {
  buildAutopilotDeepInterviewRalplanGateError,
  canAdvanceAutopilotDeepInterviewToRalplan,
} from '../autopilot/deep-interview-gate.js';
import {
  type AutopilotChildPhase,
  deriveAutopilotChildPhase,
} from '../autopilot/fsm.js';
import {
  buildAutopilotRalplanUltragoalGateError,
  canAdvanceAutopilotRalplanToUltragoal,
} from '../autopilot/ralplan-gate.js';
import {
  isUnsupportedNativeSubagentEvidenceForScope,
} from '../leader/contract.js';
import {
  buildRalplanConsensusGateFromSources,
} from '../ralplan/consensus-gate.js';


const AUTOPILOT_CHILD_PHASE_ORDER: AutopilotChildPhase[] = [
  'deep-interview',
  'ralplan',
  'ultragoal',
  'rework',
  'team',
  'ralph',
  'code-review',
  'ultraqa',
];

function autopilotPhaseOrder(phase: AutopilotChildPhase | null): number {
  return phase ? AUTOPILOT_CHILD_PHASE_ORDER.indexOf(phase) : -1;
}

function isForwardAutopilotPhase(
  currentPhase: AutopilotChildPhase | null,
  nextPhase: AutopilotChildPhase | null,
): boolean {
  const currentOrder = autopilotPhaseOrder(currentPhase);
  const nextOrder = autopilotPhaseOrder(nextPhase);
  return currentOrder >= 0 && nextOrder > currentOrder;
}

function isNextAutopilotPhase(
  currentPhase: AutopilotChildPhase | null,
  nextPhase: AutopilotChildPhase | null,
): boolean {
  const currentOrder = autopilotPhaseOrder(currentPhase);
  const nextOrder = autopilotPhaseOrder(nextPhase);
  return currentOrder >= 0 && nextOrder === currentOrder + 1;
}

export const SUPPORTED_STATE_READ_MODES = [
  'autopilot',
  'autoresearch',
  'team',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
  'skill-active',
] as const;

export type SupportedStateReadMode = (typeof SUPPORTED_STATE_READ_MODES)[number];
export type StateOperationName =
  | 'state_read'
  | 'state_write'
  | 'state_clear'
  | 'state_list_active'
  | 'state_get_status';

export interface StateOperationResponse {
  payload: unknown;
  isError?: boolean;
}

const stateWriteQueues = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = stateWriteQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = tail.finally(() => gate);
  stateWriteQueues.set(path, queued);

  await tail.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateWriteQueues.get(path) === queued) {
      stateWriteQueues.delete(path);
    }
  }
}

async function writeAtomicFile(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, data, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function writeClearedSessionScopedModeState(
  path: string,
  mode: string,
  sessionId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const clearedState = withModeRuntimeContext({}, {
    mode,
    active: false,
    current_phase: 'cleared',
    updated_at: nowIso,
    completed_at: nowIso,
    session_id: sessionId,
  });
  await writeAtomicFile(path, JSON.stringify(clearedState, null, 2));
}

async function clearSessionNativeStopState(baseStateDir: string, sessionId: string): Promise<string[]> {
  const paths = [
    join(baseStateDir, 'native-stop-state.json'),
    join(baseStateDir, 'sessions', sessionId, 'native-stop-state.json'),
  ];
  const changed: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sessions = state.sessions && typeof state.sessions === 'object' && !Array.isArray(state.sessions)
      ? { ...(state.sessions as Record<string, unknown>) }
      : null;
    if (!sessions || !Object.prototype.hasOwnProperty.call(sessions, sessionId)) continue;
    delete sessions[sessionId];
    state.sessions = sessions;
    await writeAtomicFile(path, JSON.stringify(state, null, 2));
    changed.push(path);
  }
  return changed;
}

function readModeSupportsStrictValidation(mode: string): mode is SupportedStateReadMode {
  return SUPPORTED_STATE_READ_MODES.includes(mode as SupportedStateReadMode);
}

function validateStrictReadableMode(mode: unknown): string {
  const normalized = validateStateModeSegment(mode);
  if (!readModeSupportsStrictValidation(normalized)) {
    throw new Error(`mode must be one of: ${SUPPORTED_STATE_READ_MODES.join(', ')}`);
  }
  return normalized;
}

async function initializeStateEnvironment(
  cwd: string,
  effectiveSessionId?: string,
  rootSource?: StateRootSource,
): Promise<void> {
  await mkdir(getStateDir(cwd), { recursive: true });
  if (effectiveSessionId) {
    await mkdir(getStateDir(cwd, effectiveSessionId), { recursive: true });
  }
  if (rootSource === 'team-env') return;
  const { ensureTmuxHookInitialized } = await import('../cli/tmux-hook.js');
  await ensureTmuxHookInitialized(cwd);
}

function hasExplicitStateField(
  fields: Record<string, unknown>,
  customState: unknown,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key)
    || (
      customState != null
      && Object.prototype.hasOwnProperty.call(customState as Record<string, unknown>, key)
    );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalSessionId(value: unknown): string | undefined {
  try {
    return validateSessionId(stringValue(value).trim());
  } catch {
    return undefined;
  }
}

function normalizeCurrentPhaseAliasForWrite(
  state: Record<string, unknown>,
  fields: Record<string, unknown>,
  customState: unknown,
): void {
  const hasCanonicalPhase = hasExplicitStateField(fields, customState, 'current_phase');
  const hasAliasPhase = hasExplicitStateField(fields, customState, 'currentPhase');
  if (!hasCanonicalPhase && hasAliasPhase) {
    state.current_phase = state.currentPhase;
  }
  if (hasCanonicalPhase || hasAliasPhase) {
    delete state.currentPhase;
  }
}

function normalizeCleanAutopilotCompletionEvidence(state: Record<string, unknown>): void {
  if (!isAutopilotSuccessfulTerminalState(state) || !hasCleanAutopilotReviewAndQaEvidence(state)) return;

  const reviewVerdict = state.review_verdict;
  const qaVerdict = state.qa_verdict;
  const nestedState = { ...objectRecord(state.state) };
  const handoffArtifacts = { ...objectRecord(nestedState.handoff_artifacts ?? state.handoff_artifacts) };

  handoffArtifacts.code_review = reviewVerdict;
  handoffArtifacts.ultraqa = qaVerdict;
  state.handoff_artifacts = handoffArtifacts;
  state.return_to_ralplan_reason = null;
  nestedState.handoff_artifacts = handoffArtifacts;
  nestedState.review_verdict = reviewVerdict;
  nestedState.qa_verdict = qaVerdict;
  nestedState.return_to_ralplan_reason = null;
  state.state = nestedState;
}

function isCompleteRalplanTerminalState(state: Record<string, unknown>): boolean {
  const currentPhase = stringValue(state.current_phase).trim().toLowerCase();
  const gate = objectRecord(state.ralplan_consensus_gate);
  return state.active === false
    && currentPhase === 'complete'
    && gate.complete === true;
}

function isRalplanCompleteCloseoutAttempt(state: Record<string, unknown>): boolean {
  return state.active === false && hasCleanTerminalValue(state);
}
function stateContainsUnsupportedNativeSubagentEvidence(
  state: Record<string, unknown>,
  input: { cwd?: string; sessionId?: string } = {},
): boolean {
  const nestedState = objectRecord(state.state);
  const handoffArtifacts = objectRecord(state.handoff_artifacts);
  const nestedHandoffArtifacts = objectRecord(nestedState.handoff_artifacts);
  const ralplanHandoff = objectRecord(handoffArtifacts.ralplan);
  const nestedRalplanHandoff = objectRecord(nestedHandoffArtifacts.ralplan);
  return isUnsupportedNativeSubagentEvidenceForScope(state.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(nestedState.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(handoffArtifacts.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(nestedHandoffArtifacts.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(ralplanHandoff.native_subagent_support, input)
    || isUnsupportedNativeSubagentEvidenceForScope(nestedRalplanHandoff.native_subagent_support, input);
}

function hasNonCleanTerminalValue(state: Record<string, unknown>): boolean {
  const terminalValues = new Set(['blocked', 'cancelled', 'failed']);
  return terminalValues.has(stringValue(state.current_phase).trim().toLowerCase())
    || terminalValues.has(stringValue(state.status).trim().toLowerCase())
    || terminalValues.has(stringValue(state.outcome).trim().toLowerCase())
    || terminalValues.has(stringValue(state.terminal_outcome).trim().toLowerCase())
    || terminalValues.has(stringValue(state.lifecycle_outcome).trim().toLowerCase())
    || terminalValues.has(stringValue(state.run_outcome).trim().toLowerCase());
}

function hasCleanTerminalValue(state: Record<string, unknown>): boolean {
  const terminalValues = [
    state.current_phase,
    state.status,
    state.outcome,
    state.terminal_outcome,
    state.lifecycle_outcome,
    state.run_outcome,
  ];
  return terminalValues.some((value) => stringValue(value).trim().toLowerCase() === 'complete');
}

function hasCompleteRalplanConsensusGate(state: Record<string, unknown>): boolean {
  const nestedState = objectRecord(state.state);
  return objectRecord(state.ralplan_consensus_gate).complete === true
    || objectRecord(nestedState.ralplan_consensus_gate).complete === true;
}

function isApprovedUnsupportedNativeNonCleanRecoveryState(
  state: Record<string, unknown>,
  input: { cwd?: string; sessionId?: string } = {},
): boolean {
  if (state.active !== false) return false;
  if (hasCleanTerminalValue(state)) return false;
  if (hasCompleteRalplanConsensusGate(state)) return false;
  return stateContainsUnsupportedNativeSubagentEvidence(state, input) && hasNonCleanTerminalValue(state);
}

export function validateRalplanTerminalConsensus(
  cwd: string,
  state: Record<string, unknown>,
  sessionId: string | undefined,
  options: { requireNativeSubagents?: boolean } = {},
): string | null {
  if (!isRalplanCompleteCloseoutAttempt(state)) return null;
  if (stateContainsUnsupportedNativeSubagentEvidence(state, { cwd, sessionId })) {
    return 'Cannot complete ralplan cleanly while native subagent support is unavailable; terminalize the workflow as blocked/cancelled/failed or restart in a runtime with working native subagents.';
  }
  const stateSessionId = sessionId ?? optionalSessionId(state.session_id);
  const gate = buildRalplanConsensusGateFromSources([
    { source: 'state-write-ralplan-terminal', value: state, sessionId: stateSessionId },
  ], {
    cwd,
    sessionId: stateSessionId,
    requireNativeSubagents: options.requireNativeSubagents === true,
  });
  if (gate.complete === true) {
    if (options.requireNativeSubagents === true) {
      state.ralplan_consensus_gate = {
        ...objectRecord(state.ralplan_consensus_gate),
        ...gate,
      };
    }
    return null;
  }
  const details = gate.blockedDetails?.length ? ` Details: ${gate.blockedDetails.join('; ')}.` : '';
  const evidenceDescription = options.requireNativeSubagents === true
    ? 'tracker-backed native architect and critic consensus evidence'
    : 'architect and critic consensus evidence';
  return `ralplan complete state requires ${evidenceDescription} (${gate.blockedReason ?? 'missing_consensus'}).${details}`;
}

function buildRalplanTerminalState(
  state: Record<string, unknown>,
  sessionId: string | undefined,
  nowIso: string,
): Record<string, unknown> {
  const completedAt = stringValue(state.completed_at).trim() || nowIso;
  const terminalReason = stringValue(state.terminal_reason).trim() || 'ralplan consensus complete';
  return withModeRuntimeContext(state, {
    ...state,
    mode: 'ralplan',
    active: false,
    current_phase: 'complete',
    status: 'complete',
    updated_at: nowIso,
    completed_at: completedAt,
    terminal_reason: terminalReason,
    session_id: sessionId,
    ralplan_consensus_gate: {
      ...objectRecord(state.ralplan_consensus_gate),
      complete: true,
    },
  });
}

function buildRalplanTerminalSkillState(
  base: SkillActiveStateLike | null,
  terminalState: Record<string, unknown>,
  sessionId: string | undefined,
  nowIso: string,
): SkillActiveStateLike {
  const completedAt = stringValue(terminalState.completed_at).trim() || nowIso;
  const terminalReason = stringValue(terminalState.terminal_reason).trim() || 'ralplan consensus complete';
  return {
    ...(base ?? {}),
    version: 1,
    active: false,
    skill: 'ralplan',
    keyword: stringValue(base?.keyword).trim() || 'ralplan',
    phase: 'complete',
    activated_at: stringValue(base?.activated_at).trim() || stringValue(terminalState.started_at).trim() || nowIso,
    updated_at: nowIso,
    completed_at: completedAt,
    source: stringValue(base?.source).trim() || 'state-operations',
    ...(sessionId ? { session_id: sessionId } : {}),
    terminal_reason: terminalReason,
    active_skills: [],
  };
}

function buildRalplanSkillStateFromEntries(
  base: SkillActiveStateLike | null,
  terminalState: Record<string, unknown>,
  entries: SkillActiveEntry[],
  sessionId: string | undefined,
  nowIso: string,
): SkillActiveStateLike {
  if (entries.length === 0) {
    return buildRalplanTerminalSkillState(base, terminalState, sessionId, nowIso);
  }

  const primary = entries[0] as SkillActiveEntry;
  const activeBase = clearTerminalSkillActiveMarkers(base ?? {});
  return {
    ...activeBase,
    version: 1,
    active: true,
    skill: primary.skill,
    keyword: stringValue(activeBase.keyword).trim(),
    phase: primary.phase || stringValue(activeBase.phase).trim(),
    activated_at: primary.activated_at || stringValue(base?.activated_at).trim() || nowIso,
    updated_at: nowIso,
    source: stringValue(activeBase.source).trim() || 'state-operations',
    session_id: primary.session_id || undefined,
    thread_id: primary.thread_id || stringValue(activeBase.thread_id).trim() || undefined,
    turn_id: primary.turn_id || stringValue(activeBase.turn_id).trim() || undefined,
    active_skills: entries,
  };
}

function isTerminalSkillActiveTombstone(state: SkillActiveStateLike | null): boolean {
  return state !== null && isTerminalSkillActiveState(state);
}

function filterCompletedRalplanRootEntries(
  entries: SkillActiveEntry[],
  completedSessionId: string | undefined,
  rootScopeCompletion: boolean,
): SkillActiveEntry[] {
  return entries.filter((entry) => {
    const entrySessionId = stringValue(entry.session_id).trim();
    if (entry.skill !== 'ralplan') return true;
    if (completedSessionId && entrySessionId === completedSessionId) return false;
    if (rootScopeCompletion && entrySessionId.length === 0) return false;
    return true;
  });
}

function filterCompletedRalplanSessionEntries(entries: SkillActiveEntry[], sessionId: string): SkillActiveEntry[] {
  return entries.filter((entry) => {
    const entrySessionId = stringValue(entry.session_id).trim();
    return entrySessionId === sessionId && entry.skill !== 'ralplan';
  });
}

function skillActiveEntryKey(entry: Pick<SkillActiveEntry, 'skill' | 'session_id'>): string {
  return `${entry.skill}::${stringValue(entry.session_id).trim()}`;
}

function collectCompletedRalplanSessionEntries(
  sessionState: SkillActiveStateLike | null,
  rootState: SkillActiveStateLike | null,
  sessionId: string,
): SkillActiveEntry[] {
  const entries = new Map<string, SkillActiveEntry>();
  for (const entry of filterCompletedRalplanSessionEntries(listActiveSkills(rootState ?? {}), sessionId)) {
    entries.set(skillActiveEntryKey(entry), entry);
  }
  for (const entry of filterCompletedRalplanSessionEntries(listActiveSkills(sessionState ?? {}), sessionId)) {
    entries.set(skillActiveEntryKey(entry), entry);
  }
  return [...entries.values()];
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  JSON.parse(serialized);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicFile(path, serialized);
}

async function readJsonRecordIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return objectRecord(parsed);
  } catch {
    return null;
  }
}

function shouldWriteRootRalplanTerminalState(rootState: Record<string, unknown> | null, sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  return optionalSessionId(rootState?.session_id) === sessionId;
}

export async function completeRalplanSession(options: {
  cwd: string;
  baseStateDir: string;
  state: Record<string, unknown>;
  explicitSessionId?: string;
  requireNativeSubagents?: boolean;
}): Promise<boolean> {
  if (!isCompleteRalplanTerminalState(options.state)) return false;
  const writableScope = await resolveWritableStateScope(options.cwd, options.explicitSessionId);
  const sessionId = writableScope.sessionId;
  const validationError = validateRalplanTerminalConsensus(options.cwd, options.state, sessionId, {
    requireNativeSubagents: options.requireNativeSubagents === true,
  });
  if (validationError) throw new Error(validationError);

  const completedSessionId = sessionId ?? optionalSessionId(options.state.session_id);
  const rootScopeCompletion = !sessionId;

  const nowIso = new Date().toISOString();
  const rootState = buildRalplanTerminalState(options.state, sessionId, nowIso);
  const rootStatePath = getStatePath('ralplan', options.cwd);
  const existingRootState = await readJsonRecordIfExists(rootStatePath);
  const shouldWriteRootState = shouldWriteRootRalplanTerminalState(existingRootState, sessionId);

  if (shouldWriteRootState) {
    await writeAtomicJson(rootStatePath, rootState);
  }
  if (sessionId) {
    await writeAtomicJson(
      getStatePath('ralplan', options.cwd, sessionId),
      buildRalplanTerminalState(options.state, sessionId, nowIso),
    );
  }

  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(options.baseStateDir, sessionId);
  const rootSkillState = await readSkillActiveState(rootPath);
  const rootEntries = filterCompletedRalplanRootEntries(
    listActiveSkills(rootSkillState ?? {}),
    completedSessionId,
    rootScopeCompletion,
  );
  if (rootEntries.length > 0 || (shouldWriteRootState && rootSkillState !== null)) {
    await writeAtomicJson(rootPath, buildRalplanSkillStateFromEntries(rootSkillState, rootState, rootEntries, undefined, nowIso));
  } else if (rootSkillState !== null && !isTerminalSkillActiveTombstone(rootSkillState)) {
    await unlink(rootPath).catch(() => {});
  }
  if (sessionPath && sessionId) {
    const sessionSkillState = await readSkillActiveState(sessionPath);
    const sessionEntries = collectCompletedRalplanSessionEntries(sessionSkillState, rootSkillState, sessionId);
    if (sessionEntries.length > 0 || sessionSkillState !== null) {
      await writeAtomicJson(
        sessionPath,
        sessionEntries.length > 0
          ? buildRalplanSkillStateFromEntries(sessionSkillState ?? rootSkillState, rootState, sessionEntries, sessionId, nowIso)
          : buildRalplanTerminalSkillState(sessionSkillState, rootState, sessionId, nowIso),
      );
    }
  }
  return true;
}

export async function listStateStatuses(
  cwd: string,
  explicitSessionId?: string,
  mode?: string,
  options: { authoritativeActiveDecision?: boolean } = {},
): Promise<Record<string, unknown>> {
  const stateDirs = options.authoritativeActiveDecision
    ? await getAuthoritativeActiveStateDirs(cwd, explicitSessionId)
    : await getReadScopedStateDirs(cwd, explicitSessionId);
  const statuses: Record<string, unknown> = {};
  const seenModes = new Set<string>();

  for (const stateDir of stateDirs) {
    if (!existsSync(stateDir)) continue;
    const files = await readdir(stateDir);
    for (const file of files) {
      if (!file.endsWith('-state.json')) continue;
      const currentMode = file.replace('-state.json', '');
      if (!mode && currentMode === SKILL_ACTIVE_STATE_MODE) continue;
      if (mode && currentMode !== mode) continue;
      if (seenModes.has(currentMode)) continue;
      seenModes.add(currentMode);
      try {
        const data = JSON.parse(await readFile(join(stateDir, file), 'utf-8'));
        statuses[currentMode] = {
          active: data.active,
          phase: data.current_phase,
          path: join(stateDir, file),
          data,
        };
      } catch {
        statuses[currentMode] = { error: 'malformed state file' };
      }
    }
  }

  if (!mode || mode === 'ultragoal') {
    const ultragoal = await readUltragoalState(cwd).catch(() => null);
    if (ultragoal && (ultragoal.active || (mode === 'ultragoal' && !seenModes.has('ultragoal')))) {
      statuses.ultragoal = {
        active: ultragoal.active,
        phase: ultragoal.status,
        path: join(cwd, '.omx', 'ultragoal', 'goals.json'),
        data: ultragoal,
        source: 'ultragoal-artifacts',
      };
    }
  }

  return statuses;
}


export async function listActiveStateModes(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const cwd = resolveWorkingDirectoryForState(workingDirectory);
  const scope = await resolveRuntimeStateScope(cwd, explicitSessionId);
  const sessionId = scope.sessionId;
  const statuses = await listStateStatuses(cwd, sessionId, undefined, {
    authoritativeActiveDecision: true,
  });
  const canonicalState = await readVisibleSkillActiveStateForStateDir(getBaseStateDir(cwd), sessionId);
  const canonicalActiveModes = new Set(
    listTransitionActiveSkills(canonicalState ?? {}, sessionId).map((entry) => entry.skill),
  );
  const hasCanonicalVisibility = isTransitionCanonicalStateOwned(canonicalState, sessionId);

  return Object.entries(statuses)
    .filter(([mode, status]) => {
      if (!Boolean((status as { active?: unknown }).active)) return false;
      if (hasCanonicalVisibility && isTrackedWorkflowMode(mode)) {
        return canonicalActiveModes.has(mode);
      }
      return true;
    })
    .map(([mode]) => mode);
}

async function readCanonicalActiveWorkflowModes(
  baseStateDir: string,
  sessionId?: string,
): Promise<TrackedWorkflowMode[]> {
  const canonicalState = await readVisibleSkillActiveStateForStateDir(baseStateDir, sessionId);
  const activeModes = listTransitionActiveSkills(canonicalState ?? {}, sessionId)
    .map((entry) => entry.skill)
    .filter(isTrackedWorkflowMode);
  return [...new Set(activeModes)];
}

function isActiveDetailWorkflowState(state: Record<string, unknown>): boolean {
  if (state.active !== true) return false;
  const phase = typeof state.current_phase === 'string' ? state.current_phase.trim().toLowerCase() : '';
  return !['complete', 'completed', 'cancelled', 'canceled', 'failed', 'cleared'].includes(phase);
}

async function readSessionDetailTransitionModes(
  cwd: string,
  sessionId: string | undefined,
  requestedMode: TrackedWorkflowMode,
): Promise<TrackedWorkflowMode[] | undefined> {
  if (!sessionId || requestedMode !== 'ralplan') return undefined;
  const autopilotPath = getStatePath('autopilot', cwd, sessionId);
  if (existsSync(autopilotPath)) {
    try {
      const state = JSON.parse(await readFile(autopilotPath, 'utf-8')) as Record<string, unknown>;
      if (isActiveDetailWorkflowState(state)) return ['autopilot'];
    } catch {
      return undefined;
    }
  }

  const deepInterviewPath = getStatePath('deep-interview', cwd, sessionId);
  if (!existsSync(deepInterviewPath)) return undefined;

  try {
    const state = JSON.parse(await readFile(deepInterviewPath, 'utf-8')) as Record<string, unknown>;
    return isActiveDetailWorkflowState(state) ? ['deep-interview'] : undefined;
  } catch {
    return undefined;
  }
}

export async function executeStateOperation(
  name: StateOperationName,
  rawArgs: Record<string, unknown> = {},
): Promise<StateOperationResponse> {
  let cwd: string;
  let explicitSessionId: string | undefined;

  try {
    cwd = resolveWorkingDirectoryForState(rawArgs.workingDirectory as string | undefined);
    explicitSessionId = validateSessionId(rawArgs.session_id);
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'state_read': {
        const mode = validateStrictReadableMode(rawArgs.mode);
        const paths = await getReadScopedStatePaths(mode, cwd, explicitSessionId);
        const path = paths.find((candidate) => existsSync(candidate));
        if (!path) {
          return { payload: { exists: false, mode } };
        }
        const data = JSON.parse(await readFile(path, 'utf-8'));
        return { payload: data };
      }

      case 'state_write': {
        const stateScope = await resolveWritableStateScope(cwd, explicitSessionId);
        const effectiveSessionId = stateScope.sessionId;
        const mode = validateStateModeSegment(rawArgs.mode);
        const { baseStateDir, rootSource } = getBaseStateDirWithSource(cwd);
        await initializeStateEnvironment(cwd, effectiveSessionId, rootSource);
        const path = getStatePath(mode, cwd, effectiveSessionId);

        const {
          mode: _mode,
          workingDirectory: _workingDirectory,
          session_id: _sessionId,
          state: customState,
          ...fields
        } = rawArgs;
        let validationError: string | null = null;
        let transitionMessage: string | undefined;
        let ensureRalphArtifacts = false;

        await withStateWriteLock(path, async () => {
          let existing: Record<string, unknown> = {};
          if (existsSync(path)) {
            try {
              existing = JSON.parse(await readFile(path, 'utf-8'));
            } catch (error) {
              process.stderr.write(`[state] Failed to parse state file: ${error}\n`);
            }
          }

          const mergedRaw = {
            ...existing,
            ...fields,
            ...((customState as Record<string, unknown>) || {}),
          } as Record<string, unknown>;
          normalizeCurrentPhaseAliasForWrite(mergedRaw, fields, customState);
          delete mergedRaw.trustedPipelineProgress;
          if (!hasExplicitStateField(fields, customState, 'run_outcome')) {
            delete mergedRaw.run_outcome;
          }
          if (!hasExplicitStateField(fields, customState, 'lifecycle_outcome')) {
            delete mergedRaw.lifecycle_outcome;
          }
          if (!hasExplicitStateField(fields, customState, 'terminal_outcome')) {
            delete mergedRaw.terminal_outcome;
          }

          if (
            mode === 'ralph' &&
            effectiveSessionId &&
            typeof mergedRaw.owner_omx_session_id !== 'string'
          ) {
            mergedRaw.owner_omx_session_id = effectiveSessionId;
          }

          if (mode === 'ralph') {
            const originalPhase = mergedRaw.current_phase;
            const validation = validateAndNormalizeRalphState(mergedRaw);
            if (!validation.ok || !validation.state) {
              validationError = validation.error || `ralph.current_phase must be one of: ${RALPH_PHASES.join(', ')}`;
              return;
            }
            if (
              typeof originalPhase === 'string' &&
              typeof validation.state.current_phase === 'string' &&
              validation.state.current_phase !== originalPhase
            ) {
              validation.state.ralph_phase_normalized_from = originalPhase;
            }
            Object.assign(mergedRaw, validation.state);
            if (mergedRaw.current_phase === 'complete') {
              const completionAudit = evaluateRalphCompletionAuditEvidence(mergedRaw, cwd);
              if (!completionAudit.complete) {
                validationError = `ralph complete state requires passing completion_audit or repo-relative completion_audit_path (${completionAudit.reason})`;
                return;
              }
              delete mergedRaw.completion_audit_gate;
              delete mergedRaw.completion_audit_missing_reason;
              delete mergedRaw.completion_audit_blocked_at;
            }
            ensureRalphArtifacts = true;
          }

          if (mode !== SKILL_ACTIVE_STATE_MODE) {
            const runOutcomeValidation = applyRunOutcomeContract(mergedRaw);
            if (!runOutcomeValidation.ok || !runOutcomeValidation.state) {
              validationError = runOutcomeValidation.error || 'Invalid run outcome state';
              return;
            }
            Object.assign(mergedRaw, runOutcomeValidation.state);
            const terminalNormalization = normalizeTerminalWorkflowState(mergedRaw, { mode });
            Object.assign(mergedRaw, terminalNormalization.state);
          }

          if (mode === 'autopilot') {
            normalizeCleanAutopilotCompletionEvidence(mergedRaw);
          }

          const unsupportedNativeNonCleanRecovery = isApprovedUnsupportedNativeNonCleanRecoveryState(mergedRaw, { cwd, sessionId: effectiveSessionId });
          if (mode === 'ralplan' && !unsupportedNativeNonCleanRecovery) {
            validationError = validateRalplanTerminalConsensus(cwd, mergedRaw, effectiveSessionId, {
              requireNativeSubagents: true,
            });
            if (validationError) return;
          }

          const currentAutopilotChildPhase = mode === 'autopilot'
            ? deriveAutopilotChildPhase({ mode: 'autopilot', ...existing })
            : null;
          let nextAutopilotChildPhase = mode === 'autopilot'
            ? deriveAutopilotChildPhase({ mode: 'autopilot', ...mergedRaw })
            : null;

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'deep-interview'
            && isAutopilotSuccessfulTerminalState(mergedRaw)
          ) {
            validationError = 'Cannot complete Autopilot before ralplan gate: deep-interview may only advance to ralplan.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && isAutopilotSuccessfulTerminalState(mergedRaw)
          ) {
            validationError = 'Cannot complete Autopilot before ultragoal gate: ralplan may only advance to ultragoal.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && unsupportedNativeNonCleanRecovery
          ) {
            nextAutopilotChildPhase = currentAutopilotChildPhase;
          }

          if (mode === 'autopilot') {
            const completionTransitionError = validateAutopilotCompletionTransition(
              existing as Record<string, unknown>,
              mergedRaw,
            );
            if (completionTransitionError) {
              validationError = completionTransitionError;
              return;
            }
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'deep-interview'
            && isForwardAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
            && !isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            validationError = 'Cannot skip Autopilot ralplan gate: deep-interview may only advance to ralplan.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'deep-interview'
            && isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
              cwd,
              sessionId: effectiveSessionId,
              baseStateDir,
              currentState: existing as Record<string, unknown>,
              nextState: mergedRaw,
            });
            if (!gate.allowed) {
              validationError = buildAutopilotDeepInterviewRalplanGateError(gate);
              return;
            }
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && isForwardAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
            && !isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            validationError = 'Cannot skip Autopilot ultragoal gate: ralplan may only advance to ultragoal.';
            return;
          }

          if (
            mode === 'autopilot'
            && currentAutopilotChildPhase === 'ralplan'
            && isNextAutopilotPhase(currentAutopilotChildPhase, nextAutopilotChildPhase)
          ) {
            const gate = canAdvanceAutopilotRalplanToUltragoal({
              cwd,
              sessionId: effectiveSessionId,
              currentState: existing as Record<string, unknown>,
              nextState: mergedRaw,
            });
            if (!gate.allowed) {
              validationError = buildAutopilotRalplanUltragoalGateError(gate);
              return;
            }
          }

          if (isTrackedWorkflowMode(mode) && mergedRaw.active === true) {
            const activeCanonicalModes = await readCanonicalActiveWorkflowModes(baseStateDir, effectiveSessionId);
            const canonicalDecision = evaluateWorkflowTransition(activeCanonicalModes, mode);
            if (!canonicalDecision.allowed && canonicalDecision.denialReason === 'rollback') {
              validationError = buildWorkflowTransitionError(activeCanonicalModes, mode, 'write');
              return;
            }
            const transitionCurrentModes = mode === 'ralplan'
              ? (
                activeCanonicalModes.length > 0
                  ? activeCanonicalModes
                  : await readSessionDetailTransitionModes(cwd, effectiveSessionId, mode)
              )
              : undefined;
            try {
              const transition = await reconcileWorkflowTransition(cwd, mode, {
                action: 'write',
                sessionId: effectiveSessionId,
                source: 'state-operations',
                baseStateDir,
                ...(transitionCurrentModes ? { currentModes: transitionCurrentModes } : {}),
              });
              transitionMessage ??= transition.transitionMessage;
            } catch (error) {
              validationError = (error as Error).message;
              return;
            }
          }

          const merged = withModeRuntimeContext(existing, mergedRaw);
          await writeAtomicFile(path, JSON.stringify(merged, null, 2));
        });

        if (validationError) {
          return {
            payload: { error: validationError },
            isError: true,
          };
        }

        if (mode === SKILL_ACTIVE_STATE_MODE) {
          const state = await readSkillActiveState(path);
          if (state) {
            await writeSkillActiveStateCopiesForStateDir(baseStateDir, state, effectiveSessionId);
          }
        } else {
          if (mode === 'ralph' && ensureRalphArtifacts) {
            await ensureCanonicalRalphArtifacts(cwd, effectiveSessionId);
          }
          const data = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
          const ralplanCompletionHandled = mode === 'ralplan'
            && !isApprovedUnsupportedNativeNonCleanRecoveryState(data, { cwd, sessionId: effectiveSessionId })
            && await completeRalplanSession({
              cwd,
              baseStateDir,
              state: data,
              explicitSessionId,
              requireNativeSubagents: true,
            });

          if (!ralplanCompletionHandled) {
            await syncCanonicalSkillStateForMode({
              cwd,
              baseStateDir,
              mode,
              active: data.active === true,
              currentPhase: typeof data.current_phase === 'string' ? data.current_phase : undefined,
              sessionId: effectiveSessionId,
              source: 'state-operations',
            });
          }
        }

        return {
          payload: {
            success: true,
            mode,
            path,
            ...(transitionMessage ? { transition: transitionMessage } : {}),
          },
        };
      }

      case 'state_clear': {
        const mode = validateStateModeSegment(rawArgs.mode);
        const allSessions = rawArgs.all_sessions === true;
        const { baseStateDir, rootSource } = getBaseStateDirWithSource(cwd);

        if (allSessions) {
          const removedPaths: string[] = [];
          const paths = await getAllScopedStatePaths(mode, cwd);
          for (const path of paths) {
            if (!existsSync(path)) continue;
            await unlink(path);
            removedPaths.push(path);
          }
          const canonicalPaths = mode === SKILL_ACTIVE_STATE_MODE
            ? []
            : await getAllScopedStatePaths(SKILL_ACTIVE_STATE_MODE, cwd);
          if (canonicalPaths.some((path) => existsSync(path))) {
            await syncCanonicalSkillStateForMode({
              cwd,
              baseStateDir,
              mode,
              active: false,
              source: 'state-operations',
              allSessions: true,
            });
          }

          return {
            payload: {
              cleared: true,
              mode,
              all_sessions: true,
              removed: removedPaths.length,
              paths: removedPaths,
              warning: 'all_sessions clears global and session-scoped state files',
            },
          };
        }

        const stateScope = await resolveWritableStateScope(cwd, explicitSessionId);
        const effectiveSessionId = stateScope.sessionId;
        await initializeStateEnvironment(cwd, effectiveSessionId, rootSource);
        const path = getStatePath(mode, cwd, effectiveSessionId);
        if (
          mode !== SKILL_ACTIVE_STATE_MODE
          && effectiveSessionId
          && existsSync(getStatePath(mode, cwd))
        ) {
          await writeClearedSessionScopedModeState(path, mode, effectiveSessionId);
        } else if (existsSync(path)) {
          await unlink(path);
        }
        const nativeStopCleared = effectiveSessionId
          ? await clearSessionNativeStopState(baseStateDir, effectiveSessionId)
          : [];
        if (mode !== SKILL_ACTIVE_STATE_MODE) {
          await syncCanonicalSkillStateForMode({
            cwd,
            baseStateDir,
            mode,
            active: false,
            sessionId: effectiveSessionId,
            source: 'state-operations',
          });
        }
        return { payload: { cleared: true, mode, path, ...(nativeStopCleared.length > 0 ? { native_stop_cleared: nativeStopCleared } : {}) } };
      }

      case 'state_list_active': {
        const activeModes = await listActiveStateModes(cwd, explicitSessionId);
        return { payload: { active_modes: activeModes } };
      }

      case 'state_get_status': {
        const mode = typeof rawArgs.mode === 'string' ? rawArgs.mode.trim() : undefined;
        const statuses = await listStateStatuses(cwd, explicitSessionId, mode || undefined);
        return { payload: { statuses } };
      }
    }
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }
}
