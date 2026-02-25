import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('omx setup scope behavior', () => {
  it('accepts --scope project form', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const bySeparateArg = runOmx(wd, ['setup', '--dry-run', '--scope', 'project'], { HOME: home });
      if (shouldSkipForSpawnPermissions(bySeparateArg.error)) return;
      assert.equal(bySeparateArg.status, 0, bySeparateArg.stderr || bySeparateArg.stdout);
      assert.match(bySeparateArg.stdout, /Using setup scope: project/);

      const byEqualsArg = runOmx(wd, ['setup', '--dry-run', '--scope=user'], { HOME: home });
      if (shouldSkipForSpawnPermissions(byEqualsArg.error)) return;
      assert.equal(byEqualsArg.status, 0, byEqualsArg.stderr || byEqualsArg.stdout);
      assert.match(byEqualsArg.stdout, /Using setup scope: user/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses persisted setup scope when --scope is omitted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const omxDir = join(wd, '.omx');
      const home = join(wd, 'home');
      await mkdir(omxDir, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(join(omxDir, 'setup-scope.json'), JSON.stringify({ scope: 'project' }));

      const res = runOmx(wd, ['setup', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Using setup scope: project \(from \.omx\/setup-scope\.json\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not persist setup scope on --dry-run', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const res = runOmx(wd, ['setup', '--scope', 'project', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(wd, '.omx', 'setup-scope.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('project scope writes prompts/skills/config/native-agents under cwd', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const res = runOmx(wd, ['setup', '--scope', 'project'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const localPrompts = join(wd, '.codex', 'prompts');
      const localSkills = join(wd, '.agents', 'skills');
      const localConfig = join(wd, '.codex', 'config.toml');
      const localAgents = join(wd, '.omx', 'agents');
      const scopeFile = join(wd, '.omx', 'setup-scope.json');
      const agentsMdPath = join(wd, 'AGENTS.md');

      assert.equal(existsSync(localPrompts), true);
      assert.equal(existsSync(localSkills), true);
      assert.equal(existsSync(localConfig), true);
      assert.equal(existsSync(localAgents), true);
      assert.equal(existsSync(join(localAgents, 'executor.toml')), true);
      assert.equal(existsSync(join(localSkills, 'omx-setup', 'SKILL.md')), true);
      assert.ok((await readdir(localPrompts)).length > 0, 'local prompts should be installed');
      assert.equal(existsSync(agentsMdPath), true);

      const configToml = await readFile(localConfig, 'utf-8');
      assert.match(configToml, /\.omx\/agents\/executor\.toml/);
      const agentsMd = await readFile(agentsMdPath, 'utf-8');
      assert.match(agentsMd, /\.\/\.codex\/prompts/);
      assert.match(agentsMd, /\.\/\.agents\/skills/);
      const persistedScope = JSON.parse(await readFile(scopeFile, 'utf-8')) as { scope: string };
      assert.equal(persistedScope.scope, 'project');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('defaults to user scope in non-interactive runs when no scope is persisted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const res = runOmx(wd, ['setup'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Using setup scope: user/);

      assert.equal(existsSync(join(home, '.codex', 'prompts')), true);
      assert.equal(existsSync(join(home, '.agents', 'skills')), true);
      assert.equal(existsSync(join(home, '.omx', 'agents')), true);
      assert.equal(existsSync(join(wd, '.omx', 'setup-scope.json')), true);
      const persistedScope = JSON.parse(await readFile(join(wd, '.omx', 'setup-scope.json'), 'utf-8')) as { scope: string };
      assert.equal(persistedScope.scope, 'user');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy "project-local" persisted scope to "project"', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const omxDir = join(wd, '.omx');
      const home = join(wd, 'home');
      await mkdir(omxDir, { recursive: true });
      await mkdir(home, { recursive: true });
      // Write the legacy scope value
      await writeFile(join(omxDir, 'setup-scope.json'), JSON.stringify({ scope: 'project-local' }));

      const res = runOmx(wd, ['setup', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      // Should migrate and use "project"
      assert.match(res.stdout, /Using setup scope: project/);
      // Should log migration warning to stderr
      assert.match(res.stderr, /Migrating persisted setup scope "project-local"/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves existing AGENTS.md in non-interactive runs without --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const home = join(wd, 'home');
      const existingAgents = '# custom agents instructions\n\nkeep this file\n';
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existingAgents);

      const res = runOmx(wd, ['setup', '--scope=project'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /AGENTS\.md already exists \(use --force to overwrite\)\./);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existingAgents);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('overwrites existing AGENTS.md with --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-scope-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), '# old custom file\n');

      const res = runOmx(wd, ['setup', '--scope=project', '--force'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const overwritten = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      assert.match(overwritten, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.doesNotMatch(overwritten, /# old custom file/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
