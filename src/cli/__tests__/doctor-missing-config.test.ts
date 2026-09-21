import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
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

function shouldSkipForSpawnPermissions(error?: string): boolean {
  return typeof error === 'string' && /(EPERM|EACCES)/i.test(error);
}

describe('omx doctor missing config diagnostic', () => {
  it('reports the resolved CODEX_HOME config path without creating config.toml', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-missing-config-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(wd, 'custom-codex-home');
      const configPath = join(codexDir, 'config.toml');
      await mkdir(codexDir, { recursive: true });

      const result = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(
        result.stdout,
        new RegExp(
          `\\[!!\\] Config: config\\.toml not found at ${configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. CODEX_HOME is set, so this is the active Codex config path\\. This check did not create it; run "omx setup" for this Codex home to repair\\.`,
        ),
      );
      assert.equal(existsSync(configPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not call project-scope config missing under CODEX_HOME', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-project-config-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(wd, 'user-codex-home');
      const projectCodex = join(wd, '.codex');
      const projectConfig = join(projectCodex, 'config.toml');
      await mkdir(codexHome, { recursive: true });
      await mkdir(projectCodex, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), '{ "scope": "project" }\n');

      const result = runOmx(wd, ['doctor'], {
        HOME: home,
        CODEX_HOME: codexHome,
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const resolvedProjectConfig = projectConfig.replace(wd, await realpath(wd));
      assert.match(
        result.stdout,
        new RegExp(
          `\\[!!\\] Config: config\\.toml not found at ${resolvedProjectConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. This check did not create it; run "omx setup" for this project scope to repair\\.`,
        ),
      );
      assert.doesNotMatch(result.stdout, /CODEX_HOME is set, so this is the active Codex config path/);
      assert.equal(existsSync(projectConfig), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
