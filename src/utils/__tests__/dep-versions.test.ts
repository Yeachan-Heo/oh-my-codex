import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

function readInstalledVersions(pkg: string): string[] {
  const manifests = new Set<string>();
  const directManifest = join('node_modules', pkg, 'package.json');
  if (existsSync(directManifest)) manifests.add(directManifest);

  const pnpmStoreDir = join('node_modules', '.pnpm');
  if (existsSync(pnpmStoreDir)) {
    const manifestSuffix = join('node_modules', pkg, 'package.json');
    for (const entry of readdirSync(pnpmStoreDir)) {
      const manifestPath = join(pnpmStoreDir, entry, manifestSuffix);
      if (existsSync(manifestPath)) manifests.add(manifestPath);
    }
  }

  return [...manifests]
    .map((manifestPath) => JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string })
    .map((pkgJson) => pkgJson.version)
    .sort();
}

function semverGte(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map(Number) as [number, number, number];
  const [ma, mi, pa] = parse(version);
  const [mb, mib, pb] = parse(minimum);
  if (ma !== mb) return ma > mb;
  if (mi !== mib) return mi > mib;
  return pa >= pb;
}

describe('transitive dependency minimum safe versions (issue #170)', () => {
  it('ajv is at least 8.18.0 (fixes GHSA-2g4f-4pwh-qvx6 ReDoS)', () => {
    const versions = readInstalledVersions('ajv');
    assert.ok(versions.length > 0, 'expected to find at least one installed ajv version');
    assert.ok(
      versions.every((version) => semverGte(version, '8.18.0')),
      `ajv versions [${versions.join(', ')}] include a version below the minimum safe version 8.18.0`,
    );
  });

  it('hono is at least 4.11.10 (fixes GHSA-gq3j-xvxp-8hrf timing attack)', () => {
    const versions = readInstalledVersions('hono');
    assert.ok(versions.length > 0, 'expected to find at least one installed hono version');
    assert.ok(
      versions.every((version) => semverGte(version, '4.11.10')),
      `hono versions [${versions.join(', ')}] include a version below the minimum safe version 4.11.10`,
    );
  });
});
