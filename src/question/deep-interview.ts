import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getStateFilePath, readCurrentSessionId } from '../mcp/state-paths.js';
import {
  runOmxQuestion,
  type OmxQuestionClientOptions,
  type OmxQuestionSuccessPayload,
} from './client.js';
import {
  getQuestionRecordPath,
  getQuestionStateDir,
  readQuestionRecord,
} from './state.js';
import type { TerminalLifecycleOutcome } from '../runtime/terminal-lifecycle.js';
import type { QuestionInput, QuestionRecord } from './types.js';

const DEEP_INTERVIEW_STATE_FILE = 'deep-interview-state.json';

export interface DeepInterviewQuestionEnforcementState {
  obligation_id: string;
  source: 'omx-question';
  status: 'pending' | 'satisfied' | 'cleared';
  lifecycle_outcome: 'askuserQuestion';
  requested_at: string;
  question_id?: string;
  satisfied_at?: string;
  cleared_at?: string;
  clear_reason?: 'handoff' | 'abort' | 'error';
}

interface DeepInterviewStateRecord {
  updated_at?: string;
  lifecycle_outcome?: TerminalLifecycleOutcome;
  question_enforcement?: DeepInterviewQuestionEnforcementState;
  [key: string]: unknown;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseTimestampMs(value: unknown): number | null {
  const raw = safeString(value).trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildObligationId(now = new Date()): string {
  return `deep-interview-question-${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 10)}`;
}

async function readDeepInterviewStateIfExists(
  cwd: string,
  sessionId?: string,
): Promise<DeepInterviewStateRecord | null> {
  const statePath = getStateFilePath(DEEP_INTERVIEW_STATE_FILE, cwd, sessionId);
  try {
    return JSON.parse(await readFile(statePath, 'utf-8')) as DeepInterviewStateRecord;
  } catch {
    return null;
  }
}

async function writeDeepInterviewState(
  cwd: string,
  state: DeepInterviewStateRecord,
  sessionId?: string,
): Promise<void> {
  const statePath = getStateFilePath(DEEP_INTERVIEW_STATE_FILE, cwd, sessionId);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function createDeepInterviewQuestionObligation(
  now = new Date(),
): DeepInterviewQuestionEnforcementState {
  return {
    obligation_id: buildObligationId(now),
    source: 'omx-question',
    status: 'pending',
    lifecycle_outcome: 'askuserQuestion',
    requested_at: now.toISOString(),
  };
}

export function isPendingDeepInterviewQuestionEnforcement(
  enforcement: Partial<DeepInterviewQuestionEnforcementState> | null | undefined,
): enforcement is DeepInterviewQuestionEnforcementState {
  return safeString(enforcement?.obligation_id).trim() !== ''
    && safeString(enforcement?.status).trim().toLowerCase() === 'pending';
}

export function satisfyDeepInterviewQuestionObligation(
  enforcement: DeepInterviewQuestionEnforcementState,
  questionId: string,
  now = new Date(),
): DeepInterviewQuestionEnforcementState {
  return {
    ...enforcement,
    status: 'satisfied',
    question_id: questionId,
    satisfied_at: now.toISOString(),
    cleared_at: undefined,
    clear_reason: undefined,
  };
}

export function clearDeepInterviewQuestionObligation(
  enforcement: DeepInterviewQuestionEnforcementState | undefined,
  reason: 'handoff' | 'abort' | 'error',
  now = new Date(),
): DeepInterviewQuestionEnforcementState | undefined {
  if (!enforcement) return undefined;
  if (enforcement.status !== 'pending') return enforcement;
  return {
    ...enforcement,
    status: 'cleared',
    cleared_at: now.toISOString(),
    clear_reason: reason,
  };
}

function isSameSessionQuestionRecord(record: QuestionRecord, sessionId: string): boolean {
  const recordSessionId = safeString(record.session_id).trim();
  return !recordSessionId || recordSessionId === sessionId;
}

function isAnsweredDeepInterviewRecordForObligation(
  record: QuestionRecord | null,
  sessionId: string,
  enforcement: DeepInterviewQuestionEnforcementState,
): record is QuestionRecord {
  if (!record) return false;
  if (!isSameSessionQuestionRecord(record, sessionId)) return false;
  if (safeString(record.source).trim() !== 'deep-interview') return false;
  if (record.status !== 'answered' || !record.answer) return false;

  const requestedAtMs = parseTimestampMs(enforcement.requested_at);
  const createdAtMs = parseTimestampMs(record.created_at);
  if (requestedAtMs !== null && (createdAtMs === null || createdAtMs < requestedAtMs)) {
    return false;
  }

  return true;
}

async function findAnsweredDeepInterviewRecordForObligation(
  cwd: string,
  sessionId: string,
  enforcement: DeepInterviewQuestionEnforcementState,
): Promise<QuestionRecord | null> {
  const exactQuestionId = safeString(enforcement.question_id).trim();
  if (exactQuestionId) {
    const exactRecord = await readQuestionRecord(
      getQuestionRecordPath(cwd, exactQuestionId, sessionId),
    );
    if (isAnsweredDeepInterviewRecordForObligation(exactRecord, sessionId, enforcement)) {
      return exactRecord;
    }
  }

  let entries: string[];
  try {
    entries = await readdir(getQuestionStateDir(cwd, sessionId));
  } catch {
    return null;
  }

  const candidates: QuestionRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const record = await readQuestionRecord(join(getQuestionStateDir(cwd, sessionId), entry));
    if (isAnsweredDeepInterviewRecordForObligation(record, sessionId, enforcement)) {
      candidates.push(record);
    }
  }

  candidates.sort((left, right) => {
    const leftCreatedAt = parseTimestampMs(left.created_at) ?? 0;
    const rightCreatedAt = parseTimestampMs(right.created_at) ?? 0;
    if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
    return left.question_id.localeCompare(right.question_id);
  });

  return candidates[0] ?? null;
}

export async function updateDeepInterviewQuestionEnforcement(
  cwd: string,
  sessionId: string | undefined,
  updater: (
    current: DeepInterviewQuestionEnforcementState | undefined,
  ) => DeepInterviewQuestionEnforcementState | undefined,
): Promise<DeepInterviewStateRecord | null> {
  if (!safeString(sessionId).trim()) return null;
  const state = await readDeepInterviewStateIfExists(cwd, sessionId);
  if (!state) return null;

  const nextEnforcement = updater(state.question_enforcement);
  const nextState: DeepInterviewStateRecord = {
    ...state,
    updated_at: new Date().toISOString(),
    ...(nextEnforcement
      ? {
          question_enforcement: nextEnforcement,
          ...(nextEnforcement.status === 'pending'
            ? {
                lifecycle_outcome: 'askuserQuestion',
                run_outcome: 'blocked_on_user',
                active: false,
                completed_at: safeString(state.completed_at) || new Date().toISOString(),
              }
            : {}),
        }
      : {}),
  };
  if (!nextEnforcement) {
    delete nextState.question_enforcement;
  }
  if (nextEnforcement?.status !== 'pending') {
    delete nextState.lifecycle_outcome;
    delete nextState.run_outcome;
  }

  await writeDeepInterviewState(cwd, nextState, sessionId);
  return nextState;
}

export async function reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords(
  cwd: string,
  sessionId: string | undefined,
  now = new Date(),
): Promise<DeepInterviewStateRecord | null> {
  const normalizedSessionId = safeString(sessionId).trim();
  if (!normalizedSessionId) return null;

  const state = await readDeepInterviewStateIfExists(cwd, normalizedSessionId);
  const enforcement = state?.question_enforcement;
  if (!state || !isPendingDeepInterviewQuestionEnforcement(enforcement)) {
    return state;
  }

  const answeredRecord = await findAnsweredDeepInterviewRecordForObligation(
    cwd,
    normalizedSessionId,
    enforcement,
  );
  if (!answeredRecord) return state;

  return await updateDeepInterviewQuestionEnforcement(
    cwd,
    normalizedSessionId,
    (current) => (
      current?.obligation_id === enforcement.obligation_id
        && isPendingDeepInterviewQuestionEnforcement(current)
        ? satisfyDeepInterviewQuestionObligation(current, answeredRecord.question_id, now)
        : current
    ),
  );
}

export async function runDeepInterviewQuestion(
  input: Partial<QuestionInput> & { question: string },
  options: OmxQuestionClientOptions = {},
): Promise<OmxQuestionSuccessPayload> {
  const cwd = options.cwd ?? process.cwd();
  const sessionId = safeString(input.session_id).trim() || await readCurrentSessionId(cwd);
  const obligation = createDeepInterviewQuestionObligation();

  await updateDeepInterviewQuestionEnforcement(
    cwd,
    sessionId,
    () => obligation,
  );

  try {
    const result = await runOmxQuestion(
      {
        ...input,
        source: input.source ?? 'deep-interview',
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      options,
    );

    await updateDeepInterviewQuestionEnforcement(
      cwd,
      sessionId,
      (current) => (
        current?.obligation_id === obligation.obligation_id
          ? satisfyDeepInterviewQuestionObligation(current, result.question_id)
          : current
      ),
    );

    return result;
  } catch (error) {
    await updateDeepInterviewQuestionEnforcement(
      cwd,
      sessionId,
      (current) => (
        current?.obligation_id === obligation.obligation_id
          ? clearDeepInterviewQuestionObligation(current, 'error')
          : current
      ),
    );
    throw error;
  }
}
