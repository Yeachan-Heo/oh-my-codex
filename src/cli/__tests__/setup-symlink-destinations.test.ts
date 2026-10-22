import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';

function setMockHome(home: string): () => void {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, '.codex');
  return () => {
    if (typeof previousHome === 'string') process.env.HOME = previousHome;
    else delete process.env.HOME;
    if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
    else delete process.env.CODEX_HOME;
  };
}

async function withRepo(run: (repo: string, parent: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'omx-setup-symlink-'));
  const repo = join(parent, 'repo');
  await mkdir(repo);
  const restoreHome = setMockHome(join(parent, 'home'));
  const previousCwd = process.cwd();
  try {
    process.chdir(repo);
    await run(repo, parent);
  } finally {
    process.chdir(previousCwd);
    restoreHome();
    await rm(parent, { recursive: true, force: true });
  }
}

describe('omx setup symlink destinations', () => {
  it('refuses a symlinked project .gitignore and leaves the target untouched', async () => {
    await withRepo(async (repo, parent) => {
      const victim = join(parent, 'victim.txt');
      await writeFile(victim, 'ORIGINAL-SECRET-CONTENT\n');
      await symlink('../victim.txt', join(repo, '.gitignore'));

      const gitignorePath = join(repo, '.gitignore');
      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes(gitignorePath) &&
            msg.includes('Either remove the symlink')
          );
        },
      );
      assert.equal(await readFile(victim, 'utf8'), 'ORIGINAL-SECRET-CONTENT\n');
    });
  });

  it('refuses a symlinked prompt destination and leaves the target untouched', async () => {
    await withRepo(async (repo, parent) => {
      await mkdir(join(repo, '.codex', 'prompts'), { recursive: true });
      const victim = join(parent, 'victim-prompt.txt');
      await writeFile(victim, 'ORIGINAL-PROMPT-CONTENT\n');
      const analystPath = join(repo, '.codex', 'prompts', 'analyst.md');
      await symlink('../../../victim-prompt.txt', analystPath);

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes(analystPath) &&
            msg.includes('Either remove the symlink')
          );
        },
      );
      assert.equal(await readFile(victim, 'utf8'), 'ORIGINAL-PROMPT-CONTENT\n');
    });
  });
});
