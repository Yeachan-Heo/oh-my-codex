import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryWorkerDriver } from '../workers/in-memory-driver.js';

describe('bumpkin/in-memory-driver', () => {
  it('spawns workers with unique ids and the requested workspace path', async () => {
    const driver = new InMemoryWorkerDriver();
    const a = await driver.spawn({ image: 'node:20', workspacePath: '/ws/a' });
    const b = await driver.spawn({ image: 'node:20', workspacePath: '/ws/b' });
    assert.notEqual(a.id, b.id);
    assert.equal(a.workspacePath, '/ws/a');
    assert.equal(b.workspacePath, '/ws/b');
    assert.equal(driver.spawned.length, 2);
  });

  it('exec returns canned responses based on command', async () => {
    const driver = new InMemoryWorkerDriver({
      respond: (cmd) => {
        if (cmd === 'npm') return { code: 0, stdout: 'installed', stderr: '' };
        return { code: 127, stdout: '', stderr: 'command not found' };
      },
    });
    const w = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    const ok = await w.exec('npm', ['install']);
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout, 'installed');
    const bad = await w.exec('missing', []);
    assert.equal(bad.code, 127);
  });

  it('exec falls back to defaultResult when no respond fn is set', async () => {
    const driver = new InMemoryWorkerDriver({
      defaultResult: { code: 0, stdout: 'noop', stderr: '' },
    });
    const w = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    const r = await w.exec('echo', ['hi']);
    assert.equal(r.stdout, 'noop');
  });

  it('records every exec call in worker.log', async () => {
    const driver = new InMemoryWorkerDriver();
    const w = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    await w.exec('ls', ['-la']);
    await w.exec('pwd', []);
    const log = (w as unknown as { log: Array<{ cmd: string; args: readonly string[] }> }).log;
    assert.deepEqual(log, [
      { cmd: 'ls', args: ['-la'] },
      { cmd: 'pwd', args: [] },
    ]);
  });

  it('exec throws after close()', async () => {
    const driver = new InMemoryWorkerDriver();
    const w = await driver.spawn({ image: 'node:20', workspacePath: '/ws' });
    await w.close();
    await assert.rejects(() => w.exec('ls', []), /closed/);
  });
});
