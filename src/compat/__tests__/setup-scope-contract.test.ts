import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

interface CompatRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface SetupScopeFixture {
  id: string;
  command: string[];
  expect: {
    exit_code: number;
    stdout_contains: string[];
    stderr?: string;
  };
  artifact_assertions: string[];
  source_contracts: string[];
}

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const defaultTarget = join(repoRoot, 'bin', process.platform === 'win32' ? 'omx.cmd' : 'omx');
const fixturesRoot = join(repoRoot, 'scripts', 'compat', 'fixtures', 'setup-scope');

function readFixture(name: string): SetupScopeFixture {
  return JSON.parse(readFileSync(join(fixturesRoot, name), 'utf-8')) as SetupScopeFixture;
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

function runCompatTarget(cwd: string, argv: string[], envOverrides: Record<string, string> = {}): CompatRunResult {
  const target = resolveCompatTarget();
  const result = spawnSync(target.command, [...target.argsPrefix, ...argv], {
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

function assertArtifact(cwd: string, assertion: string): void {
  let match = assertion.match(/^(?<path>.+) exists$/);
  if (match?.groups) {
    assert.equal(existsSync(join(cwd, match.groups.path)), true, assertion);
    return;
  }

  match = assertion.match(/^(?<path>.+) absent$/);
  if (match?.groups) {
    assert.equal(existsSync(join(cwd, match.groups.path)), false, assertion);
    return;
  }

  match = assertion.match(/^(?<path>.+) contains (?<expected>.+)$/);
  if (match?.groups) {
    const content = readFileSync(join(cwd, match.groups.path), 'utf-8');
    assert.match(content, new RegExp(match.groups.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return;
  }

  match = assertion.match(/^(?<path>.+) json (?<key>[^=]+)=(?<value>.+)$/);
  if (match?.groups) {
    const parsed = JSON.parse(readFileSync(join(cwd, match.groups.path), 'utf-8')) as Record<string, unknown>;
    assert.equal(parsed[match.groups.key], match.groups.value, assertion);
    return;
  }

  throw new Error(`Unsupported artifact assertion: ${assertion}`);
}

async function withTempWorkspace(assertions: string[], run: (cwd: string, home: string) => boolean): Promise<void> {
  const wd = await mkdtemp(join(tmpdir(), 'omx-compat-setup-scope-'));
  const home = join(wd, 'home');
  await mkdir(home, { recursive: true });

  try {
    const shouldAssertArtifacts = run(wd, home);
    if (shouldAssertArtifacts) {
      for (const assertion of assertions) {
        assertArtifact(wd, assertion);
      }
    }
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
}

describe('compat setup scope contract', () => {
  const fixtures = [
    readFixture('dry-run-project.fixture.json'),
    readFixture('project-artifacts.fixture.json'),
  ];

  for (const fixture of fixtures) {
    it(`matches ${fixture.id}`, async () => {
      await withTempWorkspace(fixture.artifact_assertions, (wd, home) => {
        const result = runCompatTarget(wd, fixture.command, { HOME: home });
        if (shouldSkipForSpawnPermissions(result.error)) return false;

        assert.equal(result.status, fixture.expect.exit_code, result.stderr || result.stdout);
        assert.equal(result.stderr, fixture.expect.stderr ?? '');
        for (const fragment of fixture.expect.stdout_contains) {
          assert.match(result.stdout, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        }
        return true;
      });
    });
  }
});
