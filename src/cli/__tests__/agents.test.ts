import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
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

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('omx agents', () => {
  it('lists project and user native agents with name, description, and model', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-cli-'));
    const home = join(wd, 'home');
    try {
      const projectAgentsDir = join(wd, '.codex', 'agents');
      const userAgentsDir = join(home, '.codex', 'agents');
      await mkdir(projectAgentsDir, { recursive: true });
      await mkdir(userAgentsDir, { recursive: true });

      await writeFile(
        join(projectAgentsDir, 'planner.toml'),
        'name = "planner"\ndescription = "Project planner"\nmodel = "gpt-5.4"\ndeveloper_instructions = """plan"""\n',
      );
      await writeFile(
        join(userAgentsDir, 'reviewer.toml'),
        'name = "reviewer"\ndescription = "User reviewer"\ndeveloper_instructions = """review"""\n',
      );

      const result = runOmx(wd, ['agents', 'list'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /scope\s+name\s+model\s+description/i);
      assert.match(result.stdout, /project\s+planner\s+gpt-5\.4\s+Project planner/);
      assert.match(result.stdout, /user\s+reviewer\s+-\s+User reviewer/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('adds a scaffolded agent TOML file with required fields and commented optional fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-cli-'));
    const home = join(wd, 'home');
    try {
      await mkdir(home, { recursive: true });

      const result = runOmx(wd, ['agents', 'add', 'my-helper', '--scope', 'project'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const agentPath = join(wd, '.codex', 'agents', 'my-helper.toml');
      assert.equal(existsSync(agentPath), true);

      const content = await readFile(agentPath, 'utf-8');
      assert.match(content, /^name = "my-helper"$/m);
      assert.match(content, /^description = "TODO: describe this agent's purpose"$/m);
      assert.match(content, /^developer_instructions = """$/m);
      assert.match(content, /^# model = "gpt-5\.4"$/m);
      assert.match(content, /^# model_reasoning_effort = "medium"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('edits an existing agent via $EDITOR and removes it with --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-cli-'));
    const home = join(wd, 'home');
    try {
      const projectAgentsDir = join(wd, '.codex', 'agents');
      await mkdir(projectAgentsDir, { recursive: true });
      await mkdir(home, { recursive: true });
      const agentPath = join(projectAgentsDir, 'editor-test.toml');
      await writeFile(
        agentPath,
        'name = "editor-test"\ndescription = "Before edit"\ndeveloper_instructions = """before"""\n',
      );

      const editorScript = join(wd, 'editor.sh');
      await writeFile(
        editorScript,
        '#!/usr/bin/env bash\nprintf \'\\nmodel = "gpt-5.4"\\n\' >> "$1"\n',
      );
      await chmod(editorScript, 0o755);

      const editResult = runOmx(wd, ['agents', 'edit', 'editor-test', '--scope', 'project'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        EDITOR: editorScript,
      });
      if (shouldSkipForSpawnPermissions(editResult.error)) return;

      assert.equal(editResult.status, 0, editResult.stderr || editResult.stdout);
      assert.match(await readFile(agentPath, 'utf-8'), /^model = "gpt-5\.4"$/m);

      const removeResult = runOmx(wd, ['agents', 'remove', 'editor-test', '--scope', 'project', '--force'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
      });
      if (shouldSkipForSpawnPermissions(removeResult.error)) return;

      assert.equal(removeResult.status, 0, removeResult.stderr || removeResult.stdout);
      assert.equal(existsSync(agentPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails with clear guidance when remove runs in non-interactive mode without --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-agents-cli-'));
    const home = join(wd, 'home');
    try {
      const projectAgentsDir = join(wd, '.codex', 'agents');
      await mkdir(projectAgentsDir, { recursive: true });
      await mkdir(home, { recursive: true });
      const agentPath = join(projectAgentsDir, 'non-interactive.toml');
      await writeFile(
        agentPath,
        'name = "non-interactive"\ndescription = "Remove me"\ndeveloper_instructions = """noop"""\n',
      );

      const result = runOmx(wd, ['agents', 'remove', 'non-interactive', '--scope', 'project'], {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.notEqual(result.status, 0, 'expected non-zero exit for non-interactive remove');
      assert.equal(existsSync(agentPath), true, 'agent file should remain when remove aborts');
      assert.match(
        result.stderr,
        /remove requires an interactive terminal; rerun with --force in non-interactive environments/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
