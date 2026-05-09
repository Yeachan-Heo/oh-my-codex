import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isInstallVersionBump,
  isNewerVersion,
  maybeCheckAndPromptUpdate,
  readUserInstallStamp,
  resolveInstalledCliEntry,
  runDeferredGlobalUpdate,
  runImmediateUpdate,
  shouldCheckForUpdates,
  spawnInstalledSetupRefresh,
  writeUserInstallStamp,
} from '../update.js';

const PACKAGE_NAME = 'oh-my-codex';

describe('isNewerVersion', () => {
  it('returns true when latest has higher major', () => {
    assert.equal(isNewerVersion('1.0.0', '2.0.0'), true);
  });

  it('returns true when latest has higher minor', () => {
    assert.equal(isNewerVersion('1.0.0', '1.1.0'), true);
  });

  it('returns true when latest has higher patch', () => {
    assert.equal(isNewerVersion('1.0.0', '1.0.1'), true);
  });

  it('returns false when versions are equal', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
  });

  it('returns false when current is ahead', () => {
    assert.equal(isNewerVersion('2.0.0', '1.9.9'), false);
  });

  it('returns false for invalid current version', () => {
    assert.equal(isNewerVersion('invalid', '1.0.0'), false);
  });

  it('returns false for invalid latest version', () => {
    assert.equal(isNewerVersion('1.0.0', 'invalid'), false);
  });

  it('handles v-prefixed versions', () => {
    assert.equal(isNewerVersion('v1.0.0', 'v1.0.1'), true);
  });

  it('returns false when major is lower even if minor/patch higher', () => {
    assert.equal(isNewerVersion('2.5.5', '1.9.9'), false);
  });
});

describe('shouldCheckForUpdates', () => {
  const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

  it('returns true when state is null', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), null), true);
  });

  it('returns true when last_checked_at is missing', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), {} as never), true);
  });

  it('returns true when last_checked_at is invalid', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), { last_checked_at: 'not-a-date' }), true);
  });

  it('returns false when checked within interval', () => {
    const now = Date.now();
    const recentCheck = new Date(now - INTERVAL_MS + 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: recentCheck }), false);
  });

  it('returns true when check is overdue', () => {
    const now = Date.now();
    const oldCheck = new Date(now - INTERVAL_MS - 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: oldCheck }), true);
  });

  it('returns true when exactly at interval boundary', () => {
    const now = Date.now();
    const exactCheck = new Date(now - INTERVAL_MS).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: exactCheck }), true);
  });

  it('respects custom interval', () => {
    const now = Date.now();
    const customInterval = 60 * 1000;
    const recentCheck = new Date(now - 30 * 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: recentCheck }, customInterval), false);
  });
});

describe('install stamp helpers', () => {
  it('treats missing prior stamp as a version bump', () => {
    assert.equal(isInstallVersionBump('0.14.0', null), true);
  });

  it('treats matching installed_version as not a bump', () => {
    assert.equal(
      isInstallVersionBump('0.14.0', {
        installed_version: '0.14.0',
        setup_completed_version: '0.14.0',
        updated_at: '2026-04-20T00:00:00.000Z',
      }),
      false,
    );
  });

  it('writes and reads the user-scope install stamp schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-install-stamp-'));
    const stampPath = join(root, '.codex', '.omx', 'install-state.json');

    try {
      await writeUserInstallStamp(
        {
          installed_version: '0.14.0',
          setup_completed_version: '0.14.0',
          updated_at: '2026-04-20T00:00:00.000Z',
        },
        stampPath,
      );

      const parsed = await readUserInstallStamp(stampPath);
      assert.deepEqual(parsed, {
        installed_version: '0.14.0',
        setup_completed_version: '0.14.0',
        updated_at: '2026-04-20T00:00:00.000Z',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('maybeCheckAndPromptUpdate', () => {
  async function withInteractiveTty(run: () => Promise<void>): Promise<void> {
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      await run();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalStdinTty,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalStdoutTty,
      });
    }
  }

  it('schedules a deferred update after a successful startup prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalLog = console.log;
    const logs: string[] = [];
    let inlineUpdateCalls = 0;
    let setupRefreshCalls = 0;
    const deferredCwds: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.9.0',
          askYesNo: async (question) => {
            assert.match(question, /Update after this session exits/);
            return true;
          },
          runGlobalUpdate: () => {
            inlineUpdateCalls += 1;
            return { ok: true, stderr: '' };
          },
          runDeferredGlobalUpdate: (deferredCwd) => {
            deferredCwds.push(deferredCwd);
            return { ok: true, stderr: '', logPath: join(deferredCwd, '.omx', 'logs', 'update-test.log') };
          },
          runSetupRefresh: async () => {
            setupRefreshCalls += 1;
            return { ok: true, stderr: '' };
          },
        });
      });

      assert.equal(inlineUpdateCalls, 0);
      assert.equal(setupRefreshCalls, 0);
      assert.deepEqual(deferredCwds, [cwd]);
      assert.match(logs.join('\n'), /Update scheduled after this session exits/);
      assert.match(logs.join('\n'), /Log: .*update-test\.log/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps startup update deferred so local setup is not refreshed inline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalLog = console.log;
    const receivedCwds: string[] = [];
    console.log = () => undefined;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.13.0',
          fetchLatestVersion: async () => '0.13.1',
          askYesNo: async () => true,
          runDeferredGlobalUpdate: (deferredCwd) => {
            receivedCwds.push(deferredCwd);
            return { ok: true, stderr: '', logPath: join(deferredCwd, '.omx', 'logs', 'update-test.log') };
          },
          runSetupRefresh: async () => {
            throw new Error('startup setup refresh should be handled by the deferred updater');
          },
        });
      });

      assert.deepEqual(receivedCwds, [cwd]);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not update or refresh setup when the prompt is declined', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    let updateAttempts = 0;
    let setupRefreshCalls = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.9.0',
          askYesNo: async () => false,
          runGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '' };
          },
          runSetupRefresh: async () => {
            setupRefreshCalls += 1;
            return { ok: true, stderr: '' };
          },
        });
      });

      assert.equal(updateAttempts, 0);
      assert.equal(setupRefreshCalls, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports scheduler diagnostics when startup deferral cannot be launched', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalLog = console.log;
    const logs: string[] = [];
    let setupRefreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.9.0',
          askYesNo: async () => true,
          runDeferredGlobalUpdate: () => ({ ok: false, stderr: 'powershell not found', logPath: join(cwd, '.omx', 'logs', 'update-test.log') }),
          runSetupRefresh: async () => {
            setupRefreshCalls += 1;
            return { ok: true, stderr: '' };
          },
        });
      });

      assert.equal(setupRefreshCalls, 0);
      assert.match(logs.join('\n'), /Failed to schedule the deferred update/);
      assert.match(logs.join('\n'), /powershell not found/);
      assert.match(logs.join('\n'), /update-test\.log/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips the update flow when the fetched version is not newer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    let promptCalls = 0;
    let updateAttempts = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.8.9',
          askYesNo: async () => {
            promptCalls += 1;
            return true;
          },
          runGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '' };
          },
          runSetupRefresh: async () => {
            throw new Error('setup refresh should not run when already up to date');
          },
        });
      });

      assert.equal(promptCalls, 0);
      assert.equal(updateAttempts, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('respects the passive launch-time cadence before checking npm', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const statePath = join(cwd, '.omx', 'state', 'update-check.json');
    let latestCalls = 0;

    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(statePath, JSON.stringify({
        last_checked_at: new Date().toISOString(),
        last_seen_latest: '9.9.9',
      }, null, 2));

      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          fetchLatestVersion: async () => {
            latestCalls += 1;
            return '9.9.9';
          },
          getCurrentVersion: async () => '0.14.0',
        });
      });

      assert.equal(latestCalls, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('runImmediateUpdate', () => {
  it('bypasses the passive cadence and updates immediately on explicit request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const statePath = join(cwd, '.omx', 'state', 'update-check.json');
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    let setupCalls = 0;
    const refreshCwds: string[] = [];
    let updateCalls = 0;
    let latestCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    process.env.CODEX_HOME = join(cwd, '.codex');

    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(statePath, JSON.stringify({
        last_checked_at: new Date().toISOString(),
        last_seen_latest: '0.14.1',
      }, null, 2));

      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => {
          latestCalls += 1;
          return '0.14.1';
        },
        runGlobalUpdate: () => {
          updateCalls += 1;
          return { ok: true, stderr: '' };
        },
        runSetupRefresh: async (refreshCwd) => {
          setupCalls += 1;
          refreshCwds.push(refreshCwd);
          return { ok: true, stderr: '' };
        },
      });

      assert.equal(result.status, 'updated');
      assert.equal(latestCalls, 1);
      assert.equal(updateCalls, 1);
      assert.equal(setupCalls, 1);
      assert.deepEqual(refreshCwds, [cwd]);
      assert.match(logs.join('\n'), /Running: npm install -g oh-my-codex@latest/);
      assert.match(logs.join('\n'), /Updated to v0\.14\.1/);

      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
      };
      assert.equal(stamp.installed_version, '0.14.1');
      assert.equal(stamp.setup_completed_version, '0.14.1');
    } finally {
      console.log = originalLog;
      if (typeof originalCodexHome === 'string') {
        process.env.CODEX_HOME = originalCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports up-to-date status for explicit update when npm is already current', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    let updateCalls = 0;
    let refreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    process.env.CODEX_HOME = join(cwd, '.codex');

    try {
      await writeUserInstallStamp(
        {
          installed_version: '0.14.0',
          setup_completed_version: '0.14.0',
          updated_at: '2026-04-20T00:00:00.000Z',
        },
        stampPath,
      );

      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => '0.14.0',
        runGlobalUpdate: () => {
          updateCalls += 1;
          return { ok: true, stderr: '' };
        },
        runSetupRefresh: async () => {
          refreshCalls += 1;
          return { ok: true, stderr: '' };
        },
      });

      assert.equal(result.status, 'up-to-date');
      assert.equal(updateCalls, 0);
      assert.equal(refreshCalls, 0);
      assert.match(logs.join('\n'), /already up to date \(v0\.14\.0\)/);
    } finally {
      console.log = originalLog;
      if (typeof originalCodexHome === 'string') {
        process.env.CODEX_HOME = originalCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs setup refresh for explicit update when current version matches but setup stamp is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    let refreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    process.env.CODEX_HOME = join(cwd, '.codex');

    try {
      await writeUserInstallStamp(
        {
          installed_version: '0.14.0',
          setup_completed_version: '0.13.9',
          updated_at: '2026-04-20T00:00:00.000Z',
        },
        stampPath,
      );

      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => '0.14.0',
        runGlobalUpdate: () => {
          throw new Error('global update should not run when already current');
        },
        runSetupRefresh: async () => {
          refreshCalls += 1;
          return { ok: true, stderr: '' };
        },
      });

      assert.equal(result.status, 'up-to-date');
      assert.equal(refreshCalls, 1);
      assert.match(logs.join('\n'), /Running setup refresh/);
      assert.match(logs.join('\n'), /Setup refresh completed for v0\.14\.0/);

      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
      };
      assert.equal(stamp.installed_version, '0.14.0');
      assert.equal(stamp.setup_completed_version, '0.14.0');
    } finally {
      console.log = originalLog;
      if (typeof originalCodexHome === 'string') {
        process.env.CODEX_HOME = originalCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('continues explicit update when update-check state cannot be written', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const originalLog = console.log;
    const logs: string[] = [];
    let updateCalls = 0;
    let refreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => '0.14.1',
        writeUpdateState: async () => {
          throw new Error('EACCES');
        },
        runGlobalUpdate: () => {
          updateCalls += 1;
          return { ok: true, stderr: '' };
        },
        runSetupRefresh: async () => {
          refreshCalls += 1;
          return { ok: true, stderr: '' };
        },
      });

      assert.equal(result.status, 'updated');
      assert.equal(updateCalls, 1);
      assert.equal(refreshCalls, 1);
      assert.match(logs.join('\n'), /Updated to v0\.14\.1/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails without writing the success stamp when the fresh setup handoff fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    let refreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    process.env.CODEX_HOME = join(cwd, '.codex');

    try {
      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => '0.14.1',
        runGlobalUpdate: () => ({ ok: true, stderr: '' }),
        runSetupRefresh: async () => {
          refreshCalls += 1;
          return { ok: false, stderr: 'updated setup exited 17' };
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal(refreshCalls, 1);
      assert.match(logs.join('\n'), /Update installed, but the setup refresh failed/);
      await assert.rejects(readFile(stampPath, 'utf-8'));
    } finally {
      console.log = originalLog;
      if (typeof originalCodexHome === 'string') {
        process.env.CODEX_HOME = originalCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('runImmediateUpdate failure diagnostics', () => {
  it('reports npm stderr when explicit update fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const originalLog = console.log;
    const logs: string[] = [];
    let refreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => '0.14.1',
        runGlobalUpdate: () => ({ ok: false, stderr: 'EPERM: file is locked\nmore detail' }),
        runSetupRefresh: async () => {
          refreshCalls += 1;
          return { ok: true, stderr: '' };
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal(refreshCalls, 0);
      assert.match(logs.join('\n'), /Update failed while running npm install -g oh-my-codex@latest/);
      assert.match(logs.join('\n'), /npm stderr: EPERM: file is locked/);
      assert.match(logs.join('\n'), /npm install -g oh-my-codex@latest && omx setup/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('runDeferredGlobalUpdate', () => {
  it('launches a detached Windows PowerShell updater that waits for the parent and runs setup after npm', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deferred-update-'));
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const listeners: string[] = [];

    try {
      const result = runDeferredGlobalUpdate(
        cwd,
        ((command, args, options) => {
          calls.push({ command, args: args as string[], options: (options ?? {}) as Record<string, unknown> });
          return {
            once(event: string) {
              listeners.push(event);
              return this;
            },
            unref() {},
          } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn,
        'win32',
        12345,
      );

      assert.equal(result.ok, true);
      assert.match(result.logPath ?? '', /\.omx[\\/]logs[\\/]update-/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'powershell.exe');
      assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
      assert.deepEqual(listeners, ['error']);
      assert.equal(calls[0].options.detached, true);
      assert.equal(calls[0].options.stdio, 'ignore');
      assert.equal(calls[0].options.windowsHide, true);
      assert.equal(calls[0].options.cwd, cwd);
      assert.equal((calls[0].options.env as NodeJS.ProcessEnv | undefined)?.OMX_DEFERRED_UPDATE_PARENT_PID, '12345');
      assert.equal((calls[0].options.env as NodeJS.ProcessEnv | undefined)?.OMX_DEFERRED_UPDATE_LOG, result.logPath);
      assert.match(calls[0].args[4], /Get-Process -Id \$parentPid/);
      assert.match(calls[0].args[4], /npm install -g oh-my-codex@latest/);
      assert.match(calls[0].args[4], /omx setup/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('post-update setup refresh handoff', () => {
  it('uses the installed package bin entry when resolving the refreshed CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-bin-contract-'));
    const globalRoot = join(cwd, 'global-root');
    const packageRoot = join(globalRoot, PACKAGE_NAME);
    const cliRelativePath = join('dist', 'custom', 'omx-entry.js');
    const cliEntry = join(packageRoot, cliRelativePath);

    try {
      await mkdir(dirname(cliEntry), { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: PACKAGE_NAME, version: '0.14.1', bin: { omx: cliRelativePath } }, null, 2),
      );
      await writeFile(cliEntry, '#!/usr/bin/env node\n');

      assert.equal(await resolveInstalledCliEntry(globalRoot), cliEntry);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to the current published CLI layout when package metadata is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-bin-fallback-'));
    const globalRoot = join(cwd, 'global-root');
    const cliEntry = join(globalRoot, PACKAGE_NAME, 'dist', 'cli', 'omx.js');

    try {
      await mkdir(dirname(cliEntry), { recursive: true });
      await writeFile(cliEntry, '#!/usr/bin/env node\n');

      assert.equal(await resolveInstalledCliEntry(globalRoot), cliEntry);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns null when neither package bin nor fallback CLI entry exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-bin-missing-'));

    try {
      assert.equal(await resolveInstalledCliEntry(join(cwd, 'global-root')), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not impose a timeout on the interactive setup refresh handoff', () => {
    let receivedTimeout: unknown = Symbol('unset');
    const result = spawnInstalledSetupRefresh(
      '/tmp/omx.js',
      '/tmp/project',
      ((_command, _args, options) => {
        receivedTimeout = options?.timeout;
        return { status: 0, error: undefined };
      }) as typeof import('node:child_process').spawnSync,
    );

    assert.equal(result.ok, true);
    assert.equal(receivedTimeout, undefined);
  });
});
