import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ReviewPersistencePaths {
  workingDirectory: string;
  reviewRoot: string;
  activePath: string;
  startLockPath: string;
  reviewsRoot: string;
  startTransactionsRoot: string;
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
  recoverPendingReviewTransactions(
    paths: ReviewPersistencePaths,
  ): Promise<Array<{ state: 'COMMITTED'; response: unknown }>>;
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
      const recovered = await api.acquireReviewLocks(paths, undefined, ['start'], { timeoutMs: 0 });
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
          session_id: trust.sessionId ?? key,
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
          session_id: trust.sessionId ?? key,
          root_thread_id: trust.rootThreadId ?? 'root-thread-1',
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
        ...(trust.sessionId ? { session_id: trust.sessionId } : {}),
        ...(trust.rootThreadId ? { root_thread_id: trust.rootThreadId } : {}),
      },
    },
    {
      name: 'report',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'FINAL_REVIEWS', path: `${reviewId}.json` },
      payload: finalArtifact(reviewId, repositoryRoot),
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
      payload: {
        schema_version: 1,
        state: 'CONSUMED',
        review_id: reviewId,
        idempotency_key: key,
        consumed_at: now,
      },
    },
    {
      name: 'stop-marker',
      mode: 'CREATE_ONCE_JSON',
      target: { area: 'REVIEW_STATE', path: 'stop-terminal-brief.json' },
      payload: { schema_version: 1, state: 'PENDING_BRIEF', review_id: reviewId, created_at: now },
    },
  ];
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
      await api.atomicWritePrivateJson(reviewPath, reviewRecordPayload(reviewId, 1));
      const plan: DurablePlan = {
        journal_scope: 'REVIEW',
        idempotency_key: key,
        review_id: reviewId,
        operation: 'DIRECT_REVIEW_RECOVERY_REQUIRES_START_GATE',
        input: { review_id: reviewId },
        expected_revision: 1,
        effects: [
          durableEffects(reviewId, key, workingDirectory)[4]!,
          durableEffects(reviewId, key, workingDirectory)[8]!,
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
      { name: 'approval', path: (_reviewId, key) => `approvals/${key}/consumed`, payload: () => ({ consumed: true }) },
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
        const effects = structuredClone(durableEffects(reviewId, key, workingDirectory).slice(0, 3)) as any[];
        effects[1].payload.activity.session_id = sessionId;
        effects[1].payload.attestation.session_id = sessionId;
        effects[1].payload.attestation.root_thread_id = rootThreadId;
        effects.push({
          name: 'review',
          mode: 'APPLY_REVIEW_REVISION',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/review.json` },
          payload: {
            ...reviewRecordPayload(reviewId, 2),
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
        reviewRecordPayload(rootReviewId, 1),
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
            payload: reviewRecordPayload(reviewId, 1),
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
        effects: [],
        response: { review_id: validReviewId, stable: true },
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
        await api.atomicWritePrivateJson(reviewPath, reviewRecordPayload(reviewId, 1));
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
            payload: reviewRecordPayload(reviewId, 2),
          }],
          response: { review_id: reviewId, revision: 2 },
        }, { crashAt: 'after:committed' }), /injected crash/u);

        const rolledBack = reviewRecordPayload(reviewId, testCase.revision);
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
      await api.atomicWritePrivateJson(validReviewPath, reviewRecordPayload(validReviewId, 1));
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
          payload: reviewRecordPayload(validReviewId, 2),
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
    if (process.platform === 'win32') return;
    await withWorkspace(async (workingDirectory) => {
      const api = await loadDurablePersistenceApi();
      const sessionId = api.generateReviewId();
      const reviewId = api.generateReviewId();
      const key = api.generateReviewId();
      const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
      await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
      const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
      await api.atomicWritePrivateJson(reviewPath, reviewRecordPayload(reviewId, 1));
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
          payload: reviewRecordPayload(reviewId, 2),
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
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
      `;
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', childProgram, moduleUrl, workingDirectory,
        sessionId, JSON.stringify(plan),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      const [exitCode, signal] = await once(child, 'close');
      assert.equal(exitCode, null);
      assert.equal(signal, 'SIGKILL');

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
        const trust = { sessionId, rootThreadId: 'root-thread-1' };
        const paths = await api.resolveReviewPersistencePaths({ workingDirectory, session_id: sessionId });
        await api.claimActiveReview(paths, { schema_version: 1, review_id: reviewId, status: 'REVIEWING' });
        const reviewPath = join(paths.reviewRoot, reviewId, 'review.json');
        await api.atomicWritePrivateJson(reviewPath, {
          ...reviewRecordPayload(reviewId, 1),
          session_id: sessionId,
          root_thread_id: trust.rootThreadId,
        });
        const plan: DurablePlan = {
          idempotency_key: key,
          review_id: reviewId,
          operation: 'TEST_DURABLE_MUTATION',
          input: { review_id: reviewId, requested: 'bounded' },
          expected_revision: 1,
          effects: durableEffects(reviewId, key, workingDirectory, trust),
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
        effects: [durableEffects(reviewId, key, workingDirectory)[4]!],
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
      await api.atomicWritePrivateJson(
        join(paths.reviewRoot, transactionReviewId, 'review.json'),
        reviewRecordPayload(transactionReviewId, 1),
      );
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
            payload: reviewRecordPayload(transactionReviewId, 2),
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
