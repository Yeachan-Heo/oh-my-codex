import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeQuestionInput } from '../types.js';

describe('normalizeQuestionInput', () => {
  it('allows free-text-only prompts when allow_other is true', () => {
    const result = normalizeQuestionInput({
      question: 'Describe the desired evaluator command',
      options: [],
      allow_other: true,
      source: 'deep-interview',
    });

    assert.equal(result.question, 'Describe the desired evaluator command');
    assert.deepEqual(result.options, []);
    assert.equal(result.allow_other, true);
    assert.equal(result.type, 'single-answerable');
  });

  it('normalizes explicit multi-answerable type', () => {
    const result = normalizeQuestionInput({
      question: 'Pick one or more',
      options: ['A', 'B'],
      allow_other: false,
      type: 'multi-answerable',
    });

    assert.equal(result.type, 'multi-answerable');
    assert.equal(result.multi_select, true);
  });

  it('keeps legacy multi_select compatibility', () => {
    const result = normalizeQuestionInput({
      question: 'Pick one or more',
      options: ['A', 'B'],
      allow_other: false,
      multi_select: true,
    });

    assert.equal(result.type, 'multi-answerable');
    assert.equal(result.multi_select, true);
  });

  it('rejects conflicting explicit single-answerable type', () => {
    assert.throws(
      () => normalizeQuestionInput({ question: 'Pick one', options: ['A'], allow_other: false, type: 'single-answerable', multi_select: true }),
      /type=single-answerable conflicts with multi_select=true/,
    );
  });



  it('normalizes batch questions with stable unique ids', () => {
    const result = normalizeQuestionInput({
      header: 'Batch',
      questions: [
        { id: 'first', question: 'Pick first', options: ['A'], allow_other: false },
        { id: 'second', question: 'Pick second', options: ['B'], allow_other: false, type: 'multi-answerable' },
      ],
    });

    assert.equal(result.question, 'Pick first');
    assert.equal(result.questions?.length, 2);
    assert.equal(result.questions?.[0]?.id, 'first');
    assert.equal(result.questions?.[1]?.multi_select, true);
  });

  it('rejects duplicate batch question ids', () => {
    assert.throws(
      () => normalizeQuestionInput({
        questions: [
          { id: 'same', question: 'One', options: ['A'], allow_other: false },
          { id: 'same', question: 'Two', options: ['B'], allow_other: false },
        ],
      }),
      /questions id must be unique: same/,
    );
  });

  it('rejects empty options when allow_other is false', () => {
    assert.throws(
      () => normalizeQuestionInput({ question: 'Pick one', options: [], allow_other: false }),
      /options must be a non-empty array unless allow_other is true/,
    );
  });
});
