import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { initTeamState, createTask, readTeamConfig, saveTeamConfig } from '../state.js';

async function loadRuntimeCliModule() {
  process.env.OMX_RUNTIME_CLI_DISABLE_AUTO_START = '1';
  return await import('../runtime-cli.js');
}

async function createRefreshFixture(): Promise<{
  root: string;
  memoryRoot: string;
  scriptPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-refresh-'));
  const memoryRoot = join(root, 'memory');
  const scriptPath = join(root, 'scripts', 'refresh_memory.py');
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(scriptPath, '#!/usr/bin/env python3\n', 'utf-8');
  return { root, memoryRoot, scriptPath };
}

describe('runtime-cli helpers', () => {
  it('normalizes per-worker providers and validates supported values', async () => {
    const runtimeCli = await loadRuntimeCliModule();

    assert.deepEqual(
      runtimeCli.normalizeAgentTypes(['codex', 'gemini'], 2),
      ['codex', 'gemini'],
    );
    assert.deepEqual(
      runtimeCli.normalizeAgentTypes(['gemini'], 3),
      ['gemini'],
    );
    assert.throws(
      () => runtimeCli.normalizeAgentTypes(['codex', 'invalid'], 2),
      /Expected codex\\|claude\\|gemini/,
    );
  });

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

  it('does not treat leader pane as a worker pane for dead-worker detection', async () => {
    const runtimeCli = await loadRuntimeCliModule();

    const result = runtimeCli.detectDeadWorkerFailure(1, 1, true, 'team-exec');
    assert.equal(result.deadWorkerFailure, true);
    assert.equal(result.fixingWithNoWorkers, false);
  });

  it('gracefully shuts down only when the leader explicitly requests shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-shutdown-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
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
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not auto-shutdown merely because monitorTeam reaches complete', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-complete-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('runtime-cli-complete', 'task', 'executor', 1, cwd);
      await createTask('runtime-cli-complete', {
        subject: 'done task',
        description: 'already complete',
        status: 'completed',
        owner: 'worker-1',
      }, cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'runtime-cli-complete');
      assert.equal(existsSync(teamRoot), true);

      const runtimeCli = await loadRuntimeCliModule();
      const snapshot = await (await import('../runtime.js')).monitorTeam('runtime-cli-complete', cwd);
      assert.equal(snapshot?.phase, 'complete');

      assert.equal(existsSync(teamRoot), true);
      assert.equal(typeof runtimeCli.shutdownWithForceFallback, 'function');
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps team-complete refresh disabled until strict mode and explicit team gate are enabled', async () => {
    const runtimeCli = await loadRuntimeCliModule();

    const disabledStrict = runtimeCli.scheduleFormalMemoryRefreshOnTeamComplete('/repo', 'alpha', {});
    assert.equal(disabledStrict.scheduled, false);
    assert.equal(disabledStrict.reason, 'strict_mode_disabled');

    const disabledGate = runtimeCli.scheduleFormalMemoryRefreshOnTeamComplete('/repo', 'alpha', {
      OMX_STRICT_MEMORY_MODE: '1',
    });
    assert.equal(disabledGate.scheduled, false);
    assert.equal(disabledGate.reason, 'team_completion_refresh_disabled');
  });

  it('schedules detached formal-memory refresh for completed leader teams', async () => {
    const runtimeCli = await loadRuntimeCliModule();
    const fixture = await createRefreshFixture();
    try {
      let captured:
        | {
            command: string;
            args: readonly string[];
            options: {
              cwd: string;
              env: NodeJS.ProcessEnv;
              detached: boolean;
              stdio: 'ignore';
            };
          }
        | undefined;
      let unrefCalled = false;

      const result = runtimeCli.scheduleFormalMemoryRefreshOnTeamComplete(
        '/repo',
        'team-alpha',
        {
          OMX_STRICT_MEMORY_MODE: '1',
          OMX_STRICT_MEMORY_REFRESH_ON_TEAM_COMPLETE: '1',
          OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
          OMX_EXTERNAL_MEMORY_REFRESH_PYTHON: 'python3.12',
        },
        ((command: string, args: readonly string[], options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          detached: boolean;
          stdio: 'ignore';
        }) => {
          captured = { command, args, options };
          return {
            unref() {
              unrefCalled = true;
            },
          };
        }) as never,
      );

      assert.equal(result.scheduled, true);
      assert.equal(captured?.command, 'python3.12');
      assert.deepEqual(captured?.args, [fixture.scriptPath, '--workspace-root', '/repo']);
      assert.equal(captured?.options.env.OMX_EXTERNAL_MEMORY_REFRESH_SOURCE, 'omx-team-runtime-complete');
      assert.equal(captured?.options.env.OMX_EXTERNAL_MEMORY_REFRESH_TEAM_NAME, 'team-alpha');
      assert.equal(captured?.options.detached, true);
      assert.equal(unrefCalled, true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('skips team-complete refresh when the process is marked as a team worker', async () => {
    const runtimeCli = await loadRuntimeCliModule();
    const fixture = await createRefreshFixture();
    try {
      const result = runtimeCli.scheduleFormalMemoryRefreshOnTeamComplete('/repo', 'team-worker', {
        OMX_STRICT_MEMORY_MODE: '1',
        OMX_STRICT_MEMORY_REFRESH_ON_TEAM_COMPLETE: '1',
        OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
        OMX_TEAM_WORKER: 'team-worker/worker-1',
      });
      assert.equal(result.scheduled, false);
      assert.equal(result.reason, 'team_worker_process');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
