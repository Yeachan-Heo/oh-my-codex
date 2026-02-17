import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-team-nudge-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
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
  echo "%2 12346"
  exit 0
fi
exit 0
`;
}

function runNotifyHook(
  cwd: string,
  fakeBinDir: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-test',
    'turn-id': `turn-${Date.now()}`,
    'input-messages': ['test'],
    'last-assistant-message': 'output',
  };

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      OMX_TEAM_LEADER_NUDGE_MS: '10000',
      OMX_TEAM_LEADER_STALE_MS: '10000',
      OMX_TEAM_WORKER: '',
      TMUX: '',
      TMUX_PANE: '',
      ...extraEnv,
    },
  });
}

describe('notify-hook team leader nudge', () => {
  it('nudges leader via tmux send-keys when team is active and mailbox has messages', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'alpha';
      const teamDir = join(stateDir, 'team', teamName);
      const mailboxDir = join(teamDir, 'mailbox');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'm1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'ACK',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys/);
      assert.match(tmuxLog, /-t devsess:0/);
      assert.match(tmuxLog, /Team alpha:/);
    });
  });

  it('nudges when worker panes are alive and leader is stale (no recent HUD turn)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'beta';
      const teamDir = join(stateDir, 'team', teamName);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(join(teamDir, 'mailbox'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-beta',
      });

      // Leader HUD state is stale (last turn 5 minutes ago)
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      });

      // No mailbox messages — but worker panes alive should trigger nudge
      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys/);
      assert.match(tmuxLog, /Team beta:/);
      assert.match(tmuxLog, /leader stale/);
      assert.match(tmuxLog, /pane\(s\) still active/);
    });
  });

  it('emits team_leader_nudge event to events.ndjson when nudge fires', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'gamma';
      const teamDir = join(stateDir, 'team', teamName);
      const eventsDir = join(teamDir, 'events');
      const mailboxDir = join(teamDir, 'mailbox');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(eventsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-gamma',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'msg-99',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'Task complete',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      // Verify event was written
      const eventsPath = join(eventsDir, 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist after nudge');
      const eventsContent = await readFile(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type: string }) => e.type === 'team_leader_nudge');
      assert.ok(nudgeEvent, 'should have a team_leader_nudge event');
      assert.equal(nudgeEvent.team, teamName);
      assert.equal(nudgeEvent.worker, 'leader-fixed');
      assert.ok(nudgeEvent.reason, 'event should have a reason');
    });
  });

  it('does not nudge when no active team state exists', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // No team-state.json — no active team
      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      // tmux log should not contain display-message for any team nudge
      const hasLog = existsSync(tmuxLogPath);
      if (hasLog) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /Team .+: leader stale/);
      }
    });
  });

  it('includes stale_leader_with_messages reason when both conditions met', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'delta';
      const teamDir = join(stateDir, 'team', teamName);
      const eventsDir = join(teamDir, 'events');
      const mailboxDir = join(teamDir, 'mailbox');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(eventsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-delta',
      });

      // Leader stale
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 3,
      });

      // Mailbox has messages
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'combo-msg',
            from_worker: 'worker-2',
            to_worker: 'leader-fixed',
            body: 'done',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /leader stale/);
      assert.match(tmuxLog, /msg\(s\) pending/);

      // Verify event reason
      const eventsPath = join(eventsDir, 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const eventsContent = await readFile(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type: string }) => e.type === 'team_leader_nudge');
      assert.ok(nudgeEvent);
      assert.equal(nudgeEvent.reason, 'stale_leader_with_messages');
    });
  });
});
