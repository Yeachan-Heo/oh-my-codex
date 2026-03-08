import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type PackageJson = {
  bin?: string | Record<string, string>;
};

type NpmPackDryRunFile = {
  path: string;
  mode?: number;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunFile[];
};

describe('package bin contract', () => {
  it('declares omx with an explicit relative bin path and ships an executable wrapper', () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;

    assert.deepEqual(pkg.bin, { omx: 'bin/omx.js' });

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
  });
});
