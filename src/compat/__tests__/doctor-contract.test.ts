import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const fixturesRoot = join(repoRoot, 'src', 'compat', 'fixtures', 'doctor');

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

function runCompatTarget(cwd: string, argv: string[], envOverrides: Record<string, string> = {}): CompatRunResult {
  const target = resolveCompatTarget();
  const result = spawnSync(target.command, [...target.argsPrefix, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}

function normalizeInstallDoctorOutput(text: string, home: string, cwd: string): string {
  return text
    .replaceAll(join(home, '.codex').replace(/\\/g, '/'), '<CODEX_HOME>')
    .replaceAll(join(cwd, '.omx', 'state').replace(/\\/g, '/'), '<REPO_STATE_DIR>')
    .replace(/\\/g, '/')
    .split('\n')
    .map((line) => {
      if (line.startsWith('  [OK] Codex CLI:') || line.startsWith('  [XX] Codex CLI:')) {
        return '  [CODEX_CLI_STATUS]';
      }
      if (line.startsWith('  [OK] Node.js:')) {
        return '  [OK] Node.js: <NODE_VERSION>';
      }
      if (line.startsWith('Results: ')) {
        return 'Results: <RESULTS>';
      }
      if (line.startsWith('Run "omx setup')) {
        return 'Run <SETUP_FOLLOWUP>';
      }
      return line;
    })
    .join('\n');
}

describe('compat doctor contract', () => {
  it('matches onboarding warning copy for first setup expectations', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-compat-doctor-'));
    const home = join(wd, 'home');
    const codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.non_omx]\ncommand = "node"\n');

    try {
      const result = runCompatTarget(wd, ['doctor'], { HOME: home, CODEX_HOME: codexHome });
      if (shouldSkipForSpawnPermissions(result.error)) return;
      assert.equal(result.status, Number.parseInt(readFixture('install-onboarding.exitcode.txt').trim(), 10), result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(normalizeInstallDoctorOutput(result.stdout, home, wd), readFixture('install-onboarding.stdout.txt'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('matches doctor --team resume_blocker behavior', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-compat-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({ name: 'alpha', tmux_session: 'omx-team-alpha' }));
      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(tmuxPath, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');
      await chmod(tmuxPath, 0o755);

      const result = runCompatTarget(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(result.error)) return;
      assert.equal(result.status, Number.parseInt(readFixture('team-resume-blocker.exitcode.txt').trim(), 10), result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.replace(/\\/g, '/'), readFixture('team-resume-blocker.stdout.txt'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
