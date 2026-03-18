import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ensureRepoDependencies,
  hasSparkShellFallbackBanner,
  hasUsableNodeModules,
  prepareLocalHydrationAssetDirectory,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
  rewriteManifestDownloadUrls,
} from '../smoke-packed-install.mjs';

test('detects the sparkshell GLIBC fallback banner', () => {
  assert.equal(
    hasSparkShellFallbackBanner('[sparkshell] GLIBC-incompatible native sidecar detected; falling back to raw command execution without summary support.\n'),
    true,
  );
  assert.equal(hasSparkShellFallbackBanner('node v20.0.0\n'), false);
});

test('rewrites copied native manifest download urls to the local smoke server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-packed-install-'));
  try {
    const sourceDir = join(root, 'source-release-assets');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'omx-explore-harness-x86_64-unknown-linux-musl.tar.xz'), 'explore');
    await writeFile(join(sourceDir, 'omx-sparkshell-x86_64-unknown-linux-musl.tar.xz'), 'sparkshell');
    await writeFile(join(sourceDir, 'native-release-manifest.json'), JSON.stringify({
      version: '0.9.0',
      assets: [
        {
          product: 'omx-explore-harness',
          archive: 'omx-explore-harness-x86_64-unknown-linux-musl.tar.xz',
          download_url: 'https://github.com/example/omx-explore-harness-x86_64-unknown-linux-musl.tar.xz',
        },
        {
          product: 'omx-sparkshell',
          archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.xz',
          download_url: 'https://github.com/example/omx-sparkshell-x86_64-unknown-linux-musl.tar.xz',
        },
      ],
    }, null, 2));

    const copiedDir = prepareLocalHydrationAssetDirectory(sourceDir, root);
    rewriteManifestDownloadUrls(join(copiedDir, 'native-release-manifest.json'), 'http://127.0.0.1:43123');

    const originalManifest = JSON.parse(await readFile(join(sourceDir, 'native-release-manifest.json'), 'utf-8'));
    const copiedManifest = JSON.parse(await readFile(join(copiedDir, 'native-release-manifest.json'), 'utf-8'));

    assert.match(originalManifest.assets[0].download_url, /^https:\/\/github\.com\//);
    assert.deepEqual(
      copiedManifest.assets.map((asset) => asset.download_url),
      [
        'http://127.0.0.1:43123/omx-explore-harness-x86_64-unknown-linux-musl.tar.xz',
        'http://127.0.0.1:43123/omx-sparkshell-x86_64-unknown-linux-musl.tar.xz',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveGitCommonDir resolves relative git common dir output against the repo root', () => {
  const commonDir = resolveGitCommonDir('/tmp/worktree', () => ({
    status: 0,
    stdout: '../primary/.git\n',
    stderr: '',
  }));
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
    }));

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

    const events = [];
    const result = ensureRepoDependencies(worktreeRepo, {
      gitRunner: () => ({
        status: 0,
        stdout: `${join(primaryRepo, '.git')}\n`,
        stderr: '',
      }),
      install: () => {
        throw new Error('install should not be called when a reusable node_modules source exists');
      },
      log: (message) => events.push(message),
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
    const installs = [];
    const result = ensureRepoDependencies(root, {
      gitRunner: () => ({
        status: 1,
        stdout: '',
        stderr: 'not a worktree',
      }),
      install: (cwd) => {
        installs.push(cwd);
      },
    });

    assert.equal(result.strategy, 'installed');
    assert.deepEqual(installs, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
