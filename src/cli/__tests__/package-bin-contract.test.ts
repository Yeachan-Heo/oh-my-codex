import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type PackageJson = {
  files?: string[];
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
};

type NpmPackDryRunFile = {
  path: string;
  mode?: number;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunFile[];
};

describe('package bin contract', () => {
  it('declares omx with an explicit relative bin path and ships packaged explore harness assets', () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;

    assert.deepEqual(pkg.bin, { omx: 'bin/omx.js' });
    assert.equal(pkg.scripts?.['build:explore'], 'cargo build -p omx-explore-harness');
    assert.equal(pkg.scripts?.['build:explore:release'], 'node scripts/build-explore-harness.js');
    assert.equal(pkg.scripts?.prepack, 'npm run build && npm run build:explore:release');
    assert.equal(pkg.scripts?.postpack, 'node scripts/cleanup-explore-harness.js');
    assert.equal(pkg.scripts?.['test:explore'], 'cargo test -p omx-explore-harness && node --test dist/cli/__tests__/explore.test.js dist/hooks/__tests__/explore-routing.test.js');
    assert.ok(pkg.files?.includes('Cargo.toml'));
    assert.ok(pkg.files?.includes('Cargo.lock'));
    assert.ok(pkg.files?.includes('crates/'));

    const binPath = join(process.cwd(), 'bin', 'omx.js');
    assert.equal(existsSync(binPath), true, 'expected bin/omx.js to exist');

    const binSource = readFileSync(binPath, 'utf-8');
    assert.match(binSource, /^#!\/usr\/bin\/env node/);

    const stat = statSync(binPath);
    assert.notEqual(stat.mode & 0o111, 0, 'expected bin/omx.js to be executable');

    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.equal(packed.status, 0, packed.stderr || packed.stdout);

    const results = JSON.parse(packed.stdout) as NpmPackDryRunResult[];
    assert.equal(Array.isArray(results), true, 'expected npm pack --json array output');

    const binEntry = results[0]?.files?.find((file) => file.path === 'bin/omx.js');
    assert.ok(binEntry, 'expected npm pack output to include bin/omx.js');
    assert.notEqual((binEntry.mode ?? 0) & 0o111, 0, 'expected packed bin/omx.js to keep execute bits');

    const packagedHarnessPath = process.platform === 'win32' ? 'bin/omx-explore-harness.exe' : 'bin/omx-explore-harness';
    const packagedHarnessEntry = results[0]?.files?.find((file) => file.path === packagedHarnessPath);
    const packagedHarnessMetaEntry = results[0]?.files?.find((file) => file.path === 'bin/omx-explore-harness.meta.json');
    const cargoTomlEntry = results[0]?.files?.find((file) => file.path === 'Cargo.toml');
    const cargoLockEntry = results[0]?.files?.find((file) => file.path === 'Cargo.lock');
    const crateManifestEntry = results[0]?.files?.find((file) => file.path === 'crates/omx-explore/Cargo.toml');
    const crateMainEntry = results[0]?.files?.find((file) => file.path === 'crates/omx-explore/src/main.rs');

    assert.ok(packagedHarnessEntry, `expected npm pack output to include ${packagedHarnessPath}`);
    assert.ok(packagedHarnessMetaEntry, 'expected npm pack output to include the packaged explore harness metadata');
    assert.notEqual((packagedHarnessEntry?.mode ?? 0) & 0o111, 0, `expected packed ${packagedHarnessPath} to keep execute bits`);
    assert.ok(cargoTomlEntry, 'expected npm pack output to include Cargo.toml');
    assert.ok(cargoLockEntry, 'expected npm pack output to include Cargo.lock');
    assert.ok(crateManifestEntry, 'expected npm pack output to include crates/omx-explore/Cargo.toml');
    assert.ok(crateMainEntry, 'expected npm pack output to include crates/omx-explore/src/main.rs');
  });
});
