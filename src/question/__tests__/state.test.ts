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
  readQuestionRecord,
  waitForQuestionTerminalState,
} from '../state.js';

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
