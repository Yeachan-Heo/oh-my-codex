import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isInstallVersionBump,
  isNewerVersion,
  maybeCheckAndPromptUpdate,
  readUserInstallStamp,
  resolveAutoUpdateMode,
  resolveGlobalInstallRoot,
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

describe('direct npm spawn fallback', () => {
  function enoentResult() {
    const error = Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' });
    return { status: null, signal: null, error, stdout: '', stderr: '', output: [null, '', ''], pid: 0 };
  }

  function okResult(stdout = '') {
    return { status: 0, signal: null, error: undefined, stdout, stderr: '', output: [null, stdout, ''], pid: 0 };
  }

  it('falls back to npm.cmd for win32 global installs when direct npm spawn returns ENOENT', () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = runGlobalUpdate(
      ((command: string, args: readonly string[]) => {
        calls.push({ command, args: args as string[] });
        return command === 'npm' ? enoentResult() : okResult();
      }) as unknown as typeof import('node:child_process').spawnSync,
      'win32',
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.command), ['npm', 'npm.cmd']);
    assert.deepEqual(calls[0].args, ['install', '-g', 'oh-my-codex@latest']);
    assert.deepEqual(calls[1].args, ['install', '-g', 'oh-my-codex@latest']);
  });

  it('does not fall back to npm.cmd for non-Windows ENOENT failures', () => {
    const calls: string[] = [];

    const result = runGlobalUpdate(
      ((command: string) => {
        calls.push(command);
        return enoentResult();
      }) as unknown as typeof import('node:child_process').spawnSync,
      'linux',
    );

    assert.equal(result.ok, false);
    assert.match(result.stderr, /ENOENT/);
    assert.deepEqual(calls, ['npm']);
  });


  it('packs the dev branch from a local checkout instead of globally installing the git dependency spec', () => {
    const originalNpmLocation = process.env.npm_config_location;
    const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];

    process.env.npm_config_location = 'global';

    try {
      const result = runGlobalUpdate(
        'github:Yeachan-Heo/oh-my-codex#dev',
        ((command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
          calls.push({ command, args: args as string[], cwd: options?.cwd, env: options?.env });
          if (command === 'git' && args[0] === 'clone') {
            mkdirSync(String(args[args.length - 1]), { recursive: true });
          }
          if (command === 'git' && args[0] === 'rev-parse') {
            return okResult('1234567890abcdef\n');
          }
          if (command === 'npm' && args[0] === 'pack') {
            writeFileSync(join(options?.cwd ?? process.cwd(), 'oh-my-codex-0.18.9.tgz'), 'packed');
            return okResult(JSON.stringify([{ filename: 'oh-my-codex-0.18.9.tgz' }]));
          }
          return okResult();
        }) as unknown as typeof import('node:child_process').spawnSync,
        'linux',
      );

      assert.equal(result.ok, true);
      assert.deepEqual(calls.map((call) => [call.command, ...call.args.slice(0, 3)]), [
        ['git', 'clone', '--depth', '1'],
        ['git', 'rev-parse', 'HEAD'],
        ['npm', 'install', '--global=false', '--location=project'],
        ['npm', 'run', 'prepack'],
        ['npm', 'pack', '--ignore-scripts', '--json'],
        ['npm', 'install', '-g', join(calls[2].cwd ?? '', 'oh-my-codex-0.18.9.tgz')],
      ]);
      const dependencyInstall = calls.find((call) => call.command === 'npm' && call.args[0] === 'install' && call.args.includes('--include=dev'));
      assert.equal(dependencyInstall?.env?.npm_config_global, 'false');
      assert.equal(dependencyInstall?.env?.npm_config_location, 'project');
      assert.equal(calls.some((call) => call.args.includes('github:Yeachan-Heo/oh-my-codex#dev')), false);
    } finally {
      if (typeof originalNpmLocation === 'string') {
        process.env.npm_config_location = originalNpmLocation;
      } else {
        delete process.env.npm_config_location;
      }
    }
  });

  it('falls back to npm.cmd for win32 global-root lookup when direct npm spawn returns ENOENT', () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    const root = resolveGlobalInstallRoot(
      ((command: string, args: readonly string[]) => {
        calls.push({ command, args: args as string[] });
        return command === 'npm' ? enoentResult() : okResult('C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\r\n');
      }) as unknown as typeof import('node:child_process').spawnSync,
      'win32',
    );

    assert.equal(root, 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules');
    assert.deepEqual(calls.map((call) => call.command), ['npm', 'npm.cmd']);
    assert.deepEqual(calls[0].args, ['root', '-g']);
    assert.deepEqual(calls[1].args, ['root', '-g']);
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
      assert.match(calls[0].args[4], /& 'omx' 'setup'/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves plugin setup delivery mode for deferred post-update refreshes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deferred-update-plugin-'));
    const calls: Array<{ command: string; args: string[] }> = [];

    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
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
      );

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].args[1], /'omx' 'setup' '--scope' 'user' '--plugin' '--mcp' 'none' '--disable-team'/);
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
      );

      await writeFile(
        setupScopePath,
        JSON.stringify({ scope: 'project', installMode: 'legacy', mcpMode: 'compat' }, null, 2),
      );

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].args[1], /'omx' 'setup' '--scope' 'user' '--plugin' '--mcp' 'none' '--disable-team'/);
      assert.doesNotMatch(calls[0].args[1], /compat/);
      assert.doesNotMatch(calls[0].args[1], /legacy/);
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
