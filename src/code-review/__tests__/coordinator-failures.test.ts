import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { BatchPlan } from '../batching.js';
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
  type DurableReviewCoordinatorHostDependencies,
} from '../coordinator.js';
import * as coordinatorModule from '../coordinator.js';
import { canonicalLanePayloadDigest } from '../evidence.js';
import {
  atomicCreatePrivateJson,
  readReviewConsumptionMarkers,
  resolveReviewLockPaths,
  resolveReviewPersistencePaths,
  type DurableTransactionBoundary,
} from '../persistence.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const RESULT_KEY = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const START = new Date('2026-07-14T00:00:00.000Z');
const START_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVIEWER_START_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ARCHITECT_START_KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface DurableCoordinatorForTest {
  start(input: { record: ReviewRecord; idempotency_key: string; crashAt?: DurableTransactionBoundary }): Promise<ReviewRecord>;
  get(reviewId: string): Promise<ReviewRecord>;
  recordStart(input: {
    event: Extract<import('../contract.js').ReviewRecordLaneEvent, { event: 'START' }>;
    tracker: unknown;
    now: Date;
  }): Promise<ReviewRecord>;
  recordResult(input: {
    event: Extract<import('../contract.js').ReviewRecordLaneEvent, { event: 'RESULT' }>;
    source: 'MCP' | 'CLI';
    now: Date;
  }): Promise<LaneResultProposal>;
  reconcile(input: {
    review_id: string;
    crashAt?: DurableTransactionBoundary;
  }): Promise<ReviewRecord>;
}

function durableFactory(): ((
  context: { workingDirectory: string; session_id: string },
  host?: DurableReviewCoordinatorHostDependencies,
) => DurableCoordinatorForTest) {
  const exports = Object.fromEntries(Object.entries(coordinatorModule)) as Record<string, unknown>;
  assert.equal(typeof exports.createDurableReviewCoordinator, 'function');
  return exports.createDurableReviewCoordinator as (
    context: { workingDirectory: string; session_id: string },
    host?: DurableReviewCoordinatorHostDependencies,
  ) => DurableCoordinatorForTest;
}

function trustedJournal() {
  let cutoffAt = START.toISOString();
  let value: unknown = { events: [], diagnostic_events: [], publication_ids: [] };
  const calls: Array<{ session_id: string; root_thread_id: string; review_id: string; cutoff_at: string }> = [];
  const host: DurableReviewCoordinatorHostDependencies = {
    root_thread_id: 'root-1',
    now: () => new Date(cutoffAt),
    loadHookJournalSnapshot: async (input) => {
      calls.push(structuredClone(input));
      return structuredClone(value);
    },
  };
  return {
    host,
    calls,
    observe(snapshot: import('../coordinator.js').ActivitySnapshot): void {
      cutoffAt = snapshot.cutoff_at;
      value = {
        events: structuredClone(snapshot.events),
        diagnostic_events: structuredClone(snapshot.diagnostic_events ?? []),
        publication_ids: snapshot.publications.flatMap((publication) => (
          publication !== null && typeof publication === 'object' && !Array.isArray(publication)
            && typeof (publication as { publication_id?: unknown }).publication_id === 'string'
            ? [(publication as { publication_id: string }).publication_id]
            : []
        )),
      };
    },
    setRaw(next: unknown, cutoff = cutoffAt): void {
      cutoffAt = cutoff;
      value = next;
    },
  };
}

async function withTemporaryReviewRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-review-coordinator-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

function initialReview(timeoutMs = 60_000): ReviewRecord {
  const plan: BatchPlan = {
    review_flags: [],
    batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
    required_lanes: [
      { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
      { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
    ],
  };
  return createInitialReviewRecord({
    review_id: REVIEW_ID,
    session_id: 'session-1',
    root_thread_id: 'root-1',
    scope: scope(),
    lane_timeout_ms: timeoutMs,
    batch_plan: plan,
    now: START,
  });
}

function running(timeoutMs = 60_000): ReviewRecord {
  const record = initialReview(timeoutMs);
  return applyLaneStart({
    review: record,
    event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-reviewer', idempotency_key: RESULT_KEY },
    tracker: {
      schema_version: 1,
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
  const eventRef = `result-event-${proposal.lane_id}`;
  return {
    schema_version: 1,
    publication_id: proposal.idempotency_key,
    published_at: at,
    activity: {
      ...activity(eventRef, at),
      lane_id: proposal.lane_id,
      event_kind: 'RESULT_POST_TOOL',
    },
    attestation: {
      schema_version: 1,
      session_id: 'session-1',
      root_thread_id: 'root-1',
      review_id: REVIEW_ID,
      attempt: 1,
      lane_id: proposal.lane_id,
      child_thread_id: 'child-reviewer',
      scope_hash: HASH,
      payload_digest: proposal.payload_digest,
      tool_event_ref: eventRef,
      nonce: `nonce_${proposal.lane_id}`,
      published_at: at,
    },
  };
}

describe('review coordinator failure and concurrency invariants', () => {
  it('returns the immutable START receipt across replay, conflict, and transport death', async () => {
    const plan: BatchPlan = {
      review_flags: [],
      batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
      required_lanes: [
        { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
        { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
      ],
    };
    const record = createInitialReviewRecord({
      review_id: REVIEW_ID,
      session_id: 'session-1',
      root_thread_id: 'root-1',
      scope: scope(),
      batch_plan: plan,
      now: START,
    });
    const startReviewer = (durable: DurableCoordinatorForTest): Promise<ReviewRecord> => (
      durable.recordStart({
        event: {
          event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1',
          thread_id: 'child-reviewer', idempotency_key: REVIEWER_START_KEY,
        },
        tracker: {
          schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer',
          tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker-reviewer',
          first_seen_at: START.toISOString(),
        },
        now: START,
      })
    );

    await withTemporaryReviewRoot(async (root) => {
      const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' });
      const first = await durable.start({ record, idempotency_key: START_KEY });
      assert.equal(first.revision, 1);
      assert.equal((await startReviewer(durable)).revision, 2);
      assert.deepEqual(await durable.start({ record, idempotency_key: START_KEY }), first);

      const conflicting = createInitialReviewRecord({
        review_id: REVIEW_ID,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        scope: { ...scope(), scope_hash: 'b'.repeat(64) },
        batch_plan: plan,
        now: START,
      });
      await assert.rejects(
        durable.start({ record: conflicting, idempotency_key: START_KEY }),
        (error: unknown) => (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT',
      );
    });

    await withTemporaryReviewRoot(async (root) => {
      const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' });
      await assert.rejects(
        durable.start({ record, idempotency_key: START_KEY, crashAt: 'after:locator-cleanup' }),
        /injected crash/i,
      );
      const recoveredReceipt = await durable.start({ record, idempotency_key: START_KEY });
      assert.equal(recoveredReceipt.revision, 1);
      assert.equal((await startReviewer(durable)).revision, 2);
      assert.deepEqual(await durable.start({ record, idempotency_key: START_KEY }), recoveredReceipt);
    });
  });

  it('publishes a terminal no-changes review without reserving the active pointer', async () => {
    await withTemporaryReviewRoot(async (root) => {
      const emptyPlan: BatchPlan = { review_flags: [], batches: [], required_lanes: [] };
      const emptyScope: ScopeManifest = {
        ...scope(),
        selector: { explicit_paths: ['missing.ts'] },
        files: [],
        changed_lines: 0,
      };
      const record = createInitialReviewRecord({
        review_id: REVIEW_ID,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        scope: emptyScope,
        batch_plan: emptyPlan,
        now: START,
      });
      const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' });
      const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
      const finalized = await durable.start({ record, idempotency_key: START_KEY });

      assert.deepEqual(finalized, record);
      assert.equal(finalized.status, 'FINALIZED');
      await assert.rejects(readFile(paths.activePath, 'utf8'), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ));
      const artifact = JSON.parse(await readFile(join(paths.reviewsRoot, `${REVIEW_ID}.json`), 'utf8')) as {
        verdict?: { rule_id?: string };
      };
      assert.equal(artifact.verdict?.rule_id, 'NO_CHANGES');
      assert.match(await readFile(join(paths.reviewsRoot, `${REVIEW_ID}.md`), 'utf8'), /NO_CHANGES|No changes/i);

      const nextReviewId = '44444444-4444-4444-8444-444444444444';
      const plan: BatchPlan = {
        review_flags: [],
        batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
        required_lanes: [
          { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
          { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
        ],
      };
      const next = createInitialReviewRecord({
        review_id: nextReviewId,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        scope: scope(),
        batch_plan: plan,
        now: START,
      });
      await durable.start({ record: next, idempotency_key: '55555555-5555-4555-8555-555555555555' });
      assert.deepEqual(JSON.parse(await readFile(paths.activePath, 'utf8')), {
        schema_version: 1,
        review_id: nextReviewId,
        status: 'REVIEWING',
      });
      assert.deepEqual(await durable.start({ record, idempotency_key: START_KEY }), finalized);
    });
  });

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
    const first = foldActivitySnapshot({
      review: running(),
      snapshot: { cutoff_at: '2026-07-14T00:00:30.000Z', events: [activity('reused', '2026-07-14T00:00:30.000Z')], publications: [] },
    });
    const reused = foldActivitySnapshot({
      review: first,
      snapshot: { cutoff_at: '2026-07-14T00:00:40.000Z', events: [activity('reused', '2026-07-14T00:00:40.000Z')], publications: [] },
    });
    assert.equal(reused.lanes[0]!.status, 'INVALID');
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

  it('rejects caller-supplied consumption state', () => {
    const untrustedInput = {
      review: running(),
      proposals: [],
      snapshot: { cutoff_at: '2026-07-14T00:00:30.000Z', events: [], publications: [] },
      consumedToolEventRefs: new Set<string>(),
      now: new Date('2026-07-14T00:00:30.000Z'),
    };
    assert.throws(() => reconcileResultPublications(untrustedInput), /durable|marker|caller|consumption/i);
  });

  it('strictly rejects caller evidence and loads one frozen hook snapshot while locks are held', async () => {
    await withTemporaryReviewRoot(async (root) => {
      const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
      const lockPaths = resolveReviewLockPaths(paths, REVIEW_ID);
      let clockCalls = 0;
      let loaderCalls = 0;
      let locksObserved = false;
      let loadedValue: unknown = {
        events: [activity('trusted-progress', '2026-07-14T00:00:50.000Z')],
        diagnostic_events: [],
        publication_ids: [],
      };
      const host: DurableReviewCoordinatorHostDependencies = {
        root_thread_id: 'root-1',
        now: () => {
          clockCalls += 1;
          return new Date('2026-07-14T00:01:20.000Z');
        },
        loadHookJournalSnapshot: async (identity) => {
          loaderCalls += 1;
          await Promise.all([
            readFile(lockPaths.journalLockPath, 'utf8'),
            readFile(lockPaths.mutationLockPath, 'utf8'),
          ]);
          locksObserved = true;
          assert.deepEqual(identity, {
            session_id: 'session-1',
            root_thread_id: 'root-1',
            review_id: REVIEW_ID,
            cutoff_at: '2026-07-14T00:01:20.000Z',
          });
          return structuredClone(loadedValue);
        },
      };
      const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, host);
      await durable.start({ record: initialReview(), idempotency_key: START_KEY });
      await durable.recordStart({
        event: {
          event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1',
          thread_id: 'child-reviewer', idempotency_key: REVIEWER_START_KEY,
        },
        tracker: {
          schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer',
          tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker-reviewer',
          first_seen_at: START.toISOString(),
        },
        now: START,
      });

      const forgedRequest = {
        review_id: REVIEW_ID,
        cutoff_at: '2099-01-01T00:00:00.000Z',
        events: [activity('forged', '2026-07-14T00:00:59.000Z')],
        diagnostic_events: [],
        snapshot: { events: [], diagnostic_events: [], publication_ids: [] },
      };
      await assert.rejects(durable.reconcile(forgedRequest), /accepts only|caller|evidence|fields/i);
      assert.equal(loaderCalls, 0);
      assert.equal(clockCalls, 0);

      const reconciled = await durable.reconcile({ review_id: REVIEW_ID });
      assert.equal(loaderCalls, 1);
      assert.equal(clockCalls, 1);
      assert.equal(locksObserved, true);
      assert.equal(reconciled.lanes[0]!.last_processed_activity_ref, 'trusted-progress');
      assert.equal(reconciled.lanes[0]!.idle_deadline_at, '2026-07-14T00:01:50.000Z');

      loadedValue = { events: [], publication_ids: [] };
      await assert.rejects(durable.reconcile({ review_id: REVIEW_ID }), /missing|malformed|journal|evidence/i);
      loadedValue = {
        events: [activity('wrong-session', '2026-07-14T00:00:55.000Z', { session_id: 'forged-session' })],
        diagnostic_events: [],
        publication_ids: [],
      };
      await assert.rejects(durable.reconcile({ review_id: REVIEW_ID }), /identity|journal|evidence/i);
      const withoutHost = durableFactory()({ workingDirectory: root, session_id: 'session-1' });
      await assert.rejects(withoutHost.reconcile({ review_id: REVIEW_ID }), /loader|trusted|unavailable/i);
    });
  });

  it('linearizes the snapshot cutoff and admits only a fully combined publication', () => {
    const record = running();
    const proposal = resultProposal(record);
    const before = publication(proposal, '2026-07-14T00:00:59.999Z');
    const accepted = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:01:00.000Z', events: [], publications: [before] },
      now: new Date('2026-07-14T00:02:00.000Z'),
    });
    assert.equal(accepted.lanes[0]!.status, 'COMPLETE', 'PREPARED before deadline must survive later recovery');

    const after = publication(proposal, '2026-07-14T00:01:00.001Z');
    const rejected = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:01:00.001Z', events: [], publications: [after] },
      now: new Date('2026-07-14T00:01:00.001Z'),
    });
    assert.equal(rejected.lanes[0]!.status, 'TIMED_OUT');
    assert.throws(() => reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:00:59.999Z', events: [], publications: [{ ...before, attestation: undefined } as unknown as ResultPostToolPublication] },
      now: START,
    }), /atomic|attestation|publication/i);
  });

  it('folds earlier activity before validating a RESULT regardless of input order', () => {
    const record = running();
    const proposal = resultProposal(record);
    const result = publication(proposal, '2026-07-14T00:01:20.000Z');
    const reconciled = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: {
        cutoff_at: '2026-07-14T00:01:40.000Z',
        events: [
          activity('after-result', '2026-07-14T00:01:30.000Z'),
          activity('before-result', '2026-07-14T00:00:50.000Z'),
        ],
        publications: [result],
      },
      now: new Date('2026-07-14T00:01:40.000Z'),
    });

    assert.equal(reconciled.lanes[0]!.status, 'COMPLETE');
    assert.equal(reconciled.lanes[0]!.idle_deadline_at, '2026-07-14T00:01:50.000Z');
    assert.equal(reconciled.lanes[0]!.last_processed_activity_ref, result.activity.event_ref);
  });

  it('does not let activity observed after RESULT rescue a publication past the prior deadline', () => {
    const record = running();
    const proposal = resultProposal(record);
    const reconciled = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: {
        cutoff_at: '2026-07-14T00:01:30.000Z',
        events: [activity('after-result', '2026-07-14T00:01:30.000Z')],
        publications: [publication(proposal, '2026-07-14T00:01:20.000Z')],
      },
      now: new Date('2026-07-14T00:01:30.000Z'),
    });

    assert.equal(reconciled.lanes[0]!.status, 'TIMED_OUT');
    assert.equal(reconciled.lanes[0]!.idle_deadline_at, '2026-07-14T00:01:00.000Z');
  });

  it('times out when the first activity precedes RESULT but follows the current deadline', () => {
    const record = running();
    const proposal = resultProposal(record);
    const reconciled = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: {
        cutoff_at: '2026-07-14T00:01:20.000Z',
        events: [activity('first-too-late', '2026-07-14T00:01:00.001Z')],
        publications: [publication(proposal, '2026-07-14T00:01:20.000Z')],
      },
      now: new Date('2026-07-14T00:01:20.000Z'),
    });

    assert.equal(reconciled.lanes[0]!.status, 'TIMED_OUT');
    assert.equal(reconciled.lanes[0]!.failure_code, 'LANE_TIMED_OUT');
  });

  it('keeps unmatched publications and attestations completely inert', () => {
    const record = running();
    const proposal = resultProposal(record);
    const unmatched = {
      ...publication(proposal, '2026-07-14T00:00:59.000Z'),
      publication_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };
    const reconciled = reconcileResultPublications({
      review: record,
      proposals: [proposal],
      snapshot: { cutoff_at: '2026-07-14T00:00:59.500Z', events: [], publications: [unmatched] },
      now: new Date('2026-07-14T00:00:59.500Z'),
    });
    assert.deepEqual(reconciled, record);
  });

  it('never lets a late RESULT or aggregate tracker last_seen revive a timed-out lane', () => {
    const timedOut = foldActivitySnapshot({ review: running(), snapshot: { cutoff_at: '2026-07-14T00:01:01.000Z', events: [], publications: [] } });
    assert.equal(timedOut.lanes[0]!.status, 'TIMED_OUT');
    assert.throws(() => resultProposal(timedOut), /terminal|timeout|running/i);
    const reconciled = reconcileResultPublications({
      review: timedOut,
      proposals: [],
      snapshot: { cutoff_at: '2099-01-01T00:00:00.000Z', events: [], publications: [] },
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

  it('bounds readiness by the lane deadline and fails closed for terminal or old-attempt lanes', async () => {
    const pending = initialReview(60_000);
    pending.lanes[0]!.idle_deadline_at = new Date(START.getTime() + 1_000).toISOString();
    let now = START.getTime();
    let monotonicNow = 0;
    let observedDeadline = '';
    await assert.rejects(waitForLaneRunning({
      load: () => pending,
      lane_id: 'reviewer-batch-1',
      now: () => new Date(now),
      // ASSERTION-CHANGE-JUSTIFIED: readiness expiry is monotonic, so the seam
      // must advance elapsed time rather than relying on a wall-clock jump.
      monotonicNow: () => monotonicNow,
      waitForChange: (deadlineAt) => {
        observedDeadline = deadlineAt;
        now += 1_000;
        monotonicNow += 1_000;
      },
      maximum_wait_ms: 30_000,
    }), (error: unknown) => (error as { code?: string }).code === 'LANE_TIMED_OUT');
    assert.equal(observedDeadline, pending.lanes[0]!.idle_deadline_at);

    const terminal = structuredClone(pending);
    terminal.lanes[0]!.status = 'FAILED';
    await assert.rejects(waitForLaneRunning({
      load: () => terminal,
      lane_id: 'reviewer-batch-1',
      now: () => START,
      waitForChange: () => assert.fail('terminal readiness must not wait'),
    }), (error: unknown) => (error as { code?: string }).code === 'LANE_EVIDENCE_INVALID');

    const nextAttempt = structuredClone(pending);
    nextAttempt.current_attempt = 2;
    await assert.rejects(waitForLaneRunning({
      load: () => nextAttempt,
      lane_id: 'reviewer-batch-1',
      now: () => START,
      waitForChange: () => assert.fail('old-attempt readiness must not wait'),
    }), (error: unknown) => (error as { code?: string }).code === 'LANE_EVIDENCE_INVALID');
  });

  it('expires the readiness budget by monotonic elapsed time across wall-clock rollback and jumps', async () => {
    for (const wallDelta of [-60_000, 5_000]) {
      const pending = initialReview(60_000);
      let wallNow = START.getTime();
      let monotonicNow = 1_000;
      let waits = 0;
      const request: Parameters<typeof waitForLaneRunning>[0] = {
        load: () => pending,
        lane_id: 'reviewer-batch-1',
        now: () => new Date(wallNow),
        monotonicNow: () => monotonicNow,
        waitForChange: () => {
          waits += 1;
          if (waits > 3) throw new Error('monotonic readiness budget was exceeded');
          wallNow += wallDelta;
          monotonicNow += 10_000;
        },
        maximum_wait_ms: 30_000,
      };
      await assert.rejects(
        waitForLaneRunning(request),
        (error: unknown) => (error as { code?: string }).code === 'LANE_TIMED_OUT',
      );
      assert.equal(waits, 3);
    }
  });

  it('does not let a wall-clock rollback extend an earlier lane deadline', async () => {
    const pending = initialReview(60_000);
    pending.lanes[0]!.idle_deadline_at = new Date(START.getTime() + 1_000).toISOString();
    let wallNow = START.getTime();
    let monotonicNow = 1_000;
    const waits: number[] = [];

    await assert.rejects(waitForLaneRunning({
      load: () => pending,
      lane_id: 'reviewer-batch-1',
      now: () => new Date(wallNow),
      monotonicNow: () => monotonicNow,
      waitForChange: (_deadlineAt, maximumWaitMs) => {
        waits.push(maximumWaitMs);
        if (waits.length === 1) {
          wallNow -= 60_000;
          monotonicNow += 50;
          return;
        }
        monotonicNow += maximumWaitMs;
      },
      maximum_wait_ms: 30_000,
    }), (error: unknown) => (error as { code?: string }).code === 'LANE_TIMED_OUT');

    assert.deepEqual(waits, [1_000, 950]);
  });

  it('does not let a wall-clock jump expire an unchanged monotonic lane deadline', async () => {
    const pending = initialReview(60_000);
    let wallNow = START.getTime();
    let monotonicNow = 1_000;
    const waits: number[] = [];

    await assert.rejects(waitForLaneRunning({
      load: () => pending,
      lane_id: 'reviewer-batch-1',
      now: () => new Date(wallNow),
      monotonicNow: () => monotonicNow,
      waitForChange: (_deadlineAt, maximumWaitMs) => {
        waits.push(maximumWaitMs);
        if (waits.length === 1) {
          wallNow += 86_400_000;
          monotonicNow += 1;
          return;
        }
        monotonicNow += maximumWaitMs;
      },
      maximum_wait_ms: 30_000,
    }), (error: unknown) => (error as { code?: string }).code === 'LANE_TIMED_OUT');

    assert.deepEqual(waits, [30_000, 29_999]);
  });

  it('tightens the monotonic cap when the persisted lane deadline moves earlier', async () => {
    const pending = initialReview(60_000);
    let monotonicNow = 1_000;
    const waits: number[] = [];

    await assert.rejects(waitForLaneRunning({
      load: () => pending,
      lane_id: 'reviewer-batch-1',
      now: () => START,
      monotonicNow: () => monotonicNow,
      waitForChange: (_deadlineAt, maximumWaitMs) => {
        waits.push(maximumWaitMs);
        if (waits.length === 1) {
          pending.lanes[0]!.idle_deadline_at = new Date(START.getTime() + 1_000).toISOString();
          monotonicNow += 50;
          return;
        }
        monotonicNow += maximumWaitMs;
      },
      maximum_wait_ms: 30_000,
    }), (error: unknown) => (error as { code?: string }).code === 'LANE_TIMED_OUT');

    assert.deepEqual(waits, [30_000, 950]);
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

  it('persists one sanitized RESULT identity across receipt replay, restart, and reconciliation', async () => {
    await withTemporaryReviewRoot(async (root) => {
      const secret = `github_pat_${'s'.repeat(24)}`;
      const tsScope: ScopeManifest = {
        ...scope(),
        files: [{
          path: 'src/example.ts', change: 'MODIFIED', sources: ['WORKTREE'], binary: false,
          additions: 1, deletions: 0,
        }],
      };
      const plan: BatchPlan = {
        review_flags: [],
        batches: [{
          batch_id: 'batch-1', module_root: 'src', files: ['src/example.ts'], changed_lines: 1,
          oversized_single_file: false,
        }],
        required_lanes: [
          { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
          { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
        ],
      };
      const record = createInitialReviewRecord({
        review_id: REVIEW_ID,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        scope: tsScope,
        batch_plan: plan,
        lane_timeout_ms: 60_000,
        now: START,
      });
      const journal = trustedJournal();
      let durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, journal.host);
      const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
      await durable.start({ record, idempotency_key: START_KEY });
      await durable.recordStart({
        event: {
          event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1',
          thread_id: 'child-reviewer', idempotency_key: REVIEWER_START_KEY,
        },
        tracker: {
          schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer',
          tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker-reviewer',
          first_seen_at: START.toISOString(),
        },
        now: START,
      });
      const rawResult: import('../contract.js').ReviewerLaneResult = {
        role: 'code-reviewer',
        review_id: REVIEW_ID,
        attempt: 1,
        lane_id: 'reviewer-batch-1',
        batch_id: 'batch-1',
        scope_hash: HASH,
        recommendation: 'COMMENT',
        findings: [{
          severity: 'LOW', title: 'Remove the credential',
          body: `Authorization: Bearer ${secret}`, file: 'src/example.ts',
          fix: `replace api_key=${secret}`, evidence: secret,
        }],
        diagnostics: [
          {
            diagnostic_id: 'lsp-secret', capability: 'LSP', applicability: 'APPLICABLE',
            execution: 'NATIVE', outcome: 'PASS', tool_name: 'lsp_diagnostics',
            event_ref: 'diagnostic-lsp', summary: `token=${secret}`,
          },
          {
            diagnostic_id: 'ast-secret', capability: 'AST', applicability: 'APPLICABLE',
            execution: 'NATIVE', outcome: 'PASS', tool_name: 'ast_search',
            event_ref: 'diagnostic-ast', summary: `authorization: Bearer ${secret}`,
          },
        ],
      };
      const event = {
        event: 'RESULT' as const,
        review_id: REVIEW_ID,
        attempt: 1,
        lane_id: 'reviewer-batch-1',
        scope_hash: HASH,
        result: rawResult,
        idempotency_key: RESULT_KEY,
      };
      const receipt = await durable.recordResult({ event, source: 'MCP', now: START });
      assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret, 'u'));
      assert.equal(receipt.payload_digest, canonicalLanePayloadDigest(receipt.result));

      const proposalPath = join(paths.reviewRoot, REVIEW_ID, 'submissions', RESULT_KEY, 'proposal');
      const persistedProposal = JSON.parse(await readFile(proposalPath, 'utf8')) as LaneResultProposal;
      assert.deepEqual(persistedProposal, receipt);
      assert.equal(persistedProposal.payload_digest, canonicalLanePayloadDigest(persistedProposal.result));
      assert.doesNotMatch(JSON.stringify(persistedProposal), new RegExp(secret, 'u'));

      durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, journal.host);
      assert.deepEqual(await durable.recordResult({ event, source: 'CLI', now: START }), receipt);
      const resultPublication = publication(receipt, '2026-07-14T00:00:30.000Z');
      await atomicCreatePrivateJson(
        join(paths.reviewRoot, REVIEW_ID, 'submissions', RESULT_KEY, 'post-tool'),
        resultPublication,
      );
      journal.observe({
        cutoff_at: '2026-07-14T00:00:40.000Z',
        events: [],
        publications: [resultPublication],
        diagnostic_events: [
          {
            schema_version: 1, session_id: 'session-1', review_id: REVIEW_ID, attempt: 1,
            lane_id: 'reviewer-batch-1', child_thread_id: 'child-reviewer',
            event_ref: 'diagnostic-lsp', observed_at: '2026-07-14T00:00:10.000Z',
            tool_name: 'lsp_diagnostics',
          },
          {
            schema_version: 1, session_id: 'session-1', review_id: REVIEW_ID, attempt: 1,
            lane_id: 'reviewer-batch-1', child_thread_id: 'child-reviewer',
            event_ref: 'diagnostic-ast', observed_at: '2026-07-14T00:00:11.000Z',
            tool_name: 'ast_search',
          },
        ],
      });
      durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, journal.host);
      const reconciled = await durable.reconcile({ review_id: REVIEW_ID });
      assert.equal(reconciled.lanes[0]!.status, 'COMPLETE');
      assert.equal(reconciled.lanes[0]!.findings[0]?.body, 'Authorization: [REDACTED]');
      assert.doesNotMatch(JSON.stringify(reconciled), new RegExp(secret, 'u'));
      assert.doesNotMatch(
        await readFile(join(paths.reviewRoot, REVIEW_ID, 'lanes', 'reviewer-batch-1-attempt-1', 'terminal'), 'utf8'),
        new RegExp(secret, 'u'),
      );
    });
  });

  it('root-recovers an initial PREPARED transaction and continues past revision one', async () => {
    await withTemporaryReviewRoot(async (root) => {
      const plan: BatchPlan = {
        review_flags: [],
        batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
        required_lanes: [
          { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
          { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
        ],
      };
      const input = {
        review_id: REVIEW_ID, session_id: 'session-1', root_thread_id: 'root-1', scope: scope(),
        batch_plan: plan, batches: plan.batches, required_lanes: plan.required_lanes, now: START,
      };
      const record = (createInitialReviewRecord as unknown as (value: typeof input) => ReviewRecord)(input);
      const journal = trustedJournal();
      const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, journal.host);
      const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
      await assert.rejects(
        durable.start({ record, idempotency_key: START_KEY, crashAt: 'after:prepared' }),
        /injected crash/i,
      );
      await assert.rejects(readFile(paths.activePath, 'utf8'), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ));
      await assert.rejects(
        readFile(join(paths.reviewRoot, REVIEW_ID, 'review.json'), 'utf8'),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
      await assert.rejects(
        readdir(paths.pendingReviewTransactionsRoot),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
      const recoveredStart = await durable.get(REVIEW_ID);
      assert.equal(recoveredStart.revision, 1);
      assert.deepEqual(JSON.parse(await readFile(paths.activePath, 'utf8')), {
        schema_version: 1, review_id: REVIEW_ID, status: 'REVIEWING',
      });
      await durable.recordStart({
        event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-reviewer', idempotency_key: REVIEWER_START_KEY },
        tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker-reviewer', first_seen_at: START.toISOString() },
        now: START,
      });
      await durable.recordStart({
        event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', thread_id: 'child-architect', idempotency_key: ARCHITECT_START_KEY },
        tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-architect', tracker_lane_id: 'architect-global', tracker_path: 'tracker-architect', first_seen_at: START.toISOString() },
        now: START,
      });
      assert.equal((await durable.get(REVIEW_ID)).revision, 3, 'later root scans must not replay a stale revision-one START');
      const beforeProposalRevision = (await durable.get(REVIEW_ID)).revision;
      const reviewerEvent = {
        event: 'RESULT' as const, review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', scope_hash: HASH,
        result: resultProposal(running()).result, idempotency_key: RESULT_KEY,
      };
      const architectKey = '33333333-3333-4333-8333-333333333333';
      const architectEvent = {
        event: 'RESULT' as const, review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', scope_hash: HASH,
        result: { role: 'architect' as const, review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', batch_id: 'global' as const, scope_hash: HASH, architectural_status: 'CLEAR' as const, findings: [] },
        idempotency_key: architectKey,
      };
      const forgedKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const [reviewerProposal, architectProposal, forged] = await Promise.all([
        durable.recordResult({ event: reviewerEvent, source: 'MCP', now: START }),
        durable.recordResult({ event: architectEvent, source: 'MCP', now: START }),
        durable.recordResult({ event: { ...reviewerEvent, idempotency_key: forgedKey }, source: 'CLI', now: START }).then(
          () => null,
          (error: unknown) => error,
        ),
      ]);
      assert.match(String((forged as { code?: unknown })?.code), /MCP|TRANSPORT/);
      assert.equal((await durable.get(REVIEW_ID)).revision, beforeProposalRevision);

      const reviewerPublication = publication(reviewerProposal, '2026-07-14T00:04:00.000Z');
      const architectPublication = {
        ...publication(architectProposal, '2026-07-14T00:04:01.000Z'),
        activity: { ...publication(architectProposal, '2026-07-14T00:04:01.000Z').activity, child_thread_id: 'child-architect' },
        attestation: { ...publication(architectProposal, '2026-07-14T00:04:01.000Z').attestation, child_thread_id: 'child-architect' },
      };
      await Promise.all([
        atomicCreatePrivateJson(join(paths.reviewRoot, REVIEW_ID, 'submissions', RESULT_KEY, 'post-tool'), reviewerPublication),
        atomicCreatePrivateJson(join(paths.reviewRoot, REVIEW_ID, 'submissions', architectKey, 'post-tool'), architectPublication),
      ]);
      const snapshot = { cutoff_at: '2026-07-14T00:05:00.000Z', events: [], publications: [reviewerPublication, architectPublication], diagnostic_events: [] };
      journal.observe(snapshot);
      const reconciled = await durable.reconcile({ review_id: REVIEW_ID });
      assert.equal(reconciled.revision, beforeProposalRevision + 1);
      assert.equal(reconciled.lanes.filter((lane) => lane.status === 'COMPLETE').length, 2);
      assert.equal(reconciled.lanes.some((lane) => lane.last_processed_activity_ref === reviewerPublication.activity.event_ref), true);
      assert.equal(reconciled.lanes.some((lane) => lane.last_processed_activity_ref === architectPublication.activity.event_ref), true);
      const consumed = await readReviewConsumptionMarkers(paths, REVIEW_ID);
      assert.equal(consumed.length, 6);
      assert.deepEqual(
        consumed.reduce<Record<string, number>>((counts, marker) => ({
          ...counts,
          [marker.kind]: (counts[marker.kind] ?? 0) + 1,
        }), {}),
        { NONCE: 2, PROPOSAL_KEY: 2, TOOL_EVENT_REF: 2 },
      );
      assert.equal(await readFile(join(paths.reviewRoot, REVIEW_ID, 'lanes', 'reviewer-batch-1-attempt-1', 'terminal'), 'utf8').then(() => true), true);
      assert.equal(await readFile(join(paths.reviewRoot, REVIEW_ID, 'lanes', 'architect-global-attempt-1', 'terminal'), 'utf8').then(() => true), true);
      journal.observe({ ...snapshot, cutoff_at: '2026-07-14T00:06:00.000Z' });
      const replayed = await durable.reconcile({ review_id: REVIEW_ID });
      assert.equal(replayed.revision, reconciled.revision);
    });
  });

  it('recovers a pre-deadline PREPARED reconciliation after the deadline without re-evaluation', async () => {
    await withTemporaryReviewRoot(async (root) => {
      const plan: BatchPlan = {
        review_flags: [],
        batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
        required_lanes: [
          { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
          { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
        ],
      };
      const input = {
        review_id: REVIEW_ID, session_id: 'session-1', root_thread_id: 'root-1', scope: scope(), lane_timeout_ms: 60_000,
        batch_plan: plan, batches: plan.batches, required_lanes: plan.required_lanes, now: START,
      };
      const record = (createInitialReviewRecord as unknown as (value: typeof input) => ReviewRecord)(input);
      const journal = trustedJournal();
      const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, journal.host);
      await durable.start({ record, idempotency_key: START_KEY });
      await durable.recordStart({
        event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-reviewer', idempotency_key: REVIEWER_START_KEY },
        tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker-reviewer', first_seen_at: START.toISOString() }, now: START,
      });
      await durable.recordStart({
        event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', thread_id: 'child-architect', idempotency_key: ARCHITECT_START_KEY },
        tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-architect', tracker_lane_id: 'architect-global', tracker_path: 'tracker-architect', first_seen_at: START.toISOString() }, now: START,
      });
      const reviewerProposal = await durable.recordResult({
        event: { event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', scope_hash: HASH, result: resultProposal(running()).result, idempotency_key: RESULT_KEY },
        source: 'MCP', now: START,
      });
      const architectKey = '33333333-3333-4333-8333-333333333333';
      const architectProposal = await durable.recordResult({
        event: {
          event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', scope_hash: HASH,
          result: {
            role: 'architect', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', batch_id: 'global',
            scope_hash: HASH, architectural_status: 'CLEAR', findings: [],
          },
          idempotency_key: architectKey,
        },
        source: 'MCP', now: START,
      });
      const reviewerPublication = publication(reviewerProposal, '2026-07-14T00:00:59.000Z');
      const rawArchitectPublication = publication(architectProposal, '2026-07-14T00:00:59.100Z');
      const architectPublication: ResultPostToolPublication = {
        ...rawArchitectPublication,
        activity: { ...rawArchitectPublication.activity, child_thread_id: 'child-architect' },
        attestation: { ...rawArchitectPublication.attestation, child_thread_id: 'child-architect' },
      };
      const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
      await Promise.all([
        atomicCreatePrivateJson(join(paths.reviewRoot, REVIEW_ID, 'submissions', RESULT_KEY, 'post-tool'), reviewerPublication),
        atomicCreatePrivateJson(join(paths.reviewRoot, REVIEW_ID, 'submissions', architectKey, 'post-tool'), architectPublication),
      ]);
      const snapshot = {
        cutoff_at: '2026-07-14T00:00:59.500Z',
        events: [],
        publications: [reviewerPublication, architectPublication],
        diagnostic_events: [],
      };
      journal.observe(snapshot);
      await assert.rejects(durable.reconcile({ review_id: REVIEW_ID, crashAt: 'after:prepared' }), /injected crash/i);
      assert.deepEqual(JSON.parse(await readFile(paths.activePath, 'utf8')), {
        schema_version: 1,
        review_id: REVIEW_ID,
        status: 'REVIEWING',
      });
      journal.observe({ ...snapshot, cutoff_at: '2026-07-14T00:02:00.000Z' });
      const recovered = await durable.reconcile({ review_id: REVIEW_ID });
      assert.equal(recovered.lanes.find((lane) => lane.lane_id === 'reviewer-batch-1')?.status, 'COMPLETE');
      assert.equal(recovered.revision, 4);
      assert.deepEqual(JSON.parse(await readFile(paths.activePath, 'utf8')), {
        schema_version: 1,
        review_id: REVIEW_ID,
        status: 'READY_TO_SYNTHESIZE',
      });
      const transactions = await readdir(join(paths.reviewRoot, REVIEW_ID, 'transactions'));
      const committed = await Promise.all(transactions.map(async (directory) => {
        try {
          return await readFile(join(paths.reviewRoot, REVIEW_ID, 'transactions', directory, 'committed'), 'utf8');
        } catch {
          return null;
        }
      }));
      assert.equal(committed.some((value) => value?.includes('COMMITTED')), true);
    });
  });

  it('rejects nonce and tool-event reuse across separate observations', async () => {
    for (const reusedIdentity of ['nonce', 'tool-event-ref'] as const) {
      await withTemporaryReviewRoot(async (root) => {
        const plan: BatchPlan = {
          review_flags: [],
          batches: [{ batch_id: 'batch-1', module_root: '.', files: ['README.md'], changed_lines: 1, oversized_single_file: false }],
          required_lanes: [
            { lane_id: 'reviewer-batch-1', role: 'code-reviewer', batch_id: 'batch-1' },
            { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
          ],
        };
        const record = createInitialReviewRecord({
          review_id: REVIEW_ID,
          session_id: 'session-1',
          root_thread_id: 'root-1',
          scope: scope(),
          batch_plan: plan,
          now: START,
        });
        const journal = trustedJournal();
        const durable = durableFactory()({ workingDirectory: root, session_id: 'session-1' }, journal.host);
        const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
        await durable.start({ record, idempotency_key: START_KEY });
        await durable.recordStart({
          event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-reviewer', idempotency_key: REVIEWER_START_KEY },
          tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-reviewer', tracker_lane_id: 'reviewer-batch-1', tracker_path: 'tracker-reviewer', first_seen_at: START.toISOString() },
          now: START,
        });
        await durable.recordStart({
          event: { event: 'START', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', thread_id: 'child-architect', idempotency_key: ARCHITECT_START_KEY },
          tracker: { schema_version: 1, session_id: 'session-1', thread_id: 'child-architect', tracker_lane_id: 'architect-global', tracker_path: 'tracker-architect', first_seen_at: START.toISOString() },
          now: START,
        });
        const reviewerProposal = await durable.recordResult({
          event: {
            event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'reviewer-batch-1', scope_hash: HASH,
            result: resultProposal(running()).result, idempotency_key: RESULT_KEY,
          },
          source: 'MCP',
          now: START,
        });
        const architectKey = '33333333-3333-4333-8333-333333333333';
        const architectProposal = await durable.recordResult({
          event: {
            event: 'RESULT', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', scope_hash: HASH,
            result: {
              role: 'architect', review_id: REVIEW_ID, attempt: 1, lane_id: 'architect-global', batch_id: 'global',
              scope_hash: HASH, architectural_status: 'CLEAR', findings: [],
            },
            idempotency_key: architectKey,
          },
          source: 'MCP',
          now: START,
        });
        const reviewerPublication = publication(reviewerProposal, '2026-07-14T00:00:30.000Z');
        await atomicCreatePrivateJson(
          join(paths.reviewRoot, REVIEW_ID, 'submissions', RESULT_KEY, 'post-tool'),
          reviewerPublication,
        );
        journal.observe({
          cutoff_at: '2026-07-14T00:00:31.000Z',
          events: [],
          publications: [reviewerPublication],
          diagnostic_events: [],
        });
        await durable.reconcile({ review_id: REVIEW_ID });
        assert.deepEqual(
          (await readReviewConsumptionMarkers(paths, REVIEW_ID)).map((marker) => marker.kind).sort(),
          ['NONCE', 'PROPOSAL_KEY', 'TOOL_EVENT_REF'],
        );

        const baseArchitectPublication = publication(architectProposal, '2026-07-14T00:00:40.000Z');
        const architectPublication: ResultPostToolPublication = {
          ...baseArchitectPublication,
          activity: {
            ...baseArchitectPublication.activity,
            child_thread_id: 'child-architect',
            ...(reusedIdentity === 'tool-event-ref'
              ? { event_ref: reviewerPublication.activity.event_ref }
              : {}),
          },
          attestation: {
            ...baseArchitectPublication.attestation,
            child_thread_id: 'child-architect',
            ...(reusedIdentity === 'tool-event-ref'
              ? { tool_event_ref: reviewerPublication.attestation.tool_event_ref }
              : { nonce: reviewerPublication.attestation.nonce }),
          },
        };
        await atomicCreatePrivateJson(
          join(paths.reviewRoot, REVIEW_ID, 'submissions', architectKey, 'post-tool'),
          architectPublication,
        );
        journal.observe({
          cutoff_at: '2026-07-14T00:00:41.000Z',
          events: [],
          publications: [architectPublication],
          diagnostic_events: [],
        });
        await assert.rejects(
          durable.reconcile({ review_id: REVIEW_ID }),
          /consum|reuse|nonce|event.ref|evidence/i,
        );
      });
    }
  });
});
