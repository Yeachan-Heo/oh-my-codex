import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReviewRecord } from '../contract.js';
import {
  projectFinalReviewArtifact,
  validateFinalReviewArtifact,
} from '../render.js';

const REVIEW_ID = '22222222-2222-4222-8222-222222222222';
const SCOPE_HASH = 'a'.repeat(64);

function validArtifact(): Record<string, unknown> {
  return {
    schema_version: 1,
    review_id: REVIEW_ID,
    revision: 7,
    status: 'FINALIZED',
    current_attempt: 1,
    scope: {
      selector: { explicit_paths: [] },
      status: 'FULL_SCOPE',
      scope_hash: SCOPE_HASH,
      files: [{
        path: 'src/example.ts',
        change: 'MODIFIED',
        sources: ['WORKTREE'],
        binary: false,
        additions: 1,
        deletions: 0,
      }],
      changed_lines: 1,
      reasons: [],
    },
    review_flags: [],
    batches: [{
      batch_id: 'batch-1',
      module_root: '.',
      files: ['src/example.ts'],
      changed_lines: 1,
      oversized_single_file: false,
    }],
    lanes: [
      {
        lane_id: 'reviewer-1',
        role: 'code-reviewer',
        batch_id: 'batch-1',
        scope_hash: SCOPE_HASH,
        status: 'COMPLETE',
        attempt: 1,
        recommendation: 'APPROVE',
        findings: [],
        diagnostic_ids: [],
      },
      {
        lane_id: 'architect-1',
        role: 'architect',
        batch_id: 'global',
        scope_hash: SCOPE_HASH,
        status: 'COMPLETE',
        attempt: 1,
        architectural_status: 'CLEAR',
        findings: [],
        diagnostic_ids: [],
      },
    ],
    diagnostics: [],
    verdict: {
      recommendation: 'APPROVE',
      architectural_status: 'CLEAR',
      scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE',
      rule_id: 'CLEAN_APPROVAL',
      reasons: ['ALL_REQUIRED_EVIDENCE_CLEAR'],
      clean: true,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:01:00.000Z',
    finalized_at: '2026-07-15T00:01:00.000Z',
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

describe('final review artifact validation', () => {
  it('accepts a complete terminal artifact', () => {
    assert.equal(validateFinalReviewArtifact(validArtifact()).review_id, REVIEW_ID);
  });

  it('rejects malformed bounded fields, paths, and bounded collections', () => {
    const cases: Array<{ pattern: RegExp; mutate: (artifact: Record<string, unknown>) => void }> = [
      { pattern: /review_id must be a bounded string/, mutate: (artifact) => { artifact.review_id = ''; } },
      { pattern: /cryptographic UUID/, mutate: (artifact) => { artifact.review_id = 'not-a-uuid'; } },
      {
        pattern: /repository-relative/,
        mutate: (artifact) => { record(list(record(artifact.scope).files)[0]).path = '/absolute.ts'; },
      },
      {
        pattern: /escapes the repository root/,
        mutate: (artifact) => { record(list(record(artifact.scope).files)[0]).path = '../escape.ts'; },
      },
      {
        pattern: /explicit_paths must be a bounded array/,
        mutate: (artifact) => { record(record(artifact.scope).selector).explicit_paths = 'src'; },
      },
      {
        pattern: /sources must be non-empty/,
        mutate: (artifact) => { record(list(record(artifact.scope).files)[0]).sources = []; },
      },
      { pattern: /scope files must be a bounded array/, mutate: (artifact) => { record(artifact.scope).files = {}; } },
      { pattern: /scope reasons must be a bounded array/, mutate: (artifact) => { record(artifact.scope).reasons = {}; } },
      {
        pattern: /scope reason is invalid/,
        mutate: (artifact) => { record(artifact.scope).reasons = [null]; },
      },
      { pattern: /batch files must be a bounded array/, mutate: (artifact) => { record(list(artifact.batches)[0]).files = {}; } },
      { pattern: /lane findings exceed/, mutate: (artifact) => { record(list(artifact.lanes)[0]).findings = {}; } },
      { pattern: /diagnostic ids must be bounded/, mutate: (artifact) => { record(list(artifact.lanes)[0]).diagnostic_ids = {}; } },
      { pattern: /verdict reasons must be a bounded array/, mutate: (artifact) => { record(artifact.verdict).reasons = {}; } },
      { pattern: /verdict reason is invalid/, mutate: (artifact) => { record(artifact.verdict).reasons = [null]; } },
    ];

    for (const testCase of cases) {
      const artifact = structuredClone(validArtifact());
      testCase.mutate(artifact);
      assert.throws(() => validateFinalReviewArtifact(artifact), testCase.pattern);
    }
  });

  it('rejects cross-boundary contradictions and malformed top-level collections', () => {
    const cases: Array<{ pattern: RegExp; mutate: (artifact: Record<string, unknown>) => void }> = [
      {
        pattern: /outside the frozen scope/,
        mutate: (artifact) => { record(list(artifact.batches)[0]).files = ['src/other.ts']; },
      },
      {
        pattern: /non-failed lane must not contain failure evidence/,
        mutate: (artifact) => { record(list(artifact.lanes)[0]).failure_code = 'UNEXPECTED'; },
      },
      {
        pattern: /verdict scope status contradicts/,
        mutate: (artifact) => { record(artifact.verdict).scope_status = 'PARTIAL_SCOPE'; },
      },
      { pattern: /review_flags is invalid/, mutate: (artifact) => { artifact.review_flags = ['BATCHED_REVIEW', 'BATCHED_REVIEW']; } },
      { pattern: /final review collections are invalid/, mutate: (artifact) => { artifact.batches = {}; } },
    ];
    for (const testCase of cases) {
      const artifact = structuredClone(validArtifact());
      testCase.mutate(artifact);
      assert.throws(() => validateFinalReviewArtifact(artifact), testCase.pattern);
    }
  });

  it('rejects an aggregate finding count above the review limit', () => {
    const artifact = validArtifact();
    const finding = {
      severity: 'LOW',
      title: 'bounded finding',
      body: 'body',
      file: 'src/example.ts',
      fix: 'fix',
    };
    artifact.lanes = Array.from({ length: 26 }, (_, index) => ({
      lane_id: `reviewer-${index}`,
      role: 'code-reviewer',
      batch_id: 'batch-1',
      scope_hash: SCOPE_HASH,
      status: 'COMPLETE',
      attempt: 1,
      recommendation: 'APPROVE',
      findings: Array.from({ length: 200 }, () => finding),
      diagnostic_ids: [],
    }));
    assert.throws(() => validateFinalReviewArtifact(artifact), /findings exceed the review limit/);
  });

  it('rejects projection from a non-terminal review record', () => {
    assert.throws(() => projectFinalReviewArtifact({
      review_id: REVIEW_ID,
      status: 'REVIEWING',
    } as ReviewRecord), /review record is not terminal/);
  });

  it('projects every bounded terminal lane field before validating the artifact', () => {
    const projected = projectFinalReviewArtifact(validArtifact() as unknown as ReviewRecord);
    assert.deepEqual(projected.lanes, validArtifact().lanes);
    assert.equal(projected.review_id, REVIEW_ID);
  });
});
