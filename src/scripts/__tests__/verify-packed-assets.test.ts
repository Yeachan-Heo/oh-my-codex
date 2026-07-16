import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseNpmPackManifest,
  REQUIRED_PACKED_ASSETS,
  verifyPackedAssetManifest,
  verifyPackedAssetPaths,
} from '../verify-packed-assets.js';

describe('packed asset manifest', () => {
  it('requires the installed code-review runtime contract test', () => {
    assert.ok(REQUIRED_PACKED_ASSETS.includes(
      'dist/scripts/__tests__/code-review-installed-contract.test.js' as typeof REQUIRED_PACKED_ASSETS[number],
    ));
  });

  it('accepts the complete npm pack manifest including prepack logs', () => {
    const stdout = `prepack output\n${JSON.stringify([{
      filename: 'oh-my-codex.tgz',
      files: REQUIRED_PACKED_ASSETS.map((path) => ({ path })),
    }])}`;
    const parsed = parseNpmPackManifest(stdout);
    assert.doesNotThrow(() => verifyPackedAssetManifest(parsed));
  });

  it('fails with exactly one precise diagnostic for the removed asset', () => {
    const missing = 'dist/scripts/run-compiled-ci.js';
    const paths = REQUIRED_PACKED_ASSETS.filter((path) => path !== missing);
    assert.throws(
      () => verifyPackedAssetPaths(paths),
      (error: unknown) => (error as Error).message === `PACKED_ASSET_MISSING: ${missing}`,
    );
  });

  it('rejects malformed npm output before checking individual assets', () => {
    assert.throws(() => parseNpmPackManifest('not json'), /^Error: PACKED_ASSET_MANIFEST_INVALID$/);
    assert.throws(() => verifyPackedAssetManifest([{ files: [{ path: 42 as unknown as string }] }]), /PACKED_ASSET_MANIFEST_INVALID/);
  });
});
