import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertBuiltinExploreHarnessSupported,
  exploreCommand,
  EXPLORE_DEPRECATION_MESSAGE,
  EXPLORE_HELP,
  getBuiltinExploreHarnessUnsupportedReason,
  packagedExploreHarnessBinaryName,
  resolvePackagedExploreHarnessCommand,
} from '../explore.js';

async function captureExploreCommand(args: string[]): Promise<{ stdout: string; threw: boolean; error?: string }> {
  const originalLog = console.log;
  let stdout = '';
  console.log = (...parts: unknown[]) => {
    stdout += `${parts.map((part) => String(part)).join(' ')}\n`;
  };
  try {
    await exploreCommand(args);
    return { stdout, threw: false };
  } catch (error) {
    return { stdout, threw: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    console.log = originalLog;
  }
}

describe('exploreCommand (hard-deprecated tombstone)', () => {
  it('prints migration help for --help without throwing', async () => {
    const result = await captureExploreCommand(['--help']);
    assert.equal(result.threw, false);
    assert.match(result.stdout, /Hard-deprecated legacy command surface/);
    assert.match(result.stdout, /all fail intentionally/);
    assert.match(result.stdout, /omx sparkshell/);
  });

  it('throws the deprecation message for bare invocation', async () => {
    const result = await captureExploreCommand([]);
    assert.equal(result.threw, true);
    assert.match(result.error ?? '', /hard-deprecated and the direct command surface has been removed/);
  });

  it('throws the deprecation message for legacy --prompt usage', async () => {
    const result = await captureExploreCommand(['--prompt', 'find package.json']);
    assert.equal(result.threw, true);
    assert.match(result.error ?? '', new RegExp(EXPLORE_DEPRECATION_MESSAGE.slice(0, 24)));
  });

  it('exposes deprecation help text', () => {
    assert.match(EXPLORE_HELP, /Migration:/);
    assert.match(EXPLORE_HELP, /normal Codex repository inspection tools\/subagents/);
  });
});

describe('getBuiltinExploreHarnessUnsupportedReason', () => {
  it('returns undefined on non-Windows platforms', () => {
    assert.equal(getBuiltinExploreHarnessUnsupportedReason('linux', {} as NodeJS.ProcessEnv), undefined);
  });

  it('reports a reason on Windows without an override', () => {
    const reason = getBuiltinExploreHarnessUnsupportedReason('win32', {} as NodeJS.ProcessEnv);
    assert.match(reason ?? '', /not ready on Windows/);
  });

  it('returns undefined on Windows when OMX_EXPLORE_BIN is set', () => {
    assert.equal(
      getBuiltinExploreHarnessUnsupportedReason('win32', { OMX_EXPLORE_BIN: '/tmp/harness' } as NodeJS.ProcessEnv),
      undefined,
    );
  });

  it('assert helper throws only on unsupported platforms', () => {
    assert.doesNotThrow(() => assertBuiltinExploreHarnessSupported('linux', {} as NodeJS.ProcessEnv));
    assert.throws(() => assertBuiltinExploreHarnessSupported('win32', {} as NodeJS.ProcessEnv), /not ready on Windows/);
  });
});

describe('resolvePackagedExploreHarnessCommand', () => {
  it('uses a packaged native binary when metadata matches the current platform', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-packaged-'));
    try {
      const binDir = join(wd, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(wd, 'package.json'), '{}\n');
      await writeFile(join(binDir, 'omx-explore-harness.meta.json'), JSON.stringify({
        binaryName: packagedExploreHarnessBinaryName(),
        platform: process.platform,
        arch: process.arch,
      }));
      const binaryPath = join(binDir, packagedExploreHarnessBinaryName());
      await writeFile(binaryPath, '#!/bin/sh\nexit 0\n');
      await chmod(binaryPath, 0o755);

      const resolved = resolvePackagedExploreHarnessCommand(wd);
      assert.deepEqual(resolved, { command: binaryPath, args: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores packaged binaries built for a different platform', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-packaged-mismatch-'));
    try {
      const binDir = join(wd, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(wd, 'package.json'), '{}\n');
      await writeFile(join(binDir, 'omx-explore-harness.meta.json'), JSON.stringify({
        binaryName: packagedExploreHarnessBinaryName('linux'),
        platform: process.platform === 'win32' ? 'linux' : 'win32',
        arch: process.arch,
      }));
      await writeFile(join(binDir, packagedExploreHarnessBinaryName('linux')), '#!/bin/sh\nexit 0\n');

      assert.equal(resolvePackagedExploreHarnessCommand(wd), undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
