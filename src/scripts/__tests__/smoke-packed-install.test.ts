// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ensureRepoDependencies,
  hasUsableNodeModules,
  PACKED_INSTALL_SMOKE_CORE_COMMANDS,
  parseNpmPackJsonOutput,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
} from '../smoke-packed-install.js';

test('packed install smoke stays limited to boot + core commands', () => {
  assert.deepEqual(PACKED_INSTALL_SMOKE_CORE_COMMANDS, [
    ['--help'],
    ['version'],
  ]);
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('explore') || argv.includes('sparkshell')),
    false,
  );
});

test('parseNpmPackJsonOutput ignores prepack logs before npm pack JSON', () => {
  const parsed = parseNpmPackJsonOutput([
    '[sync-plugin-mirror] synced 29 canonical skill directories and plugin metadata',
    '[',
    '  {',
    '    "filename": "oh-my-codex-0.15.0.tgz"',
    '  }',
    ']',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [{ filename: 'oh-my-codex-0.15.0.tgz' }]);
});

test('resolveGitCommonDir resolves relative git common dir output against the repo root', () => {
  const commonDir = resolveGitCommonDir('/tmp/worktree', () => ({
    status: 0,
    stdout: '../primary/.git\n',
    stderr: '',
  }) as ReturnType<typeof import('node:child_process').spawnSync>);
  assert.equal(commonDir, '/tmp/primary/.git');
});

test('hasUsableNodeModules requires the packaged build dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-node-modules-'));
  try {
    const nodeModules = join(root, 'node_modules');
    await mkdir(join(nodeModules, 'typescript'), { recursive: true });
    await mkdir(join(nodeModules, '@iarna', 'toml'), { recursive: true });
    await mkdir(join(nodeModules, '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(nodeModules, 'zod'), { recursive: true });
    await writeFile(join(nodeModules, 'typescript', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(nodeModules, 'zod', 'package.json'), '{}');

    assert.equal(hasUsableNodeModules(root), true);

    await rm(join(nodeModules, 'zod', 'package.json'));
    assert.equal(hasUsableNodeModules(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveReusableNodeModulesSource reuses primary worktree node_modules when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-reuse-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const reusable = resolveReusableNodeModulesSource(worktreeRepo, () => ({
      status: 0,
      stdout: `${join(primaryRepo, '.git')}\n`,
      stderr: '',
    }) as ReturnType<typeof import('node:child_process').spawnSync>);

    assert.equal(reusable, join(primaryRepo, 'node_modules'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies symlinks a reusable primary worktree node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-symlink-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const events: string[] = [];
    const result = ensureRepoDependencies(worktreeRepo, {
      gitRunner: () => ({
        status: 0,
        stdout: `${join(primaryRepo, '.git')}\n`,
        stderr: '',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: () => {
        throw new Error('install should not be called when a reusable node_modules source exists');
      },
      log: (message: string) => events.push(message),
    });

    assert.equal(result.strategy, 'symlink');
    assert.equal(result.sourceNodeModulesPath, join(primaryRepo, 'node_modules'));
    assert.equal(events[0], `[smoke:packed-install] Reusing node_modules from ${join(primaryRepo, 'node_modules')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies falls back to npm ci when no reusable node_modules source exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-install-node-modules-'));
  try {
    const installs: string[] = [];
    const result = ensureRepoDependencies(root, {
      gitRunner: () => ({
        status: 1,
        stdout: '',
        stderr: 'not a worktree',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: (cwd: string) => {
        installs.push(cwd);
      },
    });

    assert.equal(result.strategy, 'installed');
    assert.deepEqual(installs, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
