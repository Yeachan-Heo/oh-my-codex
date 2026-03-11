import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

interface CompatRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const defaultTarget = join(repoRoot, 'bin', process.platform === 'win32' ? 'omx.cmd' : 'omx');
const fixturesRoot = join(repoRoot, 'src', 'compat', 'fixtures', 'reasoning');

function readFixture(name: string): string {
  return readFileSync(join(fixturesRoot, name), 'utf-8');
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

function resolveCompatTarget(): { command: string; argsPrefix: string[] } {
  const override = process.env.OMX_COMPAT_TARGET?.trim();
  const targetPath = override
    ? (isAbsolute(override) ? override : resolve(process.cwd(), override))
    : defaultTarget;

  if (targetPath.endsWith('.js')) {
    return { command: process.execPath, argsPrefix: [targetPath] };
  }

  return { command: targetPath, argsPrefix: [] };
}

function runCompatTarget(argv: string[], envOverrides: Record<string, string>): CompatRunResult {
  const target = resolveCompatTarget();
  const result = spawnSync(target.command, [...target.argsPrefix, ...argv], {
    cwd: process.cwd(),
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

function normalizeReasoningOutput(text: string, codexHome: string): string {
  const normalizedHome = codexHome.replace(/\\/g, '/');
  return text.replaceAll(`${normalizedHome}/config.toml`, '<CODEX_HOME>/config.toml').replace(/\\/g, '/');
}

describe('compat reasoning contract', () => {
  it('matches no-config, set, and current-value behavior', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-reasoning-contract-'));
    const home = join(wd, 'home');
    const codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true });

    try {
      const env = { HOME: home, CODEX_HOME: codexHome };

      const noConfig = runCompatTarget(['reasoning'], env);
      if (shouldSkipForSpawnPermissions(noConfig.error)) return;
      assert.equal(noConfig.status, 0, noConfig.stderr || noConfig.stdout);
      assert.equal(noConfig.stderr, '');
      assert.equal(
        normalizeReasoningOutput(noConfig.stdout, codexHome),
        readFixture('no-config.stdout.txt'),
      );

      const setHigh = runCompatTarget(['reasoning', 'high'], env);
      assert.equal(setHigh.status, 0, setHigh.stderr || setHigh.stdout);
      assert.equal(setHigh.stderr, '');
      assert.equal(
        normalizeReasoningOutput(setHigh.stdout, codexHome),
        readFixture('set-high.stdout.txt'),
      );

      const current = runCompatTarget(['reasoning'], env);
      assert.equal(current.status, 0, current.stderr || current.stdout);
      assert.equal(current.stderr, '');
      assert.equal(current.stdout, readFixture('current-high.stdout.txt'));

      assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf-8'), readFixture('config.toml.txt'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
