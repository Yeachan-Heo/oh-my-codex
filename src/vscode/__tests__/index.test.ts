import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  buildDirectSessionArgs,
  findDangerousLaunchArgs,
  launchDirectSession,
  launchRequiresDangerousApproval,
  resolveVscodeLaunchEnv,
  runOmxCatalogCommand,
} from '../index.js';

function fakeChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough() as ChildProcess['stdout'];
  child.stderr = new PassThrough() as ChildProcess['stderr'];
  Object.defineProperty(child, 'pid', { value: 12345 });
  child.kill = (() => true) as ChildProcess['kill'];
  return child;
}

async function withTempDir(test: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-vscode-direct-'));
  try {
    await test(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function readFileEventually(path: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('VSCode direct session API', () => {
  it('builds direct launch args without preserving conflicting tmux policy flags', () => {
    assert.deepEqual(
      buildDirectSessionArgs({ codexArgs: ['--tmux', '--model', 'gpt-5', '--direct'] }),
      ['launch', '--direct', '--model', 'gpt-5'],
    );
    assert.deepEqual(
      buildDirectSessionArgs({ mode: 'resume', codexArgs: ['--tmux', '--last'] }),
      ['resume', '--direct', '--last'],
    );
  });

  it('requires explicit approval for dangerous launch flags', () => {
    const args = buildDirectSessionArgs({ codexArgs: ['--madmax', '--yolo'] });
    assert.equal(launchRequiresDangerousApproval(args), true);
    assert.deepEqual(findDangerousLaunchArgs(args), ['--madmax', '--yolo']);
    assert.throws(
      () => launchDirectSession({
        cwd: process.cwd(),
        codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        sessionId: 'test-danger',
      }),
      /dangerous_launch_requires_approval/,
    );
  });

  it('spawns omx in direct mode with VSCode session environment and log path', async () => {
    await withTempDir(async (cwd) => {
      let capturedCommand = '';
      let capturedArgs: string[] = [];
      let capturedOptions: SpawnOptions | undefined;
      const child = fakeChildProcess();
      const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
        capturedCommand = command;
        capturedArgs = [...args];
        capturedOptions = options;
        return child;
      };

      const handle = launchDirectSession({
        cwd,
        omxCommand: 'custom-omx',
        prompt: 'ship the extension',
        sessionId: 'vscode-test-session',
        env: { PATH: '/bin' },
      }, {
        spawn,
        now: () => new Date('2026-06-13T00:00:00.000Z'),
      });

      assert.equal(capturedCommand, 'custom-omx');
      assert.deepEqual(capturedArgs, ['launch', '--direct', 'ship the extension']);
      assert.equal(capturedOptions?.cwd, cwd);
      assert.equal((capturedOptions?.env as NodeJS.ProcessEnv).OMX_LAUNCH_POLICY, 'direct');
      assert.equal((capturedOptions?.env as NodeJS.ProcessEnv).OMX_VSCODE_SESSION_ID, 'vscode-test-session');
      assert.equal((capturedOptions?.env as NodeJS.ProcessEnv).OMX_VSCODE_LOG_PATH, handle.log_path);
      assert.equal(handle.pid, 12345);
      assert.equal(handle.stop(), true);

      child.emit('exit', 0, null);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  it('launches direct sessions through Windows command shims', async () => {
    await withTempDir(async (cwd) => {
      const fakeBin = join(cwd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, 'omx.cmd'), '@echo off\r\n');

      let capturedCommand = '';
      let capturedArgs: string[] = [];
      let capturedOptions: SpawnOptions | undefined;
      const child = fakeChildProcess();
      const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
        capturedCommand = command;
        capturedArgs = [...args];
        capturedOptions = options;
        return child;
      };

      const handle = launchDirectSession({
        cwd,
        omxCommand: 'omx',
        sessionId: 'vscode-windows-session',
        env: {
          PATH: fakeBin,
          PATHEXT: '.CMD;.EXE',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
        platform: 'win32',
      }, { spawn });

      assert.equal(capturedCommand, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(capturedArgs.slice(0, 3), ['/d', '/s', '/c']);
      assert.match(capturedArgs[3] ?? '', /omx\.cmd/i);
      assert.match(capturedArgs[3] ?? '', /launch/);
      assert.equal(capturedOptions?.windowsHide, true);
      assert.equal(capturedOptions?.windowsVerbatimArguments, true);
      assert.equal(handle.command, capturedCommand);

      child.emit('exit', 0, null);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  it('redacts child process output before writing VSCode session logs', async () => {
    await withTempDir(async (cwd) => {
      const child = fakeChildProcess();
      const logPath = join(cwd, 'vscode-session.log');

      launchDirectSession({
        cwd,
        omxCommand: 'custom-omx',
        sessionId: 'vscode-redaction-session',
        logPath,
      }, {
        spawn: () => child,
        now: () => new Date('2026-06-13T00:00:00.000Z'),
      });

      child.stdout?.emit('data', 'Authorization: Bearer sk-live-token\n');
      child.stderr?.emit('data', 'access_token=plain-secret\n');
      child.emit('exit', 0, null);
      await new Promise((resolve) => setImmediate(resolve));

      const log = await readFileEventually(logPath);
      assert.doesNotMatch(log, /sk-live-token/);
      assert.doesNotMatch(log, /plain-secret/);
      assert.match(log, /\[REDACTED]/);
    });
  });

  it('builds VSCode launch env through the shared platform command resolver', async () => {
    await withTempDir(async (cwd) => {
      const binDir = join(cwd, 'bin');
      await mkdir(binDir, { recursive: true });
      const codexPath = join(binDir, 'codex');
      await writeFile(codexPath, '#!/bin/sh\n');
      await chmod(codexPath, 0o755);

      const resolution = resolveVscodeLaunchEnv({
        cwd,
        omxCommand: join(cwd, 'dist', 'cli', 'omx.js'),
        baseEnv: { PATH: '' },
        extraPath: [binDir, binDir],
        platform: 'linux',
      });

      assert.equal(resolution.codexPath, codexPath);
      assert.equal(resolution.env.PATH?.split(delimiter)[0], binDir);
      assert.equal(resolution.pathEntries.filter((entry) => entry === binDir).length, 1);
      assert.ok(resolution.pathEntries.includes(join(cwd, 'dist', 'cli')));
      assert.ok(resolution.pathEntries.includes(join(cwd, 'node_modules', '.bin')));
    });
  });

  it('runs catalog commands with VSCode direct-session environment', async () => {
    await withTempDir(async (cwd) => {
      const scriptPath = join(cwd, 'catalog-env.cjs');
      await writeFile(scriptPath, [
        'process.stdout.write(JSON.stringify({',
        '  policy: process.env.OMX_LAUNCH_POLICY,',
        '  runner: process.env.OMX_VSCODE_RUNNER,',
        '  argv: process.argv.slice(2),',
        '}));',
        '',
      ].join('\n'));

      const result = runOmxCatalogCommand({
        cwd,
        omxCommand: process.execPath,
        args: [scriptPath, 'doctor', '--json'],
      });

      assert.equal(result.code, 0);
      const payload = JSON.parse(result.stdout) as { policy?: string; runner?: string; argv?: string[] };
      assert.equal(payload.policy, 'direct');
      assert.equal(payload.runner, '1');
      assert.deepEqual(payload.argv, ['doctor', '--json']);
    });
  });

  it('runs catalog commands through Windows command shims', async () => {
    await withTempDir(async (cwd) => {
      const fakeBin = join(cwd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, 'omx.cmd'), '@echo off\r\n');

      let capturedCommand = '';
      let capturedArgs: readonly string[] = [];
      let capturedOptions: { env?: NodeJS.ProcessEnv; windowsHide?: boolean; windowsVerbatimArguments?: boolean } | undefined;
      const spawnSync = ((command: string, args: readonly string[], options?: typeof capturedOptions) => {
        capturedCommand = command;
        capturedArgs = [...args];
        capturedOptions = options;
        return {
          status: 0,
          stdout: 'ok',
          stderr: '',
          pid: 1,
          output: [],
          signal: null,
        } as SpawnSyncReturns<string>;
      }) as unknown as typeof import('node:child_process').spawnSync;

      const result = runOmxCatalogCommand({
        cwd,
        omxCommand: 'omx',
        args: ['doctor'],
        env: {
          PATH: fakeBin,
          PATHEXT: '.CMD;.EXE',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
        platform: 'win32',
      }, { spawnSync });

      assert.equal(result.code, 0);
      assert.equal(result.command, 'C:\\Windows\\System32\\cmd.exe');
      assert.equal(capturedCommand, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(capturedArgs.slice(0, 3), ['/d', '/s', '/c']);
      assert.match(capturedArgs[3] ?? '', /omx\.cmd/i);
      assert.match(capturedArgs[3] ?? '', /doctor/);
      assert.equal(capturedOptions?.env?.OMX_LAUNCH_POLICY, 'direct');
      assert.equal(capturedOptions?.windowsHide, true);
      assert.equal(capturedOptions?.windowsVerbatimArguments, true);
    });
  });

});
