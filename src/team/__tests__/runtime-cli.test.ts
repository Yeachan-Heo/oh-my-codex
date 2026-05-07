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
  it('accepts inline JSON payloads without consuming stdin', async () => {
    const runtimeCli = await loadRuntimeCliModule();
    const base64Payload = Buffer.from(
      '{"teamName":"alpha","task":"quote \\"this\\" & keep 100%"}',
      'utf-8',
    ).toString('base64url');

    assert.equal(
      runtimeCli.resolveRuntimeCliInlineInput(['--input-json', '{"teamName":"alpha"}']),
      '{"teamName":"alpha"}',
    );
    assert.equal(
      runtimeCli.resolveRuntimeCliInlineInput(['--input-json-base64', base64Payload]),
      '{"teamName":"alpha","task":"quote \\"this\\" & keep 100%"}',
    );
    assert.equal(runtimeCli.resolveRuntimeCliInlineInput([]), null);
    assert.throws(
      () => runtimeCli.resolveRuntimeCliInlineInput(['--input-json']),
      /Missing JSON payload for --input-json/,
    );
    assert.throws(
      () => runtimeCli.resolveRuntimeCliInlineInput(['--input-json-base64']),
      /Missing JSON payload for --input-json-base64/,
    );
  });

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
    assert.equal(
      runtimeCli.resolveRuntimeCliProviderMap(undefined, 2),
      null,
    );
    assert.equal(
      runtimeCli.resolveRuntimeCliProviderMap(['claude'], 2),
      'claude',
    );
    assert.equal(
      runtimeCli.resolveRuntimeCliAgentType(undefined),
      'executor',
    );
    assert.equal(
      runtimeCli.resolveRuntimeCliAgentType('test-engineer'),
      'test-engineer',
    );
    assert.deepEqual(
      runtimeCli.resolveRuntimeCliMissingFields({
        teamName: 'alpha',
        workerCount: 2,
        tasks: [{ subject: 'task', description: 'desc' }],
        cwd: '/tmp/repo',
      }),
      [],
    );
    assert.deepEqual(
      runtimeCli.resolveRuntimeCliMissingFields({
        teamName: 'alpha',
        tasks: [{ subject: 'task', description: 'desc' }],
        cwd: '/tmp/repo',
      }),
      ['workerCount or agentTypes'],
    );
    assert.throws(
      () => runtimeCli.normalizeAgentTypes(['codex', 'invalid'], 2),
      /Expected codex\\|claude\\|gemini/,
    );
  });

  it('prefers the explicit task transport over joined subtask subjects and falls back when absent', async () => {
    const runtimeCli = await loadRuntimeCliModule();

    assert.equal(
      runtimeCli.resolveRuntimeCliTask({
        task: 'Execute approved demo plan',
        tasks: [
          { subject: 'Implement runtime', description: 'Change runtime' },
          { subject: 'Verify runtime', description: 'Cover runtime' },
        ],
      }),
      'Execute approved demo plan',
    );
    assert.equal(
      runtimeCli.resolveRuntimeCliTask({
        tasks: [
          { subject: 'Implement runtime', description: 'Change runtime' },
          { subject: 'Verify runtime', description: 'Cover runtime' },
        ],
      }),
      'Implement runtime; Verify runtime',
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

  it('reads task results from explicit OMX_TEAM_STATE_ROOT during shutdown collection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-env-root-cwd-'));
    const explicitStateRoot = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-env-root-state-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    process.env.OMX_TEAM_STATE_ROOT = explicitStateRoot;
    try {
      await initTeamState('env-root-results', 'task', 'executor', 1, cwd);
      await createTask('env-root-results', {
        subject: 'completed task',
        description: 'stored under explicit state root',
        status: 'completed',
        owner: 'worker-1',
        result: 'PASS: explicit root task result',
      }, cwd);

      const runtimeCli = await loadRuntimeCliModule();
      const stateRoot = runtimeCli.resolveRuntimeCliStateRoot(cwd);
      assert.equal(stateRoot, explicitStateRoot);
      assert.deepEqual(
        runtimeCli.collectTaskResults(stateRoot, 'env-root-results'),
        [{
          taskId: '1',
          status: 'completed',
          summary: 'PASS: explicit root task result',
        }],
      );
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(explicitStateRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
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

  it('does not auto-force failed-task shutdown without explicit issue confirmation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-confirm-issues-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('shutdown-confirm-required', 'task', 'executor', 1, cwd);
      await createTask('shutdown-confirm-required', {
        subject: 'failed task',
        description: 'requires confirmation',
        status: 'failed',
      }, cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'shutdown-confirm-required');
      assert.equal(existsSync(teamRoot), true);

      const runtimeCli = await loadRuntimeCliModule();
      await assert.rejects(
        () => runtimeCli.shutdownWithForceFallback('shutdown-confirm-required', cwd),
        /shutdown_confirm_issues_required:failed=1/,
      );

      assert.equal(existsSync(teamRoot), true);
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

  it('preserves team state when building terminal output for completed teams', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-preserve-complete-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      await initTeamState('runtime-cli-preserve-complete', 'task', 'executor', 1, cwd);
      await createTask('runtime-cli-preserve-complete', {
        subject: 'done task',
        description: 'already complete',
        status: 'completed',
        owner: 'worker-1',
        result: 'PASS: complete without shutdown',
      }, cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'runtime-cli-preserve-complete');
      assert.equal(existsSync(teamRoot), true);

      const runtimeCli = await loadRuntimeCliModule();
      const result = runtimeCli.buildTerminalCliResult(
        runtimeCli.resolveRuntimeCliStateRoot(cwd),
        'runtime-cli-preserve-complete',
        'complete',
        1,
        Date.now() - 1_000,
      );

      assert.equal(existsSync(teamRoot), true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.output.status, 'completed');
      assert.equal(result.output.teamName, 'runtime-cli-preserve-complete');
      assert.deepEqual(result.output.taskResults, [{
        taskId: '1',
        status: 'completed',
        summary: 'PASS: complete without shutdown',
      }]);
      assert.match(result.notice, /preserving team state/i);
      assert.match(result.notice, /omx team shutdown runtime-cli-preserve-complete/);
      assert.match(result.notice, /omx team api read-stall-state/);
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves team state when building terminal output for failed teams', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-preserve-failed-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      await initTeamState('runtime-cli-preserve-failed', 'task', 'executor', 1, cwd);
      await createTask('runtime-cli-preserve-failed', {
        subject: 'failed task',
        description: 'needs postmortem',
        status: 'failed',
        owner: 'worker-1',
        result: 'FAIL: worker crashed',
      }, cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'runtime-cli-preserve-failed');
      assert.equal(existsSync(teamRoot), true);

      const runtimeCli = await loadRuntimeCliModule();
      const result = runtimeCli.buildTerminalCliResult(
        runtimeCli.resolveRuntimeCliStateRoot(cwd),
        'runtime-cli-preserve-failed',
        'failed',
        1,
        Date.now() - 1_000,
      );

      assert.equal(existsSync(teamRoot), true);
      assert.equal(result.exitCode, 1);
      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.teamName, 'runtime-cli-preserve-failed');
      assert.deepEqual(result.output.taskResults, [{
        taskId: '1',
        status: 'failed',
        summary: 'FAIL: worker crashed',
      }]);
      assert.match(result.notice, /preserving team state/i);
      assert.match(result.notice, /omx team api read-stall-state/);
      assert.match(result.notice, /omx team shutdown runtime-cli-preserve-failed/);
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports cancelled terminal phases without deleting team state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-cli-preserve-cancelled-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      await initTeamState('runtime-cli-preserve-cancelled', 'task', 'executor', 1, cwd);
      await createTask('runtime-cli-preserve-cancelled', {
        subject: 'cancelled task',
        description: 'team stopped for inspection',
        status: 'blocked',
      }, cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'runtime-cli-preserve-cancelled');
      assert.equal(existsSync(teamRoot), true);

      const runtimeCli = await loadRuntimeCliModule();
      const result = runtimeCli.buildTerminalCliResult(
        runtimeCli.resolveRuntimeCliStateRoot(cwd),
        'runtime-cli-preserve-cancelled',
        'cancelled',
        1,
        Date.now() - 1_000,
      );

      assert.equal(existsSync(teamRoot), true);
      assert.equal(result.exitCode, 1);
      assert.equal(result.output.status, 'failed');
      assert.match(result.notice, /phase=cancelled/);
      assert.match(result.notice, /omx team shutdown runtime-cli-preserve-cancelled/);
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


  it('does not treat leader pane as a worker pane for dead-worker detection', async () => {
    const runtimeCli = await loadRuntimeCliModule();

    const result = runtimeCli.detectDeadWorkerFailure(1, 1, true, 'team-exec');
    assert.equal(result.deadWorkerFailure, true);
    assert.equal(result.fixingWithNoWorkers, false);
  });
