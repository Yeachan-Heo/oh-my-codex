import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isInstallVersionBump,
  isNewerVersion,
  maybeCheckAndPromptUpdate,
  readUserInstallStamp,
  resolveAutoUpdateMode,
  resolveInstalledCliEntry,
  formatDeferredSetupCommand,
  resolveSetupRefreshArgs,
  runDeferredGlobalUpdate,
  runGlobalUpdate,
  runImmediateUpdate,
  shouldCheckForUpdates,
  spawnInstalledSetupRefresh,
  writeUserInstallStamp,
} from '../update.js';
import {
  resolveBunGlobalBin,
  resolvePackageManagerOwnership,
  type PackageManagerOwnership,
} from '../package-manager-ownership.js';

const PACKAGE_NAME = 'oh-my-codex';
const frozenNpmOwnership: PackageManagerOwnership = {
  manager: 'npm',
  npmCommand: { kind: 'node-script', command: process.execPath, commandArgs: ['/configured/npm-cli.js'] },
  npmPrefix: '/configured',
  globalInstallRoot: '/configured/node_modules',
  packageRoot: '/configured/node_modules/oh-my-codex',
  environment: { OMX_UPDATE_TEST: '1' },
};

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

describe('resolveAutoUpdateMode', () => {
  it('defaults to prompt mode when the env var is unset', () => {
    const originalMode = process.env.OMX_AUTO_UPDATE;
    delete process.env.OMX_AUTO_UPDATE;

    try {
      assert.equal(resolveAutoUpdateMode(), 'prompt');
      assert.equal(resolveAutoUpdateMode(''), 'prompt');
    } finally {
      if (typeof originalMode === 'string') {
        process.env.OMX_AUTO_UPDATE = originalMode;
      }
    }
  });

  it('supports the explicit legacy disabled value', () => {
    assert.equal(resolveAutoUpdateMode('0'), 'disabled');
  });

  it('supports only defer for no-prompt mode and keeps other truthy values in prompt mode', () => {
    assert.equal(resolveAutoUpdateMode('defer'), 'defer');
    for (const value of ['1', 'true', 'false', 'off', 'no', 'never', 'disabled', 'deferred', 'always', 'auto', 'silent']) {
      assert.equal(resolveAutoUpdateMode(value), 'prompt');
    }
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
    const originalMode = process.env.OMX_AUTO_UPDATE;
    const originalLog = console.log;
    const logs: string[] = [];
    let inlineUpdateCalls = 0;
    let setupRefreshCalls = 0;
    const deferredCwds: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    delete process.env.OMX_AUTO_UPDATE;

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
      if (typeof originalMode === 'string') {
        process.env.OMX_AUTO_UPDATE = originalMode;
      } else {
        delete process.env.OMX_AUTO_UPDATE;
      }
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps startup update deferred so local setup is not refreshed inline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalMode = process.env.OMX_AUTO_UPDATE;
    const originalLog = console.log;
    const receivedCwds: string[] = [];
    console.log = () => undefined;
    delete process.env.OMX_AUTO_UPDATE;

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
      if (typeof originalMode === 'string') {
        process.env.OMX_AUTO_UPDATE = originalMode;
      } else {
        delete process.env.OMX_AUTO_UPDATE;
      }
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('schedules deferred update without a TTY prompt when OMX_AUTO_UPDATE=defer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalMode = process.env.OMX_AUTO_UPDATE;
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;
    const deferredCwds: string[] = [];

    process.env.OMX_AUTO_UPDATE = 'defer';
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });

    try {
      await maybeCheckAndPromptUpdate(cwd, {
        getCurrentVersion: async () => '0.13.0',
        fetchLatestVersion: async () => '0.13.1',
        askYesNo: async () => {
          throw new Error('defer mode must not prompt');
        },
        runDeferredGlobalUpdate: (deferredCwd) => {
          deferredCwds.push(deferredCwd);
          return { ok: true, stderr: '', logPath: join(deferredCwd, '.omx', 'logs', 'update-test.log') };
        },
      });

      assert.deepEqual(deferredCwds, [cwd]);
    } finally {
      if (typeof originalMode === 'string') {
        process.env.OMX_AUTO_UPDATE = originalMode;
      } else {
        delete process.env.OMX_AUTO_UPDATE;
      }
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalStdinTty,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalStdoutTty,
      });
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
    const originalMode = process.env.OMX_AUTO_UPDATE;
    const originalLog = console.log;
    const logs: string[] = [];
    let setupRefreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    delete process.env.OMX_AUTO_UPDATE;

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
      if (typeof originalMode === 'string') {
        process.env.OMX_AUTO_UPDATE = originalMode;
      } else {
        delete process.env.OMX_AUTO_UPDATE;
      }
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

  it('treats a current dev install dev_base_version as the launch update baseline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-dev-baseline-'));
    let promptCalls = 0;
    let updateAttempts = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.18.10',
          fetchLatestVersion: async () => '0.18.11',
          readUserInstallStamp: async () => ({
            installed_version: '0.18.10',
            setup_completed_version: '0.18.10',
            install_channel: 'dev',
            install_source: 'github:Yeachan-Heo/oh-my-codex#dev',
            install_revision: '8214377e3c1d',
            dev_base_version: '0.18.11',
            updated_at: '2026-06-09T20:21:24.070Z',
          }),
          askYesNo: async () => {
            promptCalls += 1;
            return true;
          },
          runDeferredGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '', logPath: join(cwd, '.omx', 'logs', 'update-test.log') };
          },
        });
      });

      assert.equal(promptCalls, 0);
      assert.equal(updateAttempts, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not infer a dev_base_version from launch-time latest alone', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-dev-baseline-missing-'));
    const originalCodexHome = process.env.CODEX_HOME;
    const codexHome = join(cwd, '.codex');
    const stampPath = join(codexHome, '.omx', 'install-state.json');
    let promptCalls = 0;
    let updateAttempts = 0;
    process.env.CODEX_HOME = codexHome;

    try {
      await mkdir(join(codexHome, '.omx'), { recursive: true });
      await writeFile(stampPath, JSON.stringify({
        installed_version: '0.18.10',
        setup_completed_version: '0.18.10',
        install_channel: 'dev',
        install_source: 'github:Yeachan-Heo/oh-my-codex#dev',
        install_revision: '8214377e3c1d',
        updated_at: '2026-06-09T20:21:24.070Z',
      }, null, 2));

      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.18.10',
          fetchLatestVersion: async () => '0.18.11',
          askYesNo: async () => {
            promptCalls += 1;
            return false;
          },
          runDeferredGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '', logPath: join(cwd, '.omx', 'logs', 'update-test.log') };
          },
        });
      });

      const unchangedStamp = JSON.parse(await readFile(stampPath, 'utf-8')) as { dev_base_version?: string };
      assert.equal(promptCalls, 1);
      assert.equal(updateAttempts, 0);
      assert.equal(unchangedStamp.dev_base_version, undefined);
    } finally {
      if (typeof originalCodexHome === 'string') {
        process.env.CODEX_HOME = originalCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the artifact version when it is newer than the stamped dev baseline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-dev-baseline-outrun-'));
    let promptCalls = 0;
    let updateAttempts = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.18.12',
          fetchLatestVersion: async () => '0.18.13',
          readUserInstallStamp: async () => ({
            installed_version: '0.18.12',
            setup_completed_version: '0.18.12',
            install_channel: 'dev',
            install_source: 'github:Yeachan-Heo/oh-my-codex#dev',
            install_revision: '8214377e3c1d',
            dev_base_version: '0.18.11',
            updated_at: '2026-06-09T20:21:24.070Z',
          }),
          askYesNo: async (question) => {
            promptCalls += 1;
            assert.match(question, /v0\.18\.12 → v0\.18\.13/);
            return false;
          },
          runDeferredGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '', logPath: join(cwd, '.omx', 'logs', 'update-test.log') };
          },
        });
      });

      assert.equal(promptCalls, 1);
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

describe('frozen package-manager update ownership', () => {
  function okResult(stdout = '') {
    return { status: 0, signal: null, error: undefined, stdout, stderr: '', output: [null, stdout, ''], pid: 0 };
  }

  it('rejects legacy unowned update calls without selecting an ambient manager', () => {
    const calls: string[] = [];
    const result = runGlobalUpdate(((command: string) => {
      calls.push(command);
      return okResult();
    }) as unknown as typeof import('node:child_process').spawnSync);

    assert.equal(result.ok, false);
    assert.match(result.stderr, /validated package-manager ownership/);
    assert.deepEqual(calls, []);
  });

  it('requires ownership when the native updater remains selected beside an explicit setup seam', async () => {
    const result = await runImmediateUpdate('/tmp/omx-unowned-update', {
      getCurrentVersion: async () => '0.14.0',
      fetchLatestVersion: async () => '0.14.1',
      resolvePackageManagerOwnership: async () => null,
      runSetupRefresh: async () => ({ ok: true, stderr: '' }),
    });

    assert.equal(result.status, 'failed');
  });

  it('uses only the selected frozen npm command for dev packaging and installation', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const owner: PackageManagerOwnership = {
      ...frozenNpmOwnership,
      npmCommand: { kind: 'node-script', command: '/configured/node', commandArgs: ['/configured/npm-cli.js'] },
    };
    const result = runGlobalUpdate('github:Yeachan-Heo/oh-my-codex#dev', ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return command === 'git' ? { ...okResult(), stdout: args[0] === 'rev-parse' ? '1234567890abcdef\n' : '' } : okResult();
    }) as typeof import('node:child_process').spawnSync, 'win32', owner);

    assert.equal(result.ok, false);
    assert.match(result.stderr, /npm pack did not produce/);
    assert.deepEqual(calls.map((call) => call.command), [
      'git', 'git', '/configured/node', '/configured/node', '/configured/node',
    ]);
    for (const call of calls.slice(2)) {
      assert.deepEqual(call.args.slice(0, 1), ['/configured/npm-cli.js']);
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
    const installSources: string[] = [];
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
        runGlobalUpdate: (installSource) => {
          updateCalls += 1;
          installSources.push(installSource);
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
      assert.deepEqual(installSources, [`${PACKAGE_NAME}@latest`]);
      assert.equal(setupCalls, 1);
      assert.deepEqual(refreshCwds, [cwd]);
      assert.match(logs.join('\n'), /Selected update channel: stable/);
      assert.match(logs.join('\n'), /Install source: oh-my-codex@latest/);
      assert.match(logs.join('\n'), /Running: npm install -g oh-my-codex@latest/);
      assert.match(logs.join('\n'), /Updated stable channel to v0\.14\.1/);

      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
        install_channel: string;
        install_source: string;
        install_revision: string;
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

  it('force-installs stable for explicit update even when npm is already current', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    const installSources: string[] = [];
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
        runGlobalUpdate: (installSource) => {
          updateCalls += 1;
          installSources.push(installSource);
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
      assert.deepEqual(installSources, [`${PACKAGE_NAME}@latest`]);
      assert.match(logs.join('\n'), /Selected update channel: stable/);
      assert.match(logs.join('\n'), /Running: npm install -g oh-my-codex@latest/);
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

  it('uses stable as a rollback path while preserving persisted setup preferences', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    const installSources: string[] = [];
    const setupArgs = resolveSetupRefreshArgs;
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
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'user', installMode: 'plugin', mcpMode: 'none', teamMode: 'disabled' }, null, 2),
      );

      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => '0.14.0',
        runGlobalUpdate: (installSource) => {
          installSources.push(installSource);
          return { ok: true, stderr: '', revision: '1234567890ab' };
        },
        runSetupRefresh: async () => {
          refreshCalls += 1;
          assert.deepEqual(setupArgs(cwd), [
            'setup',
            '--scope',
            'user',
            '--plugin',
            '--mcp',
            'none',
            '--disable-team',
          ]);
          return { ok: true, stderr: '' };
        },
      }, { channel: 'stable' });

      assert.equal(result.status, 'updated');
      assert.deepEqual(installSources, [`${PACKAGE_NAME}@latest`]);
      assert.equal(refreshCalls, 1);
      assert.match(logs.join('\n'), /Selected update channel: stable/);
      assert.match(logs.join('\n'), /Install source: oh-my-codex@latest/);

      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
        install_channel: string;
        install_source: string;
        install_revision: string;
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

  it('installs the upstream dev branch without implying npm latest', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-dev-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    const originalLog = console.log;
    const logs: string[] = [];
    const installSources: string[] = [];
    let latestCalls = 0;
    let refreshCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
    process.env.CODEX_HOME = join(cwd, '.codex');

    try {
      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.14.0',
        fetchLatestVersion: async () => {
          latestCalls += 1;
          return '0.14.0';
        },
        runGlobalUpdate: (installSource) => {
          installSources.push(installSource);
          return { ok: true, stderr: '', revision: '1234567890ab' };
        },
        runSetupRefresh: async () => {
          refreshCalls += 1;
          return { ok: true, stderr: '' };
        },
        getInstalledVersionAfterUpdate: async () => '0.15.0',
        getInstalledRevisionAfterUpdate: async () => null,
      }, { channel: 'dev' });

      assert.equal(result.status, 'updated');
      assert.equal(latestCalls, 1);
      assert.equal(refreshCalls, 1);
      assert.deepEqual(installSources, ['github:Yeachan-Heo/oh-my-codex#dev']);
      assert.match(logs.join('\n'), /Selected update channel: dev/);
      assert.match(logs.join('\n'), /Install source: github:Yeachan-Heo\/oh-my-codex#dev/);
      assert.match(logs.join('\n'), /Running: clone dev branch, run prepack, then npm install -g the packed tarball/);
      assert.match(logs.join('\n'), /start a new Codex session if \/skills still shows stale OMX plugin skill metadata/);
      assert.doesNotMatch(logs.join('\n'), /dev.*oh-my-codex@latest/i);

      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
        install_channel: string;
        install_source: string;
        install_revision: string;
        dev_base_version: string;
      };
      assert.equal(stamp.installed_version, '0.15.0');
      assert.equal(stamp.setup_completed_version, '0.15.0');
      assert.equal(stamp.install_channel, 'dev');
      assert.equal(stamp.install_source, 'github:Yeachan-Heo/oh-my-codex#dev');
      assert.equal(stamp.install_revision, '1234567890ab');
      assert.equal(stamp.dev_base_version, '0.15.0');
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


  it('records the latest release as dev display baseline when dev package.json lags behind', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-dev-baseline-'));
    const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(cwd, '.codex');

    try {
      const result = await runImmediateUpdate(cwd, {
        getCurrentVersion: async () => '0.18.10',
        fetchLatestVersion: async () => '0.18.11',
        runGlobalUpdate: () => ({ ok: true, stderr: '', revision: '4dd0f6455772' }),
        runSetupRefresh: async () => ({ ok: true, stderr: '' }),
        getInstalledVersionAfterUpdate: async () => '0.18.10',
        getInstalledRevisionAfterUpdate: async () => null,
      }, { channel: 'dev' });

      assert.equal(result.status, 'updated');
      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
        install_channel: string;
        install_revision: string;
        dev_base_version: string;
      };
      assert.equal(stamp.installed_version, '0.18.10');
      assert.equal(stamp.setup_completed_version, '0.18.10');
      assert.equal(stamp.install_channel, 'dev');
      assert.equal(stamp.install_revision, '4dd0f6455772');
      assert.equal(stamp.dev_base_version, '0.18.11');
    } finally {
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
      assert.match(logs.join('\n'), /Updated stable channel to v0\.14\.1/);
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
      assert.match(logs.join('\n'), /Update failed while running the selected npm transaction \(npm install -g oh-my-codex@latest\)/);
      assert.match(logs.join('\n'), /npm stderr: EPERM: file is locked/);
      assert.match(logs.join('\n'), /ownership-safe recovery command: omx update/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('runDeferredGlobalUpdate', () => {
  it('launches a detached Node worker with a frozen ownership payload on Windows', async () => {
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
        frozenNpmOwnership,
      );

      assert.equal(result.ok, true);
      assert.match(result.logPath ?? '', /\.omx[\\/]logs[\\/]update-/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.command, process.execPath);
      assert.match(calls[0]?.args[0] ?? '', /update-worker\.js$/);
      const payloadPath = calls[0]?.args[1];
      assert.equal(typeof payloadPath, 'string');
      const payload = JSON.parse(await readFile(String(payloadPath), 'utf-8')) as {
        cwd: string;
        parentPid: number;
        ownership: PackageManagerOwnership;
        setupArgs: string[];
      };
      assert.deepEqual(payload, {
        cwd,
        logPath: result.logPath,
        parentPid: 12345,
        ownership: frozenNpmOwnership,
        setupArgs: ['setup'],
      });
      assert.deepEqual(listeners, ['error']);
      assert.equal(calls[0]?.options.detached, true);
      assert.equal(calls[0]?.options.stdio, 'ignore');
      assert.equal(calls[0]?.options.windowsHide, true);
      assert.equal(calls[0]?.options.cwd, cwd);
      assert.deepEqual(calls[0]?.options.env, { OMX_UPDATE_TEST: '1', OMX_SKIP_NATIVE_AGENT_REFRESH: '1' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes the frozen staged payload when the detached launcher emits an error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deferred-update-launcher-error-'));
    let payloadPath = '';

    try {
      const result = runDeferredGlobalUpdate(
        cwd,
        ((_command, args) => {
          payloadPath = String((args as readonly string[])[1]);
          return {
            once(event: string, listener: (error: Error) => void) {
              if (event === 'error') listener(new Error('launcher failed'));
              return this;
            },
            unref() {},
          } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn,
        'linux',
        12345,
        frozenNpmOwnership,
      );

      assert.equal(result.ok, true);
      assert.equal(existsSync(payloadPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves plugin setup delivery mode for deferred post-update refreshes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deferred-update-plugin-'));
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];

    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'user', installMode: 'plugin', mcpMode: 'none', teamMode: 'disabled' }, null, 2),
      );

      const result = runDeferredGlobalUpdate(
        cwd,
        ((command, args, options) => {
          calls.push({ command, args: args as string[], options: (options ?? {}) as Record<string, unknown> });
          return {
            once() {
              return this;
            },
            unref() {},
          } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn,
        'linux',
        12345,
        frozenNpmOwnership,
      );

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      const payload = JSON.parse(await readFile(calls[0]?.args[1] ?? '', 'utf-8')) as { setupArgs: string[] };
      assert.deepEqual(payload.setupArgs, ['setup', '--scope', 'user', '--plugin', '--mcp', 'none', '--disable-team']);
      assert.equal((calls[0].options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.OMX_SKIP_NATIVE_AGENT_REFRESH, '1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('snapshots deferred setup refresh args when scheduling the detached updater', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deferred-update-snapshot-'));
    const calls: Array<{ command: string; args: string[] }> = [];

    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      const setupScopePath = join(cwd, '.omx', 'setup-scope.json');
      await writeFile(
        setupScopePath,
        JSON.stringify({ scope: 'user', installMode: 'plugin', mcpMode: 'none', teamMode: 'disabled' }, null, 2),
      );

      const result = runDeferredGlobalUpdate(
        cwd,
        ((command, args) => {
          calls.push({ command, args: args as string[] });
          return {
            once() {
              return this;
            },
            unref() {},
          } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn,
        'linux',
        12345,
        frozenNpmOwnership,
      );

      await writeFile(
        setupScopePath,
        JSON.stringify({ scope: 'project', installMode: 'legacy', mcpMode: 'compat' }, null, 2),
      );

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      const payload = JSON.parse(await readFile(calls[0]?.args[1] ?? '', 'utf-8')) as { setupArgs: string[] };
      assert.deepEqual(payload.setupArgs, ['setup', '--scope', 'user', '--plugin', '--mcp', 'none', '--disable-team']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('quotes deferred setup command arguments at the shell boundary', () => {
    const args = ['setup', '--scope', 'user project', '--mcp', "none'; echo pwned #", '--flag', ''];

    assert.equal(
      formatDeferredSetupCommand('linux', 'omx tool', args),
      "'omx tool' 'setup' '--scope' 'user project' '--mcp' 'none'\\''; echo pwned #' '--flag' ''",
    );
    assert.equal(
      formatDeferredSetupCommand('win32', 'omx tool', args),
      "& 'omx tool' 'setup' '--scope' 'user project' '--mcp' 'none''; echo pwned #' '--flag' ''",
    );
  });


describe('deferred update worker', () => {
  it('retains refresh suppression and removes the verified staging directory after execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-update-worker-'));
    const globalRoot = join(root, 'global');
    const packageRoot = join(globalRoot, PACKAGE_NAME);
    const stage = join(root, 'omx-update-stage');

    const payloadPath = join(stage, 'transaction.json');
    const capturePath = join(root, 'setup-capture.json');
    const codexHome = join(root, 'codex-home');
    const stampPath = join(codexHome, '.omx', 'install-state.json');
    const npmCliPath = join(root, 'npm-cli.js');
    const cliPath = join(packageRoot, 'dist', 'cli.js');
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'update-worker.js');

    try {
      await mkdir(dirname(cliPath), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.14.1', bin: { omx: 'dist/cli.js' } }));
      await writeFile(cliPath, [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.OMX_UPDATE_CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), skip: process.env.OMX_SKIP_NATIVE_AGENT_REFRESH, stampPresent: existsSync(process.env.OMX_UPDATE_STAMP_PATH) }));",
      ].join('\n'));
      await writeFile(npmCliPath, [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'root') process.stdout.write(process.env.OMX_UPDATE_GLOBAL_ROOT + '\\n');",
        "else if (args[0] === 'prefix') process.stdout.write(process.env.OMX_UPDATE_PREFIX + '\\n');",
      ].join('\n'));
      await mkdir(stage, { recursive: true });
      await chmod(stage, 0o700);
      const ownership: PackageManagerOwnership = {
        manager: 'npm',
        npmCommand: { kind: 'node-script', command: process.execPath, commandArgs: [npmCliPath] },
        npmPrefix: root,
        globalInstallRoot: globalRoot,
        packageRoot,
        environment: {
          OMX_UPDATE_CAPTURE_PATH: capturePath,
          OMX_UPDATE_GLOBAL_ROOT: globalRoot,
          OMX_UPDATE_PREFIX: root,
          CODEX_HOME: codexHome,
          OMX_UPDATE_STAMP_PATH: stampPath,
        },
      };
      const serialized = JSON.stringify({ cwd: root, logPath: join(root, 'update.log'), parentPid: 999999, ownership, setupArgs: ['setup', '--scope', 'project'] });
      await writeFile(payloadPath, serialized, { mode: 0o600 });
      const digest = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
      const result = spawnSync(process.execPath, [workerPath, payloadPath, digest(serialized), digest(await readFile(workerPath))], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(await readFile(capturePath, 'utf-8')), {
        args: ['setup', '--scope', 'project'],
        skip: '1',
        stampPresent: false,
      });
      const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
        installed_version: string;
        setup_completed_version: string;
        install_channel: string;
        install_source: string;
        package_manager: string;
        updated_at: string;
      };
      assert.deepEqual({ ...stamp, updated_at: undefined }, {
        installed_version: '0.14.1',
        setup_completed_version: '0.14.1',
        install_channel: 'stable',
        install_source: 'oh-my-codex@latest',
        package_manager: 'npm',
        updated_at: undefined,
      });
      assert.match(stamp.updated_at, /^\d{4}-\d{2}-\d{2}T/);
      await assert.rejects(readFile(payloadPath), { code: 'ENOENT' });
      await assert.rejects(readFile(stage), { code: 'ENOENT' });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'unexpected-package', version: '0.14.1', bin: { omx: 'dist/cli.js' } }));
      await mkdir(stage, { recursive: true });
      await chmod(stage, 0o700);
      await writeFile(payloadPath, serialized, { mode: 0o600 });
      const rejected = spawnSync(process.execPath, [workerPath, payloadPath, digest(serialized), digest(await readFile(workerPath))], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.equal(rejected.status, 1, rejected.stderr);
      await assert.rejects(readFile(stage), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a worker whose frozen identity digest no longer matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-update-worker-integrity-'));
    const stage = join(root, 'omx-update-integrity');

    const payloadPath = join(stage, 'transaction.json');
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'update-worker.js');

    try {
      await mkdir(stage, { recursive: true });
      await chmod(stage, 0o700);
      const serialized = '{}';
      await writeFile(payloadPath, serialized, { mode: 0o600 });
      const digest = (contents: string) => createHash('sha256').update(contents).digest('hex');
      const result = spawnSync(process.execPath, [workerPath, payloadPath, digest(serialized), digest('different worker')], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      assert.equal(result.status, 1);
      assert.equal(existsSync(join(root, 'update.log')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a signed deferred payload with an invalid parent transaction boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-update-worker-payload-'));
    const stage = join(root, 'omx-update-payload');

    const payloadPath = join(stage, 'transaction.json');
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'update-worker.js');

    try {
      await mkdir(stage, { recursive: true });
      await chmod(stage, 0o700);
      const serialized = JSON.stringify({ cwd: root, logPath: join(root, 'update.log'), parentPid: 0, setupArgs: [], ownership: frozenNpmOwnership });
      await writeFile(payloadPath, serialized, { mode: 0o600 });
      const digest = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
      const result = spawnSync(process.execPath, [workerPath, payloadPath, digest(serialized), digest(await readFile(workerPath))], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      assert.equal(result.status, 1, result.stderr);
      assert.equal(await readFile(payloadPath, 'utf-8'), serialized);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a noncanonical payload path without removing its owner-only directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-update-worker-noncanonical-'));
    const stage = join(root, 'omx-update-noncanonical');
    const payloadPath = join(stage, 'unrelated.json');
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'update-worker.js');

    try {
      await mkdir(stage, { recursive: true });
      await chmod(stage, 0o700);
      const serialized = '{}';
      await writeFile(payloadPath, serialized, { mode: 0o600 });
      const digest = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
      const result = spawnSync(process.execPath, [workerPath, payloadPath, digest(serialized), digest(await readFile(workerPath))], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      assert.equal(result.status, 1, result.stderr);
      assert.equal(await readFile(payloadPath, 'utf-8'), serialized);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves an owner-only directory outside the scheduler staging namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-update-worker-foreign-stage-'));
    const stage = join(root, 'foreign-stage');
    const payloadPath = join(stage, 'transaction.json');
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'update-worker.js');

    try {
      await mkdir(stage, { recursive: true });
      await chmod(stage, 0o700);
      const serialized = '{}';
      await writeFile(payloadPath, serialized, { mode: 0o600 });
      const digest = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
      const result = spawnSync(process.execPath, [workerPath, payloadPath, digest(serialized), digest(await readFile(workerPath))], {
        encoding: 'utf-8',
        timeout: 10000,
      });

      assert.equal(result.status, 1, result.stderr);
      assert.equal(await readFile(payloadPath, 'utf-8'), serialized);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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

  it('passes only the frozen ownership environment to the immediate setup child', () => {
    const frozenEnvironment: NodeJS.ProcessEnv = {
      CODEX_HOME: '/frozen/codex-home',
      OMX_SKIP_NATIVE_AGENT_REFRESH: '1',
    };
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;

    const result = spawnInstalledSetupRefresh(
      '/tmp/omx.js',
      '/tmp/project',
      ((_command, _args, options) => {
        receivedEnvironment = options?.env;
        return { status: 0, error: undefined };
      }) as typeof import('node:child_process').spawnSync,
      process.execPath,
      frozenEnvironment,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(receivedEnvironment, frozenEnvironment);
    assert.equal(receivedEnvironment?.OMX_SKIP_NATIVE_AGENT_REFRESH, '1');
  });

  it('passes persisted plugin setup choices to the updated CLI refresh', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-plugin-refresh-'));
    const received: Array<{ command: string; args: string[] }> = [];

    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'user', installMode: 'plugin', mcpMode: 'none', teamMode: 'disabled' }, null, 2),
      );

      const result = spawnInstalledSetupRefresh(
        '/tmp/omx.js',
        cwd,
        ((command, args) => {
          received.push({ command, args: args as string[] });
          return { status: 0, error: undefined };
        }) as typeof import('node:child_process').spawnSync,
      );

      assert.equal(result.ok, true);
      assert.equal(received[0]?.command, process.execPath);
      assert.deepEqual(received[0]?.args, [
        '/tmp/omx.js',
        'setup',
        '--scope',
        'user',
        '--plugin',
        '--mcp',
        'none',
        '--disable-team',
      ]);
      assert.deepEqual(resolveSetupRefreshArgs(cwd), [
        'setup',
        '--scope',
        'user',
        '--plugin',
        '--mcp',
        'none',
        '--disable-team',
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('migrates legacy project-local scope when building update setup refresh args', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-plugin-legacy-scope-'));

    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'project-local', installMode: 'plugin', mcpMode: 'none' }, null, 2),
      );

      assert.deepEqual(resolveSetupRefreshArgs(cwd), [
        'setup',
        '--scope',
        'project',
        '--plugin',
        '--mcp',
        'none',
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('persisted merge policy update replay', () => {
  it('replays valid scoped policies without force, even when a stale force field is present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-merge-policy-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      const statePath = join(cwd, '.omx', 'setup-scope.json');
      await writeFile(statePath, JSON.stringify({ scope: 'user', installMode: 'plugin', mergeAgents: true, force: true }));
      assert.deepEqual(resolveSetupRefreshArgs(cwd), ['setup', '--scope', 'user', '--plugin', '--merge-agents']);

      await writeFile(statePath, JSON.stringify({ scope: 'project', mcpMode: 'compat', teamMode: 'disabled', mergeAgents: false }));
      assert.deepEqual(resolveSetupRefreshArgs(cwd), ['setup', '--scope', 'project', '--mcp', 'compat', '--disable-team', '--no-merge-agents']);
      assert.doesNotMatch(resolveSetupRefreshArgs(cwd).join(' '), /--force/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not replay malformed, unscoped, invalid-scope, or nonboolean merge policy records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-merge-policy-invalid-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      const statePath = join(cwd, '.omx', 'setup-scope.json');
		for (const [record, expected] of [
			[{ mergeAgents: true }, ["setup"]],
			[{ scope: "workspace", mergeAgents: true }, ["setup"]],
			[{ scope: "user", mergeAgents: "true" }, ["setup", "--scope", "user"]],
		] as const) {
			await writeFile(statePath, JSON.stringify(record));
			assert.deepEqual(resolveSetupRefreshArgs(cwd), expected);
		}
      await writeFile(statePath, '{ broken');
      assert.deepEqual(resolveSetupRefreshArgs(cwd), ['setup']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('snapshots merge-policy argv in the detached Node-worker payload on every platform', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-merge-policy-snapshot-'));
    const calls: Array<{ args: string[] }> = [];
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'user', mergeAgents: false, force: true }));
      for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
        calls.length = 0;
        const result = runDeferredGlobalUpdate(cwd, ((_, args) => {
          calls.push({ args: args as string[] });
          return { once() { return this; }, unref() {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn, platform, 12345, frozenNpmOwnership);
        assert.equal(result.ok, true);
        const payload = JSON.parse(await readFile(calls[0]?.args[1] ?? '', 'utf-8')) as { setupArgs: string[] };
        assert.deepEqual(payload.setupArgs, ['setup', '--scope', 'user', '--no-merge-agents']);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('package-manager ownership', () => {
  const executable = '/configured/node_modules/oh-my-codex/dist/cli/omx.js';
  const packageRoot = '/configured/node_modules/oh-my-codex';

  function ownershipDependencies(stamp: 'npm' | 'bun' | undefined, roots: { npm?: string; bunBin?: string }) {
    return {
      currentExecutable: executable,
      currentPackageRoot: packageRoot,
      readInstallStamp: async () => stamp
        ? { installed_version: '0.20.3', updated_at: '2026-07-22T00:00:00.000Z', package_manager: stamp }
        : null,
      realpath: (path: string) => path,
      resolveNpmGlobalInstallRoot: () => roots.npm ?? null,
      resolveBunGlobalBin: () => roots.bunBin ?? null,
      resolveBunCommand: () => '/configured/runtime/bun',
      resolveNpmCommand: () => ({ kind: 'node-script' as const, command: '/canonical/node', commandArgs: ['/canonical/npm-cli.js'] }),
      resolveNpmPrefix: () => '/configured',
      environment: { OMX_UPDATE_TEST: '1' },
    };
  }

  it('selects a validated npm owner from isolated roots', async () => {
    assert.deepEqual(await resolvePackageManagerOwnership(ownershipDependencies('npm', {
      npm: '/configured/node_modules',
    })), {
      manager: 'npm',
      npmCommand: { kind: 'node-script', command: '/canonical/node', commandArgs: ['/canonical/npm-cli.js'] },
      npmPrefix: '/configured',
      globalInstallRoot: '/configured/node_modules',
      packageRoot: '/configured/node_modules/oh-my-codex',
      environment: {},
    });
  });

  it('recovers an npm owner from a stale Bun stamp without deleting the stamp', async () => {
    const ownership = await resolvePackageManagerOwnership(ownershipDependencies('bun', {
      npm: '/configured/node_modules',
    }));

    assert.equal(ownership?.manager, 'npm');
  });

  it('freezes CODEX_HOME for deferred setup and update finalization', async () => {
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('npm', { npm: '/configured/node_modules' }),
      environment: { CODEX_HOME: '/configured/codex-home' },
    });
    assert.deepEqual(ownership?.environment, { CODEX_HOME: '/configured/codex-home' });
  });

  it('resolves a normal npm Node-shebang launch from its installed npm CLI without lifecycle provenance', async () => {
    let npmCommand: Extract<PackageManagerOwnership, { manager: 'npm' }>['npmCommand'] | undefined;
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('npm', { npm: '/fake/npm/lib/node_modules' }),
      currentExecutable: '/fake/npm/lib/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/npm/lib/node_modules/oh-my-codex',
      currentNodeExecutable: '/fake/npm/bin/node',
      resolveNpmCommand: () => null,
      resolveNpmGlobalInstallRoot: (command) => {
        npmCommand = command;
        return '/fake/npm/lib/node_modules';
      },
      resolveNpmPrefix: () => '/fake/npm',
      environment: {},
    });
    assert.deepEqual(npmCommand, {
      kind: 'node-script', command: '/fake/npm/bin/node', commandArgs: ['/fake/npm/lib/node_modules/npm/bin/npm-cli.js'],
    });
    assert.deepEqual(ownership, {
      manager: 'npm',
      npmCommand: npmCommand!,
      npmPrefix: '/fake/npm',
      globalInstallRoot: '/fake/npm/lib/node_modules',
      packageRoot: '/fake/npm/lib/node_modules/oh-my-codex',
      environment: {},
    });
    assert.equal(await resolvePackageManagerOwnership({
      ...ownershipDependencies('npm', { npm: '/fake/npm/lib/node_modules' }),
      currentExecutable: '/fake/npm/lib/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/npm/lib/node_modules/oh-my-codex',
      currentNodeExecutable: '/fake/npm/bin/node',
      resolveNpmCommand: () => null,
      realpath: (path) => {
        if (path.endsWith('/npm/bin/npm-cli.js')) throw new Error('missing npm CLI');
        return path;
      },
      environment: {},
    }), null, 'missing installed npm CLI must fail closed');
  });

  it('resolves npm from the selected global OMX root before a Node runtime sibling on Windows', async () => {
    let npmCommand: Extract<PackageManagerOwnership, { manager: 'npm' }>['npmCommand'] | undefined;
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('npm', { npm: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules' }),
      platform: 'win32',
      currentExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\oh-my-codex\\dist\\cli\\omx.js',
      currentPackageRoot: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\oh-my-codex',
      currentNodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      resolveNpmCommand: () => null,
      resolveNpmGlobalInstallRoot: (command) => {
        npmCommand = command;
        return 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules';
      },
      resolveNpmPrefix: () => 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      environment: {},
    });

    assert.deepEqual(npmCommand, {
      kind: 'node-script',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      commandArgs: ['C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js'],
    });
    assert.equal(ownership?.manager, 'npm');
  });

  it('resolves a normal Bun Node-shebang launch only from its configured install root and matching shim', async () => {
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: '/fake/bun/bin' }),
      currentExecutable: '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      bunInstallRoot: '/fake/bun',
      resolveBunCommand: () => null,
      environment: {},
      realpath: (path) => (({
        '/fake/bun/bin/omx': '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      } as Record<string, string>)[path] ?? path),
    });
    assert.deepEqual(ownership, {
      manager: 'bun',
      bunCommand: '/fake/bun/bin/bun',
      bunGlobalBin: '/fake/bun/bin',
      bunShim: '/fake/bun/bin/omx',
      bunInstallRoot: '/fake/bun',
      npmPrefix: '/fake/bun/install/global/node_modules',
      globalInstallRoot: '/fake/bun/install/global/node_modules',
      packageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      environment: { BUN_INSTALL: '/fake/bun' },
    });
    assert.equal(await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: '/fake/bun/bin' }),
      currentExecutable: '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      resolveBunCommand: () => null,
      bunInstallRoot: undefined,
      environment: {},
    }), null, 'missing Bun command provenance must fail closed');
  });

  it('queries Bun global-bin under the frozen configured environment', () => {
    const calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv | undefined }> = [];
    const bin = resolveBunGlobalBin(
      '/fake/bun/bin/bun',
      { BUN_INSTALL: '/fake/bun', PATH: '/frozen/path' },
      ((command, args, options) => {
        calls.push({ command, args: args as string[], environment: options?.env });
        return { status: 0, stdout: '/fake/bun/bin\n', stderr: '', error: undefined } as ReturnType<typeof import('node:child_process').spawnSync>;
      }) as typeof import('node:child_process').spawnSync,
    );

    assert.equal(bin, '/fake/bun/bin');
    assert.deepEqual(calls, [{
      command: '/fake/bun/bin/bun',
      args: ['pm', 'bin', '-g'],
      environment: { BUN_INSTALL: '/fake/bun', PATH: '/frozen/path' },
    }]);
  });

  it('resolves an unstamped Bun install after confirming its canonical shim and configured root', async () => {
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies(undefined, { bunBin: '/fake/bun/bin' }),
      currentExecutable: '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      bunInstallRoot: '/fake/bun',
      resolveBunCommand: () => '/fake/bun/bin/bun',
      environment: {},
      realpath: (path) => (({
        '/fake/bun/bin/omx': '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      } as Record<string, string>)[path] ?? path),
    });

    assert.deepEqual(ownership, {
      manager: 'bun',
      bunCommand: '/fake/bun/bin/bun',
      bunGlobalBin: '/fake/bun/bin',
      bunShim: '/fake/bun/bin/omx',
      bunInstallRoot: '/fake/bun',
      npmPrefix: '/fake/bun/install/global/node_modules',
      globalInstallRoot: '/fake/bun/install/global/node_modules',
      packageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      environment: { BUN_INSTALL: '/fake/bun' },
    });
  });

  it('recovers a Bun owner from a stale npm stamp without deleting the stamp', async () => {
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('npm', { bunBin: '/fake/bun/bin' }),
      currentExecutable: '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      bunInstallRoot: '/fake/bun',
      resolveBunCommand: () => '/fake/bun/bin/bun',
      environment: {},
      realpath: (path) => (({
        '/fake/bun/bin/omx': '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      } as Record<string, string>)[path] ?? path),
    });

    assert.equal(ownership?.manager, 'bun');
  });

  it('fails closed when npm and Bun ownership both validate, even with a manager stamp', async () => {
    for (const stamp of [undefined, 'npm', 'bun'] as const) {
      const ownership = await resolvePackageManagerOwnership({
        ...ownershipDependencies(stamp, {
          npm: '/fake/bun/install/global/node_modules',
          bunBin: '/fake/bun/bin',
        }),
        currentExecutable: '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
        currentPackageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
        bunInstallRoot: '/fake/bun',
        resolveBunCommand: () => '/fake/bun/bin/bun',
        resolveNpmPrefix: () => '/fake/bun/install/global',
        environment: {},
        realpath: (path) => (({
          '/fake/bun/bin/omx': '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
        } as Record<string, string>)[path] ?? path),
      });

      assert.equal(ownership, null);
    }
  });

  it('uses platform-correct canonical paths for a Windows Bun .cmd shim', async () => {
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: 'C:\\Users\\alice\\.bun\\bin' }),
      platform: 'win32',
      bunInstallRoot: 'C:\\Users\\alice\\.bun',
      currentExecutable: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules\\oh-my-codex\\dist\\cli\\omx.js',
      currentPackageRoot: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules\\oh-my-codex',
      resolveBunCommand: () => null,
      environment: {},
      realpath: (path) => path,
    });
    assert.deepEqual(ownership, {
      manager: 'bun',
      bunCommand: 'C:\\Users\\alice\\.bun\\bin\\bun.exe',
      bunGlobalBin: 'C:\\Users\\alice\\.bun\\bin',
      bunShim: 'C:\\Users\\alice\\.bun\\bin\\omx.cmd',
      bunInstallRoot: 'C:\\Users\\alice\\.bun',
      npmPrefix: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules',
      globalInstallRoot: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules',
      packageRoot: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules\\oh-my-codex',
      environment: { BUN_INSTALL: 'C:\\Users\\alice\\.bun' },
    });
  });

  it('derives a fresh Bun installation root from its canonical executable without ambient PATH lookup', async () => {
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: 'C:\\Users\\alice\\.bun\\bin' }),
      platform: 'win32',
      currentExecutable: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules\\oh-my-codex\\dist\\cli\\omx.js',
      currentPackageRoot: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules\\oh-my-codex',
      bunInstallRoot: undefined,
      resolveBunCommand: () => 'C:\\Users\\alice\\.bun\\bin\\bun.exe',
      environment: {},
      realpath: (path) => path,
    });

    assert.deepEqual(ownership, {
      manager: 'bun',
      bunCommand: 'C:\\Users\\alice\\.bun\\bin\\bun.exe',
      bunGlobalBin: 'C:\\Users\\alice\\.bun\\bin',
      bunShim: 'C:\\Users\\alice\\.bun\\bin\\omx.cmd',
      bunInstallRoot: 'C:\\Users\\alice\\.bun',
      npmPrefix: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules',
      globalInstallRoot: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules',
      packageRoot: 'C:\\Users\\alice\\.bun\\install\\global\\node_modules\\oh-my-codex',
      environment: { BUN_INSTALL: 'C:\\Users\\alice\\.bun' },
    });
  });

  it('rejects Bun shim evidence when BUN_INSTALL cannot bind the command and global target', async () => {
    let npmCalls = 0;
    const ownership = await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: '/configured/bun/bin' }),
      bunInstallRoot: '/missing/developer-bun',
      currentExecutable: '/links/omx.js',
      currentPackageRoot: '/links/package',
      realpath: (path: string) => {
        if (path === '/missing/developer-bun') throw new Error('missing BUN_INSTALL');
        return path;
      },
      resolveNpmGlobalInstallRoot: () => { npmCalls += 1; return null; },
    });
    assert.equal(ownership, null);
    assert.equal(npmCalls, 1, 'A stale stamp cannot suppress independent live ownership validation.');
  });

  it('fails closed for missing, ambiguous, stale, or non-shim Bun ownership evidence', async () => {
    assert.equal(await resolvePackageManagerOwnership(ownershipDependencies(undefined, {})), null);
    assert.equal((await resolvePackageManagerOwnership(ownershipDependencies('bun', {
      npm: '/configured/node_modules',
    })))?.manager, 'npm', 'a stale Bun stamp must yield to one uniquely validated npm owner');
    assert.equal(await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: '/configured/bun/bin' }),
      resolveBunGlobalBin: () => '/configured/bun/bin',
      realpath: (path) => path,
    }), null);
    assert.equal(await resolvePackageManagerOwnership({
      ...ownershipDependencies('bun', { bunBin: '/fake/bun/bin' }),
      currentExecutable: '/fake/bun/install/global/node_modules/oh-my-codex/dist/cli/omx.js',
      currentPackageRoot: '/fake/bun/install/global/node_modules/oh-my-codex',
      bunInstallRoot: '/fake/bun',
      resolveBunCommand: () => '/other/bun',
      environment: {},
    }), null, 'Bun executable provenance must bind to the configured installation target.');
  });

  it('uses the frozen Bun command for stable and deferred updates and rejects Bun dev before spawning', async () => {
    const owner: PackageManagerOwnership = {
      manager: 'bun',
      bunCommand: '/configured/runtime/bun',
      bunGlobalBin: '/configured/bun/bin',
      bunShim: '/configured/bun/bin/omx',
      bunInstallRoot: '/configured/bun',
      globalInstallRoot: '/configured/node_modules',
      packageRoot: '/configured/node_modules/oh-my-codex',
      npmPrefix: '/configured',
      environment: { OMX_UPDATE_TEST: '1', BUN_INSTALL: '/configured/bun' },
    };
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = ((command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('node:child_process').spawnSync;
    assert.deepEqual(runGlobalUpdate('oh-my-codex@latest', spawnProcess, 'linux', owner), { ok: true, stderr: '' });
    assert.deepEqual(calls, [{ command: '/configured/runtime/bun', args: ['add', '--global', '--ignore-scripts', 'oh-my-codex@latest'] }]);
    calls.length = 0;
    const incompleteOwner: PackageManagerOwnership = {
      ...owner,
      bunInstallRoot: undefined,
      environment: { OMX_UPDATE_TEST: '1' },
    };
    assert.deepEqual(runGlobalUpdate('oh-my-codex@latest', spawnProcess, 'linux', incompleteOwner), {
      ok: false,
      stderr: 'The package-manager ownership transaction is incomplete.',
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(runGlobalUpdate('github:Yeachan-Heo/oh-my-codex#dev', spawnProcess, 'linux', owner), {
      ok: false, stderr: 'Bun dev updates are not yet supported',
    });
    assert.deepEqual(calls, []);

    const cwd = await mkdtemp(join(tmpdir(), 'omx-deferred-bun-'));
    try {
      const deferredCalls: Array<{ command: string; args: string[] }> = [];
      const deferred = runDeferredGlobalUpdate(cwd, ((command, args) => {
        deferredCalls.push({ command, args: args as string[] });
        return { once() { return this; }, unref() {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as typeof import('node:child_process').spawn, 'linux', 12345, owner);
      assert.equal(deferred.ok, true);
      assert.equal(deferredCalls[0]?.command, process.execPath);
      assert.match(deferredCalls[0]?.args[0] ?? '', /update-worker\.js$/);
      const payload = JSON.parse(await readFile(deferredCalls[0]?.args[1] ?? '', 'utf-8')) as { ownership: PackageManagerOwnership; setupArgs: string[] };
      assert.deepEqual(payload.ownership, owner);
      assert.deepEqual(payload.setupArgs, ['setup']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects malformed frozen npm and Bun ownership before spawning a manager or deferred worker', async () => {
    const malformedOwners: PackageManagerOwnership[] = [
      {
        ...frozenNpmOwnership,
        npmCommand: { kind: 'node-script', command: '/untrusted/npm-launcher', commandArgs: [] },
      },
      {
        manager: 'bun',
        bunCommand: '/untrusted/bun-launcher',
        bunGlobalBin: '',
        bunShim: '',
        bunInstallRoot: '/configured/bun',
        globalInstallRoot: '/configured/node_modules',
        packageRoot: '/configured/node_modules/oh-my-codex',
        npmPrefix: '/configured',
        environment: { BUN_INSTALL: '/configured/bun' },
      },
    ];
    const cwd = await mkdtemp(join(tmpdir(), 'omx-malformed-frozen-ownership-'));
    try {
      for (const ownership of malformedOwners) {
        const managerCalls: string[] = [];
        const result = runGlobalUpdate('oh-my-codex@latest', ((command: string) => {
          managerCalls.push(command);
          return { status: 0, signal: null, error: undefined, stdout: '', stderr: '', output: [null, '', ''], pid: 0 };
        }) as typeof import('node:child_process').spawnSync, 'linux', ownership);
        assert.deepEqual(result, { ok: false, stderr: 'The package-manager ownership transaction is incomplete.' });
        assert.deepEqual(managerCalls, []);

        const workerCalls: string[] = [];
        const deferred = runDeferredGlobalUpdate(cwd, ((command) => {
          workerCalls.push(command);
          return { once() { return this; }, unref() {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn, 'linux', 12345, ownership);
        assert.deepEqual(deferred.ok, false);
        assert.deepEqual(workerCalls, []);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
