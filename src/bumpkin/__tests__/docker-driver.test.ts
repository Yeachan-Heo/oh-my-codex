import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DockerWorkerDriver, type SpawnFn } from '../workers/docker-driver.js';

function makeFakeSpawn(
  scripts: Array<{
    matches: (cmd: string, args: readonly string[]) => boolean;
    code: number;
    stdout?: string;
    stderr?: string;
  }>,
): { spawn: SpawnFn; calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    const script = scripts.find((s) => s.matches(cmd, args));
    if (!script) throw new Error(`no script matched ${cmd} ${args.join(' ')}`);

    const stdoutE = new EventEmitter();
    const stderrE = new EventEmitter();
    const mainE = new EventEmitter();

    setImmediate(() => {
      if (script.stdout) stdoutE.emit('data', Buffer.from(script.stdout));
      if (script.stderr) stderrE.emit('data', Buffer.from(script.stderr));
      mainE.emit('close', script.code);
    });

    return {
      stdout: {
        on(_event: 'data', cb: (chunk: Buffer) => void) {
          stdoutE.on('data', cb);
        },
      },
      stderr: {
        on(_event: 'data', cb: (chunk: Buffer) => void) {
          stderrE.on('data', cb);
        },
      },
      on(event: 'close' | 'error', cb: (arg: number | null | Error) => void) {
        mainE.on(event, cb as (arg: unknown) => void);
      },
    };
  };
  return { spawn, calls };
}

describe('bumpkin/docker-driver', () => {
  it('spawn() runs `docker run` with the correct flags', async () => {
    const { spawn, calls } = makeFakeSpawn([
      {
        matches: (cmd, args) => cmd === 'docker' && args[0] === 'run',
        code: 0,
        stdout: 'container-id\n',
      },
    ]);
    const driver = new DockerWorkerDriver({ spawn });
    await driver.spawn({
      image: 'node:20',
      workspacePath: '/ws',
      env: { NODE_ENV: 'test' },
    });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.cmd, 'docker');
    assert.equal(call.args[0], 'run');
    assert.ok(call.args.includes('-v'));
    assert.ok(call.args.includes('/ws:/workspace'));
    assert.ok(call.args.includes('-w'));
    assert.ok(call.args.includes('/workspace'));
    assert.ok(call.args.includes('-e'));
    assert.ok(call.args.includes('NODE_ENV=test'));
    assert.ok(call.args.includes('node:20'));
  });

  it('spawn() throws when docker run exits non-zero', async () => {
    const { spawn } = makeFakeSpawn([
      {
        matches: (cmd, args) => cmd === 'docker' && args[0] === 'run',
        code: 125,
        stderr: 'image not found',
      },
    ]);
    const driver = new DockerWorkerDriver({ spawn });
    await assert.rejects(
      () => driver.spawn({ image: 'missing:tag', workspacePath: '/ws' }),
      /docker run failed.*image not found/,
    );
  });

  it('exec() delegates to `docker exec` and returns the result', async () => {
    const { spawn, calls } = makeFakeSpawn([
      {
        matches: (cmd, args) => cmd === 'docker' && args[0] === 'run',
        code: 0,
      },
      {
        matches: (cmd, args) => cmd === 'docker' && args[0] === 'exec',
        code: 0,
        stdout: 'hello\n',
      },
    ]);
    const driver = new DockerWorkerDriver({ spawn });
    const worker = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    const result = await worker.exec('echo', ['hello']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'hello\n');
    const execCall = calls[1];
    assert.ok(execCall);
    assert.deepEqual(execCall.args.slice(0, 2), ['exec', worker.id]);
  });

  it('close() invokes `docker stop` then `docker rm`', async () => {
    const { spawn, calls } = makeFakeSpawn([
      { matches: (cmd, args) => cmd === 'docker' && args[0] === 'run', code: 0 },
      { matches: (cmd, args) => cmd === 'docker' && args[0] === 'stop', code: 0 },
      { matches: (cmd, args) => cmd === 'docker' && args[0] === 'rm', code: 0 },
    ]);
    const driver = new DockerWorkerDriver({ spawn });
    const worker = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    await worker.close();
    assert.equal(calls[1]?.args[0], 'stop');
    assert.equal(calls[2]?.args[0], 'rm');
  });

  it('exec() after close() throws', async () => {
    const { spawn } = makeFakeSpawn([
      { matches: (cmd, args) => cmd === 'docker' && args[0] === 'run', code: 0 },
      { matches: (cmd, args) => cmd === 'docker' && args[0] === 'stop', code: 0 },
      { matches: (cmd, args) => cmd === 'docker' && args[0] === 'rm', code: 0 },
    ]);
    const driver = new DockerWorkerDriver({ spawn });
    const worker = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    await worker.close();
    await assert.rejects(() => worker.exec('ls', []), /closed/);
  });
});
