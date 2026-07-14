import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LaneActivityEvent,
  LaneRecord,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewRecord,
  ScopeManifest,
} from '../contract.js';
import {
  applyLaneStart,
  createInitialReviewRecord,
  createLaneResultProposal,
  finalizeReview,
  foldActivitySnapshot,
  reconcileResultPublications,
  resolveLaneTimeoutMs,
  resumeReview,
  waitForLaneRunning,
} from '../coordinator.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const RESULT_KEY = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const START = new Date('2026-07-14T00:00:00.000Z');

function scope(): ScopeManifest {
  return {
    selector: { explicit_paths: [] },
    status: 'FULL_SCOPE',
    scope_hash: HASH,
    files: [{ path: 'README.md', change: 'MODIFIED', sources: ['WORKTREE'], binary: false, additions: 1, deletions: 0 }],
    changed_lines: 1,
    reasons: [],
  };
}

function running(timeoutMs = 60_000): ReviewRecord {
  const record = createInitialReviewRecord({
    review_id: REVIEW_ID,
    session_id: 'session-1',
    root_thread_id: 'root-1',
    scope: scope(),
    lane_timeout_ms: timeoutMs,
    batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
    required_lanes: [{ lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' }],
    now: START,
  });
  return applyLaneStart({
    review: record,
    event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-reviewer', idempotency_key: RESULT_KEY },
    tracker: {
      session_id: 'session-1',
      thread_id: 'child-reviewer',
      tracker_lane_id: 'reviewer-batch-1',
      tracker_path: 'tracker',
      first_seen_at: START.toISOString(),
      last_seen_at: '2099-01-01T00:00:00.000Z',
    },
    now: START,
  });
}

function activity(eventRef: string, observedAt: string, overrides: Partial<LaneActivityEvent> = {}): LaneActivityEvent {
  return {
    schema_version: 1,
    session_id: 'session-1',
    review_id: REVIEW_ID,
    attempt: 1,
    lane_id: 'reviewer-batch-1',
    child_thread_id: 'child-reviewer',
    event_ref: eventRef,
    event_kind: 'AGENT_PROGRESS',
    observed_at: observedAt,
    ...overrides,
  };
}

function resultProposal(record: ReviewRecord): LaneResultProposal {
  return createLaneResultProposal({
    review: record,
    event: {
      event: 'RESULT',
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: 'reviewer-batch-1',
      scope_hash: HASH,
      result: {
        role: 'code-reviewer',
        review_id: REVIEW_ID,
        attempt: 1,
        lane_id: 'reviewer-batch-1',
        batch_id: 'batch-1',
        scope_hash: HASH,
        recommendation: 'APPROVE',
        findings: [],
        diagnostics: [],
      },
      idempotency_key: RESULT_KEY,
    },
    source: 'MCP',
    now: START,
  });
}

function publication(proposal: LaneResultProposal, at: string): ResultPostToolPublication {
  return {
    schema_version: 1,
    publication_id: proposal.idempotency_key,
    published_at: at,
    activity: {
      ...activity('result-event', at),
      event_kind: 'RESULT_POST_TOOL',
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
      tool_event_ref: 'result-event',
      nonce: 'nonce',
      published_at: at,
    },
  };
}

describe('review coordinator failure and concurrency invariants', () => {
  it('rejects invalid timeout configuration instead of falling back', () => {
    for (const value of ['29999', '3600001', '0', '-1', '1.5', 'garbage']) {
      assert.throws(() => resolveLaneTimeoutMs({ OMX_CODE_REVIEW_LANE_TIMEOUT_MS: value }), /configuration|timeout/i);
    }
  });

  it('folds continuous activity chronologically even when files arrive out of order', () => {
    const record = running();
    const folded = foldActivitySnapshot({
      review: record,
      snapshot: {
        cutoff_at: '2026-07-14T00:02:30.000Z',
        events: [
          activity('event-2', '2026-07-14T00:01:30.000Z'),
          activity('event-1', '2026-07-14T00:00:30.000Z'),
        ],
        publications: [],
      },
    });
    const lane = folded.lanes[0]!;
    assert.equal(lane.status, 'RUNNING');
    assert.equal(lane.last_processed_activity_ref, 'event-2');
    assert.equal(lane.last_processed_activity_at, '2026-07-14T00:01:30.000Z');
    assert.equal(lane.idle_deadline_at, '2026-07-14T00:02:30.000Z');
    assert.notEqual(lane.idle_deadline_at, lane.provenance?.last_seen_at);
  });

  it('rejects duplicate, stale, future, wrong-child, wrong-session, and wrong-attempt events', () => {
    const invalidEvents = [
      [activity('same', '2026-07-14T00:00:30.000Z'), activity('same', '2026-07-14T00:00:30.000Z')],
      [activity('future', '2026-07-14T00:02:00.000Z')],
      [activity('wrong-child', '2026-07-14T00:00:30.000Z', { child_thread_id: 'other' })],
      [activity('wrong-session', '2026-07-14T00:00:30.000Z', { session_id: 'other' })],
      [activity('wrong-attempt', '2026-07-14T00:00:30.000Z', { attempt: 2 })],
      [activity('stale', '2026-07-13T23:59:59.999Z')],
    ];
    for (const events of invalidEvents) {
      const folded = foldActivitySnapshot({ review: running(), snapshot: { cutoff_at: '2026-07-14T00:01:00.000Z', events, publications: [] } });
      assert.equal(folded.lanes[0]!.status, 'INVALID');
      assert.equal(folded.lanes[0]!.failure_code, 'LANE_EVIDENCE_INVALID');
    }
  });

  it('times out at the prior deadline and the first later event cannot revive it', () => {
    const folded = foldActivitySnapshot({
      review: running(),
      snapshot: {
        cutoff_at: '2026-07-14T00:01:01.000Z',
        events: [activity('late', '2026-07-14T00:01:00.001Z')],
        publications: [],
      },
    });
    assert.equal(folded.lanes[0]!.status, 'TIMED_OUT');
    assert.equal(folded.lanes[0]!.idle_deadline_at, '2026-07-14T00:01:00.000Z');
    const noEvents = foldActivitySnapshot({ review: running(), snapshot: { cutoff_at: '2026-07-14T00:01:00.001Z', events: [], publications: [] } });
    assert.equal(noEvents.lanes[0]!.status, 'TIMED_OUT');
  });

  it('linearizes the snapshot cutoff and admits only a fully combined publication', () => {
    const record = running();
    const proposal = resultProposal(record);
    const before = publication(proposal, '2026-07-14T00:00:59.999Z');
    const accepted = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:01:00.000Z', events: [], publications: [before] },
      consumedToolEventRefs: new Set(),
      now: new Date('2026-07-14T00:02:00.000Z'),
    });
    assert.equal(accepted.lanes[0]!.status, 'COMPLETE', 'PREPARED before deadline must survive later recovery');

    const after = publication(proposal, '2026-07-14T00:01:00.001Z');
    const rejected = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:01:00.001Z', events: [], publications: [after] },
      consumedToolEventRefs: new Set(),
      now: new Date('2026-07-14T00:01:00.001Z'),
    });
    assert.equal(rejected.lanes[0]!.status, 'TIMED_OUT');
    assert.throws(() => reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:00:59.999Z', events: [], publications: [{ ...before, attestation: undefined } as unknown as ResultPostToolPublication] },
      consumedToolEventRefs: new Set(),
      now: START,
    }), /atomic|attestation|publication/i);
  });

  it('never lets a late RESULT or aggregate tracker last_seen revive a timed-out lane', () => {
    const timedOut = foldActivitySnapshot({ review: running(), snapshot: { cutoff_at: '2026-07-14T00:01:01.000Z', events: [], publications: [] } });
    assert.equal(timedOut.lanes[0]!.status, 'TIMED_OUT');
    assert.throws(() => resultProposal(timedOut), /terminal|timeout|running/i);
    const reconciled = reconcileResultPublications({
      review: timedOut,
      proposals: [],
      snapshot: { cutoff_at: '2099-01-01T00:00:00.000Z', events: [], publications: [] },
      consumedToolEventRefs: new Set(),
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    assert.equal(reconciled.lanes[0]!.status, 'TIMED_OUT');
  });

  it('rejects stale and late readiness deterministically without sleeping', async () => {
    let now = START.getTime();
    await assert.rejects(waitForLaneRunning({
      load: () => running(),
      lane_id: 'missing-lane',
      now: () => new Date(now),
      waitForChange: () => { now += 30_001; },
      maximum_wait_ms: 30_000,
    }), /readiness|lane|timeout/i);
  });

  it('blocks resume and finalization on scope drift and old-attempt late results', () => {
    const record = running();
    const blocked: ReviewRecord = {
      ...record,
      status: 'BLOCKED',
      resumable: true,
      resumable_reason: 'LANE_TIMED_OUT',
      lanes: [{ ...record.lanes[0]!, status: 'TIMED_OUT', failure_code: 'LANE_TIMED_OUT' }],
      attempt_history: [{ ...record.attempt_history[0]!, status: 'BLOCKED', resumable: true, resumable_reason: 'LANE_TIMED_OUT' }],
    };
    assert.throws(() => resumeReview({ review: blocked, current_scope_hash: 'b'.repeat(64), now: START }), /SCOPE_DRIFT|scope/i);
    assert.throws(() => finalizeReview({ review: record, current_scope_hash: 'b'.repeat(64), now: START }), /SCOPE_DRIFT|scope/i);
    const resumed = resumeReview({ review: blocked, current_scope_hash: HASH, now: START });
    assert.throws(() => createLaneResultProposal({
      review: resumed,
      event: {
        event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', scope_hash: HASH,
        result: resultProposal(record).result, idempotency_key: RESULT_KEY,
      },
      source: 'MCP', now: START,
    }), /attempt|late|terminal/i);
  });

  it('preserves both distinct child proposals and rejects a forged fresh CLI race', () => {
    const record = running();
    const first = resultProposal(record);
    const secondLane: LaneRecord = {
      ...record.lanes[0]!,
      lane_id: 'reviewer-batch-2',
      batch_id: 'batch-2',
      provenance: { ...record.lanes[0]!.provenance!, thread_id: 'child-reviewer-2', tracker_lane_id: 'reviewer-batch-2' },
    };
    const twoLane: ReviewRecord = {
      ...record,
      lanes: [record.lanes[0]!, secondLane],
      batches: [...record.batches, { batch_id: 'batch-2', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
      attempt_history: [{ ...record.attempt_history[0]!, lane_ids: ['reviewer-batch-1', 'reviewer-batch-2'], bindings: [
        ...record.attempt_history[0]!.bindings,
        { lane_id: 'reviewer-batch-2', attempt: 1, role: 'code-reviewer', batch_id: 'batch-2', thread_id: 'child-reviewer-2' },
      ] }],
    };
    const secondKey = '33333333-3333-4333-8333-333333333333';
    const second = createLaneResultProposal({
      review: twoLane,
      event: { event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-2', scope_hash: HASH, result: { ...(first.result as import('../contract.js').ReviewerLaneResult), lane_id: 'reviewer-batch-2', batch_id: 'batch-2' }, idempotency_key: secondKey },
      source: 'MCP', now: START,
    });
    assert.notEqual(first.idempotency_key, second.idempotency_key);
    assert.notEqual(first.payload_digest, second.payload_digest);
    assert.throws(() => createLaneResultProposal({
      review: twoLane,
      event: { event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-2', scope_hash: HASH, result: second.result, idempotency_key: '44444444-4444-4444-8444-444444444444' },
      source: 'CLI', now: START,
    }), /CLI|fresh|proposal/i);
  });
});
