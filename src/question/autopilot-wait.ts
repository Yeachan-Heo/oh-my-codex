import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getStateFilePath } from '../mcp/state-paths.js';
import type { DeepInterviewQuestionEnforcementState } from './deep-interview.js';

const AUTOPILOT_STATE_FILE = 'autopilot-state.json';

export interface AutopilotDeepInterviewQuestionWaitState {
  obligationId: string;
  previousPhase: string;
  requestedAt?: string;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizePhase(value: unknown): string {
  return safeString(value).toLowerCase().replace(/_/g, '-');
}

async function readAutopilotState(cwd: string, sessionId?: string): Promise<Record<string, unknown> | null> {
  const statePath = getStateFilePath(AUTOPILOT_STATE_FILE, cwd, sessionId);
  try {
    return JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeAutopilotState(cwd: string, sessionId: string | undefined, state: Record<string, unknown>): Promise<void> {
  const statePath = getStateFilePath(AUTOPILOT_STATE_FILE, cwd, sessionId);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function readAutopilotDeepInterviewQuestionWaitState(
  cwd: string,
  sessionId?: string,
): Promise<AutopilotDeepInterviewQuestionWaitState | null> {
  const state = await readAutopilotState(cwd, sessionId);
  if (!state || safeString(state.mode) !== 'autopilot') return null;

  const nestedState = safeObject(state.state);
  const wait = safeObject(nestedState.deep_interview_question);
  const obligationId = safeString(wait.obligation_id);
  if (!obligationId) return null;
  if (safeString(wait.status) !== 'waiting_for_user') return null;
  if (safeString(wait.source) !== 'omx-question') return null;

  const phase = normalizePhase(state.current_phase);
  const runOutcome = safeString(state.run_outcome);
  const lifecycleOutcome = safeString(state.lifecycle_outcome);
  if (phase !== 'waiting-for-user') return null;
  if (runOutcome && runOutcome !== 'blocked_on_user') return null;
  if (lifecycleOutcome && lifecycleOutcome !== 'askuserQuestion') return null;

  return {
    obligationId,
    previousPhase: safeString(wait.previous_phase) || 'deep-interview',
    requestedAt: safeString(wait.requested_at) || undefined,
  };
}

export async function canStartAutopilotDeepInterviewQuestion(
  cwd: string,
  sessionId?: string,
): Promise<boolean> {
  const state = await readAutopilotState(cwd, sessionId);
  if (!state || safeString(state.mode) !== 'autopilot' || state.active !== true) return false;
  return normalizePhase(state.current_phase) === 'deep-interview';
}

export async function markAutopilotDeepInterviewQuestionWaiting(
  cwd: string,
  sessionId: string | undefined,
  obligation: DeepInterviewQuestionEnforcementState,
): Promise<boolean> {
  if (!safeString(sessionId)) return false;
  const state = await readAutopilotState(cwd, sessionId);
  if (!state || safeString(state.mode) !== 'autopilot' || state.active !== true) return false;

  const currentPhase = safeString(state.current_phase) || 'deep-interview';
  if (normalizePhase(currentPhase) !== 'deep-interview') return false;

  const nestedState = safeObject(state.state);
  const wait = {
    status: 'waiting_for_user',
    source: 'omx-question',
    obligation_id: obligation.obligation_id,
    previous_phase: currentPhase,
    previous_run_outcome: state.run_outcome ?? null,
    previous_lifecycle_outcome: state.lifecycle_outcome ?? null,
    requested_at: obligation.requested_at,
    updated_at: new Date().toISOString(),
  };

  const nextState = {
    ...state,
    active: true,
    current_phase: 'waiting-for-user',
    run_outcome: 'blocked_on_user',
    lifecycle_outcome: 'askuserQuestion',
    updated_at: new Date().toISOString(),
    state: {
      ...nestedState,
      deep_interview_question: wait,
    },
  };

  await writeAutopilotState(cwd, sessionId, nextState);
  return true;
}

export async function resolveAutopilotDeepInterviewQuestionWaiting(
  cwd: string,
  sessionId: string | undefined,
  obligationId: string,
  status: 'satisfied' | 'cleared',
): Promise<boolean> {
  if (!safeString(sessionId) || !safeString(obligationId)) return false;
  const state = await readAutopilotState(cwd, sessionId);
  if (!state || safeString(state.mode) !== 'autopilot') return false;

  const nestedState = safeObject(state.state);
  const wait = safeObject(nestedState.deep_interview_question);
  if (safeString(wait.obligation_id) !== obligationId) return false;
  if (safeString(wait.status) !== 'waiting_for_user') return false;

  const previousRunOutcome = wait.previous_run_outcome;
  const previousLifecycleOutcome = wait.previous_lifecycle_outcome;
  const nextState: Record<string, unknown> = {
    ...state,
    active: true,
    current_phase: safeString(wait.previous_phase) || 'deep-interview',
    updated_at: new Date().toISOString(),
    state: {
      ...nestedState,
      deep_interview_question: {
        ...wait,
        status,
        resolved_at: new Date().toISOString(),
      },
    },
  };

  if (typeof previousRunOutcome === 'string' && previousRunOutcome.trim()) {
    nextState.run_outcome = previousRunOutcome;
  } else {
    delete nextState.run_outcome;
  }

  if (typeof previousLifecycleOutcome === 'string' && previousLifecycleOutcome.trim()) {
    nextState.lifecycle_outcome = previousLifecycleOutcome;
  } else {
    delete nextState.lifecycle_outcome;
  }

  await writeAutopilotState(cwd, sessionId, nextState);
  return true;
}
