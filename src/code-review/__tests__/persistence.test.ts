import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { sanitizeForPersistence } from '../redaction.js';

const execFileAsync = promisify(execFile);

interface ReviewPersistencePaths {
  workingDirectory: string;
  session_id?: string;
  reviewRoot: string;
  activePath: string;
  startLockPath: string;
  reviewsRoot: string;
  startTransactionsRoot: string;
  startReceiptsRoot: string;
  pendingReviewTransactionsRoot: string;
}

interface ReviewScopedLockPaths {
  journalLockPath: string;
  mutationLockPath: string;
}

interface PersistenceApi {
  generateReviewId(): string;
  resolveReviewPersistencePaths(input: {
    workingDirectory: string;
    session_id?: string;
  }): Promise<ReviewPersistencePaths>;
  claimActiveReview(
    paths: ReviewPersistencePaths,
    pointer: {
      schema_version: 1;
      review_id: string;
      status: 'CREATED' | 'SCOPE_FROZEN' | 'REVIEWING' | 'READY_TO_SYNTHESIZE' | 'FINALIZED' | 'BLOCKED';
    },
  ): Promise<void>;
  readActiveReview(paths: ReviewPersistencePaths): Promise<{
    schema_version: 1;
    review_id: string;
    status: string;
  } | null>;
  atomicWritePrivateJson(
    path: string,
    value: unknown,
    options?: { beforeRename?: (temporaryPath: string) => void | Promise<void> },
  ): Promise<void>;
}

type ReviewLockName = 'start' | 'journal' | 'mutation';

interface ReviewLockHandle {
  name: ReviewLockName;
  path: string;
  nonce: string;
}

interface LockPersistenceApi extends PersistenceApi {
  resolveReviewLockPaths(paths: ReviewPersistencePaths, review_id: string): ReviewScopedLockPaths;
  probeReviewLockOwner(
    owner: {
      pid: number;
      hostname: string;
      process_start_marker: string;
      nonce: string;
      acquired_at: string;
    },
    readMarker?: (pid: number) => Promise<string | null>,
  ): Promise<'live' | 'absent' | 'reused' | 'unknown'>;
  acquireReviewLocks(
    paths: ReviewPersistencePaths,
    review_id: string | undefined,
    requested: readonly ReviewLockName[],
    options?: {
      timeoutMs?: number;
      now?: () => number;
      ownerProbe?: (owner: {
        pid: number;
        hostname: string;
        process_start_marker: string;
        nonce: string;
        acquired_at: string;
      }) => 'live' | 'absent' | 'reused' | 'unknown' | Promise<'live' | 'absent' | 'reused' | 'unknown'>;
      waitForChange?: (lockPath: string, remainingMs: number) => void | Promise<void>;
      onAcquired?: (name: ReviewLockName) => void;
      beforeReclaimRename?: (lockPath: string) => void | Promise<void>;
      afterReclaimRename?: (lockPath: string, quarantinePath: string) => void | Promise<void>;
    },
  ): Promise<ReviewLockHandle[]>;
  releaseReviewLocks(
    handles: readonly ReviewLockHandle[],
    options?: { afterOwnerRead?: (handle: ReviewLockHandle) => void | Promise<void> },
  ): Promise<boolean[]>;
}

type DurableStage =
  | 'prepared'
  | 'locator'
  | 'created-intent'
  | 'proposal'
  | 'post-tool'
  | 'consume'
  | 'manifest'
  | 'lane'
  | 'review'
  | 'report'
  | 'active-overlay'
  | 'approval'
  | 'stop-consume'
  | 'stop-marker'
  | 'committed'
  | 'receipt'
  | 'locator-cleanup';

type DurableBoundary = `before:${DurableStage}` | `after:${DurableStage}`;

interface DurableEffect {
  name: Exclude<DurableStage, 'prepared' | 'locator' | 'committed' | 'receipt' | 'locator-cleanup'>;
  mode:
    | 'CREATE_ONCE_JSON'
    | 'APPLY_REVIEW_REVISION'
    | 'UPDATE_MATCHING_ACTIVE'
    | 'RESTORE_MISSING_ACTIVE'
    | 'REMOVE_MATCHING_ACTIVE'
    | 'REPLACE_MATCHING_JSON';
  target: { area: 'REVIEW_STATE' | 'FINAL_REVIEWS'; path: string };
  payload?: unknown;
  review_id?: string;
  expected_status?: string;
  expected_revision?: number;
}

type ReviewConsumptionKind = 'PROPOSAL_KEY' | 'TOOL_EVENT_REF' | 'NONCE';

interface ReviewConsumptionMarker {
  schema_version: 1;
  state: 'CONSUMED';
  review_id: string;
  kind: ReviewConsumptionKind;
  value_sha256: string;
  idempotency_key: string;
  consumed_at: string;
}

interface DurablePlan {
  journal_scope?: 'START' | 'REVIEW';
  idempotency_key: string;
  review_id: string;
  operation: string;
  input: unknown;
  expected_revision: number;
  effects: DurableEffect[];
  response: unknown;
}

interface ReviewRecordSnapshot extends Record<string, unknown> {
  review_id: string;
  revision: number;
  status: string;
  session_id?: string;
  root_thread_id?: string;
}

interface DurablePersistenceApi extends LockPersistenceApi {
  atomicCreatePrivateJson(
    path: string,
    value: unknown,
    options?: { beforePublish?: (temporaryPath: string) => void | Promise<void> },
  ): Promise<void>;
  runDurableTransaction(
    paths: ReviewPersistencePaths,
    plan: DurablePlan,
    options?: { crashAt?: DurableBoundary; crashMode?: 'THROW' | 'SIGKILL' | 'ABORT' },
  ): Promise<{ state: 'COMMITTED'; response: unknown }>;
  runDurableReviewTransactionWithPlanFactory(
    paths: ReviewPersistencePaths,
    input: {
      review_id: string;
      session_id: string;
      root_thread_id: string;
      plan_factory(context: { current_review: ReviewRecordSnapshot }): Promise<DurablePlan | undefined>;
    },
    options?: { crashAt?: DurableBoundary; crashMode?: 'THROW' | 'SIGKILL' | 'ABORT' },
  ): Promise<{
    transaction?: { state: 'COMMITTED'; response: unknown };
    review: ReviewRecordSnapshot;
  }>;
  recoverDurableTransactions(
    paths: ReviewPersistencePaths,
    input: { review_id: string; idempotency_key: string; journal_scope?: 'START' | 'REVIEW' },
  ): Promise<{ state: 'COMMITTED'; response: unknown } | null>;
  recoverPendingReviewTransactions(
    paths: ReviewPersistencePaths,
  ): Promise<Array<{ state: 'COMMITTED'; response: unknown }>>;
  createReviewConsumptionEffect(input: {
    review_id: string;
    idempotency_key: string;
    kind: ReviewConsumptionKind;
    value: string;
    consumed_at: string;
  }): DurableEffect;
  readReviewConsumptionMarkers(
    paths: ReviewPersistencePaths,
    review_id: string,
  ): Promise<ReviewConsumptionMarker[]>;
  readReviewConsumptionGroups(
    paths: ReviewPersistencePaths,
    review_id: string,
  ): Promise<Array<{
    manifest: { idempotency_key: string; transaction_id: string; publication_count: number };
    markers: ReviewConsumptionMarker[];
  }>>;
}

interface FinalArtifactApi extends DurablePersistenceApi {
  writeFinalReviewArtifacts(
    paths: ReviewPersistencePaths,
    artifact: unknown,
    options?: { afterJsonPublished?: (jsonPath: string) => void | Promise<void> },
  ): Promise<{ jsonPath: string; markdownPath: string; artifact_sha256: string }>;
}

interface RenderApi {
  renderFinalReviewMarkdown(artifact: unknown): string;
}

async function loadPersistenceApi(): Promise<PersistenceApi> {
  const modulePath: string = '../persistence.js';
  const loaded = await import(modulePath).catch(() => null) as Partial<PersistenceApi> | null;
  assert.equal(
    typeof loaded?.resolveReviewPersistencePaths,
    'function',
    'expected code-review persistence paths to be implemented',
  );
  assert.equal(typeof loaded?.generateReviewId, 'function');
  assert.equal(typeof loaded?.claimActiveReview, 'function');
  assert.equal(typeof loaded?.readActiveReview, 'function');
  assert.equal(typeof loaded?.atomicWritePrivateJson, 'function');
  return loaded as PersistenceApi;
}

async function loadLockPersistenceApi(): Promise<LockPersistenceApi> {
  const loaded = await loadPersistenceApi() as Partial<LockPersistenceApi>;
  assert.equal(
    typeof loaded.acquireReviewLocks,
    'function',
    'expected ordered review persistence locks to be implemented',
  );
  assert.equal(typeof loaded.releaseReviewLocks, 'function');
  return loaded as LockPersistenceApi;
}

async function loadDurablePersistenceApi(): Promise<DurablePersistenceApi> {
  const loaded = await loadLockPersistenceApi() as Partial<DurablePersistenceApi>;
  assert.equal(
    typeof loaded.runDurableTransaction,
    'function',
    'expected durable review transactions to be implemented',
  );
  assert.equal(
    typeof loaded.runDurableReviewTransactionWithPlanFactory,
    'function',
    'expected a same-lock durable review plan factory to be implemented',
  );
  assert.equal(typeof loaded.recoverDurableTransactions, 'function');
  assert.equal(typeof loaded.createReviewConsumptionEffect, 'function');
  assert.equal(typeof loaded.readReviewConsumptionMarkers, 'function');
  assert.equal(typeof loaded.readReviewConsumptionGroups, 'function');
  assert.equal(typeof loaded.atomicCreatePrivateJson, 'function');
  return loaded as DurablePersistenceApi;
}

async function loadFinalArtifactApi(): Promise<{ persistence: FinalArtifactApi; render: RenderApi }> {
  const persistence = await loadDurablePersistenceApi() as Partial<FinalArtifactApi>;
  const modulePath: string = '../render.js';
  const render = await import(modulePath).catch(() => null) as Partial<RenderApi> | null;
  assert.equal(
    typeof persistence.writeFinalReviewArtifacts,
    'function',
    'expected atomic final review artifact persistence to be implemented',
  );
  assert.equal(typeof render?.renderFinalReviewMarkdown, 'function');
  return { persistence: persistence as FinalArtifactApi, render: render as RenderApi };
}

async function withWorkspace(run: (workingDirectory: string, api: PersistenceApi) => Promise<void>): Promise<void> {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'omx-code-review-persistence-'));
  try {
    await run(workingDirectory, await loadPersistenceApi());
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

describe('code-review persistence foundations', () => {
  it('resolves an explicit session authoritatively and otherwise uses the single root fallback', async () => {
    await withWorkspace(async (workingDirectory, api) => {
      const sessionId = '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2';
      const root = await api.resolveReviewPersistencePaths({ workingDirectory });
      const session = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });

      assert.equal(root.reviewRoot, join(workingDirectory, '.omx', 'state', 'code-review'));
      assert.equal(session.reviewRoot, join(
        workingDirectory,
        '.omx',
        'state',
        'sessions',
        sessionId,
        'code-review',
      ));
      assert.equal(root.activePath, join(root.reviewRoot, 'active.json'));
      assert.equal(session.activePath, join(session.reviewRoot, 'active.json'));
      assert.equal(root.reviewsRoot, join(workingDirectory, '.omx', 'reviews'));
      assert.equal(session.reviewsRoot, root.reviewsRoot);
    });
  });

  it('generates unique cryptographic UUID review ids without Math.random', async () => {
    const api = await loadPersistenceApi();
    const originalRandom = Math.random;
    Math.random = () => {
      throw new Error('Math.random must not be used for review ids');
    };
    try {
      const ids = Array.from({ length: 128 }, () => api.generateReviewId());
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      }
    } finally {
      Math.random = originalRandom;
    }
  });

  it('isolates simultaneous sessions while allowing only one active review in each scope', async () => {
    await withWorkspace(async (workingDirectory, api) => {
      const firstPaths = await api.resolveReviewPersistencePaths({
        workingDirectory,
        session_id: '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2',
      });
      const secondPaths = await api.resolveReviewPersistencePaths({
        workingDirectory,
        session_id: '031e48ec-ad76-4543-a61d-4b913456c390',
      });
      const firstReview = api.generateReviewId();
      const secondReview = api.generateReviewId();
      await Promise.all([
        api.claimActiveReview(firstPaths, { schema_version: 1, review_id: firstReview, status: 'REVIEWING' }),
        api.claimActiveReview(secondPaths, { schema_version: 1, review_id: secondReview, status: 'REVIEWING' }),
      ]);

      assert.equal((await api.readActiveReview(firstPaths))?.review_id, firstReview);
      assert.equal((await api.readActiveReview(secondPaths))?.review_id, secondReview);
      await assert.rejects(
        api.claimActiveReview(firstPaths, {
          schema_version: 1,
          review_id: api.generateReviewId(),
          status: 'REVIEWING',
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'REVIEW_ALREADY_ACTIVE',
      );
      assert.equal((await api.readActiveReview(firstPaths))?.review_id, firstReview);
    });
  });

  it('creates review state with owner-only directory and file permissions', async () => {
    if (process.platform === 'win32') return;
    await withWorkspace(async (workingDirectory, api) => {
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      await api.claimActiveReview(paths, {
        schema_version: 1,
        review_id: api.generateReviewId(),
        status: 'REVIEWING',
      });

      assert.equal((await stat(paths.reviewRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(paths.activePath)).mode & 0o777, 0o600);
    });
  });

  it('keeps the old JSON and removes the temporary file when atomic replace fails', async () => {
    await withWorkspace(async (workingDirectory, api) => {
      const target = join(workingDirectory, '.omx', 'state', 'atomic.json');
      await api.atomicWritePrivateJson(target, { revision: 1 });
      await assert.rejects(
        api.atomicWritePrivateJson(target, { revision: 2 }, {
          beforeRename: () => {
            throw new Error('injected rename boundary failure');
          },
        }),
        /injected rename boundary failure/u,
      );

      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { revision: 1 });
      assert.deepEqual((await readdir(join(workingDirectory, '.omx', 'state'))).filter((name) => name.includes('.tmp-')), []);
    });
  });
});

describe('code-review persistence locks', () => {
  it('places only start.lock at session root and derives review-scoped journal and mutation paths', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      assert.equal(typeof api.resolveReviewLockPaths, 'function');
      assert.deepEqual(api.resolveReviewLockPaths(paths, reviewId), {
        journalLockPath: join(paths.reviewRoot, reviewId, 'journal.lock'),
        mutationLockPath: join(paths.reviewRoot, reviewId, 'mutation.lock'),
      });
      assert.equal(paths.startLockPath, join(paths.reviewRoot, 'start.lock'));
    });
  });

  it('acquires requested locks in start -> journal -> mutation order and permits skipped locks', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'omx-code-review-locks-'));
    try {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const observed: ReviewLockName[] = [];
      const all = await api.acquireReviewLocks(paths, reviewId, ['mutation', 'start', 'journal'], {
        timeoutMs: 0,
        onAcquired: (name) => observed.push(name),
      });
      assert.deepEqual(observed, ['start', 'journal', 'mutation']);
      assert.deepEqual(all.map((handle) => handle.name), observed);
      assert.deepEqual(await api.releaseReviewLocks(all), [true, true, true]);

      const journalOnly = await api.acquireReviewLocks(paths, reviewId, ['journal'], { timeoutMs: 0 });
      assert.deepEqual(journalOnly.map((handle) => handle.name), ['journal']);
      await api.releaseReviewLocks(journalOnly);

      const withoutJournal = await api.acquireReviewLocks(paths, reviewId, ['mutation', 'start'], { timeoutMs: 0 });
      assert.deepEqual(withoutJournal.map((handle) => handle.name), ['start', 'mutation']);
      await api.releaseReviewLocks(withoutJournal);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('serves repeated twenty-way lock contention without starvation or remnants', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      for (let round = 0; round < 5; round += 1) {
        let start!: () => void;
        const barrier = new Promise<void>((resolve) => { start = resolve; });
        let active = 0;
        let maximumActive = 0;
        const startedAt = performance.now();
        const contenders = Array.from({ length: 20 }, async () => {
          await barrier;
          try {
            const handles = await api.acquireReviewLocks(paths, undefined, ['start']);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => setImmediate(resolve));
            active -= 1;
            await api.releaseReviewLocks(handles);
            return undefined;
          } catch (error) {
            return (error as { code?: unknown }).code;
          }
        });
        start();
        const outcomes = await Promise.all(contenders);
        const elapsedMs = performance.now() - startedAt;
        assert.deepEqual(outcomes.filter((outcome) => outcome !== undefined), [], `round ${round}`);
        assert.equal(maximumActive, 1, `round ${round}`);
        assert.ok(elapsedMs < 3_500, `round ${round} took ${elapsedMs}ms`);
        const remnants = (await readdir(paths.reviewRoot).catch(() => [])).filter((name) => (
          name.includes('.lock') || name.includes('.release-') || name.includes('.reap-') || name.includes('.tmp-')
        ));
        assert.deepEqual(remnants, [], `round ${round} remnants`);
      }
    });
  });

  it('reclaims only a parseable same-host lock whose PID is provably absent', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const staleNonce = api.generateReviewId();
      await api.atomicWritePrivateJson(paths.startLockPath, {
        pid: 999_999,
        hostname: hostname(),
        process_start_marker: 'old-process',
        nonce: staleNonce,
        acquired_at: '2026-07-14T00:00:00.000Z',
      });

      const handles = await api.acquireReviewLocks(paths, undefined, ['start'], {
        timeoutMs: 5_000,
        ownerProbe: () => 'absent',
      });
      assert.equal(handles.length, 1);
      assert.notEqual(handles[0]?.nonce, staleNonce);
      await api.releaseReviewLocks(handles);
    });
  });

  it('fails closed for live, reused, unknown, remote, empty, and malformed lock owners', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const localOwner = {
        pid: process.pid,
        hostname: hostname(),
        process_start_marker: 'marker',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      };
      const cases: Array<{
        content: string;
        probe: 'live' | 'reused' | 'unknown' | 'absent';
      }> = [
        { content: JSON.stringify(localOwner), probe: 'live' },
        { content: JSON.stringify(localOwner), probe: 'reused' },
        { content: JSON.stringify(localOwner), probe: 'unknown' },
        { content: JSON.stringify({ ...localOwner, hostname: 'remote.example' }), probe: 'absent' },
        { content: '', probe: 'absent' },
        { content: '{malformed', probe: 'absent' },
      ];

      for (const testCase of cases) {
        await api.atomicWritePrivateJson(paths.startLockPath, localOwner);
        await writeFile(paths.startLockPath, testCase.content, { mode: 0o600 });
        await assert.rejects(
          api.acquireReviewLocks(paths, undefined, ['start'], {
            timeoutMs: 0,
            ownerProbe: () => testCase.probe,
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
        );
        await rm(paths.startLockPath, { force: true });
      }
    });
  });

  it('caps observable lock waiting at five monotonic seconds', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      await api.atomicWritePrivateJson(paths.startLockPath, {
        pid: process.pid,
        hostname: hostname(),
        process_start_marker: 'live',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      });
      let monotonicNow = 0;
      let waits = 0;
      await assert.rejects(
        api.acquireReviewLocks(paths, undefined, ['start'], {
          timeoutMs: 60_000,
          now: () => monotonicNow,
          ownerProbe: () => 'live',
          waitForChange: (_path, remainingMs) => {
            waits += 1;
            monotonicNow += Math.min(1_000, remainingMs);
          },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
      );
      assert.equal(monotonicNow, 5_000);
      assert.equal(waits, 5);
    });
  });

  it('does not publish a lock after its monotonic deadline expires during the final wait', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      await api.atomicWritePrivateJson(paths.startLockPath, {
        pid: process.pid,
        hostname: hostname(),
        process_start_marker: 'live',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      });
      let monotonicNow = 0;
      let acquired = 0;

      await assert.rejects(
        api.acquireReviewLocks(paths, undefined, ['start'], {
          timeoutMs: 5_000,
          now: () => monotonicNow,
          ownerProbe: () => 'live',
          waitForChange: async () => {
            monotonicNow = 5_001;
            await rm(paths.startLockPath, { force: true });
          },
          onAcquired: () => { acquired += 1; },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
      );
      assert.equal(acquired, 0);
      await assert.rejects(
        stat(paths.startLockPath),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    });
  });

  it('never renames away a lock republished as live after the absent probe', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const staleOwner = {
        pid: 999_999,
        hostname: hostname(),
        process_start_marker: 'stale',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      };
      // A concurrent, legitimate reclaimer republishes a LIVE lock in the gap between our absent probe and
      // our reclaim of the stale owner.
      const liveOwner = {
        ...staleOwner,
        pid: process.pid,
        process_start_marker: 'live-replacement',
        nonce: api.generateReviewId(),
      };
      await api.atomicWritePrivateJson(paths.startLockPath, staleOwner);
      let afterRenameCalls = 0;

      await assert.rejects(
        api.acquireReviewLocks(paths, undefined, ['start'], {
          timeoutMs: 0,
          ownerProbe: async () => {
            await api.atomicWritePrivateJson(paths.startLockPath, liveOwner);
            return 'absent' as const;
          },
          afterReclaimRename: () => { afterRenameCalls += 1; },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
      );

      // ASSERTION-CHANGE-JUSTIFIED: the prior expectation let reclaimAbsentOwner rename away a lock that a
      // concurrent reclaimer had already republished as LIVE, opening an empty-path window a third acquirer
      // could win — two processes believing they hold the same lock, plus an orphaned lock file. Reclaim now
      // re-reads the on-disk nonce and refuses to touch a lock whose nonce no longer matches the probed-absent
      // owner, so the live lock is never renamed and no quarantine window is opened.
      assert.equal(afterRenameCalls, 0, 'a republished live lock is never renamed away');
      const published = JSON.parse(await readFile(paths.startLockPath, 'utf8')) as { nonce: string };
      assert.equal(published.nonce, liveOwner.nonce, 'the live lock stays intact at the canonical path');
      const quarantines = (await readdir(paths.reviewRoot)).filter((name) => name.includes('.reap-'));
      assert.equal(quarantines.length, 0, 'no quarantine is created and no empty-path window is opened');
    });
  });

  it('restores or preserves a quarantined lock when the on-disk nonce changes between re-read and rename', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      for (const restoration of ['SUCCEEDS', 'BLOCKED'] as const) {
        const sessionId = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        const staleOwner = {
          pid: 999_999,
          hostname: hostname(),
          process_start_marker: 'stale',
          nonce: api.generateReviewId(),
          acquired_at: '2026-07-14T00:00:00.000Z',
        };
        // The residual race: the stale nonce still matches at re-read, but a live owner republishes in the
        // tiny window before the rename. reclaim moves it, then detects the nonce mismatch and restores it
        // (SUCCEEDS) unless a new owner has since taken the path (BLOCKED), where it preserves the quarantine.
        const liveOwner = {
          ...staleOwner,
          pid: process.pid,
          process_start_marker: 'live-replacement',
          nonce: api.generateReviewId(),
        };
        const winnerOwner = {
          ...liveOwner,
          process_start_marker: 'winner',
          nonce: api.generateReviewId(),
        };
        await api.atomicWritePrivateJson(paths.startLockPath, staleOwner);
        let beforeRenameCalls = 0;

        await assert.rejects(
          api.acquireReviewLocks(paths, undefined, ['start'], {
            timeoutMs: 0,
            ownerProbe: () => 'absent' as const,
            beforeReclaimRename: async () => {
              beforeRenameCalls += 1;
              await api.atomicWritePrivateJson(paths.startLockPath, liveOwner);
            },
            ...(restoration === 'BLOCKED' ? {
              afterReclaimRename: async () => {
                await api.atomicWritePrivateJson(paths.startLockPath, winnerOwner);
              },
            } : {}),
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
          restoration,
        );
        assert.equal(beforeRenameCalls, 1, restoration);
        const published = JSON.parse(await readFile(paths.startLockPath, 'utf8')) as { nonce: string };
        assert.equal(
          published.nonce,
          restoration === 'SUCCEEDS' ? liveOwner.nonce : winnerOwner.nonce,
          restoration,
        );
        const quarantines = (await readdir(paths.reviewRoot)).filter((name) => name.includes('.reap-'));
        assert.equal(quarantines.length, restoration === 'SUCCEEDS' ? 0 : 1, restoration);
        if (restoration === 'BLOCKED') {
          const quarantined = JSON.parse(
            await readFile(join(paths.reviewRoot, quarantines[0]!), 'utf8'),
          ) as { nonce: string };
          assert.equal(quarantined.nonce, liveOwner.nonce);
        }
      }
    });
  });

  it('releases a lock only while the published owner nonce still matches', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const handles = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
      await api.atomicWritePrivateJson(paths.startLockPath, {
        pid: process.pid,
        hostname: hostname(),
        process_start_marker: 'replacement',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      });

      assert.deepEqual(await api.releaseReviewLocks(handles), [false]);
      assert.equal((await stat(paths.startLockPath)).isFile(), true);
    });
  });

  it('atomically quarantines release and preserves an owner replaced after the initial read', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const handles = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
      const replacementNonce = api.generateReviewId();

      const released = await api.releaseReviewLocks(handles, {
        afterOwnerRead: async () => {
          await api.atomicWritePrivateJson(paths.startLockPath, {
            pid: process.pid,
            hostname: hostname(),
            process_start_marker: 'replacement-marker',
            nonce: replacementNonce,
            acquired_at: '2026-07-14T00:00:00.000Z',
          });
        },
      });

      assert.deepEqual(released, [false]);
      const owner = JSON.parse(await readFile(paths.startLockPath, 'utf8')) as { nonce: string };
      assert.equal(owner.nonce, replacementNonce);
    });
  });

  it('classifies a real child marker as live, a forged marker as reused, and unavailable identity as unknown', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      assert.equal(typeof api.probeReviewLockOwner, 'function');
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const moduleUrl = new URL('../persistence.js', import.meta.url).href;
      const childProgram = `
        const persistence = await import(process.argv[1]);
        const paths = await persistence.resolveReviewPersistencePaths({
          workingDirectory: process.argv[2], session_id: process.argv[3],
        });
        await persistence.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
        process.stdout.write('ACQUIRED\\n');
        setInterval(() => undefined, 1000);
      `;
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory, sessionId,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await once(child.stdout!, 'data');
        const owner = JSON.parse(await readFile(paths.startLockPath, 'utf8')) as {
          pid: number;
          hostname: string;
          process_start_marker: string;
          nonce: string;
          acquired_at: string;
        };
        assert.equal(await api.probeReviewLockOwner(owner), 'live');
        assert.equal(await api.probeReviewLockOwner({
          ...owner,
          process_start_marker: `${owner.process_start_marker}-forged`,
        }), 'reused');
        assert.equal(await api.probeReviewLockOwner(owner, async () => null), 'unknown');
      } finally {
        child.kill('SIGTERM');
        await once(child, 'close');
      }
    });
  });

  it('orders hook-first and coordinator-first journal contention without reversing locks', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const hookFirst = await api.acquireReviewLocks(paths, reviewId, ['journal'], { timeoutMs: 0 });
      let releasedHook = false;
      const coordinator = await api.acquireReviewLocks(paths, reviewId, ['mutation', 'journal', 'start'], {
        timeoutMs: 5_000,
        waitForChange: async () => {
          if (!releasedHook) {
            releasedHook = true;
            await api.releaseReviewLocks(hookFirst);
          }
        },
      });
      assert.deepEqual(coordinator.map((handle) => handle.name), ['start', 'journal', 'mutation']);

      await assert.rejects(
        api.acquireReviewLocks(paths, reviewId, ['journal'], { timeoutMs: 0 }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
      );
      await api.releaseReviewLocks(coordinator);
      const hookAfter = await api.acquireReviewLocks(paths, reviewId, ['journal'], { timeoutMs: 0 });
      assert.equal(hookAfter.length, 1);
      await api.releaseReviewLocks(hookAfter);
    });
  });

  it('coordinates live and abandoned owners across real Node processes', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const moduleUrl = new URL('../persistence.js', import.meta.url).href;
      const childProgram = `
        const persistence = await import(process.argv[1]);
        const paths = await persistence.resolveReviewPersistencePaths({
          workingDirectory: process.argv[2], session_id: process.argv[3],
        });
        try {
          const handles = await persistence.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
          process.stdout.write('ACQUIRED');
          if (process.argv[4] === 'release') await persistence.releaseReviewLocks(handles);
        } catch (error) {
          process.stdout.write(String(error?.code ?? 'UNKNOWN'));
        }
      `;
      const parentHandles = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
      const liveAttempt = await execFileAsync(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory, sessionId, 'release',
      ]);
      assert.equal(liveAttempt.stdout, 'PERSISTENCE_LOCKED');
      await api.releaseReviewLocks(parentHandles);

      const abandoned = await execFileAsync(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory, sessionId, 'abandon',
      ]);
      assert.equal(abandoned.stdout, 'ACQUIRED');
      const recovered = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 5_000 });
      assert.equal(recovered.length, 1);
      await api.releaseReviewLocks(recovered);
    });
  });
});

const DURABLE_STAGES: readonly DurableStage[] = [
  'prepared',
  'locator',
  'proposal',
  'post-tool',
  'consume',
  'manifest',
  'lane',
  'review',
  'report',
  'active-overlay',
  'approval',
  'stop-marker',
  'committed',
  'locator-cleanup',
];

function reviewerResult(reviewId: string): Record<string, unknown> {
  return {
    role: 'code-reviewer',
    review_id: reviewId,
    attempt: 1,
    lane_id: 'reviewer-1',
    batch_id: 'batch-1',
    scope_hash: 'a'.repeat(64),
    recommendation: 'REQUEST CHANGES',
    findings: [],
    diagnostics: [],
  };
}

function reviewRecordPayload(reviewId: string, revision: number): Record<string, unknown> {
  const now = '2026-07-14T00:00:00.000Z';
  return {
    schema_version: 1,
    revision,
    review_id: reviewId,
    status: 'REVIEWING',
    current_attempt: 1,
    effective_config: {
      lane_timeout_ms: 30_000,
      max_files_per_review: 500,
      max_changed_lines_per_review: 50_000,
      accepted_equivalents: [],
    },
    review_flags: [],
    batches: [],
    lanes: [],
    attempt_history: [],
    diagnostics: [],
    resumable: false,
    created_at: now,
    updated_at: now,
  };
}

function trustedFactoryRevisionPlan(
  currentReview: ReviewRecordSnapshot,
  idempotencyKey: string,
): DurablePlan {
  const nextReview = structuredClone(currentReview);
  delete nextReview.last_applied_transaction_id;
  nextReview.revision += 1;
  return {
    journal_scope: 'REVIEW',
    idempotency_key: idempotencyKey,
    review_id: currentReview.review_id,
    operation: 'TRUSTED_FACTORY_REVISION',
    input: { review_id: currentReview.review_id, revision: currentReview.revision },
    expected_revision: currentReview.revision,
    effects: [{
      name: 'review',
      mode: 'APPLY_REVIEW_REVISION',
      target: { area: 'REVIEW_STATE', path: `${currentReview.review_id}/review.json` },
      payload: nextReview,
    }],
    response: { review_id: currentReview.review_id, revision: nextReview.revision },
  };
}

function diagnosticPayload(
  diagnosticId: string,
  summary: string,
  includeThreadId = false,
): Record<string, unknown> {
  return {
    diagnostic_id: diagnosticId,
    capability: 'LINT',
    applicability: 'APPLICABLE',
    execution: 'NATIVE',
    outcome: 'PASS',
    ...(includeThreadId ? { thread_id: 'reviewer-thread-1' } : {}),
    event_ref: `events/${diagnosticId}.json`,
    summary,
  };
}

function reviewScope(reason = 'Full scope was reviewed.'): Record<string, unknown> {
  return {
    selector: { explicit_paths: ['src/a.ts'] },
    status: 'FULL_SCOPE',
    scope_hash: 'a'.repeat(64),
    files: [{
      path: 'src/a.ts',
      change: 'MODIFIED',
      sources: ['WORKTREE'],
      binary: false,
      additions: 1,
      deletions: 0,
    }],
    changed_lines: 1,
    reasons: [reason],
  };
}

function reviewVerdict(reason = 'Review evidence is complete.'): Record<string, unknown> {
  return {
    recommendation: 'APPROVE',
    architectural_status: 'CLEAR',
    scope_status: 'FULL_SCOPE',
    evidence_status: 'FULL_EVIDENCE',
    rule_id: 'CLEAN_REVIEW',
    reasons: [reason],
    clean: true,
  };
}

function reviewRecordWithTopology(reviewId: string, revision: number): Record<string, unknown> {
  const now = '2026-07-14T00:00:00.000Z';
  return {
    ...reviewRecordPayload(reviewId, revision),
    scope: reviewScope(),
    batches: [{
      batch_id: 'batch-1',
      module_root: '.',
      files: ['src/a.ts'],
      changed_lines: 1,
      oversized_single_file: false,
    }],
    lanes: [{
      lane_id: 'reviewer-1',
      role: 'code-reviewer',
      batch_id: 'batch-1',
      scope_hash: 'a'.repeat(64),
      status: 'COMPLETE',
      attempt: 1,
      timeout_ms: 30_000,
      idle_deadline_at: now,
      recommendation: 'APPROVE',
      findings: [{
        severity: 'LOW',
        title: 'Scoped observation',
        body: 'The observation belongs to this batch.',
        file: 'src/a.ts',
        fix: 'Keep the observation in scope.',
      }],
      diagnostic_ids: ['diagnostic-1'],
    }, {
      lane_id: 'architect-1',
      role: 'architect',
      batch_id: 'global',
      scope_hash: 'a'.repeat(64),
      status: 'COMPLETE',
      attempt: 1,
      timeout_ms: 30_000,
      idle_deadline_at: now,
      architectural_status: 'CLEAR',
      findings: [],
      diagnostic_ids: [],
    }],
    diagnostics: [diagnosticPayload('diagnostic-1', 'Diagnostic passed.', true)],
  };
}

function durableEffects(
  reviewId: string,
  key: string,
  repositoryRoot: string,
  trust: { sessionId?: string; rootThreadId?: string } = {},
): DurableEffect[] {
  const now = '2026-07-14T00:00:00.000Z';
  const result = reviewerResult(reviewId);
  const sessionId = trust.sessionId ?? key;
  const rootThreadId = trust.rootThreadId ?? 'root-thread-1';
  const approvalNonce = `approval-${key}`;
  const approvalSourceRef = `explicit-${key}`;
  const report = sanitizeForPersistence(finalArtifact(reviewId, repositoryRoot), { repositoryRoot });
  const typedConsumption = (kind: ReviewConsumptionKind, value: string): DurableEffect => {
    const digest = createHash('sha256')
      .update('omx-code-review-consumption\0', 'utf8')
      .update(kind, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex');
    const directory = { PROPOSAL_KEY: 'proposal-key', TOOL_EVENT_REF: 'tool-event-ref', NONCE: 'nonce' }[kind];
    return {
      name: 'consume', mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/consumptions/${directory}/${digest}.json` },
      payload: {
        schema_version: 1, state: 'CONSUMED', review_id: reviewId, kind,
        value_sha256: digest, idempotency_key: key, consumed_at: now,
      },
    };
  };
  return [
    {
      name: 'proposal',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/proposal` },
      payload: {
        schema_version: 1,
        state: 'PENDING_HOST_ATTESTATION',
        review_id: reviewId,
        attempt: 1,
        lane_id: 'reviewer-1',
        scope_hash: 'a'.repeat(64),
        idempotency_key: key,
        payload_digest: 'b'.repeat(64),
        result,
        proposed_at: now,
      },
    },
    {
      name: 'post-tool',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/post-tool` },
      payload: {
        schema_version: 1,
        publication_id: key,
        published_at: now,
        activity: {
          schema_version: 1,
          session_id: sessionId,
          review_id: reviewId,
          attempt: 1,
          lane_id: 'reviewer-1',
          child_thread_id: 'child-thread-1',
          event_ref: 'events/result-post-tool-1.json',
          event_kind: 'RESULT_POST_TOOL',
          observed_at: now,
        },
        attestation: {
          schema_version: 1,
          session_id: sessionId,
          root_thread_id: rootThreadId,
          review_id: reviewId,
          attempt: 1,
          lane_id: 'reviewer-1',
          child_thread_id: 'child-thread-1',
          scope_hash: 'a'.repeat(64),
          payload_digest: 'b'.repeat(64),
          tool_event_ref: 'events/result-post-tool-1.json',
          nonce: key,
          published_at: now,
        },
      },
    },
    {
      name: 'consume',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/consumed` },
      payload: {
        schema_version: 1,
        state: 'CONSUMED',
        review_id: reviewId,
        idempotency_key: key,
        consumed_at: now,
      },
    },
    {
      name: 'lane',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/lanes/reviewer-1-attempt-1/terminal` },
      payload: {
        event: 'RESULT',
        review_id: reviewId,
        attempt: 1,
        lane_id: 'reviewer-1',
        scope_hash: 'a'.repeat(64),
        result,
        idempotency_key: key,
      },
    },
    {
      name: 'review',
      mode: 'APPLY_REVIEW_REVISION',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
      payload: {
        ...reviewRecordPayload(reviewId, 2),
        effective_config: {
          lane_timeout_ms: 30_000,
          max_files_per_review: 500,
          max_changed_lines_per_review: 50_000,
          accepted_equivalents: [{
            capability: 'AST', source: 'EXPLICIT_USER', source_ref: approvalSourceRef,
            program: 'node', args: ['scripts/ast-check.mjs'],
          }],
        },
        status: 'FINALIZED',
        scope: reviewScope(),
        batches: [{
          batch_id: 'batch-1', module_root: '.', files: ['src/a.ts'],
          changed_lines: 1, oversized_single_file: false,
        }],
        lanes: [{
          lane_id: 'reviewer-1', role: 'code-reviewer', batch_id: 'batch-1',
          scope_hash: 'a'.repeat(64), status: 'COMPLETE', attempt: 1,
          timeout_ms: 30_000, idle_deadline_at: now, recommendation: 'REQUEST CHANGES',
          findings: [], diagnostic_ids: [],
        }],
        ...(trust.sessionId === undefined ? {} : { session_id: sessionId }),
        ...(trust.rootThreadId === undefined ? {} : { root_thread_id: rootThreadId }),
      },
    },
    {
      name: 'report',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'FINAL_REVIEWS', path: `${reviewId}.json` },
      payload: report,
    },
    {
      name: 'active-overlay',
      mode: 'REMOVE_MATCHING_ACTIVE',
      target: { area: 'REVIEW_STATE', path: 'active.json' },
      review_id: reviewId,
      expected_status: 'READY_TO_SYNTHESIZE',
      expected_revision: 1,
    },
    {
      name: 'approval',
      mode: 'CREATE_ONCE_JSON',
      target: {
        area: 'REVIEW_STATE',
        path: `approvals/consumptions/${createHash('sha256').update(approvalNonce).digest('hex')}.json`,
      },
      payload: {
        schema_version: 1,
        state: 'COMMITTED',
        nonce: approvalNonce,
        review_id: reviewId,
        capability: 'AST',
        source_ref: approvalSourceRef,
        prepared_at: now,
        committed_at: now,
      },
    },
    {
      name: 'stop-marker',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: 'stop-terminal-brief.json' },
      // ASSERTION-CHANGE-JUSTIFIED: Stop evidence now binds the exact session/root and final artifact digest.
      payload: {
        schema_version: 1,
        state: 'PENDING_BRIEF',
        session_id: sessionId,
        review_id: reviewId,
        root_thread_id: rootThreadId,
        artifact_sha256: createHash('sha256').update(`${JSON.stringify(report, null, 2)}\n`).digest('hex'),
        verdict: 'REQUEST CHANGES',
        issued_stop_signature: 'A'.repeat(43),
        issued_at: now,
      },
    },
    typedConsumption('PROPOSAL_KEY', key),
    typedConsumption('TOOL_EVENT_REF', 'events/result-post-tool-1.json'),
    typedConsumption('NONCE', key),
  ];
}

function reviewEffectWithoutExplicitApproval(effect: DurableEffect): DurableEffect {
  const output = structuredClone(effect);
  const payload = output.payload as Record<string, unknown>;
  const effectiveConfig = payload.effective_config as Record<string, unknown>;
  payload.effective_config = { ...effectiveConfig, accepted_equivalents: [] };
  return output;
}

function consumedPublicationPlan(
  api: DurablePersistenceApi,
  reviewId: string,
  transactionKey: string,
  publicationKey: string,
  workingDirectory: string,
  sessionId: string,
): DurablePlan {
  const now = '2026-07-14T00:00:00.000Z';
  const complete = durableEffects(reviewId, publicationKey, workingDirectory, {
    sessionId, rootThreadId: 'root-thread-1',
  });
  const publication = complete[1]!.payload as any;
  const markers = ([
    ['PROPOSAL_KEY', publicationKey],
    ['TOOL_EVENT_REF', publication.attestation.tool_event_ref],
    ['NONCE', publication.attestation.nonce],
  ] as const).map(([kind, value]) => api.createReviewConsumptionEffect({
    review_id: reviewId,
    idempotency_key: transactionKey,
    kind,
    value,
    consumed_at: now,
  }));
  return {
    idempotency_key: transactionKey,
    review_id: reviewId,
    operation: 'CONSUME_BOUND_PUBLICATION',
    input: { review_id: reviewId, publication_id: publicationKey },
    expected_revision: 1,
    effects: [...complete.slice(0, 2), ...markers, {
      name: 'review', mode: 'APPLY_REVIEW_REVISION',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
      payload: {
        ...(reviewEffectWithoutExplicitApproval(complete[4]!).payload as Record<string, unknown>),
        status: 'REVIEWING',
        session_id: sessionId,
        root_thread_id: 'root-thread-1',
      },
    }],
    response: { review_id: reviewId, revision: 2, publication_id: publicationKey },
  };
}

function isAbruptChildExit(error: unknown): boolean {
  const candidate = error as { signal?: unknown; code?: unknown };
  return (typeof candidate.signal === 'string' && candidate.signal.length > 0)
    || (typeof candidate.code === 'number' && candidate.code > 1);
}

function isAbruptClose(exitCode: unknown, signal: unknown): boolean {
  return (typeof signal === 'string' && signal.length > 0)
    || (typeof exitCode === 'number' && exitCode > 1);
}

async function runAbruptTransaction(
  workingDirectory: string,
  sessionId: string,
  plan: DurablePlan,
  crashAt: DurableBoundary,
): Promise<void> {
  const moduleUrl = new URL('../persistence.js', import.meta.url).href;
  const program = `
    const persistence = await import(process.argv[1]);
    const paths = await persistence.resolveReviewPersistencePaths({
      workingDirectory: process.argv[2], session_id: process.argv[3],
    });
    await persistence.runDurableTransaction(paths, JSON.parse(process.argv[4]), {
      crashAt: process.argv[5], crashMode: 'ABORT',
    });
  `;
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--input-type=module', '-e', program, moduleUrl, workingDirectory,
      sessionId, JSON.stringify(plan), crashAt,
    ]),
    isAbruptChildExit,
  );
}

async function runAbruptFactoryTransaction(
  workingDirectory: string,
  sessionId: string,
  rootThreadId: string,
  plan: DurablePlan,
): Promise<void> {
  const moduleUrl = new URL('../persistence.js', import.meta.url).href;
  const program = `
    const persistence = await import(process.argv[1]);
    const paths = await persistence.resolveReviewPersistencePaths({
      workingDirectory: process.argv[2], session_id: process.argv[3],
    });
    const plan = JSON.parse(process.argv[5]);
    await persistence.runDurableReviewTransactionWithPlanFactory(paths, {
      review_id: plan.review_id,
      session_id: process.argv[3],
      root_thread_id: process.argv[4],
      plan_factory: async () => plan,
    }, { crashAt: 'after:prepared', crashMode: 'ABORT' });
  `;
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--input-type=module', '-e', program, moduleUrl, workingDirectory,
      sessionId, rootThreadId, JSON.stringify(plan),
    ]),
    isAbruptChildExit,
  );
}

describe('code-review durable transaction journal', () => {
  it('uses only start.lock for START and leaves no journal, revision, or effect when a review lock is held', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const startReviewId = api.generateReviewId();
      const startKey = api.generateReviewId();
      const legacyRootJournalPath = join(paths.reviewRoot, 'journal.lock');
      await api.atomicWritePrivateJson(legacyRootJournalPath, {
        pid: process.pid,
        hostname: hostname(),
        process_start_marker: 'legacy-root-owner',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      });
      try {
        const startResult = await api.runDurableTransaction(paths, {
          journal_scope: 'START',
          idempotency_key: startKey,
          review_id: startReviewId,
          operation: 'START_WITH_SKIPPED_REVIEW_LOCKS',
          input: { review_id: startReviewId },
          expected_revision: 0,
          effects: [{
            name: 'review',
            mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${startReviewId}/review.json` },
            payload: reviewRecordPayload(startReviewId, 1),
          }],
          response: { review_id: startReviewId },
        });
        assert.equal(startResult.state, 'COMMITTED');
      } finally {
        await rm(legacyRootJournalPath, { force: true });
      }

      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const scoped = api.resolveReviewLockPaths(paths, reviewId);
      await api.atomicWritePrivateJson(scoped.journalLockPath, {
        pid: process.pid,
        hostname: hostname(),
        process_start_marker: 'live-review-owner',
        nonce: api.generateReviewId(),
        acquired_at: '2026-07-14T00:00:00.000Z',
      });
      await assert.rejects(
        api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'BLOCKED_REVIEW',
          input: { review_id: reviewId },
          expected_revision: 0,
          effects: [{
            name: 'proposal',
            mode: 'CREATE_ONCE_JSON',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/proposal` },
            payload: { state: 'PENDING_HOST_ATTESTATION' },
          }],
          response: { review_id: reviewId },
        }, { crashAt: undefined }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
      );
      for (const forbiddenPath of [
        join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'),
        join(paths.reviewRoot, reviewId, 'submissions', key, 'proposal'),
        join(paths.reviewRoot, reviewId, 'review.json'),
      ]) {
        await assert.rejects(readFile(forbiddenPath, 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));
      }

      const gatedReviewId = api.generateReviewId();
      const gatedKey = api.generateReviewId();
      const gatedEffect = durableEffects(gatedReviewId, gatedKey, workingDirectory)[2]!;
      const startGate = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
      try {
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: gatedKey,
          review_id: gatedReviewId,
          operation: 'RECOVERY_SCAN_REQUIRES_START_LOCK',
          input: { review_id: gatedReviewId },
          expected_revision: 0,
          effects: [gatedEffect],
          response: { ok: true },
        }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED');
        await assert.rejects(
          readFile(join(paths.reviewRoot, gatedEffect.target.path), 'utf8'),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      } finally {
        await api.releaseReviewLocks(startGate);
      }
    });
  });

  it('automatically discovers and recovers crashed A before applying unrelated mutation B', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      assert.equal(typeof api.recoverPendingReviewTransactions, 'function');
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const firstKey = api.generateReviewId();
      const secondKey = api.generateReviewId();
      const firstEffect = durableEffects(reviewId, firstKey, workingDirectory)[0]!;
      const secondEffect = durableEffects(reviewId, secondKey, workingDirectory)[2]!;
      const firstEffectPath = firstEffect.target.path;

      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: firstKey,
        review_id: reviewId,
        operation: 'CRASHED_A',
        input: { sequence: 'A' },
        expected_revision: 0,
        effects: [firstEffect],
        response: { sequence: 'A' },
      }, { crashAt: 'after:locator' }), /injected crash/u);

      const second = await api.runDurableTransaction(paths, {
        idempotency_key: secondKey,
        review_id: reviewId,
        operation: 'MUTATION_B',
        input: { sequence: 'B' },
        expected_revision: 0,
        effects: [secondEffect],
        response: { sequence: 'B' },
      });

      assert.deepEqual(second, { state: 'COMMITTED', response: { sequence: 'B' } });
      assert.deepEqual(
        JSON.parse(await readFile(join(paths.reviewRoot, firstEffectPath), 'utf8')),
        firstEffect.payload,
      );
      await readFile(join(paths.reviewRoot, reviewId, 'transactions', firstKey, 'committed'), 'utf8');
      assert.deepEqual(await readdir(paths.pendingReviewTransactionsRoot).catch(() => []), []);
    });
  });

  it('takes the root start gate before direct REVIEW recovery and leaves prepared state untouched when blocked', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      const stopPath = join(paths.reviewRoot, 'stop-terminal-brief.json');
      const trust = { sessionId: key, rootThreadId: 'root-thread-1' };
      await api.atomicWritePrivateJson(reviewPath, {
        ...reviewRecordPayload(reviewId, 1),
        session_id: trust.sessionId,
        root_thread_id: trust.rootThreadId,
      });
      const effects = durableEffects(reviewId, key, workingDirectory, trust);
      const plan: DurablePlan = {
        journal_scope: 'REVIEW',
        idempotency_key: key,
        review_id: reviewId,
        operation: 'DIRECT_REVIEW_RECOVERY_REQUIRES_START_GATE',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [
          reviewEffectWithoutExplicitApproval(effects[4]!),
          effects[5]!,
          effects[8]!,
        ],
        response: { review_id: reviewId, revision: 2 },
      };
      await assert.rejects(
        api.runDurableTransaction(paths, plan, { crashAt: 'after:locator' }),
        /injected crash/u,
      );
      const preparedPath = join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared');
      const preparedBefore = await readFile(preparedPath, 'utf8');
      const startGate = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
      try {
        await assert.rejects(
          api.recoverDurableTransactions(paths, {
            journal_scope: 'REVIEW', review_id: reviewId, idempotency_key: key,
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
        );
        assert.equal(await readFile(preparedPath, 'utf8'), preparedBefore);
        assert.equal((JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number }).revision, 1);
        await assert.rejects(readFile(stopPath, 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));
      } finally {
        await api.releaseReviewLocks(startGate);
      }
    });
  });

  it('rejects marker-only payloads for typed proposal, post-tool, lane, approval, and Stop effects', async () => {
    const cases: Array<{
      name: DurableEffect['name'];
      path: (reviewId: string, key: string) => string;
      payload: (reviewId: string, key: string) => unknown;
    }> = [
      { name: 'proposal', path: (reviewId, key) => `${reviewId}/submissions/${key}/proposal`, payload: () => ({ state: 'PENDING_HOST_ATTESTATION' }) },
      { name: 'post-tool', path: (reviewId, key) => `${reviewId}/submissions/${key}/post-tool`, payload: (_reviewId, key) => ({ publication_id: key }) },
      { name: 'lane', path: (reviewId) => `${reviewId}/lanes/reviewer-attempt-1/terminal`, payload: () => ({ status: 'COMPLETE' }) },
      {
        name: 'approval',
        path: (_reviewId, key) => `approvals/consumptions/${createHash('sha256').update(key).digest('hex')}.json`,
        payload: () => ({ consumed: true }),
      },
      { name: 'stop-marker', path: () => 'stop-terminal-brief.json', payload: () => ({ state: 'PENDING_BRIEF' }) },
    ];
    for (const testCase of cases) {
      await withWorkspace(async (workingDirectory) => {
        const api = await loadDurablePersistenceApi();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const target = testCase.path(reviewId, key);
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: `INVALID_${testCase.name}`,
          input: { effect: testCase.name },
          expected_revision: 0,
          effects: [{
            name: testCase.name,
            mode: 'CREATE_ONCE_JSON',
            target: { area: 'REVIEW_STATE', path: target },
            payload: testCase.payload(reviewId, key),
          }],
          response: { ok: false },
        }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED', testCase.name);
        await assert.rejects(readFile(join(paths.reviewRoot, target), 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));
      });
    }
  });

  it('binds post-tool activity and attestation identity to the persistence scope and current review', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const rootThreadId = 'root-thread-a';
      const makePlan = (
        reviewId: string,
        key: string,
        sessionId: string,
      ): DurablePlan => {
        const complete = durableEffects(reviewId, key, workingDirectory);
        const effects = structuredClone([
          ...complete.slice(0, 2),
          ...complete.slice(-3),
        ]) as any[];
        effects[1].payload.activity.session_id = sessionId;
        effects[1].payload.attestation.session_id = sessionId;
        effects[1].payload.attestation.root_thread_id = rootThreadId;
        effects.push({
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...(reviewEffectWithoutExplicitApproval(complete[4]!).payload as Record<string, unknown>),
            session_id: sessionId,
            root_thread_id: rootThreadId,
          },
        });
        return {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'TRUST_BOUND_POST_TOOL',
          input: { review_id: reviewId },
          expected_revision: 1,
          effects,
          response: { review_id: reviewId, revision: 2 },
        };
      };
      const cases: Array<{
        label: string;
        mutate: (plan: any, different: string) => void;
      }> = [
        {
          label: 'activity session differs from authoritative paths',
          mutate: (plan, different) => { plan.effects[1].payload.activity.session_id = different; },
        },
        {
          label: 'attestation session differs from authoritative paths',
          mutate: (plan, different) => { plan.effects[1].payload.attestation.session_id = different; },
        },
        {
          label: 'attestation root thread differs from current review',
          mutate: (plan) => { plan.effects[1].payload.attestation.root_thread_id = 'root-thread-c'; },
        },
        {
          label: 'child identity exceeds its bound',
          mutate: (plan) => {
            plan.effects[1].payload.activity.child_thread_id = 'x'.repeat(1_025);
            plan.effects[1].payload.attestation.child_thread_id = 'x'.repeat(1_025);
          },
        },
        {
          label: 'attestation nonce is nonprimitive',
          mutate: (plan) => { plan.effects[1].payload.attestation.nonce = { unsafe: true }; },
        },
        {
          label: 'attestation digest differs from proposal',
          mutate: (plan) => { plan.effects[1].payload.attestation.payload_digest = 'c'.repeat(64); },
        },
        {
          label: 'publication identity differs from transaction',
          mutate: (plan, different) => { plan.effects[1].payload.publication_id = different; },
        },
      ];
      const accepted: string[] = [];

      for (const testCase of cases) {
        const sessionId = api.generateReviewId();
        const different = api.generateReviewId();
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.atomicWritePrivateJson(reviewPath, {
          ...reviewRecordPayload(reviewId, 1),
          session_id: sessionId,
          root_thread_id: rootThreadId,
        });
        const plan = makePlan(reviewId, key, sessionId);
        testCase.mutate(plan, different);
        try {
          await api.runDurableTransaction(paths, plan);
          accepted.push(testCase.label);
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', testCase.label);
        }
        if (!accepted.includes(testCase.label)) {
          assert.equal((JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number }).revision, 1);
          for (const path of [
            join(paths.reviewRoot, reviewId, 'submissions', key, 'proposal'),
            join(paths.reviewRoot, reviewId, 'submissions', key, 'post-tool'),
            join(paths.reviewRoot, reviewId, 'submissions', key, 'consumed'),
            join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'),
            join(paths.reviewRoot, reviewId, 'transactions', key, 'committed'),
          ]) {
            await assert.rejects(readFile(path, 'utf8'), (error: unknown) => (
              (error as NodeJS.ErrnoException).code === 'ENOENT'
            ));
          }
        }
      }

      const recoverySessionId = api.generateReviewId();
      const recoveryReviewId = api.generateReviewId();
      const recoveryKey = api.generateReviewId();
      const recoveryPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: recoverySessionId,
      });
      await api.claimActiveReview(recoveryPaths, {
        schema_version: 1, review_id: recoveryReviewId, status: 'REVIEWING',
      });
      const recoveryReviewPath = join(recoveryPaths.reviewRoot, recoveryReviewId, 'review.json');
      await api.atomicWritePrivateJson(recoveryReviewPath, {
        ...reviewRecordPayload(recoveryReviewId, 1),
        session_id: recoverySessionId,
        root_thread_id: rootThreadId,
      });
      await assert.rejects(
        api.runDurableTransaction(
          recoveryPaths,
          makePlan(recoveryReviewId, recoveryKey, recoverySessionId),
          { crashAt: 'after:prepared' },
        ),
        /injected crash/u,
      );
      await api.atomicWritePrivateJson(recoveryReviewPath, {
        ...reviewRecordPayload(recoveryReviewId, 1),
        session_id: recoverySessionId,
        root_thread_id: 'root-thread-c',
      });
      try {
        await api.recoverPendingReviewTransactions(recoveryPaths);
        accepted.push('prepared recovery root thread differs from current review');
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED');
      }
      assert.equal(
        (JSON.parse(await readFile(recoveryReviewPath, 'utf8')) as { revision: number }).revision,
        1,
      );
      for (const path of [
        join(recoveryPaths.reviewRoot, recoveryReviewId, 'submissions', recoveryKey, 'proposal'),
        join(recoveryPaths.reviewRoot, recoveryReviewId, 'submissions', recoveryKey, 'post-tool'),
        join(recoveryPaths.reviewRoot, recoveryReviewId, 'submissions', recoveryKey, 'consumed'),
        join(recoveryPaths.reviewRoot, recoveryReviewId, 'transactions', recoveryKey, 'committed'),
      ]) {
        await assert.rejects(readFile(path, 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));
      }

      assert.deepEqual(accepted, [], `accepted untrusted post-tool identity: ${JSON.stringify(accepted)}`);

      const rootPaths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const rootReviewId = api.generateReviewId();
      const rootKey = api.generateReviewId();
      const internalSessionId = api.generateReviewId();
      await api.claimActiveReview(rootPaths, {
        schema_version: 1, review_id: rootReviewId, status: 'REVIEWING',
      });
      await api.atomicWritePrivateJson(
        join(rootPaths.reviewRoot, rootReviewId, 'review.json'),
        {
          ...reviewRecordPayload(rootReviewId, 1),
          session_id: internalSessionId,
          root_thread_id: rootThreadId,
        },
      );
      assert.deepEqual(await api.runDurableTransaction(
        rootPaths,
        makePlan(rootReviewId, rootKey, internalSessionId),
      ), {
        state: 'COMMITTED', response: { review_id: rootReviewId, revision: 2 },
      });

      await rm(rootPaths.activePath, { force: true });
      const boundRootReviewId = api.generateReviewId();
      const boundRootKey = api.generateReviewId();
      const boundSessionId = api.generateReviewId();
      await api.claimActiveReview(rootPaths, {
        schema_version: 1, review_id: boundRootReviewId, status: 'REVIEWING',
      });
      await api.atomicWritePrivateJson(
        join(rootPaths.reviewRoot, boundRootReviewId, 'review.json'),
        {
          ...reviewRecordPayload(boundRootReviewId, 1),
          session_id: boundSessionId,
          root_thread_id: rootThreadId,
        },
      );
      const rootConflict = makePlan(boundRootReviewId, boundRootKey, boundSessionId) as any;
      rootConflict.effects[1].payload.attestation.root_thread_id = 'root-thread-c';
      await assert.rejects(
        api.runDurableTransaction(rootPaths, rootConflict),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
    });
  });

  it('rejects a review revision that rewrites ownership after valid post-tool evidence', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const differentSessionId = api.generateReviewId();
      const rootThreadId = 'root-thread-a';
      const differentRootThreadId = 'root-thread-b';
      const invocationTurnId = 'invocation-turn-a';
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      await api.claimActiveReview(paths, {
        schema_version: 1, review_id: reviewId, status: 'REVIEWING',
      });
      await api.atomicWritePrivateJson(reviewPath, {
        ...reviewRecordPayload(reviewId, 1),
        session_id: sessionId,
        root_thread_id: rootThreadId,
        invocation_turn_id: invocationTurnId,
      });
      const effects = structuredClone(
        durableEffects(reviewId, key, workingDirectory, { sessionId, rootThreadId }).slice(0, 3),
      ) as DurableEffect[];
      effects.push({
        name: 'review',
        mode: 'APPLY_REVIEW_REVISION',
        target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
        payload: {
          ...reviewRecordPayload(reviewId, 2),
          session_id: differentSessionId,
          root_thread_id: differentRootThreadId,
          invocation_turn_id: invocationTurnId,
        },
      });

      let outcome = 'ACCEPTED';
      try {
        await api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'IMMUTABLE_REVIEW_OWNERSHIP',
          input: { review_id: reviewId },
          expected_revision: 1,
          effects,
          response: { review_id: reviewId, revision: 2 },
        });
      } catch (error) {
        outcome = String((error as { code?: unknown }).code);
      }
      const persisted = JSON.parse(await readFile(reviewPath, 'utf8')) as {
        revision: number;
        session_id?: string;
        root_thread_id?: string;
      };
      const published: string[] = [];
      for (const [label, path] of [
        ['prepared', join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared')],
        ['proposal', join(paths.reviewRoot, reviewId, 'submissions', key, 'proposal')],
        ['post-tool', join(paths.reviewRoot, reviewId, 'submissions', key, 'post-tool')],
        ['consumed', join(paths.reviewRoot, reviewId, 'submissions', key, 'consumed')],
        ['committed', join(paths.reviewRoot, reviewId, 'transactions', key, 'committed')],
      ] as const) {
        try {
          await readFile(path, 'utf8');
          published.push(label);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      assert.deepEqual({
        outcome,
        revision: persisted.revision,
        session_id: persisted.session_id,
        root_thread_id: persisted.root_thread_id,
        published,
      }, {
        outcome: 'PERSISTENCE_FAILED',
        revision: 1,
        session_id: sessionId,
        root_thread_id: rootThreadId,
        published: [],
      });
    });
  });

  it('keeps review ownership immutable across revisions and binds new reviews to their scope', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const accepted: string[] = [];
      const ownership = {
        session_id: api.generateReviewId(),
        root_thread_id: 'root-thread-a',
        invocation_turn_id: 'invocation-turn-a',
      };
      const replacements = {
        session_id: api.generateReviewId(),
        root_thread_id: 'root-thread-b',
        invocation_turn_id: 'invocation-turn-b',
      };

      for (const field of ['session_id', 'root_thread_id', 'invocation_turn_id'] as const) {
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: ownership.session_id,
        });
        await api.atomicWritePrivateJson(
          join(paths.reviewRoot, reviewId, 'review.json'),
          { ...reviewRecordPayload(reviewId, 1), ...ownership },
        );
        try {
          await api.runDurableTransaction(paths, {
            idempotency_key: key,
            review_id: reviewId,
            operation: 'IMMUTABLE_REVIEW_OWNERSHIP_FIELD',
            input: { field },
            expected_revision: 1,
            effects: [{
              name: 'review',
              mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: {
                ...reviewRecordPayload(reviewId, 2),
                ...ownership,
                [field]: replacements[field],
              },
            }],
            response: { review_id: reviewId },
          });
          accepted.push(`revision:${field}`);
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', field);
        }
      }

      const creationReviewId = api.generateReviewId();
      const creationKey = api.generateReviewId();
      const creationPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: ownership.session_id,
      });
      try {
        await api.runDurableTransaction(creationPaths, {
          idempotency_key: creationKey,
          review_id: creationReviewId,
          operation: 'CREATE_WITH_FOREIGN_SESSION',
          input: { review_id: creationReviewId },
          expected_revision: 0,
          effects: [{
            name: 'review',
            mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${creationReviewId}/review.json` },
            payload: {
              ...reviewRecordPayload(creationReviewId, 1),
              ...ownership,
              session_id: replacements.session_id,
            },
          }],
          response: { review_id: creationReviewId },
        });
        accepted.push('creation:paths');
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED');
      }

      const publicationReviewId = api.generateReviewId();
      const publicationKey = api.generateReviewId();
      const publicationPaths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const publicationEffects = structuredClone(durableEffects(
        publicationReviewId,
        publicationKey,
        workingDirectory,
        { sessionId: ownership.session_id, rootThreadId: ownership.root_thread_id },
      ).slice(0, 2)) as DurableEffect[];
      publicationEffects.push({
        name: 'review',
        mode: 'APPLY_REVIEW_REVISION',
        target: { area: 'REVIEW_STATE', path: `${publicationReviewId}/review.json` },
        payload: {
          ...reviewRecordPayload(publicationReviewId, 1),
          ...ownership,
          session_id: replacements.session_id,
          root_thread_id: replacements.root_thread_id,
        },
      });
      try {
        await api.runDurableTransaction(publicationPaths, {
          idempotency_key: publicationKey,
          review_id: publicationReviewId,
          operation: 'CREATE_WITH_FOREIGN_PUBLICATION',
          input: { review_id: publicationReviewId },
          expected_revision: 0,
          effects: publicationEffects,
          response: { review_id: publicationReviewId },
        });
        accepted.push('creation:publication');
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED');
      }

      assert.deepEqual(accepted, [], `accepted mutable review ownership: ${JSON.stringify(accepted)}`);
    });
  });

  it('rejects minimal, mismatched, enum-invalid, and revision-conflicting review payloads before journaling', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const cases = [
        {
          label: 'marker',
          payload: (_reviewId: string) => ({ marker: 'review' }),
        },
        {
          label: 'minimal',
          payload: (reviewId: string) => ({
            schema_version: 1, revision: 1, review_id: reviewId, status: 'REVIEWING',
          }),
        },
        {
          label: 'mismatched review_id',
          payload: (_reviewId: string) => reviewRecordPayload(api.generateReviewId(), 1),
        },
        {
          label: 'unknown status',
          payload: (reviewId: string) => ({ ...reviewRecordPayload(reviewId, 1), status: 'UNKNOWN' }),
        },
        {
          label: 'revision mismatch',
          payload: (reviewId: string) => reviewRecordPayload(reviewId, 2),
        },
      ];
      const accepted: string[] = [];

      for (const testCase of cases) {
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        let rejected = false;
        try {
          await api.runDurableTransaction(paths, {
            idempotency_key: key,
            review_id: reviewId,
            operation: `INVALID_REVIEW_${testCase.label}`,
            input: { label: testCase.label },
            expected_revision: 0,
            effects: [{
              name: 'review',
              mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: testCase.payload(reviewId),
            }],
            response: { ok: false },
          });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', testCase.label);
          rejected = true;
        }
        if (!rejected) {
          accepted.push(testCase.label);
          continue;
        }
        for (const path of [
          join(paths.reviewRoot, reviewId, 'review.json'),
          join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'),
          join(paths.reviewRoot, reviewId, 'transactions', key, 'committed'),
        ]) {
          await assert.rejects(readFile(path, 'utf8'), (error: unknown) => (
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          ));
        }
      }
      assert.deepEqual(accepted, [], `accepted invalid review payloads: ${accepted.join(', ')}`);
    });
  });

  it('strictly rejects malformed and enum-invalid active-overlay create payloads', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const invalidPayloads: Array<readonly [string, unknown]> = [
        ['marker', { marker: 'active' }],
        ['unknown status', { schema_version: 1, review_id: reviewId, status: 'UNKNOWN' }],
        ['unknown field', { schema_version: 1, review_id: reviewId, status: 'CREATED', unknown: true }],
      ];
      const accepted: string[] = [];
      for (const [label, payload] of invalidPayloads) {
        const key = api.generateReviewId();
        const isolatedPaths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: key,
        });
        let rejected = false;
        try {
          await api.runDurableTransaction(isolatedPaths, {
            journal_scope: 'START',
            idempotency_key: key,
            review_id: reviewId,
            operation: 'INVALID_ACTIVE_OVERLAY',
            input: { key },
            expected_revision: 0,
            effects: [{
              name: 'active-overlay',
              mode: 'CREATE_ONCE_JSON',
              target: { area: 'REVIEW_STATE', path: 'active.json' },
              payload,
            }],
            response: { ok: false },
          });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', label);
          rejected = true;
        }
        if (!rejected) {
          accepted.push(label as string);
          continue;
        }
        await assert.rejects(readFile(isolatedPaths.activePath, 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));
      }
      assert.deepEqual(accepted, [], `accepted invalid active payloads: ${accepted.join(', ')}`);
    });
  });

  it('fails START A with active payload B before review, active, committed, or revision effects', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const foreignReviewId = api.generateReviewId();
      const key = api.generateReviewId();
      let rejected = false;
      try {
        await api.runDurableTransaction(paths, {
          journal_scope: 'START',
          idempotency_key: key,
          review_id: reviewId,
          operation: 'MISMATCHED_START_ACTIVE_IDENTITY',
          input: { review_id: reviewId },
          expected_revision: 0,
          effects: [
            {
              name: 'review',
              mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: reviewRecordPayload(reviewId, 1),
            },
            {
              name: 'active-overlay',
              mode: 'CREATE_ONCE_JSON',
              target: { area: 'REVIEW_STATE', path: 'active.json' },
              payload: { schema_version: 1, review_id: foreignReviewId, status: 'CREATED' },
            },
          ],
          response: { review_id: reviewId, revision: 1 },
        });
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED');
        rejected = true;
      }
      const review = await readFile(join(paths.reviewRoot, reviewId, 'review.json'), 'utf8')
        .then((value) => JSON.parse(value) as { revision?: number }, () => null);
      const active = await readFile(paths.activePath, 'utf8')
        .then((value) => JSON.parse(value) as { review_id?: string }, () => null);
      const committed = await readFile(join(paths.startTransactionsRoot, key, 'committed'), 'utf8')
        .then(() => true, () => false);
      assert.deepEqual({
        rejected,
        reviewRevision: review?.revision ?? null,
        activeReviewId: active?.review_id ?? null,
        committed,
      }, {
        rejected: true,
        reviewRevision: null,
        activeReviewId: null,
        committed: false,
      });
    });
  });

  it('rejects diagnostics, enum coercion, and reason budgets through one pre-PREPARED gate', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const cases: Array<{
        label: string;
        effect: (reviewId: string, key: string) => DurableEffect;
      }> = [
        {
          label: 'review diagnostics total over 16 KiB',
          effect: (reviewId) => {
            const record = reviewRecordPayload(reviewId, 1);
            record.diagnostics = Array.from({ length: 9 }, (_, index) => (
              diagnosticPayload(`diagnostic-${index + 1}`, 'x'.repeat(1_900), true)
            ));
            return {
              name: 'review', mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: record,
            };
          },
        },
        {
          label: 'scope reason over 500',
          effect: (reviewId) => {
            const record = reviewRecordPayload(reviewId, 1);
            record.scope = reviewScope('x'.repeat(501));
            return {
              name: 'review', mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: record,
            };
          },
        },
        {
          label: 'verdict reason over 500',
          effect: (reviewId) => {
            const record = reviewRecordPayload(reviewId, 1);
            record.verdict = reviewVerdict('x'.repeat(501));
            return {
              name: 'review', mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: record,
            };
          },
        },
        {
          label: 'proposal recommendation array',
          effect: (reviewId, key) => {
            const effect = structuredClone(durableEffects(reviewId, key, workingDirectory)[0]!) as any;
            effect.payload.result.recommendation = ['APPROVE'];
            return effect;
          },
        },
        {
          label: 'proposal arbitrary diagnostic',
          effect: (reviewId, key) => {
            const effect = structuredClone(durableEffects(reviewId, key, workingDirectory)[0]!) as any;
            effect.payload.result.diagnostics = [{ arbitrary: true }];
            return effect;
          },
        },
        {
          label: 'lane diagnostic summary over 2 KiB',
          effect: (reviewId, key) => {
            const effect = structuredClone(durableEffects(reviewId, key, workingDirectory)[3]!) as any;
            effect.payload.result.diagnostics = [diagnosticPayload('diagnostic-long', 'x'.repeat(5_000))];
            return effect;
          },
        },
        {
          label: 'lane diagnostics total over 16 KiB',
          effect: (reviewId, key) => {
            const effect = structuredClone(durableEffects(reviewId, key, workingDirectory)[3]!) as any;
            effect.payload.result.diagnostics = Array.from({ length: 9 }, (_, index) => (
              diagnosticPayload(`diagnostic-${index + 1}`, 'x'.repeat(1_900))
            ));
            return effect;
          },
        },
      ];
      const accepted: string[] = [];

      for (const testCase of cases) {
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: key,
        });
        const effect = testCase.effect(reviewId, key);
        let rejected = false;
        try {
          await api.runDurableTransaction(paths, {
            idempotency_key: key,
            review_id: reviewId,
            operation: 'INVALID_STRICT_BOUNDARY',
            input: { label: testCase.label },
            expected_revision: 0,
            effects: [effect],
            response: { ok: false },
          });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', testCase.label);
          rejected = true;
        }
        if (!rejected) {
          accepted.push(testCase.label);
          continue;
        }
        for (const path of [
          join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'),
          join(paths.reviewRoot, reviewId, 'transactions', key, 'committed'),
          effect.target.area === 'FINAL_REVIEWS'
            ? join(paths.reviewsRoot, effect.target.path)
            : join(paths.reviewRoot, effect.target.path),
          join(paths.reviewRoot, reviewId, 'review.json'),
        ]) {
          await assert.rejects(readFile(path, 'utf8'), (error: unknown) => (
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          ), testCase.label);
        }
      }

      assert.deepEqual(accepted, [], `accepted invalid strict payloads: ${accepted.join(', ')}`);
    });
  });

  it('rejects proposed and current ReviewRecord topology conflicts without mutation', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const mutations: Array<readonly [string, (record: any) => void]> = [
        ['reviewer global', (record) => { record.lanes[0].batch_id = 'global'; }],
        ['reviewer finding outside scope', (record) => { record.lanes[0].findings[0].file = 'src/outside.ts'; }],
        ['architect diagnostic', (record) => { record.lanes[1].diagnostic_ids = ['diagnostic-1']; }],
        ['duplicate batch', (record) => { record.batches.push(structuredClone(record.batches[0])); }],
        ['duplicate lane', (record) => { record.lanes.push(structuredClone(record.lanes[0])); }],
        ['duplicate diagnostic', (record) => { record.diagnostics.push(structuredClone(record.diagnostics[0])); }],
        ['lane scope mismatch', (record) => { record.lanes[0].scope_hash = 'b'.repeat(64); }],
        ['unknown diagnostic reference', (record) => { record.lanes[0].diagnostic_ids = ['missing']; }],
      ];
      const accepted: string[] = [];

      for (const [label, mutate] of mutations) {
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: key,
        });
        const record = reviewRecordWithTopology(reviewId, 1) as any;
        mutate(record);
        let rejected = false;
        try {
          await api.runDurableTransaction(paths, {
            idempotency_key: key,
            review_id: reviewId,
            operation: 'INVALID_REVIEW_TOPOLOGY',
            input: { label },
            expected_revision: 0,
            effects: [{
              name: 'review', mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload: record,
            }],
            response: { ok: false },
          });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', label);
          rejected = true;
        }
        if (!rejected) {
          accepted.push(label);
          continue;
        }
        for (const path of [
          join(paths.reviewRoot, reviewId, 'review.json'),
          join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'),
          join(paths.reviewRoot, reviewId, 'transactions', key, 'committed'),
        ]) {
          await assert.rejects(readFile(path, 'utf8'), (error: unknown) => (
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          ), label);
        }
      }

      const currentReviewId = api.generateReviewId();
      const foreignReviewId = api.generateReviewId();
      const currentKey = api.generateReviewId();
      const currentPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: currentKey,
      });
      const currentPath = join(currentPaths.reviewRoot, currentReviewId, 'review.json');
      await api.atomicWritePrivateJson(currentPath, reviewRecordWithTopology(foreignReviewId, 1));
      let currentMismatchRejected = false;
      try {
        await api.runDurableTransaction(currentPaths, {
          idempotency_key: currentKey,
          review_id: currentReviewId,
          operation: 'CURRENT_PATH_IDENTITY_MISMATCH',
          input: { review_id: currentReviewId },
          expected_revision: 1,
          effects: [{
            name: 'review', mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${currentReviewId}/review.json` },
            payload: reviewRecordWithTopology(currentReviewId, 2),
          }],
          response: { ok: false },
        });
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED');
        currentMismatchRejected = true;
      }
      const currentAfter = JSON.parse(await readFile(currentPath, 'utf8')) as {
        review_id: string; revision: number;
      };

      assert.deepEqual({
        accepted,
        currentMismatchRejected,
        currentAfter: { review_id: currentAfter.review_id, revision: currentAfter.revision },
      }, {
        accepted: [],
        currentMismatchRejected: true,
        currentAfter: { review_id: foreignReviewId, revision: 1 },
      });
    });
  });

  it('rejects every tampered COMMITTED identity or response across all replay paths', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const cases = [
        { label: 'idempotency_key', route: 'direct' as const },
        { label: 'response', route: 'reentry' as const },
        { label: 'transaction_id', route: 'root' as const },
        { label: 'input_digest', route: 'direct' as const },
      ];
      const accepted: Array<{ label: string; result: unknown }> = [];

      for (const testCase of cases) {
        const sessionId = api.generateReviewId();
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: sessionId,
        });
        const plan: DurablePlan = {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'COMMITTED_TAMPER',
          input: { stable: true },
          expected_revision: 0,
          effects: [],
          response: { review_id: reviewId, stable: true },
        };
        await assert.rejects(
          api.runDurableTransaction(paths, plan, { crashAt: 'after:committed' }),
          /injected crash/u,
        );
        const committedPath = join(paths.reviewRoot, reviewId, 'transactions', key, 'committed');
        const committed = JSON.parse(await readFile(committedPath, 'utf8')) as Record<string, unknown>;
        if (testCase.label === 'idempotency_key') committed.idempotency_key = api.generateReviewId();
        if (testCase.label === 'response') committed.response = { tampered: true };
        if (testCase.label === 'transaction_id') committed.transaction_id = api.generateReviewId();
        if (testCase.label === 'input_digest') committed.input_digest = 'f'.repeat(64);
        await writeFile(committedPath, `${JSON.stringify(committed, null, 2)}\n`, { mode: 0o600 });

        try {
          const result = testCase.route === 'direct'
            ? await api.recoverDurableTransactions(paths, {
                review_id: reviewId, idempotency_key: key, journal_scope: 'REVIEW',
              })
            : testCase.route === 'reentry'
              ? await api.runDurableTransaction(paths, plan)
              : await api.recoverPendingReviewTransactions(paths);
          accepted.push({ label: testCase.label, result });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', testCase.label);
        }
      }

      const validSessionId = api.generateReviewId();
      const validReviewId = api.generateReviewId();
      const validKey = api.generateReviewId();
      const validPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: validSessionId,
      });
      const validPlan: DurablePlan = {
        idempotency_key: validKey,
        review_id: validReviewId,
        operation: 'VALID_COMMITTED_REPLAY',
        input: { stable: true },
        expected_revision: 0,
        effects: [],
        response: { review_id: validReviewId, stable: true },
      };
      const first = await api.runDurableTransaction(validPaths, validPlan);
      const replay = await api.runDurableTransaction(validPaths, validPlan);
      assert.deepEqual(replay, first);
      assert.deepEqual(accepted, [], `accepted tampered committed values: ${JSON.stringify(accepted)}`);
    });
  });

  it('skips absent effect boundaries and rejects an invalid recovery journal scope', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const completed = await api.runDurableTransaction(paths, {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'NO_EFFECT_BOUNDARY',
        input: { stable: true },
        expected_revision: 0,
        effects: [],
        response: { ok: true },
      }, { crashAt: 'before:proposal' });
      assert.deepEqual(completed, { state: 'COMMITTED', response: { ok: true } });

      await assert.rejects(
        (api.recoverDurableTransactions as unknown as (
          paths: ReviewPersistencePaths,
          input: { review_id: string; idempotency_key: string; journal_scope: string },
        ) => Promise<unknown>)(paths, {
          review_id: reviewId,
          idempotency_key: api.generateReviewId(),
          journal_scope: 'INVALID',
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
    });
  });

  it('validates committed START intent and applied review state before root-scan fast-path cleanup', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const committedMutations = [
        'transaction_id', 'idempotency_key', 'input_digest', 'response',
      ] as const;
      const accepted: Array<{ label: string; result: unknown }> = [];

      for (const mutation of committedMutations) {
        const sessionId = api.generateReviewId();
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: sessionId,
        });
        await assert.rejects(api.runDurableTransaction(paths, {
          journal_scope: 'START',
          idempotency_key: key,
          review_id: reviewId,
          operation: 'START_COMMITTED_TAMPER',
          input: { stable: true },
          expected_revision: 0,
          effects: [],
          response: { review_id: reviewId, stable: true },
        }, { crashAt: 'after:committed' }), /injected crash/u);
        const committedPath = join(paths.startTransactionsRoot, key, 'committed');
        const committed = JSON.parse(await readFile(committedPath, 'utf8')) as Record<string, unknown>;
        if (mutation === 'transaction_id') committed.transaction_id = api.generateReviewId();
        if (mutation === 'idempotency_key') committed.idempotency_key = api.generateReviewId();
        if (mutation === 'input_digest') committed.input_digest = 'f'.repeat(64);
        if (mutation === 'response') committed.response = { tampered: true };
        await writeFile(committedPath, `${JSON.stringify(committed, null, 2)}\n`, { mode: 0o600 });

        try {
          const result = await api.recoverPendingReviewTransactions(paths);
          accepted.push({ label: `committed ${mutation}`, result });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', mutation);
        }
      }

      for (const mutation of ['identity', 'revision'] as const) {
        const sessionId = api.generateReviewId();
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: sessionId,
        });
        await assert.rejects(api.runDurableTransaction(paths, {
          journal_scope: 'START',
          idempotency_key: key,
          review_id: reviewId,
          operation: 'START_APPLIED_REVIEW_TAMPER',
          input: { stable: true },
          expected_revision: 0,
          effects: [{
            name: 'review',
            mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
          }],
          response: { review_id: reviewId, revision: 1 },
        }, { crashAt: 'after:committed' }), /injected crash/u);
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as Record<string, unknown>;
        if (mutation === 'identity') review.review_id = api.generateReviewId();
        if (mutation === 'revision') review.revision = 2;
        await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });

        try {
          const result = await api.recoverPendingReviewTransactions(paths);
          accepted.push({ label: `review ${mutation}`, result });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', mutation);
        }
      }

      const validSessionId = api.generateReviewId();
      const validReviewId = api.generateReviewId();
      const validKey = api.generateReviewId();
      const validPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: validSessionId,
      });
      await assert.rejects(api.runDurableTransaction(validPaths, {
        journal_scope: 'START',
        idempotency_key: validKey,
        review_id: validReviewId,
        operation: 'VALID_START_COMMITTED_SCAN',
        input: { stable: true },
        expected_revision: 0,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${validReviewId}/review.json` },
          payload: { ...reviewRecordPayload(validReviewId, 1), session_id: validSessionId },
        }],
        response: { review_id: validReviewId, revision: 1, stable: true },
      }, { crashAt: 'after:committed' }), /injected crash/u);
      assert.deepEqual(await api.recoverPendingReviewTransactions(validPaths), []);
      assert.deepEqual(accepted, [], `accepted tampered START state: ${JSON.stringify(accepted)}`);
    });
  });

  it('rejects committed START recovery when the applied review was rolled back or lost its transaction binding', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const accepted: Array<{ label: string; result: unknown }> = [];
      const cases = [
        { label: 'revision one without transaction binding', revision: 1, binding: 'missing', route: 'root' },
        { label: 'revision one with stale transaction binding', revision: 1, binding: 'wrong', route: 'direct' },
        { label: 'revision two without transaction binding', revision: 2, binding: 'missing', route: 'root' },
        { label: 'revision two with wrong transaction binding', revision: 2, binding: 'wrong', route: 'direct' },
      ] as const;

      for (const testCase of cases) {
        const sessionId = api.generateReviewId();
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: sessionId,
        });
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.atomicWritePrivateJson(
          reviewPath,
          { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
        );
        await assert.rejects(api.runDurableTransaction(paths, {
          journal_scope: 'START',
          idempotency_key: key,
          review_id: reviewId,
          operation: 'COMMITTED_REVIEW_ROLLBACK',
          input: { revision: 2 },
          expected_revision: 1,
          effects: [{
            name: 'review',
            mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: { ...reviewRecordPayload(reviewId, 2), session_id: sessionId },
          }],
          response: { review_id: reviewId, revision: 2 },
        }, { crashAt: 'after:committed' }), /injected crash/u);

        const rolledBack: Record<string, unknown> = {
          ...reviewRecordPayload(reviewId, testCase.revision),
          session_id: sessionId,
        };
        if (testCase.binding === 'wrong') {
          rolledBack.last_applied_transaction_id = api.generateReviewId();
        }
        await writeFile(reviewPath, `${JSON.stringify(rolledBack, null, 2)}\n`, { mode: 0o600 });

        try {
          const result = testCase.route === 'direct'
            ? await api.recoverDurableTransactions(paths, {
                journal_scope: 'START', review_id: reviewId, idempotency_key: key,
              })
            : await api.recoverPendingReviewTransactions(paths);
          accepted.push({ label: testCase.label, result });
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', testCase.label);
        }
      }

      const validSessionId = api.generateReviewId();
      const validReviewId = api.generateReviewId();
      const validKey = api.generateReviewId();
      const validPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: validSessionId,
      });
      const validReviewPath = join(validPaths.reviewRoot, validReviewId, 'review.json');
      await api.atomicWritePrivateJson(
        validReviewPath,
        { ...reviewRecordPayload(validReviewId, 1), session_id: validSessionId },
      );
      await assert.rejects(api.runDurableTransaction(validPaths, {
        journal_scope: 'START',
        idempotency_key: validKey,
        review_id: validReviewId,
        operation: 'VALID_COMMITTED_REVIEW_BINDING',
        input: { revision: 2 },
        expected_revision: 1,
        effects: [{
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${validReviewId}/review.json` },
          payload: { ...reviewRecordPayload(validReviewId, 2), session_id: validSessionId },
        }],
        response: { review_id: validReviewId, revision: 2 },
      }, { crashAt: 'after:committed' }), /injected crash/u);
      const applied = JSON.parse(await readFile(validReviewPath, 'utf8')) as Record<string, unknown>;
      assert.equal(applied.revision, 2);
      assert.equal(typeof applied.last_applied_transaction_id, 'string');
      assert.deepEqual(await api.recoverPendingReviewTransactions(validPaths), []);
      assert.deepEqual(JSON.parse(await readFile(validReviewPath, 'utf8')), applied);
      assert.deepEqual(accepted, [], `accepted invalid committed review state: ${JSON.stringify(accepted)}`);
    });
  });

  it('rejects tampered prepared input, effects, revision, and locator identity before side effects', async () => {
    const mutations = ['input', 'effects', 'revision', 'locator'] as const;
    for (const mutation of mutations) {
      await withWorkspace(async (workingDirectory) => {
        const api = await loadDurablePersistenceApi();
        assert.equal(typeof api.recoverPendingReviewTransactions, 'function');
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const proposalEffect = durableEffects(reviewId, key, workingDirectory)[0]!;
        const effectPath = proposalEffect.target.path;
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'TAMPER_TEST',
          input: { stable: true },
          expected_revision: 0,
          effects: [proposalEffect],
          response: { ok: true },
        }, { crashAt: 'after:locator' }), /injected crash/u);

        const locatorNames = await readdir(paths.pendingReviewTransactionsRoot);
        assert.equal(locatorNames.length, 1);
        const locatorPath = join(paths.pendingReviewTransactionsRoot, locatorNames[0]!);
        const locator = JSON.parse(await readFile(locatorPath, 'utf8')) as Record<string, unknown>;
        const preparedPath = join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared');
        const prepared = JSON.parse(await readFile(preparedPath, 'utf8')) as Record<string, unknown>;
        if (mutation === 'input') prepared.input = { stable: false };
        if (mutation === 'effects') prepared.effects = [];
        if (mutation === 'revision') prepared.expected_revision = 99;
        if (mutation === 'locator') locator.review_id = api.generateReviewId();
        await writeFile(preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });
        await writeFile(locatorPath, `${JSON.stringify(locator, null, 2)}\n`, { mode: 0o600 });

        await assert.rejects(
          api.recoverPendingReviewTransactions(paths),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
          mutation,
        );
        await assert.rejects(readFile(join(paths.reviewRoot, effectPath), 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));
      });
    }
  });

  it('discovers an active review transaction killed after PREPARED publication but before its locator', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      await api.atomicWritePrivateJson(
        reviewPath,
        { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
      );
      const proposal = durableEffects(reviewId, key, workingDirectory)[0]!;
      const plan: DurablePlan = {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'DISCOVER_PREPARED_WITHOUT_LOCATOR',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [proposal, {
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 2), session_id: sessionId },
        }],
        response: { review_id: reviewId, revision: 2 },
      };
      const transactionDirectory = join(paths.reviewRoot, reviewId, 'transactions', key);

      const moduleUrl = new URL('../persistence.js', import.meta.url).href;
      const childProgram = `
        const persistence = await import(process.argv[1]);
        const paths = await persistence.resolveReviewPersistencePaths({
          workingDirectory: process.argv[2], session_id: process.argv[3],
        });
        try {
          await persistence.runDurableTransaction(paths, JSON.parse(process.argv[4]), {
            crashAt: 'after:prepared',
          });
        } catch {
          process.abort();
        }
      `;
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory,
        sessionId, JSON.stringify(plan),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      const [exitCode, signal] = await once(child, 'close');
      assert.equal(isAbruptClose(exitCode, signal), true);

      await readFile(join(transactionDirectory, 'prepared'), 'utf8');
      await assert.rejects(
        readFile(join(transactionDirectory, 'committed'), 'utf8'),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
      const prematureLocators = await readdir(paths.pendingReviewTransactionsRoot)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      assert.deepEqual(prematureLocators, [], 'after:prepared must precede locator publication');

      assert.deepEqual(await api.recoverPendingReviewTransactions(paths), [{
        state: 'COMMITTED', response: { review_id: reviewId, revision: 2 },
      }]);
      const proposalPath = join(paths.reviewRoot, proposal.target.path);
      const publishedProposal = await readFile(proposalPath, 'utf8');
      const publishedReview = await readFile(reviewPath, 'utf8');
      const committed = await readFile(join(transactionDirectory, 'committed'), 'utf8');
      assert.equal((JSON.parse(publishedReview) as { revision: number }).revision, 2);
      assert.deepEqual(await api.recoverPendingReviewTransactions(paths), []);
      assert.equal(await readFile(proposalPath, 'utf8'), publishedProposal);
      assert.equal(await readFile(reviewPath, 'utf8'), publishedReview);
      assert.equal(await readFile(join(transactionDirectory, 'committed'), 'utf8'), committed);
      assert.deepEqual(
        await readdir(paths.pendingReviewTransactionsRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        }),
        [],
      );
    });
  });

  it('bounds locator-less discovery to a strict, non-dangling active review', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const stageProposal = async (
        paths: ReviewPersistencePaths,
        reviewId: string,
        key: string,
        expectedRevision: number,
      ): Promise<void> => {
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'BOUNDED_ORPHAN_DISCOVERY',
          input: { review_id: reviewId },
          expected_revision: expectedRevision,
          effects: [durableEffects(reviewId, key, workingDirectory)[0]!],
          response: { review_id: reviewId },
        }, { crashAt: 'after:prepared' }), /injected crash/u);
      };

      const oldPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: api.generateReviewId(),
      });
      const oldReviewId = api.generateReviewId();
      const oldKey = api.generateReviewId();
      await api.atomicWritePrivateJson(
        join(oldPaths.reviewRoot, oldReviewId, 'review.json'),
        reviewRecordPayload(oldReviewId, 1),
      );
      await stageProposal(oldPaths, oldReviewId, oldKey, 1);
      assert.deepEqual(await api.recoverPendingReviewTransactions(oldPaths), []);
      const currentReviewId = api.generateReviewId();
      await api.claimActiveReview(oldPaths, {
        schema_version: 1, review_id: currentReviewId, status: 'REVIEWING',
      });
      await api.atomicWritePrivateJson(
        join(oldPaths.reviewRoot, currentReviewId, 'review.json'),
        reviewRecordPayload(currentReviewId, 1),
      );
      assert.deepEqual(await api.recoverPendingReviewTransactions(oldPaths), []);
      await assert.rejects(
        readFile(join(oldPaths.reviewRoot, oldReviewId, 'submissions', oldKey, 'proposal'), 'utf8'),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );

      for (const condition of ['DANGLING', 'CONFLICTING'] as const) {
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: api.generateReviewId(),
        });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        await api.claimActiveReview(paths, {
          schema_version: 1, review_id: reviewId, status: 'REVIEWING',
        });
        if (condition === 'CONFLICTING') {
          await api.atomicWritePrivateJson(
            join(paths.reviewRoot, reviewId, 'review.json'),
            reviewRecordPayload(reviewId, 1),
          );
        }
        await stageProposal(paths, reviewId, key, condition === 'CONFLICTING' ? 1 : 0);
        if (condition === 'CONFLICTING') {
          await api.atomicWritePrivateJson(
            join(paths.reviewRoot, reviewId, 'review.json'),
            { ...reviewRecordPayload(reviewId, 1), status: 'BLOCKED', resumable: true },
          );
        }
        await assert.rejects(
          api.recoverPendingReviewTransactions(paths),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
          condition,
        );
        await assert.rejects(
          readFile(join(paths.reviewRoot, reviewId, 'submissions', key, 'proposal'), 'utf8'),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      }
    });
  });

  it('recovers root start-WAL allocation and publishes revision one only from COMMITTED', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const plan: DurablePlan = {
        journal_scope: 'START',
        idempotency_key: key,
        review_id: reviewId,
        operation: 'REVIEW_START_ALLOCATION',
        input: { review_id: reviewId },
        expected_revision: 0,
        effects: [
          {
            name: 'review',
            mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: reviewRecordPayload(reviewId, 1),
          },
          {
            name: 'active-overlay',
            mode: 'CREATE_ONCE_JSON',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
          },
        ],
        response: { review_id: reviewId, revision: 1 },
      };
      await assert.rejects(
        api.runDurableTransaction(paths, plan, { crashAt: 'after:prepared' }),
        /injected crash/u,
      );
      assert.deepEqual(await api.recoverDurableTransactions(paths, {
        journal_scope: 'START', review_id: reviewId, idempotency_key: key,
      }), {
        state: 'COMMITTED', response: { review_id: reviewId, revision: 1 },
      });
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 1);
      assert.equal((await api.readActiveReview(paths))?.review_id, reviewId);
      assert.deepEqual(await readdir(paths.startTransactionsRoot).catch(() => []), []);
      await assert.rejects(
        api.claimActiveReview(paths, {
          schema_version: 1, review_id: api.generateReviewId(), status: 'REVIEWING',
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'REVIEW_ALREADY_ACTIVE',
      );
    });
  });

  it('cleans successful and recovered START journals before later revision recovery', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const startKey = api.generateReviewId();
      const startPlan: DurablePlan = {
        journal_scope: 'START',
        idempotency_key: startKey,
        review_id: reviewId,
        operation: 'START_THEN_ADVANCE',
        input: { review_id: reviewId },
        expected_revision: 0,
        effects: [{
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewRecordPayload(reviewId, 1),
        }, {
          name: 'active-overlay',
          mode: 'CREATE_ONCE_JSON',
          target: { area: 'REVIEW_STATE', path: 'active.json' },
          payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
        }],
        response: { review_id: reviewId, revision: 1 },
      };

      await api.runDurableTransaction(paths, startPlan);
      assert.deepEqual(await readdir(paths.startTransactionsRoot).catch(() => []), []);

      const advanceKey = api.generateReviewId();
      await api.runDurableTransaction(paths, {
        idempotency_key: advanceKey,
        review_id: reviewId,
        operation: 'ADVANCE_AFTER_START',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [{
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 2), status: 'READY_TO_SYNTHESIZE' },
        }, {
          name: 'active-overlay',
          mode: 'UPDATE_MATCHING_ACTIVE',
          target: { area: 'REVIEW_STATE', path: 'active.json' },
          payload: { schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE' },
          review_id: reviewId,
          expected_status: 'REVIEWING',
          expected_revision: 1,
        }],
        response: { review_id: reviewId, revision: 2 },
      });

      assert.deepEqual(await api.recoverPendingReviewTransactions(paths), []);
      assert.equal((await api.readActiveReview(paths))?.status, 'READY_TO_SYNTHESIZE');
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 2);

      const crashedReviewId = api.generateReviewId();
      const crashedKey = api.generateReviewId();
      const crashedSessionId = api.generateReviewId();
      const crashedPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: crashedSessionId,
      });
      await assert.rejects(api.runDurableTransaction(crashedPaths, {
        ...startPlan,
        idempotency_key: crashedKey,
        review_id: crashedReviewId,
        input: { review_id: crashedReviewId },
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${crashedReviewId}/review.json` },
          payload: { ...reviewRecordPayload(crashedReviewId, 1), session_id: crashedSessionId },
        }],
        response: { review_id: crashedReviewId, revision: 1 },
      }, { crashAt: 'after:committed' }), /injected crash/u);
      await readFile(join(crashedPaths.startTransactionsRoot, crashedKey, 'committed'), 'utf8');
      assert.deepEqual(await api.recoverPendingReviewTransactions(crashedPaths), []);
      assert.deepEqual(await readdir(crashedPaths.startTransactionsRoot).catch(() => []), []);
    });
  });

  it('recovers active status transitions atomically from every relevant crash boundary', async () => {
    const boundaries: readonly DurableBoundary[] = [
      'after:prepared',
      'before:locator',
      'after:locator',
      'before:review',
      'after:review',
      'before:active-overlay',
      'after:active-overlay',
      'before:committed',
      'after:committed',
      'before:locator-cleanup',
      'after:locator-cleanup',
    ];
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      for (const crashAt of boundaries) {
        const sessionId = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.claimActiveReview(paths, {
          schema_version: 1, review_id: reviewId, status: 'REVIEWING',
        });
        await api.atomicWritePrivateJson(
          reviewPath,
          { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
        );
        const plan: DurablePlan = {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'READY_STATUS_TRANSITION',
          input: { review_id: reviewId },
          expected_revision: 1,
          effects: [{
            name: 'review', mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: {
              ...reviewRecordPayload(reviewId, 2),
              session_id: sessionId,
              status: 'READY_TO_SYNTHESIZE',
            },
          }, {
            name: 'active-overlay', mode: 'UPDATE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE' },
            review_id: reviewId,
            expected_status: 'REVIEWING',
            expected_revision: 1,
          }],
          response: { review_id: reviewId, revision: 2 },
        };

        await assert.rejects(api.runDurableTransaction(paths, plan, { crashAt }), /injected crash/u, crashAt);
        if (crashAt === 'after:prepared') {
          assert.deepEqual(await readdir(paths.pendingReviewTransactionsRoot).catch(() => []), []);
          assert.equal((await api.readActiveReview(paths))?.status, 'REVIEWING');
          assert.equal((JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number }).revision, 1);
        }
        await api.recoverPendingReviewTransactions(paths);
        const active = await api.readActiveReview(paths);
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number; status: string };
        assert.deepEqual(
          { active: active?.status, review: review.status, revision: review.revision },
          { active: 'READY_TO_SYNTHESIZE', review: 'READY_TO_SYNTHESIZE', revision: 2 },
          crashAt,
        );
      }
    });
  });

  it('removes the active pointer only with an exact terminal transition binding', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      for (const crashAt of ['after:review', 'after:active-overlay', 'after:committed'] as const) {
        const sessionId = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: sessionId,
        });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.claimActiveReview(paths, {
          schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE',
        });
        await api.atomicWritePrivateJson(
          reviewPath,
          {
            ...reviewRecordPayload(reviewId, 2),
            session_id: sessionId,
            status: 'READY_TO_SYNTHESIZE',
          },
        );
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'FINALIZE_ATOMICALLY',
          input: { review_id: reviewId },
          expected_revision: 2,
          effects: [{
            name: 'review', mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: {
              ...reviewRecordPayload(reviewId, 3),
              session_id: sessionId,
              status: 'FINALIZED',
            },
          }, {
            name: 'active-overlay', mode: 'REMOVE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            review_id: reviewId,
            expected_status: 'READY_TO_SYNTHESIZE',
            expected_revision: 2,
          }],
          response: { review_id: reviewId, revision: 3 },
        }, { crashAt }), /injected crash/u);

        await api.recoverPendingReviewTransactions(paths);
        assert.equal(await api.readActiveReview(paths), null, crashAt);
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number; status: string };
        assert.deepEqual(review.status, 'FINALIZED', crashAt);
        assert.equal(review.revision, 3, crashAt);
      }

      const conflictSessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: conflictSessionId,
      });
      const reviewId = api.generateReviewId();
      const otherReviewId = api.generateReviewId();
      await api.claimActiveReview(paths, {
        schema_version: 1, review_id: otherReviewId, status: 'REVIEWING',
      });
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, reviewId, 'review.json'),
        { ...reviewRecordPayload(reviewId, 1), session_id: conflictSessionId },
      );
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: api.generateReviewId(),
        review_id: reviewId,
        operation: 'CONFLICTING_TERMINAL_REMOVE',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...reviewRecordPayload(reviewId, 2),
            session_id: conflictSessionId,
            status: 'FINALIZED',
          },
        }, {
          name: 'active-overlay', mode: 'REMOVE_MATCHING_ACTIVE',
          target: { area: 'REVIEW_STATE', path: 'active.json' },
          review_id: reviewId,
          expected_status: 'REVIEWING',
          expected_revision: 1,
        }],
        response: { review_id: reviewId },
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
      assert.equal((await api.readActiveReview(paths))?.review_id, otherReviewId);
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 1);
    });
  });

  it('restores a missing active pointer only while resuming the exact BLOCKED revision', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      const blockedAttempt = {
        attempt: 1, status: 'BLOCKED', bindings: [], lane_ids: [],
        started_at: '2026-07-14T00:00:00.000Z', updated_at: '2026-07-14T00:00:00.000Z',
        resumable: true, resumable_reason: 'LANE_FAILED',
      };
      await api.atomicWritePrivateJson(
        reviewPath,
        {
          ...reviewRecordPayload(reviewId, 2), status: 'BLOCKED', resumable: true,
          resumable_reason: 'LANE_FAILED', attempt_history: [blockedAttempt],
        },
      );
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'RESUME_BLOCKED_REVIEW',
        input: { review_id: reviewId },
        expected_revision: 2,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...reviewRecordPayload(reviewId, 3),
            current_attempt: 2,
            attempt_history: [blockedAttempt, {
              attempt: 2, status: 'REVIEWING', bindings: [], lane_ids: [],
              started_at: '2026-07-14T00:01:00.000Z', updated_at: '2026-07-14T00:01:00.000Z',
              resumable: false,
            }],
          },
        }, {
          name: 'active-overlay', mode: 'RESTORE_MISSING_ACTIVE',
          target: { area: 'REVIEW_STATE', path: 'active.json' },
          payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
          review_id: reviewId,
          expected_status: 'BLOCKED',
          expected_revision: 2,
        }],
        response: { review_id: reviewId, revision: 3 },
      }, { crashAt: 'after:review' }), /injected crash/u);
      await api.recoverPendingReviewTransactions(paths);
      assert.equal((await api.readActiveReview(paths))?.status, 'REVIEWING');
      const review = JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number; status: string };
      assert.deepEqual({ revision: review.revision, status: review.status }, { revision: 3, status: 'REVIEWING' });
    });
  });

  it('durably consumes proposal, tool event, and nonce identities without persisting raw values', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const publicationKey = api.generateReviewId();
      const now = '2026-07-14T00:00:00.000Z';
      const rawValues: Record<ReviewConsumptionKind, string> = {
        PROPOSAL_KEY: publicationKey,
        TOOL_EVENT_REF: 'events/result-post-tool-1.json',
        NONCE: publicationKey,
      };
      const markerEffects = (Object.keys(rawValues) as ReviewConsumptionKind[]).map((kind) => (
        api.createReviewConsumptionEffect({
          review_id: reviewId,
          idempotency_key: key,
          kind,
          value: rawValues[kind],
          consumed_at: now,
        })
      ));
      for (const effect of markerEffects) {
        assert.match(effect.target.path, new RegExp(`^${reviewId}/consumptions/[a-z-]+/[0-9a-f]{64}\\.json$`, 'u'));
        for (const raw of Object.values(rawValues)) assert.doesNotMatch(JSON.stringify(effect), new RegExp(raw.replaceAll('/', '\\/'), 'u'));
      }
      assert.equal(new Set(markerEffects.map((effect) => effect.target.path)).size, 3);
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, reviewId, 'review.json'),
        { ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: 'root-thread-1' },
      );
      const complete = durableEffects(reviewId, publicationKey, workingDirectory, {
        sessionId, rootThreadId: 'root-thread-1',
      });
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'CONSUME_REPLAY_IDENTITIES',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [...complete.slice(0, 2), ...markerEffects, {
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...(reviewEffectWithoutExplicitApproval(complete[4]!).payload as Record<string, unknown>),
            session_id: sessionId,
            root_thread_id: 'root-thread-1',
          },
        }],
        response: { review_id: reviewId, revision: 2 },
      }, { crashAt: 'after:consume' }), /injected crash/u);
      await api.recoverPendingReviewTransactions(paths);

      const markers = await api.readReviewConsumptionMarkers(paths, reviewId);
      assert.deepEqual(new Set(markers.map((marker) => marker.kind)), new Set(Object.keys(rawValues)));
      assert.equal(markers.every((marker) => marker.idempotency_key === key), true);
      assert.match(JSON.stringify(markers), /[0-9a-f]{64}/u);
      for (const raw of Object.values(rawValues)) assert.doesNotMatch(JSON.stringify(markers), new RegExp(raw.replaceAll('/', '\\/'), 'u'));
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 2);

      const reuseKey = api.generateReviewId();
      const reused = api.createReviewConsumptionEffect({
        review_id: reviewId,
        idempotency_key: reuseKey,
        kind: 'PROPOSAL_KEY',
        value: rawValues.PROPOSAL_KEY,
        consumed_at: now,
      });
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: reuseKey,
        review_id: reviewId,
        operation: 'REUSE_CONSUMED_PROPOSAL',
        input: { review_id: reviewId },
        expected_revision: 2,
        effects: [reused, {
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewRecordPayload(reviewId, 3),
        }],
        response: { review_id: reviewId, revision: 3 },
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 2);

      assert.throws(() => api.createReviewConsumptionEffect({
        review_id: reviewId,
        idempotency_key: api.generateReviewId(),
        kind: 'NONCE',
        value: 'x'.repeat(1_025),
        consumed_at: now,
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
    });
  });

  it('rejects unbalanced typed consumption kinds and marker-only transactions before PREPARED', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const now = '2026-07-14T00:00:00.000Z';
      for (const markerOnly of [false, true]) {
        const key = api.generateReviewId();
        const first = api.createReviewConsumptionEffect({
          review_id: reviewId, idempotency_key: key, kind: 'NONCE', value: 'one', consumed_at: now,
        });
        const effects: DurableEffect[] = markerOnly ? [first] : [first, api.createReviewConsumptionEffect({
          review_id: reviewId, idempotency_key: key, kind: 'NONCE', value: 'two', consumed_at: now,
        }), {
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewRecordPayload(reviewId, 1),
        }];
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'INVALID_CONSUMPTION_TOPOLOGY',
          input: { review_id: reviewId },
          expected_revision: 0,
          effects,
          response: { ok: false },
        }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
        await assert.rejects(
          readFile(join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'), 'utf8'),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      }
    });
  });

  it('binds two proposal/post-tool pairs and two complete consumption triples in one recovery', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const transactionKey = api.generateReviewId();
      const publicationKeys = [api.generateReviewId(), api.generateReviewId()] as const;
      const now = '2026-07-14T00:00:00.000Z';
      const pairs = publicationKeys.flatMap((publicationKey, index) => {
        const pair = structuredClone(durableEffects(
          reviewId,
          publicationKey,
          workingDirectory,
          { sessionId, rootThreadId: 'root-thread-1' },
        ).slice(0, 2)) as any[];
        if (index === 1) {
          pair[0].payload.lane_id = 'reviewer-2';
          pair[0].payload.result.lane_id = 'reviewer-2';
          pair[1].payload.activity.lane_id = 'reviewer-2';
          pair[1].payload.activity.child_thread_id = 'child-thread-2';
          pair[1].payload.activity.event_ref = 'events/result-post-tool-2.json';
          pair[1].payload.attestation.lane_id = 'reviewer-2';
          pair[1].payload.attestation.child_thread_id = 'child-thread-2';
          pair[1].payload.attestation.tool_event_ref = 'events/result-post-tool-2.json';
        }
        return pair as DurableEffect[];
      });
      for (const effect of pairs) {
        await api.atomicCreatePrivateJson(join(paths.reviewRoot, effect.target.path), effect.payload);
      }
      const markers = publicationKeys.flatMap((publicationKey, index) => ([
        api.createReviewConsumptionEffect({
          review_id: reviewId, idempotency_key: transactionKey, kind: 'PROPOSAL_KEY',
          value: publicationKey, consumed_at: now,
        }),
        api.createReviewConsumptionEffect({
          review_id: reviewId, idempotency_key: transactionKey, kind: 'TOOL_EVENT_REF',
          value: `events/result-post-tool-${index + 1}.json`, consumed_at: now,
        }),
        api.createReviewConsumptionEffect({
          review_id: reviewId, idempotency_key: transactionKey, kind: 'NONCE',
          value: publicationKey, consumed_at: now,
        }),
      ]));
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, reviewId, 'review.json'),
        { ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: 'root-thread-1' },
      );
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: transactionKey,
        review_id: reviewId,
        operation: 'BATCHED_RECONCILIATION',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [...pairs, ...markers, {
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...reviewRecordPayload(reviewId, 2),
            session_id: sessionId,
            root_thread_id: 'root-thread-1',
            scope: reviewScope(),
            batches: [{
              batch_id: 'batch-1', module_root: '.', files: ['src/a.ts'],
              changed_lines: 1, oversized_single_file: false,
            }],
            lanes: ['reviewer-1', 'reviewer-2'].map((laneId) => ({
              lane_id: laneId, role: 'code-reviewer', batch_id: 'batch-1',
              scope_hash: 'a'.repeat(64), status: 'COMPLETE', attempt: 1,
              timeout_ms: 30_000, idle_deadline_at: now,
              recommendation: 'REQUEST CHANGES', findings: [], diagnostic_ids: [],
            })),
          },
        }],
        response: { review_id: reviewId, revision: 2 },
      }, { crashAt: 'after:consume' }), /injected crash/u);
      await api.recoverPendingReviewTransactions(paths);
      assert.equal((await api.readReviewConsumptionMarkers(paths, reviewId)).length, 6);
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 2);

      const unpairedKey = api.generateReviewId();
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: unpairedKey,
        review_id: reviewId,
        operation: 'UNPAIRED_POST_TOOL',
        input: { review_id: reviewId },
        expected_revision: 2,
        effects: [pairs[1]!, {
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...reviewRecordPayload(reviewId, 3),
            session_id: sessionId,
            root_thread_id: 'root-thread-1',
          },
        }],
        response: { ok: false },
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
    });
  });

  it('recovers every before/after crash boundary and applies all effects exactly once', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'omx-code-review-wal-'));
    try {
      const api = await loadDurablePersistenceApi();
      const boundaries = DURABLE_STAGES.flatMap((stage): DurableBoundary[] => [
        `before:${stage}`,
        `after:${stage}`,
      ]);

      for (const crashAt of boundaries) {
        const sessionId = api.generateReviewId();
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const trust = { sessionId, rootThreadId: 'root-thread-1' };
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE' });
        const effects = durableEffects(reviewId, key, workingDirectory, trust);
        const proposedReview = effects[4]!.payload as Record<string, unknown>;
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.atomicWritePrivateJson(reviewPath, {
          ...reviewRecordPayload(reviewId, 1),
          status: 'READY_TO_SYNTHESIZE',
          effective_config: proposedReview.effective_config,
          session_id: sessionId,
          root_thread_id: trust.rootThreadId,
        });
        const plan: DurablePlan = {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'TEST_DURABLE_MUTATION',
          input: { review_id: reviewId, requested: 'bounded' },
          expected_revision: 1,
          effects,
          response: { review_id: reviewId, revision: 2 },
        };

        const moduleUrl = new URL('../persistence.js', import.meta.url).href;
        const childProgram = `
          const persistence = await import(process.argv[1]);
          const paths = await persistence.resolveReviewPersistencePaths({
            workingDirectory: process.argv[2], session_id: process.argv[3],
          });
          await persistence.runDurableTransaction(paths, JSON.parse(process.argv[4]), {
            crashAt: process.argv[5],
          });
        `;
        let childFailed = false;
        try {
          await execFileAsync(process.execPath, [
            '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory,
            sessionId, JSON.stringify(plan), crashAt,
          ]);
        } catch (error) {
          childFailed = true;
          assert.match(String(error), /injected crash/u, crashAt);
        }
        assert.equal(childFailed, true, `${crashAt} child must exit before publishing success`);

        const recovered = await api.recoverPendingReviewTransactions(paths);
        if (crashAt === 'before:prepared') {
          assert.deepEqual(recovered, [], crashAt);
          await assert.rejects(
            readFile(join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'), 'utf8'),
            (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
          );
          continue;
        }
        if (recovered.length > 0) {
          assert.deepEqual(recovered, [{
            state: 'COMMITTED',
            response: { review_id: reviewId, revision: 2 },
          }], crashAt);
        }

        const committed = JSON.parse(await readFile(
          join(paths.reviewRoot, reviewId, 'transactions', key, 'committed'),
          'utf8',
        )) as { transaction_id: string };
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as {
          revision: number;
          last_applied_transaction_id: string;
        };
        assert.equal(review.revision, 2, crashAt);
        assert.equal(review.last_applied_transaction_id, committed.transaction_id, crashAt);

        const createdTargets = durableEffects(reviewId, key, workingDirectory, trust)
          .filter((effect) => effect.mode === 'CREATE_ONCE_JSON')
          .map((effect) => effect.target.area === 'FINAL_REVIEWS'
            ? join(paths.reviewsRoot, effect.target.path)
            : join(paths.reviewRoot, effect.target.path));
        for (const target of createdTargets) {
          JSON.parse(await readFile(target, 'utf8'));
        }
        const markdown = await readFile(join(paths.reviewsRoot, `${reviewId}.md`), 'utf8');
        assert.match(markdown, new RegExp(`Review ID: ${reviewId}`, 'u'), crashAt);
        assert.equal(await api.readActiveReview(paths), null, crashAt);
        const locatorRoot = join(paths.reviewRoot, 'pending-review-transactions');
        assert.deepEqual(await readdir(locatorRoot).catch(() => []), [], crashAt);
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects the same idempotency key with a different canonical payload', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, reviewId, 'review.json'),
        reviewRecordPayload(reviewId, 1),
      );
      const plan: DurablePlan = {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'TEST_CONFLICT',
        input: { value: 1 },
        expected_revision: 1,
        effects: [reviewEffectWithoutExplicitApproval(durableEffects(reviewId, key, workingDirectory)[4]!)],
        response: { ok: true },
      };
      await api.runDurableTransaction(paths, plan);

      await assert.rejects(
        api.runDurableTransaction(paths, { ...plan, input: { value: 2 } }),
        (error: unknown) => (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT',
      );
      const review = JSON.parse(await readFile(join(paths.reviewRoot, reviewId, 'review.json'), 'utf8')) as { revision: number };
      assert.equal(review.revision, 2);
    });
  });

  it('treats a temp-only hook crash as absent and only accepts a fully published create-once journal', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const journalPath = join(paths.reviewRoot, reviewId, 'activity', 'child-thread', 'event-1');
      const hookLock = await api.acquireReviewLocks(paths, reviewId, ['journal'], { timeoutMs: 0 });
      try {
        await assert.rejects(
          api.atomicCreatePrivateJson(journalPath, { event_ref: 'event-1' }, {
            beforePublish: () => {
              throw new Error('hook crashed before no-replace publication');
            },
          }),
          /hook crashed/u,
        );
        await assert.rejects(readFile(journalPath, 'utf8'), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ));

        await api.atomicCreatePrivateJson(journalPath, { event_ref: 'event-1' });
        assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), { event_ref: 'event-1' });
        await assert.rejects(api.atomicCreatePrivateJson(journalPath, { event_ref: 'different' }), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'EEXIST'
          || (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT'
        ));
      } finally {
        await api.releaseReviewLocks(hookLock);
      }
      const coordinatorLocks = await api.acquireReviewLocks(
        paths, reviewId, ['mutation', 'journal'], { timeoutMs: 0 },
      );
      try {
        assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), { event_ref: 'event-1' });
      } finally {
        await api.releaseReviewLocks(coordinatorLocks);
      }
    });
  });

  it('rejects corrupt or cross-review active state before mutating the review', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      await api.atomicWritePrivateJson(paths.activePath, { malformed: true });
      await assert.rejects(
        api.readActiveReview(paths),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );

      const activeReviewId = api.generateReviewId();
      await api.atomicWritePrivateJson(paths.activePath, {
        schema_version: 1, review_id: activeReviewId, status: 'REVIEWING',
      });
      const transactionReviewId = api.generateReviewId();
      const key = api.generateReviewId();
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, transactionReviewId, 'review.json'),
        reviewRecordPayload(transactionReviewId, 1),
      );
      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: key,
        review_id: transactionReviewId,
        operation: 'TEST_MISMATCHED_ACTIVE',
        input: { review_id: transactionReviewId },
        expected_revision: 1,
        effects: [
          {
            name: 'review',
            mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${transactionReviewId}/review.json` },
            payload: { ...reviewRecordPayload(transactionReviewId, 2), status: 'FINALIZED' },
          },
          {
            name: 'active-overlay',
            mode: 'REMOVE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            review_id: transactionReviewId,
            expected_status: 'REVIEWING',
            expected_revision: 1,
          },
        ],
        response: { ok: true },
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
      assert.equal((await api.readActiveReview(paths))?.review_id, activeReviewId);
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, transactionReviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 1);
    });
  });

  it('rejects a transaction plan that requests cleanup for a different active review identity', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const transactionReviewId = api.generateReviewId();
      const differentActiveReviewId = api.generateReviewId();
      await api.claimActiveReview(paths, {
        schema_version: 1, review_id: differentActiveReviewId, status: 'REVIEWING',
      });
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, transactionReviewId, 'review.json'),
        reviewRecordPayload(transactionReviewId, 1),
      );

      await assert.rejects(
        api.runDurableTransaction(paths, {
          idempotency_key: api.generateReviewId(),
          review_id: transactionReviewId,
          operation: 'INVALID_CROSS_REVIEW_CLEANUP',
          input: { review_id: transactionReviewId },
          expected_revision: 1,
          effects: [{
            name: 'active-overlay',
            mode: 'REMOVE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            review_id: differentActiveReviewId,
          }],
          response: { ok: false },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      assert.equal((await api.readActiveReview(paths))?.review_id, differentActiveReviewId);
    });
  });

  it('keeps lane attempt journals append-only and preserves old terminal evidence', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const firstRoot = join(paths.reviewRoot, reviewId, 'lanes', 'reviewer-attempt-1');
      const secondRoot = join(paths.reviewRoot, reviewId, 'lanes', 'reviewer-attempt-2');
      await api.atomicCreatePrivateJson(join(firstRoot, 'start'), { attempt: 1, status: 'RUNNING' });
      await api.atomicCreatePrivateJson(join(firstRoot, 'terminal'), { attempt: 1, status: 'FAILED' });
      await assert.rejects(
        api.atomicCreatePrivateJson(join(firstRoot, 'terminal'), { attempt: 1, status: 'COMPLETE' }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
      );
      await api.atomicCreatePrivateJson(join(secondRoot, 'start'), { attempt: 2, status: 'RUNNING' });
      await api.atomicCreatePrivateJson(join(secondRoot, 'terminal'), { attempt: 2, status: 'COMPLETE' });

      assert.deepEqual(JSON.parse(await readFile(join(firstRoot, 'terminal'), 'utf8')), {
        attempt: 1, status: 'FAILED',
      });
      assert.deepEqual(JSON.parse(await readFile(join(secondRoot, 'terminal'), 'utf8')), {
        attempt: 2, status: 'COMPLETE',
      });
    });
  });

  it('increments the review revision once per committed transaction without rewriting old journals', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      await api.atomicWritePrivateJson(reviewPath, reviewRecordPayload(reviewId, 1));
      const firstKey = api.generateReviewId();
      const first: DurablePlan = {
        idempotency_key: firstKey,
        review_id: reviewId,
        operation: 'FIRST_REVISION',
        input: { sequence: 1 },
        expected_revision: 1,
        effects: [{
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewRecordPayload(reviewId, 2),
        }],
        response: { revision: 2 },
      };
      await api.runDurableTransaction(paths, first);
      const firstCommittedPath = join(paths.reviewRoot, reviewId, 'transactions', firstKey, 'committed');
      const firstCommitted = await readFile(firstCommittedPath, 'utf8');

      const secondKey = api.generateReviewId();
      await api.runDurableTransaction(paths, {
        ...first,
        idempotency_key: secondKey,
        operation: 'SECOND_REVISION',
        input: { sequence: 2 },
        expected_revision: 2,
        effects: [{
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewRecordPayload(reviewId, 3),
        }],
        response: { revision: 3 },
      });
      assert.equal((JSON.parse(await readFile(reviewPath, 'utf8')) as { revision: number }).revision, 3);
      assert.equal(await readFile(firstCommittedPath, 'utf8'), firstCommitted);
    });
  });
});

function finalArtifact(reviewId: string, repositoryRoot: string): unknown {
  const now = '2026-07-14T00:00:00.000Z';
  return {
    schema_version: 1,
    review_id: reviewId,
    revision: 2,
    status: 'FINALIZED',
    current_attempt: 1,
    scope: {
      selector: { explicit_paths: ['src/a.ts'] },
      status: 'FULL_SCOPE',
      scope_hash: 'a'.repeat(64),
      files: [{
        path: 'src/a.ts',
        change: 'MODIFIED',
        sources: ['WORKTREE'],
        binary: false,
        additions: 1,
        deletions: 0,
      }],
      changed_lines: 1,
      reasons: [`reviewed from ${repositoryRoot}`],
    },
    review_flags: [],
    batches: [{
      batch_id: 'batch-1', module_root: '.', files: ['src/a.ts'], changed_lines: 1, oversized_single_file: false,
    }],
    lanes: [{
      lane_id: 'reviewer-1',
      role: 'code-reviewer',
      batch_id: 'batch-1',
      scope_hash: 'a'.repeat(64),
      status: 'COMPLETE',
      attempt: 1,
      recommendation: 'REQUEST CHANGES',
      findings: [{
        severity: 'HIGH',
        title: 'Leaked credential',
        body: 'Authorization: Bearer final-artifact-secret',
        file: 'src/a.ts',
        start_line: 1,
        end_line: 1,
        fix: 'Remove api_key=final-key-secret',
        evidence: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      }],
      diagnostic_ids: ['diagnostic-1'],
    }, {
      lane_id: 'architect-1',
      role: 'architect',
      batch_id: 'global',
      scope_hash: 'a'.repeat(64),
      status: 'COMPLETE',
      attempt: 1,
      architectural_status: 'CLEAR',
      findings: [],
      diagnostic_ids: [],
    }],
    diagnostics: [{
      diagnostic_id: 'diagnostic-1',
      capability: 'LINT',
      applicability: 'APPLICABLE',
      execution: 'NATIVE',
      outcome: 'FAIL',
      tool_name: 'eslint',
      event_ref: 'events/lint-1.json',
      summary: 'One review finding was confirmed.',
    }],
    verdict: {
      recommendation: 'REQUEST CHANGES',
      architectural_status: 'CLEAR',
      scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE',
      rule_id: 'REVIEW_FINDING',
      reasons: ['A high-severity finding remains.'],
      clean: false,
    },
    created_at: now,
    updated_at: now,
    finalized_at: now,
  };
}

describe('final review artifact rendering', () => {
  it('writes authoritative JSON and deterministic Markdown with identical safe identity', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence, render } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = persistence.generateReviewId();
      const artifact = finalArtifact(reviewId, workingDirectory) as any;
      artifact.lanes[0].findings[0].body += ' AKIAIOSFODNN7EXAMPLE';
      artifact.lanes[0].findings[0].fix += ' Rotate ASIAIOSFODNN7EXAMPLE.';
      artifact.lanes[0].findings[0].evidence += '\n-----BEGIN PRIVATE KEY-----\npkcs8-material\n-----END PRIVATE KEY-----';
      const written = await persistence.writeFinalReviewArtifacts(
        paths,
        artifact,
      );
      const jsonText = await readFile(written.jsonPath, 'utf8');
      const markdown = await readFile(written.markdownPath, 'utf8');
      const parsed = JSON.parse(jsonText) as { review_id: string; scope: { scope_hash: string } };

      assert.equal(parsed.review_id, reviewId);
      assert.match(markdown, new RegExp(`Review ID: ${reviewId}`, 'u'));
      assert.match(markdown, new RegExp(`Scope Hash: ${parsed.scope.scope_hash}`, 'u'));
      assert.equal(markdown, render.renderFinalReviewMarkdown(parsed));
      assert.match(written.artifact_sha256, /^[0-9a-f]{64}$/u);
      assert.doesNotMatch(
        `${jsonText}\n${markdown}`,
        /final-artifact-secret|final-key-secret|ghp_|\/Users\/|(?:AKIA|ASIA)IOSFODNN7EXAMPLE|BEGIN PRIVATE KEY|pkcs8-material/u,
      );
    });
  });

  it('writes BLOCKED artifacts without fabricated lane results and preserves terminal lane state rules', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const blocked = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      blocked.status = 'BLOCKED';
      blocked.verdict.architectural_status = 'BLOCK';
      blocked.verdict.evidence_status = 'DEGRADED_EVIDENCE';
      blocked.verdict.rule_id = 'LANE_FAILURE';
      blocked.verdict.reasons = ['Lane failures blocked a trustworthy final synthesis.'];
      blocked.diagnostics = [];
      const reviewer = blocked.lanes[0];
      const architect = blocked.lanes[1];
      blocked.lanes = [
        { ...reviewer, lane_id: 'reviewer-failed', status: 'FAILED', failure_code: 'LANE_FAILED' },
        { ...reviewer, lane_id: 'reviewer-timed-out', status: 'TIMED_OUT', failure_code: 'LANE_TIMED_OUT' },
        { ...reviewer, lane_id: 'reviewer-invalid', status: 'INVALID', failure_code: 'LANE_INVALID' },
        { ...architect, lane_id: 'architect-failed', status: 'FAILED', failure_code: 'ARCHITECT_FAILED' },
        { ...reviewer, lane_id: 'reviewer-pending', status: 'PENDING' },
        { ...architect, lane_id: 'architect-running', status: 'RUNNING' },
      ];
      for (const lane of blocked.lanes) {
        lane.findings = [];
        lane.diagnostic_ids = [];
        delete lane.recommendation;
        delete lane.architectural_status;
      }

      const written = await persistence.writeFinalReviewArtifacts(paths, blocked);
      const json = await readFile(written.jsonPath, 'utf8');
      const markdown = await readFile(written.markdownPath, 'utf8');
      const persisted = JSON.parse(json) as { lanes: Array<Record<string, unknown>> };
      assert.match(json, /"failure_code": "LANE_FAILED"/u);
      assert.match(markdown, /Failure: `LANE_FAILED`/u);
      assert.equal(persisted.lanes.some((lane) => (
        lane.recommendation !== undefined || lane.architectural_status !== undefined
      )), false);

      const invalidArtifacts: unknown[] = [];
      const withoutFailureCode = structuredClone(blocked);
      withoutFailureCode.review_id = persistence.generateReviewId();
      delete withoutFailureCode.lanes[0].failure_code;
      invalidArtifacts.push(withoutFailureCode);

      const fabricatedReviewerResult = structuredClone(blocked);
      fabricatedReviewerResult.review_id = persistence.generateReviewId();
      fabricatedReviewerResult.lanes[0].recommendation = 'REQUEST CHANGES';
      invalidArtifacts.push(fabricatedReviewerResult);

      const fabricatedArchitectResult = structuredClone(blocked);
      fabricatedArchitectResult.review_id = persistence.generateReviewId();
      fabricatedArchitectResult.lanes[3].architectural_status = 'BLOCK';
      invalidArtifacts.push(fabricatedArchitectResult);

      for (const roleField of ['recommendation', 'architectural_status'] as const) {
        const missingCompleteResult = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
        delete missingCompleteResult.lanes[roleField === 'recommendation' ? 0 : 1][roleField];
        invalidArtifacts.push(missingCompleteResult);
      }

      const cleanFinalizedFailure = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      cleanFinalizedFailure.verdict = {
        recommendation: 'APPROVE',
        architectural_status: 'CLEAR',
        scope_status: 'FULL_SCOPE',
        evidence_status: 'FULL_EVIDENCE',
        rule_id: 'CLEAN_REVIEW',
        reasons: ['All required review evidence is complete.'],
        clean: true,
      };
      cleanFinalizedFailure.lanes[0].status = 'FAILED';
      cleanFinalizedFailure.lanes[0].failure_code = 'LANE_FAILED';
      delete cleanFinalizedFailure.lanes[0].recommendation;
      invalidArtifacts.push(cleanFinalizedFailure);

      for (const invalid of invalidArtifacts) {
        await assert.rejects(
          persistence.writeFinalReviewArtifacts(paths, invalid),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
      }
    });
  });

  it('fails closed on BLOCKED approvals and permits only the scope-free REVIEW_NOT_STARTED shape', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const scopeFree = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      scopeFree.status = 'BLOCKED';
      delete scopeFree.scope;
      scopeFree.batches = [];
      scopeFree.lanes = [];
      scopeFree.diagnostics = [];
      scopeFree.verdict = {
        recommendation: 'REQUEST CHANGES',
        architectural_status: 'BLOCK',
        scope_status: 'PARTIAL_SCOPE',
        evidence_status: 'DEGRADED_EVIDENCE',
        rule_id: 'REVIEW_NOT_STARTED',
        reasons: ['REVIEW_NOT_STARTED'],
        clean: false,
      };
      const written = await persistence.writeFinalReviewArtifacts(paths, scopeFree);
      assert.equal((JSON.parse(await readFile(written.jsonPath, 'utf8')) as {
        verdict: { rule_id: string };
      }).verdict.rule_id, 'REVIEW_NOT_STARTED');

      const invalid: unknown[] = [];
      for (const verdict of [{ recommendation: 'APPROVE', clean: true }, {
        recommendation: 'APPROVE', clean: false,
      }, { recommendation: 'REQUEST CHANGES', clean: true }] as const) {
        const blocked = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
        blocked.status = 'BLOCKED';
        blocked.verdict.recommendation = verdict.recommendation;
        blocked.verdict.clean = verdict.clean;
        invalid.push(blocked);
      }
      for (const mutate of [
        (artifact: any) => { artifact.verdict.rule_id = 'INVALID_OR_MISSING_EVIDENCE'; },
        (artifact: any) => { artifact.verdict.reasons = ['MISSING_LANE']; },
        (artifact: any) => { artifact.verdict.scope_status = 'FULL_SCOPE'; },
        (artifact: any) => { artifact.verdict.evidence_status = 'FULL_EVIDENCE'; },
        (artifact: any) => { artifact.verdict.architectural_status = 'CLEAR'; },
      ]) {
        const malformed = structuredClone(scopeFree);
        malformed.review_id = persistence.generateReviewId();
        mutate(malformed);
        invalid.push(malformed);
      }
      for (const artifact of invalid) {
        await assert.rejects(
          persistence.writeFinalReviewArtifacts(paths, artifact),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
      }
    });
  });

  it('requires every FINALIZED lane to be complete even when the verdict is not clean', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const accepted: string[] = [];
      for (const status of ['FAILED', 'TIMED_OUT', 'INVALID', 'PENDING', 'RUNNING'] as const) {
        const artifact = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
        artifact.lanes[0].status = status;
        delete artifact.lanes[0].recommendation;
        if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'INVALID') {
          artifact.lanes[0].failure_code = `LANE_${status}`;
        }
        try {
          await persistence.writeFinalReviewArtifacts(paths, artifact);
          accepted.push(status);
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', status);
        }
      }
      assert.deepEqual(accepted, [], `accepted incomplete FINALIZED lanes: ${JSON.stringify(accepted)}`);

      const noChanges = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      const changedFile = structuredClone(noChanges.scope.files[0]);
      noChanges.scope.files = [];
      noChanges.scope.changed_lines = 0;
      noChanges.batches = [];
      noChanges.lanes = [];
      noChanges.diagnostics = [];
      noChanges.verdict = {
        recommendation: 'COMMENT',
        architectural_status: 'CLEAR',
        scope_status: 'FULL_SCOPE',
        evidence_status: 'FULL_EVIDENCE',
        rule_id: 'NO_CHANGES',
        reasons: ['No changed files require review.'],
        clean: true,
      };

      const invalidNoChanges = [
        ['missing scope', (artifact: any) => { delete artifact.scope; }],
        ['scope files', (artifact: any) => { artifact.scope.files = [changedFile]; }],
        ['changed lines', (artifact: any) => { artifact.scope.changed_lines = 1; }],
        ['batches', (artifact: any) => {
          artifact.batches = [{
            batch_id: 'unused-batch',
            module_root: '.',
            files: [],
            changed_lines: 0,
            oversized_single_file: false,
          }];
        }],
        ['rule', (artifact: any) => { artifact.verdict.rule_id = 'CLEAN'; }],
        ['approval', (artifact: any) => { artifact.verdict.recommendation = 'APPROVE'; }],
      ] as const;
      const acceptedNoChanges: string[] = [];
      for (const [label, mutate] of invalidNoChanges) {
        const artifact = structuredClone(noChanges);
        artifact.review_id = persistence.generateReviewId();
        mutate(artifact);
        try {
          await persistence.writeFinalReviewArtifacts(paths, artifact);
          acceptedNoChanges.push(label);
        } catch (error) {
          assert.equal((error as { code?: unknown }).code, 'PERSISTENCE_FAILED', label);
        }
      }
      assert.deepEqual(
        acceptedNoChanges,
        [],
        `accepted false zero-lane no-changes artifacts: ${JSON.stringify(acceptedNoChanges)}`,
      );
      await persistence.writeFinalReviewArtifacts(paths, noChanges);
    });
  });

  it('rejects duplicate or out-of-plan lanes, batches, scope hashes, and diagnostic references', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = persistence.generateReviewId();
      const base = finalArtifact(reviewId, workingDirectory) as any;
      const invalidArtifacts: unknown[] = [];

      const duplicateLane = structuredClone(base);
      duplicateLane.lanes.push(structuredClone(duplicateLane.lanes[0]));
      invalidArtifacts.push(duplicateLane);

      const duplicateBatch = structuredClone(base);
      duplicateBatch.batches.push(structuredClone(duplicateBatch.batches[0]));
      invalidArtifacts.push(duplicateBatch);

      const badArchitect = structuredClone(base);
      badArchitect.lanes[1].batch_id = 'batch-1';
      badArchitect.lanes[1].recommendation = 'APPROVE';
      invalidArtifacts.push(badArchitect);

      const badReviewer = structuredClone(base);
      badReviewer.lanes[0].batch_id = 'missing-batch';
      badReviewer.lanes[0].architectural_status = 'CLEAR';
      invalidArtifacts.push(badReviewer);

      const wrongScope = structuredClone(base);
      wrongScope.lanes[0].scope_hash = 'b'.repeat(64);
      invalidArtifacts.push(wrongScope);

      const danglingDiagnostic = structuredClone(base);
      danglingDiagnostic.lanes[0].diagnostic_ids = ['missing-diagnostic'];
      invalidArtifacts.push(danglingDiagnostic);

      const duplicateDiagnostic = structuredClone(base);
      duplicateDiagnostic.diagnostics.push(structuredClone(duplicateDiagnostic.diagnostics[0]));
      invalidArtifacts.push(duplicateDiagnostic);

      const duplicateDiagnosticRef = structuredClone(base);
      duplicateDiagnosticRef.lanes[0].diagnostic_ids.push('diagnostic-1');
      invalidArtifacts.push(duplicateDiagnosticRef);

      for (const invalid of invalidArtifacts) {
        await assert.rejects(
          persistence.writeFinalReviewArtifacts(paths, invalid),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
      }
    });
  });

  it('binds reviewer findings to an actual batch and architect evidence to the frozen scope', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = persistence.generateReviewId();
      const base = finalArtifact(reviewId, workingDirectory) as any;
      const finding = structuredClone(base.lanes[0].findings[0]);
      finding.body = 'Scoped finding.';
      finding.fix = 'Apply the scoped correction.';
      finding.evidence = 'bounded evidence';
      const invalidArtifacts: unknown[] = [];

      const globalReviewer = structuredClone(base);
      globalReviewer.lanes[0].batch_id = 'global';
      invalidArtifacts.push(globalReviewer);

      const reviewerOutsideScope = structuredClone(base);
      reviewerOutsideScope.lanes[0].findings[0].file = 'src/outside.ts';
      invalidArtifacts.push(reviewerOutsideScope);

      const reviewerOutsideBatch = structuredClone(base);
      reviewerOutsideBatch.scope.files.push({
        path: 'src/b.ts', change: 'MODIFIED', sources: ['WORKTREE'], binary: false,
        additions: 1, deletions: 0,
      });
      reviewerOutsideBatch.lanes[0].findings[0].file = 'src/b.ts';
      invalidArtifacts.push(reviewerOutsideBatch);

      const architectOutsideScope = structuredClone(base);
      architectOutsideScope.lanes[1].findings = [{ ...finding, file: 'src/outside.ts' }];
      invalidArtifacts.push(architectOutsideScope);

      const architectWithDiagnostic = structuredClone(base);
      architectWithDiagnostic.lanes[1].diagnostic_ids = ['diagnostic-1'];
      invalidArtifacts.push(architectWithDiagnostic);

      for (const invalid of invalidArtifacts) {
        await assert.rejects(
          persistence.writeFinalReviewArtifacts(paths, invalid),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
      }
    });
  });

  it('allows one 2 KiB diagnostic but rejects 2,049 bytes and more than 16 KiB in total across two lanes', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const contractModulePath: string = '../contract.js';
      const contract = await import(contractModulePath) as {
        REVIEW_LIMITS: Record<string, number>;
      };
      assert.equal(contract.REVIEW_LIMITS.diagnosticsTotalBytes, 16 * 1_024);
      assert.equal(contract.REVIEW_LIMITS.diagnosticsPerLane, undefined);

      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const accepted = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      accepted.diagnostics[0].summary = 'x'.repeat(2_048);
      await persistence.writeFinalReviewArtifacts(paths, accepted);

      const oversizedOne = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      oversizedOne.diagnostics[0].summary = 'x'.repeat(2_049);
      await assert.rejects(
        persistence.writeFinalReviewArtifacts(paths, oversizedOne),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );

      const oversizedTotal = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      oversizedTotal.lanes = [oversizedTotal.lanes[0], {
        ...structuredClone(oversizedTotal.lanes[0]),
        lane_id: 'reviewer-2',
      }];
      oversizedTotal.diagnostics = Array.from({ length: 9 }, (_, index) => ({
        ...structuredClone(oversizedTotal.diagnostics[0]),
        diagnostic_id: `diagnostic-${index + 1}`,
        summary: 'x'.repeat(1_900),
      }));
      oversizedTotal.lanes[0].diagnostic_ids = oversizedTotal.diagnostics.slice(0, 5)
        .map((diagnostic: { diagnostic_id: string }) => diagnostic.diagnostic_id);
      oversizedTotal.lanes[1].diagnostic_ids = oversizedTotal.diagnostics.slice(5)
        .map((diagnostic: { diagnostic_id: string }) => diagnostic.diagnostic_id);
      await assert.rejects(
        persistence.writeFinalReviewArtifacts(paths, oversizedTotal),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
    });
  });

  it('renders Markdown from the exact validated JSON bytes published on disk', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence, render } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = persistence.generateReviewId();
      const value = finalArtifact(reviewId, workingDirectory) as any;
      let hookCalled = false;

      const written = await persistence.writeFinalReviewArtifacts(paths, value, {
        afterJsonPublished: async (jsonPath) => {
          hookCalled = true;
          const published = JSON.parse(await readFile(jsonPath, 'utf8')) as any;
          assert.deepEqual(published.verdict.reasons, ['A high-severity finding remains.']);
          value.verdict.reasons = ['In-memory mutation must not control Markdown.'];
        },
      });

      const diskJson = JSON.parse(await readFile(written.jsonPath, 'utf8')) as unknown;
      const markdown = await readFile(written.markdownPath, 'utf8');
      assert.equal(hookCalled, true);
      assert.equal(markdown, render.renderFinalReviewMarkdown(diskJson));
      assert.match(markdown, /A high-severity finding remains\./u);
      assert.doesNotMatch(markdown, /In-memory mutation must not control Markdown/u);
    });
  });

  it('rejects invalid final paths and verdict enums before writing either artifact', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence, render } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = persistence.generateReviewId();
      const invalid = finalArtifact(reviewId, workingDirectory) as {
        lanes: Array<{ findings: Array<{ file: string }> }>;
        verdict: { recommendation: string };
      };
      invalid.lanes[0]!.findings[0]!.file = join(workingDirectory, 'src', 'a.ts');
      invalid.verdict.recommendation = 'APPROVED';

      assert.throws(
        () => render.renderFinalReviewMarkdown(invalid),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await assert.rejects(
        persistence.writeFinalReviewArtifacts(paths, invalid),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await assert.rejects(readFile(join(paths.reviewsRoot, `${reviewId}.json`), 'utf8'), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ));
      await assert.rejects(readFile(join(paths.reviewsRoot, `${reviewId}.md`), 'utf8'), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ));
    });
  });
});

describe('runtime-enforced review persistence regressions', () => {
  it('rejects fail-open BLOCKED verdicts in durable ReviewRecord revisions before PREPARED', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const invalidPayloads = [
        (reviewId: string) => ({
          ...reviewRecordPayload(reviewId, 2),
          status: 'BLOCKED',
          scope: reviewScope(),
          verdict: {
            recommendation: 'APPROVE', architectural_status: 'CLEAR',
            scope_status: 'FULL_SCOPE', evidence_status: 'FULL_EVIDENCE',
            rule_id: 'CLEAN_APPROVAL', reasons: ['ALL_REQUIRED_EVIDENCE_CLEAR'], clean: true,
          },
          finalized_at: '2026-07-14T00:00:00.000Z',
        }),
        (reviewId: string) => ({
          ...reviewRecordPayload(reviewId, 2),
          status: 'BLOCKED',
          verdict: {
            recommendation: 'REQUEST CHANGES', architectural_status: 'BLOCK',
            scope_status: 'PARTIAL_SCOPE', evidence_status: 'DEGRADED_EVIDENCE',
            rule_id: 'INVALID_OR_MISSING_EVIDENCE', reasons: ['MISSING_LANE'], clean: false,
          },
          finalized_at: '2026-07-14T00:00:00.000Z',
        }),
        (reviewId: string) => ({
          ...reviewRecordPayload(reviewId, 2),
          attempt_history: [{
            attempt: 1,
            status: 'BLOCKED',
            bindings: [],
            lane_ids: [],
            started_at: '2026-07-14T00:00:00.000Z',
            updated_at: '2026-07-14T00:00:00.000Z',
            verdict: {
              recommendation: 'APPROVE', architectural_status: 'CLEAR',
              scope_status: 'FULL_SCOPE', evidence_status: 'FULL_EVIDENCE',
              rule_id: 'CLEAN_APPROVAL', reasons: ['ALL_REQUIRED_EVIDENCE_CLEAR'], clean: true,
            },
            resumable: false,
          }],
        }),
      ];
      for (const makePayload of invalidPayloads) {
        const sessionId = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        await api.atomicWritePrivateJson(
          join(paths.reviewRoot, reviewId, 'review.json'),
          { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
        );
        const payload = { ...makePayload(reviewId), session_id: sessionId };
        await assert.rejects(
          api.runDurableTransaction(paths, {
            idempotency_key: key,
            review_id: reviewId,
            operation: 'INVALID_BLOCKED_TERMINAL',
            input: { review_id: reviewId },
            expected_revision: 1,
            effects: [{
              name: 'review', mode: 'APPLY_REVIEW_REVISION',
              target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
              payload,
            }],
            response: { review_id: reviewId, revision: 2 },
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
        await assert.rejects(
          readFile(join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'), 'utf8'),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      }
    });
  });

  it('replays an integrity-bound historical REVIEW transaction after a later lane revision', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const rootThreadId = 'root-thread-1';
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      const initial = {
        ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: rootThreadId,
      };
      await api.atomicWritePrivateJson(reviewPath, initial);

      const transactionAKey = api.generateReviewId();
      const publicationKey = api.generateReviewId();
      const planA = consumedPublicationPlan(
        api, reviewId, transactionAKey, publicationKey, workingDirectory, sessionId,
      );
      const originalA = await api.runDurableTransaction(paths, planA);
      const reviewAfterAText = await readFile(reviewPath, 'utf8');
      const reviewAfterA = JSON.parse(reviewAfterAText) as ReviewRecordSnapshot & {
        lanes: Array<{ recommendation?: string }>;
        last_applied_transaction_id?: string;
      };
      assert.deepEqual(await api.runDurableTransaction(paths, planA), originalA);

      const transactionBKey = api.generateReviewId();
      const reviewAfterB = structuredClone(reviewAfterA);
      delete reviewAfterB.last_applied_transaction_id;
      reviewAfterB.revision = 3;
      reviewAfterB.updated_at = '2026-07-14T00:00:01.000Z';
      reviewAfterB.lanes[0]!.recommendation = 'COMMENT';
      await api.runDurableTransaction(paths, {
        idempotency_key: transactionBKey,
        review_id: reviewId,
        operation: 'LATER_LANE_MUTATION',
        input: { review_id: reviewId, revision: 2 },
        expected_revision: 2,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewAfterB,
        }],
        response: { review_id: reviewId, revision: 3 },
      });
      const reviewAfterBText = await readFile(reviewPath, 'utf8');

      assert.deepEqual(await api.runDurableTransaction(paths, planA), originalA);
      const conflictingA = structuredClone(planA);
      conflictingA.response = { review_id: reviewId, revision: 2, tampered: true };
      await assert.rejects(
        api.runDurableTransaction(paths, conflictingA),
        (error: unknown) => (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT',
      );

      await api.atomicWritePrivateJson(reviewPath, initial);
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      const changedSameRevision = structuredClone(reviewAfterA);
      changedSameRevision.updated_at = '2026-07-14T00:00:02.000Z';
      await api.atomicWritePrivateJson(reviewPath, changedSameRevision);
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      const wrongTransaction = structuredClone(reviewAfterA);
      wrongTransaction.last_applied_transaction_id = api.generateReviewId();
      await api.atomicWritePrivateJson(reviewPath, wrongTransaction);
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );

      const wrongOwner = JSON.parse(reviewAfterBText) as Record<string, unknown>;
      wrongOwner.session_id = api.generateReviewId();
      await api.atomicWritePrivateJson(reviewPath, wrongOwner);
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      const wrongTopology = JSON.parse(reviewAfterBText) as { lanes: unknown[] };
      wrongTopology.lanes.push(structuredClone(wrongTopology.lanes[0]));
      await api.atomicWritePrivateJson(reviewPath, wrongTopology);
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await writeFile(reviewPath, reviewAfterBText, { mode: 0o600 });

      const transactionRoot = join(paths.reviewRoot, reviewId, 'transactions', transactionAKey);
      const committedPath = join(transactionRoot, 'committed');
      const committedText = await readFile(committedPath, 'utf8');
      const tamperedCommitted = JSON.parse(committedText) as Record<string, unknown>;
      tamperedCommitted.response = { tampered: true };
      await writeFile(committedPath, `${JSON.stringify(tamperedCommitted, null, 2)}\n`, { mode: 0o600 });
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await writeFile(committedPath, committedText, { mode: 0o600 });

      const preparedPath = join(transactionRoot, 'prepared');
      const preparedText = await readFile(preparedPath, 'utf8');
      const tamperedPrepared = JSON.parse(preparedText) as Record<string, unknown>;
      tamperedPrepared.operation = 'TAMPERED_HISTORICAL_OPERATION';
      await writeFile(preparedPath, `${JSON.stringify(tamperedPrepared, null, 2)}\n`, { mode: 0o600 });
      await assert.rejects(
        api.runDurableTransaction(paths, planA),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await writeFile(preparedPath, preparedText, { mode: 0o600 });
      assert.deepEqual(await api.runDurableTransaction(paths, planA), originalA);
      assert.equal(await readFile(reviewPath, 'utf8'), reviewAfterBText);
    });
  });

  it('serializes trusted plan factories without a snapshot-to-commit lock gap', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const rootThreadId = 'root-thread-1';
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
        ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: rootThreadId,
      });

      let releaseFirst!: () => void;
      const firstMayReturn = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
      let concurrentFactories = 0;
      let maxConcurrentFactories = 0;
      const observedRevisions: number[] = [];
      const keys = [api.generateReviewId(), api.generateReviewId()];
      const runFactory = (index: number) => api.runDurableReviewTransactionWithPlanFactory(paths, {
        review_id: reviewId,
        session_id: sessionId,
        root_thread_id: rootThreadId,
        plan_factory: async ({ current_review }) => {
          concurrentFactories += 1;
          maxConcurrentFactories = Math.max(maxConcurrentFactories, concurrentFactories);
          observedRevisions.push(current_review.revision);
          if (index === 0) {
            await assert.rejects(
              api.acquireReviewLocks(paths, reviewId, ['journal'], { timeoutMs: 0 }),
              (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
            );
            await assert.rejects(
              api.acquireReviewLocks(paths, reviewId, ['mutation'], { timeoutMs: 0 }),
              (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
            );
            markFirstEntered();
            await firstMayReturn;
          }
          concurrentFactories -= 1;
          return trustedFactoryRevisionPlan(current_review, keys[index]!);
        },
      });

      const first = runFactory(0);
      await firstEntered;
      const second = runFactory(1);
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.equal(maxConcurrentFactories, 1);
      assert.deepEqual(observedRevisions, [1, 2]);
      assert.equal(firstResult.transaction?.state, 'COMMITTED');
      assert.equal(secondResult.transaction?.state, 'COMMITTED');
      assert.equal(firstResult.review.revision, 2);
      assert.equal(secondResult.review.revision, 3);
    });
  });

  it('makes undefined a deep-cloned no-op and releases both locks when the trusted factory throws', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const rootThreadId = 'root-thread-1';
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      await api.atomicWritePrivateJson(reviewPath, {
        ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: rootThreadId,
      });

      const noOp = await api.runDurableReviewTransactionWithPlanFactory(paths, {
        review_id: reviewId,
        session_id: sessionId,
        root_thread_id: rootThreadId,
        plan_factory: async ({ current_review }) => {
          current_review.status = 'BLOCKED';
          return undefined;
        },
      });
      assert.equal(noOp.transaction, undefined);
      assert.equal(noOp.review.revision, 1);
      assert.equal(noOp.review.status, 'REVIEWING');
      assert.equal((JSON.parse(await readFile(reviewPath, 'utf8')) as { status: string }).status, 'REVIEWING');

      const thrown = new Error('trusted factory failed');
      await assert.rejects(
        api.runDurableReviewTransactionWithPlanFactory(paths, {
          review_id: reviewId,
          session_id: sessionId,
          root_thread_id: rootThreadId,
          plan_factory: async () => { throw thrown; },
        }),
        (error: unknown) => error === thrown,
      );
      const reacquired = await api.acquireReviewLocks(paths, reviewId, ['journal', 'mutation'], { timeoutMs: 0 });
      assert.deepEqual(reacquired.map((lock) => lock.name), ['journal', 'mutation']);
      await api.releaseReviewLocks(reacquired);
      assert.deepEqual(await readdir(join(paths.reviewRoot, reviewId, 'transactions')).catch(() => []), []);
    });
  });

  it('rejects stale, START, mismatched, and wrong-owner factory plans before PREPARED', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const rootThreadId = 'root-thread-1';
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
        ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: rootThreadId,
      });

      let wrongIdentityFactoryCalled = false;
      await assert.rejects(
        api.runDurableReviewTransactionWithPlanFactory(paths, {
          review_id: reviewId,
          session_id: api.generateReviewId(),
          root_thread_id: rootThreadId,
          plan_factory: async () => {
            wrongIdentityFactoryCalled = true;
            return undefined;
          },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      assert.equal(wrongIdentityFactoryCalled, false);

      const wrongReviewId = api.generateReviewId();
      const cases: Array<(current: ReviewRecordSnapshot) => DurablePlan> = [
        (current) => ({
          ...trustedFactoryRevisionPlan(current, api.generateReviewId()),
          journal_scope: 'START',
        }),
        (current) => trustedFactoryRevisionPlan({ ...current, review_id: wrongReviewId }, api.generateReviewId()),
        (current) => {
          const plan = trustedFactoryRevisionPlan(current, api.generateReviewId());
          plan.expected_revision = 0;
          (plan.effects[0]!.payload as ReviewRecordSnapshot).revision = 1;
          return plan;
        },
        (current) => {
          const plan = trustedFactoryRevisionPlan(current, api.generateReviewId());
          (plan.effects[0]!.payload as ReviewRecordSnapshot).root_thread_id = 'other-root';
          return plan;
        },
        (current) => {
          const plan = trustedFactoryRevisionPlan(current, api.generateReviewId());
          const proposed = plan.effects[0]!.payload as Record<string, any>;
          proposed.effective_config.accepted_equivalents = [{
            capability: 'AST', program: 'node', args: ['scripts/ast-check.mjs'],
            source: 'REPO_CONTRACT', source_ref: 'trusted-rule',
          }];
          return plan;
        },
      ];
      for (const makePlan of cases) {
        await assert.rejects(
          api.runDurableReviewTransactionWithPlanFactory(paths, {
            review_id: reviewId,
            session_id: sessionId,
            root_thread_id: rootThreadId,
            plan_factory: async ({ current_review }) => makePlan(current_review),
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
      }
      assert.deepEqual(await readdir(paths.startTransactionsRoot).catch(() => []), []);
      assert.deepEqual(await readdir(join(paths.reviewRoot, reviewId, 'transactions')).catch(() => []), []);
      assert.deepEqual(await readdir(join(paths.reviewRoot, wrongReviewId, 'transactions')).catch(() => []), []);
    });
  });

  it('recovers a locator-less factory transaction before taking the next trusted snapshot', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const crashModes = ['THROW', 'ABORT'] as const;
      for (const crashMode of crashModes) {
        const sessionId = api.generateReviewId();
        const rootThreadId = 'root-thread-1';
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const currentReview = {
          ...reviewRecordPayload(reviewId, 1),
          session_id: sessionId,
          root_thread_id: rootThreadId,
        } as ReviewRecordSnapshot;
        const plan = trustedFactoryRevisionPlan(currentReview, key);
        await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), currentReview);
        assert.equal(await api.readActiveReview(paths), null);

        if (crashMode === 'THROW') {
          await assert.rejects(
            api.runDurableReviewTransactionWithPlanFactory(paths, {
              review_id: reviewId,
              session_id: sessionId,
              root_thread_id: rootThreadId,
              plan_factory: async () => plan,
            }, { crashAt: 'after:prepared', crashMode }),
            /injected crash at after:prepared/u,
          );
        } else {
          await runAbruptFactoryTransaction(workingDirectory, sessionId, rootThreadId, plan);
        }

        const transactionRoot = join(paths.reviewRoot, reviewId, 'transactions', key);
        assert.equal((JSON.parse(await readFile(join(transactionRoot, 'prepared'), 'utf8')) as {
          state: string;
        }).state, 'PREPARED');
        await assert.rejects(
          readFile(join(transactionRoot, 'committed'), 'utf8'),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
        assert.deepEqual(await readdir(paths.pendingReviewTransactionsRoot).catch(() => []), []);
        assert.equal((JSON.parse(await readFile(
          join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
        )) as { revision: number }).revision, 1);

        const observedRevisions: number[] = [];
        const recovered = await api.runDurableReviewTransactionWithPlanFactory(paths, {
          review_id: reviewId,
          session_id: sessionId,
          root_thread_id: rootThreadId,
          plan_factory: async ({ current_review }) => {
            observedRevisions.push(current_review.revision);
            return undefined;
          },
        });
        assert.deepEqual(observedRevisions, [2], crashMode);
        assert.equal(recovered.transaction, undefined);
        assert.equal(recovered.review.revision, 2);
        assert.equal((JSON.parse(await readFile(join(transactionRoot, 'committed'), 'utf8')) as {
          state: string;
        }).state, 'COMMITTED');
        assert.deepEqual(await readdir(paths.pendingReviewTransactionsRoot).catch(() => []), []);
        assert.equal(await api.readActiveReview(paths), null);
      }
    });
  });

  it('replays the original START response after its transaction directory was cleaned', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const plan: DurablePlan = {
        journal_scope: 'START',
        idempotency_key: key,
        review_id: reviewId,
        operation: 'START_RECEIPT_REPLAY',
        input: { review_id: reviewId },
        expected_revision: 0,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: reviewRecordPayload(reviewId, 1),
        }, {
          name: 'active-overlay', mode: 'CREATE_ONCE_JSON',
          target: { area: 'REVIEW_STATE', path: 'active.json' },
          payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
        }],
        response: { review_id: reviewId, revision: 1, stable: true },
      };

      const first = await api.runDurableTransaction(paths, plan);
      assert.deepEqual(await readdir(paths.startTransactionsRoot).catch(() => []), []);
      assert.deepEqual(await api.runDurableTransaction(paths, plan), first);
    });
  });

  it('rejects a READY_TO_SYNTHESIZE to CREATED active-state regression before PREPARED', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      await api.claimActiveReview(paths, {
        schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE',
      });
      await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
        ...reviewRecordPayload(reviewId, 1), status: 'READY_TO_SYNTHESIZE',
      });

      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'REGRESS_ACTIVE_STATE',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 2), status: 'CREATED' },
        }, {
          name: 'active-overlay', mode: 'UPDATE_MATCHING_ACTIVE',
          target: { area: 'REVIEW_STATE', path: 'active.json' },
          payload: { schema_version: 1, review_id: reviewId, status: 'CREATED' },
          review_id: reviewId,
          expected_status: 'READY_TO_SYNTHESIZE',
          expected_revision: 1,
        }],
        response: { ok: false },
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
      await assert.rejects(
        readFile(join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'), 'utf8'),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    });
  });

  it('rejects complete consumption triples that are not bound to their proposal and post-tool pair', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const transactionKey = api.generateReviewId();
      const publicationKey = api.generateReviewId();
      const now = '2026-07-14T00:00:00.000Z';
      const pair = durableEffects(reviewId, publicationKey, workingDirectory, {
        sessionId, rootThreadId: 'root-thread-1',
      }).slice(0, 2);
      const markers = (['PROPOSAL_KEY', 'TOOL_EVENT_REF', 'NONCE'] as const).map((kind) => (
        api.createReviewConsumptionEffect({
          review_id: reviewId,
          idempotency_key: transactionKey,
          kind,
          value: `unbound-${kind}`,
          consumed_at: now,
        })
      ));
      await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
        ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: 'root-thread-1',
      });

      await assert.rejects(api.runDurableTransaction(paths, {
        idempotency_key: transactionKey,
        review_id: reviewId,
        operation: 'UNBOUND_COMPLETE_TRIPLE',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [...pair, ...markers, {
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...reviewRecordPayload(reviewId, 2),
            session_id: sessionId,
            root_thread_id: 'root-thread-1',
          },
        }],
        response: { ok: false },
      }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED');
    });
  });

  it('renders the sanctioned diagnostic-degraded complete reviewer result but rejects degraded approval', async () => {
    await withWorkspace(async (workingDirectory) => {
      const { persistence } = await loadFinalArtifactApi();
      const paths = await persistence.resolveReviewPersistencePaths({ workingDirectory });
      const degraded = finalArtifact(persistence.generateReviewId(), workingDirectory) as any;
      degraded.lanes[0].failure_code = 'DIAGNOSTIC_DEGRADED';
      degraded.lanes[0].recommendation = 'COMMENT';
      degraded.diagnostics[0].execution = 'FALLBACK';
      degraded.diagnostics[0].outcome = 'PASS';
      await persistence.writeFinalReviewArtifacts(paths, degraded);

      const approve = structuredClone(degraded);
      approve.review_id = persistence.generateReviewId();
      approve.lanes[0].recommendation = 'APPROVE';
      await assert.rejects(
        persistence.writeFinalReviewArtifacts(paths, approve),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );

      const durableReviewId = persistence.generateReviewId();
      await persistence.atomicWritePrivateJson(
        join(paths.reviewRoot, durableReviewId, 'review.json'),
        reviewRecordPayload(durableReviewId, 1),
      );
      const durableDegraded = reviewRecordWithTopology(durableReviewId, 2) as any;
      durableDegraded.lanes[0].failure_code = 'DIAGNOSTIC_DEGRADED';
      durableDegraded.lanes[0].recommendation = 'COMMENT';
      await persistence.runDurableTransaction(paths, {
        idempotency_key: persistence.generateReviewId(),
        review_id: durableReviewId,
        operation: 'PERSIST_TASK5_DEGRADED_RESULT',
        input: { review_id: durableReviewId },
        expected_revision: 1,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${durableReviewId}/review.json` },
          payload: durableDegraded,
        }],
        response: { review_id: durableReviewId, revision: 2 },
      });
      const persisted = JSON.parse(await readFile(
        join(paths.reviewRoot, durableReviewId, 'review.json'), 'utf8',
      )) as any;
      assert.deepEqual({
        status: persisted.lanes[0].status,
        failure_code: persisted.lanes[0].failure_code,
        recommendation: persisted.lanes[0].recommendation,
      }, {
        status: 'COMPLETE', failure_code: 'DIAGNOSTIC_DEGRADED', recommendation: 'COMMENT',
      });
    });
  });

  it('reads only complete manifest-bound consumption groups and fails closed on deletion, extras, and temp state', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const transactionKey = api.generateReviewId();
      const publicationKey = api.generateReviewId();
      await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
        ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: 'root-thread-1',
      });
      const plan = consumedPublicationPlan(
        api, reviewId, transactionKey, publicationKey, workingDirectory, sessionId,
      );
      await api.runDurableTransaction(paths, plan);
      const groups = await api.readReviewConsumptionGroups(paths, reviewId);
      assert.deepEqual(
        groups.map((group) => ({
          key: group.manifest.idempotency_key,
          count: group.manifest.publication_count,
          markers: group.markers.length,
        })),
        [{ key: transactionKey, count: 1, markers: 3 }],
      );

      const markerEffect = plan.effects.find((effect) => (
        effect.name === 'consume' && (effect.payload as { kind?: unknown }).kind === 'NONCE'
      ))!;
      const markerPath = join(paths.reviewRoot, markerEffect.target.path);
      const markerText = await readFile(markerPath, 'utf8');
      await rm(markerPath);
      await assert.rejects(
        api.readReviewConsumptionGroups(paths, reviewId),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await writeFile(markerPath, markerText, { mode: 0o600 });

      const marker = JSON.parse(markerText) as ReviewConsumptionMarker;
      const extraDigest = 'f'.repeat(64);
      const extraPath = join(markerPath, '..', `${extraDigest}.json`);
      await api.atomicWritePrivateJson(extraPath, { ...marker, value_sha256: extraDigest });
      await assert.rejects(
        api.readReviewConsumptionGroups(paths, reviewId),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await rm(extraPath);

      const tempPath = join(
        paths.reviewRoot,
        reviewId,
        'consumptions',
        'manifests',
        `.${transactionKey}.json.tmp-${process.pid}-${api.generateReviewId()}`,
      );
      await writeFile(tempPath, '{}\n', { mode: 0o600 });
      await assert.rejects(
        api.readReviewConsumptionGroups(paths, reviewId),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
    });
  });

  it('accepts exactly sixteen publication groups without letting the effect cap admit seventeen', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const buildPlan = (
        reviewId: string,
        transactionKey: string,
        sessionId: string,
        groupCount: number,
      ): DurablePlan => {
        const now = '2026-07-14T00:00:00.000Z';
        const pairs: DurableEffect[] = [];
        const markers: DurableEffect[] = [];
        const lanes: Array<Record<string, unknown>> = [];
        for (let index = 0; index < groupCount; index += 1) {
          const publicationKey = api.generateReviewId();
          const laneId = `reviewer-${index + 1}`;
          const eventRef = `events/result-post-tool-${index + 1}.json`;
          const pair = structuredClone(durableEffects(
            reviewId,
            publicationKey,
            workingDirectory,
            { sessionId, rootThreadId: 'root-thread-1' },
          ).slice(0, 2)) as any[];
          pair[0].payload.lane_id = laneId;
          pair[0].payload.result.lane_id = laneId;
          pair[1].payload.activity.lane_id = laneId;
          pair[1].payload.activity.child_thread_id = `child-${index + 1}`;
          pair[1].payload.activity.event_ref = eventRef;
          pair[1].payload.attestation.lane_id = laneId;
          pair[1].payload.attestation.child_thread_id = `child-${index + 1}`;
          pair[1].payload.attestation.tool_event_ref = eventRef;
          pairs.push(...pair as DurableEffect[]);
          markers.push(...([
            ['PROPOSAL_KEY', publicationKey],
            ['TOOL_EVENT_REF', eventRef],
            ['NONCE', publicationKey],
          ] as const).map(([kind, value]) => api.createReviewConsumptionEffect({
            review_id: reviewId,
            idempotency_key: transactionKey,
            kind,
            value,
            consumed_at: now,
          })));
          lanes.push({
            lane_id: laneId,
            role: 'code-reviewer',
            batch_id: 'batch-1',
            scope_hash: 'a'.repeat(64),
            status: 'COMPLETE',
            attempt: 1,
            timeout_ms: 30_000,
            idle_deadline_at: now,
            recommendation: 'REQUEST CHANGES',
            findings: [],
            diagnostic_ids: [],
          });
        }
        return {
          idempotency_key: transactionKey,
          review_id: reviewId,
          operation: `BOUND_${groupCount}_PUBLICATIONS`,
          input: { review_id: reviewId, group_count: groupCount },
          expected_revision: 1,
          effects: [...pairs, ...markers, {
            name: 'review', mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: {
              ...reviewRecordPayload(reviewId, 2),
              session_id: sessionId,
              root_thread_id: 'root-thread-1',
              scope: reviewScope(),
              batches: [{
                batch_id: 'batch-1', module_root: '.', files: ['src/a.ts'],
                changed_lines: 1, oversized_single_file: false,
              }],
              lanes,
            },
          }],
          response: { review_id: reviewId, revision: 2, group_count: groupCount },
        };
      };

      const acceptedSessionId = api.generateReviewId();
      const acceptedPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: acceptedSessionId,
      });
      const acceptedReviewId = api.generateReviewId();
      const acceptedKey = api.generateReviewId();
      await api.atomicWritePrivateJson(join(acceptedPaths.reviewRoot, acceptedReviewId, 'review.json'), {
        ...reviewRecordPayload(acceptedReviewId, 1),
        session_id: acceptedSessionId,
        root_thread_id: 'root-thread-1',
      });
      await api.runDurableTransaction(
        acceptedPaths,
        buildPlan(acceptedReviewId, acceptedKey, acceptedSessionId, 16),
      );
      const [group] = await api.readReviewConsumptionGroups(acceptedPaths, acceptedReviewId);
      assert.deepEqual({
        publications: group?.manifest.publication_count,
        markers: group?.markers.length,
      }, { publications: 16, markers: 48 });

      const rejectedSessionId = api.generateReviewId();
      const rejectedPaths = await api.resolveReviewPersistencePaths({
        workingDirectory, session_id: rejectedSessionId,
      });
      const rejectedReviewId = api.generateReviewId();
      const rejectedKey = api.generateReviewId();
      await api.atomicWritePrivateJson(join(rejectedPaths.reviewRoot, rejectedReviewId, 'review.json'), {
        ...reviewRecordPayload(rejectedReviewId, 1),
        session_id: rejectedSessionId,
        root_thread_id: 'root-thread-1',
      });
      await assert.rejects(
        api.runDurableTransaction(
          rejectedPaths,
          buildPlan(rejectedReviewId, rejectedKey, rejectedSessionId, 17),
        ),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
      await assert.rejects(
        readFile(join(rejectedPaths.reviewRoot, rejectedReviewId, 'transactions', rejectedKey, 'prepared'), 'utf8'),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    });
  });

  it('rejects non-resumable, reason-conflicting, and wrong-attempt active restoration', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const now = '2026-07-14T00:00:00.000Z';
      const cases = [
        {
          label: 'resumable false',
          mutateCurrent: (review: any) => {
            review.resumable = false;
            delete review.resumable_reason;
            review.attempt_history[0].resumable = false;
            delete review.attempt_history[0].resumable_reason;
          },
          mutateProposed: (_review: any) => undefined,
        },
        {
          label: 'reason conflict',
          mutateCurrent: (review: any) => { review.resumable_reason = 'MISSING_LANE'; },
          mutateProposed: (_review: any) => undefined,
        },
        {
          label: 'wrong attempt',
          mutateCurrent: (_review: any) => undefined,
          mutateProposed: (review: any) => {
            review.current_attempt = 3;
            review.attempt_history[1].attempt = 3;
          },
        },
      ];
      for (const testCase of cases) {
        const paths = await api.resolveReviewPersistencePaths({
          workingDirectory, session_id: api.generateReviewId(),
        });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        const blockedAttempt = {
          attempt: 1, status: 'BLOCKED', bindings: [], lane_ids: [],
          started_at: now, updated_at: now, resumable: true, resumable_reason: 'LANE_FAILED',
        };
        const current: any = {
          ...reviewRecordPayload(reviewId, 1), status: 'BLOCKED', resumable: true,
          resumable_reason: 'LANE_FAILED', attempt_history: [blockedAttempt],
          session_id: paths.session_id,
        };
        const proposed: any = {
          ...reviewRecordPayload(reviewId, 2), current_attempt: 2,
          attempt_history: [blockedAttempt, {
            attempt: 2, status: 'REVIEWING', bindings: [], lane_ids: [],
            started_at: now, updated_at: now, resumable: false,
          }],
          session_id: paths.session_id,
        };
        testCase.mutateCurrent(current);
        testCase.mutateProposed(proposed);
        await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), current);
        await assert.rejects(api.runDurableTransaction(paths, {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'INVALID_RESTORE',
          input: { label: testCase.label },
          expected_revision: 1,
          effects: [{
            name: 'review', mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
            payload: proposed,
          }, {
            name: 'active-overlay', mode: 'RESTORE_MISSING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
            review_id: reviewId, expected_status: 'BLOCKED', expected_revision: 1,
          }],
          response: { ok: false },
        }), (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED', testCase.label);
        await assert.rejects(
          readFile(join(paths.reviewRoot, reviewId, 'transactions', key, 'prepared'), 'utf8'),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      }
    });
  });

  it('survives abrupt termination after START locator cleanup using its committed receipt', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const plan: DurablePlan = {
        journal_scope: 'START',
        idempotency_key: key,
        review_id: reviewId,
        operation: 'SIGKILL_START_RECEIPT',
        input: { review_id: reviewId },
        expected_revision: 0,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
        }],
        response: { review_id: reviewId, revision: 1, original: true },
      };
      await runAbruptTransaction(workingDirectory, sessionId, plan, 'after:locator-cleanup');
      assert.deepEqual(await readdir(paths.startTransactionsRoot).catch(() => []), []);
      assert.deepEqual(await api.runDurableTransaction(paths, plan), {
        state: 'COMMITTED', response: plan.response,
      });
      assert.deepEqual(await readdir(paths.startReceiptsRoot), [`${key}.json`]);

      await api.runDurableTransaction(paths, {
        idempotency_key: api.generateReviewId(), review_id: reviewId,
        operation: 'ADVANCE_AFTER_RECEIPT', input: { review_id: reviewId }, expected_revision: 1,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 2), session_id: sessionId },
        }],
        response: { revision: 2 },
      });
      assert.deepEqual((await api.runDurableTransaction(paths, plan)).response, plan.response);
      await assert.rejects(
        api.runDurableTransaction(paths, { ...plan, input: { review_id: reviewId, conflict: true } }),
        (error: unknown) => (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT',
      );
    });
  });

  it('fails closed on rolled-back, missing, malformed, duplicate, hidden, or wrong-identity START receipts', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const plan: DurablePlan = {
        journal_scope: 'START', idempotency_key: key, review_id: reviewId,
        operation: 'START_RECEIPT_INTEGRITY', input: { review_id: reviewId }, expected_revision: 0,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
        }],
        response: { review_id: reviewId, revision: 1 },
      };
      await api.runDurableTransaction(paths, plan);
      const receiptPath = join(paths.startReceiptsRoot, `${key}.json`);
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      const receiptText = await readFile(receiptPath, 'utf8');
      const reviewText = await readFile(reviewPath, 'utf8');
      const rejectsScan = async (): Promise<void> => {
        await assert.rejects(
          api.recoverPendingReviewTransactions(paths),
          (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        );
      };

      await rm(reviewPath);
      await rejectsScan();
      await writeFile(reviewPath, reviewText, { mode: 0o600 });

      const revisionZero = { ...(JSON.parse(reviewText) as Record<string, unknown>), revision: 0 };
      await writeFile(reviewPath, `${JSON.stringify(revisionZero)}\n`, { mode: 0o600 });
      await rejectsScan();
      await writeFile(reviewPath, reviewText, { mode: 0o600 });

      const wrongIdentity = {
        ...(JSON.parse(receiptText) as Record<string, unknown>), review_id: api.generateReviewId(),
      };
      await writeFile(receiptPath, `${JSON.stringify(wrongIdentity)}\n`, { mode: 0o600 });
      await rejectsScan();
      await writeFile(receiptPath, receiptText, { mode: 0o600 });

      await writeFile(receiptPath, '{}\n', { mode: 0o600 });
      await rejectsScan();
      await writeFile(receiptPath, receiptText, { mode: 0o600 });

      const duplicatePath = join(paths.startReceiptsRoot, `${api.generateReviewId()}.json`);
      await writeFile(duplicatePath, receiptText, { mode: 0o600 });
      await rejectsScan();
      await rm(duplicatePath);

      const hiddenPath = join(
        paths.startReceiptsRoot,
        `.${key}.json.tmp-${process.pid}-${api.generateReviewId()}`,
      );
      await writeFile(hiddenPath, '{}\n', { mode: 0o600 });
      await rejectsScan();
    });
  });

  it('binds the committed START receipt response even after the review advances', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const originalResponse = { review_id: reviewId, revision: 1, original: true };
      const plan: DurablePlan = {
        journal_scope: 'START', idempotency_key: key, review_id: reviewId,
        operation: 'START_RECEIPT_RESPONSE_BINDING', input: { review_id: reviewId }, expected_revision: 0,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 1), session_id: sessionId },
        }],
        response: originalResponse,
      };
      await api.runDurableTransaction(paths, plan);
      await api.runDurableTransaction(paths, {
        idempotency_key: api.generateReviewId(), review_id: reviewId,
        operation: 'ADVANCE_RECEIPT_REVIEW', input: { review_id: reviewId }, expected_revision: 1,
        effects: [{
          name: 'review', mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: { ...reviewRecordPayload(reviewId, 2), session_id: sessionId },
        }],
        response: { review_id: reviewId, revision: 2 },
      });
      const receiptPath = join(paths.startReceiptsRoot, `${key}.json`);
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
      receipt.response = { review_id: reviewId, revision: 1, original: false };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

      await assert.rejects(
        api.runDurableTransaction(paths, plan),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
    });
  });

  it('recovers active UPDATE, REMOVE, and RESTORE transitions after abrupt termination', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const now = '2026-07-14T00:00:00.000Z';
      for (const mode of ['UPDATE', 'REMOVE', 'RESTORE'] as const) {
        const sessionId = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        const reviewId = api.generateReviewId();
        const key = api.generateReviewId();
        let current: any;
        let proposed: any;
        let activeEffect: DurableEffect;
        if (mode === 'UPDATE') {
          current = { ...reviewRecordPayload(reviewId, 1), session_id: sessionId };
          proposed = { ...reviewRecordPayload(reviewId, 2), session_id: sessionId, status: 'READY_TO_SYNTHESIZE' };
          await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
          activeEffect = {
            name: 'active-overlay', mode: 'UPDATE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE' },
            review_id: reviewId, expected_status: 'REVIEWING', expected_revision: 1,
          };
        } else if (mode === 'REMOVE') {
          current = { ...reviewRecordPayload(reviewId, 1), session_id: sessionId, status: 'READY_TO_SYNTHESIZE' };
          proposed = { ...reviewRecordPayload(reviewId, 2), session_id: sessionId, status: 'FINALIZED' };
          await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'READY_TO_SYNTHESIZE' });
          activeEffect = {
            name: 'active-overlay', mode: 'REMOVE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            review_id: reviewId, expected_status: 'READY_TO_SYNTHESIZE', expected_revision: 1,
          };
        } else {
          const blockedAttempt = {
            attempt: 1, status: 'BLOCKED', bindings: [], lane_ids: [],
            started_at: now, updated_at: now, resumable: true, resumable_reason: 'LANE_FAILED',
          };
          current = {
            ...reviewRecordPayload(reviewId, 1), session_id: sessionId, status: 'BLOCKED',
            resumable: true, resumable_reason: 'LANE_FAILED', attempt_history: [blockedAttempt],
          };
          proposed = {
            ...reviewRecordPayload(reviewId, 2), session_id: sessionId, current_attempt: 2,
            attempt_history: [blockedAttempt, {
              attempt: 2, status: 'REVIEWING', bindings: [], lane_ids: [],
              started_at: now, updated_at: now, resumable: false,
            }],
          };
          activeEffect = {
            name: 'active-overlay', mode: 'RESTORE_MISSING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
            review_id: reviewId, expected_status: 'BLOCKED', expected_revision: 1,
          };
        }
        await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), current);
        const plan: DurablePlan = {
          idempotency_key: key, review_id: reviewId, operation: `SIGKILL_ACTIVE_${mode}`,
          input: { review_id: reviewId }, expected_revision: 1,
          effects: [{
            name: 'review', mode: 'APPLY_REVIEW_REVISION',
            target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` }, payload: proposed,
          }, activeEffect],
          response: { review_id: reviewId, revision: 2 },
        };
        await runAbruptTransaction(workingDirectory, sessionId, plan, 'after:active-overlay');
        await api.recoverPendingReviewTransactions(paths);
        const active = await api.readActiveReview(paths);
        assert.equal(active?.status ?? null, mode === 'REMOVE' ? null : proposed.status, mode);
        const review = JSON.parse(await readFile(join(paths.reviewRoot, reviewId, 'review.json'), 'utf8')) as any;
        assert.deepEqual({ revision: review.revision, status: review.status }, {
          revision: 2, status: proposed.status,
        }, mode);
      }
    });
  });

  it('recovers batched consumption across PREPARED, manifest, and COMMITTED abrupt boundaries', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      for (const crashAt of ['after:prepared', 'after:manifest', 'after:committed'] as const) {
        const sessionId = api.generateReviewId();
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        const reviewId = api.generateReviewId();
        const transactionKey = api.generateReviewId();
        const publicationKey = api.generateReviewId();
        await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
        await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
          ...reviewRecordPayload(reviewId, 1), session_id: sessionId, root_thread_id: 'root-thread-1',
        });
        const plan = consumedPublicationPlan(
          api, reviewId, transactionKey, publicationKey, workingDirectory, sessionId,
        );
        await runAbruptTransaction(workingDirectory, sessionId, plan, crashAt);
        if (crashAt === 'after:manifest') {
          await assert.rejects(
            api.readReviewConsumptionGroups(paths, reviewId),
            (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
          );
        }
        await api.recoverPendingReviewTransactions(paths);
        const groups = await api.readReviewConsumptionGroups(paths, reviewId);
        assert.deepEqual(groups.map((group) => ({
          key: group.manifest.idempotency_key,
          count: group.manifest.publication_count,
          markers: group.markers.length,
        })), [{ key: transactionKey, count: 1, markers: 3 }], crashAt);
      }
    });
  });
});
