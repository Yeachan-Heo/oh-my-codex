import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  nestedRepoLocalApiBinaryPath,
  packagedApiBinaryCandidatePaths,
  repoLocalApiBinaryPath,
  resolveApiBinaryPath,
  resolveApiBinaryPathWithHydration,
  runApiBinary,
} from '../api.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync('node', [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

const fixturePackageRoot = join(tmpdir(), 'omx-api-package-root');


describe('resolveApiBinaryPath', () => {
  it('prefers OMX_API_BIN override', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-override-'));
    try {
      assert.equal(
        resolveApiBinaryPath({
          cwd,
          env: { OMX_API_BIN: './bin/custom-api' },
          packageRoot: '/unused',
        }),
        join(cwd, 'bin', 'custom-api'),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('checks Linux musl packaged paths before glibc and legacy paths', () => {
    assert.deepEqual(
      packagedApiBinaryCandidatePaths(fixturePackageRoot, 'linux', 'x64', {}, ['musl', 'glibc']),
      [
        join(fixturePackageRoot, 'bin', 'native', 'linux-x64-musl', 'omx-api'),
        join(fixturePackageRoot, 'bin', 'native', 'linux-x64-glibc', 'omx-api'),
        join(fixturePackageRoot, 'bin', 'native', 'linux-x64', 'omx-api'),
      ],
    );
  });

  it('falls back from packaged binary to repo-local build artifact', () => {
    const repoLocal = repoLocalApiBinaryPath(fixturePackageRoot);
    assert.equal(
      resolveApiBinaryPath({ packageRoot: fixturePackageRoot, exists: (path) => path === repoLocal }),
      repoLocal,
    );
  });

  it('falls back to nested repo-local native build artifact when present', () => {
    const nestedRepoLocal = nestedRepoLocalApiBinaryPath(fixturePackageRoot);
    assert.equal(
      resolveApiBinaryPath({ packageRoot: fixturePackageRoot, exists: (path) => path === nestedRepoLocal }),
      nestedRepoLocal,
    );
  });

  it('throws with checked paths when neither packaged nor repo-local binary exists', () => {
    assert.throws(
      () => resolveApiBinaryPath({ packageRoot: fixturePackageRoot, exists: () => false }),
      /native binary not found/,
    );
  });


  it('prefers a cached hydrated omx-api binary before packaged and repo-local paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-cached-'));
    try {
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: '0.8.15' }));
      const cacheDir = join(cwd, 'cache');
      const cachedDir = join(cacheDir, '0.8.15', 'linux-x64-musl', 'omx-api');
      const cachedBinary = join(cachedDir, 'omx-api');
      await mkdir(cachedDir, { recursive: true });
      await writeFile(cachedBinary, '#!/bin/sh\n');
      await chmod(cachedBinary, 0o755);
      await writeFile(`${cachedBinary}.sha256`, `${createHash('sha256').update('#!/bin/sh\n').digest('hex')}\n`, { mode: 0o600 });

      assert.equal(
        await resolveApiBinaryPathWithHydration({
          packageRoot: cwd,
          platform: 'linux',
          arch: 'x64',
          linuxLibcPreference: ['musl', 'glibc'],
          env: { OMX_NATIVE_CACHE_DIR: cacheDir, OMX_NATIVE_AUTO_FETCH: '0' },
        }),
        await realpath(cachedBinary),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports the first rejected cache entry instead of an earlier missing candidate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-rejected-cache-'));
    try {
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: '0.8.15' }));
      const cacheDir = join(cwd, 'cache');
      const rejected = join(cacheDir, '0.8.15', 'linux-x64-glibc', 'omx-api', 'omx-api');
      await mkdir(dirname(rejected), { recursive: true });
      await writeFile(rejected, 'unverified');
      await assert.rejects(
        () => resolveApiBinaryPathWithHydration({
          packageRoot: cwd,
          platform: 'linux',
          arch: 'x64',
          linuxLibcPreference: ['musl', 'glibc'],
          env: { OMX_NATIVE_CACHE_DIR: cacheDir, OMX_NATIVE_AUTO_FETCH: '0' },
        }),
        (error: Error) => error.message.includes(rejected) && error.message.includes('legacy-unverified'),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a sidecarless managed cache binary and falls through to the packaged authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-sidecarless-'));
    try {
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: '0.8.15' }));
      const cacheDir = join(cwd, 'cache');
      const cachedDir = join(cacheDir, '0.8.15', 'linux-x64-musl', 'omx-api');
      const cachedBinary = join(cachedDir, 'omx-api');
      const packaged = join(cwd, 'bin', 'native', 'linux-x64-musl', 'omx-api');
      await mkdir(cachedDir, { recursive: true });
      await mkdir(dirname(packaged), { recursive: true });
      await writeFile(cachedBinary, '#!/bin/sh\necho untrusted\n');
      await writeFile(packaged, '#!/bin/sh\necho packaged\n');
      assert.equal(await resolveApiBinaryPathWithHydration({
        packageRoot: cwd,
        platform: 'linux',
        arch: 'x64',
        linuxLibcPreference: ['musl'],
        env: { OMX_NATIVE_CACHE_DIR: cacheDir, OMX_NATIVE_AUTO_FETCH: '0' },
      }), packaged);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('runApiBinary', () => {
  it('forwards argv, cwd, and env to the native binary', () => {
    const calls: { binary: string; args: string[]; options: unknown }[] = [];
    const result = runApiBinary('/fake/omx-api', ['generate', 'text', 'hello'], {
      cwd: '/work',
      env: { TEST_ENV: '1' },
      spawnImpl: ((binary: string, args: string[], options: unknown) => {
        calls.push({ binary, args, options });
        return { status: 0, signal: null, output: [], stdout: 'ok\n', stderr: '', pid: 123 };
      }) as unknown as typeof spawnSync,
    });

    assert.equal(result.stdout, 'ok\n');
    assert.equal(calls[0]?.binary, '/fake/omx-api');
    assert.deepEqual(calls[0]?.args, ['generate', 'text', 'hello']);
    assert.deepEqual(calls[0]?.options, {
      cwd: '/work',
      env: { TEST_ENV: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  });
});

describe('omx api', () => {
  it('includes api in top-level help output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-help-'));
    try {
      const result = runOmx(cwd, ['--help']);
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx api\s+Run native omx-api localhost gateway commands \(serve\|status\|stop\|generate\)/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prints api usage when invoked with top-level or nested --help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-subhelp-'));
    try {
      for (const argv of [['api', '--help'], ['api', 'serve', '--help'], ['api', 'generate', '--help']]) {
        const result = runOmx(cwd, argv);
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, `${argv.join(' ')} stderr=${result.stderr} stdout=${result.stdout}`);
        assert.match(result.stdout, /Usage: omx api <command> \[args\.\.\.\]/);
        assert.match(result.stdout, /generate text <prompt\.\.\.>/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves child stdout, stderr, and exit code through the JS bridge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-bridge-'));
    try {
      const stubPath = join(cwd, 'api-stub.cjs');
      await writeFile(stubPath, 'process.stdout.write("api-stdout\\n"); process.stderr.write("api-stderr\\n"); process.exit(7);\n');

      const result = runOmx(cwd, ['api', stubPath], { OMX_API_BIN: process.execPath });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 7, result.stderr || result.stdout);
      assert.equal(result.stdout, 'api-stdout\n');
      assert.equal(result.stderr, 'api-stderr\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails clearly when the configured native binary path does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-api-missing-'));
    try {
      const result = runOmx(cwd, ['api', 'status'], { OMX_API_BIN: join(cwd, 'bin', 'missing-api') });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /failed to launch native binary: executable not found/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
