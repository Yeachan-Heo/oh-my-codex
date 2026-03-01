import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initTeamState, createTask, readTeamConfig, saveTeamConfig } from '../state.js';

async function loadRuntimeCliModule() {
  process.env.OMX_RUNTIME_CLI_DISABLE_AUTO_START = '1';
  return await import('../runtime-cli.js');
}

describe('runtime-cli helpers', () => {
  it('refreshes pane targets from live team config after scale changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-live-'));
    try {
      await initTeamState('live-refresh', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('live-refresh', cwd);
      assert.ok(config);
      if (!config) return;

      config.leader_pane_id = '%900';
      config.workers[0]!.pane_id = '%101';
      config.workers[1]!.pane_id = '%102';
      await saveTeamConfig(config, cwd);

      const runtimeCli = await loadRuntimeCliModule();
      const before = await runtimeCli.loadLivePaneState('live-refresh', cwd);
      assert.deepEqual(before, {
        paneIds: ['%101', '%102'],
        leaderPaneId: '%900',
      });

      config.workers = [config.workers[0]!];
      config.workers[0]!.pane_id = '%777';
      await saveTeamConfig(config, cwd);

      const after = await runtimeCli.loadLivePaneState('live-refresh', cwd);
      assert.deepEqual(after, {
        paneIds: ['%777'],
        leaderPaneId: '%900',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('computes dead-worker failure from live pane count, not startup snapshot', async () => {
    const runtimeCli = await loadRuntimeCliModule();

    const staleSnapshotBehavior = runtimeCli.detectDeadWorkerFailure(2, 3, true, 'team-exec');
    assert.equal(staleSnapshotBehavior.deadWorkerFailure, false);

    const liveBehavior = runtimeCli.detectDeadWorkerFailure(2, 2, true, 'team-exec');
    assert.equal(liveBehavior.deadWorkerFailure, true);
    assert.equal(liveBehavior.fixingWithNoWorkers, false);
  });

  it('falls back to forced shutdown when graceful shutdown is blocked', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-shutdown-'));
    try {
      await initTeamState('shutdown-fallback', 'task', 'executor', 1, cwd);
      await createTask('shutdown-fallback', {
        subject: 'pending task',
        description: 'blocks graceful shutdown',
        status: 'pending',
      }, cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'shutdown-fallback');
      assert.equal(existsSync(teamRoot), true);

      const runtimeCli = await loadRuntimeCliModule();
      await runtimeCli.shutdownWithForceFallback('shutdown-fallback', cwd);

      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
