import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readContextPackHandoffStatus } from '../artifacts.js';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  selectLatestPlanningArtifactPath,
} from '../artifact-names.js';
import {
  CONTEXT_PACK_SCHEMA,
  buildContextPackBasis,
  contextPackExcerptPath,
  contextPackIndexPath,
  describeContextRef,
  filterContextPackEntries,
  findMissingContextPackRoles,
  formatRelationPath,
  groupContextRefsByRole,
  listContextPackRoles,
  materializeContextPackRefs,
  parseContextPackPathInfo,
  readContextPackDocument,
  rebindContextRefsForRepoRoot,
  resolveContextPackRepoRoot,
  upsertContextPackEntries,
  validateContextPackManifest,
  writeContextPackDocument,
  type ContextPackDocument,
  type ContextPackExecutionRef,
} from '../context-packs.js';

let tempDir: string;

function packRelativePath(slug: string = 'issue-direct'): string {
  return `.omx/context/context-20260420T000000Z-${slug}.json`;
}

function packAbsolutePath(slug: string = 'issue-direct'): string {
  return join(tempDir, packRelativePath(slug));
}

async function writeRepoFile(relativePath: string, content: string): Promise<string> {
  const absolutePath = join(tempDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

function validSha1(character: string): string {
  return character.repeat(40);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-packs-'));
});

afterEach(async () => {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('context-packs', () => {
  it('parses timestamped and legacy planning artifact filenames', () => {
    assert.deepEqual(parsePlanningArtifactFileName('prd-20260427T153000Z-my-feature.md'), {
      kind: 'prd',
      timestamp: '20260427T153000Z',
      slug: 'my-feature',
    });
    assert.deepEqual(parsePlanningArtifactFileName('test-spec-20260427T153000Z-my-feature.md'), {
      kind: 'test-spec',
      timestamp: '20260427T153000Z',
      slug: 'my-feature',
    });
    assert.deepEqual(parsePlanningArtifactFileName('testspec-my-feature.md'), {
      kind: 'test-spec',
      slug: 'my-feature',
    });
    assert.deepEqual(parsePlanningArtifactFileName('deep-interview-20260427T153000Z-my-feature.md'), {
      kind: 'deep-interview',
      timestamp: '20260427T153000Z',
      slug: 'my-feature',
    });
    assert.deepEqual(parsePlanningArtifactFileName('deep-interview-my-feature.md'), {
      kind: 'deep-interview',
      slug: 'my-feature',
    });
    assert.deepEqual(parsePlanningArtifactFileName('deep-interview-autoresearch-20260427T153000Z-my-feature.md'), {
      kind: 'deep-interview-autoresearch',
      timestamp: '20260427T153000Z',
      slug: 'my-feature',
    });
    assert.equal(parsePlanningArtifactFileName('notes-my-feature.md'), null);
    assert.equal(selectLatestPlanningArtifactPath([
      'prd-zeta.md',
      'prd-20260427T153000Z-alpha.md',
      'prd-20260427T153100Z-alpha.md',
    ]), 'prd-20260427T153100Z-alpha.md');
    assert.equal(
      ['prd-zeta.md', 'prd-20260427T153000Z-alpha.md'].sort(comparePlanningArtifactPaths).at(-1),
      'prd-20260427T153000Z-alpha.md',
    );
  });

  it('parses context-pack filenames and resolves repo roots from canonical paths', () => {
    assert.deepEqual(
      parseContextPackPathInfo('context-20260420T000000Z-Feature API.json'),
      { timestamp: '20260420T000000Z', slugHint: 'Feature API' },
    );
    assert.equal(parseContextPackPathInfo('notes.json'), null);

    assert.equal(
      resolveContextPackRepoRoot(packAbsolutePath('issue-roots'), '/fallback'),
      tempDir,
    );
    assert.equal(
      resolveContextPackRepoRoot(
        join(tempDir, '.omx', 'context', 'nested', 'deeper', 'context-20260420T000000Z-issue-roots.json'),
        '/fallback',
      ),
      '/fallback',
    );
    assert.equal(
      resolveContextPackRepoRoot(join(tempDir, 'tmp', 'context-20260420T000000Z-issue-roots.json'), '/fallback'),
      '/fallback',
    );
  });

  it('rejects noncanonical pack locations at the shared write boundary', () => {
    assert.throws(
      () => writeContextPackDocument(
        join(tempDir, 'docs', 'context-20260420T000000Z-issue-invalid.json'),
        {
          schema: CONTEXT_PACK_SCHEMA,
          slug: 'issue-invalid',
          entries: [],
        },
      ),
      /Context pack path must be \.omx\/context\/context-<timestamp>-<slug>\.json\./,
    );
    assert.throws(
      () => upsertContextPackEntries(
        join(tempDir, '.omx', 'context', 'nested', 'context-20260420T000000Z-issue-invalid.json'),
        [{ path: 'docs/quickstart.md' }],
      ),
      /Context pack path must be \.omx\/context\/context-<timestamp>-<slug>\.json\./,
    );
  });

  it('rejects drive-letter absolute source paths in entries and basis objects', () => {
    assert.throws(
      () => writeContextPackDocument(packAbsolutePath('issue-drive-entry-win32'), {
        schema: CONTEXT_PACK_SCHEMA,
        slug: 'issue-drive-entry-win32',
        entries: [
          {
            label: 'runtime',
            path: 'C:\\repo\\docs\\quickstart.md',
            roles: ['build'],
            tags: [],
            relationPath: [{ tag: 'implements', target: 'docs/quickstart.md' }],
          },
        ],
      }),
      /entries must provide a repo-relative path/i,
    );
    assert.throws(
      () => writeContextPackDocument(packAbsolutePath('issue-drive-entry-posixish'), {
        schema: CONTEXT_PACK_SCHEMA,
        slug: 'issue-drive-entry-posixish',
        entries: [
          {
            label: 'runtime',
            path: 'C:/repo/docs/quickstart.md',
            roles: ['build'],
            tags: [],
            relationPath: [{ tag: 'implements', target: 'docs/quickstart.md' }],
          },
        ],
      }),
      /entries must provide a repo-relative path/i,
    );
    assert.throws(
      () => writeContextPackDocument(packAbsolutePath('issue-drive-basis'), {
        schema: CONTEXT_PACK_SCHEMA,
        slug: 'issue-drive-basis',
        basis: {
          prd: { path: 'C:/repo/.omx/plans/prd-issue-drive-basis.md', sha1: validSha1('a') },
          testSpecs: [],
        },
        entries: [],
      }),
      /basis must provide a repo-relative path/i,
    );
  });

  it('builds deterministic basis objects from approved PRD and matching test specs', async () => {
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-basis.md'), '# PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'testspec-issue-basis.md'), '# Test Spec B\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-basis.md'), '# Test Spec A\n');

    const basis = buildContextPackBasis(tempDir, 'issue-basis');
    assert.ok(basis);
    assert.equal(basis?.prd.path, '.omx/plans/prd-issue-basis.md');
    assert.deepEqual(
      basis?.testSpecs.map((entry) => entry.path),
      [
        '.omx/plans/test-spec-issue-basis.md',
        '.omx/plans/testspec-issue-basis.md',
      ],
    );
  });

  it('builds basis from exact timestamped PRD/test-spec pairs when available', async () => {
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-20260427T153000Z-issue-timestamped.md'), '# Old PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-20260427T153100Z-issue-timestamped.md'), '# New PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-timestamped.md'), '# Legacy Test Spec\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-20260427T153100Z-issue-timestamped.md'), '# New Test Spec\n');

    const basis = buildContextPackBasis(tempDir, 'issue-timestamped');

    assert.ok(basis);
    assert.equal(basis?.prd.path, '.omx/plans/prd-20260427T153100Z-issue-timestamped.md');
    assert.deepEqual(
      basis?.testSpecs.map((entry) => entry.path),
      ['.omx/plans/test-spec-20260427T153100Z-issue-timestamped.md'],
    );
  });

  it('falls back to slug-matched test specs when a timestamped PRD has no exact test-spec pair', async () => {
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-20260427T153000Z-issue-fallback.md'), '# PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-fallback.md'), '# Test Spec A\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'testspec-issue-fallback.md'), '# Test Spec B\n');

    const basis = buildContextPackBasis(tempDir, 'issue-fallback');

    assert.ok(basis);
    assert.equal(basis?.prd.path, '.omx/plans/prd-20260427T153000Z-issue-fallback.md');
    assert.deepEqual(
      basis?.testSpecs.map((entry) => entry.path),
      [
        '.omx/plans/test-spec-issue-fallback.md',
        '.omx/plans/testspec-issue-fallback.md',
      ],
    );
  });

  it('preserves mixed-case approved artifact names in fresh basis validation', async () => {
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-Issue-ABC.md'), '# PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-Issue-ABC.md'), '# Test Spec\n');
    await writeRepoFile('docs/scope.md', '# Scope\n\nStay inside the approved slice.\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nBuild the approved slice.\n');
    await writeRepoFile('docs/verify.md', '# Verify\n\nCheck the approved slice.\n');

    const packPath = packAbsolutePath('Issue-ABC');
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'Issue-ABC',
      entries: [
        {
          label: 'scope',
          path: 'docs/scope.md',
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'Issue-ABC' },
            { tag: 'bounds', target: 'docs/scope.md' },
          ],
        },
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'Issue-ABC' },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
        {
          label: 'verify',
          path: 'docs/verify.md',
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'Issue-ABC' },
            { tag: 'verifies', target: 'docs/verify.md' },
          ],
        },
      ],
    }, { refreshBasis: true });

    const basis = buildContextPackBasis(tempDir, 'Issue-ABC');
    assert.ok(basis);
    assert.equal(basis?.prd.path, '.omx/plans/prd-Issue-ABC.md');
    assert.deepEqual(basis?.testSpecs.map((entry) => entry.path), ['.omx/plans/test-spec-Issue-ABC.md']);

    const issues = validateContextPackManifest({
      packPath,
      repoRoot: tempDir,
      expectedSlug: 'Issue-ABC',
      requireFreshBasis: true,
    });
    assert.deepEqual(issues, []);
  });

  it('treats timestamped PRD/test-spec artifacts as handoff-ready basis', async () => {
    const slug = 'issue-timestamped-ready';
    const packPath = packAbsolutePath(slug);
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(
      join(tempDir, '.omx', 'plans', `prd-20260427T153000Z-${slug}.md`),
      [
        '# PRD',
        '',
        'Approved context basis.',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${packRelativePath(slug)}\``,
        '',
      ].join('\n'),
    );
    await writeFile(join(tempDir, '.omx', 'plans', `test-spec-20260427T153000Z-${slug}.md`), '# Test Spec\n');
    await writeRepoFile('docs/scope.md', '# Scope\n\nStay inside the approved slice.\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nBuild the approved slice.\n');
    await writeRepoFile('docs/verify.md', '# Verify\n\nCheck the approved slice.\n');

    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: [
        {
          label: 'scope',
          path: 'docs/scope.md',
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'bounds', target: 'docs/scope.md' },
          ],
        },
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
        {
          label: 'verify',
          path: 'docs/verify.md',
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'verifies', target: 'docs/verify.md' },
          ],
        },
      ],
    }, { refreshBasis: true });

    const status = readContextPackHandoffStatus(tempDir, packPath);

    assert.equal(status.handoffState, 'ready');
    assert.equal(status.basisState, 'fresh');
    assert.equal(status.prdPath, join(tempDir, '.omx', 'plans', `prd-20260427T153000Z-${slug}.md`));
    assert.deepEqual(status.testSpecPaths, [join(tempDir, '.omx', 'plans', `test-spec-20260427T153000Z-${slug}.md`)]);
  });

  it('returns null when reading invalid JSON or structurally invalid pack manifests', async () => {
    const invalidJsonPath = packAbsolutePath('issue-invalid-json');
    await mkdir(dirname(invalidJsonPath), { recursive: true });
    await writeFile(invalidJsonPath, '{invalid json\n');
    assert.equal(readContextPackDocument(invalidJsonPath), null);

    const invalidManifestPath = packAbsolutePath('issue-invalid-manifest');
    await writeFile(
      invalidManifestPath,
      `${JSON.stringify({
        schema: CONTEXT_PACK_SCHEMA,
        slug: 'issue-invalid-manifest',
        basis: {
          prd: { path: 'docs/prd.md', sha1: validSha1('a') },
          testSpecs: [
            { path: 'docs/test.md', sha1: validSha1('b') },
            { path: 'docs/test.md', sha1: validSha1('c') },
          ],
        },
        entries: [
          {
            label: 'runtime',
            path: 'docs/runtime.md',
            roles: ['build'],
            tags: [],
          },
        ],
      }, null, 2)}\n`,
    );
    assert.equal(readContextPackDocument(invalidManifestPath), null);
  });

  it('reports structural manifest errors directly through validation', async () => {
    const cases: Array<{ slug: string; manifest: object; pattern: RegExp }> = [
      {
        slug: 'issue-duplicate-basis',
        manifest: {
          schema: CONTEXT_PACK_SCHEMA,
          slug: 'issue-duplicate-basis',
          basis: {
            prd: { path: 'docs/prd.md', sha1: validSha1('a') },
            testSpecs: [
              { path: 'docs/test.md', sha1: validSha1('b') },
              { path: 'docs/test.md', sha1: validSha1('c') },
            ],
          },
          entries: [
            {
              label: 'runtime',
              path: 'docs/runtime.md',
              roles: ['build'],
              tags: [],
            },
          ],
        },
        pattern: /basis testSpecs path "docs\/test\.md" is repeated\./,
      },
      {
        slug: 'issue-selector-range',
        manifest: {
          schema: CONTEXT_PACK_SCHEMA,
          slug: 'issue-selector-range',
          entries: [
            {
              label: 'runtime',
              path: 'docs/runtime.md',
              roles: ['build'],
              tags: [],
              selector: { type: 'heading', value: '## Runtime Contract', maxWords: 20 },
            },
          ],
        },
        pattern: /heading selector maxWords must be an integer between 40 and 240\./,
      },
      {
        slug: 'issue-long-relation',
        manifest: {
          schema: CONTEXT_PACK_SCHEMA,
          slug: 'issue-long-relation',
          entries: [
            {
              label: 'runtime',
              path: 'docs/runtime.md',
              roles: ['build'],
              tags: [],
              relationPath: [
                { tag: 'plan', target: 'issue-long-relation' },
                { tag: 'one', target: 'a' },
                { tag: 'two', target: 'b' },
                { tag: 'three', target: 'c' },
                { tag: 'four', target: 'd' },
                { tag: 'implements', target: 'docs/runtime.md' },
              ],
            },
          ],
        },
        pattern: /relationPath must contain 1-5 steps\./,
      },
    ];

    for (const testCase of cases) {
      const packPath = packAbsolutePath(testCase.slug);
      await mkdir(dirname(packPath), { recursive: true });
      await writeFile(packPath, `${JSON.stringify(testCase.manifest, null, 2)}\n`);

      const issues = validateContextPackManifest({
        packPath,
        repoRoot: tempDir,
      });
      assert.equal(issues.length, 1);
      assert.match(issues[0] ?? '', testCase.pattern);
    }
  });

  it('accepts canonical multi-step custom relation paths during direct validation', async () => {
    const packPath = packAbsolutePath('issue-relation-ok');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nShared build and verify guidance.\n');
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-relation-ok',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build', 'verify'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-relation-ok' },
            { tag: 'evidence', target: 'gate-a' },
            { tag: 'verifies', target: 'docs/runtime.md' },
          ],
        },
      ],
    });

    assert.deepEqual(
      validateContextPackManifest({
        packPath,
        repoRoot: tempDir,
      }),
      [],
    );
  });

  it('writes basis explicitly instead of inferring it on every write', async () => {
    const packPath = packAbsolutePath('issue-basis-write');
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-basis-write.md'), '# PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-basis-write.md'), '# Test Spec\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nShared build guidance.\n');

    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-basis-write',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-basis-write' },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
      ],
    });

    const withoutRefresh = readContextPackDocument(packPath);
    assert.ok(withoutRefresh);
    assert.equal(withoutRefresh?.basis, undefined);

    writeContextPackDocument(packPath, withoutRefresh!, { refreshBasis: true });
    const withRefresh = readContextPackDocument(packPath);
    assert.ok(withRefresh?.basis);
    assert.equal(withRefresh?.basis?.prd.path, '.omx/plans/prd-issue-basis-write.md');
  });

  it('preserves stored basis across non-refreshing entry upserts', async () => {
    const slug = 'issue-upsert-basis';
    const packPath = packAbsolutePath(slug);
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', `prd-${slug}.md`), '# PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', `test-spec-${slug}.md`), '# Test Spec\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nBuild the approved slice.\n');
    await writeRepoFile('docs/boundary.md', '# Boundary\n\nStay inside the approved slice.\n');
    await writeRepoFile('docs/verify.md', '# Verify\n\nCheck the approved slice.\n');

    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
        {
          label: 'boundary',
          path: 'docs/boundary.md',
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'bounds', target: 'docs/boundary.md' },
          ],
        },
        {
          label: 'verify',
          path: 'docs/verify.md',
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'verifies', target: 'docs/verify.md' },
          ],
        },
      ],
    }, { refreshBasis: true });
    const before = readContextPackDocument(packPath);
    assert.ok(before?.basis);

    upsertContextPackEntries(
      packPath,
      [{ path: 'docs/runtime.md', label: 'runtime', tags: ['patched'] }],
      { repoRoot: tempDir },
    );

    const after = readContextPackDocument(packPath);
    assert.deepEqual(after?.basis, before.basis);
    assert.deepEqual(after?.entries.find((entry) => entry.label === 'runtime')?.tags, ['patched']);
  });

  it('keeps handoff basis states meaningful across upsert and refresh transitions', async () => {
    const slug = 'issue-upsert-handoff';
    const packPath = packAbsolutePath(slug);
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(
      join(tempDir, '.omx', 'plans', `prd-${slug}.md`),
      [
        '# PRD',
        '',
        'Initial approved basis.',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${packRelativePath(slug)}\``,
        '',
      ].join('\n'),
    );
    await writeFile(join(tempDir, '.omx', 'plans', `test-spec-${slug}.md`), '# Test Spec\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nBuild the approved slice.\n');
    await writeRepoFile('docs/boundary.md', '# Boundary\n\nStay inside the approved slice.\n');
    await writeRepoFile('docs/verify.md', '# Verify\n\nCheck the approved slice.\n');

    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
        {
          label: 'boundary',
          path: 'docs/boundary.md',
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'bounds', target: 'docs/boundary.md' },
          ],
        },
        {
          label: 'verify',
          path: 'docs/verify.md',
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'verifies', target: 'docs/verify.md' },
          ],
        },
      ],
    }, { refreshBasis: true });

    let status = readContextPackHandoffStatus(tempDir, packPath);
    assert.equal(status.handoffState, 'ready');
    assert.equal(status.basisState, 'fresh');

    upsertContextPackEntries(
      packPath,
      [{ path: 'docs/runtime.md', label: 'runtime', tags: ['non-refresh'] }],
      { repoRoot: tempDir },
    );
    status = readContextPackHandoffStatus(tempDir, packPath);
    assert.equal(status.handoffState, 'ready');
    assert.equal(status.basisState, 'fresh');

    await writeFile(
      join(tempDir, '.omx', 'plans', `prd-${slug}.md`),
      [
        '# PRD',
        '',
        'Changed approved basis.',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${packRelativePath(slug)}\``,
        '',
      ].join('\n'),
    );
    upsertContextPackEntries(
      packPath,
      [{ path: 'docs/verify.md', label: 'verify', tags: ['stale-preserved'] }],
      { repoRoot: tempDir },
    );
    status = readContextPackHandoffStatus(tempDir, packPath);
    assert.equal(status.handoffState, 'invalid');
    assert.equal(status.basisState, 'stale-prd');
    assert.ok(status.issues.some((issue) => issue.includes('basis prd hash')));

    upsertContextPackEntries(
      packPath,
      [{ path: 'docs/boundary.md', label: 'boundary', tags: ['refreshed'] }],
      { repoRoot: tempDir, refreshBasis: true },
    );
    status = readContextPackHandoffStatus(tempDir, packPath);
    assert.equal(status.handoffState, 'ready');
    assert.equal(status.basisState, 'fresh');
  });

  it('keeps runtime materialization valid without the generated index while explicit readiness validation can still require it', async () => {
    const packPath = packAbsolutePath('issue-runtime-no-index');
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-runtime-no-index.md'), '# PRD\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-runtime-no-index.md'), '# Test Spec\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nShared build guidance.\n');

    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-runtime-no-index',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-runtime-no-index' },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
      ],
    }, { refreshBasis: true });

    await rm(contextPackIndexPath(packPath));

    assert.deepEqual(
      validateContextPackManifest({
        packPath,
        repoRoot: tempDir,
      }),
      [],
    );
    assert.deepEqual(
      validateContextPackManifest({
        packPath,
        repoRoot: tempDir,
        requireGeneratedIndex: true,
      }),
      ['context-20260420T000000Z-issue-runtime-no-index.json is missing generated index context-20260420T000000Z-issue-runtime-no-index.md.'],
    );

    const resolution = materializeContextPackRefs({
      packPath,
      repoRoot: tempDir,
    });
    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.refs.length, 1);
    assert.equal(resolution.refs[0]?.delivery, 'file');
  });

  it('accepts planner notes inside View Notes but rejects scaffold drift outside that block', async () => {
    const packPath = packAbsolutePath('issue-index-validation');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nShared build guidance.\n');
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-index-validation',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-index-validation' },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
      ],
    });

    const indexPath = contextPackIndexPath(packPath);
    const initialIndex = await readFile(indexPath, 'utf-8');
    const notesCustomizedIndex = initialIndex.replace(
      '<!-- Optional planner-added notes on when to use specific role or tag views. Keep them concise, advisory, and focused on when a role/tag view helps answer a concrete implementation question. -->',
      '- Prefer the build lane first unless the task is purely verification.',
    );
    await writeFile(indexPath, notesCustomizedIndex);

    assert.deepEqual(
      validateContextPackManifest({
        packPath,
        repoRoot: tempDir,
        requireGeneratedIndex: true,
      }),
      [],
    );

    await writeFile(
      indexPath,
      notesCustomizedIndex.replace('## Refs', '## Extra Brief\n- stale requirement\n\n## Refs'),
    );
    assert.deepEqual(
      validateContextPackManifest({
        packPath,
        repoRoot: tempDir,
        requireGeneratedIndex: true,
      }),
      ['context-20260420T000000Z-issue-index-validation.json generated index context-20260420T000000Z-issue-index-validation.md must remain scaffold-only outside View Notes.'],
    );
  });

  it('rewrites malformed view-note sections back to the default index scaffold', async () => {
    const packPath = packAbsolutePath('issue-index');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\nShared build guidance.\n');
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-index',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-index' },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
      ],
    });

    const indexPath = contextPackIndexPath(packPath);
    const malformedIndex = (await readFile(indexPath, 'utf-8')).replace(
      '<!-- OMX:CONTEXT:VIEW-NOTES:END -->',
      '<!-- OMX:CONTEXT:VIEW-NOTES:BROKEN -->',
    );
    await writeFile(indexPath, malformedIndex);

    const document = readContextPackDocument(packPath);
    assert.ok(document);
    writeContextPackDocument(packPath, document!);

    const rewrittenIndex = await readFile(indexPath, 'utf-8');
    assert.match(rewrittenIndex, /## View Notes/);
    assert.match(rewrittenIndex, /when a role\/tag view helps answer a concrete implementation question/i);
    assert.doesNotMatch(rewrittenIndex, /VIEW-NOTES:BROKEN/);
  });

  it('materializes heading excerpts by title, includes nested sections, and uses the default word budget', async () => {
    const packPath = packAbsolutePath('issue-heading');
    const introWords = Array.from({ length: 90 }, (_, index) => `intro${index}`).join(' ');
    const detailWords = Array.from({ length: 80 }, (_, index) => `detail${index}`).join(' ');
    await writeRepoFile(
      'docs/runtime.md',
      [
        '# Runtime',
        '',
        '## Runtime Contract',
        '',
        introWords,
        '',
        '### Details',
        '',
        detailWords,
        '',
        '## Later Section',
        '',
        'This section should not be included.',
        '',
      ].join('\n'),
    );
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-heading',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: ['runtime'],
          selector: { type: 'heading', value: 'Runtime Contract' },
          relationPath: [
            { tag: 'plan', target: 'issue-heading' },
            { tag: 'implements', target: 'docs/runtime.md#runtime-contract' },
          ],
        },
      ],
    });

    const resolution = materializeContextPackRefs({
      packPath,
      repoRoot: tempDir,
    });
    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.refs.length, 1);
    assert.equal(resolution.refs[0]?.delivery, 'excerpt');
    assert.equal(
      resolution.refs[0]?.path,
      contextPackExcerptPath(packPath, 0, 'runtime'),
    );
    assert.ok(existsSync(resolution.refs[0]!.path));

    const excerpt = await readFile(resolution.refs[0]!.path, 'utf-8');
    assert.match(excerpt, /## Runtime Contract/);
    assert.match(excerpt, /### Details/);
    assert.match(excerpt, /\[excerpt truncated after 160 words\]/);
    assert.doesNotMatch(excerpt, /## Later Section/);
  });

  it('truncates an over-budget first excerpt line to the heading word budget', async () => {
    const packPath = packAbsolutePath('issue-heading-first-line');
    const headingTitle = [
      ...Array.from({ length: 44 }, (_, index) => String.fromCharCode(97 + (index % 26))),
      'tailword',
    ].join(' ');
    await writeRepoFile(
      'docs/runtime-first-line.md',
      [
        '# Runtime',
        '',
        `## ${headingTitle}`,
        '',
        'This body should not fit after the over-budget heading.',
        '',
      ].join('\n'),
    );
    upsertContextPackEntries(
      packPath,
      [
        {
          label: 'runtime',
          path: 'docs/runtime-first-line.md',
          roles: ['build'],
          selector: { type: 'heading', value: headingTitle, maxWords: 40 },
        },
      ],
      { repoRoot: tempDir },
    );

    const resolution = materializeContextPackRefs({
      packPath,
      repoRoot: tempDir,
    });
    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.refs.length, 1);

    const excerpt = await readFile(resolution.refs[0]!.path, 'utf-8');
    const excerptBody = excerpt.split('## Excerpt\n')[1]!.split('\n\n[excerpt truncated')[0]!;
    assert.equal(excerptBody.trim().split(/\s+/).length, 40);
    assert.doesNotMatch(excerptBody, /tailword/);
    assert.doesNotMatch(excerptBody, /This body should not fit/);
    assert.match(excerpt, /\[excerpt truncated after 40 words\]/);
  });

  it('ignores fenced code blocks when resolving heading selectors', async () => {
    const packPath = packAbsolutePath('issue-heading-fence');
    await writeRepoFile(
      'docs/runtime-fenced.md',
      [
        '# Runtime',
        '',
        '```md',
        '## Runtime Contract',
        '',
        'Sample contract block that should not be selected.',
        '```',
        '',
        '## Runtime Contract',
        '',
        'Real contract section that executors should read.',
        '',
        '### Details',
        '',
        'Real implementation details.',
        '',
        '## Later Section',
        '',
        'This section should not be included.',
        '',
      ].join('\n'),
    );
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-heading-fence',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime-fenced.md',
          roles: ['build'],
          tags: ['runtime'],
          selector: { type: 'heading', value: 'Runtime Contract' },
          relationPath: [
            { tag: 'plan', target: 'issue-heading-fence' },
            { tag: 'implements', target: 'docs/runtime-fenced.md#runtime-contract' },
          ],
        },
      ],
    });

    const resolution = materializeContextPackRefs({
      packPath,
      repoRoot: tempDir,
    });
    assert.deepEqual(resolution.issues, []);

    const excerpt = await readFile(resolution.refs[0]!.path, 'utf-8');
    assert.match(excerpt, /Real contract section that executors should read\./);
    assert.match(excerpt, /### Details/);
    assert.doesNotMatch(excerpt, /Sample contract block that should not be selected\./);
    assert.doesNotMatch(excerpt, /```/);
    assert.doesNotMatch(excerpt, /## Later Section/);
  });

  it('ignores indented code blocks when resolving heading selectors', async () => {
    const packPath = packAbsolutePath('issue-heading-indented');
    await writeRepoFile(
      'docs/runtime-indented.md',
      [
        '# Runtime',
        '',
        '    ## Runtime Contract',
        '',
        '    Sample contract block that should not be selected.',
        '',
        '## Runtime Contract',
        '',
        'Real indented-safe contract section that executors should read.',
        '',
        '### Details',
        '',
        'Real implementation details.',
        '',
        '## Later Section',
        '',
        'This section should not be included.',
        '',
      ].join('\n'),
    );
    writeContextPackDocument(packPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-heading-indented',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime-indented.md',
          roles: ['build'],
          tags: ['runtime'],
          selector: { type: 'heading', value: 'Runtime Contract' },
          relationPath: [
            { tag: 'plan', target: 'issue-heading-indented' },
            { tag: 'implements', target: 'docs/runtime-indented.md#runtime-contract' },
          ],
        },
      ],
    });

    const resolution = materializeContextPackRefs({
      packPath,
      repoRoot: tempDir,
    });
    assert.deepEqual(resolution.issues, []);

    const excerpt = await readFile(resolution.refs[0]!.path, 'utf-8');
    assert.match(excerpt, /Real indented-safe contract section that executors should read\./);
    assert.match(excerpt, /### Details/);
    assert.doesNotMatch(excerpt, /Sample contract block that should not be selected\./);
    assert.doesNotMatch(excerpt, /## Later Section/);
  });

  it('materializes line selectors through EOF and reports out-of-range selectors', async () => {
    const validPackPath = packAbsolutePath('issue-lines-valid');
    await writeRepoFile(
      'docs/lines.md',
      ['line 1', '    if True:', '', '        pass', 'line 5'].join('\n'),
    );
    writeContextPackDocument(validPackPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-lines-valid',
      entries: [
        {
          label: 'tail',
          path: 'docs/lines.md',
          roles: ['build'],
          tags: [],
          selector: { type: 'lines', start: 2, end: 4 },
          relationPath: [
            { tag: 'plan', target: 'issue-lines-valid' },
            { tag: 'implements', target: 'docs/lines.md:2-4' },
          ],
        },
      ],
    });

    const validResolution = materializeContextPackRefs({
      packPath: validPackPath,
      repoRoot: tempDir,
    });
    assert.deepEqual(validResolution.issues, []);
    const validExcerpt = await readFile(validResolution.refs[0]!.path, 'utf-8');
    assert.match(validExcerpt, /## Excerpt\n    if True:\n\n        pass\n$/);

    const invalidPackPath = packAbsolutePath('issue-lines-invalid');
    writeContextPackDocument(invalidPackPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-lines-invalid',
      entries: [
        {
          label: 'tail',
          path: 'docs/lines.md',
          roles: ['build'],
          tags: [],
          selector: { type: 'lines', start: 2, end: 6 },
          relationPath: [
            { tag: 'plan', target: 'issue-lines-invalid' },
            { tag: 'implements', target: 'docs/lines.md:2-6' },
          ],
        },
      ],
    });

    const invalidResolution = materializeContextPackRefs({
      packPath: invalidPackPath,
      repoRoot: tempDir,
    });
    assert.equal(invalidResolution.refs.length, 0);
    assert.equal(invalidResolution.issues.length, 1);
    assert.match(invalidResolution.issues[0] ?? '', /line selector 2-6 exceeds the source length \(5 lines\)\./);
  });

  it('filters entries and reports role coverage through direct helpers', () => {
    const document: ContextPackDocument = {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-helpers',
      entries: [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: ['runtime', 'api'],
          relationPath: [
            { tag: 'plan', target: 'issue-helpers' },
            { tag: 'implements', target: 'docs/runtime.md' },
          ],
        },
        {
          label: 'acceptance',
          path: 'docs/acceptance.md',
          roles: ['verify'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-helpers' },
            { tag: 'verifies', target: 'docs/acceptance.md' },
          ],
        },
      ],
    };

    assert.deepEqual(
      filterContextPackEntries(document, { tags: ['runtime'] }).map((entry) => entry.label),
      ['runtime', 'acceptance'],
    );
    assert.deepEqual(
      filterContextPackEntries(document, { roles: ['build', 'verify'], tags: ['api'] }).map((entry) => entry.label),
      ['runtime'],
    );
    assert.deepEqual(
      filterContextPackEntries(document, { paths: ['docs/acceptance.md'] }).map((entry) => entry.label),
      ['acceptance'],
    );
    assert.deepEqual(
      filterContextPackEntries(document, { roles: ['build'], paths: ['docs/acceptance.md'] }).map((entry) => entry.label),
      [],
    );
    assert.deepEqual(listContextPackRoles(document), ['build', 'verify']);
    assert.deepEqual(findMissingContextPackRoles(document), ['scope']);
  });

  it('groups refs by every assigned role and formats helper output consistently', () => {
    const refs: ContextPackExecutionRef[] = [
      {
        roles: ['build', 'verify'],
        label: 'runtime',
        path: '/tmp/runtime.md',
        sourcePath: '/repo/docs/runtime.md',
        delivery: 'excerpt',
        relationPath: [
          { tag: 'plan', target: 'issue-helpers' },
          { tag: 'verifies', target: 'docs/runtime.md' },
        ],
        tags: ['runtime'],
      },
      {
        roles: ['scope'],
        label: 'boundary',
        path: '/repo/docs/boundary.md',
        sourcePath: '/repo/docs/boundary.md',
        delivery: 'file',
        relationPath: [
          { tag: 'plan', target: 'issue-helpers' },
          { tag: 'bounds', target: 'docs/boundary.md' },
        ],
        tags: [],
      },
    ];

    const grouped = groupContextRefsByRole(refs);
    assert.deepEqual(grouped.build?.map((ref) => ref.label), ['runtime']);
    assert.deepEqual(grouped.verify?.map((ref) => ref.label), ['runtime']);
    assert.deepEqual(grouped.scope?.map((ref) => ref.label), ['boundary']);
    assert.equal(describeContextRef(refs[0]!), 'runtime=/tmp/runtime.md [excerpt]');
    assert.equal(
      formatRelationPath(refs[0]!.relationPath),
      'plan: issue-helpers -> verifies: docs/runtime.md',
    );
  });

  it('rebinds direct file refs into a target repo root only when the target exists and leaves excerpt refs unchanged', async () => {
    const leaderRoot = join(tempDir, 'leader');
    const workerRoot = join(tempDir, 'worker');
    await writeRepoFile('leader/docs/runtime.md', '# Runtime\n');
    const refs: ContextPackExecutionRef[] = [
      {
        roles: ['build'],
        label: 'runtime',
        path: join(leaderRoot, 'docs', 'runtime.md'),
        sourcePath: join(leaderRoot, 'docs', 'runtime.md'),
        delivery: 'file',
        relationPath: [
          { tag: 'plan', target: 'issue-helpers' },
          { tag: 'implements', target: 'docs/runtime.md' },
        ],
        tags: [],
      },
      {
        roles: ['verify'],
        label: 'acceptance',
        path: '/tmp/omx-context-pack-excerpts/context-issue/01-acceptance.md',
        sourcePath: '/leader/docs/acceptance.md',
        delivery: 'excerpt',
        relationPath: [
          { tag: 'plan', target: 'issue-helpers' },
          { tag: 'verifies', target: 'docs/acceptance.md' },
        ],
        tags: [],
      },
    ];

    const reboundWithoutTarget = rebindContextRefsForRepoRoot(refs, leaderRoot, workerRoot);
    assert.equal(reboundWithoutTarget[0]?.path, join(leaderRoot, 'docs', 'runtime.md'));
    assert.equal(reboundWithoutTarget[1]?.path, '/tmp/omx-context-pack-excerpts/context-issue/01-acceptance.md');

    await writeRepoFile('worker/docs/runtime.md', '# Runtime\n');
    const rebound = rebindContextRefsForRepoRoot(refs, leaderRoot, workerRoot);
    assert.equal(rebound[0]?.path, join(workerRoot, 'docs', 'runtime.md'));
    assert.equal(rebound[1]?.path, '/tmp/omx-context-pack-excerpts/context-issue/01-acceptance.md');
  });

  it('upserts entries with collision-safe inferred labels and accurate add-update bookkeeping', async () => {
    await writeRepoFile('docs/quickstart.md', '# Quickstart\n\nStart here.\n');
    await writeRepoFile('guides/quickstart.md', '# Quickstart Guide\n\nStart here too.\n');
    await writeRepoFile('docs/runtime.md', ['# Runtime', '', 'Contract.'].join('\n'));

    const initialResult = upsertContextPackEntries(
      packAbsolutePath('issue-upsert'),
      [
        { path: 'docs/quickstart.md' },
        { path: 'guides/quickstart.md' },
      ],
      { repoRoot: tempDir },
    );
    assert.deepEqual(initialResult.addedLabels, ['quickstart', 'guides-quickstart-md']);
    assert.deepEqual(initialResult.updatedLabels, []);

    const secondResult = upsertContextPackEntries(
      packAbsolutePath('issue-upsert'),
      [
        { path: 'docs/quickstart.md', roles: ['verify'], tags: ['acceptance'] },
        {
          path: 'docs/runtime.md',
          label: 'runtime',
          roles: ['build'],
          selector: { type: 'lines', start: 1, end: 3 },
        },
      ],
      { repoRoot: tempDir },
    );
    assert.deepEqual(secondResult.addedLabels, ['runtime']);
    assert.deepEqual(secondResult.updatedLabels, ['quickstart']);

    const document = readContextPackDocument(packAbsolutePath('issue-upsert'));
    assert.ok(document);
    const quickstartEntry = document?.entries.find((entry) => entry.label === 'quickstart');
    const collidingEntry = document?.entries.find((entry) => entry.label === 'guides-quickstart-md');
    const runtimeEntry = document?.entries.find((entry) => entry.label === 'runtime');

    assert.deepEqual(quickstartEntry?.roles, ['build', 'verify']);
    assert.deepEqual(quickstartEntry?.tags, ['acceptance']);
    assert.equal(collidingEntry?.path, 'guides/quickstart.md');
    assert.deepEqual(runtimeEntry?.selector, { type: 'lines', start: 1, end: 3 });
    assert.equal(existsSync(contextPackIndexPath(packAbsolutePath('issue-upsert'))), true);
  });

  it('infers compact labels for numeric-leading source paths', async () => {
    await writeRepoFile('docs/123-runtime.md', '# Runtime\n\nStart here.\n');

    const result = upsertContextPackEntries(
      packAbsolutePath('issue-numeric-label'),
      [{ path: 'docs/123-runtime.md' }],
      { repoRoot: tempDir },
    );
    assert.deepEqual(result.addedLabels, ['123-runtime']);

    const document = readContextPackDocument(packAbsolutePath('issue-numeric-label'));
    assert.ok(document);
    assert.equal(document?.entries[0]?.label, '123-runtime');
    assert.equal(document?.entries[0]?.path, 'docs/123-runtime.md');
  });

  it('infers Unicode labels from international source filenames', async () => {
    await writeRepoFile('docs/café-runtime.md', '# Runtime\n\nStart here.\n');
    await writeRepoFile('docs/运行时.md', '# Runtime\n\nStart here.\n');

    const result = upsertContextPackEntries(
      packAbsolutePath('issue-unicode-label'),
      [
        { path: 'docs/café-runtime.md' },
        { path: 'docs/运行时.md' },
      ],
      { repoRoot: tempDir },
    );
    assert.deepEqual(result.addedLabels, ['café-runtime', '运行时']);

    const document = readContextPackDocument(packAbsolutePath('issue-unicode-label'));
    assert.ok(document);
    assert.deepEqual(
      document?.entries.map((entry) => [entry.label, entry.path]),
      [
        ['café-runtime', 'docs/café-runtime.md'],
        ['运行时', 'docs/运行时.md'],
      ],
    );
  });

  it('infers selector-aware labels for same-path selector entries', async () => {
    await writeRepoFile('docs/runtime.md', '# Runtime\n\n## Deferred Work\n\nLater.\n');

    const result = upsertContextPackEntries(
      packAbsolutePath('issue-selector-labels'),
      [
        { path: 'docs/runtime.md' },
        { path: 'docs/runtime.md', selector: { type: 'heading', value: 'Deferred Work' } },
      ],
      { repoRoot: tempDir },
    );
    assert.deepEqual(result.addedLabels, ['runtime', 'runtime-deferred-work']);

    const document = readContextPackDocument(packAbsolutePath('issue-selector-labels'));
    assert.deepEqual(
      document?.entries.map((entry) => [entry.label, entry.path, entry.selector]),
      [
        ['runtime', 'docs/runtime.md', undefined],
        ['runtime-deferred-work', 'docs/runtime.md', { type: 'heading', value: 'Deferred Work', maxWords: undefined }],
      ],
    );
  });

  it('preserves selectors on same-path updates but clears them when repointing an entry', async () => {
    await writeRepoFile('docs/runtime.md', '# Runtime\n\n## Contract\n\nFollow this.\n');
    await writeRepoFile('docs/quickstart.md', '# Quickstart\n\nStart here.\n');

    upsertContextPackEntries(
      packAbsolutePath('issue-selector-refresh'),
      [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          selector: { type: 'heading', value: 'Contract' },
        },
      ],
      { repoRoot: tempDir },
    );

    upsertContextPackEntries(
      packAbsolutePath('issue-selector-refresh'),
      [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['verify'],
        },
      ],
      { repoRoot: tempDir },
    );

    let document = readContextPackDocument(packAbsolutePath('issue-selector-refresh'));
    assert.ok(document);
    let runtimeEntry = document?.entries.find((entry) => entry.label === 'runtime');
    assert.deepEqual(runtimeEntry?.roles, ['build', 'verify']);
    assert.equal(runtimeEntry?.selector?.type, 'heading');
    assert.equal(runtimeEntry?.selector?.value, 'Contract');

    upsertContextPackEntries(
      packAbsolutePath('issue-selector-refresh'),
      [
        {
          label: 'runtime',
          path: 'docs/quickstart.md',
        },
      ],
      { repoRoot: tempDir },
    );

    document = readContextPackDocument(packAbsolutePath('issue-selector-refresh'));
    assert.ok(document);
    runtimeEntry = document?.entries.find((entry) => entry.label === 'runtime');
    assert.equal(runtimeEntry?.path, 'docs/quickstart.md');
    assert.equal(runtimeEntry?.selector, undefined);
    assert.deepEqual(runtimeEntry?.relationPath, [
      { tag: 'plan', target: 'issue-selector-refresh' },
      { tag: 'implements', target: 'docs/quickstart.md' },
    ]);
  });

  it('preserves valid custom relation paths on ordinary entry updates and re-infers stale ones', async () => {
    await writeRepoFile('docs/quickstart.md', '# Quickstart\n\nStart here.\n');
    await writeRepoFile('docs/runtime.md', '# Runtime\n\n## Contract\n\nFollow this.\n');

    upsertContextPackEntries(
      packAbsolutePath('issue-custom-relation'),
      [
        {
          path: 'docs/quickstart.md',
          roles: ['build'],
          relationPath: [
            { tag: 'plan', target: 'issue-custom-relation' },
            { tag: 'evidence', target: 'shared-guidance' },
            { tag: 'implements', target: 'docs/quickstart.md' },
          ],
        },
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          selector: { type: 'heading', value: 'Contract' },
          relationPath: [
            { tag: 'plan', target: 'issue-custom-relation' },
            { tag: 'dependency', target: 'runtime-contract' },
            { tag: 'implements', target: 'docs/runtime.md#contract' },
          ],
        },
      ],
      { repoRoot: tempDir },
    );

    upsertContextPackEntries(
      packAbsolutePath('issue-custom-relation'),
      [
        {
          path: 'docs/quickstart.md',
          roles: ['verify'],
        },
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          selector: { type: 'lines', start: 1, end: 3 },
        },
      ],
      { repoRoot: tempDir },
    );

    const document = readContextPackDocument(packAbsolutePath('issue-custom-relation'));
    assert.ok(document);

    const quickstartEntry = document?.entries.find((entry) => entry.label === 'quickstart');
    const runtimeEntry = document?.entries.find((entry) => entry.label === 'runtime');

    assert.deepEqual(quickstartEntry?.roles, ['build', 'verify']);
    assert.deepEqual(quickstartEntry?.relationPath, [
      { tag: 'plan', target: 'issue-custom-relation' },
      { tag: 'evidence', target: 'shared-guidance' },
      { tag: 'implements', target: 'docs/quickstart.md' },
    ]);

    assert.deepEqual(runtimeEntry?.selector, { type: 'lines', start: 1, end: 3 });
    assert.deepEqual(runtimeEntry?.relationPath, [
      { tag: 'plan', target: 'issue-custom-relation' },
      { tag: 'implements', target: 'docs/runtime.md:1-3' },
    ]);
  });

  it('requires a new selector when repointing an entry to a different long source', async () => {
    await writeRepoFile('docs/runtime.md', '# Runtime\n\n## Contract\n\nFollow this.\n');
    await writeRepoFile(
      'docs/runtime-refresh.md',
      Array.from({ length: 260 }, (_, index) => `word${index}`).join(' '),
    );

    upsertContextPackEntries(
      packAbsolutePath('issue-selector-long-refresh'),
      [
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          selector: { type: 'heading', value: 'Contract' },
        },
      ],
      { repoRoot: tempDir },
    );

    assert.throws(
      () => upsertContextPackEntries(
        packAbsolutePath('issue-selector-long-refresh'),
        [
          {
            label: 'runtime',
            path: 'docs/runtime-refresh.md',
          },
        ],
        { repoRoot: tempDir },
      ),
      /must declare a selector because docs\/runtime-refresh\.md exceeds the short-file threshold\./,
    );
  });

  it('rejects inferred selector targets that exceed the relation-target limit', async () => {
    const longPath = `docs/${'a'.repeat(170)}.md`;
    await writeRepoFile(longPath, '# Heading\n\nLong path target.\n');

    assert.throws(
      () => upsertContextPackEntries(
        packAbsolutePath('issue-long-heading-target'),
        [
          {
            path: longPath,
            roles: ['build'],
            selector: { type: 'heading', value: 'Heading' },
          },
        ],
        { repoRoot: tempDir },
      ),
      /inferred selector target must be at most 180 characters/i,
    );

    assert.throws(
      () => upsertContextPackEntries(
        packAbsolutePath('issue-long-lines-target'),
        [
          {
            path: longPath,
            roles: ['build'],
            selector: { type: 'lines', start: 1, end: 999 },
          },
        ],
        { repoRoot: tempDir },
      ),
      /inferred selector target must be at most 180 characters/i,
    );
  });
});
