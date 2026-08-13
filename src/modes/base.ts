/**
 * Base mode lifecycle management for oh-my-codex
 * All execution modes (autopilot, autoresearch, deep-interview, ralph, ultrawork, team, ultraqa, ralplan) share this base.
 */

import { readFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { withModeRuntimeContext } from '../state/mode-state-context.js';
import {
  isTrackedWorkflowMode,
} from '../state/workflow-transition.js';
import { reconcileWorkflowTransition } from '../state/workflow-transition-reconcile.js';
import { syncCanonicalSkillStateForMode } from '../state/skill-active.js';
import { validateAndNormalizeRalphState } from '../ralph/contract.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { validateAutopilotCompletionTransition } from '../autopilot/completion-gate.js';
import { syncRunStateFromModeState } from '../runtime/run-state.js';
import {
  createWritableCommitRevalidator,
  getAuthoritativeActiveStatePaths,
  getBaseStateDir,
  getReadScopedStateDirs,
  getReadScopedStatePaths,
  getStateFilename,
  resolveWritableStateScope,
} from '../mcp/state-paths.js';
import { completeRalplanSession, writeStateFile } from '../state/operations.js';
import { readNeutralizedRoutingOverlay } from '../ralplan/documented-leader-preflight.js';


export interface ModeState {
  active: boolean;
  mode: string;
  iteration: number;
  max_iterations: number;
  current_phase: string;
  run_outcome?: string;
  task_description?: string;
  started_at: string;
  completed_at?: string;
  last_turn_at?: string;
  error?: string;
  [key: string]: unknown;
}

export type ModeName = 'autopilot' | 'autoresearch' | 'deep-interview' | 'ralph' | 'ultrawork' | 'team' | 'ultraqa' | 'ultragoal' | 'ralplan';

/** @deprecated These mode names were removed in v4.6. Use the canonical modes instead. */
export type DeprecatedModeName = 'ultrapilot' | 'pipeline' | 'ecomode';

const DEPRECATED_MODES: Record<DeprecatedModeName, string> = {
  ultrapilot: 'Use "team" instead. ultrapilot has been merged into team mode.',
  pipeline: 'Use "team" instead. pipeline has been merged into team mode.',
  ecomode: 'Use "ultrawork" instead. ecomode has been merged into ultrawork mode.',
};

/**
 * Check if a mode name is deprecated and return a warning message if so.
 * Returns null if the mode is not deprecated.
 */
export function getDeprecationWarning(mode: string): string | null {
  const warning = DEPRECATED_MODES[mode as DeprecatedModeName];
  if (!warning) return null;
  return `[DEPRECATED] Mode "${mode}" is deprecated. ${warning}`;
}

function normalizeRalphModeStateOrThrow(state: ModeState): ModeState {
  const originalPhase = state.current_phase;
  const validation = validateAndNormalizeRalphState(state as Record<string, unknown>);
  if (!validation.ok || !validation.state) {
    throw new Error(validation.error || 'Invalid ralph mode state');
  }
  const normalized = validation.state as ModeState;
  if (
    typeof originalPhase === 'string'
    && typeof normalized.current_phase === 'string'
    && normalized.current_phase !== originalPhase
  ) {
    normalized.ralph_phase_normalized_from = originalPhase;
  }
  return normalized;
}

function applySharedRunOutcomeContractOrThrow(state: ModeState): ModeState {
  const validation = applyRunOutcomeContract(state as Record<string, unknown>);
  if (!validation.ok || !validation.state) {
    throw new Error(validation.error || 'Invalid run outcome state');
  }
  return validation.state as ModeState;
}

function normalizeModeStateOrThrow(mode: string, state: ModeState): ModeState {
  const normalized = mode === 'ralph'
    ? normalizeRalphModeStateOrThrow(state)
    : state;
  return applySharedRunOutcomeContractOrThrow(normalized);
}

function stateDir(projectRoot?: string): string {
  return getBaseStateDir(projectRoot);
}

export async function assertModeStartAllowed(
  mode: ModeName,
  _projectRoot?: string,
): Promise<void> {
  if (!isTrackedWorkflowMode(mode)) return;
}

/**
 * Start a mode. Checks for exclusive mode conflicts.
 */
export async function startMode(
  mode: ModeName,
  taskDescription: string,
  maxIterations: number = 50,
  projectRoot?: string,
  explicitSessionId?: string,
): Promise<ModeState> {
  const scope = await resolveWritableStateScope(projectRoot, explicitSessionId);
  const dir = stateDir(projectRoot);
  await mkdir(dir, { recursive: true });

  const baseStateDir = getBaseStateDir(projectRoot);
  const beforeCommit = createWritableCommitRevalidator({
    operation: 'startMode',
    cwd: projectRoot ?? process.cwd(),
    explicitSessionId,
    capturedScope: scope,
    baseStateDir,
  });
  let transitionMessage: string | undefined;
  if (isTrackedWorkflowMode(mode)) {
    const transition = await reconcileWorkflowTransition(projectRoot ?? process.cwd(), mode, {
      action: 'start',
      sessionId: scope.sessionId,
      source: 'startMode',
      baseStateDir,
      beforeCommit,
    });
    transitionMessage = transition.transitionMessage;
  }
  await mkdir(scope.stateDir, { recursive: true });

  const stateBase: ModeState = {
    active: true,
    mode,
    iteration: 0,
    max_iterations: maxIterations,
    current_phase: 'starting',
    task_description: taskDescription,
    started_at: new Date().toISOString(),
    ...(transitionMessage ? { transition_message: transitionMessage } : {}),
    ...(mode === 'ralph' && scope.sessionId ? { owner_omx_session_id: scope.sessionId } : {}),
  };

  const withContext = withModeRuntimeContext({}, stateBase) as ModeState;
  const state = normalizeModeStateOrThrow(mode, withContext);
  const payload = JSON.stringify(state, null, 2);
  const path = join(scope.stateDir, getStateFilename(mode));
  await beforeCommit({ site: 'mode.primary', kind: 'write', path });
  await writeStateFile(path, payload);
  await syncRunStateFromModeState(state, projectRoot, scope.sessionId, {
    beforeCommit,
    targetPath: join(scope.stateDir, 'run-state.json'),
  });
  if (isTrackedWorkflowMode(mode)) {
    await syncCanonicalSkillStateForMode({
      cwd: projectRoot ?? process.cwd(),
      baseStateDir,
      mode,
      active: true,
      currentPhase: typeof state.current_phase === 'string' ? state.current_phase : undefined,
      sessionId: scope.sessionId,
      source: 'startMode',
      beforeCommit,
    });
  }
  return state;
}

/**
 * Read current mode state
 */
export async function readModeState(mode: string, projectRoot?: string): Promise<ModeState | null> {
  const paths = await getReadScopedStatePaths(mode, projectRoot);
  return readModeStateFromPaths(paths);
}

async function readModeStateFromPaths(paths: string[]): Promise<ModeState | null> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const canonical = JSON.parse(await readFile(path, 'utf-8')) as ModeState;
      if (canonical.mode === 'ralplan') {
        const overlay = await readNeutralizedRoutingOverlay(path, 'ralplan');
        if (overlay) return overlay as ModeState;
      }
      return canonical;
    } catch {
      return null;
    }
  }
  return null;
}

export async function readModeStateForSession(
  mode: string,
  sessionId: string | undefined,
  projectRoot?: string,
): Promise<ModeState | null> {
  let paths: string[];
  try {
    paths = await getReadScopedStatePaths(mode, projectRoot, sessionId);
  } catch {
    return null;
  }
  return readModeStateFromPaths(paths);
}

export async function readModeStateForExplicitSession(
  mode: string,
  sessionId: string,
  projectRoot?: string,
): Promise<ModeState | null> {
  const scope = await resolveWritableStateScope(projectRoot, sessionId);
  if (!scope.sessionId) return null;
  return readModeStateFromPaths([join(scope.stateDir, getStateFilename(mode))]);
}

export async function readModeStateForActiveDecision(
  mode: string,
  sessionId: string | undefined,
  projectRoot?: string,
): Promise<ModeState | null> {
  let paths: string[];
  try {
    paths = await getAuthoritativeActiveStatePaths(mode, projectRoot, sessionId);
  } catch {
    return null;
  }
  return readModeStateFromPaths(paths);
}

function assertRalphUpdateMatchesSession(state: ModeState, sessionId?: string): void {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return;

  const ownerOmxSessionId = typeof state.owner_omx_session_id === 'string'
    ? state.owner_omx_session_id.trim()
    : '';
  if (ownerOmxSessionId && ownerOmxSessionId !== normalizedSessionId) {
    throw new Error(`Mode ralph state belongs to another session (${ownerOmxSessionId})`);
  }

  const stateSessionId = typeof state.session_id === 'string' ? state.session_id.trim() : '';
  if (stateSessionId && stateSessionId !== normalizedSessionId) {
    throw new Error(`Mode ralph state belongs to another session (${stateSessionId})`);
  }
}

/**
 * Update mode state (merge fields)
 */
export async function updateModeState(
  mode: string,
  updates: Partial<ModeState>,
  projectRoot?: string,
  explicitSessionId?: string,
): Promise<ModeState> {
  return updateModeStateInternal(mode, updates, projectRoot, explicitSessionId, false);
}

/** Persists Autopilot pipeline bookkeeping while enforcing the ralplan-to-ultragoal gate. */
export async function updateAutopilotPipelineState(
  updates: Partial<ModeState>,
  projectRoot?: string,
  explicitSessionId?: string,
): Promise<ModeState> {
  return updateModeStateInternal('autopilot', updates, projectRoot, explicitSessionId, true);
}

async function updateModeStateInternal(
  mode: string,
  updates: Partial<ModeState>,
  projectRoot: string | undefined,
  explicitSessionId: string | undefined,
  pipelineProgressWrite: boolean,
): Promise<ModeState> {
  const scope = await resolveWritableStateScope(projectRoot, explicitSessionId);
  const baseStateDir = getBaseStateDir(projectRoot);
  const beforeCommit = createWritableCommitRevalidator({
    operation: 'updateModeState',
    cwd: projectRoot ?? process.cwd(),
    explicitSessionId,
    capturedScope: scope,
    baseStateDir,
  });
  const current = mode === 'ralph' && scope.sessionId
    ? await readModeStateForActiveDecision(mode, scope.sessionId, projectRoot)
    : explicitSessionId
      ? await readModeStateForExplicitSession(mode, explicitSessionId, projectRoot)
      : await readModeState(mode, projectRoot);
  if (!current) throw new Error(`Mode ${mode} not found`);
  await mkdir(scope.stateDir, { recursive: true });

  if (mode === 'ralph') {
    assertRalphUpdateMatchesSession(current, scope.sessionId);
  }

  const updatedBase = { ...current, ...updates };
  if (mode === 'autopilot') {
    const submittedSessionId = typeof updates.session_id === 'string' ? updates.session_id.trim() : '';
    if (submittedSessionId && scope.sessionId && submittedSessionId !== scope.sessionId) {
      throw new Error('autopilot.session_id must match the selected writable session scope');
    }
    const canonicalWorkspace = projectRoot ?? process.cwd();
    const submittedWorkingDirectory = typeof updates.workingDirectory === 'string' ? updates.workingDirectory.trim() : '';
    if (submittedWorkingDirectory && submittedWorkingDirectory !== canonicalWorkspace) {
      throw new Error('autopilot.workingDirectory must match the selected writable workspace');
    }
    if (scope.sessionId) updatedBase.session_id = scope.sessionId;
    updatedBase.workingDirectory = canonicalWorkspace;
    const currentHandoffs = current.handoff_artifacts && typeof current.handoff_artifacts === 'object'
      ? current.handoff_artifacts as Record<string, unknown>
      : {};
    const nextHandoffs = updates.handoff_artifacts && typeof updates.handoff_artifacts === 'object'
      ? updates.handoff_artifacts as Record<string, unknown>
      : {};
    if (Object.keys(currentHandoffs).length > 0 || Object.keys(nextHandoffs).length > 0) {
      updatedBase.handoff_artifacts = { ...currentHandoffs, ...nextHandoffs };
    }
  }
  delete updatedBase.trustedPipelineProgress;
  if (!Object.prototype.hasOwnProperty.call(updates, 'run_outcome')) {
    delete updatedBase.run_outcome;
  }
  if (mode === 'ralph' && scope.sessionId && typeof updatedBase.owner_omx_session_id !== 'string') {
    updatedBase.owner_omx_session_id = scope.sessionId;
  }
  const normalizedBase = normalizeModeStateOrThrow(mode, updatedBase as ModeState);
  if (mode === 'autopilot') {
    const completionTransitionError = validateAutopilotCompletionTransition(
      current as Record<string, unknown>,
      normalizedBase as Record<string, unknown>,
      { allowUnknownActivePhaseCompletion: pipelineProgressWrite },
    );
    if (completionTransitionError) throw new Error(completionTransitionError);
  }
  const updated = withModeRuntimeContext(current, normalizedBase) as ModeState;
  const payload = JSON.stringify(updated, null, 2);
  const path = join(scope.stateDir, getStateFilename(mode));
  await beforeCommit({ site: 'mode.primary', kind: 'write', path });
  await writeStateFile(path, payload);
  await syncRunStateFromModeState(updated, projectRoot, scope.sessionId, {
    beforeCommit,
    targetPath: join(scope.stateDir, 'run-state.json'),
  });
  if (isTrackedWorkflowMode(mode)) {
    const cwd = projectRoot ?? process.cwd();
    const ralplanCompletionHandled = mode === 'ralplan' && await completeRalplanSession({
      cwd,
      baseStateDir,
      state: updated as Record<string, unknown>,
      explicitSessionId,
      beforeCommit,
      capturedScope: scope,
    });
    if (!ralplanCompletionHandled) {
      await syncCanonicalSkillStateForMode({
        cwd,
        baseStateDir,
        mode,
        active: updated.active === true,
        currentPhase: typeof updated.current_phase === 'string' ? updated.current_phase : undefined,
        sessionId: scope.sessionId,
        source: 'updateModeState',
        beforeCommit,
      });
    }
  }
  return updated;
}

/**
 * Cancel a mode
 */
export async function cancelMode(mode: string, projectRoot?: string): Promise<void> {
  const state = await readModeState(mode, projectRoot);
  if (state && state.active) {
    await updateModeState(mode, {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }, projectRoot);
  }
}

/**
 * Cancel all active modes
 */
export async function cancelAllModes(projectRoot?: string): Promise<string[]> {
  const dirs = await getReadScopedStateDirs(projectRoot);
  const cancelled: string[] = [];
  const seenModes = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith('-state.json')) continue;
      const mode = f.replace('-state.json', '');
      if (seenModes.has(mode)) continue;
      seenModes.add(mode);
      const state = await readModeState(mode, projectRoot);
      if (state?.active) {
        await cancelMode(mode, projectRoot);
        cancelled.push(mode);
      }
    }
  }
  return cancelled;
}

/**
 * List all active modes
 */
export async function listActiveModes(projectRoot?: string): Promise<Array<{ mode: string; state: ModeState }>> {
  const dirs = await getReadScopedStateDirs(projectRoot);
  const active: Array<{ mode: string; state: ModeState }> = [];
  const seenModes = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith('-state.json')) continue;
      const mode = f.replace('-state.json', '');
      if (seenModes.has(mode)) continue;
      seenModes.add(mode);
      const state = await readModeState(mode, projectRoot);
      if (state?.active) {
        active.push({ mode, state });
      }
    }
  }
  return active;
}
