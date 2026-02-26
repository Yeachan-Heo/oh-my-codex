import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getVerificationInstructions,
  determineTaskSize,
  getFixLoopInstructions,
  hasStructuredVerificationEvidence,
} from '../verifier.js';

describe('determineTaskSize', () => {
  it('returns small for low file count and line changes', () => {
    assert.equal(determineTaskSize(1, 10), 'small');
    assert.equal(determineTaskSize(3, 99), 'small');
  });

  it('returns standard for moderate file count and line changes', () => {
    assert.equal(determineTaskSize(4, 50), 'standard');
    assert.equal(determineTaskSize(15, 499), 'standard');
  });

  it('returns large for high file count', () => {
    assert.equal(determineTaskSize(16, 100), 'large');
  });

  it('returns large for high line changes', () => {
    assert.equal(determineTaskSize(5, 500), 'large');
  });

  it('returns small at exact boundary (3 files, 99 lines)', () => {
    assert.equal(determineTaskSize(3, 99), 'small');
  });

  it('returns standard when file count exceeds small threshold', () => {
    assert.equal(determineTaskSize(4, 99), 'standard');
  });

  it('returns standard when line changes hit 100 but files are low', () => {
    assert.equal(determineTaskSize(3, 100), 'standard');
  });

  it('returns large at exact boundary (15 files, 500 lines)', () => {
    assert.equal(determineTaskSize(15, 500), 'large');
  });

  it('returns large when file count exceeds standard threshold', () => {
    assert.equal(determineTaskSize(16, 0), 'large');
  });
});

describe('getVerificationInstructions', () => {
  it('includes the task description in all sizes', () => {
    const desc = 'Add login button';
    for (const size of ['small', 'standard', 'large'] as const) {
      const result = getVerificationInstructions(size, desc);
      assert.ok(result.includes(desc), `${size} should include task description`);
    }
  });

  it('includes Verification Protocol header for all sizes', () => {
    for (const size of ['small', 'standard', 'large'] as const) {
      const result = getVerificationInstructions(size, 'task');
      assert.ok(result.includes('## Verification Protocol'));
    }
  });

  it('returns small-specific instructions', () => {
    const result = getVerificationInstructions('small', 'fix typo');
    assert.ok(result.includes('type checker on modified files'));
    assert.ok(result.includes('PASS/FAIL'));
    // Should NOT contain large/standard-specific items
    assert.ok(!result.includes('Security review'));
    assert.ok(!result.includes('Run linter'));
  });

  it('returns standard-specific instructions', () => {
    const result = getVerificationInstructions('standard', 'add feature');
    assert.ok(result.includes('tsc --noEmit'));
    assert.ok(result.includes('Run linter'));
    assert.ok(result.includes('regressions'));
    // Should NOT contain large-specific items
    assert.ok(!result.includes('Security review'));
    assert.ok(!result.includes('Performance impact'));
  });

  it('returns large-specific instructions', () => {
    const result = getVerificationInstructions('large', 'refactor auth');
    assert.ok(result.includes('Security review'));
    assert.ok(result.includes('Performance impact'));
    assert.ok(result.includes('API compatibility'));
    assert.ok(result.includes('confidence level'));
  });
});

describe('getFixLoopInstructions', () => {
  it('returns instructions with default maxRetries of 3', () => {
    const result = getFixLoopInstructions();
    assert.ok(result.includes('Fix-Verify Loop'));
    assert.ok(result.includes('up to 3 times'));
    assert.ok(result.includes('after 3 attempts'));
  });

  it('respects custom maxRetries', () => {
    const result = getFixLoopInstructions(5);
    assert.ok(result.includes('up to 5 times'));
    assert.ok(result.includes('after 5 attempts'));
    assert.ok(!result.includes('up to 3 times'));
  });

  it('includes escalation guidance', () => {
    const result = getFixLoopInstructions();
    assert.ok(result.includes('escalate'));
    assert.ok(result.includes('What was attempted'));
    assert.ok(result.includes('Recommended next steps'));
  });
});

describe('hasStructuredVerificationEvidence', () => {
  it('returns true for structured verification summaries', () => {
    const summary = `
Summary: done
Verification Evidence:
- PASS build: \`npm run build\`
- PASS tests: \`node --test dist/foo.test.js\`
`;
    assert.equal(hasStructuredVerificationEvidence(summary), true);
  });

  it('returns false for unstructured summaries', () => {
    assert.equal(
      hasStructuredVerificationEvidence('Implemented fix and opened PR.'),
      false,
    );
  });

  it('returns false for missing input', () => {
    assert.equal(hasStructuredVerificationEvidence(undefined), false);
    assert.equal(hasStructuredVerificationEvidence(null), false);
    assert.equal(hasStructuredVerificationEvidence(''), false);
  });
});
