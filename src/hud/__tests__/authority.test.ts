import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runHudAuthorityTick } from '../authority.js';

describe('runHudAuthorityTick', () => {
  it('writes a live HUD authority owner lease before ticking', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-'));
    try {
      await runHudAuthorityTick(
        { cwd, nodePath: '/node', packageRoot: '/pkg' },
        { runProcess: async () => {} },
      );

      const lease = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'notify-fallback-authority-owner.json'), 'utf-8'));
      assert.equal(lease.owner, 'hud');
      assert.equal(lease.pid, process.pid);
      assert.equal(lease.cwd, cwd);
      assert.ok(typeof lease.heartbeat_at === 'string' && lease.heartbeat_at.length > 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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
      '/pkg/dist/scripts/notify-fallback-watcher.js',
      '--once',
      '--authority-only',
      '--cwd',
      '/tmp/project',
      '--notify-script',
      '/pkg/dist/scripts/notify-hook.js',
      '--poll-ms',
      '75',
    ]);
    assert.equal(call.options.cwd, '/tmp/project');
    assert.equal(call.options.timeoutMs, 4321);
    assert.equal(call.options.env.OMX_HUD_AUTHORITY, '1');
    assert.equal(call.options.env.CUSTOM_ENV, '1');
  });

  it('surfaces authority child stderr on failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-hud-authority-failure-'));
    try {
      mkdirSync(join(cwd, 'dist', 'scripts'), { recursive: true });
      const failingScript = join(cwd, 'dist', 'scripts', 'notify-fallback-watcher.js');
      writeFileSync(failingScript, "console.error('notify script missing during rebuild'); process.exit(1);\n");

      await assert.rejects(
        runHudAuthorityTick({
          cwd,
          nodePath: process.execPath,
          packageRoot: cwd,
          timeoutMs: 1000,
        }),
        /notify script missing during rebuild/,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces nonzero authority child status when the child is silent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-hud-authority-silent-failure-'));
    try {
      mkdirSync(join(cwd, 'dist', 'scripts'), { recursive: true });
      const failingScript = join(cwd, 'dist', 'scripts', 'notify-fallback-watcher.js');
      writeFileSync(failingScript, 'process.exit(1);\n');

      await assert.rejects(
        runHudAuthorityTick({
          cwd,
          nodePath: process.execPath,
          packageRoot: cwd,
          timeoutMs: 1000,
        }),
        /hud authority tick failed with status 1/,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
