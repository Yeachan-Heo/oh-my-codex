import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNonCleanReviewVerdict } from '../review-verdict.js';

function cleanStageArtifacts(): Record<string, unknown> {
  const scopeHash = 'a'.repeat(64);
  const reviewId = '11111111-1111-4111-8111-111111111111';
  const artifactPath = `.omx/reviews/${reviewId}.json`;
  const artifactSha256 = 'b'.repeat(64);
  const artifact = {
    schema_version: 1,
    review_id: reviewId,
    revision: 3,
    status: 'FINALIZED',
    current_attempt: 1,
    scope: {
      selector: { explicit_paths: [] },
      status: 'FULL_SCOPE',
      scope_hash: scopeHash,
      files: [{
        path: 'src/example.ts', change: 'MODIFIED', sources: ['WORKTREE'], binary: false,
        additions: 1, deletions: 0,
      }],
      changed_lines: 1,
      reasons: [],
    },
    review_flags: [],
    batches: [{
      batch_id: 'batch-1', module_root: '.', files: ['src/example.ts'], changed_lines: 1,
      oversized_single_file: false,
    }],
    lanes: [
      {
        lane_id: 'reviewer-1', role: 'code-reviewer', batch_id: 'batch-1', scope_hash: scopeHash,
        status: 'COMPLETE', attempt: 1, recommendation: 'APPROVE', findings: [], diagnostic_ids: [],
      },
      {
        lane_id: 'architect-1', role: 'architect', batch_id: 'global', scope_hash: scopeHash,
        status: 'COMPLETE', attempt: 1, architectural_status: 'CLEAR', findings: [], diagnostic_ids: [],
      },
    ],
    diagnostics: [],
    verdict: {
      recommendation: 'APPROVE', architectural_status: 'CLEAR', scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE', rule_id: 'CLEAN_APPROVAL',
      reasons: ['ALL_REQUIRED_EVIDENCE_CLEAR'], clean: true,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:01:00.000Z',
    finalized_at: '2026-07-15T00:01:00.000Z',
  };
  return {
    code_review_artifact: artifact,
    code_review_artifact_identity: {
      review_id: reviewId, revision: 3, artifact_path: artifactPath, artifact_sha256: artifactSha256,
    },
    review_verdict: {
      clean: true, recommendation: 'APPROVE', architectural_status: 'CLEAR', stage: 'code-review',
      artifact_path: artifactPath, artifact_sha256: artifactSha256,
    },
  };
}

describe('pipeline review verdict classification', () => {
  it('accepts only the exact clean verdict projected by a complete validated stage artifact', () => {
    const artifacts = cleanStageArtifacts();
    assert.equal(isNonCleanReviewVerdict(artifacts.review_verdict, artifacts), false);
    assert.equal(isNonCleanReviewVerdict({ ...(artifacts.review_verdict as object) }, artifacts), true);

    const inconsistent = {
      ...artifacts,
      review_verdict: { ...(artifacts.review_verdict as object), stage: 'other-stage' },
    };
    assert.equal(isNonCleanReviewVerdict(inconsistent.review_verdict, inconsistent), true);
  });

  it('does not accept a self-described clean runtime approval without validated artifact context', () => {
    assert.equal(isNonCleanReviewVerdict({
      clean: true,
      recommendation: 'APPROVE',
      architectural_status: 'CLEAR',
      stage: 'code-review',
      artifact_path: '.omx/reviews/11111111-1111-4111-8111-111111111111.json',
      artifact_sha256: 'a'.repeat(64),
    }), true);
  });

  it('fails closed for absent, malformed, partial, or unidentified verdicts', () => {
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
      {
        clean: true,
        recommendation: 'APPROVE',
        architectural_status: 'CLEAR',
        stage: 'code-review',
        artifact_path: '.omx/reviews/review.json',
        artifact_sha256: 'bad',
      },
    ]) {
      assert.equal(isNonCleanReviewVerdict(value), true, JSON.stringify(value));
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
