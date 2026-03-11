import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withPackagedExploreHarnessHidden, withPackagedExploreHarnessLock } from './packaged-explore-harness-lock.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const r = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('omx doctor onboarding warning copy', () => {
  it('explains first-setup expectation for config and MCP onboarding warnings', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-copy-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, 'config.toml'),
        `
[mcp_servers.non_omx]
command = "node"
`.trimStart(),
      );

      const res = runOmx(wd, ['doctor'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Config: config\.toml exists but no OMX entries yet \(expected before first setup; run "omx setup --force" once\)/,
      );
      assert.match(
        res.stdout,
        /MCP Servers: 1 servers but no OMX servers yet \(expected before first setup; run "omx setup --force" once\)/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns when explore harness sources are packaged but cargo is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-explore-copy-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const home = join(wd, 'home');
        const codexDir = join(home, '.codex');
        const fakeBin = join(wd, 'bin');
        await mkdir(codexDir, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await writeFile(join(fakeBin, 'codex'), '#!/bin/sh\necho "codex test"\n');
        spawnSync('chmod', ['+x', join(fakeBin, 'codex')], { encoding: 'utf-8' });

        const res = runOmx(wd, ['doctor'], {
          HOME: home,
          CODEX_HOME: join(home, '.codex'),
          PATH: fakeBin,
        });
        if (shouldSkipForSpawnPermissions(res.error)) return;
        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(
          res.stdout,
          /Explore Harness: Rust harness sources are packaged, but no compatible packaged prebuilt or cargo was found \(install Rust or set OMX_EXPLORE_BIN for omx explore\)/,
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes explore harness check when a packaged native binary is present even without cargo', async () => {
    await withPackagedExploreHarnessLock(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-explore-binary-'));
      try {
        const home = join(wd, 'home');
        const codexDir = join(home, '.codex');
        const fakeBin = join(wd, 'bin');
        const packageBinDir = join(process.cwd(), 'bin');
        const packagedBinary = join(packageBinDir, process.platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness');
        const packagedMeta = join(packageBinDir, 'omx-explore-harness.meta.json');
        const hadExistingBinary = existsSync(packagedBinary);
        const hadExistingMeta = existsSync(packagedMeta);

        await mkdir(codexDir, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await writeFile(join(fakeBin, 'codex'), '#!/bin/sh\necho "codex test"\n');
        spawnSync('chmod', ['+x', join(fakeBin, 'codex')], { encoding: 'utf-8' });
        const fsPromises = await import('node:fs/promises');
        const originalBinary = hadExistingBinary ? await fsPromises.readFile(packagedBinary) : null;
        const originalMeta = hadExistingMeta ? await fsPromises.readFile(packagedMeta, 'utf-8') : null;
        await mkdir(packageBinDir, { recursive: true });
        await writeFile(packagedBinary, '#!/bin/sh\necho "stub harness"\n');
        await writeFile(packagedMeta, JSON.stringify({ binaryName: process.platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness', platform: process.platform, arch: process.arch }));
        spawnSync('chmod', ['+x', packagedBinary], { encoding: 'utf-8' });

        try {
          const res = runOmx(wd, ['doctor'], {
            HOME: home,
            CODEX_HOME: join(home, '.codex'),
            PATH: fakeBin,
          });
          if (shouldSkipForSpawnPermissions(res.error)) return;
          assert.equal(res.status, 0, res.stderr || res.stdout);
          assert.match(
            res.stdout,
            /Explore Harness: ready \(packaged native binary:/,
          );
        } finally {
          if (originalBinary) {
            await writeFile(packagedBinary, originalBinary);
            spawnSync('chmod', ['+x', packagedBinary], { encoding: 'utf-8' });
          } else {
            await rm(packagedBinary, { force: true });
          }
          if (originalMeta !== null) {
            await writeFile(packagedMeta, originalMeta);
          } else {
            await rm(packagedMeta, { force: true });
          }
        }
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });
});
