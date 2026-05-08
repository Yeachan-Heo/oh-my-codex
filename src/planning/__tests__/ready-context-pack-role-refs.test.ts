import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readReadyContextPackRoleRefs } from '../context-pack-status.js';

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

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-pack-role-refs-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeContextPack(
  slug: string,
  entries: Array<{ path: string; roles: string[] }>,
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
  });
});
