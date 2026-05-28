import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  deriveAutopilotChildPhase,
  isAutopilotSupervisingChild,
  normalizeAutopilotPhase,
} from '../autopilot/fsm.js';
import { getStateFilePath } from '../mcp/state-paths.js';
import { sleep } from '../utils/sleep.js';
import type { DeepInterviewQuestionEnforcementState } from './deep-interview.js';

const AUTOPILOT_STATE_FILE = 'autopilot-state.json';
const AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_ENV =
  'OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS';
const AUTOPILOT_QUESTION_WAIT_LOCK_STALE_MS = 30_000;
const DEFAULT_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS = 10_000;
const MIN_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS = 1;
const MAX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS = 120_000;
export const AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV =
  'OMX_AUTOPILOT_DEEP_INTERVIEW_QUESTION_OBLIGATION_ID';

export interface AutopilotDeepInterviewQuestionWaitState {
  obligationId: string;
  previousPhase: string;
  requestedAt?: string;
}

export type AutopilotDeepInterviewQuestionWaitClaim =
  | 'started'
  | 'blocked'
  | 'not_applicable';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function resolveAutopilotQuestionWaitLockTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS;
  return Math.max(
    MIN_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS,
    Math.min(MAX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function isPendingAutopilotQuestionWait(wait: Record<string, unknown>): boolean {
  return safeString(wait.status) === 'waiting_for_user'
    && safeString(wait.source) === 'omx-question'
    && safeString(wait.obligation_id).length > 0;
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

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function maybeRecoverStaleAutopilotQuestionWaitLock(lockDir: string): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > AUTOPILOT_QUESTION_WAIT_LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
  }
  return false;
}

async function withAutopilotQuestionWaitLock<T>(
  cwd: string,
  sessionId: string,
  fn: () => Promise<T>,
  onTimeout: () => Promise<T> | T,
): Promise<T> {
  const statePath = getStateFilePath(AUTOPILOT_STATE_FILE, cwd, sessionId);
  const lockDir = `${statePath}.deep-interview-question.lock`;
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const timeoutMs = resolveAutopilotQuestionWaitLockTimeoutMs(process.env);
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleAutopilotQuestionWaitLock(lockDir)) continue;
      if (Date.now() > deadline) return await onTimeout();
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
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
  if (!isPendingAutopilotQuestionWait(wait)) return null;

  const phase = normalizeAutopilotPhase(state.current_phase);
  const runOutcome = safeString(state.run_outcome);
  const lifecycleOutcome = safeString(state.lifecycle_outcome);
  if (phase !== 'waiting-for-user') return null;
  if (runOutcome && runOutcome !== 'blocked_on_user') return null;
  if (lifecycleOutcome && lifecycleOutcome !== 'askuserQuestion') return null;
  const previousPhase = deriveAutopilotChildPhase(state);
  if (previousPhase !== 'deep-interview') return null;

  return {
    obligationId,
    previousPhase,
    requestedAt: safeString(wait.requested_at) || undefined,
  };
}

export async function canStartAutopilotDeepInterviewQuestion(
  cwd: string,
  sessionId?: string,
  options: { ownerObligationId?: string } = {},
): Promise<boolean> {
  const state = await readAutopilotState(cwd, sessionId);
  if (!isAutopilotSupervisingChild(state, 'deep-interview')) return false;
  const nestedState = safeObject(state?.state);
  const wait = safeObject(nestedState.deep_interview_question);
  if (!isPendingAutopilotQuestionWait(wait)) return true;

  const ownerObligationId = safeString(options.ownerObligationId);
  return ownerObligationId.length > 0
    && safeString(wait.obligation_id) === ownerObligationId;
}

export async function claimAutopilotDeepInterviewQuestionWaiting(
  cwd: string,
  sessionId: string | undefined,
  obligation: DeepInterviewQuestionEnforcementState,
): Promise<AutopilotDeepInterviewQuestionWaitClaim> {
  const normalizedSessionId = safeString(sessionId);
  if (!normalizedSessionId) return 'not_applicable';
  return await withAutopilotQuestionWaitLock(
    cwd,
    normalizedSessionId,
    async () => {
      const state = await readAutopilotState(cwd, normalizedSessionId);
      if (!state || safeString(state.mode) !== 'autopilot' || state.active !== true) {
        return 'not_applicable';
      }

      if (!isAutopilotSupervisingChild(state, 'deep-interview')) return 'not_applicable';
      const currentPhase = normalizeAutopilotPhase(state.current_phase) || 'deep-interview';

      const nestedState = safeObject(state.state);
      if (isPendingAutopilotQuestionWait(safeObject(nestedState.deep_interview_question))) {
        return 'blocked';
      }

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

      await writeAutopilotState(cwd, normalizedSessionId, nextState);
      return 'started';
    },
    () => 'blocked',
  );
}

export async function markAutopilotDeepInterviewQuestionWaiting(
  cwd: string,
  sessionId: string | undefined,
  obligation: DeepInterviewQuestionEnforcementState,
): Promise<boolean> {
  return await claimAutopilotDeepInterviewQuestionWaiting(cwd, sessionId, obligation) === 'started';
}

export async function resolveAutopilotDeepInterviewQuestionWaiting(
  cwd: string,
  sessionId: string | undefined,
  obligationId: string,
  status: 'satisfied' | 'cleared',
  options: { questionId?: string; clearReason?: 'handoff' | 'abort' | 'error'; now?: Date } = {},
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
  const resolvedAt = (options.now ?? new Date()).toISOString();
  const questionId = safeString(options.questionId);
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
        resolved_at: resolvedAt,
        ...(status === 'satisfied'
          ? {
              question_id: questionId || undefined,
              satisfied_at: resolvedAt,
              clear_reason: undefined,
              cleared_at: undefined,
            }
          : {
              clear_reason: options.clearReason ?? 'error',
              cleared_at: resolvedAt,
              question_id: undefined,
              satisfied_at: undefined,
            }),
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
