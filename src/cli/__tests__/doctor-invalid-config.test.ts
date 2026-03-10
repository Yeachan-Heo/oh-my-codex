import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('omx doctor invalid config detection', () => {
  it('fails when config.toml contains duplicate [tui] tables', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-invalid-config-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });

      await writeFile(
        join(codexDir, 'config.toml'),
        `
model = "gpt-5.4"

[tui]
status_line = ["model-with-reasoning"]

[tui]
theme = "base16-ocean-light"
`.trimStart(),
      );

      const res = runOmx(wd, ['doctor'], {
        HOME: home,
        CODEX_HOME: codexDir,
      });

      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /\[XX\] Config: invalid config\.toml \(possible duplicate TOML table such as \[tui\]\)/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});