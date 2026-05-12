import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getStateDir } from '../mcp/state-paths.js';
import { writeAtomic } from '../team/state.js';
import { sleep } from '../utils/sleep.js';
import { appendQuestionAnsweredEventOnce, appendQuestionEvent, normalizeSubmittedAnswers, resolveQuestionRunId } from './events.js';
import { getNormalizedQuestionType, isMultiAnswerableQuestion, normalizeQuestionInput } from './types.js';
import type {
  NormalizedQuestionItem,
  QuestionAnswer,
  QuestionAnswerEntry,
  QuestionInput,
  QuestionRecord,
  QuestionRendererState,
  QuestionStatus,
} from './types.js';

const QUESTION_NAMESPACE = 'questions';
const DEFAULT_POLL_INTERVAL_MS = 100;
const QUESTION_SUBMIT_LOCK_STALE_MS = 30_000;
const QUESTION_SUBMIT_LOCK_TIMEOUT_MS = 10_000;

export type QuestionSubmitFailureCode =
  | 'question_unknown'
  | 'question_not_open'
  | 'question_invalid_answer';

export class QuestionSubmitError extends Error {
  readonly code: QuestionSubmitFailureCode;

  constructor(code: QuestionSubmitFailureCode, message: string) {
    super(message);
    this.name = 'QuestionSubmitError';
    this.code = code;
  }
}

function buildQuestionId(now = new Date()): string {
  return `question-${now.toISOString().replace(/[:.]/g, '-')}-$${Math.random().toString(16).slice(2, 10)}`.replace('$', '');
}

export function getQuestionStateDir(cwd: string, sessionId?: string): string {
  return join(getStateDir(cwd, sessionId), QUESTION_NAMESPACE);
}

export function getQuestionRecordPath(cwd: string, questionId: string, sessionId?: string): string {
  return join(getQuestionStateDir(cwd, sessionId), `${questionId}.json`);
}

export async function writeQuestionRecord(recordPath: string, record: QuestionRecord): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true });
  await writeAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

export async function readQuestionRecord(recordPath: string): Promise<QuestionRecord | null> {
  if (!existsSync(recordPath)) return null;
  const parsed = JSON.parse(await readFile(recordPath, 'utf-8')) as QuestionRecord;
  return parsed;
}

export async function createQuestionRecord(
  cwd: string,
  input: QuestionInput,
  sessionId?: string,
  now = new Date(),
  options: { emitEvent?: boolean; timeoutMs?: number; runId?: string } = {},
): Promise<{ recordPath: string; record: QuestionRecord }> {
  const normalizedInput = normalizeQuestionInput(input);
  const questionId = buildQuestionId(now);
  const nowIso = now.toISOString();
  const runId = options.runId ?? resolveQuestionRunId();
  const record: QuestionRecord = {
    kind: 'omx.question/v1',
    question_id: questionId,
    ...(sessionId ? { session_id: sessionId } : {}),
    created_at: nowIso,
    updated_at: nowIso,
    status: 'pending',
    ...(runId ? { run_id: runId } : {}),
    ...(normalizedInput.header ? { header: normalizedInput.header } : {}),
    question: normalizedInput.question,
    options: normalizedInput.options,
    allow_other: normalizedInput.allow_other,
    other_label: normalizedInput.other_label,
    multi_select: normalizedInput.multi_select,
    type: getNormalizedQuestionType(normalizedInput),
    questions: normalizedInput.questions,
    ...(normalizedInput.source ? { source: normalizedInput.source } : {}),
  };
  const recordPath = getQuestionRecordPath(cwd, questionId, sessionId);
  await writeQuestionRecord(recordPath, record);
  if (options.emitEvent) {
    await appendQuestionEvent(cwd, 'question-created', record, {
      recordPath,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
      now,
    });
  }
  return { recordPath, record };
}

export async function updateQuestionRecord(
  recordPath: string,
  updater: (record: QuestionRecord) => QuestionRecord,
): Promise<QuestionRecord> {
  const current = await readQuestionRecord(recordPath);
  if (!current) throw new Error(`Question record not found: ${recordPath}`);
  const updated = updater(current);
  await writeQuestionRecord(recordPath, updated);
  return updated;
}

export async function markQuestionPrompting(
  recordPath: string,
  renderer: QuestionRendererState,
): Promise<QuestionRecord> {
  return updateQuestionRecord(recordPath, (record) => ({
    ...record,
    status: isTerminalQuestionStatus(record.status) ? record.status : 'prompting',
    updated_at: new Date().toISOString(),
    renderer,
  }));
}

export async function markQuestionAnswered(
  recordPath: string,
  answerOrAnswers: QuestionAnswer | QuestionAnswerEntry[],
): Promise<QuestionRecord> {
  return updateQuestionRecord(recordPath, (record) => {
    const answers = Array.isArray(answerOrAnswers)
      ? answerOrAnswers
      : [{ question_id: record.questions?.[0]?.id ?? 'q-1', index: 0, answer: answerOrAnswers }];
    const firstAnswer = answers[0]?.answer;
    return {
      ...record,
      status: 'answered',
      updated_at: new Date().toISOString(),
      ...(firstAnswer ? { answer: firstAnswer } : {}),
      answers,
      error: undefined,
    };
  });
}

function isValidQuestionId(questionId: string): boolean {
  return /^question-[A-Za-z0-9_.-]+$/.test(questionId) && !questionId.includes('..');
}

async function listQuestionRecordsInDir(dir: string): Promise<Array<{ recordPath: string; record: QuestionRecord }>> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const records: Array<{ recordPath: string; record: QuestionRecord }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const recordPath = join(dir, entry.name);
    const record = await readQuestionRecord(recordPath).catch(() => null);
    if (record?.kind === 'omx.question/v1') records.push({ recordPath, record });
  }
  return records;
}

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function maybeRecoverStaleQuestionLock(lockDir: string): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > QUESTION_SUBMIT_LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
  }
  return false;
}

async function withQuestionSubmitLock<T>(recordPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${recordPath}.submit.lock`;
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + QUESTION_SUBMIT_LOCK_TIMEOUT_MS;
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
      if (await maybeRecoverStaleQuestionLock(lockDir)) continue;
      if (Date.now() > deadline) {
        throw new QuestionSubmitError('question_not_open', `Timed out acquiring submit lock for ${recordPath}`);
      }
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

function validateStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return value;
}

function assertNoDuplicateValues(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${path} must not contain duplicate values: ${value}`);
    seen.add(value);
  }
}

function expectedSelectedLabelsForValues(
  question: NormalizedQuestionItem,
  selectedValues: string[],
  otherText: string | undefined,
): string[] {
  const optionLabelsByValue = new Map(question.options.map((option) => [option.value, option.label]));
  return selectedValues.map((value) => {
    const optionLabel = optionLabelsByValue.get(value);
    if (optionLabel) return optionLabel;
    if (question.allow_other && otherText && value === otherText) return question.other_label;
    throw new Error(`selected value is not in the option schema: ${value}`);
  });
}

function assertSelectedLabelsMatch(
  selectedLabels: string[],
  expectedLabels: string[],
  path: string,
): void {
  if (selectedLabels.length !== expectedLabels.length) {
    throw new Error(`${path} cardinality must match selected values`);
  }
  const mismatchIndex = selectedLabels.findIndex((label, index) => label !== expectedLabels[index]);
  if (mismatchIndex !== -1) {
    throw new Error(`${path}[${mismatchIndex}] must match the selected value label`);
  }
}

function questionForAnswer(record: QuestionRecord, entry: QuestionAnswerEntry): NormalizedQuestionItem {
  const question = (record.questions ?? []).find((item) => item.id === entry.question_id);
  if (question) return question;
  if (entry.question_id === 'q-1') {
    return {
      id: 'q-1',
      ...(record.header ? { header: record.header } : {}),
      question: record.question,
      options: record.options,
      allow_other: record.allow_other,
      other_label: record.other_label,
      multi_select: record.multi_select,
      type: getNormalizedQuestionType(record),
    };
  }
  throw new Error(`answers[${entry.index}].question_id is unknown for this question: ${entry.question_id}`);
}

function validateAnswerAgainstQuestion(question: NormalizedQuestionItem, entry: QuestionAnswerEntry): void {
  const { answer } = entry;
  const selectedValues = validateStringArray(answer.selected_values, `answers[${entry.index}].answer.selected_values`);
  const selectedLabels = validateStringArray(answer.selected_labels, `answers[${entry.index}].answer.selected_labels`);
  assertNoDuplicateValues(selectedValues, `answers[${entry.index}].answer.selected_values`);

  const optionValues = new Set(question.options.map((option) => option.value));
  const multi = isMultiAnswerableQuestion(question);
  const hasOtherText = typeof answer.other_text === 'string' && answer.other_text.trim().length > 0;
  const otherText = hasOtherText ? answer.other_text!.trim() : undefined;
  const outOfSchemaValues = selectedValues.filter((value) => !optionValues.has(value));

  if (answer.kind === 'other') {
    if (!question.allow_other) throw new Error(`answers[${entry.index}].answer.kind=other is not allowed for this question`);
    if (multi) throw new Error(`answers[${entry.index}].answer.kind=other is only valid for single-answerable questions`);
    if (!otherText) throw new Error(`answers[${entry.index}].answer.other_text must be a non-empty string`);
    if (selectedValues.length !== 1 || selectedValues[0] !== otherText || answer.value !== otherText) {
      throw new Error(`answers[${entry.index}].answer other value must match selected_values[0] and other_text`);
    }
    assertSelectedLabelsMatch(
      selectedLabels,
      [question.other_label],
      `answers[${entry.index}].answer.selected_labels`,
    );
    return;
  }

  if (answer.kind === 'option') {
    if (multi) throw new Error(`answers[${entry.index}].answer.kind=option is only valid for single-answerable questions`);
    if (selectedValues.length !== 1 || selectedLabels.length !== 1) {
      throw new Error(`answers[${entry.index}].answer must select exactly one option`);
    }
    const selectedValue = selectedValues[0]!;
    if (!optionValues.has(selectedValue)) {
      throw new Error(`answers[${entry.index}].answer selected value is not in the option schema: ${selectedValue}`);
    }
    if (answer.value !== selectedValue) {
      throw new Error(`answers[${entry.index}].answer.value must match selected_values[0]`);
    }
    assertSelectedLabelsMatch(
      selectedLabels,
      expectedSelectedLabelsForValues(question, selectedValues, undefined),
      `answers[${entry.index}].answer.selected_labels`,
    );
    return;
  }

  if (!multi) throw new Error(`answers[${entry.index}].answer.kind=multi is only valid for multi-answerable questions`);
  if (!Array.isArray(answer.value)) throw new Error(`answers[${entry.index}].answer.value must be an array for multi answers`);
  if (answer.value.length !== selectedValues.length || answer.value.some((value, index) => value !== selectedValues[index])) {
    throw new Error(`answers[${entry.index}].answer.value must match selected_values`);
  }
  if (outOfSchemaValues.length > 0) {
    if (!question.allow_other) {
      throw new Error(`answers[${entry.index}].answer selected value is not in the option schema: ${outOfSchemaValues[0]}`);
    }
    if (!otherText || outOfSchemaValues.length !== 1 || outOfSchemaValues[0] !== otherText) {
      throw new Error(`answers[${entry.index}].answer out-of-schema selection must match a single other_text value`);
    }
  }
  assertSelectedLabelsMatch(
    selectedLabels,
    expectedSelectedLabelsForValues(question, selectedValues, otherText),
    `answers[${entry.index}].answer.selected_labels`,
  );
}

function validateSubmittedAnswersAgainstSchema(record: QuestionRecord, answers: QuestionAnswerEntry[]): void {
  const expectedQuestionIds = new Set((record.questions ?? []).map((question) => question.id));
  if (expectedQuestionIds.size > 0 && answers.length !== expectedQuestionIds.size) {
    throw new Error(`answer payload must include exactly one answer for each question (${expectedQuestionIds.size})`);
  }
  for (const entry of answers) {
    validateAnswerAgainstQuestion(questionForAnswer(record, entry), entry);
  }
}

export async function listQuestionRecords(
  cwd: string,
  options: { sessionId?: string; status?: QuestionStatus | 'open'; limit?: number } = {},
): Promise<Array<{ recordPath: string; record: QuestionRecord }>> {
  const dirs = [getQuestionStateDir(cwd, options.sessionId)];
  const records = (await Promise.all(dirs.map((dir) => listQuestionRecordsInDir(dir)))).flat();
  const filtered = records.filter(({ record }) => {
    if (!options.status) return true;
    if (options.status === 'open') return record.status === 'pending' || record.status === 'prompting';
    return record.status === options.status;
  });
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  return filtered
    .sort((left, right) => left.record.created_at.localeCompare(right.record.created_at))
    .slice(-limit);
}

export async function submitQuestionAnswerById(
  cwd: string,
  questionId: string,
  answerPayload: unknown,
  options: { sessionId?: string; runId?: string } = {},
): Promise<{ recordPath: string; record: QuestionRecord }> {
  const normalizedQuestionId = questionId.trim();
  if (!isValidQuestionId(normalizedQuestionId)) {
    throw new QuestionSubmitError('question_unknown', `Unknown question id: ${questionId}`);
  }

  const recordPath = getQuestionRecordPath(cwd, normalizedQuestionId, options.sessionId);
  return await withQuestionSubmitLock(recordPath, async () => {
    const current = await readQuestionRecord(recordPath);
    if (!current) throw new QuestionSubmitError('question_unknown', `Unknown question id: ${normalizedQuestionId}`);
    if (current.status !== 'pending' && current.status !== 'prompting') {
      throw new QuestionSubmitError(
        'question_not_open',
        `Question ${normalizedQuestionId} is ${current.status}; only pending or prompting questions can be answered.`,
      );
    }

    let answers: QuestionAnswerEntry[];
    try {
      answers = normalizeSubmittedAnswers(current, answerPayload);
      validateSubmittedAnswersAgainstSchema(current, answers);
    } catch (error) {
      throw new QuestionSubmitError('question_invalid_answer', error instanceof Error ? error.message : String(error));
    }
    const record = await markQuestionAnswered(recordPath, answers);
    await appendQuestionAnsweredEventOnce(cwd, record, { recordPath, runId: options.runId });
    return { recordPath, record };
  });
}

export async function markQuestionTerminalError(
  recordPath: string,
  status: Extract<QuestionStatus, 'aborted' | 'error'>,
  code: string,
  message: string,
): Promise<QuestionRecord> {
  return updateQuestionRecord(recordPath, (record) => ({
    ...record,
    status,
    updated_at: new Date().toISOString(),
    error: {
      code,
      message,
      at: new Date().toISOString(),
    },
  }));
}

export function isTerminalQuestionStatus(status: QuestionStatus): boolean {
  return status === 'answered' || status === 'aborted' || status === 'error';
}

export async function waitForQuestionTerminalState(
  recordPath: string,
  options: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    rendererAlive?: (record: QuestionRecord) => boolean;
    rendererDeathMessage?: (record: QuestionRecord) => string;
  } = {},
): Promise<QuestionRecord> {
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = options.timeoutMs;
  const startedAt = Date.now();

  while (true) {
    const record = await readQuestionRecord(recordPath);
    if (!record) throw new Error(`Question record not found while waiting: ${recordPath}`);
    if (isTerminalQuestionStatus(record.status)) return record;
    if (options.rendererAlive && !options.rendererAlive(record)) {
      throw new Error(
        options.rendererDeathMessage?.(record)
          ?? `Question renderer ${record.renderer?.renderer ?? 'unknown'} exited before answering.`,
      );
    }
    if (typeof timeoutMs === 'number' && timeoutMs >= 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for question answer after ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}
