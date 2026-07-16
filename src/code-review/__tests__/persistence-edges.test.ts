import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { BatchPlan } from '../batching.js';
import {
  createInitialReviewRecord,
} from '../coordinator.js';
import {
  acquireReviewLocks,
  atomicWritePrivateJson,
  createReviewConsumptionEffect,
  publishReviewHookJournalEntry,
  readActiveReview,
  readReviewConsumptionGroups,
  recoverDurableTransactions,
  resolveReviewPersistencePaths,
  runDurableReviewTransactionWithPlanFactory,
  runDurableTransaction,
  writeFinalReviewArtifacts,
  type DurableTransactionPlan,
  type ReviewPersistencePaths,
} from '../persistence.js';
import { projectFinalReviewArtifact } from '../render.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';

async function withPaths(run: (root: string, paths: ReviewPersistencePaths) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-persistence-edges-'));
  try {
    const paths = await resolveReviewPersistencePaths({ workingDirectory: root, session_id: 'session-1' });
    await run(root, paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function emptyFinalArtifact(reviewId = REVIEW_ID) {
  const batchPlan: BatchPlan = { review_flags: [], batches: [], required_lanes: [] };
  return projectFinalReviewArtifact(createInitialReviewRecord({
    review_id: reviewId,
    session_id: 'session-1',
    root_thread_id: 'root-1',
    scope: {
      selector: { explicit_paths: [] },
      status: 'FULL_SCOPE',
      scope_hash: 'a'.repeat(64),
      files: [],
      changed_lines: 0,
      reasons: [],
    },
    batch_plan: batchPlan,
    now: new Date('2026-07-14T00:00:00.000Z'),
  }));
}

function emptyPlan(overrides: Partial<DurableTransactionPlan> = {}): DurableTransactionPlan {
  return {
    journal_scope: 'REVIEW',
    idempotency_key: KEY,
    review_id: REVIEW_ID,
    operation: 'VALIDATE_PLAN',
    input: {},
    expected_revision: 0,
    effects: [],
    response: {},
    ...overrides,
  };
}

describe('review persistence exported failure edges', () => {
  it('rejects non-directories, unreadable active state, duplicate locks, and missing review lock identity', async () => {
    await withPaths(async (root, paths) => {
      const file = join(root, 'ordinary-file');
      await writeFile(file, 'not a directory', 'utf8');
      await assert.rejects(atomicWritePrivateJson(join(file, 'state.json'), {}), /not a directory/i);

      await mkdir(paths.reviewRoot, { recursive: true });
      await writeFile(paths.activePath, '{not-json', 'utf8');
      await assert.rejects(readActiveReview(paths), /could not read active review pointer/i);
      await rm(paths.activePath, { force: true });

      await assert.rejects(acquireReviewLocks(paths, REVIEW_ID, ['start', 'start']), /requested twice/i);
      await assert.rejects(acquireReviewLocks(paths, undefined, ['journal']), /requires a review_id/i);
    });
  });

  it('publishes activity and diagnostic hook journals create-once and rejects paths outside their schemas', async () => {
    await withPaths(async (_root, paths) => {
      const eventRef = 'event-1';
      const relativePath = `${REVIEW_ID}/activity/child-1/${createHash('sha256')
        .update(`${eventRef}:AGENT_PROGRESS`, 'utf8').digest('hex')}.json`;
      const input = {
        review_id: REVIEW_ID,
        relative_path: relativePath,
        build_value: (publishedAt: string) => ({ event_ref: eventRef, published_at: publishedAt }),
      };
      assert.equal(await publishReviewHookJournalEntry(paths, input), true);
      assert.equal(await publishReviewHookJournalEntry(paths, input), false);
      assert.match(await readFile(join(paths.reviewRoot, relativePath), 'utf8'), /event-1/u);
      const diagnosticPath = `${REVIEW_ID}/diagnostics/child-1/${createHash('sha256')
        .update(eventRef, 'utf8').digest('hex')}.json`;
      const diagnosticInput = {
        ...input,
        relative_path: diagnosticPath,
      };
      assert.equal(await publishReviewHookJournalEntry(paths, diagnosticInput), true);
      assert.equal(await publishReviewHookJournalEntry(paths, diagnosticInput), false);
      await assert.rejects(publishReviewHookJournalEntry(paths, {
        ...input,
        relative_path: `${REVIEW_ID}/arbitrary.json`,
      }), /hook journal target is invalid/i);
    });
  });

  it('fails deterministically when the selected operating-system process identity path is unavailable', async () => {
    await withPaths(async (_root, paths) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      assert.equal(descriptor?.configurable, true);
      try {
        const unavailablePlatforms = [
          ...(process.platform === 'linux' ? [] : ['linux']),
          process.platform === 'win32' ? 'darwin' : 'win32',
          'aix',
        ];
        for (const platform of unavailablePlatforms) {
          Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
          await assert.rejects(
            acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 1 }),
            /process start identity is unavailable/i,
            platform,
          );
        }
      } finally {
        Object.defineProperty(process, 'platform', descriptor!);
      }
    });
  });

  it('rejects malformed transaction plans and effects before PREPARED publication', async () => {
    await withPaths(async (_root, paths) => {
      const malformed: unknown[] = [
        { ...emptyPlan(), journal_scope: 'UNKNOWN' },
        { ...emptyPlan(), operation: '' },
        { ...emptyPlan(), expected_revision: -1 },
        { ...emptyPlan(), effects: {} },
        { ...emptyPlan(), effects: Array.from({ length: 100 }, () => ({})) },
        { ...emptyPlan(), effects: [null] },
        { ...emptyPlan(), effects: [{ name: 'report', mode: 'CREATE_ONCE_JSON', target: { area: 'FINAL_REVIEWS', path: `${REVIEW_ID}.json` }, payload: {}, extra: true }] },
        { ...emptyPlan(), effects: [{ name: 'unknown', mode: 'CREATE_ONCE_JSON', target: { area: 'REVIEW_STATE', path: 'x' }, payload: {} }] },
        { ...emptyPlan(), effects: [{ name: 'report', mode: 'UNKNOWN', target: { area: 'FINAL_REVIEWS', path: `${REVIEW_ID}.json` }, payload: {} }] },
        { ...emptyPlan(), effects: [{ name: 'report', mode: 'CREATE_ONCE_JSON', target: { area: 'UNKNOWN', path: `${REVIEW_ID}.json` }, payload: {} }] },
        { ...emptyPlan(), effects: [{ name: 'report', mode: 'CREATE_ONCE_JSON', target: { area: 'FINAL_REVIEWS', path: '../escape' }, payload: {} }] },
        { ...emptyPlan(), effects: [{ name: 'review', mode: 'APPLY_REVIEW_REVISION', target: { area: 'REVIEW_STATE', path: `${REVIEW_ID}/review.json` } }] },
        { ...emptyPlan(), effects: [{ name: 'active-overlay', mode: 'UPDATE_MATCHING_ACTIVE', target: { area: 'REVIEW_STATE', path: 'active.json' }, payload: {} }] },
        { ...emptyPlan(), effects: [{ name: 'stop-marker', mode: 'REPLACE_MATCHING_JSON', target: { area: 'REVIEW_STATE', path: 'stop-terminal-brief.json' }, payload: {} }] },
        { ...emptyPlan(), effects: [{ name: 'report', mode: 'CREATE_ONCE_JSON', target: { area: 'FINAL_REVIEWS', path: `${REVIEW_ID}.json` } }] },
      ];
      for (const plan of malformed) {
        await assert.rejects(runDurableTransaction(paths, plan), /transaction|effect|target|review|active|replace|payload/i);
      }
    });
  });

  it('strictly validates consumption inputs, recovery scope, and trusted factory ownership', async () => {
    assert.throws(() => createReviewConsumptionEffect(null as never), /input is malformed/i);
    assert.throws(() => createReviewConsumptionEffect({
      review_id: REVIEW_ID,
      idempotency_key: KEY,
      kind: 'NONCE',
      value: 'bad\nvalue',
      consumed_at: '2026-07-14T00:00:00.000Z',
    }), /value is invalid/i);
    assert.throws(() => createReviewConsumptionEffect({
      review_id: REVIEW_ID,
      idempotency_key: KEY,
      kind: 'NONCE',
      value: 'nonce',
      consumed_at: 'not-a-time',
    }), /consumed_at is invalid/i);

    await withPaths(async (_root, paths) => {
      await assert.rejects(recoverDurableTransactions(paths, {
        review_id: REVIEW_ID,
        idempotency_key: KEY,
        journal_scope: 'UNKNOWN' as 'REVIEW',
      }), /journal scope is invalid/i);
      await assert.rejects(runDurableReviewTransactionWithPlanFactory(paths, null as never), /factory input is malformed/i);
      await assert.rejects(runDurableReviewTransactionWithPlanFactory(paths, {
        review_id: REVIEW_ID,
        session_id: 'other-session',
        root_thread_id: 'root-1',
        plan_factory: async () => undefined,
      }), /persistence scope conflicts/i);
      assert.deepEqual(await readReviewConsumptionGroups(paths, REVIEW_ID), []);
    });
  });

  it('fails closed for malformed, conflicting, and unwritable final artifact publications', async () => {
    await withPaths(async (_root, paths) => {
      const artifact = emptyFinalArtifact();
      await mkdir(paths.reviewsRoot, { recursive: true });
      const jsonPath = join(paths.reviewsRoot, `${REVIEW_ID}.json`);
      await writeFile(jsonPath, '{not-json', 'utf8');
      await assert.rejects(writeFinalReviewArtifacts(paths, artifact), /published final review JSON is malformed/i);

      await rm(jsonPath, { force: true });
      await writeFinalReviewArtifacts(paths, artifact);
      await assert.rejects(writeFinalReviewArtifacts(paths, { ...artifact, revision: artifact.revision + 1 }), /conflicts with the requested artifact/i);
    });

    await withPaths(async (_root, paths) => {
      const artifact = emptyFinalArtifact();
      await mkdir(join(paths.reviewsRoot, `${REVIEW_ID}.md`), { recursive: true });
      await assert.rejects(writeFinalReviewArtifacts(paths, artifact));
      assert.match(await readFile(join(paths.reviewsRoot, `${REVIEW_ID}.json`), 'utf8'), /NO_CHANGES/u);
    });
  });
});
