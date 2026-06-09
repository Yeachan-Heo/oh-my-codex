import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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

  it('does not materialize authority state under a deleted cwd marker path', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-hud-authority-deleted-marker-'));
    const deletedMarkerCwd = join(parent, 'doctor-smoke (deleted)');
    try {
      let invoked = false;
      await runHudAuthorityTick(
        { cwd: deletedMarkerCwd, nodePath: '/node', packageRoot: '/pkg' },
        {
          runProcess: async () => {
            invoked = true;
          },
        },
      );

      assert.equal(invoked, false);
      assert.equal(existsSync(join(deletedMarkerCwd, '.omx', 'state')), false);
      assert.equal(existsSync(deletedMarkerCwd), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('writes authority state under a real existing cwd that literally ends with the marker text', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-hud-authority-live-marker-'));
    const liveMarkerCwd = join(parent, 'real workspace (deleted)');
    mkdirSync(liveMarkerCwd);
    try {
      let invoked = false;
      await runHudAuthorityTick(
        { cwd: liveMarkerCwd, nodePath: '/node', packageRoot: '/pkg' },
        {
          runProcess: async () => {
            invoked = true;
          },
        },
      );

      assert.equal(invoked, true);
      const lease = JSON.parse(readFileSync(join(liveMarkerCwd, '.omx', 'state', 'notify-fallback-authority-owner.json'), 'utf-8'));
      assert.equal(lease.cwd, liveMarkerCwd);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('invokes fallback watcher in authority-only mode with HUD env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-env-'));
    const calls: Array<{
      nodePath: string;
      args: string[];
      options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };
    }> = [];

    try {
      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
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
      assert.equal(call.args.length, 9);
      assert.equal(typeof call.args[0], 'string');
      assert.equal(call.args[0].endsWith('/dist/scripts/notify-fallback-watcher.js'), true);
      assert.equal(call.args[1], '--once');
      assert.equal(call.args[2], '--authority-only');
      assert.equal(call.args[3], '--cwd');
      assert.equal(call.args[4], cwd);
      assert.equal(call.args[5], '--notify-script');
      assert.equal(call.args[6].endsWith('/dist/scripts/notify-hook.js'), true);
      assert.equal(call.args[7], '--poll-ms');
      assert.equal(call.args[8], '75');
      assert.equal(call.options.cwd, cwd);
      assert.equal(call.options.timeoutMs, 4321);
      assert.equal(call.options.env.OMX_HUD_AUTHORITY, '1');
      assert.equal(call.options.env.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS, '5000');
      assert.equal(call.options.env.OMX_HUD_AUTHORITY_JITTER_MS, '250');
      assert.equal(call.options.env.CUSTOM_ENV, '1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to CLI entry dist scripts when package root lacks dist scripts', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'omx-hud-package-root-no-dist-'));
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-entry-fallback-'));
    const cliRoot = await mkdtemp(join(tmpdir(), 'omx-cli-root-'));
    const entryPath = join(cliRoot, 'dist', 'cli', 'omx.js');
    const watcherPath = join(cliRoot, 'dist', 'scripts', 'notify-fallback-watcher.js');
    const hookPath = join(cliRoot, 'dist', 'scripts', 'notify-hook.js');
    try {
      await mkdir(join(cliRoot, 'dist', 'scripts'), { recursive: true });
      writeFileSync(watcherPath, 'console.log("cli entry watcher")\n');
      writeFileSync(hookPath, 'console.log("cli entry notify hook")\n');

      const calls: Array<{
        nodePath: string;
        args: string[];
        options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };
      }> = [];
      const env = { OMX_ENTRY_PATH: entryPath };

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot,
          env,
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
      assert.equal(calls[0]!.args[0], watcherPath);
      assert.equal(calls[0]!.args[6], hookPath);
      assert.equal(calls[0]!.options.env.OMX_HUD_AUTHORITY, '1');
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(cliRoot, { recursive: true, force: true });
    }
  });

  it('rate-limits repeated HUD authority watcher spawns and records diagnostics', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-rate-limit-'));
    const calls: Array<string[]> = [];
    try {
      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 1_000,
          random: () => 0,
          runProcess: async (_nodePath, args) => {
            calls.push(args);
          },
        },
      );
      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 2_000,
          random: () => 0,
          runProcess: async (_nodePath, args) => {
            calls.push(args);
          },
        },
      );

      assert.equal(calls.length, 1, 'second HUD frame should not respawn an authority-only child');
      const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'notify-fallback-authority-state.json'), 'utf-8'));
      assert.equal(state.last_status, 'skipped');
      assert.equal(state.last_reason, 'rate_limited');
      assert.equal(state.skip_count, 1);
      assert.equal(state.last_spawn_at, new Date(1_000).toISOString());
      assert.equal(state.next_allowed_at, new Date(6_000).toISOString());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows HUD authority watcher spawn after the rate-limit window elapses', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-rate-limit-elapsed-'));
    let calls = 0;
    try {
      for (const now of [1_000, 7_000]) {
        await runHudAuthorityTick(
          {
            cwd,
            nodePath: '/node',
            packageRoot: '/pkg',
            minIntervalMs: 5_000,
            jitterMs: 0,
          },
          {
            nowMs: () => now,
            random: () => 0,
            runProcess: async () => {
              calls += 1;
            },
          },
        );
      }

      assert.equal(calls, 2);
      const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'notify-fallback-authority-state.json'), 'utf-8'));
      assert.equal(state.last_status, 'spawned');
      assert.equal(state.last_spawn_at, new Date(7_000).toISOString());
      assert.equal(state.next_allowed_at, new Date(12_000).toISOString());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves cooldown when a contender observes the rate limit only after taking the lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-race-'));
    const statePath = join(cwd, '.omx', 'state', 'notify-fallback-authority-state.json');
    let calls = 0;
    try {
      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 1_000,
          random: () => 0,
          runProcess: async () => {
            calls += 1;
          },
        },
      );
      const spawnedState = JSON.parse(await readFile(statePath, 'utf-8'));
      await writeFile(statePath, JSON.stringify({ ...spawnedState, next_allowed_at: new Date(0).toISOString() }, null, 2));

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 2_000,
          random: () => 0,
          onLockAcquired: async () => {
            await writeFile(statePath, JSON.stringify(spawnedState, null, 2));
          },
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 1, 'contender should re-check cooldown after locking and skip spawning');
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(state.last_status, 'skipped');
      assert.equal(state.last_reason, 'rate_limited_after_lock');
      assert.equal(state.next_allowed_at, new Date(6_000).toISOString());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not let a lock loser overwrite canonical cooldown diagnostics', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-lock-loser-'));
    const stateDir = join(cwd, '.omx', 'state');
    const statePath = join(stateDir, 'notify-fallback-authority-state.json');
    const ownerPath = join(stateDir, 'notify-fallback-authority-owner.json');
    const lockPath = join(stateDir, 'notify-fallback-authority.lock');
    const canonicalState = {
      owner: 'hud',
      pid: process.pid,
      cwd,
      heartbeat_at: new Date(1_000).toISOString(),
      last_spawn_at: new Date(1_000).toISOString(),
      next_allowed_at: new Date(6_000).toISOString(),
      cooldown_ms: 5_000,
      jitter_ms: 0,
      skip_count: 0,
      last_status: 'spawned',
      last_reason: 'spawned',
    };
    try {
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(lockPath);
      await writeFile(statePath, JSON.stringify(canonicalState, null, 2));

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 7_000,
          random: () => 0,
          runProcess: async () => {
            assert.fail('lock loser must not spawn');
          },
        },
      );

      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(state.last_status, 'spawned');
      assert.equal(state.next_allowed_at, canonicalState.next_allowed_at);
      const owner = JSON.parse(await readFile(ownerPath, 'utf-8'));
      assert.equal(owner.last_status, 'locked');
      assert.equal(owner.last_reason, 'spawn_lock_active');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not release a lock that was replaced by a newer owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-token-release-'));
    const lockPath = join(cwd, '.omx', 'state', 'notify-fallback-authority.lock');
    let calls = 0;
    try {
      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 1_000,
          random: () => 0,
          onLockAcquired: async () => {
            await rm(lockPath, { recursive: true, force: true });
            await mkdir(lockPath, { recursive: true });
            await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ token: 'newer-owner' }, null, 2));
          },
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 1);
      assert.equal(existsSync(lockPath), true, 'stale releaser must not remove a newer lock owner');
      const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf-8'));
      assert.equal(owner.token, 'newer-owner');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reaps a stale authority lock before acquiring a fresh lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-stale-lock-'));
    const lockPath = join(cwd, '.omx', 'state', 'notify-fallback-authority.lock');
    let calls = 0;
    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ token: 'stale-owner' }, null, 2));
      const staleDate = new Date(1_000);
      await utimes(lockPath, staleDate, staleDate);

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
          timeoutMs: 1_000,
        },
        {
          nowMs: () => 10_000,
          random: () => 0,
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 1);
      assert.equal(existsSync(lockPath), false, 'fresh authority lock should be released after successful spawn');
      const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'notify-fallback-authority-state.json'), 'utf-8'));
      assert.equal(state.last_status, 'spawned');
      assert.equal(state.next_allowed_at, new Date(15_000).toISOString());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed before spawning when the rate-limit state cannot be persisted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-persist-failure-'));
    let calls = 0;
    try {
      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 1_000,
          random: () => 0,
          onLockAcquired: async () => {
            await rm(join(cwd, '.omx', 'state'), { recursive: true, force: true });
            await writeFile(join(cwd, '.omx', 'state'), 'not a directory');
          },
          runProcess: async () => {
            calls += 1;
          },
        },
      ).then(
        () => assert.fail('expected persistence failure'),
        (error) => assert.match(String(error), /failed to persist HUD authority rate-limit state/),
      );

      assert.equal(calls, 0, 'authority child should not spawn without durable rate-limit state');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed without spawning when the authority state is unreadable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-invalid-state-'));
    const stateDir = join(cwd, '.omx', 'state');
    const statePath = join(stateDir, 'notify-fallback-authority-state.json');
    let calls = 0;
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(statePath, '{not valid json');

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 1_000,
          random: () => 0,
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 0, 'authority child should not spawn when cooldown state cannot be trusted');
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(state.last_status, 'failed');
      assert.equal(state.last_reason, 'invalid_authority_state');
      assert.equal(state.next_allowed_at, new Date(6_000).toISOString());
      assert.match(state.last_error, /failed to read HUD authority state/);

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 2_000,
          random: () => 0,
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 0, 'repaired invalid-state diagnostic should still enforce cooldown on the next tick');
      const skippedState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(skippedState.last_status, 'skipped');
      assert.equal(skippedState.last_reason, 'rate_limited');
      assert.equal(skippedState.next_allowed_at, new Date(6_000).toISOString());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed without spawning when the authority state has an invalid shape', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-authority-invalid-shape-'));
    const stateDir = join(cwd, '.omx', 'state');
    const statePath = join(stateDir, 'notify-fallback-authority-state.json');
    let calls = 0;
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(statePath, JSON.stringify({}));

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 1_000,
          random: () => 0,
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 0, 'authority child should not spawn when parsed state shape cannot be trusted');
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(state.last_status, 'failed');
      assert.equal(state.last_reason, 'invalid_authority_state');
      assert.equal(state.next_allowed_at, new Date(6_000).toISOString());
      assert.match(state.last_error, /authority state owner must be hud/);

      await writeFile(statePath, JSON.stringify({ ...state, next_allowed_at: 'not-a-date' }));

      await runHudAuthorityTick(
        {
          cwd,
          nodePath: '/node',
          packageRoot: '/pkg',
          minIntervalMs: 5_000,
          jitterMs: 0,
        },
        {
          nowMs: () => 2_000,
          random: () => 0,
          runProcess: async () => {
            calls += 1;
          },
        },
      );

      assert.equal(calls, 0, 'authority child should not spawn when next_allowed_at is malformed');
      const repairedState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(repairedState.last_status, 'failed');
      assert.equal(repairedState.last_reason, 'invalid_authority_state');
      assert.equal(repairedState.next_allowed_at, new Date(7_000).toISOString());
      assert.match(repairedState.last_error, /next_allowed_at must be a valid ISO timestamp/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
