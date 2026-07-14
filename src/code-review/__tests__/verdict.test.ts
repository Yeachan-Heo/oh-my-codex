import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArchitectStatus, LaneRecord, ReviewRecommendation } from '../contract.js';
import { synthesizeVerdict } from '../verdict.js';

const HASH = 'a'.repeat(64);

function reviewer(recommendation: ReviewRecommendation, overrides: Partial<LaneRecord> = {}): LaneRecord {
  return {
    lane_id: 'reviewer-batch-1',
    role: 'code-reviewer',
    batch_id: 'batch-1',
    scope_hash: HASH,
    status: 'COMPLETE',
    attempt: 1,
    timeout_ms: 600_000,
    idle_deadline_at: '2026-07-14T00:10:00.000Z',
    recommendation,
    findings: [],
    diagnostic_ids: ['lsp', 'ast'],
    ...overrides,
  };
}

function architect(status: ArchitectStatus, overrides: Partial<LaneRecord> = {}): LaneRecord {
  return {
    lane_id: 'architect-global',
    role: 'architect',
    batch_id: 'global',
    scope_hash: HASH,
    status: 'COMPLETE',
    attempt: 1,
    timeout_ms: 600_000,
    idle_deadline_at: '2026-07-14T00:10:00.000Z',
    architectural_status: status,
    findings: [],
    diagnostic_ids: [],
    ...overrides,
  };
}

function verdict(recommendation: ReviewRecommendation, architecturalStatus: ArchitectStatus, options: Record<string, unknown> = {}) {
  return synthesizeVerdict({
    scope_status: 'FULL_SCOPE',
    evidence_status: 'FULL_EVIDENCE',
    expected_reviewer_lane_ids: ['reviewer-batch-1'],
    reviewer_lanes: [reviewer(recommendation)],
    architect_lane: architect(architecturalStatus),
    ...options,
  });
}

describe('verdict synthesis', () => {
  it('implements the complete reviewer recommendation by architect status truth table', () => {
    const expected: Record<ReviewRecommendation, Record<ArchitectStatus, ReviewRecommendation>> = {
      APPROVE: { CLEAR: 'APPROVE', WATCH: 'COMMENT', BLOCK: 'REQUEST CHANGES' },
      COMMENT: { CLEAR: 'COMMENT', WATCH: 'COMMENT', BLOCK: 'REQUEST CHANGES' },
      'REQUEST CHANGES': { CLEAR: 'REQUEST CHANGES', WATCH: 'REQUEST CHANGES', BLOCK: 'REQUEST CHANGES' },
    };
    for (const recommendation of Object.keys(expected) as ReviewRecommendation[]) {
      for (const status of Object.keys(expected[recommendation]) as ArchitectStatus[]) {
        assert.equal(verdict(recommendation, status).recommendation, expected[recommendation][status], `${recommendation} × ${status}`);
      }
    }
  });

  it('evaluates all ordered overrides before the approval rule', () => {
    const cases = [
      [verdict('APPROVE', 'CLEAR', { no_changes: true }), 'COMMENT', 'NO_CHANGES'],
      [verdict('APPROVE', 'CLEAR', { failures: ['MISSING_LANE'] }), 'REQUEST CHANGES', 'INVALID_OR_MISSING_EVIDENCE'],
      [verdict('APPROVE', 'CLEAR', { diagnostic_failure: true }), 'REQUEST CHANGES', 'DIAGNOSTIC_FAILED'],
      [verdict('APPROVE', 'BLOCK'), 'REQUEST CHANGES', 'LANE_REQUEST_CHANGES'],
      [verdict('APPROVE', 'CLEAR', { reviewer_lanes: [reviewer('APPROVE', { findings: [{ severity: 'HIGH', title: 'high', body: 'body', file: 'src/a.ts', fix: 'fix' }] })] }), 'REQUEST CHANGES', 'CONTRADICTORY_LANE'],
      [verdict('APPROVE', 'CLEAR', { scope_status: 'PARTIAL_SCOPE' }), 'COMMENT', 'PARTIAL_OR_DEGRADED'],
      [verdict('APPROVE', 'WATCH'), 'COMMENT', 'COMMENT_OR_FINDINGS'],
      [verdict('APPROVE', 'CLEAR'), 'APPROVE', 'CLEAN_APPROVAL'],
    ] as const;
    for (const [actual, recommendation, rule] of cases) {
      assert.equal(actual.recommendation, recommendation);
      assert.equal(actual.rule_id, rule);
      assert.equal(actual.clean, rule === 'CLEAN_APPROVAL');
    }
  });

  it('requires every planned reviewer and one architect and never infers approval from missing values', () => {
    const missingReviewer = verdict('APPROVE', 'WATCH', {
      expected_reviewer_lane_ids: ['reviewer-batch-1', 'reviewer-batch-2'],
    });
    assert.equal(missingReviewer.recommendation, 'REQUEST CHANGES');
    assert.equal(missingReviewer.architectural_status, 'WATCH');
    const missingArchitect = synthesizeVerdict({
      scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE',
      expected_reviewer_lane_ids: ['reviewer-batch-1'],
      reviewer_lanes: [reviewer('APPROVE')],
    });
    assert.equal(missingArchitect.recommendation, 'REQUEST CHANGES');
    assert.equal(missingArchitect.architectural_status, 'BLOCK');
    assert.equal(missingArchitect.clean, false);
  });

  it('aggregates the worst result across every batch and every finding', () => {
    const result = synthesizeVerdict({
      scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE',
      expected_reviewer_lane_ids: ['reviewer-batch-1', 'reviewer-batch-2', 'reviewer-batch-3'],
      reviewer_lanes: [
        reviewer('APPROVE'),
        reviewer('COMMENT', { lane_id: 'reviewer-batch-2', batch_id: 'batch-2' }),
        reviewer('REQUEST CHANGES', { lane_id: 'reviewer-batch-3', batch_id: 'batch-3' }),
      ],
      architect_lane: architect('CLEAR'),
    });
    assert.equal(result.recommendation, 'REQUEST CHANGES');
  });

  it('is monotonic under worse scope, evidence, lane status, recommendation, and findings', () => {
    const severity = { APPROVE: 0, COMMENT: 1, 'REQUEST CHANGES': 2 } as const;
    const baseline = verdict('APPROVE', 'CLEAR');
    const worsened = [
      verdict('APPROVE', 'CLEAR', { scope_status: 'PARTIAL_SCOPE' }),
      verdict('APPROVE', 'CLEAR', { evidence_status: 'DEGRADED_EVIDENCE' }),
      verdict('APPROVE', 'CLEAR', { reviewer_lanes: [reviewer('APPROVE', { status: 'FAILED' })] }),
      verdict('COMMENT', 'CLEAR'),
      verdict('REQUEST CHANGES', 'CLEAR'),
      verdict('APPROVE', 'WATCH'),
      verdict('APPROVE', 'BLOCK'),
      verdict('APPROVE', 'CLEAR', { reviewer_lanes: [reviewer('APPROVE', { findings: [{ severity: 'LOW', title: 'low', body: 'body', file: 'src/a.ts', fix: 'fix' }] })] }),
    ];
    for (const result of worsened) {
      assert.ok(severity[result.recommendation] >= severity[baseline.recommendation]);
      assert.equal(result.clean, false);
    }
  });

  it('defines clean exactly as full scope/evidence, complete approvals, clear architect, and zero findings', () => {
    assert.equal(verdict('APPROVE', 'CLEAR').clean, true);
    assert.equal(verdict('APPROVE', 'CLEAR', { evidence_status: 'DEGRADED_EVIDENCE' }).clean, false);
    assert.equal(verdict('APPROVE', 'CLEAR', { reviewer_lanes: [reviewer('APPROVE', { findings: [{ severity: 'MEDIUM', title: 'm', body: 'b', file: 'src/a.ts', fix: 'f' }] })] }).clean, false);
  });
});
