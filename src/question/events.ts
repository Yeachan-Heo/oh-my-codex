import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sleep } from '../utils/sleep.js';
import { getBaseStateDir } from '../mcp/state-paths.js';
import type { QuestionAnswerEntry, QuestionRecord } from './types.js';

export type QuestionEventType = 'question-created' | 'question-answered' | 'question-error';

const QUESTION_EVENT_LOCK_STALE_MS = 30_000;
const QUESTION_EVENT_LOCK_TIMEOUT_MS = 10_000;

export interface QuestionEventRecord {
  kind: 'omx.question-event/v1';
  event_id: string;
  type: QuestionEventType;
  question_id: string;
  session_id?: string;
  run_id?: string;
  created_at: string;
  question_created_at?: string;
  status: QuestionRecord['status'];
  source?: string;
  context_summary?: string;
  option_schema?: QuestionRecord['questions'];
  state?: {
    record_path?: string;
    renderer?: QuestionRecord['renderer'];
    timeout_ms?: number;
    error?: QuestionRecord['error'];
    answer_count?: number;
  };
}

export function getQuestionEventsPath(cwd: string): string {
  return join(getBaseStateDir(cwd), 'question-events.jsonl');
}

function questionEventLockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function maybeRecoverStaleQuestionEventLock(lockDir: string): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > QUESTION_EVENT_LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
  }
  return false;
}

async function withQuestionEventLock<T>(eventsPath: string, lockName: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${eventsPath}.${lockName}.lock`;
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = questionEventLockOwnerToken();
  const deadline = Date.now() + QUESTION_EVENT_LOCK_TIMEOUT_MS;
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
      if (await maybeRecoverStaleQuestionEventLock(lockDir)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring question event lock for ${eventsPath}`);
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

function parseQuestionEventLines(contents: string, options: { type?: QuestionEventType } = {}): QuestionEventRecord[] {
  const lines = contents.split(/\r?\n/).filter(Boolean);
  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as QuestionEventRecord;
      if (options.type && parsed.type !== options.type) return [];
      return [parsed];
    } catch {
      return [];
    }
  });
}

async function readAllQuestionEventsFromPath(path: string, options: { type?: QuestionEventType } = {}): Promise<QuestionEventRecord[]> {
  if (!existsSync(path)) return [];
  return parseQuestionEventLines(await readFile(path, 'utf-8'), options);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveQuestionRunId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return safeString(env.OMX_RUN_ID) || safeString(env.OMX_RUN_ID_OVERRIDE) || safeString(env.OMX_CURRENT_RUN_ID) || undefined;
}

function truncateSummary(value: string, max = 600): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function summarizeQuestionContext(record: QuestionRecord): string {
  const parts: string[] = [];
  if (record.header) parts.push(record.header);
  if (record.question) parts.push(record.question);
  const questions = record.questions ?? [];
  if (questions.length > 1) parts.push(`${questions.length} structured questions`);
  return truncateSummary(parts.join(' — ') || record.question_id);
}

export function buildQuestionEvent(
  type: QuestionEventType,
  record: QuestionRecord,
  options: { recordPath?: string; timeoutMs?: number; runId?: string; now?: Date } = {},
): QuestionEventRecord {
  const now = options.now ?? new Date();
  const answerCount = record.answers?.length ?? (record.answer ? 1 : 0);
  const runId = options.runId ?? record.run_id ?? resolveQuestionRunId();
  return {
    kind: 'omx.question-event/v1',
    event_id: `${type}-${record.question_id}-${now.toISOString().replace(/[:.]/g, '-')}`,
    type,
    question_id: record.question_id,
    ...(record.session_id ? { session_id: record.session_id } : {}),
    ...(runId ? { run_id: runId } : {}),
    created_at: now.toISOString(),
    question_created_at: record.created_at,
    status: record.status,
    ...(record.source ? { source: record.source } : {}),
    context_summary: summarizeQuestionContext(record),
    option_schema: record.questions,
    state: {
      ...(options.recordPath ? { record_path: options.recordPath } : {}),
      ...(record.renderer ? { renderer: record.renderer } : {}),
      ...(typeof options.timeoutMs === 'number' ? { timeout_ms: options.timeoutMs } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(answerCount ? { answer_count: answerCount } : {}),
    },
  };
}

export async function appendQuestionEvent(
  cwd: string,
  type: QuestionEventType,
  record: QuestionRecord,
  options: { recordPath?: string; timeoutMs?: number; runId?: string; now?: Date } = {},
): Promise<QuestionEventRecord> {
  const event = buildQuestionEvent(type, record, options);
  const path = getQuestionEventsPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`);
  return event;
}

export async function appendQuestionAnsweredEventOnce(
  cwd: string,
  record: QuestionRecord,
  options: { recordPath?: string; timeoutMs?: number; runId?: string; now?: Date } = {},
): Promise<{ event: QuestionEventRecord; appended: boolean }> {
  const path = getQuestionEventsPath(cwd);
  return await withQuestionEventLock(path, `answered-${record.question_id}`, async () => {
    const existing = (await readAllQuestionEventsFromPath(path, { type: 'question-answered' }))
      .find((event) => event.question_id === record.question_id);
    if (existing) return { event: existing, appended: false };
    const event = await appendQuestionEvent(cwd, 'question-answered', record, options);
    return { event, appended: true };
  });
}

export async function readQuestionEvents(cwd: string, options: { limit?: number; type?: QuestionEventType } = {}): Promise<QuestionEventRecord[]> {
  const path = getQuestionEventsPath(cwd);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const events = await readAllQuestionEventsFromPath(path, { type: options.type });
  return events.slice(-limit);
}

export function normalizeSubmittedAnswers(record: QuestionRecord, raw: unknown): QuestionAnswerEntry[] {
  const rawAnswers = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { answers?: unknown }).answers)
      ? (raw as { answers: unknown[] }).answers
      : raw && typeof raw === 'object' && (raw as { answer?: unknown }).answer
        ? [{ question_id: record.questions?.[0]?.id ?? 'q-1', index: 0, answer: (raw as { answer: unknown }).answer }]
        : [];

  if (rawAnswers.length === 0) throw new Error('answer payload must include answer or answers[]');
  const validQuestionIds = new Set((record.questions ?? []).map((question) => question.id));
  if (validQuestionIds.size === 0) validQuestionIds.add('q-1');
  const seen = new Set<string>();

  return rawAnswers.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`answers[${index}] must be an object`);
    const object = entry as Record<string, unknown>;
    const questionId = safeString(object.question_id) || (record.questions?.[index]?.id ?? (index === 0 ? 'q-1' : ''));
    if (!questionId || !validQuestionIds.has(questionId)) throw new Error(`answers[${index}].question_id is unknown for this question: ${questionId || '<missing>'}`);
    if (seen.has(questionId)) throw new Error(`answers question_id must be unique: ${questionId}`);
    seen.add(questionId);
    const answer = object.answer;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error(`answers[${index}].answer must be an object`);
    const answerObject = answer as Record<string, unknown>;
    const kind = safeString(answerObject.kind);
    if (!['option', 'other', 'multi'].includes(kind)) throw new Error(`answers[${index}].answer.kind must be option, other, or multi`);
    if (!Array.isArray(answerObject.selected_labels) || !Array.isArray(answerObject.selected_values)) {
      throw new Error(`answers[${index}].answer must include selected_labels[] and selected_values[]`);
    }
    return {
      question_id: questionId,
      index: Number.isInteger(object.index) ? object.index as number : index,
      answer: answerObject as unknown as QuestionAnswerEntry['answer'],
    };
  });
}
