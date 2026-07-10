import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function withConfig(
  config: string,
  fn: (args: { wd: string; home: string; codexDir: string; configPath: string }) => Promise<void>,
): Promise<void> {
  const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-context-window-'));
  try {
    const home = join(wd, 'home');
    const codexDir = join(home, '.codex');
    const configPath = join(codexDir, 'config.toml');
    await mkdir(codexDir, { recursive: true });
    await writeFile(configPath, config.trimStart());
    await fn({ wd, home, codexDir, configPath });
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
}

function assertNoUnsupportedLimitClaim(stdout: string): void {
  assert.doesNotMatch(stdout, /hard limit/i);
  assert.doesNotMatch(stdout, /API[- ]?vs[- ]?Codex/i);
  assert.doesNotMatch(stdout, /Codex context limit/i);
}

describe('omx doctor model context recommendation warning', () => {
  it('warns when gpt-5.6-sol model_context_window exceeds the OMX setup recommendation', async () => {
    await withConfig(
      `
model = "gpt-5.6-sol"
model_context_window = 1000000
model_auto_compact_token_limit = 200000
`,
      async ({ wd, home, codexDir, configPath }) => {
        const before = await readFile(configPath, 'utf-8');
        const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
        if (shouldSkipForSpawnPermissions(res.error)) return;

        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(res.stdout, /\[!!\] Model context recommendation:/);
        assert.match(res.stdout, /model_context_window=1000000/);
        assert.match(res.stdout, /OMX setup recommendation/);
        assert.match(res.stdout, /250000 \/ 200000/);
        assertNoUnsupportedLimitClaim(res.stdout);
        assert.equal(await readFile(configPath, 'utf-8'), before);
      },
    );
  });

  it('warns when gpt-5.6-sol model_auto_compact_token_limit exceeds the OMX setup recommendation', async () => {
    await withConfig(
      `
model = "gpt-5.6-sol"
model_context_window = 250000
model_auto_compact_token_limit = 900000
`,
      async ({ wd, home, codexDir, configPath }) => {
        const before = await readFile(configPath, 'utf-8');
        const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
        if (shouldSkipForSpawnPermissions(res.error)) return;

        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(res.stdout, /\[!!\] Model context recommendation:/);
        assert.match(res.stdout, /model_auto_compact_token_limit=900000/);
        assert.match(res.stdout, /OMX setup recommendation/);
        assert.match(res.stdout, /250000 \/ 200000/);
        assertNoUnsupportedLimitClaim(res.stdout);
        assert.equal(await readFile(configPath, 'utf-8'), before);
      },
    );
  });

  it('warns with both oversized gpt-5.6-sol context settings in the same message', async () => {
    await withConfig(
      `
model = "gpt-5.6-sol"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
`,
      async ({ wd, home, codexDir }) => {
        const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
        if (shouldSkipForSpawnPermissions(res.error)) return;

        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(res.stdout, /model_context_window=1000000/);
        assert.match(res.stdout, /model_auto_compact_token_limit=900000/);
        assertNoUnsupportedLimitClaim(res.stdout);
      },
    );
  });

  it('does not warn when gpt-5.6-sol context settings match the OMX setup recommendation', async () => {
    await withConfig(
      `
model = "gpt-5.6-sol"
model_context_window = 250000
model_auto_compact_token_limit = 200000
`,
      async ({ wd, home, codexDir }) => {
        const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
        if (shouldSkipForSpawnPermissions(res.error)) return;

        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.doesNotMatch(res.stdout, /Model context recommendation/);
      },
    );
  });

  it('does not apply the gpt-5.6-sol recommendation warning to other models', async () => {
    await withConfig(
      `
model = "o3"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
`,
      async ({ wd, home, codexDir }) => {
        const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
        if (shouldSkipForSpawnPermissions(res.error)) return;

        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.doesNotMatch(res.stdout, /Model context recommendation/);
      },
    );
  });
});
