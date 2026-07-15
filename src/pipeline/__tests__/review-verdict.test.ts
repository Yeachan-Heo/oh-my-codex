import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNonCleanReviewVerdict } from '../review-verdict.js';

describe('pipeline review verdict classification', () => {
  it('accepts only absent or explicitly clean approval fields', () => {
    for (const value of [
      undefined,
      null,
      false,
      'APPROVE',
      {},
      { clean: true },
      { recommendation: 'APPROVE' },
      { architectural_status: 'CLEAR' },
      { clean: true, recommendation: 'APPROVE', architectural_status: 'CLEAR' },
    ]) {
      assert.equal(isNonCleanReviewVerdict(value), false, JSON.stringify(value));
    }
  });

  it('rejects each independently non-clean verdict signal', () => {
    for (const value of [
      { clean: false },
      { recommendation: 'COMMENT' },
      { recommendation: 'REQUEST CHANGES' },
      { architectural_status: 'WATCH' },
      { architectural_status: 'BLOCK' },
    ]) {
      assert.equal(isNonCleanReviewVerdict(value), true, JSON.stringify(value));
    }
  });
});
