import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
      assert.match(spec.args[3] || '', /^""/);
      assert.match(spec.args[3] || '', /codex\.cmd/i);
      assert.match(spec.args[3] || '', /--version/i);
      assert.match(spec.args[3] || '', /""$/);
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

  it('skips directory PATH matches when resolving the PowerShell host for .ps1 shims', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-platform-powershell-host-'));
    try {
      const fakeBin = join(fakeRoot, 'npm-bin');
      const fakeSystem32 = join(fakeRoot, 'System32');
      const fakeDirectoryMatch = join(fakeSystem32, 'powershell');
      const fakePowerShellHostDir = join(fakeRoot, 'WindowsPowerShell', 'v1.0');
      const ps1Path = join(fakeBin, 'codex.ps1');
      const powershellExe = join(fakePowerShellHostDir, 'powershell.exe');

      await mkdir(fakeBin, { recursive: true });
      await mkdir(fakeDirectoryMatch, { recursive: true });
      await mkdir(fakePowerShellHostDir, { recursive: true });
      await writeFile(ps1Path, '');
      await writeFile(powershellExe, '');

      const spec = buildPlatformCommandSpec(
        'codex',
        ['--version'],
        'win32',
        {
          PATH: [fakeBin, fakeSystem32, fakePowerShellHostDir].join(';'),
          PATHEXT: '.EXE;.CMD;.PS1',
        },
      );

      assert.equal(spec.command, powershellExe);
      assert.deepEqual(spec.args.slice(0, 5), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
      assert.equal(spec.args[5], ps1Path);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
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

  it('ignores directory PATH matches on Windows', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-platform-directory-match-'));
    try {
      const fakeSystem32 = join(fakeRoot, 'System32');
      const fakeDirectoryMatch = join(fakeSystem32, 'powershell');
      const fakePowerShellHostDir = join(fakeRoot, 'WindowsPowerShell', 'v1.0');
      const powershellExe = join(fakePowerShellHostDir, 'powershell.exe');

      await mkdir(fakeDirectoryMatch, { recursive: true });
      await mkdir(fakePowerShellHostDir, { recursive: true });
      await writeFile(powershellExe, '');

      assert.equal(
        resolveCommandPathForPlatform(
          'powershell',
          'win32',
          {
            PATH: [fakeSystem32, fakePowerShellHostDir].join(';'),
            PATHEXT: '.EXE;.CMD;.PS1',
          },
        ),
        powershellExe,
      );
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
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
      const calls: Array<{
        command: string;
        args: readonly string[];
        options?: { windowsVerbatimArguments?: boolean; windowsHide?: boolean };
      }> = [];

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
        (((command: string, args: readonly string[], options?: { windowsVerbatimArguments?: boolean }) => {
          calls.push({ command, args, options });
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
      assert.equal(calls[0]?.options?.windowsVerbatimArguments, true);
      assert.equal(calls[0]?.options?.windowsHide, true);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('does not force verbatim arguments for direct Windows executables', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-spawn-exe-'));
    try {
      const exePath = join(fakeBin, 'tmux.exe');
      await writeFile(exePath, '');
      const calls: Array<{
        command: string;
        args: readonly string[];
        options?: { windowsVerbatimArguments?: boolean; windowsHide?: boolean };
      }> = [];

      spawnPlatformCommandSync(
        'tmux',
        ['-V'],
        { encoding: 'utf-8' },
        'win32',
        {
          PATH: fakeBin,
          PATHEXT: '.EXE;.CMD',
        },
        undefined,
        (((command: string, args: readonly string[], options?: { windowsVerbatimArguments?: boolean }) => {
          calls.push({ command, args, options });
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

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.command, exePath);
      assert.equal(calls[0]?.options?.windowsVerbatimArguments, undefined);
      assert.equal(calls[0]?.options?.windowsHide, true);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('passes a real PowerShell executable when launching Windows ps1 shims', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-platform-spawn-ps1-'));
    try {
      const fakeBin = join(fakeRoot, 'npm-bin');
      const fakeSystem32 = join(fakeRoot, 'System32');
      const fakeDirectoryMatch = join(fakeSystem32, 'powershell');
      const fakePowerShellHostDir = join(fakeRoot, 'WindowsPowerShell', 'v1.0');
      const ps1Path = join(fakeBin, 'codex.ps1');
      const powershellExe = join(fakePowerShellHostDir, 'powershell.exe');
      const calls: Array<{
        command: string;
        args: readonly string[];
      }> = [];

      await mkdir(fakeBin, { recursive: true });
      await mkdir(fakeDirectoryMatch, { recursive: true });
      await mkdir(fakePowerShellHostDir, { recursive: true });
      await writeFile(ps1Path, '');
      await writeFile(powershellExe, '');

      const probed = spawnPlatformCommandSync(
        'codex',
        ['--version'],
        { encoding: 'utf-8' },
        'win32',
        {
          PATH: [fakeBin, fakeSystem32, fakePowerShellHostDir].join(';'),
          PATHEXT: '.EXE;.CMD;.PS1',
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

      assert.equal(probed.spec.command, powershellExe);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.command, powershellExe);
      assert.deepEqual(calls[0]?.args.slice(0, 5), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
      assert.equal(calls[0]?.args[5], ps1Path);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it('launches Windows cmd shims successfully with the real spawn implementation', async () => {
    if (process.platform !== 'win32') return;

    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-platform-spawn-real-'));
    try {
      const cmdPath = join(fakeBin, 'codex.cmd');
      await writeFile(cmdPath, '@echo off\r\necho fake-codex 1.2.3\r\n');

      const probed = spawnPlatformCommandSync(
        'codex',
        ['--version'],
        { encoding: 'utf-8' },
        'win32',
        {
          ...process.env,
          PATH: [fakeBin, process.env.PATH || process.env.Path || ''].filter(Boolean).join(';'),
          PATHEXT: '.CMD;.EXE',
          ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        },
      );

      assert.equal(probed.result.status, 0, probed.result.stderr);
      assert.equal((probed.result.stdout || '').trim(), 'fake-codex 1.2.3');
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
