import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-worker-idle-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function buildFakeTmux(tmuxLogPath: string): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
}

function runNotifyHookAsWorker(
  cwd: string,
  fakeBinDir: string,
  workerEnv: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-worker',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'input-messages': ['working'],
    'last-assistant-message': 'task done',
  };

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      OMX_TEAM_WORKER: workerEnv,
      OMX_TEAM_WORKER_IDLE_COOLDOWN_MS: '500',
      OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '600000', // suppress all-idle to isolate per-worker
      TMUX: '',
      TMUX_PANE: '',
      // Isolate from inherited team env (same pattern as all-workers-idle tests)
      OMX_TEAM_STATE_ROOT: '',
      OMX_TEAM_LEADER_CWD: '',
      ...extraEnv,
    },
  });
}

describe('notify-hook per-worker idle notification', () => {
  it('fires notification on working->idle transition', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'idle-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Worker is now idle
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        current_task_id: 'task-42',
        reason: 'task complete',
        updated_at: new Date().toISOString(),
      });

      // Previous state was working
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys/, 'should use send-keys to notify leader');
      assert.match(tmuxLog, /worker-1 idle/, 'should include worker name in message');
      assert.match(tmuxLog, /was: working/, 'should include previous state');
      assert.match(tmuxLog, /task: task-42/, 'should include task id');
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');
    });
  });

  it('does not fire when worker was already idle (idle->idle)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'no-transition';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Worker is idle
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      // Previous state was also idle
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'idle',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'should NOT fire for idle->idle');
      }
    });
  });

  it('does not fire when worker is still working', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'still-working';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Worker is still working
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'should NOT fire when worker is not idle');
      }
    });
  });

  it('respects per-worker cooldown', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'cooldown-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Worker is idle with working->idle transition
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      // Pre-populate cooldown state with a recent notification
      await writeJson(join(workersDir, 'worker-1', 'worker-idle-notify.json'), {
        last_notified_at_ms: Date.now() - 100, // 100ms ago
        last_notified_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_WORKER_IDLE_COOLDOWN_MS: '600000', // 10 minute cooldown
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'cooldown should block per-worker idle notification');
      }
    });
  });

  it('can be disabled via OMX_TEAM_WORKER_IDLE_NOTIFY=false', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'disabled-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Working->idle transition
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_WORKER_IDLE_NOTIFY: 'false',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'should NOT fire when disabled');
      }
    });
  });

  it('can be disabled via OMX_TEAM_WORKER_IDLE_NOTIFY=0', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'disabled-zero';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      });

      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_WORKER_IDLE_NOTIFY: '0',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'should NOT fire when disabled with 0');
      }
    });
  });

  it('can be disabled via OMX_TEAM_WORKER_IDLE_NOTIFY=off', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'disabled-off';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      });

      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_WORKER_IDLE_NOTIFY: 'off',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'should NOT fire when disabled with off');
      }
    });
  });

  it('writes worker_idle event to events.ndjson', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'event-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const eventsDir = join(teamDir, 'events');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(eventsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        current_task_id: 'task-99',
        reason: 'finished',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const eventsPath = join(eventsDir, 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const content = await readFile(eventsPath, 'utf-8');
      const events = content.trim().split('\n').map(line => JSON.parse(line));
      const workerIdleEvent = events.find((e: { type: string }) => e.type === 'worker_idle');
      assert.ok(workerIdleEvent, 'should have a worker_idle event');
      assert.equal(workerIdleEvent.team, teamName);
      assert.equal(workerIdleEvent.worker, 'worker-1');
      assert.equal(workerIdleEvent.prev_state, 'working');
      assert.equal(workerIdleEvent.task_id, 'task-99');
      assert.equal(workerIdleEvent.reason, 'finished');
      assert.ok(workerIdleEvent.event_id, 'event should have an event_id');
      assert.ok(workerIdleEvent.created_at, 'event should have a created_at');
    });
  });

  it('targets leader_pane_id when available', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'pane-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        leader_pane_id: '%55',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /-t %55/, 'should target leader pane when available');
      assert.doesNotMatch(tmuxLog, /-t devsess:0/, 'should not target session when leader pane is available');
    });
  });

  it('does not fire for leader (non-team-worker) context', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'leader-test';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      // Run as LEADER (no OMX_TEAM_WORKER env var)
      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-leader',
        'turn-id': `turn-${Date.now()}`,
        'input-messages': ['leader turn'],
        'last-assistant-message': 'done',
      };
      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_WORKER: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'leader context should not send per-worker idle notification');
      }
    });
  });

  it('does not fire on first invocation when no prev state file exists (unknown->idle)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'first-run';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Worker is idle, but NO prev-notify-state.json exists
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'should NOT fire on unknown->idle transition');
      }
    });
  });

  it('does not fire when worker status is stale', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'stale-status';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      });

      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        pid: 123,
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
        alive: true,
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker-1 idle/, 'stale status should suppress worker-idle notification');
      }
    });
  });

  it('existing all-workers-idle hook still fires alongside per-worker', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const teamName = 'both-hooks';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Single worker: working->idle transition should fire BOTH hooks
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'prev-notify-state.json'), {
        state: 'working',
        updated_at: new Date(Date.now() - 5000).toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '500', // re-enable all-idle
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /worker-1 idle/, 'per-worker idle should fire');
      assert.match(tmuxLog, /All 1 worker idle/, 'all-workers-idle should also fire');
    });
  });
});
