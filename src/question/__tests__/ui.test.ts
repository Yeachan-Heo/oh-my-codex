import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestionRecord, markQuestionPrompting, readQuestionRecord } from '../state.js';
import { normalizeQuestionInput } from '../types.js';
import { formatQuestionAnswerForInjection } from '../renderer.js';
import {
  applyInteractiveSelectionKey,
  applyQuestionWizardKey,
  createInitialInteractiveSelectionState,
  createInitialQuestionWizardState,
  promptForSelectionsWithArrows,
  renderInteractiveQuestionFrame,
  renderQuestionWizardFrame,
  runQuestionUi,
} from '../ui.js';
import type { QuestionRecord } from '../types.js';

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  rawMode = false;

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }

  resume(): void {}
  pause(): void {}
}

class FakeTtyOutput {
  isTTY = true;
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

function makeRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    kind: 'omx.question/v1',
    question_id: 'question-1',
    created_at: '2026-04-19T00:00:00.000Z',
    updated_at: '2026-04-19T00:00:00.000Z',
    status: 'prompting',
    question: 'Pick one',
    options: [
      { label: 'Alpha', value: 'alpha' },
      { label: 'Beta', value: 'beta' },
    ],
    allow_other: true,
    other_label: 'Other',
    multi_select: false,
    type: 'single-answerable',
    ...overrides,
  };
}

describe('question ui injection metadata', () => {
  it('persists return-target metadata for answered questions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-'));
    try {
      const { recordPath } = await createQuestionRecord(cwd, {
        question: 'Pick one',
        options: [{ label: 'A', value: 'a' }],
        allow_other: true,
        other_label: 'Other',
        multi_select: false,
        type: 'single-answerable',
      }, 'sess-ui');

      await markQuestionPrompting(recordPath, {
        renderer: 'tmux-pane',
        target: '%42',
        launched_at: '2026-04-19T00:00:00.000Z',
        return_target: '%11',
        return_transport: 'tmux-send-keys',
      });

      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.renderer?.return_target, '%11');
      assert.equal(loaded?.renderer?.return_transport, 'tmux-send-keys');
      assert.equal(
        formatQuestionAnswerForInjection({
          kind: 'other',
          value: 'hello can you hear me',
          selected_labels: ['Other'],
          selected_values: ['hello can you hear me'],
          other_text: 'hello can you hear me',
        }),
        '[omx question answered] hello can you hear me',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('question ui arrow navigation', () => {
  it('moves single-select cursor with up/down arrows and submits current selection on Enter', () => {
    const record = makeRecord();
    let state = createInitialInteractiveSelectionState();

    state = applyInteractiveSelectionKey(record, state, { name: 'down' }).state;
    assert.equal(state.cursorIndex, 1);

    state = applyInteractiveSelectionKey(record, state, { name: 'down' }).state;
    assert.equal(state.cursorIndex, 2);

    state = applyInteractiveSelectionKey(record, state, { name: 'up' }).state;
    assert.equal(state.cursorIndex, 1);

    const submit = applyInteractiveSelectionKey(record, state, { name: 'enter' });
    assert.equal(submit.submit, true);
    assert.equal(submit.state.cursorIndex, 1);
  });

  it('toggles multi-select choices with Space and requires a choice before Enter', () => {
    const record = makeRecord({ multi_select: true, type: 'multi-answerable', allow_other: false });
    let state = createInitialInteractiveSelectionState();

    let update = applyInteractiveSelectionKey(record, state, { name: 'enter' });
    assert.equal(update.submit, false);
    assert.match(update.state.error ?? '', /Select one or more options/);

    state = update.state;
    state = applyInteractiveSelectionKey(record, state, { name: 'space' }).state;
    assert.deepEqual(state.selectedIndices, [0]);

    state = applyInteractiveSelectionKey(record, state, { name: 'down' }).state;
    state = applyInteractiveSelectionKey(record, state, { name: 'space' }).state;
    assert.deepEqual(state.selectedIndices, [0, 1]);

    update = applyInteractiveSelectionKey(record, state, { name: 'enter' });
    assert.equal(update.submit, true);
    assert.deepEqual(update.state.selectedIndices, [0, 1]);
  });

  it('renders option descriptions inline next to each option to keep the frame compact', () => {
    const frame = renderInteractiveQuestionFrame(
      makeRecord({
        options: [
          { label: 'Alpha', value: 'alpha', description: 'First choice explanation' },
          { label: 'Beta', value: 'beta', description: 'Second choice explanation' },
        ],
      }),
      {
        cursorIndex: 0,
        selectedIndices: [],
      },
    );

    assert.match(frame, /› \[x\] 1\. Alpha — First choice explanation/);
    assert.match(frame, /\[ \] 2\. Beta — Second choice explanation/);
    assert.doesNotMatch(frame, /Alpha\n\s+First choice/, 'description must NOT be rendered on a separate line below the option');
  });

  it('renders compact navigation instructions with checkbox markers', () => {
    const frame = renderInteractiveQuestionFrame(
      makeRecord({ multi_select: true, type: 'multi-answerable' }),
      {
        cursorIndex: 1,
        selectedIndices: [0],
      },
    );

    assert.match(frame, /↑↓ move · Space toggle · Enter submit/);
    assert.match(frame, /\[x\] 1\. Alpha/);
    assert.match(frame, /› \[ \] 2\. Beta/);
  });

  it('collects arrow-based selection in interactive mode', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const promise = promptForSelectionsWithArrows(makeRecord(), { input, output });

    queueMicrotask(() => {
      input.emit('keypress', '', { name: 'down' });
      input.emit('keypress', '', { name: 'enter' });
    });

    const selections = await promise;
    assert.deepEqual(selections, [2]);
    assert.equal(input.rawMode, false);
    assert.match(output.toString(), /↑↓ move · Enter select/);
  });

  it('writes answered state from arrow-key interaction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-run-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        {
          question: 'Pick one',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          allow_other: false,
          other_label: 'Other',
          multi_select: false,
          type: 'single-answerable',
        },
        'sess-ui-run',
      );

      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, { input, output });

      setTimeout(() => {
        input.emit('keypress', '', { name: 'down' });
        input.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.status, 'answered');
      assert.equal(loaded?.answer?.kind, 'option');
      assert.equal(loaded?.answer?.value, 'b');
      assert.equal(loaded?.type, 'single-answerable');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('renders option descriptions in number-prompt mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-number-mode-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        {
          question: 'Which lane?',
          options: [
            { label: 'Plan first', value: 'ralplan', description: 'Need architecture and test-shape review before execution' },
            { label: 'Execute directly', value: 'autopilot', description: 'Requirements are already explicit enough for planning plus execution' },
          ],
          allow_other: false,
          other_label: 'Other',
          multi_select: false,
          type: 'single-answerable',
        },
        'sess-ui-number-mode',
      );

      const input = new PassThrough() as PassThrough & { isTTY: boolean };
      input.isTTY = false;
      const output = new PassThrough() as PassThrough & { isTTY: boolean };
      output.isTTY = false;
      let rendered = '';
      output.on('data', (chunk) => {
        rendered += chunk.toString();
      });

      const runPromise = runQuestionUi(recordPath, { input, output });
      input.write('1\n');
      input.end();

      await runPromise;
      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.answer?.value, 'ralplan');
      assert.match(rendered, /1\. Plan first\n\s+Need architecture and test-shape review before execution/);
      assert.match(rendered, /2\. Execute directly\n\s+Requirements are already explicit enough for planning plus execution/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('answers and injects through persisted renderer metadata when it races the UI answer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-stale-record-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        {
          question: 'Pick one',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          allow_other: false,
          other_label: 'Other',
          multi_select: false,
          type: 'single-answerable',
        },
        'sess-ui-stale',
      );

      const injected: Array<{ paneId: string; value: string | string[] }> = [];
      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, {
        input,
        output,
        injectAnswersToPane: (paneId, answers) => {
          injected.push({ paneId, value: answers[0]!.answer.value });
          return true;
        },
        closeQuestionRenderer: () => true,
      });

      setTimeout(() => {
        void (async () => {
          await markQuestionPrompting(recordPath, {
            renderer: 'tmux-pane',
            target: '%42',
            launched_at: '2026-04-19T00:00:00.000Z',
            return_target: '%11',
            return_transport: 'tmux-send-keys',
          });
          input.emit('keypress', '', { name: 'down' });
          input.emit('keypress', '', { name: 'enter' });
        })();
      }, 25);

      await runPromise;
      assert.deepEqual(injected, [{ paneId: '%11', value: 'b' }]);
      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.status, 'answered');
      assert.equal(loaded?.renderer?.return_target, '%11');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not use launcher return-target env as an answer transport', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-env-return-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        {
          question: 'Pick one',
          options: [{ label: 'A', value: 'a' }],
          allow_other: false,
          other_label: 'Other',
          multi_select: false,
          type: 'single-answerable',
        },
        'sess-ui-env',
      );

      const injected: Array<{ paneId: string; value: string | string[] }> = [];
      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, {
        input,
        output,
        env: {
          OMX_QUESTION_RETURN_TARGET: '%11',
          OMX_QUESTION_RETURN_TRANSPORT: 'tmux-send-keys',
        } as NodeJS.ProcessEnv,
        injectAnswersToPane: (paneId, answers) => {
          injected.push({ paneId, value: answers[0]!.answer.value });
          return true;
        },
        closeQuestionRenderer: () => true,
      });

      setTimeout(() => {
        input.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      assert.deepEqual(injected, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('persists multi-answerable checkbox selections without return-pane injection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-multi-env-return-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        {
          question: 'Pick all that apply',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          allow_other: false,
          other_label: 'Other',
          multi_select: true,
          type: 'multi-answerable',
        },
        'sess-ui-multi-env',
      );

      const injected: Array<{ paneId: string; value: string | string[] }> = [];
      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, {
        input,
        output,
        env: {
          OMX_QUESTION_RETURN_TARGET: '%11',
          OMX_QUESTION_RETURN_TRANSPORT: 'tmux-send-keys',
        } as NodeJS.ProcessEnv,
        injectAnswersToPane: (paneId, answers) => {
          injected.push({ paneId, value: answers[0]!.answer.value });
          return true;
        },
        closeQuestionRenderer: () => true,
      });

      setTimeout(() => {
        input.emit('keypress', '', { name: 'space' });
        input.emit('keypress', '', { name: 'down' });
        input.emit('keypress', '', { name: 'space' });
        input.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      assert.deepEqual(injected, []);
      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.status, 'answered');
      assert.deepEqual(loaded?.answer?.selected_values, ['a', 'b']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('question ui batch wizard', () => {
  it('signals needsOtherText before advancing when Other is picked, then renders the inline text into review', () => {
    const record = makeRecord({
      questions: [
        {
          id: 'first',
          question: 'First?',
          options: [{ label: 'A', value: 'a' }],
          allow_other: true,
          other_label: 'Custom',
          multi_select: false,
          type: 'single-answerable',
        },
      ],
    });
    let state = createInitialQuestionWizardState(record);
    state = applyQuestionWizardKey(record, state, { name: 'down' }).state;

    const firstAdvance = applyQuestionWizardKey(record, state, { name: 'enter' });
    assert.equal(firstAdvance.needsOtherText, 0, 'wizard must request inline Other text before advancing');
    assert.equal(firstAdvance.submit, false);
    assert.equal(firstAdvance.state.mode, 'answering', 'wizard must stay in answering mode until Other text is collected');

    state = { ...firstAdvance.state, otherTexts: ['my custom answer'] };

    const secondAdvance = applyQuestionWizardKey(record, state, { name: 'enter' });
    assert.equal(secondAdvance.needsOtherText, undefined, 'wizard must not re-prompt once Other text is stored');
    assert.equal(secondAdvance.state.mode, 'review', 'wizard advances to review after inline text is captured');
    assert.match(renderQuestionWizardFrame(record, secondAdvance.state), /Custom: my custom answer/);
  });

  it('clears stored Other text when the user navigates back and changes the selection away from Other', () => {
    const record = makeRecord({
      questions: [
        {
          id: 'first',
          question: 'First?',
          options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
          allow_other: true,
          other_label: 'Custom',
          multi_select: false,
          type: 'single-answerable',
        },
      ],
    });
    let state = createInitialQuestionWizardState(record);
    state = applyQuestionWizardKey(record, state, { name: 'down' }).state;
    state = applyQuestionWizardKey(record, state, { name: 'down' }).state;
    const advance = applyQuestionWizardKey(record, state, { name: 'enter' });
    assert.equal(advance.needsOtherText, 0);
    state = { ...advance.state, otherTexts: ['stale custom text'] };

    const moveToA = applyQuestionWizardKey(record, state, { name: 'up' });
    state = moveToA.state;
    const moveToA2 = applyQuestionWizardKey(record, state, { name: 'up' });
    state = moveToA2.state;
    assert.equal(state.otherTexts[0], undefined, 'wizard must drop stale Other text once the user cursors away from Other');
  });

  it('submits a batch after navigating back and editing an earlier answer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-batch-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        normalizeQuestionInput({
          header: 'Batch prompt',
          questions: [
            { id: 'first', question: 'First?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], allow_other: false },
            { id: 'second', question: 'Second?', options: [{ label: 'C', value: 'c' }, { label: 'D', value: 'd' }], allow_other: false },
          ],
        }),
        'sess-ui-batch',
      );

      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, { input, output });

      setTimeout(() => {
        input.emit('keypress', '', { name: 'enter' });
        input.emit('keypress', '', { name: 'down' });
        input.emit('keypress', '', { name: 'enter' });
        input.emit('keypress', '', { name: 'left' });
        input.emit('keypress', '', { name: 'left' });
        input.emit('keypress', '', { name: 'down' });
        input.emit('keypress', '', { name: 'enter' });
        input.emit('keypress', '', { name: 'enter' });
        input.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      const loaded = await readQuestionRecord(recordPath);
      assert.equal(loaded?.status, 'answered');
      assert.deepEqual(loaded?.answers?.map((entry) => entry.answer.value), ['b', 'd']);
      assert.match(output.toString(), /Question 2 of 2/);
      assert.match(output.toString(), /Press Enter to submit/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('persists every batch answer and injects through return-pane metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-question-ui-batch-inject-'));
    try {
      const { recordPath } = await createQuestionRecord(
        cwd,
        normalizeQuestionInput({
          header: 'Batch prompt',
          questions: [
            { id: 'first', question: 'First?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], allow_other: false },
            { id: 'second', question: 'Second?', options: [{ label: 'C', value: 'c' }, { label: 'D', value: 'd' }], allow_other: false },
          ],
        }),
        'sess-ui-batch-inject',
      );
      await markQuestionPrompting(recordPath, {
        renderer: 'tmux-pane',
        target: '%42',
        launched_at: '2026-04-19T00:00:00.000Z',
        return_target: '%11',
        return_transport: 'tmux-send-keys',
      });

      const injected: Array<{ paneId: string; values: Array<string | string[]> }> = [];
      const input = new FakeTtyInput();
      const output = new FakeTtyOutput();
      const runPromise = runQuestionUi(recordPath, {
        input,
        output,
        injectAnswersToPane: (paneId, answers) => {
          injected.push({ paneId, values: answers.map((entry) => entry.answer.value) });
          return true;
        },
        closeQuestionRenderer: () => true,
      });

      setTimeout(() => {
        input.emit('keypress', '', { name: 'enter' });
        input.emit('keypress', '', { name: 'down' });
        input.emit('keypress', '', { name: 'enter' });
        input.emit('keypress', '', { name: 'enter' });
      }, 25);

      await runPromise;
      assert.deepEqual(injected, [{ paneId: '%11', values: ['a', 'd'] }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
