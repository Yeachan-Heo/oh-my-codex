import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNonCleanReviewVerdict } from '../review-verdict.js';

describe('isNonCleanReviewVerdict', () => {
  it('returns false for non-object verdicts', () => {
    assert.equal(isNonCleanReviewVerdict(null), false);
    assert.equal(isNonCleanReviewVerdict(undefined), false);
    assert.equal(isNonCleanReviewVerdict('clean'), false);
    assert.equal(isNonCleanReviewVerdict(42), false);
  });

  it('returns false for a clean verdict', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'APPROVE',
        architectural_status: 'CLEAR',
        clean: true,
      }),
      false,
    );
  });

  it('returns false when clean is absent but recommendation and status are clean', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'APPROVE',
        architectural_status: 'CLEAR',
      }),
      false,
    );
  });

  it('returns false for an empty verdict object', () => {
    assert.equal(isNonCleanReviewVerdict({}), false);
  });

  it('returns true when clean is explicitly false', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'APPROVE',
        architectural_status: 'CLEAR',
        clean: false,
      }),
      true,
    );
  });

  it('returns true for a REQUEST CHANGES recommendation', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'REQUEST CHANGES',
        architectural_status: 'CLEAR',
        clean: false,
      }),
      true,
    );
  });

  it('treats a non-APPROVE recommendation as non-clean even when clean is true', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'COMMENT',
        architectural_status: 'CLEAR',
        clean: true,
      }),
      true,
    );
  });

  it('treats a BLOCK architectural status as non-clean even when clean is true', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'APPROVE',
        architectural_status: 'BLOCK',
        clean: true,
      }),
      true,
    );
  });

  it('treats a WATCH architectural status as non-clean even when clean is true', () => {
    assert.equal(
      isNonCleanReviewVerdict({
        recommendation: 'APPROVE',
        architectural_status: 'WATCH',
        clean: true,
      }),
      true,
    );
  });
});
