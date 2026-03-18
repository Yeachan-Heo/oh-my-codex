import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runHudAuthorityTick } from '../authority.js';

describe('runHudAuthorityTick', () => {
  it('invokes fallback watcher in authority-only mode with HUD env', async () => {
    const calls: Array<{
      nodePath: string;
      args: string[];
      options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };
    }> = [];

    await runHudAuthorityTick(
      {
        cwd: '/tmp/project',
        nodePath: '/node',
        packageRoot: '/pkg',
        pollMs: 75,
        timeoutMs: 4321,
        env: { CUSTOM_ENV: '1' },
      },
      {
        runProcess: async (
          nodePath: string,
          args: string[],
          options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
        ) => {
          calls.push({ nodePath, args, options });
        },
      },
    );

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.nodePath, '/node');
    assert.deepEqual(call.args, [
      '/pkg/scripts/notify-fallback-watcher.js',
      '--once',
      '--authority-only',
      '--cwd',
      '/tmp/project',
      '--notify-script',
      '/pkg/scripts/notify-hook.js',
      '--poll-ms',
      '75',
    ]);
    assert.equal(call.options.cwd, '/tmp/project');
    assert.equal(call.options.timeoutMs, 4321);
    assert.equal(call.options.env.OMX_HUD_AUTHORITY, '1');
    assert.equal(call.options.env.CUSTOM_ENV, '1');
  });
});
