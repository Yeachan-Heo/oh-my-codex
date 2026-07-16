import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import type { ScopeManifest, ScopeSelector } from '../contract.js';

const execFile = promisify(execFileCallback);

type GitExecutor = (workingDirectory: string, args: readonly string[]) => Promise<Buffer>;

interface ResolveOptions {
  workingDirectory: string;
  selector?: ScopeSelector;
  effectiveConfig?: Readonly<Record<string, unknown>>;
  gitExecutor?: GitExecutor;
  fileSystem?: unknown;
}

interface ScopeApi {
  resolveGitScope(options: ResolveOptions): Promise<ScopeManifest>;
  runGitCommand(workingDirectory: string, args: readonly string[]): Promise<Buffer>;
  verifyScopeDrift(
    manifest: ScopeManifest,
    options: Omit<ResolveOptions, 'selector'>,
  ): Promise<{ matches: boolean; current_scope_hash: string }>;
}

async function loadScopeApi(): Promise<ScopeApi> {
  const modulePath: string = '../scope.js';
  const loaded = (await import(modulePath).catch(() => null)) as Partial<ScopeApi> | null;
  assert.equal(
    typeof loaded?.resolveGitScope,
    'function',
    'expected staged, untracked, and base-relative Git discovery to be implemented',
  );
  return loaded as ScopeApi;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'omx-code-review-scope-'));
  await git(repository, 'init', '-q');
  await git(repository, 'config', 'user.email', 'scope@example.invalid');
  await git(repository, 'config', 'user.name', 'Scope Test');
  await writeFile(join(repository, 'tracked.txt'), 'initial\n');
  await writeFile(join(repository, 'overlap.txt'), 'initial\n');
  await git(repository, 'add', '--', 'tracked.txt', 'overlap.txt');
  await git(repository, 'commit', '-qm', 'initial');
  return repository;
}

async function withRepository(run: (repository: string, api: ScopeApi) => Promise<void>): Promise<void> {
  const repository = await createRepository();
  try {
    await run(repository, await loadScopeApi());
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

function byPath(manifest: ScopeManifest): Map<string, ScopeManifest['files'][number]> {
  return new Map(manifest.files.map((entry) => [entry.path, entry]));
}

describe('real Git scope discovery', () => {
  it('derives TypeScript compiler and lint applicability only from the frozen base commit', async () => {
    await withRepository(async (repository, api) => {
      await mkdir(join(repository, 'src'), { recursive: true });
      await writeFile(join(repository, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'tsc --noEmit', lint: 'eslint src' },
      }));
      await writeFile(join(repository, 'tsconfig.json'), '{}\n');
      await writeFile(join(repository, 'eslint.config.mjs'), 'export default [];\n');
      await writeFile(join(repository, 'src', 'app.ts'), 'export const value = 1;\n');
      await git(repository, 'add', '--', 'package.json', 'tsconfig.json', 'eslint.config.mjs', 'src/app.ts');
      await git(repository, 'commit', '-qm', 'typescript baseline');
      await writeFile(join(repository, 'src', 'app.ts'), 'export const value = 2;\n');

      const first = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
      }) as ScopeManifest & { frozen_capability_config?: {
        typescript_javascript: { compiler_or_typecheck: boolean; lint: boolean };
      } };
      assert.deepEqual(first.frozen_capability_config?.typescript_javascript, {
        compiler_or_typecheck: true,
        lint: true,
      });

      await writeFile(join(repository, 'package.json'), '{"scripts":{}}\n');
      await rm(join(repository, 'tsconfig.json'));
      await rm(join(repository, 'eslint.config.mjs'));
      const afterWorktreeMutation = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
      }) as typeof first;
      assert.deepEqual(
        afterWorktreeMutation.frozen_capability_config,
        first.frozen_capability_config,
      );
    });
  });

  it('unions staged, unstaged, exclude-standard untracked, and overlapping origins', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, '.gitignore'), '*.ignored\n');
      await writeFile(join(repository, 'staged.txt'), 'staged\n');
      await git(repository, 'add', '--', '.gitignore', 'staged.txt');
      await writeFile(join(repository, 'tracked.txt'), 'unstaged\n');
      await writeFile(join(repository, 'overlap.txt'), 'index version\n');
      await git(repository, 'add', '--', 'overlap.txt');
      await writeFile(join(repository, 'overlap.txt'), 'worktree version\n');
      await writeFile(join(repository, 'new-overlap.txt'), 'index version\n');
      await git(repository, 'add', '--', 'new-overlap.txt');
      await writeFile(join(repository, 'new-overlap.txt'), 'worktree version\n');
      await writeFile(join(repository, 'untracked.txt'), 'untracked\n');
      await writeFile(join(repository, 'secret.ignored'), 'must not be read\n');

      const manifest = await api.resolveGitScope({ workingDirectory: repository });
      const files = byPath(manifest);

      assert.deepEqual([...files.keys()], [
        '.gitignore',
        'new-overlap.txt',
        'overlap.txt',
        'staged.txt',
        'tracked.txt',
        'untracked.txt',
      ]);
      assert.deepEqual(files.get('overlap.txt')?.sources, ['INDEX', 'WORKTREE']);
      assert.deepEqual(files.get('new-overlap.txt')?.sources, ['INDEX', 'WORKTREE']);
      assert.equal(files.get('new-overlap.txt')?.change, 'ADDED');
      assert.deepEqual(files.get('staged.txt')?.sources, ['INDEX']);
      assert.deepEqual(files.get('tracked.txt')?.sources, ['WORKTREE']);
      assert.deepEqual(files.get('untracked.txt')?.sources, ['UNTRACKED']);
      assert.equal(files.has('secret.ignored'), false);
      assert.equal(manifest.status, 'PARTIAL_SCOPE');
      assert.deepEqual(manifest.reasons, ['BASE_UNRESOLVED']);
      assert.ok(manifest.changed_lines >= 5);
    });
  });

  it('excludes OMX runtime state even before Git ignore setup has run', async () => {
    await withRepository(async (repository, api) => {
      await mkdir(join(repository, '.omx', 'state'), { recursive: true });
      await writeFile(join(repository, '.omx', 'state', 'active.json'), '{"active":true}\n');
      await writeFile(join(repository, 'visible.txt'), 'review me\n');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
      });

      assert.deepEqual(manifest.files.map((entry) => entry.path), ['visible.txt']);
    });
  });

  it('keeps plain and leading-BOM Git paths as distinct byte-stable identities', async () => {
    await withRepository(async (repository, api) => {
      const bomPath = '\uFEFFa';
      await writeFile(join(repository, 'a'), 'plain\n');
      await writeFile(join(repository, bomPath), 'bom\n');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
      });
      assert.deepEqual(manifest.files.map((entry) => entry.path), ['a', bomPath]);

      const plain = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: ['a'] },
      });
      const bom = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [bomPath] },
      });
      assert.deepEqual(plain.files.map((entry) => entry.path), ['a']);
      assert.deepEqual(bom.files.map((entry) => entry.path), [bomPath]);
      assert.notEqual(plain.scope_hash, bom.scope_hash);
    });
  });

  it('uses an explicit base for committed changes and keeps it in detached HEAD state', async () => {
    await withRepository(async (repository, api) => {
      const base = await git(repository, 'rev-parse', 'HEAD');
      await writeFile(join(repository, 'committed.txt'), 'branch change\n');
      await git(repository, 'add', '--', 'committed.txt');
      await git(repository, 'commit', '-qm', 'branch change');
      await git(repository, 'checkout', '--detach', '-q');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: base, explicit_paths: [] },
      });

      assert.equal(manifest.status, 'FULL_SCOPE');
      assert.equal(manifest.base_ref, base);
      assert.equal(manifest.base_sha, base);
      assert.deepEqual(manifest.files.map((entry) => entry.path), ['committed.txt']);
      assert.deepEqual(manifest.files[0]?.sources, ['BASE']);

      const unresolved = await api.resolveGitScope({ workingDirectory: repository });
      assert.equal(unresolved.status, 'PARTIAL_SCOPE');
      assert.deepEqual(unresolved.reasons, ['BASE_UNRESOLVED']);
    });
  });

  it('freezes a verified explicit base SHA before computing its merge base', async () => {
    await withRepository(async (repository, api) => {
      const verifiedSha = await git(repository, 'rev-parse', 'HEAD');
      await writeFile(join(repository, 'tracked.txt'), 'changed\n');
      const mergeBaseArgs: string[][] = [];
      const movingRefExecutor: GitExecutor = async (workingDirectory, args) => {
        if (args[0] === 'rev-parse'
          && args[1] === '--verify'
          && args[2] === '--end-of-options'
          && args[3] === 'moving-ref^{commit}') {
          return Buffer.from(`${verifiedSha}\n`);
        }
        if (args[0] === 'merge-base') mergeBaseArgs.push([...args]);
        return api.runGitCommand(workingDirectory, args);
      };

      const scope = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'moving-ref', explicit_paths: [] },
        gitExecutor: movingRefExecutor,
      });

      assert.equal(scope.base_ref, 'moving-ref');
      assert.equal(scope.base_sha, verifiedSha);
      assert.deepEqual(mergeBaseArgs, [['merge-base', verifiedSha, verifiedSha]]);
    });
  });

  it('rejects missing or empty explicit-base verification before invoking merge-base', async () => {
    await withRepository(async (repository, api) => {
      for (const verification of ['missing', 'empty'] as const) {
        let mergeBaseCalls = 0;
        const invalidBaseExecutor: GitExecutor = async (workingDirectory, args) => {
          if (args[0] === 'rev-parse'
            && args[1] === '--verify'
            && args[3] === 'missing-or-empty^{commit}') {
            if (verification === 'missing') {
              throw Object.assign(new Error('base is missing'), { code: 1 });
            }
            return Buffer.alloc(0);
          }
          if (args[0] === 'merge-base') mergeBaseCalls += 1;
          return api.runGitCommand(workingDirectory, args);
        };

        await assert.rejects(
          api.resolveGitScope({
            workingDirectory: repository,
            selector: { requested_base: 'missing-or-empty', explicit_paths: [] },
            gitExecutor: invalidBaseExecutor,
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'INVALID_BASE',
        );
        assert.equal(mergeBaseCalls, 0, verification);
      }
    });
  });

  it('uses exactly one symbolic remote default and refuses to guess among multiple defaults', async () => {
    await withRepository(async (repository, api) => {
      const base = await git(repository, 'rev-parse', 'HEAD');
      await git(repository, 'update-ref', 'refs/remotes/origin/main', base);
      await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      await writeFile(join(repository, 'tracked.txt'), 'single remote default\n');

      const oneDefault = await api.resolveGitScope({ workingDirectory: repository });
      assert.equal(oneDefault.status, 'FULL_SCOPE');
      assert.equal(oneDefault.base_ref, 'refs/remotes/origin/main');

      await git(repository, 'update-ref', 'refs/remotes/upstream/trunk', base);
      await git(
        repository,
        'symbolic-ref',
        'refs/remotes/upstream/HEAD',
        'refs/remotes/upstream/trunk',
      );
      const multipleDefaults = await api.resolveGitScope({ workingDirectory: repository });
      assert.equal(multipleDefaults.status, 'PARTIAL_SCOPE');
      assert.equal(multipleDefaults.base_sha, undefined);
      assert.deepEqual(multipleDefaults.reasons, ['BASE_UNRESOLVED']);
      assert.deepEqual(multipleDefaults.files.map((entry) => entry.path), ['tracked.txt']);
    });
  });

  it('prefers the configured upstream over a remote default and an explicit base over both', async () => {
    await withRepository(async (repository, api) => {
      const initial = await git(repository, 'rev-parse', 'HEAD');
      await writeFile(join(repository, 'committed.txt'), 'committed after initial\n');
      await git(repository, 'add', '--', 'committed.txt');
      await git(repository, 'commit', '-qm', 'later commit');
      const current = await git(repository, 'rev-parse', 'HEAD');
      const branch = await git(repository, 'branch', '--show-current');
      await git(repository, 'branch', 'upstream-target', current);
      await git(repository, 'branch', '--set-upstream-to=upstream-target', branch);
      await git(repository, 'update-ref', 'refs/remotes/origin/main', initial);
      await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

      const upstream = await api.resolveGitScope({ workingDirectory: repository });
      // ASSERTION-CHANGE-JUSTIFIED: the fail-closed for-each-ref probe returns the canonical
      // configured upstream ref, whereas the removed rev-parse probe abbreviated local refs.
      assert.equal(upstream.base_ref, 'refs/heads/upstream-target');
      assert.equal(upstream.base_sha, current);
      assert.deepEqual(upstream.files, []);

      const explicit = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: initial, explicit_paths: [] },
      });
      assert.equal(explicit.base_ref, initial);
      assert.deepEqual(explicit.files.map((entry) => entry.path), ['committed.txt']);
    });
  });

  it('returns an empty terminal scope for a clean repository and rejects non-Git directories', async () => {
    await withRepository(async (repository, api) => {
      const clean = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
      });
      assert.deepEqual(clean.files, []);
      assert.equal(clean.changed_lines, 0);

      const nonGit = await mkdtemp(join(tmpdir(), 'omx-code-review-non-git-'));
      const sentinel = join(nonGit, 'do-not-read.txt');
      await writeFile(sentinel, 'unchanged content\n');
      try {
        await assert.rejects(
          api.resolveGitScope({ workingDirectory: nonGit }),
          (error: unknown) => (error as { code?: unknown }).code === 'NOT_GIT_REPOSITORY',
        );
        assert.equal(await readFile(sentinel, 'utf8'), 'unchanged content\n');
      } finally {
        await rm(nonGit, { recursive: true, force: true });
      }
    });
  });

  it('preserves a repository root whose final path segment ends in a space', async () => {
    const api = await loadScopeApi();
    const outer = await mkdtemp(join(tmpdir(), 'omx-code-review-spaced-root-'));
    const repository = join(outer, 'repository ');
    try {
      await mkdir(repository);
      await git(repository, 'init', '-q');
      await git(repository, 'config', 'user.email', 'scope@example.invalid');
      await git(repository, 'config', 'user.name', 'Scope Test');
      await writeFile(join(repository, 'tracked.txt'), 'initial\n');
      await git(repository, 'add', '--', 'tracked.txt');
      await git(repository, 'commit', '-qm', 'initial');
      await writeFile(join(repository, 'tracked.txt'), 'changed\n');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
      });
      assert.deepEqual(manifest.files.map((entry) => entry.path), ['tracked.txt']);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('preserves rename, deletion, type-change, binary, symlink, and gitlink boundaries', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, 'rename-me.txt'), 'rename\n');
      await writeFile(join(repository, 'delete-me.txt'), 'delete\n');
      await writeFile(join(repository, 'kind.txt'), 'regular\n');
      await git(repository, 'add', '--', 'rename-me.txt', 'delete-me.txt', 'kind.txt');
      await git(repository, 'commit', '-qm', 'fixture kinds');
      const base = await git(repository, 'rev-parse', 'HEAD');

      await git(repository, 'mv', '--', 'rename-me.txt', 'renamed.txt');
      await git(repository, 'rm', '-q', '--', 'delete-me.txt');
      await rm(join(repository, 'kind.txt'));
      await symlink('tracked.txt', join(repository, 'kind.txt'));
      await writeFile(join(repository, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
      await git(repository, 'add', '--', 'kind.txt', 'asset.bin');
      await git(repository, 'update-index', '--add', '--cacheinfo', `160000,${base},vendor/sub`);

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: base, explicit_paths: [] },
      });
      const files = byPath(manifest);

      assert.equal(files.get('renamed.txt')?.change, 'RENAMED');
      assert.equal(files.get('renamed.txt')?.previous_path, 'rename-me.txt');
      assert.equal(files.get('delete-me.txt')?.change, 'DELETED');
      assert.equal(files.get('kind.txt')?.change, 'SYMLINK');
      assert.equal(files.get('asset.bin')?.binary, true);
      assert.equal(files.get('vendor/sub')?.change, 'SUBMODULE');
      assert.equal(files.get('kind.txt')?.additions, undefined);
      assert.equal(files.get('vendor/sub')?.additions, undefined);
    });
  });

  it('stops on an unmerged index instead of launching a partial review', async () => {
    await withRepository(async (repository, api) => {
      const initialBranch = await git(repository, 'branch', '--show-current');
      await git(repository, 'checkout', '-qb', 'conflict-side');
      await writeFile(join(repository, 'tracked.txt'), 'side\n');
      await git(repository, 'commit', '-qam', 'side');
      await git(repository, 'checkout', '-q', initialBranch);
      await writeFile(join(repository, 'tracked.txt'), 'main\n');
      await git(repository, 'commit', '-qam', 'main');
      await assert.rejects(git(repository, 'merge', '--no-edit', 'conflict-side'));

      await assert.rejects(
        api.resolveGitScope({ workingDirectory: repository }),
        (error: unknown) => (error as { code?: unknown }).code === 'UNMERGED',
      );
    });
  });

  it('excludes an explicitly named ignored path and filters only after the full union', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, '.gitignore'), 'ignored/**\n');
      await git(repository, 'add', '--', '.gitignore');
      await mkdir(join(repository, 'ignored'));
      await writeFile(join(repository, 'ignored', 'secret.txt'), 'secret\n');
      await mkdir(join(repository, 'src'));
      await writeFile(join(repository, 'src', 'staged.ts'), 'staged\n');
      await git(repository, 'add', '--', 'src/staged.ts');
      await writeFile(join(repository, 'src', 'unstaged.ts'), 'unstaged\n');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { explicit_paths: ['src', 'ignored/secret.txt'] },
      });

      assert.deepEqual(manifest.files.map((entry) => entry.path), [
        'src/staged.ts',
        'src/unstaged.ts',
      ]);
      assert.equal(manifest.status, 'PARTIAL_SCOPE');
      assert.deepEqual(manifest.reasons, ['BASE_UNRESOLVED', 'IGNORED_PATH_EXCLUDED']);
    });
  });

  it('does not widen an all-ignored explicit selector to every changed file', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
      await git(repository, 'add', '--', '.gitignore');
      await writeFile(join(repository, 'ignored.txt'), 'ignored\n');
      await writeFile(join(repository, 'visible.txt'), 'visible but outside the selector\n');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: ['ignored.txt'] },
      });

      assert.deepEqual(manifest.files, []);
      assert.equal(manifest.changed_lines, 0);
      assert.deepEqual(manifest.reasons, ['IGNORED_PATH_EXCLUDED']);
    });
  });

  it('reports ignored directory descendants without filtering visible changed siblings', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, '.gitignore'), 'mixed/*.ignored\n');
      await git(repository, 'add', '--', '.gitignore');
      await mkdir(join(repository, 'mixed'));
      await writeFile(join(repository, 'mixed', 'secret.ignored'), 'must not be read\n');
      await writeFile(join(repository, 'mixed', 'visible.ts'), 'review me\n');

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: ['mixed'] },
      });

      assert.deepEqual(manifest.files.map((entry) => entry.path), ['mixed/visible.ts']);
      assert.equal(manifest.status, 'PARTIAL_SCOPE');
      assert.deepEqual(manifest.reasons, ['IGNORED_PATH_EXCLUDED']);
    });
  });

  it('treats ignored descendant additions and removals as scope drift', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, '.gitignore'), 'mixed/*.ignored\n');
      await git(repository, 'add', '--', '.gitignore');
      await git(repository, 'commit', '-qm', 'ignore contract');
      await mkdir(join(repository, 'mixed'));
      await writeFile(join(repository, 'mixed', 'visible.ts'), 'stable visible change\n');
      const options = {
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: ['mixed'] },
      };

      const beforeIgnored = await api.resolveGitScope(options);
      assert.equal(beforeIgnored.status, 'FULL_SCOPE');

      const ignoredPath = join(repository, 'mixed', 'secret.ignored');
      await writeFile(ignoredPath, 'ignored descendant\n');
      const withIgnored = await api.resolveGitScope(options);
      assert.equal(withIgnored.status, 'PARTIAL_SCOPE');
      assert.deepEqual(withIgnored.files, beforeIgnored.files);
      assert.notEqual(withIgnored.scope_hash, beforeIgnored.scope_hash);
      assert.equal(
        (await api.verifyScopeDrift(beforeIgnored, { workingDirectory: repository })).matches,
        false,
      );

      await rm(ignoredPath);
      const afterRemoval = await api.resolveGitScope(options);
      assert.equal(afterRemoval.scope_hash, beforeIgnored.scope_hash);
      assert.equal(
        (await api.verifyScopeDrift(withIgnored, { workingDirectory: repository })).matches,
        false,
      );
    });
  });

  it('fails an invalid explicit base before discovery and maps unexpected Git failures', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, 'untracked.txt'), 'must not be discovered\n');
      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'does-not-exist', explicit_paths: [] },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'INVALID_BASE',
      );

      let calls = 0;
      const failingExecutor: GitExecutor = async (workingDirectory, args) => {
        calls += 1;
        if (calls === 1) return api.runGitCommand(workingDirectory, args);
        throw new Error('injected Git failure');
      };
      await assert.rejects(
        api.resolveGitScope({ workingDirectory: repository, gitExecutor: failingExecutor }),
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );

      const failedUpstreamProbe: GitExecutor = async (workingDirectory, args) => {
        if (
          args.includes('@{upstream}') ||
          (args[0] === 'for-each-ref' && args.includes('--format=%(upstream)'))
        ) {
          throw new Error('injected upstream probe failure');
        }
        return api.runGitCommand(workingDirectory, args);
      };
      await assert.rejects(
        api.resolveGitScope({ workingDirectory: repository, gitExecutor: failedUpstreamProbe }),
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );

      const exit128 = (): Error & { code: number } =>
        Object.assign(new Error('injected Git exit 128'), { code: 128 });
      const fatalUpstreamProbe: GitExecutor = async (workingDirectory, args) => {
        if (
          args.includes('@{upstream}') ||
          (args[0] === 'for-each-ref' && args.includes('--format=%(upstream)'))
        ) {
          throw exit128();
        }
        return api.runGitCommand(workingDirectory, args);
      };
      await assert.rejects(
        api.resolveGitScope({ workingDirectory: repository, gitExecutor: fatalUpstreamProbe }),
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );

      const fatalMergeBase: GitExecutor = async (workingDirectory, args) => {
        if (args[0] === 'merge-base') throw exit128();
        return api.runGitCommand(workingDirectory, args);
      };
      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: [] },
          gitExecutor: fatalMergeBase,
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );

      const invalidUntrackedPaths: GitExecutor = async (workingDirectory, args) => {
        if (
          args[0] === 'ls-files' &&
          args.includes('--others') &&
          !args.includes('--ignored')
        ) {
          return Buffer.from([0x80, 0, 0x81, 0]);
        }
        return api.runGitCommand(workingDirectory, args);
      };
      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: [] },
          gitExecutor: invalidUntrackedPaths,
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );
    });
  });

  it('fails closed for path decoding, optional Git probes, and explicit-base edge cases', async () => {
    await withRepository(async (repository, api) => {
      const noTrailingNewline: GitExecutor = async (workingDirectory, args) =>
        args[0] === 'rev-parse' && args[1] === '--show-toplevel'
          ? Buffer.from(repository)
          : api.runGitCommand(workingDirectory, args);
      assert.match(
        (await api.resolveGitScope({ workingDirectory: repository, gitExecutor: noTrailingNewline })).scope_hash,
        /^[0-9a-f]{64}$/u,
      );

      const emptyRoot: GitExecutor = async (workingDirectory, args) =>
        args[0] === 'rev-parse' && args[1] === '--show-toplevel'
          ? Buffer.alloc(0)
          : api.runGitCommand(workingDirectory, args);
      await assert.rejects(
        api.resolveGitScope({ workingDirectory: repository, gitExecutor: emptyRoot }),
        (error: unknown) => (error as { code?: unknown }).code === 'NOT_GIT_REPOSITORY',
      );

      const failedOptionalProbe: GitExecutor = async (workingDirectory, args) => {
        if (args[0] === 'symbolic-ref') throw new Error('optional probe without an exit code');
        return api.runGitCommand(workingDirectory, args);
      };
      await assert.rejects(
        api.resolveGitScope({ workingDirectory: repository, gitExecutor: failedOptionalProbe }),
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );

      for (const requestedBase of ['-option-like-base', 'base\0with-nul']) {
        await assert.rejects(
          api.resolveGitScope({
            workingDirectory: repository,
            selector: { requested_base: requestedBase, explicit_paths: [] },
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'INVALID_BASE',
        );
      }

      const noMergeBase: GitExecutor = async (workingDirectory, args) => {
        if (args[0] === 'merge-base') {
          throw Object.assign(new Error('histories do not meet'), { code: 1 });
        }
        return api.runGitCommand(workingDirectory, args);
      };
      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: [] },
          gitExecutor: noMergeBase,
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'INVALID_BASE',
      );
    });
  });

  it('rejects defensive unmerged discovery and preserves the strongest duplicate change', async () => {
    await withRepository(async (repository, api) => {
      const injectedNameStatus = (payload: string): GitExecutor => async (workingDirectory, args) => {
        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-status')) {
          return Buffer.from(payload);
        }
        return api.runGitCommand(workingDirectory, args);
      };

      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: [] },
          gitExecutor: injectedNameStatus('U\0tracked.txt\0'),
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'UNMERGED',
      );

      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: [] },
        gitExecutor: injectedNameStatus('M\0tracked.txt\0T\0tracked.txt\0'),
      });
      assert.equal(byPath(manifest).get('tracked.txt')?.change, 'TYPE_CHANGED');
    });
  });

  it('maps lstat and readlink races to scope drift without widening the scope', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, 'tracked.txt'), 'changed\n');
      const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: ['tracked.txt'] },
          fileSystem: {
            lstat: async () => { throw denied; },
            open: (path: string, flags: number) => open(path, flags),
            readlink: (path: string) => readlink(path, { encoding: 'buffer' }),
          },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'SCOPE_DRIFT',
      );

      await symlink('tracked.txt', join(repository, 'link.txt'));
      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: ['link.txt'] },
          fileSystem: {
            lstat: (path: string) => lstat(path, { bigint: true }),
            open: (path: string, flags: number) => open(path, flags),
            readlink: async () => { throw new Error('link changed'); },
          },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'SCOPE_DRIFT',
      );
    });
  });

  it('recomputes ephemeral content hashes to detect scope drift', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, 'untracked.txt'), 'version one\n');
      const manifest = await api.resolveGitScope({ workingDirectory: repository });
      const unchanged = await api.verifyScopeDrift(manifest, { workingDirectory: repository });
      assert.equal(unchanged.matches, true);

      await writeFile(join(repository, 'untracked.txt'), 'version two\n');
      const drifted = await api.verifyScopeDrift(manifest, { workingDirectory: repository });
      assert.equal(drifted.matches, false);
      assert.notEqual(drifted.current_scope_hash, manifest.scope_hash);
      assert.equal(JSON.stringify(manifest).includes('version one'), false);
    });
  });

  it('rejects a regular file replaced by a symlink between lstat and open without reading its target', async () => {
    await withRepository(async (repository, api) => {
      const external = await mkdtemp(join(tmpdir(), 'omx-code-review-external-secret-'));
      const secret = join(external, 'secret.txt');
      const reviewed = join(repository, 'race.txt');
      await writeFile(secret, 'external secret must not be read\n');
      await writeFile(reviewed, 'base\n');
      await git(repository, 'add', '--', 'race.txt');
      await git(repository, 'commit', '-qm', 'race base');
      await writeFile(reviewed, 'changed\n');
      let swapped = false;

      try {
        await assert.rejects(
          api.resolveGitScope({
            workingDirectory: repository,
            selector: { requested_base: 'HEAD', explicit_paths: ['race.txt'] },
            fileSystem: {
              lstat: async (path: string) => {
                const stat = await lstat(path, { bigint: true });
                if (basename(path) === 'race.txt' && !swapped) {
                  await rename(path, `${path}.original`);
                  await symlink(secret, path);
                  swapped = true;
                }
                return stat;
              },
              open: (path: string, flags: number) => open(path, flags),
              readlink: (path: string) => readlink(path, { encoding: 'buffer' }),
            },
          }),
          (error: unknown) => (error as { code?: unknown }).code === 'SCOPE_DRIFT',
        );
        assert.equal(swapped, true);
        assert.equal(await readFile(secret, 'utf8'), 'external secret must not be read\n');
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });

  it('closes an opened handle when file identity changes before streaming', async () => {
    await withRepository(async (repository, api) => {
      const reviewed = join(repository, 'identity.txt');
      await writeFile(reviewed, 'base\n');
      await git(repository, 'add', '--', 'identity.txt');
      await git(repository, 'commit', '-qm', 'identity base');
      await writeFile(reviewed, 'changed\n');
      let closeCalls = 0;
      let streamCalls = 0;

      await assert.rejects(
        api.resolveGitScope({
          workingDirectory: repository,
          selector: { requested_base: 'HEAD', explicit_paths: ['identity.txt'] },
          fileSystem: {
            lstat: async (path: string) => {
              const stat = await lstat(path, { bigint: true });
              return new Proxy(stat, {
                get(target, property, receiver) {
                  if (property === 'ino') return target.ino + 1n;
                  const value = Reflect.get(target, property, receiver) as unknown;
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            },
            open: async (path: string, flags: number) => {
              const handle = await open(path, flags);
              return new Proxy(handle, {
                get(target, property, receiver) {
                  if (property === 'close') {
                    return async () => {
                      closeCalls += 1;
                      await target.close();
                    };
                  }
                  if (property === 'createReadStream') {
                    return (...args: Parameters<typeof target.createReadStream>) => {
                      streamCalls += 1;
                      return target.createReadStream(...args);
                    };
                  }
                  const value = Reflect.get(target, property, receiver) as unknown;
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            },
            readlink: (path: string) => readlink(path, { encoding: 'buffer' }),
          },
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'SCOPE_DRIFT',
      );
      assert.equal(closeCalls, 1);
      assert.equal(streamCalls, 0);
    });
  });

  it('uses literal pathspecs for metacharacter filenames while directories still include descendants', async () => {
    await withRepository(async (repository, api) => {
      const paths = [
        'a1.txt',
        'a[1].txt',
        'star*.txt',
        'starX.txt',
        'question?.txt',
        'questionX.txt',
        'dir[1]/inside.ts',
        'dir1/outside.ts',
      ];
      await mkdir(join(repository, 'dir[1]'));
      await mkdir(join(repository, 'dir1'));
      for (const [index, path] of paths.entries()) {
        await writeFile(join(repository, path), `base ${index}\n`);
      }
      await git(repository, 'add', '--', ...paths);
      await git(repository, 'commit', '-qm', 'literal pathspec fixtures');
      for (const [index, path] of paths.entries()) {
        await writeFile(join(repository, path), `changed ${index}\n`);
      }
      await git(repository, 'add', '--', ...paths);

      const calls: string[][] = [];
      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: {
          requested_base: 'HEAD',
          explicit_paths: ['a[1].txt', 'star*.txt', 'question?.txt', 'dir[1]'],
        },
        gitExecutor: async (workingDirectory, args) => {
          calls.push([...args]);
          return api.runGitCommand(workingDirectory, args);
        },
      });
      assert.deepEqual(manifest.files.map((entry) => entry.path), [
        'a[1].txt',
        'dir[1]/inside.ts',
        'question?.txt',
        'star*.txt',
      ]);

      const suppliedPathspecs = calls.flatMap((args) => {
        const separator = args.indexOf('--');
        return separator < 0 ? [] : args.slice(separator + 1);
      });
      assert.ok(suppliedPathspecs.length > 0);
      for (const pathspec of suppliedPathspecs) {
        assert.ok(pathspec.startsWith(':(literal)'), pathspec);
      }
    });
  });

  it('invokes Git through argument arrays with pathspec separators and persists no source or full diff', async () => {
    await withRepository(async (repository, api) => {
      await writeFile(join(repository, 'tracked.txt'), 'argument arrays\n');
      const calls: string[][] = [];
      const manifest = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { requested_base: 'HEAD', explicit_paths: ['tracked.txt'] },
        gitExecutor: async (workingDirectory, args) => {
          assert.equal(Array.isArray(args), true);
          calls.push([...args]);
          return api.runGitCommand(workingDirectory, args);
        },
      });

      const pathCommands = calls.filter((args) =>
        ['diff', 'ls-files', 'ls-tree', 'check-ignore'].includes(args[0] ?? ''),
      );
      assert.ok(pathCommands.length > 0);
      for (const args of pathCommands) {
        if (args[0] === 'diff' || args[0] === 'ls-tree' || args[0] === 'check-ignore') {
          assert.ok(args.includes('--'), args.join(' '));
        }
      }
      const serialized = JSON.stringify(manifest);
      assert.equal(serialized.includes('argument arrays'), false);
      assert.equal(serialized.includes('full_diff'), false);
      // ASSERTION-CHANGE-JUSTIFIED: ScopeFile intentionally persists the origin field `sources`;
      // raw source payload fields, rather than that required inventory metadata, are forbidden.
      assert.equal(serialized.includes('source_text'), false);
    });
  });
});
