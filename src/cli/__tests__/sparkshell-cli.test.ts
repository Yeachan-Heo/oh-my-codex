import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  repoLocalSparkShellBinaryPath,
  resolveSparkShellBinaryPath,
  runSparkShellBinary,
} from '../sparkshell.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
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

describe('resolveSparkShellBinaryPath', () => {
  it('prefers OMX_SPARKSHELL_BIN override', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sparkshell-override-'));
    try {
      const binary = join(cwd, 'bin', 'custom-sparkshell');
      assert.equal(
        resolveSparkShellBinaryPath({
          cwd,
          env: { OMX_SPARKSHELL_BIN: './bin/custom-sparkshell' },
          packageRoot: '/unused',
        }),
        binary,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back from packaged binary to repo-local build artifact', () => {
    const packageRoot = '/repo';
    const packaged = join(packageRoot, 'bin', 'native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'omx-sparkshell.exe' : 'omx-sparkshell');
    const repoLocal = repoLocalSparkShellBinaryPath(packageRoot);

    assert.equal(
      resolveSparkShellBinaryPath({
        packageRoot,
        exists: (path) => path === repoLocal,
      }),
      repoLocal,
    );
    assert.notEqual(packaged, repoLocal);
  });

  it('throws with checked paths when neither packaged nor repo-local binary exists', () => {
    assert.throws(
      () => resolveSparkShellBinaryPath({ packageRoot: '/repo', exists: () => false }),
      /native binary not found/,
    );
  });
});

describe('runSparkShellBinary', () => {
  it('passes argv directly to the native sidecar', () => {
    let invoked: { binaryPath: string; args: string[]; stdio: unknown } | undefined;
    runSparkShellBinary('/fake/omx-sparkshell', ['git', 'diff --stat', 'a|b'], {
      cwd: '/tmp/example',
      env: { TEST_ENV: '1' },
      spawnImpl: ((binaryPath: string, args: string[], options: { stdio?: unknown }) => {
        invoked = { binaryPath, args, stdio: options.stdio };
        return {
          pid: 1,
          output: [],
          stdout: null,
          stderr: null,
          status: 0,
          signal: null,
        };
      }) as unknown as typeof spawnSync,
    });

    assert.deepEqual(invoked, {
      binaryPath: '/fake/omx-sparkshell',
      args: ['git', 'diff --stat', 'a|b'],
      stdio: 'inherit',
    });
  });
});

describe('omx sparkshell', () => {
  it('includes sparkshell in top-level help output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sparkshell-help-'));
    try {
      const result = runOmx(cwd, ['--help']);
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx sparkshell <command> \[args\.\.\.\]/);
      assert.match(result.stdout, /omx sparkshell --tmux-pane <pane-id> \[--tail-lines <100-1000>\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prints sparkshell usage when invoked with --help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sparkshell-subhelp-'));
    try {
      const result = runOmx(cwd, ['sparkshell', '--help']);
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Usage: omx sparkshell <command> \[args\.\.\.\]/);
      assert.match(result.stdout, /or: omx sparkshell --tmux-pane <pane-id> \[--tail-lines <100-1000>\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves child stdout, stderr, and exit code through the JS bridge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sparkshell-bridge-'));
    try {
      const binDir = join(cwd, 'bin');
      const stubPath = join(binDir, process.platform === 'win32' ? 'omx-sparkshell.cmd' : 'omx-sparkshell');
      await mkdir(binDir, { recursive: true });
      if (process.platform === 'win32') {
        await writeFile(
          stubPath,
          '@echo off\r\necho spark-stdout\r\n>&2 echo spark-stderr\r\nexit /b 7\r\n',
        );
      } else {
        await writeFile(
          stubPath,
          '#!/bin/sh\necho spark-stdout\necho spark-stderr 1>&2\nexit 7\n',
        );
        await chmod(stubPath, 0o755);
      }

      const result = runOmx(cwd, ['sparkshell', 'git', 'status'], {
        OMX_SPARKSHELL_BIN: stubPath,
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 7, result.stderr || result.stdout);
      assert.equal(result.stdout, 'spark-stdout\n');
      assert.equal(result.stderr, 'spark-stderr\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails clearly when the configured native binary path does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sparkshell-missing-'));
    try {
      const missingBinary = join(cwd, 'bin', 'does-not-exist');
      const result = runOmx(cwd, ['sparkshell', 'ls'], {
        OMX_SPARKSHELL_BIN: missingBinary,
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /failed to launch native binary: executable not found/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
