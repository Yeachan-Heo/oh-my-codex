import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tryReadGitBranchActivityMsFromFiles,
  tryReadGitValueFromFiles,
} from '../git-filesystem.js';

async function withTempDir(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('tryReadGitValueFromFiles', () => {
  it('returns null on non-Windows platforms', async () => {
    if (process.platform === 'win32') return;
    await withTempDir('omx-git-fs-nonwin-', async (cwd) => {
      assert.equal(tryReadGitValueFromFiles(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), null);
    });
  });

  it('reads common git queries from a .git directory', async () => {
    if (process.platform !== 'win32') return;

    await withTempDir('omx-git-fs-dir-', async (cwd) => {
      const gitDir = join(cwd, '.git');
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(
        join(gitDir, 'config'),
        ['[remote "origin"]', '\turl = origin-repo-url', ''].join('\n'),
      );

      assert.equal(tryReadGitValueFromFiles(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
      assert.equal(tryReadGitValueFromFiles(cwd, ['remote', 'get-url', 'origin']), 'origin-repo-url');
      assert.equal(tryReadGitValueFromFiles(cwd, ['remote']), 'origin');
      assert.equal(tryReadGitValueFromFiles(cwd, ['rev-parse', '--show-toplevel']), cwd);
    });
  });

  it('supports worktree gitdir pointers and detached HEADs', async () => {
    if (process.platform !== 'win32') return;

    await withTempDir('omx-git-fs-worktree-', async (cwd) => {
      const mainGitDir = join(cwd, 'main-repo', '.git');
      const worktreeRoot = join(cwd, 'worktree');
      const worktreeGitDir = join(mainGitDir, 'worktrees', 'feature-x');

      await mkdir(mainGitDir, { recursive: true });
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(worktreeRoot, { recursive: true });
      await writeFile(join(worktreeRoot, '.git'), `gitdir: ${worktreeGitDir}\n`);
      await writeFile(join(worktreeGitDir, 'commondir'), '../..\n');
      await writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature/x\n');
      await writeFile(
        join(mainGitDir, 'config'),
        [
          '[remote "origin"]',
          '\turl = origin-remote-url',
          '[remote "upstream"]',
          '\turl = upstream-remote-url',
          '',
        ].join('\n'),
      );

      assert.equal(tryReadGitValueFromFiles(worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/x');
      assert.equal(tryReadGitValueFromFiles(worktreeRoot, ['remote', 'get-url', 'upstream']), 'upstream-remote-url');
      assert.equal(tryReadGitValueFromFiles(worktreeRoot, ['remote']), 'origin\nupstream');

      await writeFile(join(worktreeGitDir, 'HEAD'), 'deadbeef\n');
      assert.equal(tryReadGitValueFromFiles(worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
    });
  });
});

describe('tryReadGitBranchActivityMsFromFiles', () => {
  it('returns NaN on non-Windows platforms', async () => {
    if (process.platform === 'win32') return;
    await withTempDir('omx-git-fs-activity-nonwin-', async (cwd) => {
      assert.equal(Number.isNaN(tryReadGitBranchActivityMsFromFiles(cwd)), true);
    });
  });

  it('derives branch activity from reflogs and refs', async () => {
    if (process.platform !== 'win32') return;

    await withTempDir('omx-git-fs-activity-', async (cwd) => {
      const gitDir = join(cwd, '.git');
      await mkdir(join(gitDir, 'logs', 'refs', 'heads'), { recursive: true });
      await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true });
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(
        join(gitDir, 'logs', 'HEAD'),
        '0000000 1111111 Test <t@example.com> 1712000000 +0000\tcommit: init\n',
      );
      await writeFile(
        join(gitDir, 'logs', 'refs', 'heads', 'main'),
        '1111111 2222222 Test <t@example.com> 1712001111 +0000\tcommit: next\n',
      );
      await writeFile(join(gitDir, 'refs', 'heads', 'main'), '2222222\n');

      assert.equal(tryReadGitBranchActivityMsFromFiles(cwd), 1712001111000);
    });
  });
});
