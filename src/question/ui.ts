import { emitKeypressEvents } from 'node:readline';
import { createInterface as createPromptInterface } from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { injectQuestionAnswersToPane } from './renderer.js';
import { markQuestionAnswered, markQuestionTerminalError, readQuestionRecord } from './state.js';
import { isMultiAnswerableQuestion } from './types.js';
import type { NormalizedQuestionItem, QuestionAnswer, QuestionAnswerEntry, QuestionRecord } from './types.js';

interface QuestionUiInput {
  isTTY?: boolean;
  on(event: 'keypress', listener: (str: string, key: KeyLike) => void): this;
  off(event: 'keypress', listener: (str: string, key: KeyLike) => void): this;
  resume?(): void;
  pause?(): void;
  setRawMode?(mode: boolean): void;
}

interface QuestionUiOutput {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

interface QuestionUiDeps {
  input?: QuestionUiInput;
  output?: QuestionUiOutput;
  env?: NodeJS.ProcessEnv;
  injectAnswersToPane?: (paneId: string, answers: QuestionAnswerEntry[]) => boolean;
}

interface InteractiveSelectionState {
  cursorIndex: number;
  selectedIndices: number[];
  error?: string;
}

interface SelectionUpdate {
  state: InteractiveSelectionState;
  submit: boolean;
}

interface KeyLike {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

interface QuestionOptionEntry {
  label: string;
  description?: string;
}

interface WizardState {
  currentQuestionIndex: number;
  selections: InteractiveSelectionState[];
  mode: 'answering' | 'review';
  error?: string;
}

interface WizardUpdate {
  state: WizardState;
  submit: boolean;
}

function recordQuestions(record: QuestionRecord): NormalizedQuestionItem[] {
  if (record.questions?.length) return record.questions;
  return [{
    id: 'q-1',
    ...(record.header ? { header: record.header } : {}),
    question: record.question,
    options: record.options,
    allow_other: record.allow_other,
    other_label: record.other_label,
    multi_select: record.multi_select,
    type: record.type ?? (record.multi_select ? 'multi-answerable' : 'single-answerable'),
  }];
}

function getOptionEntries(question: Pick<NormalizedQuestionItem, 'options' | 'allow_other' | 'other_label'>): QuestionOptionEntry[] {
  const entries = question.options.map((option, index) => ({
    label: `${index + 1}. ${option.label}`,
    description: typeof option.description === 'string' && option.description.trim()
      ? option.description.trim()
      : undefined,
  }));
  if (question.allow_other) {
    entries.push({
      label: `${question.options.length + 1}. ${question.other_label}`,
      description: undefined,
    });
  }
  return entries;
}

function getOptionLabels(question: Pick<NormalizedQuestionItem, 'options' | 'allow_other' | 'other_label'>): string[] {
  return getOptionEntries(question).map((entry) => entry.label);
}

function renderOptions(question: Pick<NormalizedQuestionItem, 'options' | 'allow_other' | 'other_label'>): string[] {
  return getOptionEntries(question).flatMap((entry) => {
    const lines = [`  [ ] ${entry.label}`];
    if (entry.description) lines.push(`      ${entry.description}`);
    return lines;
  });
}

function parseSelection(raw: string, optionCount: number, multiSelect: boolean): number[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = multiSelect ? trimmed.split(',') : [trimmed];
  const values = parts
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  if (!multiSelect && values.length !== 1) return null;
  if (values.some((value) => value < 1 || value > optionCount)) return null;
  return [...new Set(values)];
}

function buildAnswer(question: NormalizedQuestionItem, selections: number[], otherText?: string): QuestionAnswer {
  const optionCount = question.options.length;
  const otherIndex = optionCount + 1;
  const selectedOptions = selections
    .filter((value) => value <= optionCount)
    .map((value) => question.options[value - 1]);
  const selected_labels = selectedOptions.map((option) => option.label);
  const selected_values = selectedOptions.map((option) => option.value);
  const includesOther = question.allow_other && selections.includes(otherIndex);

  if (includesOther && !otherText) throw new Error('Other response text is required.');
  const resolvedOtherText = includesOther ? otherText as string : undefined;

  if (isMultiAnswerableQuestion(question)) {
    const values = resolvedOtherText ? [...selected_values, resolvedOtherText] : selected_values;
    const labels = includesOther ? [...selected_labels, question.other_label] : selected_labels;
    return { kind: 'multi', value: values, selected_labels: labels, selected_values: values, ...(resolvedOtherText ? { other_text: resolvedOtherText } : {}) };
  }

  if (includesOther) {
    return { kind: 'other', value: resolvedOtherText!, selected_labels: [question.other_label], selected_values: [resolvedOtherText!], other_text: resolvedOtherText! };
  }

  const selected = selectedOptions[0];
  if (!selected) throw new Error('No option selected.');
  return { kind: 'option', value: selected.value, selected_labels: [selected.label], selected_values: [selected.value] };
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function maybeInjectAnswers(record: QuestionRecord, answers: QuestionAnswerEntry[], deps: Pick<QuestionUiDeps, 'env' | 'injectAnswersToPane'> = {}): void {
  const env = deps.env ?? process.env;
  const envTransport = safeString(env.OMX_QUESTION_RETURN_TRANSPORT).trim();
  const target = record.renderer?.return_target ?? safeString(env.OMX_QUESTION_RETURN_TARGET).trim();
  const transport = record.renderer?.return_transport ?? (envTransport === 'tmux-send-keys' ? envTransport : undefined);
  if (!target || transport !== 'tmux-send-keys') return;
  try {
    (deps.injectAnswersToPane ?? injectQuestionAnswersToPane)(target, answers);
  } catch {}
}

function supportsInteractiveArrowUi(input: QuestionUiInput, output: QuestionUiOutput): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
}

function toggleSelection(selectedIndices: number[], index: number): number[] {
  return selectedIndices.includes(index)
    ? selectedIndices.filter((value) => value !== index)
    : [...selectedIndices, index].sort((left, right) => left - right);
}

export function createInitialInteractiveSelectionState(): InteractiveSelectionState {
  return { cursorIndex: 0, selectedIndices: [] };
}

export function applyInteractiveSelectionKey(record: QuestionRecord, state: InteractiveSelectionState, key: KeyLike): SelectionUpdate {
  const question = recordQuestions(record)[0]!;
  const optionCount = getOptionLabels(question).length;
  if (optionCount === 0) throw new Error('Interactive question UI requires at least one selectable option.');

  const moveCursor = (delta: number): SelectionUpdate => ({
    submit: false,
    state: { ...state, cursorIndex: (state.cursorIndex + delta + optionCount) % optionCount, error: undefined },
  });

  if (key.name === 'up') return moveCursor(-1);
  if (key.name === 'down') return moveCursor(1);

  if (key.sequence && /^[1-9]$/.test(key.sequence)) {
    const explicitIndex = Number.parseInt(key.sequence, 10) - 1;
    if (explicitIndex < optionCount) {
      return {
        submit: !isMultiAnswerableQuestion(question),
        state: { ...state, cursorIndex: explicitIndex, selectedIndices: isMultiAnswerableQuestion(question) ? toggleSelection(state.selectedIndices, explicitIndex) : state.selectedIndices, error: undefined },
      };
    }
  }

  if (key.name === 'space') {
    if (!isMultiAnswerableQuestion(question)) return { submit: true, state: { ...state, error: undefined } };
    return { submit: false, state: { ...state, selectedIndices: toggleSelection(state.selectedIndices, state.cursorIndex), error: undefined } };
  }

  if (key.name === 'return' || key.name === 'enter') {
    if (!isMultiAnswerableQuestion(question)) return { submit: true, state: { ...state, error: undefined } };
    if (state.selectedIndices.length > 0) return { submit: true, state: { ...state, error: undefined } };
    return { submit: false, state: { ...state, error: 'Select one or more options with Space before pressing Enter.' } };
  }

  return { submit: false, state };
}

export function renderInteractiveQuestionFrame(record: QuestionRecord, state: InteractiveSelectionState): string {
  const question = recordQuestions(record)[0]!;
  const optionEntries = getOptionEntries(question);
  const lines: string[] = [];

  if (record.header || question.header) lines.push(record.header ?? question.header ?? '');
  lines.push(question.question, '');

  optionEntries.forEach((entry, index) => {
    const isActive = state.cursorIndex === index;
    const isChecked = isMultiAnswerableQuestion(question) ? state.selectedIndices.includes(index) : isActive;
    lines.push(`${isActive ? '›' : ' '} [${isChecked ? 'x' : ' '}] ${entry.label}`);
    if (entry.description) lines.push(`      ${entry.description}`);
  });

  lines.push('');
  lines.push(isMultiAnswerableQuestion(question) ? 'Use ↑/↓ to move, Space to toggle, Enter to submit.' : 'Use ↑/↓ to move, Enter to select.');
  if (state.error) lines.push(state.error);
  return `${lines.join('\n')}\n`;
}

export function createInitialQuestionWizardState(record: QuestionRecord): WizardState {
  return { currentQuestionIndex: 0, selections: recordQuestions(record).map(() => createInitialInteractiveSelectionState()), mode: 'answering' };
}

function isQuestionSelectionValid(question: NormalizedQuestionItem, state: InteractiveSelectionState): boolean {
  return !isMultiAnswerableQuestion(question) || state.selectedIndices.length > 0;
}

function advanceWizard(record: QuestionRecord, state: WizardState): WizardState {
  const questions = recordQuestions(record);
  const current = questions[state.currentQuestionIndex]!;
  if (!isQuestionSelectionValid(current, state.selections[state.currentQuestionIndex]!)) {
    const selections = state.selections.map((item, index) => index === state.currentQuestionIndex ? { ...item, error: 'Select one or more options with Space before continuing.' } : item);
    return { ...state, selections };
  }
  if (state.currentQuestionIndex >= questions.length - 1) return { ...state, mode: 'review', error: undefined };
  return { ...state, currentQuestionIndex: state.currentQuestionIndex + 1, error: undefined };
}

export function applyQuestionWizardKey(record: QuestionRecord, state: WizardState, key: KeyLike): WizardUpdate {
  if (state.mode === 'review') {
    if (key.name === 'left' || key.name === 'backspace') return { submit: false, state: { ...state, mode: 'answering', currentQuestionIndex: recordQuestions(record).length - 1 } };
    if (key.name === 'return' || key.name === 'enter') return { submit: true, state };
    return { submit: false, state };
  }

  if (key.name === 'left' || key.name === 'backspace') {
    return { submit: false, state: { ...state, currentQuestionIndex: Math.max(0, state.currentQuestionIndex - 1), error: undefined } };
  }

  const questions = recordQuestions(record);
  const current = questions[state.currentQuestionIndex]!;
  const currentSelection = state.selections[state.currentQuestionIndex]!;
  if (key.name === 'right') return { submit: false, state: advanceWizard(record, state) };

  const update = applyInteractiveSelectionKey({ ...record, ...current, questions: [current] }, currentSelection, key);
  const nextSelections = state.selections.map((item, index) => index === state.currentQuestionIndex ? update.state : item);
  const nextState = { ...state, selections: nextSelections };
  if (!update.submit) return { submit: false, state: nextState };
  return { submit: false, state: advanceWizard(record, nextState) };
}

function selectedNumbersForQuestion(question: NormalizedQuestionItem, state: InteractiveSelectionState): number[] {
  if (isMultiAnswerableQuestion(question)) return state.selectedIndices.map((index) => index + 1);
  return [state.cursorIndex + 1];
}

function buildAnswerEntries(record: QuestionRecord, state: WizardState, otherTexts: Array<string | undefined> = []): QuestionAnswerEntry[] {
  return recordQuestions(record).map((question, index) => ({
    question_id: question.id,
    index,
    answer: buildAnswer(question, selectedNumbersForQuestion(question, state.selections[index]!), otherTexts[index]),
  }));
}

function formatSelectedLabels(question: NormalizedQuestionItem, state: InteractiveSelectionState): string {
  const selections = selectedNumbersForQuestion(question, state);
  return selections
    .map((selection) => question.options[selection - 1]?.label ?? question.other_label)
    .join(', ');
}

export function renderQuestionWizardFrame(record: QuestionRecord, state: WizardState): string {
  const questions = recordQuestions(record);
  if (state.mode === 'review') {
    const lines = [record.header ?? 'Review answers', ''];
    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${questions[index]!.question}`);
      lines.push(`   ${formatSelectedLabels(question, state.selections[index]!)}`);
    });
    lines.push('', 'Press Enter to submit, ←/Backspace to edit.');
    return `${lines.join('\n')}\n`;
  }

  const question = questions[state.currentQuestionIndex]!;
  const selection = state.selections[state.currentQuestionIndex]!;
  const optionEntries = getOptionEntries(question);
  const lines: string[] = [];
  if (record.header) lines.push(record.header);
  if (question.header && question.header !== record.header) lines.push(question.header);
  lines.push(`Question ${state.currentQuestionIndex + 1} of ${questions.length}`);
  lines.push(question.question, '');
  optionEntries.forEach((entry, index) => {
    const isActive = selection.cursorIndex === index;
    const isChecked = isMultiAnswerableQuestion(question) ? selection.selectedIndices.includes(index) : isActive;
    lines.push(`${isActive ? '›' : ' '} [${isChecked ? 'x' : ' '}] ${entry.label}`);
    if (entry.description) lines.push(`      ${entry.description}`);
  });
  lines.push('', isMultiAnswerableQuestion(question) ? 'Use ↑/↓ to move, Space to toggle, Enter/→ to continue, ← to go back.' : 'Use ↑/↓ to move, Enter/→ to continue, ← to go back.');
  if (selection.error || state.error) lines.push(selection.error ?? state.error ?? '');
  return `${lines.join('\n')}\n`;
}

export async function promptForSelectionsWithArrows(record: QuestionRecord, deps: QuestionUiDeps = {}): Promise<number[]> {
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;
  if (!supportsInteractiveArrowUi(input, output)) throw new Error('Interactive arrow UI requires TTY stdin/stdout with raw-mode support.');

  return new Promise<number[]>((resolve, reject) => {
    let state = createInitialInteractiveSelectionState();
    let finished = false;
    const cleanup = () => { input.off('keypress', onKeypress); input.setRawMode?.(false); input.pause?.(); output.write('\u001b[?25h'); };
    const finish = (selections: number[]) => { if (finished) return; finished = true; cleanup(); output.write('\n'); resolve(selections); };
    const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); output.write('\n'); reject(error); };
    const render = () => { output.write('\u001b[H\u001b[J'); output.write('\u001b[?25l'); output.write(renderInteractiveQuestionFrame(record, state)); };
    const onKeypress = (_: string, key: KeyLike) => {
      if (key.ctrl && key.name === 'c') { fail(new Error('Question UI cancelled by user.')); return; }
      const update = applyInteractiveSelectionKey(record, state, key);
      state = update.state;
      render();
      if (!update.submit) return;
      const question = recordQuestions(record)[0]!;
      finish(isMultiAnswerableQuestion(question) ? state.selectedIndices.map((index) => index + 1) : [state.cursorIndex + 1]);
    };
    emitKeypressEvents(input as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume?.();
    input.on('keypress', onKeypress);
    render();
  });
}

async function promptForAnswersWithArrows(record: QuestionRecord, deps: QuestionUiDeps = {}): Promise<QuestionAnswerEntry[]> {
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;
  if (!supportsInteractiveArrowUi(input, output)) throw new Error('Interactive arrow UI requires TTY stdin/stdout with raw-mode support.');
  return new Promise<QuestionAnswerEntry[]>((resolve, reject) => {
    let state = createInitialQuestionWizardState(record);
    let finished = false;
    const cleanup = () => { input.off('keypress', onKeypress); input.setRawMode?.(false); input.pause?.(); output.write('\u001b[?25h'); };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      output.write('\n');
      void (async () => {
        try {
          const otherTexts = await promptForWizardOtherTexts(record, state, { input, output });
          resolve(buildAnswerEntries(record, state, otherTexts));
        } catch (error) {
          reject(error);
        }
      })();
    };
    const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); output.write('\n'); reject(error); };
    const render = () => { output.write('\u001b[H\u001b[J'); output.write('\u001b[?25l'); output.write(renderQuestionWizardFrame(record, state)); };
    const onKeypress = (_: string, key: KeyLike) => {
      if (key.ctrl && key.name === 'c') { fail(new Error('Question UI cancelled by user.')); return; }
      const update = applyQuestionWizardKey(record, state, key);
      state = update.state;
      render();
      if (update.submit) finish();
    };
    emitKeypressEvents(input as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume?.();
    input.on('keypress', onKeypress);
    render();
  });
}

async function promptForWizardOtherTexts(record: QuestionRecord, state: WizardState, deps: QuestionUiDeps = {}): Promise<Array<string | undefined>> {
  const otherTexts: Array<string | undefined> = [];
  for (const [index, question] of recordQuestions(record).entries()) {
    const selectedNumbers = selectedNumbersForQuestion(question, state.selections[index]!);
    if (!question.allow_other || !selectedNumbers.includes(question.options.length + 1)) continue;
    otherTexts[index] = await promptForOtherText(question.other_label, deps);
  }
  return otherTexts;
}

async function promptForQuestionWithNumbers(question: NormalizedQuestionItem, deps: QuestionUiDeps = {}): Promise<number[]> {
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;
  const rl = createPromptInterface({ input: input as NodeJS.ReadableStream, output: output as NodeJS.WritableStream });
  try {
    output.write('\n');
    if (question.header) output.write(`${question.header}\n`);
    output.write(`${question.question}\n\n`);
    output.write(`${renderOptions(question).join('\n')}\n\n`);
    const optionCount = question.options.length + (question.allow_other ? 1 : 0);
    const prompt = isMultiAnswerableQuestion(question) ? 'Choose one or more options by number (comma-separated): ' : 'Choose an option by number: ';
    let selections: number[] | null = null;
    while (!selections) {
      selections = parseSelection(await rl.question(prompt), optionCount, isMultiAnswerableQuestion(question));
      if (!selections) output.write('Invalid selection. Please try again.\n');
    }
    return selections;
  } finally {
    rl.close();
  }
}

async function promptForOtherText(label: string, deps: QuestionUiDeps = {}): Promise<string> {
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;
  const rl = createPromptInterface({ input: input as NodeJS.ReadableStream, output: output as NodeJS.WritableStream });
  try {
    while (true) {
      const candidate = (await rl.question(`${label}: `)).trim();
      if (candidate) return candidate;
      output.write('Please enter a response.\n');
    }
  } finally {
    rl.close();
  }
}

async function promptForAnswersWithNumbers(record: QuestionRecord, deps: QuestionUiDeps = {}): Promise<QuestionAnswerEntry[]> {
  const entries: QuestionAnswerEntry[] = [];
  for (const [index, question] of recordQuestions(record).entries()) {
    const selections = await promptForQuestionWithNumbers(question, deps);
    let otherText: string | undefined;
    if (question.allow_other && selections.includes(question.options.length + 1)) otherText = await promptForOtherText(question.other_label, deps);
    entries.push({ question_id: question.id, index, answer: buildAnswer(question, selections, otherText) });
  }
  return entries;
}

export async function runQuestionUi(recordPath: string, deps: QuestionUiDeps = {}): Promise<void> {
  const record = await readQuestionRecord(recordPath);
  if (!record) throw new Error(`Question record not found: ${recordPath}`);
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;

  try {
    const questions = recordQuestions(record);
    let answers: QuestionAnswerEntry[];
    if (questions.length === 1) {
      const question = questions[0]!;
      const selections = supportsInteractiveArrowUi(input, output)
        ? await promptForSelectionsWithArrows(record, { input, output })
        : await promptForQuestionWithNumbers(question, { input, output });
      let otherText: string | undefined;
      if (question.allow_other && selections.includes(question.options.length + 1)) {
        otherText = await promptForOtherText(question.other_label, { input, output });
      }
      answers = [{ question_id: question.id, index: 0, answer: buildAnswer(question, selections, otherText) }];
    } else {
      answers = supportsInteractiveArrowUi(input, output)
        ? await promptForAnswersWithArrows(record, { input, output })
        : await promptForAnswersWithNumbers(record, { input, output });
    }
    const answeredRecord = await markQuestionAnswered(recordPath, answers);
    maybeInjectAnswers(answeredRecord, answers, { env: deps.env, injectAnswersToPane: deps.injectAnswersToPane });
  } catch (error) {
    await markQuestionTerminalError(recordPath, 'error', 'question_ui_failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
