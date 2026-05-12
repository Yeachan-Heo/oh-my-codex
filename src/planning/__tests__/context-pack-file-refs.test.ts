import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  readReadyContextPackFileRefs,
} from '../context-pack-file-refs.js';
import type { ContextPackRole } from '../context-pack-status.js';

let tempDir: string;
const DERIVED_LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*$/u;
const CONTEXT_PACK_ROLES = ['scope', 'build', 'verify'] as const satisfies readonly ContextPackRole[];

type TestContextPackEntry = {
  path: string;
  roles: readonly ContextPackRole[];
  label?: unknown;
  tags?: unknown;
  selector?: unknown;
  relationPath?: unknown;
  [key: string]: unknown;
};

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function relativeToRepo(path: string): string {
  return relative(tempDir, path).replaceAll('\\', '/');
}

function canonicalContextPackRelativePath(slug: string): string {
  return `.omx/context/context-20260507T120000Z-${slug}.json`;
}

function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1_664_525) + 1_013_904_223;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function maybe(nextRandom: () => number, threshold = 0.5): boolean {
  return nextRandom() < threshold;
}

function pickRandom<T>(nextRandom: () => number, values: readonly T[]): T {
  const index = Math.floor(nextRandom() * values.length);
  return values[index]!;
}

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-pack-file-refs-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeContextPackWithEntries(
  slug: string,
  prdPath: string,
  testSpecPath: string,
  entries: readonly TestContextPackEntry[],
): Promise<string> {
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(contextDir, { recursive: true });
  const packPath = join(tempDir, canonicalContextPackRelativePath(slug));
  const prdContent = await readFile(prdPath, 'utf-8');
  const testSpecContent = await readFile(testSpecPath, 'utf-8');
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relativeToRepo(prdPath),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relativeToRepo(testSpecPath),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries,
  }, null, 2));
  return packPath;
}

async function writeReadyPlanningBaseline(slug: string): Promise<{
  prdPath: string;
  testSpecPath: string;
}> {
  const plansDir = join(tempDir, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  const prdPath = join(plansDir, `prd-${slug}.md`);
  const testSpecPath = join(plansDir, `test-spec-${slug}.md`);
  await writeFile(prdPath, `# PRD ${slug}\n`);
  await writeFile(testSpecPath, `# Test Spec ${slug}\n`);
  return { prdPath, testSpecPath };
}

function generateValidEntry(
  nextRandom: () => number,
  index: number,
): TestContextPackEntry {
  const dirs = [
    'src/runtime',
    'src/build',
    'src/verify',
    'tests/runtime',
    'docs/guide',
  ];
  const basenames = ['index.ts', 'main.ts', 'contract.ts', 'overview.ts'];
  const roleCount = maybe(nextRandom, 0.2) ? 2 : 1;
  const roles = new Set<ContextPackRole>();
  while (roles.size < roleCount) {
    roles.add(pickRandom(nextRandom, CONTEXT_PACK_ROLES));
  }

  const entry: TestContextPackEntry = {
    path: `${pickRandom(nextRandom, dirs)}/${index % 3}-${pickRandom(nextRandom, basenames)}`,
    roles: [...roles],
  };

  if (maybe(nextRandom, 0.45)) {
    entry.label = `${pickRandom(nextRandom, ['Runtime', 'Build', 'Verify', 'Scope'])} Focus`;
  }
  if (maybe(nextRandom, 0.4)) {
    entry.tags = ['runtime', pickRandom(nextRandom, ['build', 'verify', 'scope'])];
  }
  if (maybe(nextRandom, 0.35)) {
    entry.selector = maybe(nextRandom, 0.5)
      ? { type: 'heading', value: `## ${pickRandom(nextRandom, ['Runtime Contract', 'Build Focus', 'Verification Notes'])}`, maxWords: 120 }
      : { type: 'lines', start: 2 + index, end: 4 + index };
  }
  if (maybe(nextRandom, 0.3)) {
    entry.relationPath = [
      { tag: 'Plan', target: `feature-${index}` },
      { tag: 'Implements', target: entry.path },
    ];
  }
  return entry;
}

describe('context pack file refs', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('projects previous-version ready packs with normalized repo-relative paths into derived direct file refs', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-plain');
    const packPath = await writeContextPackWithEntries(
      'file-refs-plain',
      prdPath,
      testSpecPath,
      [
        { path: './docs\\scope-ready.md', roles: ['scope'] },
        { path: 'src\\build-ready.ts', roles: ['build'] },
        { path: './tests/verify-ready.ts', roles: ['verify'] },
      ],
    );

    const resolution = readReadyContextPackFileRefs(packPath, tempDir);

    assert.deepEqual(resolution, {
      refs: [
        {
          roles: ['scope'],
          label: 'scope-ready',
          path: join(tempDir, 'docs/scope-ready.md'),
          sourcePath: join(tempDir, 'docs/scope-ready.md'),
          delivery: 'file',
        },
        {
          roles: ['build'],
          label: 'build-ready',
          path: join(tempDir, 'src/build-ready.ts'),
          sourcePath: join(tempDir, 'src/build-ready.ts'),
          delivery: 'file',
        },
        {
          roles: ['verify'],
          label: 'verify-ready',
          path: join(tempDir, 'tests/verify-ready.ts'),
          sourcePath: join(tempDir, 'tests/verify-ready.ts'),
          delivery: 'file',
        },
      ],
      issues: [],
    });
  });

  it('prefers private labels while keeping selectors file-only in the first Team row', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-private');
    const packPath = await writeContextPackWithEntries(
      'file-refs-private',
      prdPath,
      testSpecPath,
      [
        {
          path: 'src/runtime/build-entry.ts',
          roles: ['build'],
          label: ' Build Focus ',
          tags: ['runtime', 'build'],
          selector: { type: 'heading', value: ' ## Runtime Contract ', maxWords: 120 },
          relationPath: [
            { tag: 'Plan', target: 'file-refs-private' },
            { tag: 'Implements', target: 'src/runtime/build-entry.ts#runtime-contract' },
          ],
        },
      ],
    );

    const resolution = readReadyContextPackFileRefs(packPath, tempDir);

    assert.deepEqual(resolution, {
      refs: [
        {
          roles: ['build'],
          label: 'build-focus',
          path: join(tempDir, 'src/runtime/build-entry.ts'),
          sourcePath: join(tempDir, 'src/runtime/build-entry.ts'),
          delivery: 'file',
        },
      ],
      issues: [],
    });
  });

  it('fails closed when private entry metadata is malformed', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-malformed');
    const packPath = await writeContextPackWithEntries(
      'file-refs-malformed',
      prdPath,
      testSpecPath,
      [
        { path: 'docs/scope-malformed.md', roles: ['scope'] },
        {
          path: 'src/build-malformed.ts',
          roles: ['build'],
          selector: { type: 'heading', value: 'Build Focus', maxWords: 20 },
        },
        { path: 'tests/verify-malformed.ts', roles: ['verify'] },
      ],
    );

    const resolution = readReadyContextPackFileRefs(packPath, tempDir);

    assert.deepEqual(resolution.refs, []);
    assert.equal(resolution.issues.length, 1);
    assert.match(resolution.issues[0] ?? '', /Could not read ready private context-pack entry metadata/);
  });

  it('fails closed when a raw entry path escapes the repo root', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-escaped-path');
    const packPath = await writeContextPackWithEntries(
      'file-refs-escaped-path',
      prdPath,
      testSpecPath,
      [
        { path: 'docs/scope-ready.md', roles: ['scope'] },
        { path: '../outside-build.ts', roles: ['build'] },
        { path: 'tests/verify-ready.ts', roles: ['verify'] },
      ],
    );

    const resolution = readReadyContextPackFileRefs(packPath, tempDir);

    assert.deepEqual(resolution.refs, []);
    assert.equal(resolution.issues.length, 1);
    assert.match(resolution.issues[0] ?? '', /Could not read ready private context-pack entry metadata/);
  });

  it('fails closed when the caller does not provide an absolute repo root', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-relative-root');
    const packPath = await writeContextPackWithEntries(
      'file-refs-relative-root',
      prdPath,
      testSpecPath,
      [
        { path: 'docs/scope-ready.md', roles: ['scope'] },
        { path: 'src/build-ready.ts', roles: ['build'] },
        { path: 'tests/verify-ready.ts', roles: ['verify'] },
      ],
    );

    const resolution = readReadyContextPackFileRefs(packPath, '.');

    assert.deepEqual(resolution.refs, []);
    assert.equal(resolution.issues.length, 1);
    assert.match(resolution.issues[0] ?? '', /Could not resolve an absolute repo root/);
  });

  it('keeps derived labels unique across duplicate basename and label collisions', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-duplicates');
    const packPath = await writeContextPackWithEntries(
      'file-refs-duplicates',
      prdPath,
      testSpecPath,
      [
        {
          path: 'src/runtime/index.ts',
          roles: ['build'],
          label: 'Shared Focus',
        },
        {
          path: 'tests/runtime/index.ts',
          roles: ['verify'],
          label: 'Shared Focus',
        },
        {
          path: 'docs/runtime/index.ts',
          roles: ['scope'],
          selector: { type: 'heading', value: '## Runtime Contract', maxWords: 120 },
        },
      ],
    );

    const resolution = readReadyContextPackFileRefs(packPath, tempDir);
    const labels = resolution.refs.map((ref) => ref.label);

    assert.deepEqual(resolution.issues, []);
    assert.equal(labels.length, 3);
    assert.equal(new Set(labels).size, labels.length);
    assert.ok(labels.includes('shared-focus'));
    assert.ok(labels.every((label) => DERIVED_LABEL_PATTERN.test(label)));
  });

  it('keeps numeric collision fallback terminating across many length-saturated label collisions', async () => {
    const { prdPath, testSpecPath } = await writeReadyPlanningBaseline('file-refs-long-labels');
    const longLabel = 'A'.repeat(80);
    const entries = Array.from({ length: 12 }, (_, index) => ({
      path: `dir-${index}/runtime/shared.ts`,
      roles: [CONTEXT_PACK_ROLES[index % CONTEXT_PACK_ROLES.length]!],
      label: longLabel,
    }));
    const packPath = await writeContextPackWithEntries(
      'file-refs-long-labels',
      prdPath,
      testSpecPath,
      entries,
    );

    const resolution = readReadyContextPackFileRefs(packPath, tempDir);
    const labels = resolution.refs.map((ref) => ref.label);

    assert.deepEqual(resolution.issues, []);
    assert.equal(labels.length, entries.length);
    assert.equal(new Set(labels).size, labels.length);
    assert.ok(labels.some((label) => /-2$/.test(label)));
    assert.ok(labels.some((label) => /-12$/.test(label)));
    assert.ok(labels.every((label) => label.length <= 80));
    assert.ok(labels.every((label) => DERIVED_LABEL_PATTERN.test(label)));
  });

  it('satisfies the file-ref invariants across deterministic valid metadata cases', async () => {
    const nextRandom = createDeterministicRandom(0xC0D3_2214);
    for (let caseIndex = 0; caseIndex < 18; caseIndex += 1) {
      const slug = `generated-${caseIndex}`;
      const { prdPath, testSpecPath } = await writeReadyPlanningBaseline(slug);
      const entries = Array.from({ length: 6 }, (_, entryIndex) =>
        generateValidEntry(nextRandom, caseIndex * 10 + entryIndex));
      const packPath = await writeContextPackWithEntries(slug, prdPath, testSpecPath, entries);

      const resolution = readReadyContextPackFileRefs(packPath, tempDir);

      assert.deepEqual(resolution.issues, [], `expected valid file refs for ${slug}`);
      assert.equal(resolution.refs.length, entries.length, `expected one file ref per entry for ${slug}`);
      assert.equal(
        new Set(resolution.refs.map((ref) => ref.label)).size,
        resolution.refs.length,
        `expected unique labels for ${slug}`,
      );
      for (const ref of resolution.refs) {
        const repoRelativePath = relative(tempDir, ref.path).replaceAll('\\', '/');
        assert.equal(ref.delivery, 'file');
        assert.equal(ref.path, ref.sourcePath);
        assert.notEqual(repoRelativePath, '');
        assert.notEqual(repoRelativePath, '.');
        assert.ok(!repoRelativePath.startsWith('..'), `expected repo-rooted path for ${slug}`);
        assert.ok(!repoRelativePath.startsWith('../'), `expected repo-rooted path for ${slug}`);
        assert.ok(ref.roles.length > 0, `expected at least one role for ${slug}`);
        assert.match(ref.label, DERIVED_LABEL_PATTERN);
      }
    }
  });
});
