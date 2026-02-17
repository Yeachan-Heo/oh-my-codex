import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from '../package.js';

describe('getPackageRoot', () => {
  it('returns a directory that contains package.json', () => {
    const root = getPackageRoot();
    assert.ok(existsSync(join(root, 'package.json')), `Expected package.json in ${root}`);
  });

  it('returns an absolute path', () => {
    const root = getPackageRoot();
    assert.ok(root.startsWith('/'), `Expected absolute path, got: ${root}`);
  });

  it('returns a consistent value on repeated calls', () => {
    const first = getPackageRoot();
    const second = getPackageRoot();
    assert.equal(first, second);
  });
});
