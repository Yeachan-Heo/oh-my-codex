import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualLoopFeedback } from '../verdict.js';
import { VISUAL_NEXT_ACTIONS_LIMIT } from '../constants.js';

describe('buildVisualLoopFeedback smoke samples', () => {
  it('accepts a HackerNews-like sample with a passing score', () => {
    const result = buildVisualLoopFeedback({
      score: 94,
      verdict: 'pass',
      category_match: true,
      differences: ['Header spacing is 2px tighter than reference'],
      suggestions: ['Leave layout unchanged and proceed'],
      reasoning: 'Overall structure and typography align with reference.',
    });

    assert.equal(result.passes_threshold, true);
    assert.equal(result.threshold, 90);
    assert.equal(result.score, 94);
    assert.equal(result.category_match, true);
    assert.equal(result.next_actions[0], 'Leave layout unchanged and proceed');
  });

  it('returns concrete next actions for an SNS-style sample under threshold', () => {
    const result = buildVisualLoopFeedback({
      score: 78,
      verdict: 'revise',
      category_match: true,
      differences: [
        'Primary CTA uses rounded corners instead of pill shape',
        'Card shadow is stronger than reference',
      ],
      suggestions: [
        'Update CTA border radius to 9999px',
        'Reduce shadow opacity to 0.12',
      ],
      reasoning: 'Composition is close, but component styling still diverges.',
    });

    assert.equal(result.passes_threshold, false);
    assert.equal(result.next_actions.includes('Update CTA border radius to 9999px'), true);
    assert.equal(result.next_actions.some((action) => action.includes('Fix: Primary CTA uses rounded corners')), true);
    assert.equal(result.next_actions.length <= VISUAL_NEXT_ACTIONS_LIMIT, true);
  });

  it('rejects malformed payloads missing required arrays', () => {
    assert.throws(
      () => buildVisualLoopFeedback({
        score: 91,
        verdict: 'pass',
        category_match: true,
        suggestions: ['Looks good'],
        reasoning: 'Looks solid.',
      }),
      /differences/,
    );
  });

  it('rejects non-integer score values', () => {
    assert.throws(
      () => buildVisualLoopFeedback({
        score: 90.5,
        verdict: 'pass',
        category_match: true,
        differences: [],
        suggestions: [],
        reasoning: 'Looks good.',
      }),
      /integer between 0 and 100/,
    );
  });

  it('rejects verdict status outside pass|revise|fail', () => {
    assert.throws(
      () => buildVisualLoopFeedback({
        score: 91,
        verdict: 'approve',
        category_match: true,
        differences: [],
        suggestions: [],
        reasoning: 'Looks good.',
      }),
      /pass\|revise\|fail/,
    );
  });

  it('requires non-empty reasoning', () => {
    assert.throws(
      () => buildVisualLoopFeedback({
        score: 91,
        verdict: 'pass',
        category_match: true,
        differences: [],
        suggestions: [],
        reasoning: '   ',
      }),
      /reasoning must be a non-empty string/,
    );
  });
});
