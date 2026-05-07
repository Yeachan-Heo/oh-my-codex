import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { contextToolMain } from '../context-tool.js';

let tempDir: string;

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function relativeToRepo(path: string): string {
  return relative(tempDir, path).replaceAll('\\', '/');
}

function packRelativePath(slug: string, timestamp = '20260507T120000Z'): string {
  return `.omx/context/context-${timestamp}-${slug}.json`;
}

async function writePackFixture(slug: string, timestamp = '20260507T120000Z'): Promise<{
  packPath: string;
  relativePackPath: string;
}> {
  const plansDir = join(tempDir, '.omx', 'plans');
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(plansDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });

  const prdPath = join(plansDir, `prd-${slug}.md`);
  const testSpecPath = join(plansDir, `test-spec-${slug}.md`);
  const relativePackPath = packRelativePath(slug, timestamp);
  const packPath = join(tempDir, relativePackPath);
  const prdContent = [
    '# PRD',
    '',
    '## Context Pack Outcome',
    '',
    `- pack: created \`${packRelativePath(slug)}\``,
    '',
    `Launch via omx ralph "Execute ${slug} handoff"`,
  ].join('\n');
  const testSpecContent = '# Test Spec\n';
  await writeFile(prdPath, prdContent);
  await writeFile(testSpecPath, testSpecContent);
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
    entries: [
      { path: 'docs/scope.md', roles: ['scope'] },
      { path: 'docs/build.md', roles: ['build'] },
      { path: 'docs/verify.md', roles: ['verify'] },
    ],
  }, null, 2));

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
  it('prints status-only help text', async () => {
    const stdout = await captureStdout(() => contextToolMain([], tempDir));
    assert.match(stdout, /node dist\/planning\/context-tool\.js status/);
    assert.doesNotMatch(stdout, /node dist\/planning\/context-tool\.js query/);
    assert.doesNotMatch(stdout, /node dist\/planning\/context-tool\.js view/);
  });

  it('resolves ready status from a nested workspace cwd', async () => {
    const slug = 'issue-status';
    const { relativePackPath } = await writePackFixture(slug);
    const nestedCwd = join(tempDir, 'packages', 'app');
    await mkdir(nestedCwd, { recursive: true });

    const stdout = await captureStdout(() =>
      contextToolMain(['status', relativePackPath, '--json'], nestedCwd),
    );
    const parsed = JSON.parse(stdout) as {
      handoffState: string;
      declaredPackPath: string | null;
      missingRequiredContextPackRoles: string[];
    };

    assert.equal(parsed.handoffState, 'ready');
    assert.equal(parsed.declaredPackPath, relativePackPath);
    assert.deepEqual(parsed.missingRequiredContextPackRoles, []);
  });

  it('rejects noncanonical pack paths fail-closed', async () => {
    await assert.rejects(
      () => contextToolMain(['status', '.omx/context/not-a-pack.json'], tempDir),
      /Context pack path must be \.omx\/context\/context-<timestamp>-<slug>\.json\./,
    );
  });

  it('resolves status against the pack repo root for absolute canonical paths', async () => {
    const slug = 'absolute-status';
    const { packPath } = await writePackFixture(slug);
    const unrelatedCwd = await mkdtemp(join(tmpdir(), 'omx-context-tool-unrelated-'));

    try {
      const stdout = await captureStdout(() =>
        contextToolMain(['status', packPath, '--json'], unrelatedCwd),
      );
      const parsed = JSON.parse(stdout) as { handoffState: string; slug: string | null };
      assert.equal(parsed.handoffState, 'ready');
      assert.equal(parsed.slug, slug);
    } finally {
      await rm(unrelatedCwd, { recursive: true, force: true });
    }
  });

  it('fails closed when the approved plan declares a different pack for the same slug', async () => {
    const slug = 'different-pack';
    const { packPath } = await writePackFixture(slug, '20260507T130000Z');

    const stdout = await captureStdout(() =>
      contextToolMain(['status', packPath, '--json'], tempDir),
    );
    const parsed = JSON.parse(stdout) as {
      handoffState: string;
      outcomeState: string;
      issues: string[];
    };

    assert.equal(parsed.handoffState, 'invalid');
    assert.equal(parsed.outcomeState, 'other-pack');
    assert.ok(parsed.issues.some((issue) => issue.includes('Approved plan declares different context pack')));
  });
});
