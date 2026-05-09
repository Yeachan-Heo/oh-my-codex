import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  readContextPackHandoffStatus,
  resolveContextPackHandoffState,
} from '../artifacts.js';

let tempDir: string;

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

function buildContextPackOutcome(relativePackPath: string): string {
  return [
    '## Context Pack Outcome',
    '',
    `- pack: created \`${relativePackPath}\``,
  ].join('\n');
}

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-pack-status-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeApprovedPlan(
  slug: string,
  bodyLines: string[],
): Promise<{ prdPath: string; testSpecPath: string; packPath: string; packRelativePath: string }> {
  const plansDir = join(tempDir, '.omx', 'plans');
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(plansDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });

  const prdPath = join(plansDir, `prd-${slug}.md`);
  const testSpecPath = join(plansDir, `test-spec-${slug}.md`);
  const packRelativePath = canonicalContextPackRelativePath(slug);
  const packPath = join(tempDir, packRelativePath);

  await writeFile(prdPath, bodyLines.join('\n'));
  await writeFile(testSpecPath, '# Test Spec\n');

  return { prdPath, testSpecPath, packPath, packRelativePath };
}

async function writeContextPack(
  slug: string,
  prdPath: string,
  testSpecPath: string,
  roles: string[],
): Promise<void> {
  const packPath = join(tempDir, canonicalContextPackRelativePath(slug));
  const prdActual = await readFile(prdPath, 'utf-8');
  const testSpecActual = await readFile(testSpecPath, 'utf-8');
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relativeToRepo(prdPath),
        sha1: computeGitBlobSha1(prdActual),
      },
      testSpecs: [{
        path: relativeToRepo(testSpecPath),
        sha1: computeGitBlobSha1(testSpecActual),
      }],
    },
    entries: roles.map((role, index) => ({
      path: `src/${role}-${index}.ts`,
      roles: [role],
    })),
  }, null, 2));
}

describe('context pack handoff status', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('maps the public context-pack state matrix into handoff status', () => {
    assert.equal(resolveContextPackHandoffState({
      baselineState: 'missing-prd',
      outcomeState: 'absent',
      packState: 'missing',
      roleCoverage: 'unknown',
      basisState: 'stale',
    }), 'missing-baseline');
    assert.equal(resolveContextPackHandoffState({
      baselineState: 'present',
      outcomeState: 'absent',
      packState: 'missing',
      roleCoverage: 'unknown',
      basisState: 'stale',
    }), 'plan-only');
    assert.equal(resolveContextPackHandoffState({
      baselineState: 'present',
      outcomeState: 'declared',
      packState: 'missing',
      roleCoverage: 'unknown',
      basisState: 'stale',
    }), 'incomplete');
    assert.equal(resolveContextPackHandoffState({
      baselineState: 'present',
      outcomeState: 'declared',
      packState: 'valid',
      roleCoverage: 'covered',
      basisState: 'fresh',
    }), 'ready');
    assert.equal(resolveContextPackHandoffState({
      baselineState: 'present',
      outcomeState: 'malformed',
      packState: 'valid',
      roleCoverage: 'unknown',
      basisState: 'fresh',
    }), 'invalid');
    assert.equal(resolveContextPackHandoffState({
      baselineState: 'present',
      outcomeState: 'declared',
      packState: 'valid',
      roleCoverage: 'covered',
      basisState: 'stale',
    }), 'invalid');
  });

  it('reports plan-only when the approved baseline has no declared context pack', async () => {
    await writeApprovedPlan('alpha', [
      '# PRD',
      '',
      'Launch via omx ralph "Execute alpha plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPack, null);
    assert.equal(status.contextPackStatus, 'plan-only');
    assert.equal(status.baselineState, 'present');
    assert.equal(status.outcomeState, 'absent');
    assert.equal(status.declarationState, 'unknown');
    assert.equal(status.contextPackRoleRefs, null);
    assert.equal(status.roleCoverage, 'unknown');
    assert.deepEqual(status.missingRequiredContextPackRoles, []);
    assert.deepEqual(status.contextPackIssues, []);
  });

  it('reports ready when the declared pack has fresh basis and all required roles', async () => {
    const { prdPath, testSpecPath, packPath } = await writeApprovedPlan('beta', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('beta')),
      '',
      'Launch via omx ralph "Execute beta plan"',
    ]);
    await writeContextPack('beta', prdPath, testSpecPath, ['scope', 'build', 'verify']);

    const status = readContextPackHandoffStatus(tempDir);

    assert.deepEqual(status.contextPack, { path: packPath });
    assert.equal(status.contextPackStatus, 'ready');
    assert.equal(status.packState, 'valid');
    assert.equal(status.declarationState, 'matching');
    assert.equal(status.roleCoverage, 'covered');
    assert.equal(status.basisState, 'fresh');
    assert.deepEqual(status.contextPackRoleRefs, {
      scope: ['src/scope-0.ts'],
      build: ['src/build-1.ts'],
      verify: ['src/verify-2.ts'],
    });
    assert.deepEqual(status.missingRequiredContextPackRoles, []);
    assert.deepEqual(status.contextPackIssues, []);
  });

  it('reports incomplete when the declared pack omits required execution roles', async () => {
    const { prdPath, testSpecPath } = await writeApprovedPlan('gamma', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('gamma')),
      '',
      'Launch via omx ralph "Execute gamma plan"',
    ]);
    await writeContextPack('gamma', prdPath, testSpecPath, ['scope']);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'incomplete');
    assert.equal(status.roleCoverage, 'missing-required-roles');
    assert.equal(status.contextPackRoleRefs, null);
    assert.equal(status.roleCoverage, 'missing-required-roles');
    assert.deepEqual(status.missingRequiredContextPackRoles, ['build', 'verify']);
  });

  it('reports invalid when the declared pack basis drifts from the approved test spec', async () => {
    const { prdPath, testSpecPath } = await writeApprovedPlan('delta', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('delta')),
      '',
      'Launch via omx ralph "Execute delta plan"',
    ]);
    await writeContextPack('delta', prdPath, testSpecPath, ['scope', 'build', 'verify']);
    await writeFile(testSpecPath, '# Drifted Test Spec\n');

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'invalid');
    assert.equal(status.roleCoverage, 'covered');
    assert.equal(status.basisState, 'stale');
    assert.equal(status.contextPackRoleRefs, null);
    assert.equal(status.basisState, 'stale');
    assert.deepEqual(status.missingRequiredContextPackRoles, []);
    assert.ok(status.contextPackIssues.some((issue) => issue.includes('basis test-spec hash')));
  });

  it('preserves inspectable missing roles even when the declared pack is otherwise invalid', async () => {
    const { prdPath, testSpecPath } = await writeApprovedPlan('delta-missing-roles', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('delta-missing-roles')),
      '',
      'Launch via omx ralph "Execute delta missing roles plan"',
    ]);
    await writeContextPack('delta-missing-roles', prdPath, testSpecPath, ['scope']);
    await writeFile(testSpecPath, '# Drifted Test Spec\n');

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'invalid');
    assert.equal(status.roleCoverage, 'missing-required-roles');
    assert.equal(status.contextPackRoleRefs, null);
    assert.deepEqual(status.missingRequiredContextPackRoles, ['build', 'verify']);
    assert.ok(status.contextPackIssues.some((issue) => issue.includes('basis test-spec hash')));
  });

  it('keeps role coverage unknown when the declared pack cannot be inspected', async () => {
    const { packPath } = await writeApprovedPlan('invalid-json', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('invalid-json')),
      '',
      'Launch via omx ralph "Execute invalid json plan"',
    ]);
    await writeFile(packPath, '{not json');

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'invalid');
    assert.equal(status.packState, 'invalid');
    assert.equal(status.contextPackRoleRefs, null);
    assert.equal(status.roleCoverage, 'unknown');
    assert.deepEqual(status.missingRequiredContextPackRoles, []);
    assert.ok(status.contextPackIssues.some((issue) => issue.includes('invalid JSON')));
  });

  it('ignores fenced outcome declarations and keeps the plan in plan-only status', async () => {
    await writeApprovedPlan('epsilon', [
      '# PRD',
      '',
      '```md',
      '## Context Pack Outcome',
      '',
      `- pack: created \`${canonicalContextPackRelativePath('epsilon')}\``,
      '```',
      '',
      'Launch via omx ralph "Execute epsilon plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'plan-only');
    assert.equal(status.outcomeState, 'absent');
  });

  it('ignores indented outcome declarations and keeps the plan in plan-only status', async () => {
    await writeApprovedPlan('epsilon-indented', [
      '# PRD',
      '',
      '    ## Context Pack Outcome',
      '',
      `    - pack: created \`${canonicalContextPackRelativePath('epsilon-indented')}\``,
      '',
      'Launch via omx ralph "Execute epsilon indented plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'plan-only');
    assert.equal(status.outcomeState, 'absent');
  });

  it('ignores commented outcome declarations and keeps the plan in plan-only status', async () => {
    await writeApprovedPlan('epsilon-commented', [
      '# PRD',
      '',
      '<!--',
      '## Context Pack Outcome',
      '',
      `- pack: created \`${canonicalContextPackRelativePath('epsilon-commented-hidden')}\``,
      '<!--',
      `- pack: created \`${canonicalContextPackRelativePath('epsilon-commented-hidden-deeper')}\``,
      '-->',
      '-->',
      '',
      'Launch via omx ralph "Execute epsilon commented plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'plan-only');
    assert.equal(status.outcomeState, 'absent');
  });

  it('ignores adversarial hidden outcome declarations and still reads the visible declaration', async () => {
    const { prdPath, testSpecPath } = await writeApprovedPlan('epsilon-adversarial', [
      '# PRD',
      '',
      '```md',
      '## Context Pack Outcome',
      '',
      `- pack: created \`${canonicalContextPackRelativePath('sample-hidden')}\``,
      '    ```',
      '```still-open',
      '~~~',
      '## Context Pack Outcome',
      '',
      `- pack: created \`${canonicalContextPackRelativePath('other-hidden')}\``,
      '```',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('epsilon-adversarial')),
      '',
      'Launch via omx ralph "Execute epsilon adversarial plan"',
    ]);
    await writeContextPack('epsilon-adversarial', prdPath, testSpecPath, ['scope', 'build', 'verify']);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'ready');
    assert.equal(status.outcomeState, 'declared');
    assert.deepEqual(status.contextPack, {
      path: join(tempDir, canonicalContextPackRelativePath('epsilon-adversarial')),
    });
    assert.deepEqual(status.contextPackIssues, []);
  });

  it('keeps the visible outcome section valid when nested hidden blocks appear inside it', async () => {
    const { prdPath, testSpecPath } = await writeApprovedPlan('epsilon-inner-hidden', [
      '# PRD',
      '',
      '## Context Pack Outcome',
      '',
      '<!--',
      `- pack: created \`${canonicalContextPackRelativePath('epsilon-inner-hidden-comment')}\``,
      '<!--',
      `- pack: created \`${canonicalContextPackRelativePath('epsilon-inner-hidden-comment-deeper')}\``,
      '-->',
      '-->',
      '```md',
      `- pack: created \`${canonicalContextPackRelativePath('epsilon-inner-hidden-fenced')}\``,
      '```',
      `    - pack: created \`${canonicalContextPackRelativePath('epsilon-inner-hidden-indented')}\``,
      `- pack: created \`${canonicalContextPackRelativePath('epsilon-inner-hidden')}\``,
      '',
      'Launch via omx ralph "Execute epsilon inner hidden plan"',
    ]);
    await writeContextPack('epsilon-inner-hidden', prdPath, testSpecPath, ['scope', 'build', 'verify']);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'ready');
    assert.equal(status.outcomeState, 'declared');
    assert.deepEqual(status.contextPack, {
      path: join(tempDir, canonicalContextPackRelativePath('epsilon-inner-hidden')),
    });
    assert.deepEqual(status.contextPackIssues, []);
  });

  it('rejects nested outcome paths that are not canonical context-pack files', async () => {
    await writeApprovedPlan('eta', [
      '# PRD',
      '',
      buildContextPackOutcome('.omx/context/context-20260507T120000Z-eta/nested.json'),
      '',
      'Launch via omx ralph "Execute eta plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'invalid');
    assert.equal(status.outcomeState, 'malformed');
    assert.ok(status.contextPackIssues.some((issue) => issue.includes(
      '.omx/context/context-<timestamp>-<slug>.json',
    )));
  });

  it('reports invalid when the declared pack slug does not match the approved plan even if the file is missing', async () => {
    await writeApprovedPlan('theta', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('other')),
      '',
      'Launch via omx ralph "Execute theta plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'invalid');
    assert.equal(status.outcomeState, 'declared');
    assert.equal(status.declarationState, 'mismatched');
    assert.equal(status.packState, 'invalid');
    assert.ok(status.contextPackIssues.some((issue) => issue.includes(
      'does not match approved plan slug theta',
    )));
  });

  it('reports invalid when the approved plan declares multiple outcome sections', async () => {
    await writeApprovedPlan('zeta', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('zeta')),
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('zeta')),
      '',
      'Launch via omx ralph "Execute zeta plan"',
    ]);

    const status = readContextPackHandoffStatus(tempDir);

    assert.equal(status.contextPackStatus, 'invalid');
    assert.equal(status.outcomeState, 'ambiguous');
    assert.ok(status.contextPackIssues.some((issue) => issue.includes('multiple Context Pack Outcome sections')));
  });

  it('distinguishes missing, unreadable, invalid, stale, mismatched, and missing-role handoffs', async () => {
    const cases: Array<{
      slug: string;
      mutate: (fixture: Awaited<ReturnType<typeof writeApprovedPlan>>) => Promise<void>;
      expected: {
        status: string;
        packState: string;
        declarationState: string;
        basisState: string;
        roleCoverage: string;
        issue?: string;
        missingRoles?: string[];
      };
    }> = [
      {
        slug: 'missing-pack',
        mutate: async () => {},
        expected: {
          status: 'incomplete',
          packState: 'missing',
          declarationState: 'matching',
          basisState: 'stale',
          roleCoverage: 'unknown',
          issue: 'file is missing',
        },
      },
      {
        slug: 'unreadable-pack',
        mutate: async ({ packPath }) => { await mkdir(packPath, { recursive: true }); },
        expected: {
          status: 'invalid',
          packState: 'unreadable',
          declarationState: 'matching',
          basisState: 'stale',
          roleCoverage: 'unknown',
          issue: 'could not be read',
        },
      },
      {
        slug: 'invalid-pack',
        mutate: async ({ packPath }) => { await writeFile(packPath, '{bad json'); },
        expected: {
          status: 'invalid',
          packState: 'invalid',
          declarationState: 'matching',
          basisState: 'stale',
          roleCoverage: 'unknown',
          issue: 'invalid JSON',
        },
      },
      {
        slug: 'stale-basis',
        mutate: async ({ prdPath, testSpecPath }) => {
          await writeContextPack('stale-basis', prdPath, testSpecPath, ['scope', 'build', 'verify']);
          await writeFile(testSpecPath, '# Drifted Test Spec\n');
        },
        expected: {
          status: 'invalid',
          packState: 'valid',
          declarationState: 'matching',
          basisState: 'stale',
          roleCoverage: 'covered',
          issue: 'basis test-spec hash',
        },
      },
      {
        slug: 'missing-role',
        mutate: async ({ prdPath, testSpecPath }) => {
          await writeContextPack('missing-role', prdPath, testSpecPath, ['scope']);
        },
        expected: {
          status: 'incomplete',
          packState: 'valid',
          declarationState: 'matching',
          basisState: 'fresh',
          roleCoverage: 'missing-required-roles',
          missingRoles: ['build', 'verify'],
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await writeApprovedPlan(testCase.slug, [
        '# PRD',
        '',
        buildContextPackOutcome(canonicalContextPackRelativePath(testCase.slug)),
        '',
        `Launch via omx ralph "Execute ${testCase.slug} plan"`,
      ]);
      await testCase.mutate(fixture);

      const status = readContextPackHandoffStatus(tempDir, fixture.prdPath);

      assert.equal(status.contextPackStatus, testCase.expected.status);
      assert.equal(status.packState, testCase.expected.packState);
      assert.equal(status.declarationState, testCase.expected.declarationState);
      assert.equal(status.basisState, testCase.expected.basisState);
      assert.equal(status.roleCoverage, testCase.expected.roleCoverage);
      assert.deepEqual(
        status.missingRequiredContextPackRoles,
        testCase.expected.missingRoles ?? [],
      );
      if (testCase.expected.issue) {
        assert.ok(
          status.contextPackIssues.some((issue) => issue.includes(testCase.expected.issue ?? '')),
          `expected issue containing ${testCase.expected.issue}`,
        );
      }
    }

    const mismatch = await writeApprovedPlan('declared-mismatch', [
      '# PRD',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath('other')),
      '',
      'Launch via omx ralph "Execute mismatch plan"',
    ]);
    const mismatchStatus = readContextPackHandoffStatus(tempDir, mismatch.prdPath);
    assert.equal(mismatchStatus.contextPackStatus, 'invalid');
    assert.equal(mismatchStatus.declarationState, 'mismatched');
    assert.equal(mismatchStatus.packState, 'invalid');
    assert.ok(mismatchStatus.contextPackIssues.some((issue) => issue.includes('does not match approved plan slug')));
  });
});
