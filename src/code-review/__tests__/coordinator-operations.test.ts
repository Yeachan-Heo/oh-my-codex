import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  consumeStopTerminalBrief,
  executeReviewOperation,
  loadActiveReviewIdentity,
  seedCreatedReviewIntent,
  type ReviewOperationHostContext,
  type ReviewOperationResponse,
} from '../coordinator.js';
import { resolveReviewPersistencePaths } from '../persistence.js';

const START = new Date('2026-07-14T00:00:00.000Z');
const START_KEY = '11111111-1111-4111-8111-111111111111';
const LANE_KEY = '22222222-2222-4222-8222-222222222222';
const FINALIZE_KEY = '33333333-3333-4333-8333-333333333333';
const RESUME_KEY = '44444444-4444-4444-8444-444444444444';
const RESULT_KEY = '55555555-5555-4555-8555-555555555555';

interface OperationPayload {
  review_id: string;
  attempt: number;
  status: string;
  revision: number;
  artifact_sha256?: string;
  scope?: { scope_hash: string };
  required_lane_plan?: Array<{ lane_id: string; role: string; batch_id: string }>;
  lanes?: Array<{ lane_id: string; attempt: number; status: string }>;
}

function payload(response: ReviewOperationResponse): OperationPayload {
  assert.notEqual(response.isError, true, JSON.stringify(response.payload));
  assert.equal(typeof response.payload, 'object');
  return response.payload as OperationPayload;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function withRepository(
  run: (root: string) => Promise<void>,
  changed: boolean,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-review-operations-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Test User']);
    git(root, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(root, '.gitignore'), '.omx/\n', 'utf8');
    await writeFile(join(root, 'README.md'), 'before\n', 'utf8');
    git(root, ['add', '.gitignore', 'README.md']);
    git(root, ['commit', '-q', '-m', 'baseline']);
    if (changed) await writeFile(join(root, 'README.md'), 'after\n', 'utf8');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withChangedRepository(run: (root: string) => Promise<void>): Promise<void> {
  return await withRepository(run, true);
}

async function withCleanRepository(run: (root: string) => Promise<void>): Promise<void> {
  return await withRepository(run, false);
}

function host(overrides: Partial<ReviewOperationHostContext> = {}): ReviewOperationHostContext {
  return {
    source: 'MCP',
    root_thread_id: 'root-1',
    now: () => START,
    ...overrides,
  };
}

describe('review operation control plane', () => {
  it('runs START, lane binding, blocking finalization, Stop consumption, and resume through public operations', async () => {
    await withChangedRepository(async (workingDirectory) => {
      const startInput = {
        workingDirectory,
        session_id: 'session-1',
        invocation: ['$code-review'],
        idempotency_key: START_KEY,
      };
      const started = payload(await executeReviewOperation('review_start', startInput, host()));
      assert.equal(started.status, 'REVIEWING');
      assert.equal(started.attempt, 1);
      assert.equal(started.required_lane_plan?.length, 2);

      const replayed = payload(await executeReviewOperation('review_start', startInput, host()));
      assert.equal(replayed.review_id, started.review_id);
      assert.equal(replayed.revision, started.revision);

      for (const [name, input, operationHost] of [
        ['review_get', { workingDirectory, session_id: 'session-1', review_id: 'not-a-uuid' }, host()],
        ['review_get', {
          workingDirectory, session_id: 'session-1', review_id: started.review_id,
          lane_id: 'reviewer-batch-1', wait: true, maximum_wait_ms: 0,
        }, host()],
        ['review_finalize', {
          workingDirectory, session_id: 'session-1', review_id: started.review_id,
          attempt: 0, idempotency_key: FINALIZE_KEY,
        }, host()],
        ['review_record_lane', {
          workingDirectory, session_id: 'session-1', event: 'START', review_id: started.review_id,
          attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-invalid-clock', idempotency_key: LANE_KEY,
        }, host({ now: () => new Date(Number.NaN) })],
        ['review_record_lane', {
          workingDirectory, session_id: 'session-1', event: 'START', review_id: started.review_id,
          attempt: 1, lane_id: 'reviewer-batch-1', thread_id: 'child-no-loader', idempotency_key: LANE_KEY,
        }, host()],
      ] as const) {
        const rejected = await executeReviewOperation(name, input, operationHost);
        assert.equal(rejected.isError, true, `${name}: ${JSON.stringify(input)}`);
      }

      const active = await loadActiveReviewIdentity({ workingDirectory, session_id: 'session-1' });
      assert.deepEqual(active, {
        review_id: started.review_id,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        status: 'REVIEWING',
      });

      const loaded = payload(await executeReviewOperation('review_get', {
        workingDirectory,
        session_id: 'session-1',
      }, host()));
      assert.equal(loaded.review_id, started.review_id);

      const persistedPaths = await resolveReviewPersistencePaths({ workingDirectory, session_id: 'session-1' });
      const reviewPath = join(persistedPaths.reviewRoot, started.review_id, 'review.json');
      const originalReview = await readFile(reviewPath, 'utf8');
      await writeFile(reviewPath, '{not-json', 'utf8');
      const malformedReview = await executeReviewOperation('review_get', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
      }, host());
      assert.equal(malformedReview.isError, true);
      await writeFile(reviewPath, originalReview, 'utf8');

      const wrongSessionReview = JSON.parse(originalReview) as Record<string, unknown>;
      wrongSessionReview.session_id = 'other-session';
      const receiptPath = join(persistedPaths.startReceiptsRoot, `${START_KEY}.json`);
      const originalReceipt = await readFile(receiptPath, 'utf8');
      await rm(receiptPath, { force: true });
      await writeFile(reviewPath, `${JSON.stringify(wrongSessionReview)}\n`, 'utf8');
      const ownershipConflict = await executeReviewOperation('review_get', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
      }, host());
      assert.equal(ownershipConflict.isError, true);
      assert.match(JSON.stringify(ownershipConflict.payload), /ownership conflicts/i);
      await writeFile(reviewPath, originalReview, 'utf8');
      await writeFile(receiptPath, originalReceipt, 'utf8');

      const reviewerLane = started.required_lane_plan!.find((lane) => lane.role === 'code-reviewer')!;
      const bound = payload(await executeReviewOperation('review_record_lane', {
        workingDirectory,
        session_id: 'session-1',
        event: 'START',
        review_id: started.review_id,
        attempt: 1,
        lane_id: reviewerLane.lane_id,
        thread_id: 'child-reviewer',
        idempotency_key: LANE_KEY,
      }, host({
        loadTracker: async () => ({
          schema_version: 1,
          session_id: 'session-1',
          thread_id: 'child-reviewer',
          tracker_lane_id: reviewerLane.lane_id,
          tracker_path: '.omx/tracker/child-reviewer.json',
          first_seen_at: START.toISOString(),
        }),
      })));
      assert.equal(bound.lanes?.find((lane) => lane.lane_id === reviewerLane.lane_id)?.status, 'RUNNING');

      const ready = payload(await executeReviewOperation('review_get', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
        lane_id: reviewerLane.lane_id,
        wait: true,
        maximum_wait_ms: 100,
      }, host()));
      assert.equal(ready.review_id, started.review_id);

      const proposal = payload(await executeReviewOperation('review_record_lane', {
        workingDirectory,
        session_id: 'session-1',
        event: 'RESULT',
        review_id: started.review_id,
        attempt: 1,
        lane_id: reviewerLane.lane_id,
        scope_hash: started.scope!.scope_hash,
        result: {
          role: 'code-reviewer',
          review_id: started.review_id,
          attempt: 1,
          lane_id: reviewerLane.lane_id,
          batch_id: reviewerLane.batch_id,
          scope_hash: started.scope!.scope_hash,
          recommendation: 'COMMENT',
          findings: [],
          diagnostics: [],
        },
        idempotency_key: RESULT_KEY,
      }, host()));
      assert.equal((proposal as unknown as { state?: unknown }).state, 'PENDING_HOST_ATTESTATION');

      const proposalPaths = await resolveReviewPersistencePaths({ workingDirectory, session_id: 'session-1' });
      const proposalPath = join(
        proposalPaths.reviewRoot,
        started.review_id,
        'submissions',
        RESULT_KEY,
        'proposal',
      );
      const originalProposal = await readFile(proposalPath, 'utf8');
      const replayResult = async (): Promise<ReviewOperationResponse> => await executeReviewOperation('review_record_lane', {
        workingDirectory,
        session_id: 'session-1',
        event: 'RESULT',
        review_id: started.review_id,
        attempt: 1,
        lane_id: reviewerLane.lane_id,
        scope_hash: started.scope!.scope_hash,
        result: {
          role: 'code-reviewer',
          review_id: started.review_id,
          attempt: 1,
          lane_id: reviewerLane.lane_id,
          batch_id: reviewerLane.batch_id,
          scope_hash: started.scope!.scope_hash,
          recommendation: 'COMMENT',
          findings: [],
          diagnostics: [],
        },
        idempotency_key: RESULT_KEY,
      }, host());
      await writeFile(proposalPath, '{not-json', 'utf8');
      assert.equal((await replayResult()).isError, true);
      await writeFile(proposalPath, '{}\n', 'utf8');
      assert.equal((await replayResult()).isError, true);
      const invalidDigestProposal = JSON.parse(originalProposal) as Record<string, unknown>;
      invalidDigestProposal.payload_digest = 'b'.repeat(64);
      await writeFile(proposalPath, `${JSON.stringify(invalidDigestProposal)}\n`, 'utf8');
      assert.equal((await replayResult()).isError, true);
      await writeFile(proposalPath, originalProposal, 'utf8');

      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: 'a'.repeat(64),
        issued_stop_signature: 's'.repeat(43),
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /ownership or verdict conflicts/i);

      const wrongAttempt = await executeReviewOperation('review_finalize', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
        attempt: 2,
        idempotency_key: FINALIZE_KEY,
      }, host());
      assert.equal(wrongAttempt.isError, true);

      const stopSignature = 's'.repeat(43);
      const wrongStopOwner = await executeReviewOperation('review_finalize', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
        attempt: 1,
        idempotency_key: '66666666-6666-4666-8666-666666666666',
      }, host({
        loadHookJournalSnapshot: async () => ({
          events: [],
          diagnostic_events: [],
          publication_ids: [],
        }),
        stop_terminal_brief: {
          session_id: 'other-session',
          root_thread_id: 'other-root',
          issued_stop_signature: stopSignature,
          issued_at: START.toISOString(),
        },
      }));
      assert.equal(wrongStopOwner.isError, true);
      assert.match(JSON.stringify(wrongStopOwner.payload), /Stop marker ownership conflicts/i);

      const finalized = payload(await executeReviewOperation('review_finalize', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
        attempt: 1,
        idempotency_key: FINALIZE_KEY,
      }, host({
        loadHookJournalSnapshot: async () => ({
          events: [],
          diagnostic_events: [],
          publication_ids: [],
        }),
        stop_terminal_brief: {
          session_id: 'session-1',
          root_thread_id: 'root-1',
          issued_stop_signature: stopSignature,
          issued_at: START.toISOString(),
        },
      })));
      assert.equal(finalized.status, 'BLOCKED');
      assert.match(finalized.artifact_sha256!, /^[0-9a-f]{64}$/u);

      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: 'bad',
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /consumption identity is invalid/i);

      const paths = await resolveReviewPersistencePaths({ workingDirectory, session_id: 'session-1' });
      const markerPath = paths.stopTerminalBriefPath;
      const artifactPath = join(paths.reviewsRoot, `${started.review_id}.json`);
      const originalMarker = await readFile(markerPath, 'utf8');
      const originalArtifact = await readFile(artifactPath, 'utf8');
      await writeFile(markerPath, 'null\n', 'utf8');
      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: finalized.artifact_sha256!,
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /marker is malformed/i);
      await writeFile(markerPath, originalMarker, 'utf8');

      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: 'c'.repeat(64),
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /marker identity conflicts/i);

      await writeFile(artifactPath, '{not-json', 'utf8');
      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: finalized.artifact_sha256!,
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /artifact is invalid/i);
      const conflictingArtifact = JSON.parse(originalArtifact) as Record<string, unknown>;
      conflictingArtifact.revision = Number(conflictingArtifact.revision) + 1;
      await writeFile(artifactPath, `${JSON.stringify(conflictingArtifact)}\n`, 'utf8');
      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: finalized.artifact_sha256!,
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /artifact identity conflicts/i);
      await writeFile(artifactPath, originalArtifact, 'utf8');

      const consumed = await consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: finalized.artifact_sha256!,
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      });
      assert.equal(consumed.state, 'CONSUMED');
      const consumedPath = paths.stopTerminalBriefConsumedPath;
      const originalConsumed = await readFile(consumedPath, 'utf8');
      const conflictingConsumed = JSON.parse(originalConsumed) as Record<string, unknown>;
      conflictingConsumed.assistant_message_sha256 = 'c'.repeat(64);
      await writeFile(consumedPath, `${JSON.stringify(conflictingConsumed)}\n`, 'utf8');
      await assert.rejects(consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: finalized.artifact_sha256!,
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), /consumed Stop records conflict/i);
      await writeFile(consumedPath, originalConsumed, 'utf8');
      assert.deepEqual(await consumeStopTerminalBrief({
        workingDirectory,
        session_id: 'session-1',
        root_thread_id: 'root-1',
        review_id: started.review_id,
        artifact_sha256: finalized.artifact_sha256!,
        issued_stop_signature: stopSignature,
        assistant_message_sha256: 'b'.repeat(64),
        consumed_at: '2026-07-14T00:00:01.000Z',
      }), consumed);

      const resumed = payload(await executeReviewOperation('review_resume', {
        workingDirectory,
        session_id: 'session-1',
        review_id: started.review_id,
        idempotency_key: RESUME_KEY,
      }, host()));
      assert.equal(resumed.status, 'REVIEWING');
      assert.equal(resumed.attempt, 2);
      assert.equal(resumed.lanes?.filter((lane) => lane.attempt === 2 && lane.status === 'PENDING').length, 2);
    });
  });

  it('activates one hook-seeded CREATED intent and reuses its durable identity', async () => {
    await withChangedRepository(async (workingDirectory) => {
      const seeded = await seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2',
        root_thread_id: 'root-2',
        invocation_turn_id: 'turn-2',
        normalized_invocation: '  $code-review   README.md  ',
        now: START,
      });
      assert.equal(seeded.review.status, 'CREATED');
      assert.equal(seeded.intent.normalized_invocation, '$code-review README.md');

      const createdCannotResume = await executeReviewOperation('review_resume', {
        workingDirectory,
        session_id: 'session-2',
        review_id: seeded.review.review_id,
        idempotency_key: RESUME_KEY,
      }, host({ root_thread_id: 'root-2' }));
      assert.equal(createdCannotResume.isError, true);
      assert.equal((createdCannotResume.payload as { code?: unknown }).code, 'REVIEW_NOT_STARTED');

      const repeated = await seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2',
        root_thread_id: 'root-2',
        normalized_invocation: '$code-review README.md',
        now: START,
      });
      assert.equal(repeated.review.review_id, seeded.review.review_id);

      await assert.rejects(seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2',
        root_thread_id: 'root-2',
        normalized_invocation: '$code-review README.md',
        now: new Date(Number.NaN),
      }), /clock is invalid/i);

      const activated = payload(await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-2',
        invocation: ['$code-review', 'README.md'],
        idempotency_key: START_KEY,
      }, host({ seeded_review_id: seeded.review.review_id, root_thread_id: 'root-2' })));
      assert.equal(activated.review_id, seeded.review.review_id);
      assert.equal(activated.status, 'REVIEWING');
      assert.equal((await loadActiveReviewIdentity({ workingDirectory, session_id: 'session-2' }))?.status, 'REVIEWING');

      const activationReplay = payload(await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-2',
        invocation: ['$code-review', 'README.md'],
        idempotency_key: START_KEY,
      }, host({ seeded_review_id: seeded.review.review_id, root_thread_id: 'root-2' })));
      assert.equal(activationReplay.revision, activated.revision);

      const changedReplay = await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-2',
        invocation: ['$code-review'],
        idempotency_key: START_KEY,
      }, host({ seeded_review_id: seeded.review.review_id, root_thread_id: 'root-2' }));
      assert.equal(changedReplay.isError, true);
      assert.equal((changedReplay.payload as { code?: unknown }).code, 'IDEMPOTENCY_CONFLICT');

      const secondActivation = await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-2',
        invocation: ['$code-review', 'README.md'],
        idempotency_key: '20202020-2020-4020-8020-202020202020',
      }, host({ seeded_review_id: seeded.review.review_id, root_thread_id: 'root-2' }));
      assert.equal(secondActivation.isError, true);
      assert.equal((secondActivation.payload as { code?: unknown }).code, 'IDEMPOTENCY_CONFLICT');
    });

    // Corrupt-state probes run in their own repository because a failed durable
    // transaction intentionally remains recoverable and must not be erased by a
    // test before the subsequent happy-path activation.
    await withChangedRepository(async (workingDirectory) => {
      const seeded = await seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2-corrupt',
        root_thread_id: 'root-2',
        normalized_invocation: '$code-review README.md',
        now: START,
      });
      const paths = await resolveReviewPersistencePaths({ workingDirectory, session_id: 'session-2-corrupt' });
      const activePath = paths.activePath;
      const intentPath = join(paths.reviewRoot, seeded.review.review_id, 'created-intent.json');
      const originalActive = await readFile(activePath, 'utf8');
      await writeFile(activePath, JSON.stringify({
        schema_version: 1,
        review_id: seeded.review.review_id,
        status: 'SCOPE_FROZEN',
      }), 'utf8');
      await assert.rejects(
        loadActiveReviewIdentity({ workingDirectory, session_id: 'session-2-corrupt' }),
        /active review pointer conflicts/i,
      );
      await assert.rejects(seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2-corrupt',
        root_thread_id: 'root-2',
        normalized_invocation: '$code-review README.md',
        now: START,
      }), /ownership conflicts/i);
      await writeFile(activePath, originalActive, 'utf8');

      await writeFile(intentPath, '{}\n', 'utf8');
      await assert.rejects(seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2-corrupt',
        root_thread_id: 'root-2',
        normalized_invocation: '$code-review README.md',
        now: START,
      }), /intent is malformed/i);
    });

    await withChangedRepository(async (workingDirectory) => {
      const seeded = await seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-2-owner',
        root_thread_id: 'root-2',
        normalized_invocation: '$code-review README.md',
        now: START,
      });
      const wrongOwner = await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-2-owner',
        invocation: ['$code-review', 'README.md'],
        idempotency_key: '10101010-1010-4010-8010-101010101010',
      }, host({ seeded_review_id: seeded.review.review_id, root_thread_id: 'other-root' }));
      assert.equal(wrongOwner.isError, true);
      assert.equal((wrongOwner.payload as { code?: unknown }).code, 'PERSISTENCE_FAILED');
    });
  });

  it('activates a clean-repository intent directly into one published final review', async () => {
    await withCleanRepository(async (workingDirectory) => {
      const seeded = await seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-clean',
        root_thread_id: 'root-clean',
        normalized_invocation: '$code-review',
        now: START,
      });
      const activated = payload(await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-clean',
        invocation: ['$code-review'],
        idempotency_key: START_KEY,
      }, host({ seeded_review_id: seeded.review.review_id, root_thread_id: 'root-clean' })));
      assert.equal(activated.status, 'FINALIZED');
      const paths = await resolveReviewPersistencePaths({ workingDirectory, session_id: 'session-clean' });
      const artifact = JSON.parse(await readFile(join(paths.reviewsRoot, `${activated.review_id}.json`), 'utf8')) as {
        review_id?: unknown;
        status?: unknown;
      };
      assert.deepEqual({ review_id: artifact.review_id, status: artifact.status }, {
        review_id: activated.review_id,
        status: 'FINALIZED',
      });
    });
  });

  it('fails closed at the adapter boundary for malformed calls and a corrupt START receipt', async () => {
    await withChangedRepository(async (workingDirectory) => {
      const invalidCases: Array<[Parameters<typeof executeReviewOperation>[0], unknown, ReviewOperationHostContext]> = [
        ['review_start', null, host()],
        ['review_start', { workingDirectory, invocation: [], idempotency_key: START_KEY, extra: true }, host()],
        ['review_start', { workingDirectory, invocation: '--all', idempotency_key: START_KEY }, host()],
        ['review_start', { workingDirectory, invocation: ['$code-review', '--base', 'definitely-missing'], idempotency_key: START_KEY }, host()],
        ['review_start', { workingDirectory, invocation: ['--resume', START_KEY], idempotency_key: START_KEY }, host()],
        ['review_get', { workingDirectory, review_id: START_KEY, wait: 'yes' }, host()],
        ['review_get', { workingDirectory, wait: true }, host()],
        ['review_get', { workingDirectory, lane_id: 'lane', maximum_wait_ms: 1 }, host()],
        ['review_get', { workingDirectory, lane_id: 'lane', wait: true, maximum_wait_ms: 0 }, host()],
        ['review_get', { workingDirectory, lane_id: 'lane', wait: true }, { source: 'CLI' }],
        ['review_record_lane', { workingDirectory, event: 'OTHER' }, host()],
        ['review_record_lane', {
          workingDirectory,
          event: 'START',
          review_id: START_KEY,
          attempt: 1,
          lane_id: 'lane',
          thread_id: 'child',
          idempotency_key: LANE_KEY,
        }, host()],
        ['review_finalize', {
          workingDirectory,
          review_id: START_KEY,
          attempt: 0,
          idempotency_key: FINALIZE_KEY,
        }, host()],
      ];
      for (const [name, input, operationHost] of invalidCases) {
        const response = await executeReviewOperation(name, input, operationHost);
        assert.equal(response.isError, true, `${name}: ${JSON.stringify(input)}`);
      }

      const validBase = await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-valid-base',
        invocation: ['$code-review', '--base', 'HEAD'],
        idempotency_key: '77777777-7777-4777-8777-777777777777',
      }, host({ root_thread_id: 'root-valid-base' }));
      assert.equal(validBase.isError, undefined, JSON.stringify(validBase.payload));

      await assert.rejects(seedCreatedReviewIntent({
        workingDirectory,
        session_id: 'session-empty-intent',
        root_thread_id: 'root-empty-intent',
        normalized_invocation: '   ',
        now: START,
      }), /invocation is empty/i);

      const paths = await resolveReviewPersistencePaths({ workingDirectory, session_id: 'session-3' });
      await mkdir(paths.startReceiptsRoot, { recursive: true });
      await writeFile(join(paths.startReceiptsRoot, `${START_KEY}.json`), '{"idempotency_key":"wrong"}\n', 'utf8');
      const corrupt = await executeReviewOperation('review_start', {
        workingDirectory,
        session_id: 'session-3',
        invocation: ['$code-review'],
        idempotency_key: START_KEY,
      }, host({ root_thread_id: 'root-3' }));
      assert.equal(corrupt.isError, true);
      assert.equal((corrupt.payload as { code?: unknown }).code, 'PERSISTENCE_FAILED');
      assert.match(await readFile(join(paths.startReceiptsRoot, `${START_KEY}.json`), 'utf8'), /wrong/u);
    });
  });
});
