import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { contextToolMain } from '../context-tool.js';
import { computeContextPackObjectSha1, contextPackExcerptPath, writeContextPackDocument } from '../context-packs.js';

let tempDir: string;

function packRelativePath(slug: string = 'issue-950'): string {
  return `.omx/context/context-20260420T000000Z-${slug}.json`;
}

function packAbsolutePath(slug: string = 'issue-950'): string {
  return join(tempDir, packRelativePath(slug));
}

function excerptDir(slug: string = 'issue-950'): string {
  return dirname(contextPackExcerptPath(packAbsolutePath(slug), 0, 'runtime'));
}

async function writeReadyPack(root: string, slug: string): Promise<{ packPath: string; relativePackPath: string }> {
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.omx', 'plans'), { recursive: true });
  await writeFile(join(root, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
  await writeFile(join(root, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
  await writeFile(join(root, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');
  await writeFile(join(root, '.omx', 'plans', `prd-${slug}.md`), '# PRD\n\nApproved context basis.\n');
  await writeFile(join(root, '.omx', 'plans', `test-spec-${slug}.md`), '# Test Spec\n\nApproved test basis.\n');

  const relativePackPath = `.omx/context/context-20260420T000000Z-${slug}.json`;
  const packPath = join(root, relativePackPath);
  writeContextPackDocument(packPath, {
    schema: 'omx-context-pack-v1',
    slug,
    entries: [
      {
        label: 'quickstart',
        path: 'docs/quickstart.md',
        roles: ['build'],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'implements', target: 'docs/quickstart.md' },
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
        label: 'acceptance',
        path: 'docs/acceptance.md',
        roles: ['verify'],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'verifies', target: 'docs/acceptance.md' },
        ],
      },
    ],
  }, { refreshBasis: true });

  return { packPath, relativePackPath };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-tool-'));
});

afterEach(async () => {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('context-tool', () => {
  it('computes git-compatible blob sha1 hashes even when git is unavailable', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    const filePath = join(tempDir, 'docs', 'quickstart.md');
    await writeFile(filePath, '# Quickstart\n\nStart here.\n');

    const expectedHash = computeContextPackObjectSha1(filePath);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      assert.equal(computeContextPackObjectSha1(filePath), expectedHash);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
    }
  });

  it('prints help for empty and explicit help invocations', async () => {
    for (const args of [[], ['help'], ['-h'], ['--help']]) {
      const stdout = await captureStdout(() => contextToolMain(args, tempDir));
      assert.match(stdout, /Usage:/);
      assert.match(stdout, /node dist\/planning\/context-tool\.js add/);
      assert.match(stdout, /node dist\/planning\/context-tool\.js status/);
      assert.match(stdout, /node dist\/planning\/context-tool\.js view/);
      assert.match(stdout, /--path <repo\/path>/);
    }
  });

  it('rejects unknown top-level commands', async () => {
    await assert.rejects(
      () => contextToolMain(['wat'], tempDir),
      /Unknown context-tool command: wat/,
    );
  });

  it('rejects malformed add CLI argument combinations', async () => {
    const cases: Array<{ args: string[]; pattern: RegExp }> = [
      { args: ['add'], pattern: /add requires <pack\.json> and <repo\/path>\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--label'], pattern: /--label requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--role'], pattern: /--role requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--tag'], pattern: /--tag requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--heading'], pattern: /--heading requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--max-words'], pattern: /--max-words requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--lines'], pattern: /--lines requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--relation'], pattern: /--relation requires a value\./ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--lines', '2:1'], pattern: /Invalid line range "2:1"/ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--lines', 'broken'], pattern: /Invalid line range "broken"/ },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--relation', 'broken'], pattern: /Invalid relation "broken"/ },
      {
        args: ['add', packRelativePath(), 'docs/quickstart.md', '--heading', '# Scope', '--lines', '1:2'],
        pattern: /Use either --heading or --lines, not both\./,
      },
      {
        args: ['add', packRelativePath(), 'docs/quickstart.md', '--max-words', '10'],
        pattern: /--max-words only applies with --heading\./,
      },
      { args: ['add', packRelativePath(), 'docs/quickstart.md', '--oops'], pattern: /Unknown add option: --oops/ },
    ];

    for (const testCase of cases) {
      await assert.rejects(
        () => contextToolMain(testCase.args, tempDir),
        testCase.pattern,
      );
    }
  });

  it('rejects malformed sync CLI arguments', async () => {
    await assert.rejects(
      () => contextToolMain(['sync'], tempDir),
      /sync requires <pack\.json>\./,
    );
    await assert.rejects(
      () => contextToolMain(['sync', packRelativePath(), '--oops'], tempDir),
      /Unknown sync option: --oops/,
    );
  });

  it('rejects malformed status CLI arguments', async () => {
    await assert.rejects(
      () => contextToolMain(['status'], tempDir),
      /status requires <pack\.json>\./,
    );
    await assert.rejects(
      () => contextToolMain(['status', packRelativePath(), '--oops'], tempDir),
      /Unknown status option: --oops/,
    );
  });

  it('rejects malformed query and view CLI arguments with command-specific errors', async () => {
    const cases: Array<{ args: string[]; pattern: RegExp }> = [
      { args: ['query'], pattern: /query requires <pack\.json>\./ },
      { args: ['view'], pattern: /view requires <pack\.json>\./ },
      { args: ['query', packRelativePath(), '--role'], pattern: /--role requires a value\./ },
      { args: ['view', packRelativePath(), '--tag'], pattern: /--tag requires a value\./ },
      { args: ['query', packRelativePath(), '--path'], pattern: /--path requires a value\./ },
      { args: ['query', packRelativePath(), '--label'], pattern: /--label requires a value\./ },
      { args: ['query', packRelativePath(), '--oops'], pattern: /Unknown query option: --oops/ },
      { args: ['view', packRelativePath(), '--oops'], pattern: /Unknown view option: --oops/ },
    ];

    for (const testCase of cases) {
      await assert.rejects(
        () => contextToolMain(testCase.args, tempDir),
        testCase.pattern,
      );
    }
  });

  it('adds a single short source path with inferred defaults and writes the generated index', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-950.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md'], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath(), 'utf-8')) as {
      schema: string;
      slug: string;
      basis?: {
        prd: { path: string; sha1: string };
        testSpecs: Array<{ path: string; sha1: string }>;
      };
      entries: Array<{
        label: string;
        path: string;
        roles: string[];
        tags: string[];
        relationPath: Array<{ tag: string; target: string }>;
      }>;
    };
    assert.equal(document.schema, 'omx-context-pack-v1');
    assert.equal(document.slug, 'issue-950');
    assert.deepEqual(document.basis, {
      prd: {
        path: '.omx/plans/prd-issue-950.md',
        sha1: computeContextPackObjectSha1(join(tempDir, '.omx', 'plans', 'prd-issue-950.md')),
      },
      testSpecs: [
        {
          path: '.omx/plans/test-spec-issue-950.md',
          sha1: computeContextPackObjectSha1(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md')),
        },
      ],
    });
    assert.equal(document.entries.length, 1);
    assert.deepEqual(document.entries[0], {
      label: 'quickstart',
      path: 'docs/quickstart.md',
      roles: ['build'],
      tags: [],
      relationPath: [
        { tag: 'plan', target: 'issue-950' },
        { tag: 'implements', target: 'docs/quickstart.md' },
      ],
    });

    const index = await readFile(packAbsolutePath().replace(/\.json$/i, '.md'), 'utf-8');
    assert.match(index, /# Context Pack Index/);
    assert.match(index, /default-view: build/);
    assert.match(index, /## Pack Summary/);
    assert.match(index, /entries: 1/);
    assert.match(index, /roles: build=1/);
    assert.match(index, /tags: none/);
    assert.match(index, /selector-backed-entries: 0/);
    assert.match(index, /direct-file-entries: 1/);
    assert.match(index, /## View Guide/);
    assert.match(index, /## View Notes/);
    assert.match(index, /when a role\/tag view helps answer a concrete implementation question/i);
    assert.match(index, /query `--role build`/);
    assert.match(index, /build \(1\): quickstart \| query=--role build/);
    assert.match(index, /docs\/quickstart\.md \| label=quickstart \| roles=build/);
  });

  it('stores canonical repo-relative paths and inferred relation targets', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain(['add', packRelativePath('issue-canonical'), 'docs/./quickstart.md'], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath('issue-canonical'), 'utf-8')) as {
      entries: Array<{
        path: string;
        relationPath: Array<{ tag: string; target: string }>;
      }>;
    };
    assert.equal(document.entries.length, 1);
    assert.equal(document.entries[0]?.path, 'docs/quickstart.md');
    assert.deepEqual(document.entries[0]?.relationPath, [
      { tag: 'plan', target: 'issue-canonical' },
      { tag: 'implements', target: 'docs/quickstart.md' },
    ]);
  });

  it('emits JSON payloads for add and sync', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-json.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-json.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');

    const addStdout = await captureStdout(() =>
      contextToolMain(['add', packRelativePath('issue-json'), 'docs/quickstart.md', '--json'], tempDir),
    );
    const addPayload = JSON.parse(addStdout) as {
      packPath: string;
      indexPath: string;
      slug: string;
      addedLabels: string[];
      updatedLabels: string[];
    };
    assert.equal(addPayload.packPath, packAbsolutePath('issue-json'));
    assert.equal(addPayload.indexPath, packAbsolutePath('issue-json').replace(/\.json$/i, '.md'));
    assert.equal(addPayload.slug, 'issue-json');
    assert.deepEqual(addPayload.addedLabels, ['quickstart']);
    assert.deepEqual(addPayload.updatedLabels, []);

    await contextToolMain(['add', packRelativePath('issue-json'), 'docs/boundary.md', '--role', 'scope'], tempDir);
    await contextToolMain(['add', packRelativePath('issue-json'), 'docs/acceptance.md', '--role', 'verify'], tempDir);

    const syncStdout = await captureStdout(() =>
      contextToolMain(['sync', packRelativePath('issue-json'), '--json'], tempDir),
    );
    const syncPayload = JSON.parse(syncStdout) as {
      packPath: string;
      indexPath: string;
      slug: string;
      basis?: {
        prd: { path: string };
        testSpecs: Array<{ path: string }>;
      };
    };
    assert.equal(syncPayload.packPath, packAbsolutePath('issue-json'));
    assert.equal(syncPayload.indexPath, packAbsolutePath('issue-json').replace(/\.json$/i, '.md'));
    assert.equal(syncPayload.slug, 'issue-json');
    assert.equal(syncPayload.basis?.prd.path, '.omx/plans/prd-issue-json.md');
    assert.deepEqual(syncPayload.basis?.testSpecs.map((testSpec) => testSpec.path), [
      '.omx/plans/test-spec-issue-json.md',
    ]);
  });

  it('accepts --lines selectors and preserves repeated --relation flag order', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      [
        '# Runtime',
        'Line 1',
        'Line 2',
        'Line 3',
        'Line 4',
      ].join('\n'),
    );

    await contextToolMain([
      'add',
      packRelativePath('issue-lines'),
      'docs/runtime.md',
      '--lines', '2:4',
      '--relation', 'plan:issue-lines',
      '--relation', 'basis:runtime-slice',
      '--relation', 'implements:docs/runtime.md:2-4',
    ], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath('issue-lines'), 'utf-8')) as {
      entries: Array<{
        selector?: { type: string; start: number; end: number };
        relationPath: Array<{ tag: string; target: string }>;
      }>;
    };
    assert.equal(document.entries[0]?.selector?.type, 'lines');
    assert.equal(document.entries[0]?.selector?.start, 2);
    assert.equal(document.entries[0]?.selector?.end, 4);
    assert.deepEqual(document.entries[0]?.relationPath, [
      { tag: 'plan', target: 'issue-lines' },
      { tag: 'basis', target: 'runtime-slice' },
      { tag: 'implements', target: 'docs/runtime.md:2-4' },
    ]);
  });

  it('preserves valid long slugs when resolving approved basis files', async () => {
    const longSlug = `issue-${'a'.repeat(90)}`;
    assert.equal(longSlug.length > 80, true);

    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', `prd-${longSlug}.md`), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', `test-spec-${longSlug}.md`), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');

    await contextToolMain(['add', packRelativePath(longSlug), 'docs/quickstart.md'], tempDir);
    await contextToolMain(['add', packRelativePath(longSlug), 'docs/boundary.md', '--role', 'scope'], tempDir);
    await contextToolMain(['add', packRelativePath(longSlug), 'docs/acceptance.md', '--role', 'verify'], tempDir);
    await contextToolMain(['sync', packRelativePath(longSlug)], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath(longSlug), 'utf-8')) as {
      slug: string;
      basis?: {
        prd: { path: string };
        testSpecs: Array<{ path: string }>;
      };
    };
    assert.equal(document.slug, longSlug);
    assert.equal(document.basis?.prd.path, `.omx/plans/prd-${longSlug}.md`);
    assert.deepEqual(document.basis?.testSpecs.map((testSpec) => testSpec.path), [
      `.omx/plans/test-spec-${longSlug}.md`,
    ]);
  });

  it('sync refreshes basis after the approved handoff files exist', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');

    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md'], tempDir);
    await contextToolMain(['add', packRelativePath(), 'docs/boundary.md', '--role', 'scope'], tempDir);
    await contextToolMain(['add', packRelativePath(), 'docs/acceptance.md', '--role', 'verify'], tempDir);

    let document = JSON.parse(await readFile(packAbsolutePath(), 'utf-8')) as {
      basis?: {
        prd: { path: string; sha1: string };
        testSpecs: Array<{ path: string; sha1: string }>;
      };
    };
    assert.equal(document.basis, undefined);

    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-950.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md'), '# Test Spec\n\nApproved test basis.\n');

    await contextToolMain(['sync', packRelativePath()], tempDir);

    document = JSON.parse(await readFile(packAbsolutePath(), 'utf-8')) as {
      basis?: {
        prd: { path: string; sha1: string };
        testSpecs: Array<{ path: string; sha1: string }>;
      };
    };
    assert.deepEqual(document.basis, {
      prd: {
        path: '.omx/plans/prd-issue-950.md',
        sha1: computeContextPackObjectSha1(join(tempDir, '.omx', 'plans', 'prd-issue-950.md')),
      },
      testSpecs: [
        {
          path: '.omx/plans/test-spec-issue-950.md',
          sha1: computeContextPackObjectSha1(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md')),
        },
      ],
    });
  });

  it('sync rejects timestamped PRDs that do not have the same-timestamp test spec baseline', async () => {
    const slug = 'issue-950-timestamped';
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');

    await contextToolMain(['add', packRelativePath(slug), 'docs/quickstart.md'], tempDir);
    await contextToolMain(['add', packRelativePath(slug), 'docs/boundary.md', '--role', 'scope'], tempDir);
    await contextToolMain(['add', packRelativePath(slug), 'docs/acceptance.md', '--role', 'verify'], tempDir);

    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', `prd-20260427T153100Z-${slug}.md`), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', `test-spec-${slug}.md`), '# Legacy Test Spec\n\nApproved test basis.\n');

    await assert.rejects(
      () => contextToolMain(['sync', packRelativePath(slug)], tempDir),
      /Could not resolve approved PRD\/test-spec basis for slug issue-950-timestamped\./,
    );
  });

  it('sync rejects packs that are still missing required handoff roles', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-950.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md'], tempDir);

    await assert.rejects(
      () => contextToolMain(['sync', packRelativePath()], tempDir),
      /Context pack is not handoff-ready: missing required roles scope, verify\./,
    );
  });

  it('reports ready context-pack handoff status without mutating pack artifacts', async () => {
    const { relativePackPath, packPath } = await writeReadyPack(tempDir, 'issue-status-ready');
    const prdPath = join(tempDir, '.omx', 'plans', 'prd-issue-status-ready.md');
    await writeFile(
      prdPath,
      [
        '# PRD',
        '',
        'Approved context basis.',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${relativePackPath}\``,
        '',
      ].join('\n'),
    );
    await contextToolMain(['sync', relativePackPath], tempDir);
    const indexPath = packPath.replace(/\.json$/i, '.md');
    const packBefore = await readFile(packPath, 'utf-8');
    const indexBefore = await readFile(indexPath, 'utf-8');

    const stdout = await captureStdout(() => contextToolMain(['status', relativePackPath, '--json'], tempDir));
    const status = JSON.parse(stdout) as {
      handoffState: string;
      baselineState: string;
      outcomeState: string;
      packState: string;
      roleCoverage: string;
      basisState: string;
      indexState: string;
      issues: string[];
    };
    assert.equal(status.handoffState, 'ready');
    assert.equal(status.baselineState, 'present');
    assert.equal(status.outcomeState, 'single');
    assert.equal(status.packState, 'valid');
    assert.equal(status.roleCoverage, 'covered');
    assert.equal(status.basisState, 'fresh');
    assert.equal(status.indexState, 'fresh');
    assert.deepEqual(status.issues, []);
    assert.equal(await readFile(packPath, 'utf-8'), packBefore);
    assert.equal(await readFile(indexPath, 'utf-8'), indexBefore);
  });

  it('resolves absolute pack status against the pack repo root', async () => {
    const ownerRoot = join(tempDir, 'owner');
    const callerRoot = join(tempDir, 'caller');
    const slug = 'issue-status-absolute-owner';
    const { relativePackPath, packPath } = await writeReadyPack(ownerRoot, slug);
    await writeFile(
      join(ownerRoot, '.omx', 'plans', `prd-${slug}.md`),
      [
        '# PRD',
        '',
        'Approved context basis.',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${relativePackPath}\``,
        '',
      ].join('\n'),
    );
    await contextToolMain(['sync', relativePackPath], ownerRoot);

    await mkdir(join(callerRoot, '.omx', 'plans'), { recursive: true });
    await writeFile(join(callerRoot, '.omx', 'plans', `prd-${slug}.md`), '# PRD\n\nWrong repo basis.\n');
    await writeFile(join(callerRoot, '.omx', 'plans', `test-spec-${slug}.md`), '# Test Spec\n\nWrong repo basis.\n');

    const stdout = await captureStdout(() => contextToolMain(['status', packPath, '--json'], callerRoot));
    const status = JSON.parse(stdout) as {
      handoffState: string;
      baselineState: string;
      outcomeState: string;
      packState: string;
      roleCoverage: string;
      basisState: string;
      indexState: string;
      prdPath: string | null;
      testSpecPaths: string[];
      issues: string[];
    };

    assert.equal(status.handoffState, 'ready');
    assert.equal(status.baselineState, 'present');
    assert.equal(status.outcomeState, 'single');
    assert.equal(status.packState, 'valid');
    assert.equal(status.roleCoverage, 'covered');
    assert.equal(status.basisState, 'fresh');
    assert.equal(status.indexState, 'fresh');
    assert.equal(status.prdPath, join(ownerRoot, '.omx', 'plans', `prd-${slug}.md`));
    assert.deepEqual(status.testSpecPaths, [join(ownerRoot, '.omx', 'plans', `test-spec-${slug}.md`)]);
    assert.deepEqual(status.issues, []);
  });

  it('status keeps provisional synced packs plan-only until Context Pack Outcome declares them', async () => {
    const { relativePackPath } = await writeReadyPack(tempDir, 'issue-status-plan-only');

    const stdout = await captureStdout(() => contextToolMain(['status', relativePackPath, '--json'], tempDir));
    const status = JSON.parse(stdout) as { handoffState: string; outcomeState: string };

    assert.equal(status.handoffState, 'plan-only');
    assert.equal(status.outcomeState, 'absent');
  });

  it('status reports stale PRD basis when outcome is added after pack sync', async () => {
    const { relativePackPath } = await writeReadyPack(tempDir, 'issue-status-stale');
    await writeFile(
      join(tempDir, '.omx', 'plans', 'prd-issue-status-stale.md'),
      [
        '# PRD',
        '',
        'Approved context basis.',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${relativePackPath}\``,
        '',
      ].join('\n'),
    );

    const stdout = await captureStdout(() => contextToolMain(['status', relativePackPath, '--json'], tempDir));
    const status = JSON.parse(stdout) as { handoffState: string; outcomeState: string; basisState: string; issues: string[] };

    assert.equal(status.handoffState, 'invalid');
    assert.equal(status.outcomeState, 'single');
    assert.equal(status.basisState, 'stale-prd');
    assert.ok(status.issues.some((issue) => issue.includes('basis prd hash')));
  });

  it('status fails closed when Context Pack Outcome points at a different pack', async () => {
    const { relativePackPath } = await writeReadyPack(tempDir, 'issue-status-other');
    await writeFile(
      join(tempDir, '.omx', 'plans', 'prd-issue-status-other.md'),
      [
        '# PRD',
        '',
        'Approved context basis.',
        '',
        '## Context Pack Outcome',
        '- pack: created `.omx/context/context-20260420T000001Z-issue-status-other.json`',
        '',
      ].join('\n'),
    );
    await contextToolMain(['sync', relativePackPath], tempDir);

    const stdout = await captureStdout(() => contextToolMain(['status', relativePackPath, '--json'], tempDir));
    const status = JSON.parse(stdout) as { handoffState: string; outcomeState: string; issues: string[] };

    assert.equal(status.handoffState, 'invalid');
    assert.equal(status.outcomeState, 'single-other');
    assert.ok(status.issues.some((issue) => issue.includes('not') && issue.includes(relativePackPath)));
  });

  it('query returns matching refs without materializing excerpts', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      `# Runtime\n\n## Runtime Contract\n\n${Array.from({ length: 80 }, () => 'Execution detail stays intentionally compact when excerpted.').join(' ')}\n`,
    );
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain([
      'add',
      packRelativePath(),
      'docs/runtime.md',
      '--heading', '## Runtime Contract',
      '--max-words', '120',
      '--tag', 'runtime',
      '--tag', 'contract',
    ], tempDir);
    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md', '--tag', 'quickstart'], tempDir);

    const stdout = await captureStdout(() =>
      contextToolMain(['query', packRelativePath(), '--tag', 'runtime', '--json'], tempDir),
    );
    const payload = JSON.parse(stdout) as {
      entries: Array<{
        label: string;
        path: string;
        roles: string[];
        tags: string[];
        selector?: { type: string; value?: string; maxWords?: number };
      }>;
    };

    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0]?.label, 'runtime');
    assert.equal(payload.entries[0]?.path, 'docs/runtime.md');
    assert.deepEqual(payload.entries[0]?.roles, ['build']);
    assert.equal(payload.entries[0]?.selector?.type, 'heading');
    assert.equal(payload.entries[0]?.selector?.value, '## Runtime Contract');
    assert.equal(existsSync(excerptDir()), false);

    const index = await readFile(packAbsolutePath().replace(/\.json$/i, '.md'), 'utf-8');
    assert.match(index, /entries: 2/);
    assert.match(index, /tags: contract=1, quickstart=1, runtime=1/);
    assert.match(index, /tagged-entries: 2/);
    assert.match(index, /selector-backed-entries: 1/);
    assert.match(index, /direct-file-entries: 1/);
    assert.match(index, /query `--tag <tag>` first to narrow the ref set/i);
    assert.match(index, /runtime \(1\): runtime \| roles=build \| query=--tag runtime/);
    assert.match(index, /docs\/runtime\.md \| label=runtime \| roles=build/);
    assert.match(index, /## View Notes/);
  });

  it('filters query and view results by exact normalized source paths', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'runtime.md'), '# Runtime\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify this.\n');

    await contextToolMain(['add', packRelativePath('issue-path-filter'), 'docs/runtime.md', '--tag', 'runtime'], tempDir);
    await contextToolMain(['add', packRelativePath('issue-path-filter'), 'docs/quickstart.md', '--tag', 'runtime'], tempDir);
    await contextToolMain(['add', packRelativePath('issue-path-filter'), 'docs/acceptance.md', '--role', 'verify'], tempDir);

    const queryStdout = await captureStdout(() =>
      contextToolMain([
        'query',
        packRelativePath('issue-path-filter'),
        '--path', './docs/runtime.md',
        '--path', 'docs/acceptance.md',
        '--json',
      ], tempDir),
    );
    const queryPayload = JSON.parse(queryStdout) as {
      paths: string[];
      entries: Array<{ label: string; path: string }>;
    };
    assert.deepEqual(queryPayload.paths, ['docs/runtime.md', 'docs/acceptance.md']);
    assert.deepEqual(
      queryPayload.entries.map((entry) => [entry.label, entry.path]),
      [
        ['runtime', 'docs/runtime.md'],
        ['acceptance', 'docs/acceptance.md'],
      ],
    );

    const narrowedStdout = await captureStdout(() =>
      contextToolMain([
        'query',
        packRelativePath('issue-path-filter'),
        '--path', 'docs/runtime.md',
        '--tag', 'runtime',
        '--json',
      ], tempDir),
    );
    const narrowedPayload = JSON.parse(narrowedStdout) as {
      entries: Array<{ label: string; path: string }>;
    };
    assert.deepEqual(
      narrowedPayload.entries.map((entry) => [entry.label, entry.path]),
      [['runtime', 'docs/runtime.md']],
    );

    const viewStdout = await captureStdout(() =>
      contextToolMain([
        'view',
        packRelativePath('issue-path-filter'),
        '--path', 'docs/quickstart.md',
        '--json',
      ], tempDir),
    );
    const viewPayload = JSON.parse(viewStdout) as {
      paths: string[];
      refs: Array<{ label: string; sourcePath: string }>;
    };
    assert.deepEqual(viewPayload.paths, ['docs/quickstart.md']);
    assert.equal(viewPayload.refs.length, 1);
    assert.equal(viewPayload.refs[0]?.label, 'quickstart');
    assert.equal(viewPayload.refs[0]?.sourcePath, join(tempDir, 'docs', 'quickstart.md'));
  });

  it('returns empty query and view results for unmatched filters without materializing excerpts', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      [
        '# Runtime',
        '',
        '## Runtime Contract',
        '',
        Array.from({ length: 90 }, () => 'This runtime file is intentionally too long to load wholesale.').join(' '),
        '',
      ].join('\n'),
    );

    await contextToolMain([
      'add',
      packRelativePath('issue-empty-filter'),
      'docs/runtime.md',
      '--heading', '## Runtime Contract',
      '--max-words', '120',
      '--tag', 'runtime',
    ], tempDir);

    const queryStdout = await captureStdout(() =>
      contextToolMain(['query', packRelativePath('issue-empty-filter'), '--tag', 'acceptance', '--json'], tempDir),
    );
    const queryPayload = JSON.parse(queryStdout) as {
      entries: unknown[];
    };
    assert.deepEqual(queryPayload.entries, []);

    const viewStdout = await captureStdout(() =>
      contextToolMain(['view', packRelativePath('issue-empty-filter'), '--tag', 'acceptance', '--json'], tempDir),
    );
    const viewPayload = JSON.parse(viewStdout) as {
      refs: unknown[];
    };
    assert.deepEqual(viewPayload.refs, []);
    assert.equal(existsSync(excerptDir('issue-empty-filter')), false);
  });

  it('preserves planner-added view notes when the tool rewrites the markdown scaffold', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-950.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');

    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md', '--tag', 'runtime'], tempDir);
    await contextToolMain(['add', packRelativePath(), 'docs/boundary.md', '--role', 'scope'], tempDir);
    await contextToolMain(['add', packRelativePath(), 'docs/acceptance.md', '--role', 'verify'], tempDir);

    const indexPath = packAbsolutePath().replace(/\.json$/i, '.md');
    const seededIndex = await readFile(indexPath, 'utf-8');
    const updatedIndex = seededIndex.replace(
      '<!-- Optional planner-added notes on when to use specific role or tag views. Keep them concise, advisory, and focused on when a role/tag view helps answer a concrete implementation question. -->',
      '- runtime: use this tag view first when the change touches execution-contract behavior.',
    );
    await writeFile(indexPath, updatedIndex);

    await contextToolMain(['sync', packRelativePath()], tempDir);

    const preservedIndex = await readFile(indexPath, 'utf-8');
    assert.match(preservedIndex, /## View Notes/);
    assert.match(preservedIndex, /runtime: use this tag view first when the change touches execution-contract behavior\./);
  });

  it('view materializes excerpts for long sources while keeping short sources as direct file refs', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      `# Runtime\n\n## Runtime Contract\n\n${Array.from({ length: 80 }, () => 'Execution detail stays intentionally compact when excerpted.').join(' ')}\n\n## Deferred\n\nLater.\n`,
    );
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain([
      'add',
      packRelativePath(),
      'docs/runtime.md',
      '--heading', '## Runtime Contract',
      '--max-words', '120',
    ], tempDir);
    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md'], tempDir);

    const stdout = await captureStdout(() =>
      contextToolMain(['view', packRelativePath(), '--json'], tempDir),
    );
    const payload = JSON.parse(stdout) as {
      refs: Array<{
        label: string;
        path: string;
        sourcePath: string;
        delivery: 'file' | 'excerpt';
      }>;
    };

    assert.equal(payload.refs.length, 2);
    const runtime = payload.refs.find((ref) => ref.label === 'runtime');
    const quickstart = payload.refs.find((ref) => ref.label === 'quickstart');
    assert.equal(runtime?.delivery, 'excerpt');
    assert.equal(
      runtime?.path,
      contextPackExcerptPath(packAbsolutePath(), 0, 'runtime'),
    );
    assert.ok(runtime && existsSync(runtime.path));
    assert.equal(runtime?.sourcePath, join(tempDir, 'docs', 'runtime.md'));
    assert.notEqual(runtime?.path, runtime?.sourcePath);
    assert.equal(quickstart?.delivery, 'file');
    assert.equal(quickstart?.path, join(tempDir, 'docs', 'quickstart.md'));
    assert.equal(quickstart?.sourcePath, join(tempDir, 'docs', 'quickstart.md'));
  });

  it('resolves repo-relative pack paths from a nested working directory', async () => {
    const nestedCwd = join(tempDir, 'apps', 'mailctrl');
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-950.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-950.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain(['add', packRelativePath(), 'docs/quickstart.md'], nestedCwd);

    assert.equal(existsSync(packAbsolutePath()), true);

    const stdout = await captureStdout(() =>
      contextToolMain(['view', packRelativePath(), '--json'], nestedCwd),
    );
    const payload = JSON.parse(stdout) as {
      refs: Array<{
        roles: string[];
        label: string;
        path: string;
        sourcePath: string;
        delivery: 'file' | 'excerpt';
        relationPath: Array<{ tag: string; target: string }>;
        tags: string[];
      }>;
    };

    assert.equal(payload.refs.length, 1);
    assert.deepEqual(payload.refs[0]?.roles, ['build']);
    assert.equal(payload.refs[0]?.label, 'quickstart');
    assert.equal(payload.refs[0]?.path, join(tempDir, 'docs', 'quickstart.md'));
    assert.equal(payload.refs[0]?.sourcePath, join(tempDir, 'docs', 'quickstart.md'));
    assert.equal(payload.refs[0]?.delivery, 'file');
    assert.deepEqual(payload.refs[0]?.relationPath, [
      { tag: 'plan', target: 'issue-950' },
      { tag: 'implements', target: 'docs/quickstart.md' },
    ]);
    assert.deepEqual(payload.refs[0]?.tags, []);
  });

  it('rejects nested context-pack paths from a nested working directory', async () => {
    const nestedCwd = join(tempDir, 'apps', 'mailctrl', 'src');
    const nestedPackPath = '.omx/context/nested/context-20260420T000000Z-issue-nested-paths.json';
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-nested-paths.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-nested-paths.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nStay inside the approved slice.\n');
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify the approved slice.\n');

    for (const args of [
      ['add', nestedPackPath, 'docs/quickstart.md'],
      ['sync', nestedPackPath],
      ['query', nestedPackPath, '--json'],
      ['view', nestedPackPath, '--json'],
    ] as const) {
      await assert.rejects(
        () => contextToolMain(args, nestedCwd),
        /Context pack path must be \.omx\/context\/context-<timestamp>-<slug>\.json\./,
      );
    }

    assert.equal(
      existsSync(join(tempDir, '.omx', 'context', 'nested', 'context-20260420T000000Z-issue-nested-paths.json')),
      false,
    );
  });

  it('uses absolute pack paths without workspace-root guessing', async () => {
    const nestedCwd = join(tempDir, 'apps', 'mailctrl');
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    const absolutePackPath = packAbsolutePath('issue-absolute');
    await contextToolMain(['add', absolutePackPath, 'docs/quickstart.md'], nestedCwd);

    assert.equal(existsSync(absolutePackPath), true);

    const stdout = await captureStdout(() =>
      contextToolMain(['view', absolutePackPath, '--json'], nestedCwd),
    );
    const payload = JSON.parse(stdout) as {
      refs: Array<{
        path: string;
        sourcePath: string;
        delivery: 'file' | 'excerpt';
      }>;
    };
    assert.equal(payload.refs.length, 1);
    assert.equal(payload.refs[0]?.path, join(tempDir, 'docs', 'quickstart.md'));
    assert.equal(payload.refs[0]?.sourcePath, join(tempDir, 'docs', 'quickstart.md'));
    assert.equal(payload.refs[0]?.delivery, 'file');
  });

  it('prefers the current git workspace root over an unrelated ancestor .omx directory', async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), 'omx-context-tool-root-'));
    const repoRoot = join(outerRoot, 'packages', 'mailctrl');
    const nestedCwd = join(repoRoot, 'src');
    const relativePackPath = packRelativePath('issue-git-root');
    const packPath = join(repoRoot, relativePackPath);

    try {
      await mkdir(join(outerRoot, '.omx'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');
      execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });

      await contextToolMain(['add', relativePackPath, 'docs/quickstart.md'], nestedCwd);

      assert.equal(existsSync(packPath), true);
      assert.equal(existsSync(join(outerRoot, relativePackPath)), false);

      const document = JSON.parse(await readFile(packPath, 'utf-8')) as {
        entries: Array<{ path: string }>;
      };
      assert.equal(document.entries[0]?.path, 'docs/quickstart.md');
    } finally {
      await rm(outerRoot, { recursive: true, force: true });
    }
  });

  it('uses the nearest ancestor .omx workspace root when git metadata is unavailable', async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), 'omx-context-tool-omx-root-'));
    const nestedCwd = join(outerRoot, 'packages', 'mailctrl', 'src');
    const relativePackPath = packRelativePath('issue-omx-root');
    const packPath = join(outerRoot, relativePackPath);

    try {
      await mkdir(join(outerRoot, '.omx', 'plans'), { recursive: true });
      await mkdir(join(outerRoot, 'docs'), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(outerRoot, '.omx', 'plans', 'prd-issue-omx-root.md'), '# PRD\n\nApproved context basis.\n');
      await writeFile(join(outerRoot, '.omx', 'plans', 'test-spec-issue-omx-root.md'), '# Test Spec\n\nApproved test basis.\n');
      await writeFile(join(outerRoot, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

      await contextToolMain(['add', relativePackPath, 'docs/quickstart.md'], nestedCwd);

      assert.equal(existsSync(packPath), true);
      assert.equal(existsSync(join(nestedCwd, relativePackPath)), false);

      const stdout = await captureStdout(() =>
        contextToolMain(['view', relativePackPath, '--json'], nestedCwd),
      );
      const payload = JSON.parse(stdout) as {
        refs: Array<{ path: string; sourcePath: string; delivery: 'file' | 'excerpt' }>;
      };
      assert.equal(payload.refs.length, 1);
      assert.equal(payload.refs[0]?.path, join(outerRoot, 'docs', 'quickstart.md'));
      assert.equal(payload.refs[0]?.sourcePath, join(outerRoot, 'docs', 'quickstart.md'));
    } finally {
      await rm(outerRoot, { recursive: true, force: true });
    }
  });

  it('fails closed instead of resolving add sources from an ancestor .omx workspace', async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), 'omx-context-tool-ancestor-add-'));
    const repoRoot = join(outerRoot, 'packages', 'mailctrl');
    const nestedCwd = join(repoRoot, 'src');
    const relativePackPath = packRelativePath('issue-parent-source');

    try {
      await mkdir(join(outerRoot, '.omx'), { recursive: true });
      await mkdir(join(outerRoot, 'docs'), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(outerRoot, 'docs', 'quickstart.md'), '# Quickstart\n\nParent project only.\n');
      execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });

      await assert.rejects(
        () => contextToolMain(['add', relativePackPath, 'docs/quickstart.md'], nestedCwd),
        /missing source docs\/quickstart\.md/,
      );

      assert.equal(existsSync(join(outerRoot, relativePackPath)), false);
      assert.equal(existsSync(join(repoRoot, relativePackPath)), false);
    } finally {
      await rm(outerRoot, { recursive: true, force: true });
    }
  });

  it('fails closed instead of resolving sync/query/view packs from an ancestor .omx workspace', async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), 'omx-context-tool-ancestor-pack-'));
    const repoRoot = join(outerRoot, 'packages', 'mailctrl');
    const nestedCwd = join(repoRoot, 'src');
    const { packPath, relativePackPath } = await writeReadyPack(outerRoot, 'issue-parent-pack');
    const originalPack = await readFile(packPath, 'utf-8');

    try {
      await mkdir(nestedCwd, { recursive: true });
      execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });

      for (const args of [
        ['sync', relativePackPath],
        ['query', relativePackPath, '--json'],
        ['view', relativePackPath, '--json'],
      ]) {
        await assert.rejects(
          () => contextToolMain(args, nestedCwd),
          /Context pack not found:/,
        );
      }

      assert.equal(await readFile(packPath, 'utf-8'), originalPack);
      assert.equal(existsSync(join(repoRoot, relativePackPath)), false);
    } finally {
      await rm(outerRoot, { recursive: true, force: true });
    }
  });

  it('rejects relative pack paths that escape the active workspace', async () => {
    const workspaceRoot = join(tempDir, 'current');
    const siblingRoot = join(tempDir, 'other');
    const escapingPackPath = '../other/.omx/context/context-20260420T000000Z-issue-sibling.json';
    const siblingPack = await writeReadyPack(siblingRoot, 'issue-sibling');
    const originalSiblingPack = await readFile(siblingPack.packPath, 'utf-8');

    await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
    await writeFile(join(workspaceRoot, 'docs', 'quickstart.md'), '# Quickstart\n\nCurrent workspace only.\n');

    await assert.rejects(
      () => contextToolMain(['add', escapingPackPath, 'docs/quickstart.md'], workspaceRoot),
      /Context pack path must be \.omx\/context\/context-<timestamp>-<slug>\.json\./,
    );

    for (const args of [
      ['sync', escapingPackPath],
      ['query', escapingPackPath, '--json'],
      ['view', escapingPackPath, '--json'],
    ]) {
      await assert.rejects(
        () => contextToolMain(args, workspaceRoot),
        /Context pack path must be \.omx\/context\/context-<timestamp>-<slug>\.json\./,
      );
    }

    assert.equal(existsSync(join(workspaceRoot, '.omx', 'context', 'context-20260420T000000Z-issue-sibling.json')), false);
    assert.equal(await readFile(siblingPack.packPath, 'utf-8'), originalSiblingPack);
  });

  it('merges equivalent source refs into a shared multi-role entry with a documented relation tag', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await contextToolMain(['add', packRelativePath('issue-roles'), 'docs/quickstart.md', '--tag', 'baseline'], tempDir);
    await contextToolMain([
      'add',
      packRelativePath('issue-roles'),
      'docs/./quickstart.md',
      '--role', 'verify',
      '--tag', 'acceptance',
    ], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath('issue-roles'), 'utf-8')) as {
      entries: Array<{
        label: string;
        path: string;
        roles: string[];
        tags: string[];
        relationPath: Array<{ tag: string; target: string }>;
      }>;
    };
    assert.equal(document.entries.length, 1);
    assert.equal(document.entries[0]?.label, 'quickstart');
    assert.equal(document.entries[0]?.path, 'docs/quickstart.md');
    assert.deepEqual(document.entries[0]?.roles, ['build', 'verify']);
    assert.deepEqual(document.entries[0]?.tags, ['acceptance', 'baseline']);
    assert.deepEqual(document.entries[0]?.relationPath, [
      { tag: 'plan', target: 'issue-roles' },
      { tag: 'implements', target: 'docs/quickstart.md' },
    ]);
  });

  it('allows the same source path to appear multiple times when labels/selectors differ', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      [
        '# Runtime',
        '',
        '## Runtime Contract',
        '',
        Array.from({ length: 80 }, () => 'Build detail stays intentionally compact when excerpted.').join(' '),
        '',
        '## Deferred Work',
        '',
        Array.from({ length: 80 }, () => 'Deferred detail stays intentionally compact when excerpted.').join(' '),
        '',
      ].join('\n'),
    );

    await contextToolMain([
      'add',
      packRelativePath(),
      'docs/runtime.md',
      '--label', 'runtime',
      '--heading', '## Runtime Contract',
      '--max-words', '120',
      '--tag', 'runtime',
    ], tempDir);
    await contextToolMain([
      'add',
      packRelativePath(),
      'docs/runtime.md',
      '--label', 'deferred-work',
      '--role', 'verify',
      '--heading', '## Deferred Work',
      '--max-words', '120',
      '--tag', 'deferred',
    ], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath(), 'utf-8')) as {
      entries: Array<{ label: string; path: string; roles: string[] }>;
    };
    assert.equal(document.entries.length, 2);
    assert.deepEqual(
      document.entries.map((entry) => [entry.label, entry.path, entry.roles.join(',')]),
      [
        ['runtime', 'docs/runtime.md', 'build'],
        ['deferred-work', 'docs/runtime.md', 'verify'],
      ],
    );
  });

  it('rejects invalid v1 roles at the tool boundary', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    await assert.rejects(
      () => contextToolMain(['add', packRelativePath(), 'docs/quickstart.md', '--role', 'execution'], tempDir),
      /Invalid role "execution"\. Use one of: scope, build, verify\./,
    );
  });

  it('rejects adding a long source without a selector', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      `# Runtime\n\n${Array.from({ length: 90 }, () => 'This runtime file is intentionally too long to load wholesale.').join(' ')}\n`,
    );

    await assert.rejects(
      () => contextToolMain(['add', packRelativePath(), 'docs/runtime.md'], tempDir),
      /must declare a selector/,
    );
    assert.equal(existsSync(packAbsolutePath()), false);
  });

  it('sync does not impose a fixed ref-count ceiling on valid v1 packs', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-many.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-many.md'), '# Test Spec\n\nApproved test basis.\n');

    for (let index = 1; index <= 9; index += 1) {
      await writeFile(join(tempDir, 'docs', `ref-${index}.md`), `# Ref ${index}\n\nEntry ${index}.\n`);
    }

    writeContextPackDocument(packAbsolutePath('issue-many'), {
      schema: 'omx-context-pack-v1',
      slug: 'issue-many',
      entries: Array.from({ length: 9 }, (_, offset) => {
        const index = offset + 1;
        const role = index === 1 ? 'scope' : index === 2 ? 'verify' : 'build';
        const relationTag = role === 'scope' ? 'bounds' : role === 'verify' ? 'verifies' : 'implements';
        return {
          label: `ref-${index}`,
          path: `docs/ref-${index}.md`,
          roles: [role],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-many' },
            { tag: relationTag, target: `docs/ref-${index}.md` },
          ],
        };
      }),
    }, { refreshBasis: true });

    await contextToolMain(['sync', packRelativePath('issue-many')], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath('issue-many'), 'utf-8')) as {
      entries: Array<{ label: string }>;
    };
    assert.equal(document.entries.length, 9);
  });

  it('sync rejects custom relation paths that contradict the entry source semantics', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-relation.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-relation.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nScope context.\n');
    await writeFile(
      join(tempDir, 'docs', 'runtime.md'),
      '# Runtime\n\n## Runtime Contract\n\nBuild context.\n',
    );
    await writeFile(join(tempDir, 'docs', 'acceptance.md'), '# Acceptance\n\nVerify context.\n');
    await mkdir(join(tempDir, '.omx', 'context'), { recursive: true });
    await writeFile(
      packAbsolutePath('issue-relation'),
      `${JSON.stringify({
        schema: 'omx-context-pack-v1',
        slug: 'issue-relation',
        entries: [
          {
            label: 'boundary',
            path: 'docs/boundary.md',
            roles: ['scope'],
            tags: [],
            relationPath: [
              { tag: 'plan', target: 'issue-relation' },
              { tag: 'bounds', target: 'docs/boundary.md' },
            ],
          },
          {
            label: 'runtime',
            path: 'docs/runtime.md',
            roles: ['build'],
            tags: ['runtime'],
            selector: { type: 'heading', value: '## Runtime Contract', maxWords: 120 },
            relationPath: [
              { tag: 'plan', target: 'issue-relation' },
              { tag: 'verifies', target: 'docs/acceptance.md#gate-a' },
            ],
          },
          {
            label: 'acceptance',
            path: 'docs/acceptance.md',
            roles: ['verify'],
            tags: [],
            relationPath: [
              { tag: 'plan', target: 'issue-relation' },
              { tag: 'verifies', target: 'docs/acceptance.md' },
            ],
          },
        ],
      }, null, 2)}\n`,
    );

    await assert.rejects(
      () => contextToolMain(['sync', packRelativePath('issue-relation')], tempDir),
      /relationPath must end with implements: docs\/runtime\.md#runtime-contract/,
    );
  });

  it('sync accepts shared multi-role entries that use documented relation tags', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, '.omx', 'plans'), { recursive: true });
    await writeFile(join(tempDir, '.omx', 'plans', 'prd-issue-shared.md'), '# PRD\n\nApproved context basis.\n');
    await writeFile(join(tempDir, '.omx', 'plans', 'test-spec-issue-shared.md'), '# Test Spec\n\nApproved test basis.\n');
    await writeFile(join(tempDir, 'docs', 'boundary.md'), '# Boundary\n\nScope guardrails.\n');
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nShared build and verify guidance.\n');
    await mkdir(join(tempDir, '.omx', 'context'), { recursive: true });
    await writeFile(
      packAbsolutePath('issue-shared'),
      `${JSON.stringify({
        schema: 'omx-context-pack-v1',
        slug: 'issue-shared',
        entries: [
          {
            label: 'boundary',
            path: 'docs/boundary.md',
            roles: ['scope'],
            tags: [],
            relationPath: [
              { tag: 'plan', target: 'issue-shared' },
              { tag: 'bounds', target: 'docs/boundary.md' },
            ],
          },
          {
            label: 'quickstart',
            path: 'docs/quickstart.md',
            roles: ['build', 'verify'],
            tags: [],
            relationPath: [
              { tag: 'plan', target: 'issue-shared' },
              { tag: 'verifies', target: 'docs/quickstart.md' },
            ],
          },
        ],
      }, null, 2)}\n`,
    );

    await contextToolMain(['sync', packRelativePath('issue-shared')], tempDir);

    const document = JSON.parse(await readFile(packAbsolutePath('issue-shared'), 'utf-8')) as {
      entries: Array<{
        label: string;
        relationPath: Array<{ tag: string; target: string }>;
      }>;
    };
    const quickstartEntry = document.entries.find((entry) => entry.label === 'quickstart');
    assert.deepEqual(quickstartEntry?.relationPath, [
      { tag: 'plan', target: 'issue-shared' },
      { tag: 'verifies', target: 'docs/quickstart.md' },
    ]);
  });

  it('fails fast when an existing pack is invalid instead of recreating it empty', async () => {
    await mkdir(join(tempDir, '.omx', 'context'), { recursive: true });
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'quickstart.md'), '# Quickstart\n\nStart here.\n');

    const packPath = packAbsolutePath('issue-invalid');
    const original = '{invalid json\n';
    await writeFile(packPath, original);

    await assert.rejects(
      () => contextToolMain(['add', packRelativePath('issue-invalid'), 'docs/quickstart.md'], tempDir),
      /Could not read context pack:/,
    );
    assert.equal(await readFile(packPath, 'utf-8'), original);
  });

  it('rejects missing and unreadable packs for query and view', async () => {
    for (const command of ['query', 'view'] as const) {
      await assert.rejects(
        () => contextToolMain([command, packRelativePath('issue-missing')], tempDir),
        /Context pack not found:/,
      );
    }

    await mkdir(join(tempDir, '.omx', 'context'), { recursive: true });
    await writeFile(packAbsolutePath('issue-bad-read'), '{invalid json\n');

    for (const command of ['query', 'view'] as const) {
      await assert.rejects(
        () => contextToolMain([command, packRelativePath('issue-bad-read')], tempDir),
        /Could not read context pack:/,
      );
    }
  });

  it('normalizes query and view tag and label filters the same way as add', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'runtime.md'), '# Runtime\n\nStart here.\n');

    await contextToolMain([
      'add',
      packRelativePath('issue-filters'),
      'docs/runtime.md',
      '--label', 'Runtime Contract',
      '--tag', 'API Contract',
    ], tempDir);

    const queryStdout = await captureStdout(() =>
      contextToolMain([
        'query',
        packRelativePath('issue-filters'),
        '--label', 'Runtime Contract',
        '--tag', 'API Contract',
        '--json',
      ], tempDir),
    );
    const queryPayload = JSON.parse(queryStdout) as {
      entries: Array<{ label: string; tags: string[] }>;
    };
    assert.equal(queryPayload.entries.length, 1);
    assert.equal(queryPayload.entries[0]?.label, 'runtime-contract');
    assert.deepEqual(queryPayload.entries[0]?.tags, ['api-contract']);

    const viewStdout = await captureStdout(() =>
      contextToolMain([
        'view',
        packRelativePath('issue-filters'),
        '--label', 'Runtime Contract',
        '--tag', 'API Contract',
        '--json',
      ], tempDir),
    );
    const viewPayload = JSON.parse(viewStdout) as {
      refs: Array<{ label: string; delivery: 'file' | 'excerpt' }>;
    };
    assert.equal(viewPayload.refs.length, 1);
    assert.equal(viewPayload.refs[0]?.label, 'runtime-contract');
    assert.equal(viewPayload.refs[0]?.delivery, 'file');
  });

  it('normalizes Unicode label filters the same way as add', async () => {
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(join(tempDir, 'docs', 'café-runtime.md'), '# Runtime\n\nStart here.\n');

    await contextToolMain([
      'add',
      packRelativePath('issue-unicode-filters'),
      'docs/café-runtime.md',
      '--label', 'Café Runtime',
    ], tempDir);

    const queryStdout = await captureStdout(() =>
      contextToolMain([
        'query',
        packRelativePath('issue-unicode-filters'),
        '--label', 'Café Runtime',
        '--json',
      ], tempDir),
    );
    const queryPayload = JSON.parse(queryStdout) as {
      entries: Array<{ label: string; path: string }>;
    };
    assert.equal(queryPayload.entries.length, 1);
    assert.equal(queryPayload.entries[0]?.label, 'café-runtime');
    assert.equal(queryPayload.entries[0]?.path, 'docs/café-runtime.md');

    const viewStdout = await captureStdout(() =>
      contextToolMain([
        'view',
        packRelativePath('issue-unicode-filters'),
        '--label', 'café-runtime',
        '--json',
      ], tempDir),
    );
    const viewPayload = JSON.parse(viewStdout) as {
      refs: Array<{ label: string; sourcePath: string }>;
    };
    assert.equal(viewPayload.refs.length, 1);
    assert.equal(viewPayload.refs[0]?.label, 'café-runtime');
    assert.equal(viewPayload.refs[0]?.sourcePath, join(tempDir, 'docs', 'café-runtime.md'));
  });

  it('rejects source paths that escape the repo root', async () => {
    await assert.rejects(
      () => contextToolMain(['add', packRelativePath(), '../outside.md'], tempDir),
      /repo-relative path/,
    );
  });
});
