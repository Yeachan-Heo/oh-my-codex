import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LaneRecord,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewAttempt,
  ReviewRecord,
  ScopeFile,
} from '../contract.js';
import { buildCapabilityPlan } from '../capabilities.js';
import {
  canonicalLanePayloadDigest,
  parseDiagnosticToolEvents,
  parseLaneActivityEvent,
  parseLaneResultSubmission,
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

function toolEvent(eventRef: string, childThreadId: string, toolName: string) {
  return {
    schema_version: 1 as const,
    session_id: 'session-1',
    review_id: REVIEW_ID,
    attempt: 1,
    lane_id: 'reviewer-batch-1',
    child_thread_id: childThreadId,
    event_ref: eventRef,
    observed_at: '2026-07-14T00:04:00.000Z',
    tool_name: toolName,
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
        schema_version: 1,
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
      { schema_version: 1, session_id: 'other', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
      { schema_version: 1, session_id: 'session-1', thread_id: 'other-child', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
      { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'architect-global', tracker_path: 'tracker', first_seen_at: NOW },
      { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: '2026-07-13T23:59:59.999Z' },
    ]) assert.throws(() => validateLaneStart({ ...base, tracker }), /tracker|attempt|lane|session|thread/i);
    assert.throws(() => validateLaneStart({
      ...base,
      tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
      alreadyBoundThreadIds: new Set(['child-reviewer']),
    }), /bound|reuse/i);
    assert.throws(() => validateLaneStart({
      ...base,
      lane: { ...base.lane, status: 'RUNNING' },
      tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker', first_seen_at: NOW },
    }), /pending|attempt/i);
    assert.throws(() => validateLaneStart({
      ...base,
      tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: '', first_seen_at: NOW },
    }), /path/i);
  });

  it('parses hook trackers as strict unknown data with exact bounded fields', () => {
    const pending = lane({ status: 'PENDING', provenance: undefined });
    const current = review([pending]);
    const base = {
      review: current,
      lane: pending,
      thread_id: 'child-reviewer',
      alreadyBoundThreadIds: new Set<string>(),
    };
    const trusted = {
      schema_version: 1,
      session_id: 'session-1',
      thread_id: 'child-reviewer',
      tracker_lane_id: 'reviewer-batch-1',
      tracker_path: '.omx/tracker/child-reviewer.json',
      first_seen_at: NOW,
    };
    assert.equal(validateLaneStart({ ...base, tracker: trusted as never }).thread_id, 'child-reviewer');
    for (const candidate of [
      { ...trusted, schema_version: 2 },
      { ...trusted, unexpected: true },
      { ...trusted, first_seen_at: 'not-a-time' },
      { ...trusted, last_seen_at: '2026-07-13T23:59:59.999Z' },
      { ...trusted, tracker_path: 'x'.repeat(1_025) },
    ]) {
      assert.throws(() => validateLaneStart({ ...base, tracker: candidate as never }), /tracker|schema|field|timestamp|path/i);
    }
  });

  it('parses strict activity and diagnostic event journals with unique provenance', () => {
    const base = {
      schema_version: 1,
      session_id: 'session-1',
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: 'reviewer-batch-1',
      child_thread_id: 'child-reviewer',
      event_ref: 'event-1',
      observed_at: '2026-07-14T00:04:00.000Z',
    };
    assert.equal(parseDiagnosticToolEvents([{ ...base, tool_name: 'mcp__code_intel__ast' }]).length, 1);
    assert.equal(parseLaneActivityEvent({ ...base, event_kind: 'TOOL_END' }).event_kind, 'TOOL_END');
    for (const candidate of [
      {},
      { ...base, review_id: 'not-a-uuid', tool_name: 'tool' },
      { ...base, tool_name: 'tool', program: 'tsc' },
      { ...base },
    ]) {
      assert.throws(() => parseDiagnosticToolEvents([candidate]), /event|provenance|UUID|schema|bounded/i);
    }
    assert.throws(() => parseDiagnosticToolEvents([
      { ...base, tool_name: 'tool' },
      { ...base, tool_name: 'tool' },
    ]), /duplicated/);
    assert.throws(() => parseLaneActivityEvent({ ...base, event_kind: 'UNKNOWN' }), /activity event/);
  });

  it('rejects cyclic and malformed exact lane result submissions', () => {
    const current = review();
    const cyclic = reviewerResult();
    cyclic.self = cyclic;
    assert.throws(() => parseLaneResultSubmission({
      review: current,
      lane: current.lanes[0]!,
      result: cyclic,
    }), /serializable plain JSON/);
    assert.throws(() => parseLaneResultSubmission({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult({ diagnostics: null }),
    }), /schema, limits, or identity/);

    const cyclicEvidence = reviewerResult();
    cyclicEvidence.self = cyclicEvidence;
    assert.equal(validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: cyclicEvidence,
    }).valid, false);
    assert.equal(validateLaneResultEvidence({
      review: current,
      lane: { ...current.lanes[0]!, status: 'PENDING', provenance: undefined },
      result: reviewerResult(),
    }).valid, false);
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
        toolEvent('tool-lsp-1', 'child-reviewer', 'mcp__code_intel__diagnostics'),
        toolEvent('tool-ast-1', 'child-reviewer', 'mcp__code_intel__ast'),
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

  it('fails each lane evidence boundary before capability evaluation can mask it', () => {
    const current = review();
    const plan = buildCapabilityPlan(current.scope!.files);
    const events = [
      toolEvent('tool-lsp-1', 'child-reviewer', 'mcp__code_intel__diagnostics'),
      toolEvent('tool-ast-1', 'child-reviewer', 'mcp__code_intel__ast'),
    ];
    const oversized = validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult({ padding: 'x'.repeat(3 * 1024 * 1024) }),
      capabilityPlan: plan,
      toolEvents: events,
    });
    assert.ok(oversized.reasons.includes('PAYLOAD_OVERSIZED'));

    for (const invalidLane of [
      { ...current.lanes[0]!, status: 'PENDING' as const },
      { ...current.lanes[0]!, provenance: undefined },
    ]) {
      const validated = validateLaneResultEvidence({
        review: current,
        lane: invalidLane,
        result: reviewerResult(),
        capabilityPlan: plan,
        toolEvents: events,
      });
      assert.equal(validated.valid, false);
      assert.ok(validated.reasons.includes('LANE_OR_RESULT_INVALID'));
    }

    const missingPlan = validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult(),
      toolEvents: events,
    });
    assert.equal(missingPlan.valid, false);
    assert.ok(missingPlan.reasons.includes('CAPABILITY_PLAN_MISSING'));

    for (const diagnostics of [
      (reviewerResult().diagnostics as unknown[]).slice(0, 1),
      [...(reviewerResult().diagnostics as unknown[]), (reviewerResult().diagnostics as unknown[])[0]],
    ]) {
      const invalidCoverage = validateLaneResultEvidence({
        review: current,
        lane: current.lanes[0]!,
        result: reviewerResult({ diagnostics }),
        capabilityPlan: plan,
        toolEvents: events,
      });
      assert.equal(invalidCoverage.valid, false);
      assert.ok(invalidCoverage.reasons.includes('DIAGNOSTIC_CAPABILITY_COVERAGE_INVALID'));
    }

    const architectLane = lane({
      lane_id: 'architect-global', role: 'architect', batch_id: 'global',
    });
    const architect = validateLaneResultEvidence({
      review: review([architectLane]),
      lane: architectLane,
      result: {
        role: 'architect', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global',
        batch_id: 'global', scope_hash: HASH, architectural_status: 'CLEAR', findings: [],
      },
    });
    assert.equal(architect.valid, true);
    assert.deepEqual(architect.diagnostics, []);
  });

  it('degrades unverifiable event ownership and exact command/tool provenance', () => {
    const current = review();
    const result = validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult(),
      capabilityPlan: buildCapabilityPlan(current.scope!.files),
      toolEvents: [
        toolEvent('tool-lsp-1', 'other-child', 'mcp__code_intel__diagnostics'),
        toolEvent('tool-ast-1', 'child-reviewer', 'wrong-tool'),
      ],
    });
    assert.equal(result.valid, true);
    assert.equal(result.evidence_status, 'DEGRADED_EVIDENCE');
    assert.equal(result.maximum_recommendation, 'COMMENT');
    assert.match(result.reasons.join('\n'), /event|provenance|thread|tool/i);
  });

  it('accepts an attested equivalent command and rejects a failed capability evaluation', () => {
    const current = review();
    current.effective_config.accepted_equivalents = [{
      capability: 'LSP',
      source: 'REPO_CONTRACT',
      source_ref: `${'b'.repeat(40)}:code-review-equivalents.json#typescript-lsp`,
      program: 'tsc',
      args: ['--noEmit'],
    }];
    const diagnostics = structuredClone(reviewerResult().diagnostics) as Array<Record<string, unknown>>;
    diagnostics[0] = {
      ...diagnostics[0],
      execution: 'ACCEPTED_EQUIVALENT',
      source_ref: current.effective_config.accepted_equivalents[0]!.source_ref,
      program: 'tsc',
      args: ['--noEmit'],
      tool_name: undefined,
    };
    delete diagnostics[0]!.tool_name;
    const accepted = validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult({ diagnostics }),
      capabilityPlan: buildCapabilityPlan(current.scope!.files),
      toolEvents: [
        {
          schema_version: 1,
          session_id: 'session-1',
          review_id: REVIEW_ID,
          attempt: 1,
          lane_id: 'reviewer-batch-1',
          child_thread_id: 'child-reviewer',
          event_ref: 'tool-lsp-1',
          observed_at: '2026-07-14T00:04:00.000Z',
          program: 'tsc',
          args: ['--noEmit'],
        },
        toolEvent('tool-ast-1', 'child-reviewer', 'mcp__code_intel__ast'),
      ],
    });
    assert.equal(accepted.valid, true);

    diagnostics[0] = { ...diagnostics[0], execution: 'NATIVE', outcome: 'FAIL', tool_name: 'mcp__code_intel__diagnostics' };
    delete diagnostics[0]!.program;
    delete diagnostics[0]!.args;
    delete diagnostics[0]!.source_ref;
    assert.equal(validateLaneResultEvidence({
      review: current,
      lane: current.lanes[0]!,
      result: reviewerResult({ diagnostics }),
      capabilityPlan: buildCapabilityPlan(current.scope!.files),
      toolEvents: [],
    }).valid, false);
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
        nonce: 'nonce_123',
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

    const conflictingTimestamp = {
      ...publication,
      published_at: '2026-07-14T00:04:01.000Z',
    };
    assert.throws(() => validatePostToolPublication({
      review: current, lane: current.lanes[0]!, proposal,
      publication: conflictingTimestamp, consumedToolEventRefs: new Set(),
    }), /timestamps conflict/);
    const afterDeadline = {
      ...publication,
      published_at: '2026-07-14T00:11:00.000Z',
      activity: { ...publication.activity, observed_at: '2026-07-14T00:11:00.000Z' },
      attestation: { ...publication.attestation, published_at: '2026-07-14T00:11:00.000Z' },
    };
    assert.throws(() => validatePostToolPublication({
      review: current, lane: current.lanes[0]!, proposal,
      publication: afterDeadline, consumedToolEventRefs: new Set(),
    }), /after the idle deadline/);

    for (const mutated of [
      { ...publication, publication_id: '33333333-3333-4333-8333-333333333333' },
      { ...publication, attestation: { ...publication.attestation, child_thread_id: 'root-1' } },
      { ...publication, activity: { ...publication.activity, child_thread_id: 'other-child' }, attestation: { ...publication.attestation, child_thread_id: 'other-child' } },
      { ...publication, attestation: { ...publication.attestation, payload_digest: 'b'.repeat(64) } },
      { ...publication, attestation: { ...publication.attestation, scope_hash: 'b'.repeat(64) } },
    ]) assert.throws(() => validatePostToolPublication({ review: current, lane: current.lanes[0]!, proposal, publication: mutated, consumedToolEventRefs: new Set() }), /publication|attestation|identity|digest|child|scope/i);
    assert.throws(() => validatePostToolPublication({ review: current, lane: current.lanes[0]!, proposal, publication, consumedToolEventRefs: new Set(['result-tool-1']) }), /consum|reuse/i);
  });

  it('strictly rejects malformed publication fields, nonce formats, oversized refs, and unknown keys', () => {
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
    const valid: ResultPostToolPublication = {
      schema_version: 1,
      publication_id: RESULT_KEY,
      published_at: '2026-07-14T00:04:00.000Z',
      activity: {
        schema_version: 1, session_id: 'session-1', review_id: REVIEW_ID, attempt: 1,
        lane_id: 'reviewer-batch-1', child_thread_id: 'child-reviewer', event_ref: 'result-tool-1',
        event_kind: 'RESULT_POST_TOOL', observed_at: '2026-07-14T00:04:00.000Z',
      },
      attestation: {
        schema_version: 1, session_id: 'session-1', root_thread_id: 'root-1', review_id: REVIEW_ID,
        attempt: 1, lane_id: 'reviewer-batch-1', child_thread_id: 'child-reviewer', scope_hash: HASH,
        payload_digest: proposal.payload_digest, tool_event_ref: 'result-tool-1', nonce: 'nonce_123',
        published_at: '2026-07-14T00:04:00.000Z',
      },
    };
    const malformed: unknown[] = [
      { ...valid, extra: true },
      { ...valid, attestation: { ...valid.attestation, nonce: 'bad nonce!' } },
      { ...valid, activity: { ...valid.activity, event_kind: 'TOOL_END' } },
      { ...valid, activity: { ...valid.activity, event_ref: 'x'.repeat(1_025) }, attestation: { ...valid.attestation, tool_event_ref: 'x'.repeat(1_025) } },
      { ...valid, published_at: 'not-a-time' },
    ];
    for (const publication of malformed) {
      assert.throws(() => validatePostToolPublication({
        review: current,
        lane: current.lanes[0]!,
        proposal,
        publication,
        consumedToolEventRefs: new Set(),
      }), /publication|attestation|nonce|event|timestamp|bounded|malformed/i);
    }
  });

  it('exempts only a retained opposite-role lane from replacement overlap', () => {
    const validateWithAttempt = (input: {
      lanes: readonly LaneRecord[];
      batched: boolean;
      resume: boolean;
      attempt: ReviewAttempt;
    }): string[] => validateLaneIndependence(input);
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
    const initialAttempt = {
      attempt: 1,
      status: 'READY_TO_SYNTHESIZE' as const,
      bindings: [
        { lane_id: reviewer.lane_id, attempt: 1, role: reviewer.role, batch_id: reviewer.batch_id, thread_id: reviewer.provenance!.thread_id },
        { lane_id: architect.lane_id, attempt: 1, role: architect.role, batch_id: architect.batch_id, thread_id: architect.provenance!.thread_id },
      ],
      lane_ids: [reviewer.lane_id, architect.lane_id],
      started_at: NOW,
      updated_at: '2026-07-14T00:06:00.000Z',
      resumable: false,
    };
    assert.deepEqual(validateWithAttempt({ lanes: [reviewer, architect], batched: false, resume: false, attempt: initialAttempt }), []);
    assert.match(validateWithAttempt({
      lanes: [{
        ...reviewer,
        provenance: {
          ...reviewer.provenance!,
          first_seen_at: '2026-07-14T00:06:00.000Z',
          completed_at: '2026-07-14T00:05:00.000Z',
        },
      }],
      batched: false,
      resume: false,
      attempt: initialAttempt,
    }).join('\n'), /LANE_PROVENANCE_INTERVAL_INVALID/u);
    assert.match(validateWithAttempt({
      lanes: [{ ...reviewer, attempt: 2 }],
      batched: false,
      resume: false,
      attempt: initialAttempt,
    }).join('\n'), /ATTEMPT_LANE_IDENTITY_MISMATCH/u);
    const nonOverlap = {
      ...architect,
      provenance: {
        ...architect.provenance!,
        first_seen_at: '2026-07-14T00:06:00.001Z',
        completed_at: '2026-07-14T00:07:00.000Z',
      },
    };
    assert.match(validateWithAttempt({ lanes: [reviewer, nonOverlap], batched: false, resume: false, attempt: initialAttempt }).join('\n'), /overlap/i);

    const replacementArchitect = lane({
      ...nonOverlap,
      lane_id: 'architect-global-resume-2',
      attempt: 2,
      provenance: {
        ...nonOverlap.provenance!,
        tracker_lane_id: 'architect-global-resume-2',
        thread_id: 'child-architect-replacement',
      },
    });
    const retainedAndReplacementAttempt = {
      ...initialAttempt,
      attempt: 2,
      bindings: [
        { lane_id: reviewer.lane_id, attempt: 1, role: reviewer.role, batch_id: reviewer.batch_id, thread_id: reviewer.provenance!.thread_id },
        { lane_id: replacementArchitect.lane_id, attempt: 2, role: replacementArchitect.role, batch_id: replacementArchitect.batch_id, thread_id: replacementArchitect.provenance!.thread_id },
      ],
      lane_ids: [reviewer.lane_id, replacementArchitect.lane_id],
    };
    assert.deepEqual(validateWithAttempt({
      lanes: [reviewer, replacementArchitect],
      batched: false,
      resume: true,
      attempt: retainedAndReplacementAttempt,
    }), []);

    const replacementReviewer = lane({
      lane_id: 'reviewer-batch-1-resume-2',
      attempt: 2,
      provenance: {
        ...reviewer.provenance!,
        tracker_lane_id: 'reviewer-batch-1-resume-2',
        thread_id: 'child-reviewer-replacement',
        first_seen_at: '2026-07-14T00:07:00.001Z',
        completed_at: '2026-07-14T00:08:00.000Z',
      },
    });
    const twoReplacementAttempt = {
      ...retainedAndReplacementAttempt,
      bindings: [
        { lane_id: replacementReviewer.lane_id, attempt: 2, role: replacementReviewer.role, batch_id: replacementReviewer.batch_id, thread_id: replacementReviewer.provenance!.thread_id },
        { lane_id: replacementArchitect.lane_id, attempt: 2, role: replacementArchitect.role, batch_id: replacementArchitect.batch_id, thread_id: replacementArchitect.provenance!.thread_id },
      ],
      lane_ids: [replacementReviewer.lane_id, replacementArchitect.lane_id],
    };
    assert.match(validateWithAttempt({
      lanes: [replacementReviewer, replacementArchitect],
      batched: false,
      resume: true,
      attempt: twoReplacementAttempt,
    }).join('\n'), /overlap|concurrent/i);

    const mismatchedBinding = {
      ...retainedAndReplacementAttempt,
      bindings: retainedAndReplacementAttempt.bindings.map((binding) => binding.lane_id === replacementArchitect.lane_id
        ? { ...binding, thread_id: 'wrong-thread' }
        : binding),
    };
    assert.match(validateWithAttempt({
      lanes: [reviewer, replacementArchitect],
      batched: false,
      resume: true,
      attempt: mismatchedBinding,
    }).join('\n'), /binding|provenance|thread/i);
    const reused = { ...architect, provenance: { ...architect.provenance!, thread_id: 'child-reviewer' } };
    assert.match(validateWithAttempt({ lanes: [reviewer, reused], batched: false, resume: false, attempt: initialAttempt }).join('\n'), /distinct|reuse/i);

    const malformedInterval = {
      ...architect,
      provenance: { ...architect.provenance!, completed_at: 'not-a-time' },
    };
    assert.match(validateWithAttempt({
      lanes: [reviewer, malformedInterval], batched: false, resume: false, attempt: initialAttempt,
    }).join('\n'), /interval/i);

    const missingBinding = { ...initialAttempt, bindings: initialAttempt.bindings.slice(0, 1) };
    assert.match(validateWithAttempt({
      lanes: [reviewer, architect], batched: false, resume: false, attempt: missingBinding,
    }).join('\n'), /binding/i);
  });
});
