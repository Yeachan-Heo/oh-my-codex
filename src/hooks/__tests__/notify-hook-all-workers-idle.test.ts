import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-all-idle-'));
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
      OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '500', // short cooldown for tests
      TMUX: '',
      TMUX_PANE: '',
      ...extraEnv,
    },
  });
}

describe('notify-hook all-workers-idle notification', () => {
  it('sends notification to leader when all workers are idle', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'myteam';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Team config with 2 workers
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Both workers are idle
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys/, 'should use send-keys to notify leader');
      assert.match(tmuxLog, /-t devsess:0/, 'should target the leader tmux session');
      assert.match(tmuxLog, /\[OMX\] All 2 workers idle/, 'should include all-workers-idle message');
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');
    });
  });

  it('targets leader pane id when leader_pane_id is present', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'pane-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:8',
        leader_pane_id: '%99',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /-t %99/, 'should target leader pane when available');
      assert.doesNotMatch(tmuxLog, /-t devsess:8/, 'should not target session when leader pane is available');
    });
  });

  it('does not notify when some workers are still working', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'busy-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      // worker-1 is idle, worker-2 is still working
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'working',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      // Should not send the all-workers-idle notification
      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'should NOT send all-idle message when some workers are busy');
      }
    });
  });

  it('does not notify when a worker heartbeat is stale', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stale-heartbeat';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        pid: 123,
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
        alive: true,
      });

      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-2', 'heartbeat.json'), {
        pid: 456,
        last_turn_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        turn_count: 1,
        alive: true,
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'stale heartbeat should suppress all-workers-idle notification');
      }
    });
  });

  it('does not notify when current worker is not idle', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'active-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:1',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // worker-1 is working (not idle) - should not trigger
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
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
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/);
      }
    });
  });

  it('respects cooldown: does not send repeated notifications', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'cooldown-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:2',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      // Pre-populate cooldown state with a recent notification
      await writeJson(join(teamDir, 'all-workers-idle.json'), {
        last_notified_at_ms: Date.now() - 100, // 100ms ago — well within cooldown
        last_notified_at: new Date().toISOString(),
        worker_count: 1,
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      // Use a long cooldown (10 minutes) so the 100ms-old entry blocks the notification
      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '600000',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'cooldown should block repeated notification');
      }
    });
  });

  it('writes all_workers_idle event to events.ndjson', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'event-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const eventsDir = join(teamDir, 'events');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(eventsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-event',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const eventsPath = join(eventsDir, 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist after notification');
      const content = await readFile(eventsPath, 'utf-8');
      const events = content.trim().split('\n').map(line => JSON.parse(line));
      const idleEvent = events.find((e: { type: string }) => e.type === 'all_workers_idle');
      assert.ok(idleEvent, 'should have an all_workers_idle event');
      assert.equal(idleEvent.team, teamName);
      assert.equal(idleEvent.worker, 'worker-1');
      assert.equal(idleEvent.worker_count, 2);
      assert.ok(idleEvent.event_id, 'event should have an event_id');
      assert.ok(idleEvent.created_at, 'event should have a created_at timestamp');
    });
  });

  it('does not fire for leader (non-team-worker) context', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'leader-test';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:3',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
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
          OMX_TEAM_WORKER: '', // empty = not a worker
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'leader context should not send all-idle notification');
      }
    });
  });

  it('handles single worker team correctly with singular message', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'solo-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'solo-session:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /\[OMX\] All 1 worker idle/, 'single worker uses singular form');
      assert.doesNotMatch(tmuxLog, /All 1 workers idle/, 'should not use plural for single worker');
    });
  });

  it('uses manifest.v2.json over config.json when both present', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'manifest-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Write BOTH config.json and manifest.v2.json
      // They differ in tmux_session — manifest should win
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'wrong-session:0',
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      });
      await writeJson(join(teamDir, 'manifest.v2.json'), {
        schema_version: 2,
        name: teamName,
        task: 'test',
        leader: { session_id: '', worker_id: 'leader-fixed', role: 'coordinator' },
        policy: { display_mode: 'auto', delegation_only: false, plan_approval_required: false, nested_teams_allowed: false, one_team_per_leader_session: true, cleanup_requires_all_workers_inactive: true },
        permissions_snapshot: { approval_mode: 'unknown', sandbox_mode: 'unknown', network_access: true },
        tmux_session: 'correct-session:1',
        worker_count: 1,
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
        next_task_id: 1,
        created_at: new Date().toISOString(),
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /-t correct-session:1/, 'should use tmux_session from manifest.v2.json');
      assert.doesNotMatch(tmuxLog, /wrong-session/, 'should not use tmux_session from config.json');
    });
  });
});
