import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import type { ReviewBatch, ScopeFile } from '../contract.js';

interface BatchConfig {
  maxFiles: number;
  maxChangedLines: number;
}

interface BatchPlan {
  review_flags: 'BATCHED_REVIEW'[];
  batches: ReviewBatch[];
  required_lanes: Array<{
    lane_id: string;
    role: 'code-reviewer' | 'architect';
    batch_id: string | 'global';
  }>;
}

interface BatchingApi {
  resolveBatchingConfig(env?: NodeJS.ProcessEnv): BatchConfig;
  createBatchPlan(options: {
    repositoryRoot: string;
    files: readonly ScopeFile[];
    config?: BatchConfig;
  }): Promise<BatchPlan>;
}

async function loadBatchingApi(): Promise<BatchingApi> {
  const modulePath: string = '../batching.js';
  const loaded = (await import(modulePath).catch(() => null)) as Partial<BatchingApi> | null;
  assert.equal(
    typeof loaded?.createBatchPlan,
    'function',
    'expected deterministic batching decisions to be implemented',
  );
  assert.equal(typeof loaded?.resolveBatchingConfig, 'function');
  return loaded as BatchingApi;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omx-batching-'));
  temporaryRoots.push(root);
  return root;
}

function source(
  path: string,
  additions = 1,
  deletions = 0,
  overrides: Partial<ScopeFile> = {},
): ScopeFile {
  return {
    path,
    change: 'MODIFIED',
    sources: ['WORKTREE'],
    binary: false,
    additions,
    deletions,
    ...overrides,
  };
}

function fileSet(plan: BatchPlan): string[] {
  return plan.batches.flatMap((batch) => batch.files).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

describe('deterministic review batching', () => {
  it('uses the documented defaults and rejects every non-positive or non-integer override', async () => {
    const api = await loadBatchingApi();
    assert.deepEqual(api.resolveBatchingConfig({}), {
      maxFiles: 100,
      maxChangedLines: 20_000,
    });

    for (const [name, value] of [
      ['OMX_CODE_REVIEW_MAX_FILES', '0'],
      ['OMX_CODE_REVIEW_MAX_FILES', '-1'],
      ['OMX_CODE_REVIEW_MAX_FILES', '1.5'],
      ['OMX_CODE_REVIEW_MAX_FILES', 'abc'],
      ['OMX_CODE_REVIEW_MAX_CHANGED_LINES', ''],
      ['OMX_CODE_REVIEW_MAX_CHANGED_LINES', ' 2'],
      ['OMX_CODE_REVIEW_MAX_CHANGED_LINES', '9007199254740992'],
    ] as const) {
      assert.throws(
        () => api.resolveBatchingConfig({ [name]: value }),
        (error: unknown) => (error as { code?: unknown }).code === 'INVALID_CONFIGURATION',
        `${name}=${JSON.stringify(value)}`,
      );
    }

    assert.deepEqual(api.resolveBatchingConfig({
      OMX_CODE_REVIEW_MAX_FILES: '17',
      OMX_CODE_REVIEW_MAX_CHANGED_LINES: '900',
    }), { maxFiles: 17, maxChangedLines: 900 });
  });

  it('batches only above the 100-file or 20,000-line boundaries', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const hundred = Array.from({ length: 100 }, (_, index) => source(`src/f-${index.toString().padStart(3, '0')}.ts`));
    const hundredOne = [...hundred, source('src/f-100.ts')];

    assert.deepEqual((await api.createBatchPlan({ repositoryRoot: root, files: hundred })).review_flags, []);
    assert.deepEqual(
      (await api.createBatchPlan({ repositoryRoot: root, files: hundredOne })).review_flags,
      ['BATCHED_REVIEW'],
    );
    assert.deepEqual(
      (await api.createBatchPlan({ repositoryRoot: root, files: [source('src/large.ts', 20_000)] })).review_flags,
      [],
    );
    assert.deepEqual(
      (await api.createBatchPlan({ repositoryRoot: root, files: [source('src/large.ts', 20_001)] })).review_flags,
      ['BATCHED_REVIEW'],
    );
  });

  it('uses the nearest package or Cargo ancestor without walking above the repository', async () => {
    const api = await loadBatchingApi();
    const outer = await repository();
    const root = join(outer, 'repo');
    await mkdir(join(root, 'packages', 'web', 'src'), { recursive: true });
    await mkdir(join(root, 'crates', 'core', 'src'), { recursive: true });
    await mkdir(join(root, 'plain', 'nested'), { recursive: true });
    await writeFile(join(outer, 'package.json'), '{}');
    await writeFile(join(root, 'packages', 'web', 'package.json'), '{}');
    await writeFile(join(root, 'crates', 'core', 'Cargo.toml'), '[package]\nname="core"');

    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      files: [
        source('packages/web/src/a.ts', 10),
        source('crates/core/src/lib.rs', 10),
        source('plain/nested/a.ts', 10),
        source('README.md', 20_001),
      ],
    });

    assert.deepEqual(
      plan.batches.map((batch) => [batch.module_root, batch.files]),
      [
        ['.', ['README.md']],
        ['crates/core', ['crates/core/src/lib.rs']],
        ['packages/web', ['packages/web/src/a.ts']],
        ['plain', ['plain/nested/a.ts']],
      ],
    );
    assert.ok(!plan.batches.some((batch) => batch.module_root === '..'));
  });

  it('falls back to the first top-level segment and uses root for root files when no manifest exists', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      config: { maxFiles: 1, maxChangedLines: 100_000 },
      files: [source('z.ts'), source('src/a.ts'), source('src/b.ts')],
    });
    assert.deepEqual(plan.batches.map((batch) => batch.module_root), ['.', 'src', 'src']);
  });

  it('rejects dot, empty, traversal, and absolute scope paths', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    for (const path of ['.', '', '../escape.ts', '/absolute.ts']) {
      await assert.rejects(
        api.createBatchPlan({ repositoryRoot: root, files: [source(path)] }),
        (error: unknown) => (error as { code?: unknown }).code === 'INVALID_SCOPE',
        path,
      );
    }
  });

  it('ignores package manifest directories and symlinks outside the repository', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    await mkdir(join(root, 'directory-case', 'nested', 'src'), { recursive: true });
    await mkdir(join(root, 'directory-case', 'nested', 'package.json'));
    await mkdir(join(root, 'symlink-case', 'nested', 'src'), { recursive: true });
    const outsideManifest = join(root, 'outside-package.json');
    await writeFile(outsideManifest, '{}');
    await symlink(outsideManifest, join(root, 'symlink-case', 'nested', 'package.json'));

    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      files: [
        source('directory-case/nested/src/a.ts'),
        source('symlink-case/nested/src/a.ts'),
      ],
    });
    assert.deepEqual(plan.batches.map((batch) => batch.module_root), [
      'directory-case',
      'symlink-case',
    ]);
  });

  it('splits before adding the file that would cross either threshold', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const files = [
      source('src/a.ts', 5),
      source('src/b.ts', 5),
      source('src/c.ts', 5),
      source('src/d.ts', 5),
    ];
    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      files,
      config: { maxFiles: 2, maxChangedLines: 10 },
    });
    assert.deepEqual(plan.batches.map((batch) => ({ files: batch.files, lines: batch.changed_lines })), [
      { files: ['src/a.ts', 'src/b.ts'], lines: 10 },
      { files: ['src/c.ts', 'src/d.ts'], lines: 10 },
    ]);
  });

  it('keeps an oversized single file intact and marks only that batch', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      files: [source('src/a.ts', 5), source('src/huge.ts', 20_001), source('src/z.ts', 5)],
    });
    const huge = plan.batches.find((batch) => batch.files.includes('src/huge.ts'));
    assert.deepEqual(huge, {
      batch_id: huge?.batch_id,
      module_root: 'src',
      files: ['src/huge.ts'],
      changed_lines: 20_001,
      oversized_single_file: true,
    });
    assert.equal(plan.batches.filter((batch) => batch.oversized_single_file).length, 1);
  });

  it('counts binary, symlink, submodule, and undefined line totals as zero', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      files: [
        source('asset.bin', 9_999, 9_999, { binary: true }),
        source('link', 9_999, 9_999, { change: 'SYMLINK' }),
        source('vendor', 9_999, 9_999, { change: 'SUBMODULE' }),
        // ASSERTION-CHANGE-JUSTIFIED: default parameters turned the intended absent counts into one changed line.
        source('unknown.ts', 0, 0, { additions: undefined, deletions: undefined }),
        source('real.ts', 3, 2),
      ],
    });
    assert.equal(plan.batches.reduce((sum, batch) => sum + batch.changed_lines, 0), 5);
    assert.deepEqual(plan.review_flags, []);
  });

  it('covers every input exactly once, rejects duplicate paths, and is input-order invariant', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const files = [
      source('z/a.ts', 10),
      source('a/z.ts', 10),
      source('a/a.ts', 10),
      source('root.ts', 20_001),
    ];
    const forward = await api.createBatchPlan({ repositoryRoot: root, files });
    const reverse = await api.createBatchPlan({ repositoryRoot: root, files: [...files].reverse() });
    assert.deepEqual(reverse, forward);
    assert.deepEqual(fileSet(forward), files.map((file) => file.path).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));
    assert.equal(new Set(fileSet(forward)).size, files.length);

    await assert.rejects(
      api.createBatchPlan({ repositoryRoot: root, files: [source('same.ts'), source('same.ts')] }),
      (error: unknown) => (error as { code?: unknown }).code === 'INVALID_SCOPE',
    );
  });

  it('plans one reviewer per batch plus one distinct global architect', async () => {
    const api = await loadBatchingApi();
    const root = await repository();
    const plan = await api.createBatchPlan({
      repositoryRoot: root,
      files: [source('a.ts'), source('b.ts')],
      config: { maxFiles: 1, maxChangedLines: 100 },
    });
    const reviewers = plan.required_lanes.filter((lane) => lane.role === 'code-reviewer');
    const architects = plan.required_lanes.filter((lane) => lane.role === 'architect');
    assert.equal(reviewers.length, plan.batches.length);
    assert.deepEqual(reviewers.map((lane) => lane.batch_id), plan.batches.map((batch) => batch.batch_id));
    assert.deepEqual(architects, [{ lane_id: 'architect-global', role: 'architect', batch_id: 'global' }]);
    assert.ok(!reviewers.some((lane) => lane.lane_id === architects[0]?.lane_id));
  });
});
