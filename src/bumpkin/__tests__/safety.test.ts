import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkBlastRadius, matchesSurface } from '../safety/blast-radius.js';
import { checkCategory } from '../safety/category-check.js';

describe('bumpkin/blast-radius', () => {
  it('matchesSurface handles literal paths', () => {
    assert.equal(matchesSurface('src/foo.ts', ['src/foo.ts']), true);
    assert.equal(matchesSurface('src/bar.ts', ['src/foo.ts']), false);
  });

  it('matchesSurface handles /** globs', () => {
    assert.equal(matchesSurface('src/router/index.ts', ['src/router/**']), true);
    assert.equal(matchesSurface('src/billing/index.ts', ['src/router/**']), false);
  });

  it('passes when all diff paths are inside the expected surface', () => {
    const v = checkBlastRadius({
      expectedSurface: ['src/router/**', 'package.json'],
      diffPaths: ['src/router/routes.ts', 'package.json'],
      diffLineCount: 40,
    });
    assert.equal(v.pass, true);
    assert.equal(v.fileCount, 2);
  });

  it('fails and reports paths outside surface', () => {
    const v = checkBlastRadius({
      expectedSurface: ['src/router/**'],
      diffPaths: ['src/router/routes.ts', 'src/billing/invoice.ts'],
      diffLineCount: 20,
    });
    assert.equal(v.pass, false);
    assert.deepEqual(v.outOfSurface, ['src/billing/invoice.ts']);
    assert.match(v.reason, /outside expected surface/);
  });

  it('fails when file count exceeds maxFiles', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `src/router/x${i}.ts`);
    const v = checkBlastRadius({
      expectedSurface: ['src/router/**'],
      diffPaths: paths,
      diffLineCount: 100,
      maxFiles: 20,
    });
    assert.equal(v.pass, false);
    assert.match(v.reason, /25 files \(>20 max\)/);
  });

  it('fails when line count exceeds maxLines', () => {
    const v = checkBlastRadius({
      expectedSurface: ['src/router/**'],
      diffPaths: ['src/router/routes.ts'],
      diffLineCount: 600,
      maxLines: 500,
    });
    assert.equal(v.pass, false);
    assert.match(v.reason, /600 lines \(>500 max\)/);
  });
});

describe('bumpkin/category-check', () => {
  it('passes when no safety-critical paths or keywords present', () => {
    const v = checkCategory({ diffPaths: ['src/router/routes.ts'] });
    assert.equal(v.pass, true);
    assert.deepEqual(v.matchedPaths, []);
  });

  it('fails when diff touches auth/', () => {
    const v = checkCategory({ diffPaths: ['src/auth/token.ts'] });
    assert.equal(v.pass, false);
    assert.deepEqual(v.matchedPaths, ['src/auth/token.ts']);
  });

  it('fails when diff touches payments/', () => {
    const v = checkCategory({ diffPaths: ['app/payments/charge.ts'] });
    assert.equal(v.pass, false);
    assert.match(v.reason, /safety-critical/);
  });

  it('fails when diff content mentions a safety-critical keyword', () => {
    const v = checkCategory({
      diffPaths: ['src/utils/config.ts'],
      diffContent: 'const PASSWORD = process.env.PASSWORD;',
    });
    assert.equal(v.pass, false);
    assert.deepEqual(v.matchedKeywords, ['password']);
  });

  it('allows custom patterns to override defaults', () => {
    const v = checkCategory({
      diffPaths: ['app/auth/login.ts'],
      patterns: ['compliance/'],
    });
    assert.equal(v.pass, true);
  });
});
