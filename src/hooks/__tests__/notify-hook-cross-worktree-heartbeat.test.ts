import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-cross-worktree-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function runWorkerNotify(
  payloadCwd: string,
  teamWorker: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd: payloadCwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-cross-worktree',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'input-messages': ['worktree heartbeat'],
    'last-assistant-message': 'heartbeat',
  };

  const inheritedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OMX_TEAM_WORKER: teamWorker,
    TMUX: '',
    TMUX_PANE: '',
  };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'OMX_TEAM_STATE_ROOT')) {
    delete inheritedEnv.OMX_TEAM_STATE_ROOT;
  }
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'OMX_TEAM_LEADER_CWD')) {
    delete inheritedEnv.OMX_TEAM_LEADER_CWD;
  }

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: { ...inheritedEnv, ...extraEnv },
  });
}

describe('notify-hook cross-worktree heartbeat resolution', () => {
  it('logs only the latest user input preview instead of concatenating prior inputs', async () => {
    await withTempDir(async (root) => {
      const cwd = join(root, 'latest-input-preview');
      await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-latest-preview',
        'turn-id': 'turn-latest-preview',
        'input-messages': ['上一轮 query', '本轮 query'],
        'last-assistant-message': 'ok',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: { ...process.env, TMUX: '', TMUX_PANE: '' },
      });

      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);
      const turnLogPath = join(cwd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const lines = (await readFile(turnLogPath, 'utf8')).trim().split('\n');
      const entry = JSON.parse(lines[lines.length - 1]) as {
        input_preview?: string;
        input_message_count?: number;
      };
      assert.equal(entry.input_preview, '本轮 query');
      assert.equal(entry.input_message_count, 2);
    });
  });

  it('writes heartbeat under OMX_TEAM_STATE_ROOT even when payload cwd is a different worktree', async () => {
    await withTempDir(async (root) => {
      const leaderCwd = join(root, 'leader');
      const workerCwd = join(root, 'worker-worktree');
      const teamName = 'cross-root';
      const workerName = 'worker-1';

      const leaderWorkerDir = join(leaderCwd, '.omx', 'state', 'team', teamName, 'workers', workerName);
      await mkdir(leaderWorkerDir, { recursive: true });
      await mkdir(workerCwd, { recursive: true });
      await writeFile(join(leaderWorkerDir, 'identity.json'), JSON.stringify({
        name: workerName,
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        worktree_path: workerCwd,
        team_state_root: join(leaderCwd, '.omx', 'state'),
      }, null, 2));

      const result = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, {
        OMX_TEAM_STATE_ROOT: join(leaderCwd, '.omx', 'state'),
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const heartbeatPath = join(leaderWorkerDir, 'heartbeat.json');
      assert.equal(existsSync(heartbeatPath), true, 'heartbeat should be written to leader-owned state root');
      const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8')) as { turn_count?: number };
      assert.equal(heartbeat.turn_count, 1);

      const wrongHeartbeatPath = join(workerCwd, '.omx', 'state', 'team', teamName, 'workers', workerName, 'heartbeat.json');
      assert.equal(existsSync(wrongHeartbeatPath), false, 'heartbeat should not be written under worker cwd state root');
    });
  });

  it('keeps leader-owned heartbeat state when worker cwd uses the team worktree layout', async () => {
    await withTempDir(async (root) => {
      const leaderCwd = join(root, 'leader');
      const teamName = 'cross-team-layout';
      const workerName = 'worker-1';
      const workerCwd = join(leaderCwd, '.omx', 'team', teamName, 'worktrees', workerName);

      const leaderWorkerDir = join(leaderCwd, '.omx', 'state', 'team', teamName, 'workers', workerName);
      await mkdir(leaderWorkerDir, { recursive: true });
      await mkdir(workerCwd, { recursive: true });
      await writeFile(join(leaderWorkerDir, 'identity.json'), JSON.stringify({
        name: workerName,
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        worktree_path: workerCwd,
        team_state_root: join(leaderCwd, '.omx', 'state'),
      }, null, 2));

      const result = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, {
        OMX_TEAM_STATE_ROOT: join(leaderCwd, '.omx', 'state'),
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const heartbeatPath = join(leaderWorkerDir, 'heartbeat.json');
      assert.equal(existsSync(heartbeatPath), true, 'heartbeat should still resolve to leader-owned team state');

      const wrongHeartbeatPath = join(workerCwd, '.omx', 'state', 'team', teamName, 'workers', workerName, 'heartbeat.json');
      assert.equal(existsSync(wrongHeartbeatPath), false, 'team worktree cwd should not become the authoritative team state root');
    });
  });

  it('falls back to worker identity/config metadata when OMX_TEAM_STATE_ROOT is absent', async () => {
    await withTempDir(async (root) => {
      const leaderCwd = join(root, 'leader');
      const workerCwd = join(root, 'worker-worktree');
      const teamName = 'cross-meta';
      const workerName = 'worker-1';
      const teamStateRoot = join(leaderCwd, '.omx', 'state');

      const teamRoot = join(teamStateRoot, 'team', teamName);
      const leaderWorkerDir = join(teamRoot, 'workers', workerName);
      await mkdir(leaderWorkerDir, { recursive: true });
      await mkdir(workerCwd, { recursive: true });

      await writeFile(
        join(leaderWorkerDir, 'identity.json'),
        JSON.stringify({
          name: workerName,
          index: 1,
          role: 'executor',
          assigned_tasks: [],
          worktree_path: workerCwd,
          team_state_root: teamStateRoot,
        }, null, 2),
      );

      await writeFile(
        join(teamRoot, 'config.json'),
        JSON.stringify({
          name: teamName,
          tmux_session: 'leader:0',
          workers: [{ name: workerName, index: 1, role: 'executor', assigned_tasks: [] }],
          team_state_root: teamStateRoot,
        }, null, 2),
      );

      const result = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, {
        OMX_TEAM_LEADER_CWD: leaderCwd,
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const heartbeatPath = join(leaderWorkerDir, 'heartbeat.json');
      assert.equal(existsSync(heartbeatPath), true, 'heartbeat should resolve via metadata to leader-owned team state root');
    });
  });
});
