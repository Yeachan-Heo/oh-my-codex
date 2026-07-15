import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getStatePath } from '../mcp/state-paths.js';
import {
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  isTrackedWorkflowMode,
  TRACKED_WORKFLOW_MODES,
  type TrackedWorkflowMode,
  type WorkflowTransitionAction,
  type WorkflowTransitionDecision,
} from './workflow-transition.js';
import {
  listTransitionActiveSkills,
  readVisibleSkillActiveState,
  readVisibleSkillActiveStateForStateDir,
  syncCanonicalSkillStateForMode,
} from './skill-active.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { normalizeTerminalWorkflowState } from './terminal-normalization.js';
import { clearDeepInterviewQuestionObligation } from '../question/deep-interview.js';
import {
  buildAutopilotDeepInterviewRalplanGateError,
  canAdvanceAutopilotDeepInterviewToRalplan,
} from '../autopilot/deep-interview-gate.js';

interface TransitionStateLike {
  active?: unknown;
  current_phase?: unknown;
  completed_at?: unknown;
  [key: string]: unknown;
}

export interface ReconciledWorkflowTransition {
  decision: WorkflowTransitionDecision;
  transitionMessage?: string;
  autoCompletedModes: TrackedWorkflowMode[];
  completedPaths: string[];
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonIfExists(
  path: string,
  options?: { mode?: TrackedWorkflowMode; throwOnParseError?: boolean },
): Promise<TransitionStateLike | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as TransitionStateLike;
  } catch {
    if (options?.throwOnParseError && options.mode) {
      throw new Error(
        `Cannot read ${options.mode} workflow state at ${path}. Repair or clear that workflow state yourself via \`omx state clear --input '{"mode":"${options.mode}"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
      );
    }
    return null;
  }
}

function modeStatePathForRoot(
  mode: TrackedWorkflowMode,
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): string {
  if (baseStateDir) {
    return sessionId
      ? join(baseStateDir, 'sessions', sessionId, `${mode}-state.json`)
      : join(baseStateDir, `${mode}-state.json`);
  }
  return getStatePath(mode, cwd, sessionId);
}


async function assertAuthoritativeWorkflowStateReadable(
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): Promise<void> {
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePath = modeStatePathForRoot(mode, cwd, sessionId, baseStateDir);
    await readJsonIfExists(candidatePath, { mode, throwOnParseError: true });
  }
}

function isActiveWorkflowDetail(state: TransitionStateLike | null): boolean {
  if (!state || state.active !== true) return false;
  const phase = safeString(state.current_phase).trim().toLowerCase();
  return !['complete', 'completed', 'cancelled', 'canceled', 'failed', 'cleared'].includes(phase);
}

async function visibleTrackedModes(
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): Promise<TrackedWorkflowMode[]> {
  const canonical = baseStateDir
    ? await readVisibleSkillActiveStateForStateDir(baseStateDir, sessionId)
    : await readVisibleSkillActiveState(cwd, sessionId);
  const canonicalModes = listTransitionActiveSkills(canonical ?? {}, sessionId)
    .map((entry) => entry.skill)
    .filter(isTrackedWorkflowMode);

  if (sessionId) return [...new Set(canonicalModes)];

  const activeDetailModes: TrackedWorkflowMode[] = [];
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const state = await readJsonIfExists(modeStatePathForRoot(mode, cwd, undefined, baseStateDir), {
      mode,
      throwOnParseError: true,
    });
    if (isActiveWorkflowDetail(state)) activeDetailModes.push(mode);
  }

  return [...new Set([...canonicalModes, ...activeDetailModes])];
}

async function completeSourceModeState(
  cwd: string,
  baseStateDir: string | undefined,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  sessionId: string | undefined,
  nowIso: string,
  source: string,
): Promise<string[]> {
  const transitionMessage = `mode transiting: ${sourceMode} -> ${destinationMode}`;
  const candidatePaths = [modeStatePathForRoot(sourceMode, cwd, sessionId, baseStateDir)];
  const completedPaths: string[] = [];

  for (const candidatePath of candidatePaths) {
    const existing = await readJsonIfExists(candidatePath, {
      mode: sourceMode,
      throwOnParseError: true,
    });
    if (!existing || existing.active !== true) continue;
    if (sourceMode === 'deep-interview' && destinationMode === 'ralplan') {
      const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
        cwd,
        sessionId,
        baseStateDir,
        deepInterviewState: existing,
      });
      if (!gate.allowed) {
        throw new Error(buildAutopilotDeepInterviewRalplanGateError(gate));
      }
    }

    const nextCandidate: TransitionStateLike = {
      ...existing,
      active: false,
      current_phase: 'completed',
      completed_at: safeString(existing.completed_at).trim() || nowIso,
      auto_completed_reason: transitionMessage,
      completion_note: `Auto-completed ${sourceMode} during allowlisted transition to ${destinationMode}.`,
      transition_source: source,
      transition_target_mode: destinationMode,
    };
    if (sourceMode === 'deep-interview') {
      const nextQuestionEnforcement = clearDeepInterviewQuestionObligation(
        existing.question_enforcement as Parameters<typeof clearDeepInterviewQuestionObligation>[0],
        'handoff',
        new Date(nowIso),
      );
      if (nextQuestionEnforcement) {
        nextCandidate.question_enforcement = nextQuestionEnforcement;
      } else {
        delete nextCandidate.question_enforcement;
      }
    }
    delete nextCandidate.run_outcome;
    const runOutcomeState = applyRunOutcomeContract(nextCandidate, { nowIso }).state as TransitionStateLike;
    const nextState = normalizeTerminalWorkflowState(runOutcomeState, { mode: sourceMode, nowIso }).state as TransitionStateLike;

    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(nextState, null, 2));
    completedPaths.push(candidatePath);
  }

  if (sourceMode === 'deep-interview' && destinationMode === 'ralplan' && completedPaths.length === 0) {
    const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd,
      sessionId,
      baseStateDir,
      deepInterviewState: null,
    });
    throw new Error(buildAutopilotDeepInterviewRalplanGateError(gate));
  }

  await syncCanonicalSkillStateForMode({
    cwd,
    ...(baseStateDir ? { baseStateDir } : {}),
    mode: sourceMode,
    active: false,
    currentPhase: 'completed',
    sessionId,
    nowIso,
    source,
  });

  return completedPaths;
}

export async function completeWorkflowModeState(
  cwd: string,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  options: {
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
  } = {},
): Promise<string[]> {
  return completeSourceModeState(
    cwd,
    options.baseStateDir,
    sourceMode,
    destinationMode,
    options.sessionId,
    options.nowIso ?? new Date().toISOString(),
    options.source ?? 'workflow-transition',
  );
}

export async function reconcileWorkflowTransition(
  cwd: string,
  requestedMode: TrackedWorkflowMode,
  options: {
    action?: WorkflowTransitionAction;
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
    currentModes?: Iterable<string>;
  } = {},
): Promise<ReconciledWorkflowTransition> {
  const {
    action = 'activate',
    sessionId,
    nowIso = new Date().toISOString(),
    source = 'workflow-transition',
    baseStateDir,
  } = options;
  if (!options.currentModes) {
    await assertAuthoritativeWorkflowStateReadable(cwd, sessionId, baseStateDir);
  }
  const currentModes = options.currentModes
    ? [...options.currentModes].filter(isTrackedWorkflowMode)
    : await visibleTrackedModes(cwd, sessionId, baseStateDir);
  const decision = evaluateWorkflowTransition(currentModes, requestedMode);

  if (!decision.allowed) {
    throw new Error(buildWorkflowTransitionError(currentModes, requestedMode, action));
  }

  const completedPaths: string[] = [];
  for (const sourceMode of decision.autoCompleteModes) {
    completedPaths.push(...await completeSourceModeState(
      cwd,
      baseStateDir,
      sourceMode,
      requestedMode,
      sessionId,
      nowIso,
      source,
    ));
  }

  return {
    decision,
    transitionMessage: decision.transitionMessage,
    autoCompletedModes: decision.autoCompleteModes,
    completedPaths,
  };
}
