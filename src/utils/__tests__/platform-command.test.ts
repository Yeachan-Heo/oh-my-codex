import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPlatformCommandSpec,
  classifySpawnError,
  resolveCommandPathForPlatform,
  spawnPlatformCommandSync,
} from '../platform-command.js';

describe('buildPlatformCommandSpec', () => {
  it('wraps .cmd shims through ComSpec on Windows', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-cmd-'));
    try {
      const cmdPath = join(fakeBin, 'codex.cmd');
      await writeFile(cmdPath, '@echo off\r\n');
      const spec = buildPlatformCommandSpec(
        'codex',
        ['--version'],
        'win32',
        {
          PATH: fakeBin,
          PATHEXT: '.EXE;.CMD;.PS1',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
      );

      assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
      assert.match(spec.args[3] || '', /codex\.cmd/i);
      assert.match(spec.args[3] || '', /--version/i);
      assert.equal(spec.resolvedPath, cmdPath);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('launches .exe binaries directly on Windows', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-exe-'));
    try {
      const exePath = join(fakeBin, 'tmux.exe');
      await writeFile(exePath, '');
      const spec = buildPlatformCommandSpec(
        'tmux',
        ['-V'],
        'win32',
        {
          PATH: fakeBin,
          PATHEXT: '.EXE;.CMD;.PS1',
        },
      );

      assert.equal(spec.command, exePath);
      assert.deepEqual(spec.args, ['-V']);
      assert.equal(spec.resolvedPath, exePath);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('prefers PowerShell shims over cmd shims when both exist', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-ps1-'));
    try {
      const ps1Path = join(fakeBin, 'codex.ps1');
      const cmdPath = join(fakeBin, 'codex.cmd');
      await writeFile(ps1Path, '');
      await writeFile(cmdPath, '');
      const spec = buildPlatformCommandSpec(
        'codex',
        ['--version'],
        'win32',
        {
          PATH: fakeBin,
          PATHEXT: '.EXE;.CMD;.PS1',
        },
      );

      assert.match(spec.command, /powershell(?:\.exe)?$/i);
      assert.deepEqual(spec.args.slice(0, 5), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
      assert.equal(spec.args[5], ps1Path);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});

describe('resolveCommandPathForPlatform', () => {
  it('prefers PATHEXT candidates on Windows', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-path-'));
    try {
      const exePath = join(fakeBin, 'tmux.exe');
      await writeFile(exePath, '');
      assert.equal(
        resolveCommandPathForPlatform(
          'tmux',
          'win32',
          {
            PATH: fakeBin,
            PATHEXT: '.EXE;.CMD',
          },
        ),
        exePath,
      );
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('resolves PATH entries to absolute paths on POSIX', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-posix-'));
    try {
      const nodePath = join(fakeBin, 'node');
      await writeFile(nodePath, '');
      assert.equal(
        resolveCommandPathForPlatform(
          'node',
          'linux',
          { PATH: fakeBin },
        ),
        nodePath,
      );
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('returns null on POSIX when the command is not present on PATH', () => {
    assert.equal(
      resolveCommandPathForPlatform(
        'missing-binary',
        'linux',
        { PATH: '/tmp/does-not-exist' },
      ),
      null,
    );
  });
});

describe('classifySpawnError', () => {
  it('classifies ENOENT as missing', () => {
    assert.equal(classifySpawnError({ code: 'ENOENT' } as NodeJS.ErrnoException), 'missing');
  });

  it('classifies EPERM as blocked', () => {
    assert.equal(classifySpawnError({ code: 'EPERM' } as NodeJS.ErrnoException), 'blocked');
  });

  it('classifies other errors as generic error', () => {
    assert.equal(classifySpawnError({ code: 'EIO' } as NodeJS.ErrnoException), 'error');
  });
});

describe('spawnPlatformCommandSync', () => {
  it('passes the Windows-resolved spec into the spawn implementation', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-spawn-'));
    try {
      const cmdPath = join(fakeBin, 'codex.cmd');
      await writeFile(cmdPath, '@echo off\r\n');
      const calls: Array<{ command: string; args: readonly string[] }> = [];

      const probed = spawnPlatformCommandSync(
        'codex',
        ['--version'],
        { encoding: 'utf-8' },
        'win32',
        {
          PATH: fakeBin,
          PATHEXT: '.EXE;.CMD',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
        undefined,
        (((command: string, args: readonly string[]) => {
          calls.push({ command, args });
          return {
            status: 0,
            stdout: 'ok',
            stderr: '',
            pid: 1,
            output: [],
            signal: null,
          };
        }) as unknown) as typeof import('child_process').spawnSync,
      );

      assert.equal(probed.spec.command, 'C:\\Windows\\System32\\cmd.exe');
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.command, 'C:\\Windows\\System32\\cmd.exe');
      assert.match((calls[0]?.args[3] || ''), /codex\.cmd/i);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });


  it('retries blocked node-hosted scripts through process.execPath on non-Windows', () => {
    const scriptPath = '/tmp/omx-explore-stub.js';
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const probed = spawnPlatformCommandSync(
      scriptPath,
      ['--prompt', 'find auth'],
      { encoding: 'utf-8' },
      'linux',
      process.env,
      undefined,
      (((command: string, args: readonly string[]) => {
        calls.push({ command, args });
        if (calls.length === 1) {
          return {
            status: 0,
            stdout: '',
            stderr: '',
            pid: 1,
            output: [],
            signal: null,
            error: { code: 'EPERM', message: 'blocked' },
          };
        }
        return {
          status: 0,
          stdout: '# Answer\nReady\n',
          stderr: '',
          pid: 2,
          output: [],
          signal: null,
        };
      }) as unknown) as typeof import('child_process').spawnSync,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.command, scriptPath);
    assert.equal(calls[1]?.command, process.execPath);
    assert.deepEqual(calls[1]?.args, [scriptPath, '--prompt', 'find auth']);
    assert.equal(probed.result.stdout, '# Answer\nReady\n');
    assert.equal(probed.spec.command, process.execPath);
  });
});
