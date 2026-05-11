import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getBaseStateDir } from '../mcp/state-paths.js';
import type { QuestionAnswerEntry, QuestionRecord } from './types.js';

export type QuestionEventType = 'question-created' | 'question-answered' | 'question-error';

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
  const runId = options.runId ?? resolveQuestionRunId();
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

export async function readQuestionEvents(cwd: string, options: { limit?: number; type?: QuestionEventType } = {}): Promise<QuestionEventRecord[]> {
  const path = getQuestionEventsPath(cwd);
  if (!existsSync(path)) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const lines = (await readFile(path, 'utf-8')).split(/\r?\n/).filter(Boolean);
  const events = lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as QuestionEventRecord;
      if (options.type && parsed.type !== options.type) return [];
      return [parsed];
    } catch {
      return [];
    }
  });
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
