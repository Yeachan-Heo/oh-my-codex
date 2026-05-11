import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createQuestionRecord,
  getQuestionRecordPath,
  markQuestionAnswered,
  markQuestionPrompting,
  markQuestionTerminalError,
  QuestionSubmitError,
  readQuestionRecord,
  submitQuestionAnswerById,
  waitForQuestionTerminalState,
} from '../state.js';
import { readQuestionEvents } from '../events.js';

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-question-state-'));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('question state', () => {
  it('creates records under session-scoped question state and reads them back', async () => {
    const cwd = await makeRepo();
    const { record, recordPath } = await createQuestionRecord(cwd, {
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      other_label: 'Other',
      multi_select: false,
    }, 'sess-1');

    assert.equal(recordPath, getQuestionRecordPath(cwd, record.question_id, 'sess-1'));
    const loaded = await readQuestionRecord(recordPath);
    assert.equal(loaded?.question, 'Pick one');
    assert.equal(loaded?.type, 'single-answerable');
  });

  it('emits a structured creation event with correlation metadata', async () => {
    const cwd = await makeRepo();
    const { record } = await createQuestionRecord(cwd, {
      header: 'Decision',
      question: 'Pick one',
      options: [{ label: 'A', value: 'a', description: 'Alpha lane' }],
      allow_other: false,
      other_label: 'Other',
      multi_select: false,
      source: 'test-source',
    }, 'sess-events', new Date('2026-05-11T00:00:00.000Z'), {
      emitEvent: true,
      timeoutMs: 1234,
      runId: 'run-1',
    });

    const event = (await readQuestionEvents(cwd)).find((item) => item.question_id === record.question_id);
    assert.equal(event?.type, 'question-created');
    assert.equal(event?.session_id, 'sess-events');
    assert.equal(event?.run_id, 'run-1');
    assert.equal(event?.context_summary, 'Decision — Pick one');
    assert.equal(event?.option_schema?.[0]?.options[0]?.description, 'Alpha lane');
    assert.equal(event?.state?.timeout_ms, 1234);
  });

  it('submits bounded answers by id and rejects duplicate stale or unknown submissions', async () => {
    const cwd = await makeRepo();
    const { record } = await createQuestionRecord(cwd, {
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: false,
      other_label: 'Other',
      multi_select: false,
    }, 'sess-submit');

    const submitted = await submitQuestionAnswerById(cwd, record.question_id, {
      answer: {
        kind: 'option',
        value: 'a',
        selected_labels: ['A'],
        selected_values: ['a'],
      },
    }, { sessionId: 'sess-submit' });

    assert.equal(submitted.record.status, 'answered');
    assert.equal(submitted.record.answer?.value, 'a');
    const events = await readQuestionEvents(cwd);
    assert.equal(events.at(-1)?.type, 'question-answered');
    assert.equal(events.at(-1)?.state?.answer_count, 1);

    await assert.rejects(
      () => submitQuestionAnswerById(cwd, record.question_id, {
        answer: {
          kind: 'option',
          value: 'a',
          selected_labels: ['A'],
          selected_values: ['a'],
        },
      }, { sessionId: 'sess-submit' }),
      (error) => error instanceof QuestionSubmitError && error.code === 'question_not_open',
    );

    await assert.rejects(
      () => submitQuestionAnswerById(cwd, 'question-missing', {
        answer: {
          kind: 'option',
          value: 'a',
          selected_labels: ['A'],
          selected_values: ['a'],
        },
      }, { sessionId: 'sess-submit' }),
      (error) => error instanceof QuestionSubmitError && error.code === 'question_unknown',
    );
  });

  it('waits for terminal answered state and returns free-text other values exactly', async () => {
    const cwd = await makeRepo();
    const { recordPath } = await createQuestionRecord(cwd, {
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      other_label: 'Other',
      multi_select: false,
    }, 'sess-2');

    const waiter = waitForQuestionTerminalState(recordPath, { pollIntervalMs: 10, timeoutMs: 2000 });
    setTimeout(() => {
      void markQuestionAnswered(recordPath, {
        kind: 'other',
        value: 'custom text',
        selected_labels: ['Other'],
        selected_values: ['custom text'],
        other_text: 'custom text',
      });
    }, 50);

    const finalRecord = await waiter;
    assert.equal(finalRecord.answer?.value, 'custom text');
    assert.equal(finalRecord.status, 'answered');
  });

  it('persists explicit terminal errors after prompting begins', async () => {
    const cwd = await makeRepo();
    const { recordPath } = await createQuestionRecord(cwd, {
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: true,
      other_label: 'Other',
      multi_select: false,
    }, 'sess-3');

    await markQuestionPrompting(recordPath, {
      renderer: 'tmux-pane',
      target: '%42',
      launched_at: new Date().toISOString(),
    });
    await markQuestionTerminalError(
      recordPath,
      'error',
      'question_runtime_failed',
      'Question UI pane %42 disappeared immediately after launch.',
    );

    const loaded = await readQuestionRecord(recordPath);
    assert.equal(loaded?.status, 'error');
    assert.equal(loaded?.error?.code, 'question_runtime_failed');
    assert.match(loaded?.error?.message || '', /pane %42 disappeared immediately after launch/);
  });

  it('does not regress an already answered record back to prompting when renderer metadata arrives late', async () => {
    const cwd = await makeRepo();
    const { recordPath } = await createQuestionRecord(cwd, {
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: false,
      other_label: 'Other',
      multi_select: false,
    }, 'sess-4');

    await markQuestionAnswered(recordPath, {
      kind: 'option',
      value: 'a',
      selected_labels: ['A'],
      selected_values: ['a'],
    });
    await markQuestionPrompting(recordPath, {
      renderer: 'tmux-pane',
      target: '%42',
      launched_at: '2026-04-19T00:00:00.000Z',
      return_target: '%11',
      return_transport: 'tmux-send-keys',
    });

    const loaded = await readQuestionRecord(recordPath);
    assert.equal(loaded?.status, 'answered');
    assert.equal(loaded?.answer?.value, 'a');
    assert.equal(loaded?.renderer?.return_target, '%11');
  });
});
