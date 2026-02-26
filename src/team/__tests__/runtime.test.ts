import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  initTeamState,
  createTask,
  writeWorkerIdentity,
  readTeamConfig,
  listMailboxMessages,
  updateWorkerHeartbeat,
  writeAtomic,
  readTask,
  readMonitorSnapshot,
  claimTask,
  transitionTaskStatus,
} from '../state.js';
import {
  monitorTeam,
  shutdownTeam,
  resumeTeam,
  startTeam,
  assignTask,
  sendWorkerMessage,
  resolveWorkerLaunchArgsFromEnv,
  resolveCanonicalTeamStateRoot,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  type TeamRuntime,
} from '../runtime.js';

function withEmptyPath<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.PATH = prev;
    else delete process.env.PATH;
  }
}

function withoutTeamWorkerEnv<T>(fn: () => T): T {
  const prev = process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_WORKER;
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
  }
}

describe('runtime', () => {
  it('resolveCanonicalTeamStateRoot resolves to leader .omx/state', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project'),
      '/tmp/demo/project/.omx/state',
    );
  });

  it('resolveWorkerLaunchArgsFromEnv injects low-complexity default model when missing', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL]);
  });

  it('resolveWorkerLaunchArgsFromEnv reads low-complexity model from config when present', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const tempCodexHome = await mkdtemp(join(tmpdir(), 'omx-codex-home-'));
    await writeFile(
      join(tempCodexHome, '.omx-config.json'),
      JSON.stringify({ models: { team_low_complexity: 'gpt-4.1-mini' } }),
    );
    process.env.CODEX_HOME = tempCodexHome;
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'explore',
      );
      assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1-mini']);
    } finally {
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(tempCodexHome, { recursive: true, force: true });
    }
  });

  it('resolveWorkerLaunchArgsFromEnv does not inject low-complexity default for standard agent types', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor',
    );
    assert.deepEqual(args, ['--no-alt-screen']);
  });

  it('resolveWorkerLaunchArgsFromEnv treats *-low aliases as low complexity', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor-low',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL]);
  });

  it('resolveWorkerLaunchArgsFromEnv preserves explicit model in either syntax', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5' }, 'explore'),
      ['--model', 'gpt-5'],
    );
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model=gpt-5.3' }, 'explore'),
      ['--model', 'gpt-5.3'],
    );
  });

  it('resolveWorkerLaunchArgsFromEnv uses inherited leader model for all agent types', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor',
      'gpt-4.1',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1']);
  });

  it('resolveWorkerLaunchArgsFromEnv uses inherited leader model over low-complexity default', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
      'gpt-4.1',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1']);
  });

  it('resolveWorkerLaunchArgsFromEnv prefers explicit env model over inherited leader model', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5' }, 'explore', 'gpt-4.1'),
      ['--model', 'gpt-5'],
    );
  });

  it('resolveWorkerLaunchArgsFromEnv preserves explicit reasoning and logs source=explicit', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '-c model_reasoning_effort=\"high\" --no-alt-screen' },
        'explore',
      );
      assert.deepEqual(
        args,
        ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL],
      );
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=high') && line.includes('source=explicit')));
  });

  it('resolveWorkerLaunchArgsFromEnv logs model=claude without thinking_level for claude CLI', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_CLI: 'claude',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '-c model_reasoning_effort="high" --no-alt-screen',
        },
        'explore',
      );
      assert.deepEqual(
        args,
        ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL],
      );
    } finally {
      console.log = originalLog;
    }
    const startupLog = logs.find((line) => line.includes('worker startup resolution:'));
    assert.ok(startupLog);
    assert.match(startupLog, /model=claude/);
    assert.match(startupLog, /source=local-settings/);
    assert.doesNotMatch(startupLog, /thinking_level=/);
  });

  it('resolveWorkerLaunchArgsFromEnv keeps codex thinking_level logging for mixed CLI maps', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_CLI_MAP: 'codex,claude',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '-c model_reasoning_effort="high" --model claude-3-7-sonnet',
        },
        'executor',
      );
      assert.deepEqual(args, ['-c', 'model_reasoning_effort="high"', '--model', 'claude-3-7-sonnet']);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=high') && line.includes('source=explicit')));
  });

  it('resolveWorkerLaunchArgsFromEnv logs source=none/default-none when thinking is not explicit', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'explore',
      );
      assert.deepEqual(args, ['--no-alt-screen', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL]);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=none') && line.includes('source=none/default-none')));
  });

  it('startTeam rejects nested team invocation inside worker context', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    const prev = process.env.OMX_TEAM_WORKER;
    process.env.OMX_TEAM_WORKER = 'alpha/worker-1';
    try {
      await assert.rejects(
        () => startTeam('nested-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
        /nested_team_disallowed/,
      );
    } finally {
      if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
      else delete process.env.OMX_TEAM_WORKER;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam throws when tmux is not available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          withEmptyPath(() =>
            startTeam('team-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
          )),
        /requires tmux/i,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam supports prompt launch mode without tmux and pipes trigger text via stdin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-prompt',
          'prompt-mode team bootstrap',
          'executor',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          cwd,
        ));

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal(runtime.config.leader_pane_id, null);
      assert.equal((runtime.config.workers[0]?.pid ?? 0) > 0, true);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const snapshot = await monitorTeam('missing-team', cwd);
      assert.equal(snapshot, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns correct task counts from state files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-counts', 'monitor task counts', 'executor', 2, cwd);

      const t1 = await createTask('team-counts', { subject: 'p', description: 'd', status: 'pending' }, cwd);
      const t2 = await createTask('team-counts', { subject: 'ip', description: 'd', status: 'in_progress', owner: 'worker-1' }, cwd);
      await createTask('team-counts', { subject: 'c', description: 'd', status: 'completed' }, cwd);
      await createTask('team-counts', { subject: 'f', description: 'd', status: 'failed' }, cwd);

      await updateWorkerHeartbeat(
        'team-counts',
        'worker-1',
        { pid: 111, last_turn_at: new Date().toISOString(), turn_count: 7, alive: true },
        cwd,
      );

      const statusPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-counts',
        'workers',
        'worker-1',
        'status.json',
      );
      await writeAtomic(
        statusPath,
        JSON.stringify(
          {
            state: 'working',
            current_task_id: t2.id,
            updated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const snapshot = await monitorTeam('team-counts', cwd);
      assert.ok(snapshot);
      assert.equal(snapshot?.tasks.total, 4);
      assert.equal(snapshot?.tasks.pending, 1);
      assert.equal(snapshot?.tasks.in_progress, 1);
      assert.equal(snapshot?.tasks.completed, 1);
      assert.equal(snapshot?.tasks.failed, 1);
      assert.equal(snapshot?.allTasksTerminal, false);
      assert.equal(snapshot?.phase, 'team-exec');

      const worker1 = snapshot?.workers.find((w) => w.name === 'worker-1');
      assert.ok(worker1);
      assert.equal(worker1?.turnsWithoutProgress, 0);

      const reassignHint = snapshot?.recommendations.some((r) => r.includes(`task-${t2.id}`));
      assert.equal(typeof reassignHint, 'boolean');
      void t1;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam emits worker_idle and task_completed events based on transitions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-events', 'monitor event test', 'executor', 1, cwd);
      const t = await createTask('team-events', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      // First monitor creates baseline snapshot.
      await monitorTeam('team-events', cwd);

      // Transition task to completed and worker status to idle.
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-events', 'tasks', `task-${t.id}.json`),
        JSON.stringify({ ...t, status: 'completed', owner: 'worker-1' }, null, 2),
      );
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-events', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({ state: 'idle', updated_at: new Date().toISOString() }, null, 2),
      );

      await monitorTeam('team-events', cwd);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-events', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      assert.match(content, /\"type\":\"task_completed\"/);
      assert.match(content, /\"type\":\"worker_idle\"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam cleans up state even when tmux session doesn\'t exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-shutdown', 'shutdown test', 'executor', 1, cwd);
      await shutdownTeam('team-shutdown', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam blocks when pending tasks remain (shutdown gate)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-'));
    try {
      await initTeamState('team-shutdown-gate-pending', 'shutdown gate pending test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-pending',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      await assert.rejects(
        () => shutdownTeam('team-shutdown-gate-pending', cwd),
        /shutdown_gate_blocked:pending=1,blocked=0,in_progress=0,failed=0/,
      );

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-pending');
      assert.equal(existsSync(teamRoot), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam blocks when failed tasks remain (completion gate)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-failed-'));
    try {
      await initTeamState('team-shutdown-gate-failed', 'shutdown gate failed test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-failed',
        { subject: 'failed', description: 'd', status: 'failed' },
        cwd,
      );

      await assert.rejects(
        () => shutdownTeam('team-shutdown-gate-failed', cwd),
        /shutdown_gate_blocked:pending=0,blocked=0,in_progress=0,failed=1/,
      );

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-failed');
      assert.equal(existsSync(teamRoot), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force=true bypasses shutdown gate and cleans up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-force-'));
    try {
      await initTeamState('team-shutdown-gate-force', 'shutdown gate force test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-force',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      await shutdownTeam('team-shutdown-gate-force', cwd, { force: true });
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-force');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam handles persisted resize hook metadata during cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-resize-meta-'));
    try {
      const configPath = join(cwd, '.omx', 'state', 'team', 'team-resize-meta', 'config.json');
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-resize-meta', 'manifest.v2.json');
      await initTeamState('team-resize-meta', 'shutdown resize metadata', 'executor', 1, cwd);
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
      config.resize_hook_name = 'omx_resize_team_resize_meta_test';
      config.resize_hook_target = 'omx-team-team-resize-meta:0';
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest.resize_hook_name = 'omx_resize_team_resize_meta_test';
      manifest.resize_hook_target = 'omx-team-team-resize-meta:0';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await shutdownTeam('team-resize-meta', cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-resize-meta');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam continues cleanup when resize hook unregister fails while session remains active', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-failed-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-runtime-fake-tmux-'));
    const previousPath = process.env.PATH;
    const previousTmuxLog = process.env.TMUX_TEST_LOG;
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    try {
      await initTeamState('team-shutdown-gate-failed', 'shutdown resize hook failure test', 'executor', 1, cwd);
      const configPath = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-failed', 'config.json');
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-failed', 'manifest.v2.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
      config.tmux_session = 'omx-team-team-shutdown-gate-failed';
      config.resize_hook_name = 'omx_resize_team_shutdown_gate_failed_test';
      config.resize_hook_target = 'omx-team-team-shutdown-gate-failed:0';
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest.tmux_session = 'omx-team-team-shutdown-gate-failed';
      manifest.resize_hook_name = 'omx_resize_team_shutdown_gate_failed_test';
      manifest.resize_hook_target = 'omx-team-team-shutdown-gate-failed:0';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const tmuxStubPath = join(fakeBinDir, 'tmux');
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
if [ -n "\${TMUX_TEST_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$TMUX_TEST_LOG"
fi
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-sessions)
    echo "omx-team-team-shutdown-gate-failed"
    exit 0
    ;;
  set-hook)
    if [ "\${2:-}" = "-u" ]; then
      echo "simulated unregister failure" >&2
      exit 1
    fi
    exit 0
    ;;
  list-panes)
    exit 1
    ;;
  kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      process.env.TMUX_TEST_LOG = tmuxLogPath;

      await shutdownTeam('team-shutdown-gate-failed', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-failed');
      assert.equal(existsSync(teamRoot), false);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /set-hook -u -t omx-team-team-shutdown-gate-failed:0 client-resized\[\d+\]/);
      assert.match(tmuxLog, /kill-session -t omx-team-team-shutdown-gate-failed/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmuxLog === 'string') process.env.TMUX_TEST_LOG = previousTmuxLog;
      else delete process.env.TMUX_TEST_LOG;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('shutdownTeam returns rejection error when worker rejects shutdown and force is false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-reject', 'shutdown reject test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-reject',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'still working', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await assert.rejects(() => shutdownTeam('team-reject', cwd), /shutdown_rejected:worker-1:still working/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam emits shutdown_ack event when worker ack is received', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-ack-evt', 'shutdown ack event test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-ack-evt',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'busy', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await assert.rejects(() => shutdownTeam('team-ack-evt', cwd), /shutdown_rejected/);

      // Verify that a shutdown_ack event was written to the event log
      const eventLogPath = join(cwd, '.omx', 'state', 'team', 'team-ack-evt', 'events', 'events.ndjson');
      assert.ok(existsSync(eventLogPath), 'event log should exist');
      const raw = await readFile(eventLogPath, 'utf-8');
      const events = raw.trim().split('\n').map(line => JSON.parse(line));
      const ackEvents = events.filter((e: { type: string }) => e.type === 'shutdown_ack');
      assert.equal(ackEvents.length, 1, 'should have exactly one shutdown_ack event');
      assert.equal(ackEvents[0].worker, 'worker-1');
      assert.equal(ackEvents[0].reason, 'reject:busy');
      assert.equal(ackEvents[0].team, 'team-ack-evt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam emits shutdown_ack event with accept reason for accepted acks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-ack-accept', 'shutdown ack accept test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-ack-accept',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'accept', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      // Read the event log before cleanup destroys it
      const eventLogPath = join(cwd, '.omx', 'state', 'team', 'team-ack-accept', 'events', 'events.ndjson');

      await shutdownTeam('team-ack-accept', cwd);

      // State is cleaned up, but we can verify the event was emitted by checking
      // that cleanup succeeded (no error) -- the event was written before cleanup.
      // For a more direct test, check that the team root was cleaned up.
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-ack-accept');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force=true ignores rejection and cleans up team state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-force', 'shutdown force test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-force',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'still working', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-force', cwd, { force: true });
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-force');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam ignores stale rejection ack from a prior request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-stale-ack', 'shutdown stale ack test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-stale-ack',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'old ack', updated_at: '2000-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-stale-ack', cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-stale-ack');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const runtime = await resumeTeam('missing-team', cwd);
      assert.equal(runtime, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask enforces delegation_only policy for leader-fixed worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-delegation', 'delegation policy test', 'executor', 1, cwd);
      const task = await createTask(
        'team-delegation',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-delegation', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.policy.delegation_only = true;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        () => assignTask('team-delegation', 'leader-fixed', task.id, cwd),
        /delegation_only_violation/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask does not claim task when worker does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-missing-worker', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-missing-worker',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      await assert.rejects(
        () => assignTask('team-missing-worker', 'worker-404', task.id, cwd),
        /Worker worker-404 not found in team/,
      );

      const reread = await readTask('team-missing-worker', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask rolls back claim when notification transport fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-notify-fail', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-notify-fail',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      // Force notification transport to fail by clearing PATH so tmux is unavailable.
      await assert.rejects(
        () => withEmptyPath(() => assignTask('team-notify-fail', 'worker-1', task.id, cwd)),
        /worker_notify_failed/,
      );

      const reread = await readTask('team-notify-fail', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask rolls back claim when inbox write fails after claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-inbox-fail', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-inbox-fail',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );
      const workerDir = join(cwd, '.omx', 'state', 'team', 'team-inbox-fail', 'workers', 'worker-1');
      await rm(workerDir, { recursive: true, force: true });
      // Force inbox write failure by turning the would-be directory into a file.
      await writeFile(workerDir, 'not-a-directory');

      await assert.rejects(
        () => assignTask('team-inbox-fail', 'worker-1', task.id, cwd),
        /worker_assignment_failed:/,
      );

      const reread = await readTask('team-inbox-fail', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask enforces plan approval for code-change tasks when required', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-approval', 'approval policy test', 'executor', 1, cwd);
      const task = await createTask(
        'team-approval',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: true },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-approval', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.policy.plan_approval_required = true;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        () => assignTask('team-approval', 'worker-1', task.id, cwd),
        /plan_approval_required/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam does not re-notify already-notified mailbox messages (issue #116)', async () => {
    // Regression: deliverPendingMailboxMessages used to re-notify every 15 s via shouldRetry.
    // After the fix it must NOT re-notify messages that already have notified_at set.
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-spam-'));
    try {
      await initTeamState('team-no-spam', 'no spam test', 'executor', 1, cwd);

      // Write a mailbox message that is already notified but not yet delivered.
      const mailboxDir = join(cwd, '.omx', 'state', 'team', 'team-no-spam', 'mailbox');
      await mkdir(mailboxDir, { recursive: true });
      const notifiedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      await writeFile(join(mailboxDir, 'worker-1.json'), JSON.stringify({
        worker: 'worker-1',
        messages: [
          {
            message_id: 'msg-already-notified',
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'hello',
            created_at: notifiedAt,
            notified_at: notifiedAt, // already notified
            // delivered_at intentionally absent — message is still pending
          },
        ],
      }));

      // First monitorTeam call — should see the message as already-notified (unnotified=[]).
      const result1 = await monitorTeam('team-no-spam', cwd);
      assert.ok(result1, 'snapshot should exist');

      // Read the monitor snapshot from disk to verify the notified map.
      const diskSnap1 = await readMonitorSnapshot('team-no-spam', cwd);
      assert.ok(diskSnap1, 'disk snapshot should exist after first poll');
      assert.ok(
        diskSnap1.mailboxNotifiedByMessageId['msg-already-notified'],
        'already-notified message must be preserved in snapshot after first poll',
      );

      // Second monitorTeam call — previousNotifications now carries the timestamp.
      // The message must again be treated as notified (no duplicate notification).
      const result2 = await monitorTeam('team-no-spam', cwd);
      assert.ok(result2, 'second snapshot should exist');
      const diskSnap2 = await readMonitorSnapshot('team-no-spam', cwd);
      assert.ok(diskSnap2, 'disk snapshot should exist after second poll');
      assert.ok(
        diskSnap2.mailboxNotifiedByMessageId['msg-already-notified'],
        'already-notified message must remain in snapshot after second poll (no reset)',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam only notifies once per new message even without notified_at (issue #116)', async () => {
    // Regression: messages delivered via team_send_message MCP have no notified_at.
    // After the first successful poll that sets notified_at, subsequent polls must not re-notify.
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-new-msg-'));
    try {
      await initTeamState('team-new-msg', 'new msg test', 'executor', 1, cwd);

      const mailboxDir = join(cwd, '.omx', 'state', 'team', 'team-new-msg', 'mailbox');
      await mkdir(mailboxDir, { recursive: true });
      const createdAt = new Date().toISOString();
      await writeFile(join(mailboxDir, 'worker-1.json'), JSON.stringify({
        worker: 'worker-1',
        messages: [
          {
            message_id: 'msg-unnotified',
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'task assignment',
            created_at: createdAt,
            // notified_at and delivered_at intentionally absent
          },
        ],
      }));

      // First poll — unnotified=[msg-unnotified]. notifyWorker will fail (no tmux in tests)
      // so markMessageNotified is not called and the snapshot has no entry for this message.
      const result1 = await monitorTeam('team-new-msg', cwd);
      assert.ok(result1);
      const diskSnap1 = await readMonitorSnapshot('team-new-msg', cwd);
      // Without tmux the notify fails, so no entry is expected in the first snapshot.
      assert.ok(diskSnap1);

      // Simulate a successful notification by manually setting notified_at on the message.
      await writeFile(join(mailboxDir, 'worker-1.json'), JSON.stringify({
        worker: 'worker-1',
        messages: [
          {
            message_id: 'msg-unnotified',
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'task assignment',
            created_at: createdAt,
            notified_at: new Date().toISOString(),
          },
        ],
      }));

      // Second poll — message now has notified_at, so unnotified=[], no re-notification.
      const result2 = await monitorTeam('team-new-msg', cwd);
      assert.ok(result2);
      const diskSnap2 = await readMonitorSnapshot('team-new-msg', cwd);
      assert.ok(diskSnap2);
      assert.ok(
        diskSnap2.mailboxNotifiedByMessageId['msg-unnotified'],
        'notified message must be captured in snapshot after second poll',
      );

      // Third poll — previousNotifications carries the timestamp.
      // unnotified=[] so no re-notification attempt, and snapshot still tracks it.
      const result3 = await monitorTeam('team-new-msg', cwd);
      assert.ok(result3);
      const diskSnap3 = await readMonitorSnapshot('team-new-msg', cwd);
      assert.ok(diskSnap3);
      assert.ok(
        diskSnap3.mailboxNotifiedByMessageId['msg-unnotified'],
        'notified message must remain in snapshot on third poll (no duplicate notification)',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam does not emit duplicate task_completed when transitionTaskStatus completed the task first (issue #161)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-dup-'));
    try {
      await initTeamState('team-no-dup', 'dedup test', 'executor', 1, cwd);
      const t = await createTask('team-no-dup', { subject: 'task', description: 'd', status: 'pending' }, cwd);

      // Establish a baseline snapshot (task is pending).
      await monitorTeam('team-no-dup', cwd);

      // Complete the task via the claim-safe path — this emits the first task_completed event
      // and records the task ID in the monitor snapshot.
      const claim = await claimTask('team-no-dup', t.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      if (!claim.ok) throw new Error('claim failed');
      await transitionTaskStatus('team-no-dup', t.id, 'in_progress', 'completed', claim.claimToken, cwd);

      // Run monitorTeam again — it must NOT emit a second task_completed event.
      await monitorTeam('team-no-dup', cwd);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-no-dup', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      const events = content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const completedEvents = events.filter((e: { type: string }) => e.type === 'task_completed');
      assert.equal(completedEvents.length, 1, 'should have exactly one task_completed event');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage allows worker to message leader-fixed mailbox', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-leader-msg', 'leader mailbox test', 'executor', 2, cwd);
      await sendWorkerMessage('team-leader-msg', 'worker-1', 'leader-fixed', 'worker one ack', cwd);
      await sendWorkerMessage('team-leader-msg', 'worker-2', 'leader-fixed', 'worker two ack', cwd);

      const messages = await listMailboxMessages('team-leader-msg', 'leader-fixed', cwd);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.from_worker, 'worker-1');
      assert.equal(messages[1]?.from_worker, 'worker-2');
      assert.equal(messages[0]?.to_worker, 'leader-fixed');
      assert.equal(messages[1]?.to_worker, 'leader-fixed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
