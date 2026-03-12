import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

describe('omx resume', () => {
  it('forwards --last to codex resume through the normal launch wrapper', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);

      const result = runOmx(wd, ['resume', '--last'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes resume --help through to codex instead of printing top-level omx help', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);

      const result = runOmx(wd, ['resume', '--help'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --help\b/);
      assert.doesNotMatch(result.stdout, /Unknown command: resume/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
