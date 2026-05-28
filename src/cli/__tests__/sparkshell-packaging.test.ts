import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

type PackageJson = {
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
};

type NpmPackDryRunFile = {
  path: string;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunFile[];
};

describe('sparkshell packaging scaffold', () => {
  it('registers native helper scripts but keeps staged native artifacts out of npm releases', () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
    const binaryName = platform() === 'win32' ? 'omx-sparkshell.exe' : 'omx-sparkshell';
    const stagedRoot = mkdtempSync(join(tmpdir(), 'omx-sparkshell-stage-'));
    const fakeBin = mkdtempSync(join(tmpdir(), 'omx-sparkshell-cargo-'));
    const npmCache = mkdtempSync(join(tmpdir(), 'omx-sparkshell-npm-cache-'));
    const packagedBinaryRelativePath = join(`${platform()}-${arch()}`, binaryName);
    const packagedBinaryPath = join(stagedRoot, packagedBinaryRelativePath);
    const releaseBinaryPath = join(process.cwd(), 'target', 'release', binaryName);
    const originalReleaseBinary = existsSync(releaseBinaryPath) ? readFileSync(releaseBinaryPath) : null;

    assert.deepEqual(pkg.bin, { omx: 'dist/cli/omx.js' });
    assert.equal(pkg.scripts?.['build:sparkshell'], 'node dist/scripts/build-sparkshell.js');
    assert.equal(pkg.scripts?.['test:sparkshell'], 'node dist/scripts/test-sparkshell.js');
    assert.equal(pkg.files?.includes('dist/'), true, 'expected package files allowlist to include dist/');
    assert.equal(pkg.files?.includes('!crates/**/.omx/**'), true, 'expected package files allowlist to exclude crate runtime caches');
    assert.equal(pkg.files?.includes('bin/'), false, 'did not expect broad bin/ allowlist in package files');
    assert.equal(pkg.files?.includes('bin/native/'), false, 'did not expect package files to include bin/native/');
    assert.equal(pkg.files?.includes('dist/'), true);
    assert.equal(pkg.files?.includes('src/scripts/'), true);

    const buildScriptPath = join(process.cwd(), 'dist', 'scripts', 'build-sparkshell.js');
    const testScriptPath = join(process.cwd(), 'dist', 'scripts', 'test-sparkshell.js');
    const testScriptSource = readFileSync(testScriptPath, 'utf-8');
    assert.equal(existsSync(buildScriptPath), true, 'expected build sparkshell helper script to exist');
    assert.equal(existsSync(testScriptPath), true, 'expected test sparkshell helper script to exist');
    assert.match(testScriptSource, /'crates', 'omx-sparkshell', 'Cargo\.toml'/);
    assert.doesNotMatch(testScriptSource, /'native', 'omx-sparkshell', 'Cargo\.toml'/);

    try {
      rmSync(packagedBinaryPath, { force: true });
      rmSync(releaseBinaryPath, { force: true });
      mkdirSync(dirname(releaseBinaryPath), { recursive: true });
      const fakeCargoPath = join(fakeBin, platform() === 'win32' ? 'cargo.cmd' : 'cargo');
      if (platform() === 'win32') {
        writeFileSync(
          fakeCargoPath,
          [
            '@echo off',
            'if not exist "%OMX_FAKE_RELEASE_DIR%" mkdir "%OMX_FAKE_RELEASE_DIR%"',
            '> "%OMX_FAKE_RELEASE_BINARY%" echo fake sparkshell',
            'exit /b 0',
            '',
          ].join('\r\n'),
        );
      } else {
        writeFileSync(
          fakeCargoPath,
          [
            '#!/bin/sh',
            'mkdir -p "$OMX_FAKE_RELEASE_DIR"',
            'printf "%s\\n" "#!/bin/sh" "echo fake sparkshell" > "$OMX_FAKE_RELEASE_BINARY"',
            'chmod +x "$OMX_FAKE_RELEASE_BINARY"',
            '',
          ].join('\n'),
        );
        chmodSync(fakeCargoPath, 0o755);
      }

      const buildResult = spawnSync(process.execPath, [buildScriptPath], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_SPARKSHELL_MANIFEST: join(process.cwd(), 'crates', 'omx-sparkshell', 'Cargo.toml'),
          OMX_SPARKSHELL_STAGE_DIR: stagedRoot,
          OMX_FAKE_RELEASE_BINARY: releaseBinaryPath,
          OMX_FAKE_RELEASE_DIR: dirname(releaseBinaryPath),
          PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
        },
      });
      assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
      assert.equal(existsSync(packagedBinaryPath), true, `expected staged binary at ${packagedBinaryRelativePath}`);

      const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          npm_config_cache: npmCache,
        },
      });
      assert.equal(packed.status, 0, packed.stderr || packed.stdout);

      const results = JSON.parse(packed.stdout) as NpmPackDryRunResult[];
      const packedFiles = new Set((results[0]?.files ?? []).map((file) => file.path));

      assert.equal(packedFiles.has('dist/scripts/build-sparkshell.js'), true);
      assert.equal(packedFiles.has('dist/scripts/test-sparkshell.js'), true);
      assert.equal(packedFiles.has(packagedBinaryRelativePath.replaceAll('\\', '/')), false);
    } finally {
      rmSync(stagedRoot, { force: true, recursive: true });
      rmSync(fakeBin, { force: true, recursive: true });
      rmSync(npmCache, { force: true, recursive: true });
      if (originalReleaseBinary) {
        writeFileSync(releaseBinaryPath, originalReleaseBinary);
        if (platform() !== 'win32') chmodSync(releaseBinaryPath, 0o755);
      } else {
        rmSync(releaseBinaryPath, { force: true });
      }
    }
  });
});
