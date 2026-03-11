import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface CompatRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const defaultTarget = join(repoRoot, 'bin', process.platform === 'win32' ? 'omx.cmd' : 'omx');
const fixturesRoot = join(repoRoot, 'src', 'compat', 'fixtures');

function readFixture(relativePath: string): string {
  return readFileSync(join(fixturesRoot, relativePath), 'utf-8');
}

function normalizeVersionOutput(text: string): string {
  return text.replace(/^Node\.js .+$/m, 'Node.js <NODE_VERSION>');
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
    return {
      command: process.execPath,
      argsPrefix: [targetPath],
    };
  }

  return {
    command: targetPath,
    argsPrefix: [],
  };
}

function runCompatTarget(
  argv: string[],
  envOverrides: Record<string, string> = {},
): CompatRunResult {
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

describe('compat baseline contract', () => {
  it('prints top-level help exactly', () => {
    const result = runCompatTarget(['--help']);
    if (shouldSkipForSpawnPermissions(result.error)) return;

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, readFixture('help.stdout.txt'));
  });

  it('prints version output exactly', () => {
    const result = runCompatTarget(['version']);
    if (shouldSkipForSpawnPermissions(result.error)) return;

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.equal(normalizeVersionOutput(result.stdout), readFixture('version.stdout.txt'));
  });

  it('preserves ask stdout stderr and exit code exactly', () => {
    const result = runCompatTarget(['ask', 'claude', 'pass-through'], {
      OMX_ASK_ADVISOR_SCRIPT: 'scripts/fixtures/ask-advisor-stub.js',
      OMX_ASK_STUB_STDOUT: readFixture('ask/pass-through.stdout.txt'),
      OMX_ASK_STUB_STDERR: readFixture('ask/pass-through.stderr.txt'),
      OMX_ASK_STUB_EXIT_CODE: readFixture('ask/pass-through.exitcode.txt').trim(),
    });
    if (shouldSkipForSpawnPermissions(result.error)) return;

    assert.equal(result.status, Number.parseInt(readFixture('ask/pass-through.exitcode.txt').trim(), 10), result.stderr || result.stdout);
    assert.equal(result.stdout, readFixture('ask/pass-through.stdout.txt'));
    assert.equal(result.stderr, readFixture('ask/pass-through.stderr.txt'));
  });
});
