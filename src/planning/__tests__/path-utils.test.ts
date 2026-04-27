import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import {
  isCanonicalContextPackPath,
  normalizePlanningRepoRelativePath,
  resolveDeclaredContextPackPath,
} from '../path-utils.js';

function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pickOne<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function maybe(random: () => number, probability: number): boolean {
  return random() < probability;
}

function joinWithRandomSeparators(parts: readonly string[], random: () => number): string {
  return parts.reduce((joined, part, index) => {
    if (index === 0) {
      return part;
    }
    return `${joined}${pickOne(random, ['/', '//', '\\'])}${part}`;
  }, '');
}

function wrapPathNoise(rawPath: string, random: () => number): string {
  let value = rawPath;
  if (maybe(random, 0.6)) {
    value = `./${value}`;
  }
  if (maybe(random, 0.4)) {
    value = `\`${value}\``;
  }
  if (maybe(random, 0.5)) {
    value = ` ${value} `;
  }
  return value;
}

function buildCanonicalPackFileName(random: () => number): string {
  return `context-20260420T000000Z-${pickOne(random, ['issue-a', 'issue-b', 'issue-c'])}.json`;
}

function buildNoisyCanonicalPackPath(random: () => number): {
  rawPath: string;
  expectedNormalizedPath: string;
} {
  const canonicalFileName = buildCanonicalPackFileName(random);
  const noisyParts = ['.omx', 'context'];
  if (maybe(random, 0.35)) {
    noisyParts.push('.');
  }
  if (maybe(random, 0.35)) {
    noisyParts.push(pickOne(random, ['scratch', 'tmp', 'buffer']));
    noisyParts.push('..');
  }
  noisyParts.push(canonicalFileName);

  return {
    rawPath: wrapPathNoise(joinWithRandomSeparators(noisyParts, random), random),
    expectedNormalizedPath: `.omx/context/${canonicalFileName}`,
  };
}

function buildEscapingPath(random: () => number): string {
  const safeSegments = ['tmp', 'plans', 'outside', 'scratch'];
  const fileName = `context-20260420T000000Z-${pickOne(random, ['escape-a', 'escape-b', 'escape-c'])}.json`;
  const patterns = [
    ['.omx', 'context', '..', pickOne(random, safeSegments), fileName],
    ['.omx', 'context', '..', '..', pickOne(random, safeSegments), fileName],
    ['.omx', 'context', 'nested', fileName],
    ['.omx', 'context', '.', '..'],
    ['.omx', 'context'],
  ];
  return wrapPathNoise(joinWithRandomSeparators(pickOne(random, patterns), random), random);
}

describe('planning path utils', () => {
  describe('normalizePlanningRepoRelativePath', () => {
    it('normalizes representative planning paths consistently', () => {
      assert.equal(
        normalizePlanningRepoRelativePath('./docs\\./runtime.md'),
        'docs/runtime.md',
      );
      assert.equal(
        normalizePlanningRepoRelativePath('./.omx//context\\context-20260420T000000Z-issue-paths.json'),
        '.omx/context/context-20260420T000000Z-issue-paths.json',
      );
      assert.equal(
        normalizePlanningRepoRelativePath(' `.omx/context/../context/nested/../pack.json` '),
        '.omx/context/pack.json',
      );
      assert.equal(
        normalizePlanningRepoRelativePath('.omx/context/../../tmp/pack.json'),
        'tmp/pack.json',
      );
      assert.equal(
        normalizePlanningRepoRelativePath('../docs/../tmp/spec.md'),
        '../tmp/spec.md',
      );
    });

    it('is idempotent and strips wrapper noise across generated path-like inputs', () => {
      const random = createDeterministicRandom(0x5eed1234);
      const atoms = ['.omx', 'context', 'docs', 'runtime.md', 'spec.md', '.', '..', 'nested', 'tmp'];

      for (let index = 0; index < 300; index += 1) {
        const segmentCount = 1 + Math.floor(random() * 6);
        const rawSegments = Array.from({ length: segmentCount }, () => pickOne(random, atoms));
        const rawPath = wrapPathNoise(joinWithRandomSeparators(rawSegments, random), random);
        const normalized = normalizePlanningRepoRelativePath(rawPath);
        const renormalized = normalizePlanningRepoRelativePath(normalized);

        assert.equal(renormalized, normalized, `expected idempotent normalization for ${JSON.stringify(rawPath)}`);
        assert.equal(normalized.includes('\\'), false, `expected slash-normalized output for ${JSON.stringify(rawPath)}`);
        assert.equal(normalized.trim(), normalized, `expected trimmed output for ${JSON.stringify(rawPath)}`);
        assert.equal(normalized.startsWith('./'), false, `expected no leading ./ in ${JSON.stringify(rawPath)}`);
        assert.equal(normalized.startsWith('`'), false, `expected no leading backtick in ${JSON.stringify(rawPath)}`);
        assert.equal(normalized.endsWith('`'), false, `expected no trailing backtick in ${JSON.stringify(rawPath)}`);
      }
    });
  });

  describe('resolveDeclaredContextPackPath', () => {
    it('accepts flat canonical pack paths under the context directory', () => {
      const repoRoot = '/repo with spaces';
      assert.deepEqual(
        resolveDeclaredContextPackPath(
          repoRoot,
          './.omx/context/../context/context-20260420T000000Z-issue-paths.json',
        ),
        {
          normalizedPath: '.omx/context/context-20260420T000000Z-issue-paths.json',
          resolvedPath: join(repoRoot, '.omx', 'context', 'context-20260420T000000Z-issue-paths.json'),
        },
      );
    });

    it('rejects directory-only, escaping, absolute, and non-context declarations', () => {
      const repoRoot = '/repo';
      const invalidPaths = [
        '.omx/context',
        '.omx/context/',
        '.omx/context/.',
        '.omx/context/..',
        '.omx/context/nested/context-20260420T000000Z-issue-paths.json',
        '.omx/context/../plans/context-20260420T000000Z-issue-paths.json',
        '.omx/context/../../tmp/context-20260420T000000Z-issue-paths.json',
        '.omx/plans/context-20260420T000000Z-issue-paths.json',
        '.omx/contextual/context-20260420T000000Z-issue-paths.json',
        '/tmp/context-20260420T000000Z-issue-paths.json',
        'C:\\temp\\context-20260420T000000Z-issue-paths.json',
        'file:///tmp/context-20260420T000000Z-issue-paths.json',
        'https://example.com/context-20260420T000000Z-issue-paths.json',
      ];

      for (const rawPath of invalidPaths) {
        assert.equal(
          resolveDeclaredContextPackPath(repoRoot, rawPath),
          null,
          `expected ${JSON.stringify(rawPath)} to be rejected`,
        );
      }
    });

    it('accepts generated canonical pack paths and resolves them inside the canonical directory', () => {
      const repoRoot = '/repo';
      const canonicalContextDir = join(repoRoot, '.omx', 'context');
      const random = createDeterministicRandom(0x1badb002);

      for (let index = 0; index < 250; index += 1) {
        const testCase = buildNoisyCanonicalPackPath(random);
        const resolution = resolveDeclaredContextPackPath(repoRoot, testCase.rawPath);

        assert.ok(resolution, `expected canonical declaration to resolve: ${JSON.stringify(testCase.rawPath)}`);
        assert.equal(resolution?.normalizedPath, testCase.expectedNormalizedPath);
        assert.equal(
          resolution?.resolvedPath,
          resolve(repoRoot, testCase.expectedNormalizedPath),
        );
        assert.equal(
          resolution?.resolvedPath.startsWith(`${canonicalContextDir}/`),
          true,
          `expected resolved path inside canonical dir for ${JSON.stringify(testCase.rawPath)}`,
        );
      }
    });

    it('rejects generated escaping declarations that leave or collapse to the context directory root', () => {
      const repoRoot = '/repo';
      const random = createDeterministicRandom(0x0ff1ce);

      for (let index = 0; index < 200; index += 1) {
        const rawPath = buildEscapingPath(random);
        assert.equal(
          resolveDeclaredContextPackPath(repoRoot, rawPath),
          null,
          `expected escaping declaration to be rejected: ${JSON.stringify(rawPath)}`,
        );
      }
    });
  });

  describe('isCanonicalContextPackPath', () => {
    it('accepts only flat canonical pack paths', () => {
      assert.equal(isCanonicalContextPackPath('.omx/context/context-20260420T000000Z-issue-paths.json'), true);
      assert.equal(
        isCanonicalContextPackPath('/repo/.omx/context/context-20260420T000000Z-issue-paths.json'),
        true,
      );
      assert.equal(isCanonicalContextPackPath('.omx/context/nested/context-20260420T000000Z-issue-paths.json'), false);
      assert.equal(isCanonicalContextPackPath('docs/context-20260420T000000Z-issue-paths.json'), false);
    });
  });
});
