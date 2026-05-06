import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
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
  listActiveSkills,
  readVisibleSkillActiveState,
  syncCanonicalSkillStateForMode,
} from './skill-active.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { clearDeepInterviewQuestionObligation } from '../question/deep-interview.js';

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
        `Cannot read ${options.mode} workflow state at ${path}. Repair or clear that workflow state yourself via \`omx state clear --mode ${options.mode}\` or the \`omx_state.*\` MCP tools.`,
      );
    }
    return null;
  }
}

async function visibleTrackedModes(cwd: string, sessionId?: string): Promise<TrackedWorkflowMode[]> {
  const canonical = await readVisibleSkillActiveState(cwd, sessionId);
  const canonicalModes = listActiveSkills(canonical ?? {})
    .map((entry) => entry.skill)
    .filter(isTrackedWorkflowMode);

  const visibleModes = new Set<TrackedWorkflowMode>(canonicalModes);
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePaths = sessionId
      ? [getStatePath(mode, cwd, sessionId)]
      : [getStatePath(mode, cwd)];
    for (const candidatePath of candidatePaths) {
      const state = await readJsonIfExists(candidatePath, {
        mode,
        throwOnParseError: true,
      });
      if (state?.active === true) {
        visibleModes.add(mode);
      }
    }
  }

  return [...visibleModes];
}

async function completeSourceModeState(
  cwd: string,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  sessionId: string | undefined,
  nowIso: string,
  source: string,
): Promise<string[]> {
  const transitionMessage = `mode transiting: ${sourceMode} -> ${destinationMode}`;
  const candidatePaths = sessionId
    ? [getStatePath(sourceMode, cwd, sessionId)]
    : [getStatePath(sourceMode, cwd)];
  const completedPaths: string[] = [];

  for (const candidatePath of candidatePaths) {
    const existing = await readJsonIfExists(candidatePath);
    if (!existing || existing.active !== true) continue;

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
    const nextState = applyRunOutcomeContract(nextCandidate, { nowIso }).state as TransitionStateLike;

    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(nextState, null, 2));
    completedPaths.push(candidatePath);
  }

  await syncCanonicalSkillStateForMode({
    cwd,
    mode: sourceMode,
    active: false,
    currentPhase: 'completed',
    sessionId,
    nowIso,
    source,
  });

  return completedPaths;
}

export async function reconcileWorkflowTransition(
  cwd: string,
  requestedMode: TrackedWorkflowMode,
  options: {
    action?: WorkflowTransitionAction;
    sessionId?: string;
    nowIso?: string;
    source?: string;
    currentModes?: Iterable<string>;
  } = {},
): Promise<ReconciledWorkflowTransition> {
  const {
    action = 'activate',
    sessionId,
    nowIso = new Date().toISOString(),
    source = 'workflow-transition',
  } = options;
  const currentModes = options.currentModes
    ? [...options.currentModes].filter(isTrackedWorkflowMode)
    : await visibleTrackedModes(cwd, sessionId);
  const decision = evaluateWorkflowTransition(currentModes, requestedMode);

  if (!decision.allowed) {
    throw new Error(buildWorkflowTransitionError(currentModes, requestedMode, action));
  }

  const completedPaths: string[] = [];
  for (const sourceMode of decision.autoCompleteModes) {
    completedPaths.push(...await completeSourceModeState(
      cwd,
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
