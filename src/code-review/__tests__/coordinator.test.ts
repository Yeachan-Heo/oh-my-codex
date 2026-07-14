import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LaneRecord,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewRecord,
  ReviewerLaneResult,
  ScopeManifest,
} from '../contract.js';
import {
  applyLaneStart,
  createInitialReviewRecord,
  createLaneResultProposal,
  finalizeReview,
  reconcileResultPublications,
  resolveLaneTimeoutMs,
  resumeReview,
  waitForLaneRunning,
} from '../coordinator.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const REVIEWER_KEY = '22222222-2222-4222-8222-222222222222';
const ARCHITECT_KEY = '33333333-3333-4333-8333-333333333333';
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

function initial(): ReviewRecord {
  return createInitialReviewRecord({
    review_id: REVIEW_ID,
    session_id: 'session-1',
    root_thread_id: 'root-1',
    invocation_turn_id: 'turn-1',
    scope: scope(),
    batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
    required_lanes: [
      { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
      { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
    ],
    now: START,
  });
}

function startLane(record: ReviewRecord, laneId: string, threadId: string, firstSeen = START): ReviewRecord {
  return applyLaneStart({
    review: record,
    event: {
      event: 'START',
      review_id: REVIEW_ID,
      attempt: record.current_attempt,
      lane_id: laneId,
      thread_id: threadId,
      idempotency_key: laneId === 'architect-global' ? ARCHITECT_KEY : REVIEWER_KEY,
    },
    tracker: {
      session_id: 'session-1',
      thread_id: threadId,
      tracker_lane_id: laneId,
      tracker_path: `.omx/tracker/${threadId}.json`,
      first_seen_at: firstSeen.toISOString(),
    },
    now: firstSeen,
  });
}

function reviewerResult(): ReviewerLaneResult {
  return {
    role: 'code-reviewer',
    review_id: REVIEW_ID,
    attempt: 1,
    lane_id: 'reviewer-batch-1',
    batch_id: 'batch-1',
    scope_hash: HASH,
    recommendation: 'APPROVE',
    findings: [],
    diagnostics: [],
  };
}

function architectResult() {
  return {
    role: 'architect' as const,
    review_id: REVIEW_ID,
    attempt: 1,
    lane_id: 'architect-global',
    batch_id: 'global' as const,
    scope_hash: HASH,
    architectural_status: 'CLEAR' as const,
    findings: [],
  };
}

function publication(proposal: LaneResultProposal, child: string, at: string): ResultPostToolPublication {
  const eventRef = `event-${proposal.lane_id}`;
  return {
    schema_version: 1,
    publication_id: proposal.idempotency_key,
    published_at: at,
    activity: {
      schema_version: 1,
      session_id: 'session-1',
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: proposal.lane_id,
      child_thread_id: child,
      event_ref: eventRef,
      event_kind: 'RESULT_POST_TOOL',
      observed_at: at,
    },
    attestation: {
      schema_version: 1,
      session_id: 'session-1',
      root_thread_id: 'root-1',
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: proposal.lane_id,
      child_thread_id: child,
      scope_hash: HASH,
      payload_digest: proposal.payload_digest,
      tool_event_ref: eventRef,
      nonce: `nonce-${proposal.lane_id}`,
      published_at: at,
    },
  };
}

describe('review coordinator lifecycle', () => {
  it('creates every planned lane with a ten-minute default and bounded configuration', () => {
    const record = initial();
    assert.equal(record.status, 'REVIEWING');
    assert.equal(record.lanes.length, 2);
    assert.equal(record.lanes.every((lane) => lane.status === 'PENDING'), true);
    assert.equal(record.effective_config.lane_timeout_ms, 600_000);
    assert.equal(resolveLaneTimeoutMs({}), 600_000);
    assert.equal(resolveLaneTimeoutMs({ OMX_CODE_REVIEW_LANE_TIMEOUT_MS: '30000' }), 30_000);
    assert.equal(resolveLaneTimeoutMs({ OMX_CODE_REVIEW_LANE_TIMEOUT_MS: '3600000' }), 3_600_000);
  });

  it('binds START atomically from first_seen_at and is idempotent only for the same thread', () => {
    const running = startLane(initial(), 'reviewer-batch-1', 'child-reviewer');
    const lane = running.lanes.find((item) => item.lane_id === 'reviewer-batch-1')!;
    assert.equal(lane.status, 'RUNNING');
    assert.equal(lane.idle_deadline_at, '2026-07-14T00:10:00.000Z');
    assert.equal(lane.provenance?.first_seen_at, START.toISOString());
    const repeated = startLane(running, 'reviewer-batch-1', 'child-reviewer');
    assert.deepEqual(repeated, running);
    assert.throws(() => startLane(running, 'reviewer-batch-1', 'other-child'), /bound|thread|evidence/i);
  });

  it('condition-waits for readiness without fixed sleeps or a held mutation callback', async () => {
    let record = initial();
    let waits = 0;
    const running = await waitForLaneRunning({
      load: () => record,
      lane_id: 'reviewer-batch-1',
      now: () => START,
      waitForChange: () => {
        waits += 1;
        record = startLane(record, 'reviewer-batch-1', 'child-reviewer');
      },
    });
    assert.equal(running.status, 'RUNNING');
    assert.equal(waits, 1);
  });

  it('treats RESULT as an immutable proposal and allows CLI only to recover the same proposal key', () => {
    const running = startLane(initial(), 'reviewer-batch-1', 'child-reviewer');
    const event = {
      event: 'RESULT' as const,
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: 'reviewer-batch-1',
      scope_hash: HASH,
      result: reviewerResult(),
      idempotency_key: REVIEWER_KEY,
    };
    const proposal = createLaneResultProposal({ review: running, event, source: 'MCP', now: START });
    assert.equal(proposal.state, 'PENDING_HOST_ATTESTATION');
    assert.equal(running.lanes[0]!.status, 'RUNNING');
    assert.throws(() => createLaneResultProposal({ review: running, event, source: 'CLI', now: START }), /CLI|fresh|proposal/i);
    assert.deepEqual(createLaneResultProposal({ review: running, event, source: 'CLI', now: START, existingProposal: proposal }), proposal);
    assert.throws(() => createLaneResultProposal({ review: running, event: { ...event, scope_hash: 'b'.repeat(64) }, source: 'CLI', now: START, existingProposal: proposal }), /conflict|scope|identity/i);
  });

  it('reconciles only matching atomic PostToolUse publications from the bound children', () => {
    let record = startLane(initial(), 'reviewer-batch-1', 'child-reviewer');
    record = startLane(record, 'architect-global', 'child-architect');
    const reviewerProposal = createLaneResultProposal({
      review: record,
      event: { event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', scope_hash: HASH, result: reviewerResult(), idempotency_key: REVIEWER_KEY },
      source: 'MCP',
      now: START,
    });
    const architectProposal = createLaneResultProposal({
      review: record,
      event: { event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', scope_hash: HASH, result: architectResult(), idempotency_key: ARCHITECT_KEY },
      source: 'MCP',
      now: START,
    });
    const reconciled = reconcileResultPublications({
      review: record,
      proposals: [reviewerProposal, architectProposal],
      snapshot: {
        cutoff_at: '2026-07-14T00:05:00.000Z',
        events: [],
        publications: [
          publication(reviewerProposal, 'child-reviewer', '2026-07-14T00:04:00.000Z'),
          publication(architectProposal, 'child-architect', '2026-07-14T00:04:01.000Z'),
        ],
      },
      consumedToolEventRefs: new Set(),
      now: new Date('2026-07-14T00:05:00.000Z'),
    });
    assert.equal(reconciled.lanes.every((lane) => lane.status === 'COMPLETE'), true);
    assert.equal(reconciled.status, 'READY_TO_SYNTHESIZE');
    assert.ok(reconciled.revision > record.revision);
  });

  it('finalizes only after all planned lanes complete and scope is unchanged', () => {
    const record = initial();
    const complete = {
      ...record,
      status: 'READY_TO_SYNTHESIZE' as const,
      lanes: record.lanes.map((lane): LaneRecord => lane.role === 'architect'
        ? {
            ...lane,
            status: 'COMPLETE',
            architectural_status: 'CLEAR',
            provenance: {
              session_id: 'session-1', thread_id: 'child-architect', tracker_lane_id: 'architect-global',
              tracker_path: 'tracker-architect', first_seen_at: START.toISOString(), completed_at: '2026-07-14T00:01:00.000Z',
            },
          }
        : {
            ...lane,
            status: 'COMPLETE',
            recommendation: 'APPROVE',
            provenance: {
              session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1',
              tracker_path: 'tracker-reviewer', first_seen_at: START.toISOString(), completed_at: '2026-07-14T00:01:00.000Z',
            },
          }),
    };
    const finalized = finalizeReview({ review: complete, current_scope_hash: HASH, now: START });
    assert.equal(finalized.status, 'FINALIZED');
    assert.equal(finalized.verdict?.recommendation, 'APPROVE');
    assert.equal(finalized.verdict?.clean, true);
    assert.deepEqual(finalizeReview({ review: finalized, current_scope_hash: HASH, now: START }), finalized);
  });

  it('resumes append-only by replacing only failed, timed-out, invalid, or missing lanes', () => {
    const record = initial();
    const blocked: ReviewRecord = {
      ...record,
      status: 'BLOCKED',
      resumable: true,
      resumable_reason: 'LANE_EVIDENCE_INVALID',
      lanes: [
        { ...record.lanes[0]!, status: 'COMPLETE', recommendation: 'APPROVE' },
        { ...record.lanes[1]!, status: 'INVALID', failure_code: 'LANE_EVIDENCE_INVALID' },
      ],
      attempt_history: [{ ...record.attempt_history[0]!, status: 'BLOCKED', resumable: true, resumable_reason: 'LANE_EVIDENCE_INVALID' }],
    };
    const resumed = resumeReview({ review: blocked, current_scope_hash: HASH, now: new Date('2026-07-14T00:20:00.000Z') });
    assert.equal(resumed.current_attempt, 2);
    assert.equal(resumed.attempt_history.length, 2);
    assert.equal(resumed.lanes.find((lane) => lane.lane_id === 'reviewer-batch-1')?.attempt, 1);
    assert.equal(resumed.lanes.find((lane) => lane.lane_id === 'architect-global')?.attempt, 2);
    assert.equal(resumed.lanes.find((lane) => lane.lane_id === 'architect-global')?.status, 'PENDING');
  });
});
