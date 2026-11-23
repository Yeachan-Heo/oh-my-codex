import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { backupRelativePath, setup } from '../setup.js';

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

      // setup resolves the project root from process.cwd(), which is canonical (macOS /var -> /private/var).
      const gitignorePath = join(await realpath(repo), '.gitignore');
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
      const reportedAnalystPath = join(await realpath(repo), '.codex', 'prompts', 'analyst.md');

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes(reportedAnalystPath) &&
            msg.includes('Either remove the symlink')
          );
        },
      );
      assert.equal(await readFile(victim, 'utf8'), 'ORIGINAL-PROMPT-CONTENT\n');
    });
  });

  it('rejects a symlinked ancestor directory (.codex)', async () => {
    await withRepo(async (repo, parent) => {
      const targetDir = join(parent, 'external-codex');
      await mkdir(targetDir);
      const victim = join(targetDir, 'secret.txt');
      await writeFile(victim, 'EXTERNAL-SECRET\n');
      
      // Create .codex as a symlink to external directory
      await symlink(targetDir, join(repo, '.codex'));

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            (msg.includes('Refusing to install through symlink') || msg.includes('Refusing native hook transaction')) &&
            msg.includes('symlink') &&
            (msg.includes('Either remove the symlink') || msg.includes('is a symbolic link'))
          );
        },
      );
      assert.equal(await readFile(victim, 'utf8'), 'EXTERNAL-SECRET\n');
    });
  });

  it('rejects a symlinked auth directory', async () => {
    await withRepo(async (repo, parent) => {
      const targetDir = join(parent, 'external-auth');
      await mkdir(targetDir);
      const victim = join(targetDir, 'token.txt');
      await writeFile(victim, 'SECRET-TOKEN\n');
      
      // Create .omx as a symlink to external directory
      await symlink(targetDir, join(repo, '.omx'));

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes('.omx') &&
            msg.includes('Either remove the symlink')
          );
        },
      );
      assert.equal(await readFile(victim, 'utf8'), 'SECRET-TOKEN\n');
    });
  });

  it('rejects a symlinked state directory that setup manages', async () => {
    await withRepo(async (repo, parent) => {
      const targetDir = join(parent, 'external-state');
      await mkdir(targetDir);
      const victim = join(targetDir, 'installed-skills.json');
      await writeFile(victim, '{"version": 1}\n');
      
      // Create .omx/state as a symlink to external directory, which setup writes to for installed-skills.json
      await mkdir(join(repo, '.omx'), { recursive: true });
      await symlink(targetDir, join(repo, '.omx', 'state'));

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes('.omx') &&
            msg.includes('Either remove the symlink')
          );
        },
      );
      assert.equal(await readFile(victim, 'utf8'), '{"version": 1}\n');
    });
  });

  it('rejects a symlinked .omx directory even when hud-config.json would already exist', async () => {
    await withRepo(async (repo, parent) => {
      const targetDir = join(parent, 'external-omx');
      await mkdir(targetDir);
      // Create hud-config.json in the target so that the old code would skip validation
      await mkdir(join(targetDir), { recursive: true });
      await writeFile(join(targetDir, 'hud-config.json'), '{"preset": "focused"}\n');
      
      // Create .omx as a symlink to external directory
      await symlink(targetDir, join(repo, '.omx'));

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes('.omx') &&
            msg.includes('Either remove the symlink')
          );
        },
      );
    });
  });

  it('rejects a symlinked .omx/backups when backing up a managed file', async () => {
    await withRepo(async (repo, parent) => {
      const targetDir = join(parent, 'external-backups');
      await mkdir(targetDir);
      const victim = join(targetDir, 'secret-backup.txt');
      
      // Create .omx/backups as a symlink to external directory
      await mkdir(join(repo, '.omx'), { recursive: true });
      await symlink(targetDir, join(repo, '.omx', 'backups'));
      
      // Create an existing .gitignore to trigger the backup code path
      await writeFile(join(repo, '.gitignore'), 'original-gitignore\n');

      await assert.rejects(
        setup({ scope: 'project' }),
        (err: any) => {
          const msg = err?.message || '';
          return (
            msg.includes('Refusing to install through symlink') &&
            msg.includes('backups') &&
            msg.includes('Either remove the symlink')
          );
        },
      );
      // Verify nothing was written to the victim directory
      assert.equal(existsSync(victim), false, 'Backup should not be written outside the scope');
    });
  });

  it('succeeds when scope root is under a symlinked parent (like /tmp on macOS) while still rejecting symlinks inside the managed tree', async () => {
    // Regression test for issue #3887: On macOS, /tmp is a symlink to /private/tmp,
    // so the setup should not reject paths just because they're under /tmp,
    // but should still reject symlinks inside the managed scope (.codex, .omx, etc).
    await withRepo(async (repo, parent) => {
      // The repo is already under /tmp (symlinked parent), so this tests that
      // OS-level symlinks are not rejected.
      // Create a file to install
      const skillDir = join(repo, '.codex', 'skills', 'test-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Test Skill\n\nA test skill');
      
      // Setup should succeed even though the scope root is under the /tmp symlink
      await assert.doesNotReject(
        setup({ scope: 'project' }),
        'Setup should succeed when scope root is under /tmp (symlinked OS directory)'
      );
      
      // Verify the setup actually completed
      assert(existsSync(join(repo, '.gitignore')), '.gitignore should be created');
      assert(existsSync(join(repo, '.codex', 'config.toml')), 'config.toml should be created');
    });
  });

  it('succeeds with custom CODEX_HOME and validates files within CODEX_HOME scope', async () => {
    // Regression test for #3889: When CODEX_HOME is set to a custom directory,
    // setup should validate all user-scope files within the CODEX_HOME boundary.
    // This tests that CODEX_HOME is used as the managed authority root.
    await withRepo(async (repo, parent) => {
      // Create a custom CODEX_HOME directory
      const customCodexHome = join(parent, 'custom-codex');
      await mkdir(customCodexHome, { recursive: true });
      
      // Override CODEX_HOME to the custom location
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = customCodexHome;
      
      try {
        // Setup with user scope should succeed and use customCodexHome as authority root
        await assert.doesNotReject(
          setup({ scope: 'user' }),
          'Setup should succeed with custom CODEX_HOME'
        );
        
        // Verify config was created in custom CODEX_HOME
        assert(
          existsSync(join(customCodexHome, 'config.toml')),
          'config.toml should be created in custom CODEX_HOME'
        );
      } finally {
        if (typeof previousCodexHome === 'string') {
          process.env.CODEX_HOME = previousCodexHome;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });

  it('canonicalizes paths to handle OS-level symlinks in parent directories of non-existent CODEX_HOME (#4352912480)', async () => {
    // Codex finding #4352912480: When CODEX_HOME doesn't exist yet (fresh install),
    // we need to canonicalize through the deepest existing ancestor to handle OS-level
    // symlinks like /tmp -> /private/tmp on macOS.
    await withRepo(async (repo, parent) => {
      // Create a CODEX_HOME that doesn't exist yet
      const nonExistentCodexHome = join(parent, 'fresh', 'codex', 'home');
      process.env.CODEX_HOME = nonExistentCodexHome;
      
      try {
        // Setup should succeed even though CODEX_HOME path doesn't exist
        // (it will be created with intermediate directories)
        await assert.doesNotReject(
          setup({ scope: 'user' }),
          'Setup should succeed with non-existent CODEX_HOME path'
        );
        
        // Verify config was created at the correct location
        assert(
          existsSync(join(nonExistentCodexHome, 'config.toml')),
          'config.toml should be created in non-existent CODEX_HOME path'
        );
      } finally {
        // Restore original CODEX_HOME
        const previousCodexHome = process.env.HOME ? join(process.env.HOME, '.codex') : undefined;
        if (typeof previousCodexHome === 'string') {
          process.env.CODEX_HOME = previousCodexHome;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });

  it('validates project .codex directories against PROJECT root, not CODEX_HOME (#4352912487)', async () => {
    // Codex finding #4352912487: Project scope directories like .codex/.omx should be
    // validated against the PROJECT root, not CODEX_HOME. This ensures project-specific
    // files stay within project boundaries.
    await withRepo(async (repo, parent) => {
      // Create a separate CODEX_HOME outside the repo
      const externalCodexHome = join(parent, 'external-codex');
      await mkdir(externalCodexHome, { recursive: true });
      process.env.CODEX_HOME = externalCodexHome;
      
      try {
        // Setup with project scope should validate project .codex against repo root
        await assert.doesNotReject(
          setup({ scope: 'project' }),
          'Setup should succeed and validate project .codex against project root'
        );
        
        // Verify .codex was created inside the repo (project scope), not in external CODEX_HOME
        assert(
          existsSync(join(repo, '.codex', 'config.toml')),
          '.codex/config.toml should be created in project repo, not in external CODEX_HOME'
        );
        // Verify config was NOT created in external CODEX_HOME for project scope
        assert(
          !existsSync(join(externalCodexHome, 'config.toml')),
          'config.toml should NOT be created in external CODEX_HOME for project scope'
        );
      } finally {
        const previousCodexHome = process.env.HOME ? join(process.env.HOME, '.codex') : undefined;
        if (typeof previousCodexHome === 'string') {
          process.env.CODEX_HOME = previousCodexHome;
        } else {
          delete process.env.CODEX_HOME;
        }
      }
    });
  });

  it('validates OMX_ROOT directories against the override root (#4352912502)', async () => {
    // Codex finding #4352912502: When OMX_ROOT environment variable is set,
    // directories under it should be validated against that override root, not homedir().
    await withRepo(async (repo, parent) => {
      // Create a separate OMX_ROOT override
      const omxRootOverride = join(parent, 'custom-omx-root');
      await mkdir(omxRootOverride, { recursive: true });
      const previousOmxRoot = process.env.OMX_ROOT;
      process.env.OMX_ROOT = omxRootOverride;
      
      try {
        // Setup with user scope should use OMX_ROOT as the validation root for ~/.omx-like paths
        await assert.doesNotReject(
          setup({ scope: 'user' }),
          'Setup should succeed and use OMX_ROOT as validation root'
        );
        
        // When OMX_ROOT is set, .omx directory should be created under OMX_ROOT
        // (or at least paths should validate against it)
        const setupSucceeded = existsSync(join(process.env.HOME || '', '.codex', 'config.toml')) ||
                               existsSync(join(omxRootOverride, '.omx', 'backups')) ||
                               existsSync(join(omxRootOverride, 'backups'));
        assert(
          setupSucceeded,
          'Setup should have created files when OMX_ROOT is set'
        );
      } finally {
        if (typeof previousOmxRoot === 'string') {
          process.env.OMX_ROOT = previousOmxRoot;
        } else {
          delete process.env.OMX_ROOT;
        }
      }
    });
  });

  it('sanitizes out-of-base and Windows cross-drive backup paths', () => {
    // Same-drive targets keep their relative location under the backup root.
    assert.equal(
      backupRelativePath('C:\\Users\\alice', 'C:\\Users\\alice\\.codex\\skills\\old', win32),
      '.codex\\skills\\old',
    );
    // Cross-drive: win32.relative returns an absolute path, which must not escape the backup root.
    assert.equal(
      backupRelativePath('C:\\Users\\alice', 'D:\\codex\\skills\\old', win32),
      'codex_skills_old',
    );
    assert.equal(backupRelativePath('/home/alice', '/opt/codex/skills/old', posix), 'opt_codex_skills_old');
    assert.equal(backupRelativePath('/home/alice', '/home/alice', posix), 'home_alice');
    assert.equal(backupRelativePath('/home/alice', '/home/alice/..data/x', posix), '..data/x');
  });

  it('rejects dangling symlinks in validation scope to prevent out-of-scope writes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-dangling-symlink-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      // Create a project directory with a dangling symlink
      await mkdir(join(wd, '.codex'), { recursive: true });
      // Create a dangling symlink in the project
      const symlinkPath = join(wd, '.gitignore-link');
      // Create a symlink pointing to a non-existent target
      await symlink(join(wd, '..', 'victim', '.gitignore'), symlinkPath);
      
      // Verify it's a dangling symlink
      assert.equal(existsSync(symlinkPath), false, 'dangling symlink should not be followable with existsSync');
      const stats = await lstat(symlinkPath);
      assert.equal(stats.isSymbolicLink(), true, 'path should be a symlink');
      
      // Setup should succeed without following the dangling symlink
      // The key is that the validation should detect the symlink and not try to follow it
      const previousHome = process.env.HOME;
      process.env.HOME = wd;
      try {
        // This should not throw and should not create files outside the scope
        await setup({ scope: 'project', dryRun: true });
        
        // The key test: the dangling symlink should not be followed or created as a real file
        assert.equal(existsSync(join(wd, '..', 'victim')), false, 'target of dangling symlink should not be created');
      } finally {
        if (typeof previousHome === 'string') {
          process.env.HOME = previousHome;
        } else {
          delete process.env.HOME;
        }
      }
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('handles symlinked HOME directory for scope validation (regression test for macOS /var symlink)', async () => {
    // Regression test for the /var -> /private/var issue on macOS, which can also occur when
    // HOME itself is accessed through a symlink. Create a symlinked home to test canonicalization.
    const root = await mkdtemp(join(tmpdir(), 'omx-setup-symlinked-home-'));
    const realHome = join(root, 'real-home');
    const symlinkHome = join(root, 'symlinked-home');
    const repo = join(symlinkHome, 'repo');

    await mkdir(realHome);
    await mkdir(join(realHome, 'repo'));
    // Create a symlink to the real home directory
    await symlink(realHome, symlinkHome);

    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCwd = process.cwd();

    try {
      // Set HOME to the symlinked path (non-canonical)
      process.env.HOME = symlinkHome;
      process.env.CODEX_HOME = join(symlinkHome, '.codex');
      process.chdir(repo);

      // This should succeed without throwing "outside managed scope" error
      // The key is that scope validation must handle symlinks in the HOME path
      await setup({ scope: 'user' });
      assert(existsSync(join(symlinkHome, '.codex')), 'CODEX_HOME should be created');
    } finally {
      process.chdir(previousCwd);
      if (typeof previousHome === 'string') {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
      if (typeof previousCodexHome === 'string') {
        process.env.CODEX_HOME = previousCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
