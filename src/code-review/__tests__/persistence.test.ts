import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ReviewPersistencePaths {
  reviewRoot: string;
  activePath: string;
  startLockPath: string;
  journalLockPath: string;
  mutationLockPath: string;
  reviewsRoot: string;
}

interface PersistenceApi {
  generateReviewId(): string;
  resolveReviewPersistencePaths(input: {
    workingDirectory: string;
    session_id?: string;
  }): Promise<ReviewPersistencePaths>;
  claimActiveReview(
    paths: ReviewPersistencePaths,
    pointer: { schema_version: 1; review_id: string; status: 'REVIEWING' },
  ): Promise<void>;
  readActiveReview(paths: ReviewPersistencePaths): Promise<{ review_id: string } | null>;
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
  acquireReviewLocks(
    paths: ReviewPersistencePaths,
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
    },
  ): Promise<ReviewLockHandle[]>;
  releaseReviewLocks(handles: readonly ReviewLockHandle[]): Promise<boolean[]>;
}

type DurableStage =
  | 'prepared'
  | 'locator'
  | 'proposal'
  | 'post-tool'
  | 'consume'
  | 'lane'
  | 'review'
  | 'report'
  | 'active-overlay'
  | 'approval'
  | 'stop-marker'
  | 'committed'
  | 'locator-cleanup';

type DurableBoundary = `before:${DurableStage}` | `after:${DurableStage}`;

interface DurableEffect {
  name: Exclude<DurableStage, 'prepared' | 'locator' | 'committed' | 'locator-cleanup'>;
  mode: 'CREATE_ONCE_JSON' | 'APPLY_REVIEW_REVISION' | 'REMOVE_MATCHING_ACTIVE';
  target: { area: 'REVIEW_STATE' | 'FINAL_REVIEWS'; path: string };
  payload?: unknown;
  review_id?: string;
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

interface DurablePersistenceApi extends LockPersistenceApi {
  atomicCreatePrivateJson(
    path: string,
    value: unknown,
    options?: { beforePublish?: (temporaryPath: string) => void | Promise<void> },
  ): Promise<void>;
  runDurableTransaction(
    paths: ReviewPersistencePaths,
    plan: DurablePlan,
    options?: { crashAt?: DurableBoundary },
  ): Promise<{ state: 'COMMITTED'; response: unknown }>;
  recoverDurableTransactions(
    paths: ReviewPersistencePaths,
    input: { review_id: string; idempotency_key: string; journal_scope?: 'START' | 'REVIEW' },
  ): Promise<{ state: 'COMMITTED'; response: unknown } | null>;
}

interface FinalArtifactApi extends DurablePersistenceApi {
  writeFinalReviewArtifacts(
    paths: ReviewPersistencePaths,
    artifact: unknown,
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
  assert.equal(typeof loaded.recoverDurableTransactions, 'function');
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
  it('acquires requested locks in start -> journal -> mutation order and permits skipped locks', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'omx-code-review-locks-'));
    try {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const observed: ReviewLockName[] = [];
      const all = await api.acquireReviewLocks(paths, ['mutation', 'start', 'journal'], {
        timeoutMs: 0,
        onAcquired: (name) => observed.push(name),
      });
      assert.deepEqual(observed, ['start', 'journal', 'mutation']);
      assert.deepEqual(all.map((handle) => handle.name), observed);
      assert.deepEqual(await api.releaseReviewLocks(all), [true, true, true]);

      const journalOnly = await api.acquireReviewLocks(paths, ['journal'], { timeoutMs: 0 });
      assert.deepEqual(journalOnly.map((handle) => handle.name), ['journal']);
      await api.releaseReviewLocks(journalOnly);

      const withoutJournal = await api.acquireReviewLocks(paths, ['mutation', 'start'], { timeoutMs: 0 });
      assert.deepEqual(withoutJournal.map((handle) => handle.name), ['start', 'mutation']);
      await api.releaseReviewLocks(withoutJournal);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
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

      const handles = await api.acquireReviewLocks(paths, ['start'], {
        timeoutMs: 0,
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
          api.acquireReviewLocks(paths, ['start'], {
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
        api.acquireReviewLocks(paths, ['start'], {
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

  it('releases a lock only while the published owner nonce still matches', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const handles = await api.acquireReviewLocks(paths, ['start'], { timeoutMs: 0 });
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

  it('orders hook-first and coordinator-first journal contention without reversing locks', async () => {
    await withWorkspace(async (workingDirectory) => {
      const api = await loadLockPersistenceApi();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory });
      const hookFirst = await api.acquireReviewLocks(paths, ['journal'], { timeoutMs: 0 });
      let releasedHook = false;
      const coordinator = await api.acquireReviewLocks(paths, ['mutation', 'journal', 'start'], {
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
        api.acquireReviewLocks(paths, ['journal'], { timeoutMs: 0 }),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_LOCKED',
      );
      await api.releaseReviewLocks(coordinator);
      const hookAfter = await api.acquireReviewLocks(paths, ['journal'], { timeoutMs: 0 });
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
          const handles = await persistence.acquireReviewLocks(paths, ['start'], { timeoutMs: 0 });
          process.stdout.write('ACQUIRED');
          if (process.argv[4] === 'release') await persistence.releaseReviewLocks(handles);
        } catch (error) {
          process.stdout.write(String(error?.code ?? 'UNKNOWN'));
        }
      `;
      const parentHandles = await api.acquireReviewLocks(paths, ['start'], { timeoutMs: 0 });
      const liveAttempt = await execFileAsync(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory, sessionId, 'release',
      ]);
      assert.equal(liveAttempt.stdout, 'PERSISTENCE_LOCKED');
      await api.releaseReviewLocks(parentHandles);

      const abandoned = await execFileAsync(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory, sessionId, 'abandon',
      ]);
      assert.equal(abandoned.stdout, 'ACQUIRED');
      const recovered = await api.acquireReviewLocks(paths, ['start'], { timeoutMs: 0 });
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
  'lane',
  'review',
  'report',
  'active-overlay',
  'approval',
  'stop-marker',
  'committed',
  'locator-cleanup',
];

function durableEffects(reviewId: string, key: string): DurableEffect[] {
  return [
    {
      name: 'proposal',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/proposal` },
      payload: { state: 'PENDING_HOST_ATTESTATION' },
    },
    {
      name: 'post-tool',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/post-tool` },
      payload: { publication_id: key },
    },
    {
      name: 'consume',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/consumed` },
      payload: { consumed: true },
    },
    {
      name: 'lane',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/lanes/lane-attempt-1/terminal` },
      payload: { status: 'COMPLETE' },
    },
    {
      name: 'review',
      mode: 'APPLY_REVIEW_REVISION',
      target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
      payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
    },
    {
      name: 'report',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'FINAL_REVIEWS', path: `${reviewId}.json` },
      payload: { schema_version: 1, review_id: reviewId, scope_hash: 'a'.repeat(64) },
    },
    {
      name: 'active-overlay',
      mode: 'REMOVE_MATCHING_ACTIVE',
      target: { area: 'REVIEW_STATE', path: 'active.json' },
      review_id: reviewId,
    },
    {
      name: 'approval',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: `approvals/${key}/consumed` },
      payload: { consumed: true },
    },
    {
      name: 'stop-marker',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: 'stop-terminal-brief.json' },
      payload: { state: 'PENDING_BRIEF', review_id: reviewId },
    },
  ];
}

describe('code-review durable transaction journal', () => {
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
            payload: { schema_version: 1, review_id: reviewId, status: 'CREATED' },
          },
          {
            name: 'active-overlay',
            mode: 'CREATE_ONCE_JSON',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'CREATED' },
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
      assert.deepEqual(await api.runDurableTransaction(paths, plan), {
        state: 'COMMITTED', response: { review_id: reviewId, revision: 1 },
      });
      assert.equal((JSON.parse(await readFile(
        join(paths.reviewRoot, reviewId, 'review.json'), 'utf8',
      )) as { revision: number }).revision, 1);
      assert.equal((await api.readActiveReview(paths))?.review_id, reviewId);
      await readFile(join(paths.reviewRoot, 'start-transactions', key, 'prepared'), 'utf8');
      await readFile(join(paths.reviewRoot, 'start-transactions', key, 'committed'), 'utf8');
      await assert.rejects(
        api.runDurableTransaction(paths, { ...plan, input: { review_id: reviewId, changed: true } }),
        (error: unknown) => (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT',
      );
      await assert.rejects(
        api.claimActiveReview(paths, {
          schema_version: 1, review_id: api.generateReviewId(), status: 'REVIEWING',
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'REVIEW_ALREADY_ACTIVE',
      );
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
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.atomicWritePrivateJson(reviewPath, {
          schema_version: 1,
          revision: 1,
          review_id: reviewId,
          status: 'REVIEWING',
        });
        const plan: DurablePlan = {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'TEST_DURABLE_MUTATION',
          input: { review_id: reviewId, requested: 'bounded' },
          expected_revision: 1,
          effects: durableEffects(reviewId, key),
          response: { review_id: reviewId, revision: 2 },
        };

        let publishedSuccess = false;
        await assert.rejects(
          api.runDurableTransaction(paths, plan, { crashAt }).then(() => {
            publishedSuccess = true;
          }),
          /injected crash/u,
          crashAt,
        );
        assert.equal(publishedSuccess, false, `${crashAt} must not publish success`);

        const recovered = await api.recoverDurableTransactions(paths, {
          review_id: reviewId,
          idempotency_key: key,
        }) ?? await api.runDurableTransaction(paths, plan);
        assert.deepEqual(recovered, {
          state: 'COMMITTED',
          response: { review_id: reviewId, revision: 2 },
        }, crashAt);
        assert.deepEqual(await api.runDurableTransaction(paths, plan), recovered, crashAt);

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

        const createdTargets = durableEffects(reviewId, key)
          .filter((effect) => effect.mode === 'CREATE_ONCE_JSON')
          .map((effect) => effect.target.area === 'FINAL_REVIEWS'
            ? join(paths.reviewsRoot, effect.target.path)
            : join(paths.reviewRoot, effect.target.path));
        for (const target of createdTargets) {
          assert.doesNotThrow(() => JSON.parse('null'));
          JSON.parse(await readFile(target, 'utf8'));
        }
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
      await api.atomicWritePrivateJson(join(paths.reviewRoot, reviewId, 'review.json'), {
        schema_version: 1, revision: 1, review_id: reviewId,
      });
      const plan: DurablePlan = {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'TEST_CONFLICT',
        input: { value: 1 },
        expected_revision: 1,
        effects: [durableEffects(reviewId, key)[4]!],
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
      const journalPath = join(paths.reviewRoot, 'activity', 'child-thread', 'event-1');
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
      assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), { event_ref: 'event-1' });
    });
  });

  it('rejects corrupt active JSON and never removes an active pointer for another review', async () => {
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
      await api.atomicWritePrivateJson(join(paths.reviewRoot, transactionReviewId, 'review.json'), {
        schema_version: 1, revision: 1, review_id: transactionReviewId,
      });
      await api.runDurableTransaction(paths, {
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
            payload: { schema_version: 1, review_id: transactionReviewId },
          },
          {
            name: 'active-overlay',
            mode: 'REMOVE_MATCHING_ACTIVE',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            review_id: transactionReviewId,
          },
        ],
        response: { ok: true },
      });
      assert.equal((await api.readActiveReview(paths))?.review_id, activeReviewId);
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
      await api.atomicWritePrivateJson(join(paths.reviewRoot, transactionReviewId, 'review.json'), {
        schema_version: 1, revision: 1, review_id: transactionReviewId,
      });

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
      await api.atomicWritePrivateJson(reviewPath, {
        schema_version: 1, revision: 1, review_id: reviewId, status: 'REVIEWING',
      });
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
          payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
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
      diagnostic_ids: [],
    }],
    diagnostics: [],
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
      const written = await persistence.writeFinalReviewArtifacts(
        paths,
        finalArtifact(reviewId, workingDirectory),
      );
      const jsonText = await readFile(written.jsonPath, 'utf8');
      const markdown = await readFile(written.markdownPath, 'utf8');
      const parsed = JSON.parse(jsonText) as { review_id: string; scope: { scope_hash: string } };

      assert.equal(parsed.review_id, reviewId);
      assert.match(markdown, new RegExp(`Review ID: ${reviewId}`, 'u'));
      assert.match(markdown, new RegExp(`Scope Hash: ${parsed.scope.scope_hash}`, 'u'));
      assert.equal(markdown, render.renderFinalReviewMarkdown(parsed));
      assert.match(written.artifact_sha256, /^[0-9a-f]{64}$/u);
      assert.doesNotMatch(`${jsonText}\n${markdown}`, /final-artifact-secret|final-key-secret|ghp_|\/Users\//u);
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
