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
model = "gpt-5.6-sol"

[features]
multi_agent = false

[agents]
max_threads = 17
max_depth = 5

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
      assert.doesNotMatch(res.stdout, /GPT-5\.6 multi-agent compatibility/);
      assert.doesNotMatch(res.stdout, /All checks passed!/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails strict load validation when hooks.json contains top-level state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-hooks-json-state-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, 'config.toml'),
        'omx_enabled = true\nhooks = true\n',
      );
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify({
          state: {
            '/tmp/hooks.json:stop:0:0': { trusted_hash: 'sha256:legacy' },
          },
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
            PreToolUse: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
            PostToolUse: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
            PreCompact: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
            PostCompact: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'node /repo/dist/scripts/codex-native-hook.js' }] }],
          },
        }),
      );

      const res = runOmx(wd, ['doctor'], {
        HOME: home,
        CODEX_HOME: codexDir,
      });

      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /\[XX\] Native hooks: hooks\.json failed strict load validation \(invalid_document\): Codex does not accept unknown root field state; inspect the file manually because doctor will not modify it/,
      );
      assert.doesNotMatch(res.stdout, /Run "omx setup" to fix installation issues/);
      assert.doesNotMatch(res.stdout, /Native hooks:.*--force/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('fails closed when hooks.json contains invalid UTF-8 bytes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-hooks-json-invalid-utf8-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), 'omx_enabled = true\nhooks = true\n');
      await writeFile(join(codexDir, 'hooks.json'), Buffer.from([0x7b, 0xff, 0x7d]));

      const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /\[XX\] Native hooks: hooks\.json at .* is not valid UTF-8; inspect the file manually because doctor will not modify it/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves a UTF-8 BOM so strict hooks validation rejects it', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-hooks-json-bom-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const hooksPath = join(codexDir, 'hooks.json');
      const hooks = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"hooks":{}}\n', 'utf-8'),
      ]);
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), 'omx_enabled = true\nhooks = true\n');
      await writeFile(hooksPath, hooks);

      const res = runOmx(wd, ['doctor'], { HOME: home, CODEX_HOME: codexDir });
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /hooks\.json failed strict load validation \(invalid_document\)/);
      assert.deepEqual(await readFile(hooksPath), hooks);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});