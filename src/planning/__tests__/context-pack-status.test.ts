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
    assert.equal(status.roleCoverage, 'covered');
    assert.equal(status.basisState, 'fresh');
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
});
