import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { main, resolveCliInvocation } from '../index.js';

afterEach(() => {
  process.exitCode = undefined;
});

describe('omx sidecar CLI', () => {
  it('resolves sidecar as a first-class CLI command', () => {
    assert.deepEqual(resolveCliInvocation(['sidecar', 'demo']), { command: 'sidecar', launchArgs: [] });
  });

  it('routes local sidecar help to the sidecar command', async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (message?: unknown) => { logs.push(String(message)); };
    try {
      await main(['sidecar', '--help']);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('omx sidecar <team-name> --tmux')));
  });
});
