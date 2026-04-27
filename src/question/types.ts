export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export type QuestionType = 'single-answerable' | 'multi-answerable';

export interface QuestionInput {
  header?: string;
  question: string;
  options: QuestionOption[];
  allow_other: boolean;
  other_label: string;
  multi_select: boolean;
  type?: QuestionType;
  source?: string;
  session_id?: string;
}

export type QuestionRendererKind = 'tmux-pane' | 'tmux-session' | 'inline-tty' | 'windows-console';

export interface QuestionAnswer {
  kind: 'option' | 'other' | 'multi';
  value: string | string[];
  selected_labels: string[];
  selected_values: string[];
  other_text?: string;
}

export type QuestionStatus = 'pending' | 'prompting' | 'answered' | 'aborted' | 'error';

export interface QuestionRendererState {
  renderer: QuestionRendererKind;
  target: string;
  launched_at: string;
  return_target?: string;
  return_transport?: 'tmux-send-keys';
  pid?: number;
}

export interface QuestionRecord {
  kind: 'omx.question/v1';
  question_id: string;
  session_id?: string;
  created_at: string;
  updated_at: string;
  status: QuestionStatus;
  header?: string;
  question: string;
  options: QuestionOption[];
  allow_other: boolean;
  other_label: string;
  multi_select: boolean;
  type?: QuestionType;
  source?: string;
  renderer?: QuestionRendererState;
  answer?: QuestionAnswer;
  error?: {
    code: string;
    message: string;
    at: string;
  };
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeOption(raw: unknown, index: number): QuestionOption {
  if (typeof raw === 'string') {
    const label = raw.trim();
    if (!label) throw new Error(`options[${index}] must be a non-empty string`);
    return { label, value: label };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`options[${index}] must be a string or object`);
  }
  const label = safeString((raw as Record<string, unknown>).label).trim();
  const value = safeString((raw as Record<string, unknown>).value).trim() || label;
  const description = safeString((raw as Record<string, unknown>).description).trim() || undefined;
  if (!label) throw new Error(`options[${index}].label must be a non-empty string`);
  if (!value) throw new Error(`options[${index}].value must be a non-empty string`);
  return { label, value, ...(description ? { description } : {}) };
}

function parseQuestionType(raw: unknown): QuestionType | undefined {
  const normalized = safeString(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'multi-answerable' || normalized === 'multi-select') return 'multi-answerable';
  if (normalized === 'single-answerable' || normalized === 'single-select') return 'single-answerable';
  throw new Error('type must be one of: single-answerable, multi-answerable');
}

export function getNormalizedQuestionType(input: {
  type?: QuestionType;
  multi_select?: boolean;
}): QuestionType {
  return input.type ?? (input.multi_select === true ? 'multi-answerable' : 'single-answerable');
}

export function isMultiAnswerableQuestion(input: {
  type?: QuestionType;
  multi_select?: boolean;
}): boolean {
  return getNormalizedQuestionType(input) === 'multi-answerable';
}

export function normalizeQuestionInput(raw: unknown): QuestionInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('question input must be a JSON object');
  }

  const input = raw as Record<string, unknown>;
  const question = safeString(input.question).trim();
  const header = safeString(input.header).trim() || undefined;
  const source = safeString(input.source).trim() || undefined;
  const session_id = safeString(input.session_id).trim() || undefined;
  const other_label = safeString(input.other_label).trim() || 'Other';
  const allow_other = input.allow_other !== false;
  const rawMultiSelect = input.multi_select;
  const parsedType = parseQuestionType(input.type);
  const rawOptions = Array.isArray(input.options) ? input.options : [];

  if (!question) throw new Error('question must be a non-empty string');
  if (rawOptions.length === 0 && !allow_other) {
    throw new Error('options must be a non-empty array unless allow_other is true');
  }

  if (parsedType === 'single-answerable' && rawMultiSelect === true) {
    throw new Error('type=single-answerable conflicts with multi_select=true');
  }
  if (parsedType === 'multi-answerable' && rawMultiSelect === false) {
    throw new Error('type=multi-answerable conflicts with multi_select=false');
  }

  const options = rawOptions.map(normalizeOption);
  const type = getNormalizedQuestionType({
    type: parsedType,
    multi_select: rawMultiSelect === true,
  });
  const multi_select = type === 'multi-answerable';

  return {
    ...(header ? { header } : {}),
    question,
    options,
    allow_other,
    other_label,
    multi_select,
    type,
    ...(source ? { source } : {}),
    ...(session_id ? { session_id } : {}),
  };
}
