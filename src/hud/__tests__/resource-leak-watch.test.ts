import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWatchMode } from '../index.js';

describe('HUD watch resource cleanup', () => {
  it('unregisters SIGINT handlers when stopped to avoid listener leaks', async () => {
    let sigintHandler: (() => void) | undefined;
    let unregisterCalls = 0;
    const fakeTimer = Symbol('timer') as unknown as ReturnType<typeof setInterval>;

    await runWatchMode('/tmp/project', { watch: true, json: false, tmux: false }, {
      isTTY: true,
      env: {},
      readHudConfigFn: async () => ({ preset: 'minimal', git: { display: 'repo-branch' }, statusLine: { preset: 'minimal' } }),
      readAllStateFn: async () => ({ cwd: '/tmp/project', config: {}, state: {}, timestamp: '2026-05-21T00:00:00.000Z' }) as never,
      renderHudFn: () => 'hud',
      runAuthorityTickFn: async () => { sigintHandler?.(); },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => {
        sigintHandler = handler;
        return () => { unregisterCalls += 1; };
      },
      setIntervalFn: () => fakeTimer,
      clearIntervalFn: (timer) => assert.equal(timer, fakeTimer),
    });

    assert.equal(unregisterCalls, 1);
  });
});
