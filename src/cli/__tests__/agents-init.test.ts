import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentsInit } from '../agents-init.js';

function runOmx(
  cwd: string,
  argv: string[],
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', process.platform === 'win32' ? 'omx.cmd' : 'omx');
  const result = spawnSync(omxBin, argv, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function readCurrentLinuxStartTicks(): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile('/proc/self/stat', 'utf-8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

describe('omx agents-init', () => {
  it('creates a managed root AGENTS.md plus direct-child AGENTS.md files while skipping ignored directories', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-init-'));
    try {
      await mkdir(join(wd, 'src'), { recursive: true });
      await mkdir(join(wd, 'docs'), { recursive: true });
      await mkdir(join(wd, 'node_modules', 'dep'), { recursive: true });
      await mkdir(join(wd, 'dist'), { recursive: true });
      await writeFile(join(wd, 'src', 'index.ts'), 'export const value = 1;\n');
      await writeFile(join(wd, 'docs', 'guide.md'), '# guide\n');
      await writeFile(join(wd, 'package.json'), '{"name":"fixture"}\n');

      await withCwd(wd, async () => {
        await agentsInit();
      });

      const rootAgents = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const srcAgents = await readFile(join(wd, 'src', 'AGENTS.md'), 'utf-8');
      const docsAgents = await readFile(join(wd, 'docs', 'AGENTS.md'), 'utf-8');

      assert.match(rootAgents, /OMX:AGENTS-INIT:MANAGED/);
      assert.match(rootAgents, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.match(rootAgents, /\.\/\.codex/);
      assert.match(srcAgents, /<!-- Parent: ..\/AGENTS\.md -->/);
      assert.match(srcAgents, /`index\.ts`/);
      assert.match(docsAgents, /`guide\.md`/);
      assert.equal(existsSync(join(wd, 'node_modules', 'AGENTS.md')), false);
      assert.equal(existsSync(join(wd, 'dist', 'AGENTS.md')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes managed subtree files while preserving the manual notes block', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-init-'));
    try {
      await mkdir(join(wd, 'src', 'lib'), { recursive: true });
      await writeFile(join(wd, 'src', 'index.ts'), 'export const index = true;\n');

      await withCwd(wd, async () => {
        await agentsInit({ targetPath: 'src' });
      });

      const agentsPath = join(wd, 'src', 'AGENTS.md');
      const initial = await readFile(agentsPath, 'utf-8');
      const customized = initial.replace(
        '- Add subtree-specific constraints, ownership notes, and test commands here.',
        '- Preserve this custom manual note.',
      );
      await writeFile(agentsPath, customized);
      await writeFile(join(wd, 'src', 'new-file.ts'), 'export const newer = true;\n');

      await withCwd(wd, async () => {
        await agentsInit({ targetPath: 'src' });
      });

      const refreshed = await readFile(agentsPath, 'utf-8');
      assert.match(refreshed, /Preserve this custom manual note\./);
      assert.match(refreshed, /`new-file\.ts`/);
      assert.equal(existsSync(join(wd, 'src', 'lib', 'AGENTS.md')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips unmanaged AGENTS.md files by default but can adopt them with --force and a backup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-init-'));
    const original = '# custom root guidance\n';
    try {
      await mkdir(join(wd, 'src'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), original);
      await writeFile(join(wd, 'src', 'index.ts'), 'export const x = 1;\n');

      await withCwd(wd, async () => {
        await agentsInit();
      });
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), original);
      assert.equal(existsSync(join(wd, 'src', 'AGENTS.md')), true);

      await withCwd(wd, async () => {
        await agentsInit({ force: true });
      });

      const adopted = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      assert.match(adopted, /OMX:AGENTS-INIT:MANAGED/);
      const backupRoot = join(wd, '.omx', 'backups', 'agents-init');
      assert.equal(existsSync(backupRoot), true);
      const timestamps = await readdir(backupRoot);
      assert.equal(timestamps.length > 0, true);
      const backupContent = await readFile(join(backupRoot, timestamps[0], 'AGENTS.md'), 'utf-8');
      assert.equal(backupContent, original);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('protects project-root AGENTS.md during an active OMX session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-init-'));
    try {
      const pidStartTicks = await readCurrentLinuxStartTicks();
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, 'src'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), '# unmanaged\n');
      await writeFile(join(wd, 'src', 'index.ts'), 'export const x = 1;\n');
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({
          session_id: 'session-1',
          started_at: new Date().toISOString(),
          cwd: wd,
          pid: process.pid,
          pid_start_ticks: pidStartTicks,
        }, null, 2),
      );

      await withCwd(wd, async () => {
        await agentsInit({ force: true });
      });

      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), '# unmanaged\n');
      assert.equal(existsSync(join(wd, 'src', 'AGENTS.md')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('exposes help for agents-init and the deepinit alias', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-init-'));
    try {
      const helpRes = runOmx(wd, ['agents-init', '--help']);
      if (shouldSkipForSpawnPermissions(helpRes.error)) return;
      assert.equal(helpRes.status, 0, helpRes.stderr || helpRes.stdout);
      assert.match(helpRes.stdout, /Usage: omx agents-init/);

      const aliasRes = runOmx(wd, ['deepinit', '--help']);
      if (shouldSkipForSpawnPermissions(aliasRes.error)) return;
      assert.equal(aliasRes.status, 0, aliasRes.stderr || aliasRes.stdout);
      assert.match(aliasRes.stdout, /Usage: omx agents-init/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
