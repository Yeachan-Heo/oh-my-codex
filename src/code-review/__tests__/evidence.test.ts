import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LaneRecord,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewRecord,
  ScopeFile,
} from '../contract.js';
import { buildCapabilityPlan } from '../capabilities.js';
import {
  canonicalLanePayloadDigest,
  validateLaneIndependence,
  validateLaneResultEvidence,
  validateLaneStart,
  validatePostToolPublication,
} from '../evidence.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const RESULT_KEY = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const NOW = '2026-07-14T00:00:00.000Z';

function scopeFile(path = 'src/example.ts'): ScopeFile {
  return { path, change: 'MODIFIED', sources: ['WORKTREE'], binary: false, additions: 2, deletions: 1 };
}

function lane(overrides: Partial<LaneRecord> = {}): LaneRecord {
  return {
    lane_id: 'reviewer-batch-1',
    role: 'code-reviewer',
    batch_id: 'batch-1',
    scope_hash: HASH,
    status: 'RUNNING',
    attempt: 1,
    timeout_ms: 600_000,
    idle_deadline_at: '2026-07-14T00:10:00.000Z',
    findings: [],
    diagnostic_ids: [],
    provenance: {
      session_id: 'session-1',
      thread_id: 'child-reviewer',
      tracker_lane_id: 'reviewer-batch-1',
      tracker_path: '.omx/tracker/child-reviewer.json',
      first_seen_at: NOW,
      completed_at: '2026-07-14T00:05:00.000Z',
    },
    ...overrides,
  };
}

function review(lanes = [lane()]): ReviewRecord {
  return {
    schema_version: 1,
    revision: 1,
    review_id: REVIEW_ID,
    session_id: 'session-1',
    root_thread_id: 'root-1',
    status: 'REVIEWING',
    current_attempt: 1,
    effective_config: {
      lane_timeout_ms: 600_000,
      max_files_per_review: 100,
      max_changed_lines_per_review: 20_000,
      accepted_equivalents: [],
    },
    scope: {
      selector: { explicit_paths: [] },
      status: 'FULL_SCOPE',
      scope_hash: HASH,
      files: [scopeFile()],
      changed_lines: 3,
      reasons: [],
    },
    review_flags: [],
    batches: [{ batch_id: 'batch-1', module_root: '.', files: ['src/example.ts'], changed_lines: 3, oversized_single_file: false }],
    lanes,
    attempt_history: [{
      attempt: 1,
      status: 'REVIEWING',
      bindings: lanes.map((item) => ({ lane_id: item.lane_id, attempt: 1, role: item.role, batch_id: item.batch_id })),
      lane_ids: lanes.map((item) => item.lane_id),
      started_at: NOW,
      updated_at: NOW,
      resumable: false,
    }],
    diagnostics: [],
    resumable: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

function reviewerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'code-reviewer',
    review_id: REVIEW_ID,
    attempt: 1,
    lane_id: 'reviewer-batch-1',
    batch_id: 'batch-1',
    scope_hash: HASH,
    recommendation: 'APPROVE',
    findings: [],
    diagnostics: [
      {
        diagnostic_id: 'lsp-1',
        capability: 'LSP',
        applicability: 'APPLICABLE',
        execution: 'NATIVE',
        outcome: 'PASS',
        tool_name: 'mcp__code_intel__diagnostics',
        event_ref: 'tool-lsp-1',
        summary: 'No diagnostics',
      },
      {
        diagnostic_id: 'ast-1',
        capability: 'AST',
        applicability: 'APPLICABLE',
        execution: 'NATIVE',
        outcome: 'PASS',
        tool_name: 'mcp__code_intel__ast',
        event_ref: 'tool-ast-1',
        summary: 'No structural matches',
      },
    ],
    ...overrides,
  };
}

describe('lane evidence validation', () => {
  it('binds START only to the hook-derived current-session tracker lane', () => {
    const pending = lane({ status: 'PENDING', provenance: undefined });
    const current = review([pending]);
    const provenance = validateLaneStart({
      review: current,
      lane: current.lanes[0]!,
      thread_id: 'child-reviewer',
      tracker: {
        session_id: 'session-1',
        thread_id: 'child-reviewer',
        tracker_lane_id: 'reviewer-batch-1',
        tracker_path: '.omx/tracker/child-reviewer.json',
        first_seen_at: NOW,
      },
      alreadyBoundThreadIds: new Set(),
    });
    assert.equal(provenance.thread_id, 'child-reviewer');
    assert.equal(provenance.tracker_lane_id, 'reviewer-batch-1');
  });

  it('rejects missing, forged, reused, stale, cross-session, and spawn-label trackers', () => {
    const pending = lane({ status: 'PENDING', provenance: undefined });
    const current = review([pending]);
    const base = {
      review: current,
      lane: current.lanes[0]!,
      thread_id: 'child-reviewer',
      alreadyBoundThreadIds: new Set<string>(),
    };
    assert.throws(() => validateLaneStart({ ...base, tracker: undefined }), /tracker|provenance/i);
    for (const tracker of [
      { session_id: 'other', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
      { session_id: 'session-1', thread_id: 'other-child', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
      { session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'architect-global', tracker_path: 'tracker', first_seen_at: NOW },
      { session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: '2026-07-13T23:59:59.999Z' },
    ]) assert.throws(() => validateLaneStart({ ...base, tracker }), /tracker|attempt|lane|session|thread/i);
    assert.throws(() => validateLaneStart({
      ...base,
      tracker: { session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
      alreadyBoundThreadIds: new Set(['child-reviewer']),
    }), /bound|reuse/i);
  });

  it('requires exact reviewer capability coverage and lane-owned tool provenance', () => {
    const current = review();
    const plan = buildCapabilityPlan(current.scope!.files);
    const valid = validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult(),
      capabilityPlan: plan,
      toolEvents: [
        { event_ref: 'tool-lsp-1', thread_id: 'child-reviewer', tool_name: 'mcp__code_intel__diagnostics' },
        { event_ref: 'tool-ast-1', thread_id: 'child-reviewer', tool_name: 'mcp__code_intel__ast' },
      ],
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.evidence_status, 'FULL_EVIDENCE');
    assert.equal(valid.diagnostics.every((item) => item.thread_id === 'child-reviewer'), true);

    for (const diagnostics of [
      (reviewerResult().diagnostics as unknown[]).slice(0, 1),
      [...(reviewerResult().diagnostics as unknown[]), (reviewerResult().diagnostics as unknown[])[0]],
    ]) {
      const invalid = validateLaneResultEvidence({
        review: current,
        lane: current.lanes[0]!,
        result: reviewerResult({ diagnostics }),
        capabilityPlan: plan,
        toolEvents: [],
      });
      assert.equal(invalid.valid, false);
      assert.equal(invalid.maximum_recommendation, 'REQUEST CHANGES');
    }
  });

  it('degrades unverifiable event ownership and exact command/tool provenance', () => {
    const current = review();
    const result = validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult(),
      capabilityPlan: buildCapabilityPlan(current.scope!.files),
      toolEvents: [
        { event_ref: 'tool-lsp-1', thread_id: 'other-child', tool_name: 'mcp__code_intel__diagnostics' },
        { event_ref: 'tool-ast-1', thread_id: 'child-reviewer', tool_name: 'wrong-tool' },
      ],
    });
    assert.equal(result.valid, true);
    assert.equal(result.evidence_status, 'DEGRADED_EVIDENCE');
    assert.equal(result.maximum_recommendation, 'COMMENT');
    assert.match(result.reasons.join('\n'), /event|provenance|thread|tool/i);
  });

  it('rejects role, batch, scope, path, line, architect-diagnostic, contradiction, and payload limits', () => {
    const current = review();
    const plan = buildCapabilityPlan(current.scope!.files);
    const cases: unknown[] = [
      reviewerResult({ role: 'architect' }),
      reviewerResult({ batch_id: 'global' }),
      reviewerResult({ scope_hash: 'b'.repeat(64) }),
      reviewerResult({ findings: [{ severity: 'LOW', title: 'x', body: 'x', file: '../escape.ts', start_line: 1, fix: 'x' }] }),
      reviewerResult({ findings: [{ severity: 'LOW', title: 'x', body: 'x', file: 'src/example.ts', start_line: 0, fix: 'x' }] }),
      reviewerResult({ findings: [{ severity: 'HIGH', title: 'x', body: 'x', file: 'src/example.ts', start_line: 1, fix: 'x' }] }),
      { role: 'architect', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', batch_id: 'global', scope_hash: HASH, architectural_status: 'CLEAR', findings: [], diagnostics: [] },
      reviewerResult({ diagnostics: [], padding: 'x'.repeat(1024 * 1024) }),
    ];
    for (const candidate of cases) {
      const targetLane = (candidate as { role?: string }).role === 'architect'
        ? lane({ lane_id: 'architect-global', role: 'architect', batch_id: 'global' })
        : current.lanes[0]!;
      const validated = validateLaneResultEvidence({ review: current, lane: targetLane, result: candidate, capabilityPlan: plan });
      assert.equal(validated.valid, false, JSON.stringify(candidate).slice(0, 200));
    }
  });

  it('accepts one matching child publication and rejects fresh CLI, leader, cross-child, forged, reused, and copied attestations', () => {
    const current = review();
    const result = reviewerResult();
    const proposal: LaneResultProposal = {
      schema_version: 1,
      state: 'PENDING_HOST_ATTESTATION',
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: 'reviewer-batch-1',
      scope_hash: HASH,
      idempotency_key: RESULT_KEY,
      payload_digest: canonicalLanePayloadDigest(result),
      result: result as never,
      proposed_at: NOW,
    };
    const publication: ResultPostToolPublication = {
      schema_version: 1,
      publication_id: RESULT_KEY,
      published_at: '2026-07-14T00:04:00.000Z',
      activity: {
        schema_version: 1,
        session_id: 'session-1',
        review_id: REVIEW_ID,
        attempt: 1,
        lane_id: 'reviewer-batch-1',
        child_thread_id: 'child-reviewer',
        event_ref: 'result-tool-1',
        event_kind: 'RESULT_POST_TOOL',
        observed_at: '2026-07-14T00:04:00.000Z',
      },
      attestation: {
        schema_version: 1,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: REVIEW_ID,
        attempt: 1,
        lane_id: 'reviewer-batch-1',
        child_thread_id: 'child-reviewer',
        scope_hash: HASH,
        payload_digest: proposal.payload_digest,
        tool_event_ref: 'result-tool-1',
        nonce: 'nonce-1',
        published_at: '2026-07-14T00:04:00.000Z',
      },
    };
    assert.equal(validatePostToolPublication({
      review: current,
      lane: current.lanes[0]!,
      proposal,
      publication,
      consumedToolEventRefs: new Set(),
    }).publication_id, RESULT_KEY);

    for (const mutated of [
      { ...publication, publication_id: '33333333-3333-4333-8333-333333333333' },
      { ...publication, attestation: { ...publication.attestation, child_thread_id: 'root-1' } },
      { ...publication, activity: { ...publication.activity, child_thread_id: 'other-child' }, attestation: { ...publication.attestation, child_thread_id: 'other-child' } },
      { ...publication, attestation: { ...publication.attestation, payload_digest: 'b'.repeat(64) } },
      { ...publication, attestation: { ...publication.attestation, scope_hash: 'b'.repeat(64) } },
    ]) assert.throws(() => validatePostToolPublication({ review: current, lane: current.lanes[0]!, proposal, publication: mutated, consumedToolEventRefs: new Set() }), /publication|attestation|identity|digest|child|scope/i);
    assert.throws(() => validatePostToolPublication({ review: current, lane: current.lanes[0]!, proposal, publication, consumedToolEventRefs: new Set(['result-tool-1']) }), /consum|reuse/i);
  });

  it('enforces distinct overlapping initial lanes and only exempts explicit resume overlap', () => {
    const reviewer = lane();
    const architect = lane({
      lane_id: 'architect-global',
      role: 'architect',
      batch_id: 'global',
      provenance: {
        session_id: 'session-1',
        thread_id: 'child-architect',
        tracker_lane_id: 'architect-global',
        tracker_path: 'tracker-architect',
        first_seen_at: '2026-07-14T00:04:00.000Z',
        completed_at: '2026-07-14T00:06:00.000Z',
      },
    });
    assert.deepEqual(validateLaneIndependence({ lanes: [reviewer, architect], batched: false, resume: false }), []);
    const nonOverlap = { ...architect, provenance: { ...architect.provenance!, first_seen_at: '2026-07-14T00:06:00.001Z' } };
    assert.match(validateLaneIndependence({ lanes: [reviewer, nonOverlap], batched: false, resume: false }).join('\n'), /overlap/i);
    assert.deepEqual(validateLaneIndependence({ lanes: [reviewer, nonOverlap], batched: false, resume: true }), []);
    const reused = { ...architect, provenance: { ...architect.provenance!, thread_id: 'child-reviewer' } };
    assert.match(validateLaneIndependence({ lanes: [reviewer, reused], batched: false, resume: false }).join('\n'), /distinct|reuse/i);
  });
});
