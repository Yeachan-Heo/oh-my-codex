import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  type ContextPackPrivateEntryReadModel,
  type ContextPackPrivateRelationStep,
  type ContextPackPrivateSelector,
  readReadyContextPackPrivateEntryReadModel,
  readReadyContextPackRoleRefs,
} from '../context-pack-status.js';

let tempDir: string;
const PRIVATE_LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*$/u;
const PRIVATE_COMPACT_TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_PRIVATE_LABEL_LENGTH = 80;
const MAX_PRIVATE_TAG_COUNT = 8;
const MIN_PRIVATE_SELECTOR_MAX_WORDS = 40;
const MAX_PRIVATE_SELECTOR_MAX_WORDS = 240;
const MAX_PRIVATE_RELATION_PATH_STEPS = 5;
const MAX_PRIVATE_RELATION_TARGET_LENGTH = 180;
const SUPPORTED_ROLES = ['scope', 'build', 'verify'] as const;
const PRIVATE_ENTRY_KEYS = ['path', 'roles', 'label', 'tags', 'selector', 'relationPath'];
const PRIVATE_HEADING_SELECTOR_KEYS = ['type', 'value', 'maxWords'];
const PRIVATE_LINES_SELECTOR_KEYS = ['type', 'start', 'end'];
const PRIVATE_RELATION_STEP_KEYS = ['tag', 'target'];

type SupportedRole = (typeof SUPPORTED_ROLES)[number];

type TestContextPackEntry = {
  path: string;
  roles: string[];
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

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-pack-role-refs-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1_664_525) + 1_013_904_223;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pickRandom<T>(nextRandom: () => number, values: readonly T[]): T {
  const index = Math.floor(nextRandom() * values.length);
  return values[index]!;
}

function maybe(nextRandom: () => number, threshold = 0.5): boolean {
  return nextRandom() < threshold;
}

function normalizeRepoRelativePathModel(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replaceAll('\\', '/');
  if (!trimmed) {
    return null;
  }
  const withoutLeadingDot = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  if (
    !withoutLeadingDot
    || withoutLeadingDot.startsWith('/')
    || /^[A-Za-z]:/.test(withoutLeadingDot)
  ) {
    return null;
  }
  const segments = withoutLeadingDot
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes('..')) {
    return null;
  }
  return segments.join('/');
}

function hasOnlyAllowedKeysModel(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function normalizeCompactTokenModel(raw: string): string | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PRIVATE_LABEL_LENGTH)
    .replace(/-+$/g, '');
  return PRIVATE_COMPACT_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

function normalizeLabelModel(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = Array.from(
    raw
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  )
    .slice(0, MAX_PRIVATE_LABEL_LENGTH)
    .join('')
    .replace(/-+$/g, '');
  return PRIVATE_LABEL_PATTERN.test(normalized) ? normalized : null;
}

function normalizeTagsModel(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PRIVATE_TAG_COUNT) {
    return null;
  }
  const normalized = new Set<string>();
  for (const tag of raw) {
    if (typeof tag !== 'string') {
      return null;
    }
    const normalizedTag = normalizeCompactTokenModel(tag);
    if (!normalizedTag) {
      return null;
    }
    normalized.add(normalizedTag);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeSelectorModel(raw: unknown): ContextPackPrivateSelector | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.type === 'heading') {
    if (!hasOnlyAllowedKeysModel(record, PRIVATE_HEADING_SELECTOR_KEYS)) {
      return null;
    }
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    const rawMaxWords = record.maxWords;
    if (!value) {
      return null;
    }
    if (rawMaxWords != null) {
      if (typeof rawMaxWords !== 'number' || !Number.isInteger(rawMaxWords)) {
        return null;
      }
      if (
        rawMaxWords < MIN_PRIVATE_SELECTOR_MAX_WORDS
        || rawMaxWords > MAX_PRIVATE_SELECTOR_MAX_WORDS
      ) {
        return null;
      }
    }
    return {
      type: 'heading',
      value,
      maxWords: typeof rawMaxWords === 'number' ? rawMaxWords : undefined,
    };
  }
  if (record.type === 'lines') {
    if (!hasOnlyAllowedKeysModel(record, PRIVATE_LINES_SELECTOR_KEYS)) {
      return null;
    }
    const start = record.start;
    const end = record.end;
    if (typeof start !== 'number' || typeof end !== 'number') {
      return null;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return null;
    }
    if (start < 1 || end < start) {
      return null;
    }
    return { type: 'lines', start, end };
  }
  return null;
}

function normalizeRelationPathModel(
  raw: unknown,
): ContextPackPrivateRelationStep[] | null {
  if (
    !Array.isArray(raw)
    || raw.length === 0
    || raw.length > MAX_PRIVATE_RELATION_PATH_STEPS
  ) {
    return null;
  }
  const steps: ContextPackPrivateRelationStep[] = [];
  for (const step of raw) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return null;
    }
    const record = step as Record<string, unknown>;
    if (!hasOnlyAllowedKeysModel(record, PRIVATE_RELATION_STEP_KEYS)) {
      return null;
    }
    const tag = typeof record.tag === 'string' ? normalizeCompactTokenModel(record.tag) : null;
    const target = typeof record.target === 'string' ? record.target.trim() : '';
    if (!tag || !target || target.length > MAX_PRIVATE_RELATION_TARGET_LENGTH) {
      return null;
    }
    steps.push({ tag, target });
  }
  return steps;
}

function expectedRoleRefsModel(
  entries: readonly TestContextPackEntry[],
): { scope: string[]; build: string[]; verify: string[] } | null {
  const grouped = { scope: [] as string[], build: [] as string[], verify: [] as string[] };
  const seen = {
    scope: new Set<string>(),
    build: new Set<string>(),
    verify: new Set<string>(),
  };

  for (const entry of entries) {
    const path = normalizeRepoRelativePathModel(entry.path);
    if (!path) {
      return null;
    }
    for (const role of entry.roles) {
      if (!SUPPORTED_ROLES.includes(role as SupportedRole)) {
        return null;
      }
      const typedRole = role as SupportedRole;
      if (seen[typedRole].has(path)) {
        continue;
      }
      seen[typedRole].add(path);
      grouped[typedRole].push(path);
    }
  }

  return grouped;
}

function expectedPrivateEntryReadModel(
  entries: readonly TestContextPackEntry[],
): ContextPackPrivateEntryReadModel[] | null {
  const normalizedEntries: ContextPackPrivateEntryReadModel[] = [];
  for (const entry of entries) {
    const path = normalizeRepoRelativePathModel(entry.path);
    if (!path) {
      return null;
    }
    if (!hasOnlyAllowedKeysModel(entry, PRIVATE_ENTRY_KEYS)) {
      return null;
    }
    const roles: SupportedRole[] = [];
    for (const role of entry.roles) {
      if (!SUPPORTED_ROLES.includes(role as SupportedRole)) {
        return null;
      }
      if (!roles.includes(role as SupportedRole)) {
        roles.push(role as SupportedRole);
      }
    }
    if (roles.length === 0) {
      return null;
    }

    const label = entry.label == null ? null : normalizeLabelModel(entry.label);
    if (entry.label != null && !label) {
      return null;
    }
    const tags = entry.tags == null ? [] : normalizeTagsModel(entry.tags);
    if (entry.tags != null && !tags) {
      return null;
    }
    const selector = entry.selector == null ? null : normalizeSelectorModel(entry.selector);
    if (entry.selector != null && !selector) {
      return null;
    }
    const relationPath =
      entry.relationPath == null ? null : normalizeRelationPathModel(entry.relationPath);
    if (entry.relationPath != null && !relationPath) {
      return null;
    }

    normalizedEntries.push({
      path,
      roles,
      label,
      tags: tags ?? [],
      selector,
      relationPath,
    });
  }
  return normalizedEntries;
}

function buildValidPrivateMetadata(
  role: SupportedRole,
  slug: string,
  normalizedPath: string,
  index: number,
  nextRandom: () => number,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (maybe(nextRandom, 0.8)) {
    metadata.label = pickRandom(nextRandom, [
      ` ${role} focus ${index} `,
      `${role.toUpperCase()} contract ${index}`,
      `Seção ${role} ${index}`,
    ]);
  }
  if (maybe(nextRandom, 0.7)) {
    const rawTags = [
      role,
      `lane ${index % 4}`,
      pickRandom(nextRandom, ['runtime', 'api', 'smoke-test', 'handoff']),
    ];
    if (maybe(nextRandom, 0.5)) {
      rawTags.push(role.toUpperCase());
    }
    metadata.tags = rawTags;
  }
  if (maybe(nextRandom, 0.7)) {
    if (maybe(nextRandom)) {
      metadata.selector = {
        type: 'heading',
        value: ` ## ${role.toUpperCase()} Focus ${index} `,
        ...(maybe(nextRandom, 0.8)
          ? { maxWords: pickRandom(nextRandom, [40, 80, 120, 240]) }
          : {}),
      };
    } else {
      const start = 1 + Math.floor(nextRandom() * 6);
      metadata.selector = {
        type: 'lines',
        start,
        end: start + Math.floor(nextRandom() * 4),
      };
    }
  }
  if (maybe(nextRandom, 0.8)) {
    const relationPath: Array<{ tag: string; target: string }> = [
      { tag: 'Plan', target: ` ${slug} ` },
    ];
    const middleStepCount = Math.floor(nextRandom() * 3);
    for (let stepIndex = 0; stepIndex < middleStepCount; stepIndex += 1) {
      relationPath.push({
        tag: pickRandom(nextRandom, ['Evidence', 'Dependency', 'Links To']),
        target: ` ${normalizedPath}#step-${index}-${stepIndex} `,
      });
    }
    relationPath.push({
      tag: pickRandom(nextRandom, ['Bounds', 'Implements', 'Verifies']),
      target: ` ${normalizedPath} `,
    });
    metadata.relationPath = relationPath;
  }
  return metadata;
}

function buildValidPropertyEntries(
  slug: string,
  index: number,
  nextRandom: () => number,
): TestContextPackEntry[] {
  const scopePath = pickRandom(nextRandom, [
    `./docs/scope-${index}.md`,
    `docs\\scope-${index}.md`,
    `docs/scope-${index}.md`,
  ]);
  const buildPath = pickRandom(nextRandom, [
    `./docs/build-${index}.md`,
    `docs\\build-${index}.md`,
    `docs/build-${index}.md`,
  ]);
  const verifyPath = pickRandom(nextRandom, [
    `./docs/verify-${index}.md`,
    `docs\\verify-${index}.md`,
    `docs/verify-${index}.md`,
  ]);
  const entries: Array<{ role: SupportedRole; path: string }> = [
    { role: 'scope', path: scopePath },
    { role: 'build', path: buildPath },
    { role: 'verify', path: verifyPath },
  ];

  return entries.map(({ role, path }) => ({
    path,
    roles: [role],
    ...buildValidPrivateMetadata(
      role,
      slug,
      normalizeRepoRelativePathModel(path) ?? path,
      index,
      nextRandom,
    ),
  }));
}

async function writeContextPack(
  slug: string,
  entries: TestContextPackEntry[],
): Promise<string> {
  const plansDir = join(tempDir, '.omx', 'plans');
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(plansDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });

  const prdPath = join(plansDir, `prd-${slug}.md`);
  const testSpecPath = join(plansDir, `test-spec-${slug}.md`);
  const packPath = join(tempDir, canonicalContextPackRelativePath(slug));

  await writeFile(prdPath, '# PRD\n');
  await writeFile(testSpecPath, '# Test Spec\n');

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

describe('ready context pack role refs', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('normalizes, groups, and dedupes repo-relative refs by role', async () => {
    const packPath = await writeContextPack('alpha', [
      { path: './src/scope.ts', roles: ['scope'] },
      { path: 'src\\build.ts', roles: ['build', 'verify'] },
      { path: 'src/build.ts', roles: ['build'] },
      { path: 'src/shared.ts', roles: ['scope', 'build'] },
      { path: 'src/shared.ts', roles: ['scope'] },
      { path: 'src/verify.ts', roles: ['verify'] },
    ]);

    assert.deepEqual(readReadyContextPackRoleRefs(packPath), {
      scope: ['src/scope.ts', 'src/shared.ts'],
      build: ['src/build.ts', 'src/shared.ts'],
      verify: ['src/build.ts', 'src/verify.ts'],
    });
  });

  it('reads optional private entry metadata without changing grouped role refs', async () => {
    const packPath = await writeContextPack('private-metadata', [
      {
        path: './docs/runtime.md',
        roles: ['build', 'verify'],
        label: 'Runtime Contract',
        tags: ['runtime', 'api', 'runtime'],
        selector: { type: 'heading', value: ' ## Runtime Contract ', maxWords: 120 },
        relationPath: [
          { tag: 'Plan', target: ' private-metadata ' },
          { tag: 'Implements', target: ' docs/runtime.md#runtime-contract ' },
        ],
      },
      {
        path: 'docs/scope.md',
        roles: ['scope'],
        label: 'Scope Lines',
        selector: { type: 'lines', start: 3, end: 7 },
        relationPath: [
          { tag: 'Plan', target: ' private-metadata ' },
          { tag: 'Bounds', target: ' docs/scope.md:3-7 ' },
        ],
      },
    ]);

    assert.deepEqual(readReadyContextPackRoleRefs(packPath), {
      scope: ['docs/scope.md'],
      build: ['docs/runtime.md'],
      verify: ['docs/runtime.md'],
    });
    assert.deepEqual(readReadyContextPackPrivateEntryReadModel(packPath), [
      {
        path: 'docs/runtime.md',
        roles: ['build', 'verify'],
        label: 'runtime-contract',
        tags: ['api', 'runtime'],
        selector: { type: 'heading', value: '## Runtime Contract', maxWords: 120 },
        relationPath: [
          { tag: 'plan', target: 'private-metadata' },
          { tag: 'implements', target: 'docs/runtime.md#runtime-contract' },
        ],
      },
      {
        path: 'docs/scope.md',
        roles: ['scope'],
        label: 'scope-lines',
        tags: [],
        selector: { type: 'lines', start: 3, end: 7 },
        relationPath: [
          { tag: 'plan', target: 'private-metadata' },
          { tag: 'bounds', target: 'docs/scope.md:3-7' },
        ],
      },
    ]);
  });

  it('fails closed for malformed private metadata counterfactuals while grouped role refs stay usable', async () => {
    const cases: Array<{ slug: string; metadata: Record<string, unknown> }> = [
      { slug: 'invalid-label-type', metadata: { label: 42 } },
      { slug: 'invalid-label-empty', metadata: { label: '---' } },
      { slug: 'invalid-tags-shape', metadata: { tags: ['runtime', '', 'verify'] } },
      {
        slug: 'invalid-selector-heading',
        metadata: { selector: { type: 'heading', value: 'Runtime Contract', maxWords: 20 } },
      },
      {
        slug: 'invalid-selector-lines',
        metadata: { selector: { type: 'lines', start: 0, end: 3 } },
      },
      {
        slug: 'invalid-relation-path',
        metadata: {
          relationPath: [
            { tag: 'plan', target: 'alpha' },
            { tag: 'evidence', target: 'beta' },
            { tag: 'implements', target: 'gamma' },
            { tag: 'dependency', target: 'delta' },
            { tag: 'bounds', target: 'epsilon' },
            { tag: 'verifies', target: 'zeta' },
          ],
        },
      },
      { slug: 'invalid-entry-extra-key', metadata: { unexpected: true } },
      {
        slug: 'invalid-selector-extra-key',
        metadata: { selector: { type: 'heading', value: 'Runtime Contract', extra: true } },
      },
      {
        slug: 'invalid-relation-step-extra-key',
        metadata: { relationPath: [{ tag: 'plan', target: 'alpha', extra: true }] },
      },
    ];

    for (const testCase of cases) {
      const packPath = await writeContextPack(testCase.slug, [
        { path: 'docs/scope.md', roles: ['scope'] },
        {
          path: 'docs/build.md',
          roles: ['build'],
          ...testCase.metadata,
        },
        { path: 'docs/verify.md', roles: ['verify'] },
      ]);

      assert.deepEqual(readReadyContextPackRoleRefs(packPath), {
        scope: ['docs/scope.md'],
        build: ['docs/build.md'],
        verify: ['docs/verify.md'],
      }, `grouped refs should stay usable for ${testCase.slug}`);
      assert.equal(
        readReadyContextPackPrivateEntryReadModel(packPath),
        null,
        `private entry read model should fail closed for ${testCase.slug}`,
      );
    }
  });

  it('matches deterministic property checks for valid private metadata while keeping grouped role refs stable', async () => {
    const nextRandom = createDeterministicRandom(0x2244);
    for (let index = 0; index < 48; index += 1) {
      const slug = `property-valid-${index}`;
      const entries = buildValidPropertyEntries(slug, index, nextRandom);
      const expectedRoleRefs = expectedRoleRefsModel(entries);
      const expectedReadModel = expectedPrivateEntryReadModel(entries);

      const packPath = await writeContextPack(slug, entries);

      assert.deepEqual(
        readReadyContextPackRoleRefs(packPath),
        expectedRoleRefs,
        `role refs mismatch for ${slug}`,
      );
      assert.ok(expectedReadModel, `expected model should stay valid for ${slug}`);
      assert.deepEqual(
        readReadyContextPackPrivateEntryReadModel(packPath),
        expectedReadModel,
        `private read model mismatch for ${slug}`,
      );
    }
  });

  it('fails closed across deterministic adversarial private metadata property cases while keeping grouped role refs stable', async () => {
    const nextRandom = createDeterministicRandom(0x2245);
    const longTarget = `docs/build.md#${'x'.repeat(MAX_PRIVATE_RELATION_TARGET_LENGTH)}`;
    const counterfactuals: Array<{
      name: string;
      mutate: (entry: TestContextPackEntry) => TestContextPackEntry;
    }> = [
      { name: 'label-type', mutate: (entry) => ({ ...entry, label: 42 }) },
      { name: 'label-empty', mutate: (entry) => ({ ...entry, label: '---' }) },
      {
        name: 'too-many-tags',
        mutate: (entry) => ({
          ...entry,
          tags: Array.from({ length: MAX_PRIVATE_TAG_COUNT + 1 }, (_, index) => `tag-${index}`),
        }),
      },
      {
        name: 'invalid-tag-token',
        mutate: (entry) => ({ ...entry, tags: ['runtime', '', 'verify'] }),
      },
      {
        name: 'selector-low-maxWords',
        mutate: (entry) => ({
          ...entry,
          selector: { type: 'heading', value: 'Runtime Contract', maxWords: 20 },
        }),
      },
      {
        name: 'selector-extra-key',
        mutate: (entry) => ({
          ...entry,
          selector: { type: 'lines', start: 2, end: 4, extra: true },
        }),
      },
      {
        name: 'relation-too-many-steps',
        mutate: (entry) => ({
          ...entry,
          relationPath: [
            { tag: 'plan', target: 'alpha' },
            { tag: 'evidence', target: 'beta' },
            { tag: 'dependency', target: 'gamma' },
            { tag: 'links-to', target: 'delta' },
            { tag: 'bounds', target: 'epsilon' },
            { tag: 'verifies', target: 'zeta' },
          ],
        }),
      },
      {
        name: 'relation-target-too-long',
        mutate: (entry) => ({
          ...entry,
          relationPath: [{ tag: 'plan', target: longTarget }],
        }),
      },
      {
        name: 'relation-step-extra-key',
        mutate: (entry) => ({
          ...entry,
          relationPath: [{ tag: 'plan', target: 'alpha', extra: true }],
        }),
      },
      {
        name: 'entry-extra-key',
        mutate: (entry) => ({ ...entry, unexpected: true }),
      },
    ];

    for (const counterfactual of counterfactuals) {
      for (let index = 0; index < 8; index += 1) {
        const slug = `property-invalid-${counterfactual.name}-${index}`;
        const entries = buildValidPropertyEntries(slug, index, nextRandom);
        const mutatedEntries = entries.map((entry, entryIndex) =>
          entryIndex === 1 ? counterfactual.mutate(entry) : entry
        );
        const packPath = await writeContextPack(slug, mutatedEntries);

        assert.deepEqual(
          readReadyContextPackRoleRefs(packPath),
          expectedRoleRefsModel(mutatedEntries),
          `role refs should stay stable for ${slug}`,
        );
        assert.equal(
          expectedPrivateEntryReadModel(mutatedEntries),
          null,
          `model should reject ${slug}`,
        );
        assert.equal(
          readReadyContextPackPrivateEntryReadModel(packPath),
          null,
          `private read model should fail closed for ${slug}`,
        );
      }
    }
  });

  it('fails closed when the pack contains malformed entry paths or unsupported roles', async () => {
    const invalidPathPack = await writeContextPack('invalid-path', [
      { path: '../outside.ts', roles: ['build'] },
    ]);
    const invalidRolePack = await writeContextPack('invalid-role', [
      { path: 'src/build.ts', roles: ['deploy'] },
    ]);

    assert.equal(readReadyContextPackRoleRefs(invalidPathPack), null);
    assert.equal(readReadyContextPackRoleRefs(invalidRolePack), null);
  });

  it('fails closed when the pack file cannot be read', () => {
    const missingPackPath = join(tempDir, canonicalContextPackRelativePath('missing'));
    assert.equal(readReadyContextPackRoleRefs(missingPackPath), null);
    assert.equal(readReadyContextPackPrivateEntryReadModel(missingPackPath), null);
  });
});
