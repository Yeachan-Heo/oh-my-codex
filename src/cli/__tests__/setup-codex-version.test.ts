import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCodexVersion, setup } from '../setup.js';

async function writeFakeCodex(binDir: string): Promise<void> {
  const codexPath = join(binDir, 'codex');
  const script = [
    '#!/usr/bin/env node',
    'if (process.argv.includes("--version")) {',
    '  process.stdout.write(process.env.OMX_TEST_CODEX_VERSION_OUTPUT ?? "0.106.0");',
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n');
  await writeFile(codexPath, script, { mode: 0o755 });
  await chmod(codexPath, 0o755);
}

async function runSetupWithCapturedLogs(
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const previousCwd = process.cwd();
  const previousEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    OMX_TEST_CODEX_VERSION_OUTPUT: process.env.OMX_TEST_CODEX_VERSION_OUTPUT,
  };
  const logs: string[] = [];
  const originalLog = console.log;

  process.chdir(cwd);
  process.env.HOME = env.HOME;
  process.env.PATH = env.PATH;
  process.env.OMX_TEST_CODEX_VERSION_OUTPUT = env.OMX_TEST_CODEX_VERSION_OUTPUT;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    await setup({ scope: 'project' });
    return logs.join('\n');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    process.env.HOME = previousEnv.HOME;
    process.env.PATH = previousEnv.PATH;
    process.env.OMX_TEST_CODEX_VERSION_OUTPUT =
      previousEnv.OMX_TEST_CODEX_VERSION_OUTPUT;
  }
}

describe('omx setup codex version handling', () => {
  it('parses codex versions from common --version outputs', () => {
    assert.equal(parseCodexVersion('0.107.0'), '0.107.0');
    assert.equal(parseCodexVersion('codex 0.107.1'), '0.107.1');
    assert.equal(parseCodexVersion('v0.106.2'), '0.106.2');
    assert.equal(parseCodexVersion('codex version: unknown'), undefined);
  });

  it('skips [tui] for codex >= 0.107.0', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-codex-version-'));
    try {
      const home = join(wd, 'home');
      const binDir = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFakeCodex(binDir);

      const output = await runSetupWithCapturedLogs(wd, {
        HOME: home,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        OMX_TEST_CODEX_VERSION_OUTPUT: 'codex 0.107.1',
      });

      const config = await readFile(join(wd, '.codex', 'config.toml'), 'utf-8');
      assert.doesNotMatch(config, /^\[tui\]$/m);
      assert.match(
        output,
        /StatusLine \[tui\] skipped \(detected codex 0\.107\.1 >= 0\.107\.0\)\./,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps [tui] when codex version is unparseable (compatibility default)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-codex-version-'));
    try {
      const home = join(wd, 'home');
      const binDir = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFakeCodex(binDir);

      const output = await runSetupWithCapturedLogs(wd, {
        HOME: home,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        OMX_TEST_CODEX_VERSION_OUTPUT: 'codex version: unknown',
      });

      const config = await readFile(join(wd, '.codex', 'config.toml'), 'utf-8');
      assert.match(config, /^\[tui\]$/m);
      assert.match(
        output,
        /StatusLine configured in config\.toml via \[tui\] section \(codex version unparseable; compatibility mode\)\./,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
