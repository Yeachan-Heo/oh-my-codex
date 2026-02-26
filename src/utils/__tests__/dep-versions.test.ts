import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function readInstalledVersion(pkg: string): string {
  const pkgJson = JSON.parse(
    readFileSync(join('node_modules', pkg, 'package.json'), 'utf8'),
  ) as { version: string };
  return pkgJson.version;
}

function semverGte(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map(Number) as [number, number, number];
  const [ma, mi, pa] = parse(version);
  const [mb, mib, pb] = parse(minimum);
  if (ma !== mb) return ma > mb;
  if (mi !== mib) return mi > mib;
  return pa >= pb;
}

/** Skip reason when a package is not installed (worktrees, CI without install). */
function skipUnless(pkg: string): string | undefined {
  return existsSync(join('node_modules', pkg, 'package.json'))
    ? undefined
    : `${pkg} not installed (node_modules unavailable)`;
}

describe('transitive dependency minimum safe versions (issue #170)', () => {
  it('ajv is at least 8.18.0 (fixes GHSA-2g4f-4pwh-qvx6 ReDoS)', { skip: skipUnless('ajv') }, () => {
    const version = readInstalledVersion('ajv');
    assert.ok(
      semverGte(version, '8.18.0'),
      `ajv@${version} is below the minimum safe version 8.18.0`,
    );
  });

  it('hono is at least 4.11.10 (fixes GHSA-gq3j-xvxp-8hrf timing attack)', { skip: skipUnless('hono') }, () => {
    const version = readInstalledVersion('hono');
    assert.ok(
      semverGte(version, '4.11.10'),
      `hono@${version} is below the minimum safe version 4.11.10`,
    );
  });
});
