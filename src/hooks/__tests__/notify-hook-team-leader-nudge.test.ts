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
  it('sends immediate all-workers-idle nudge for active team (leader context)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'idle-alpha';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'idle-sess:0',
        leader_pane_id: '%99',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
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

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys/);
      assert.match(tmuxLog, /-t %99/, 'should target leader pane when present');
      assert.match(tmuxLog, /\[OMX\] All 2 workers idle/, 'should emit all-workers-idle nudge');
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const eventsContent = await readFile(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type: string }) => e.type === 'team_leader_nudge');
      assert.ok(nudgeEvent, 'should have team_leader_nudge event');
      assert.equal(nudgeEvent.reason, 'all_workers_idle');
    });
  });

  it('falls back to global team-state when session-scoped state is active but team-state.json remains global', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'sess-idle-fallback';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const teamName = 'idle-global-fallback';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(sessionDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'session.json'), { session_id: sessionId });
      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'idle-global:0',
        leader_pane_id: '%97',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
      });
      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: new Date().toISOString(),
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys/);
      assert.match(tmuxLog, /-t %97/, 'should still target the leader pane');
      assert.match(tmuxLog, /\[OMX\] All 2 workers idle/, 'global team-state fallback should still fire idle nudge');
    });
  });

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
        leader_pane_id: '%91',
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
      assert.match(tmuxLog, /-t %91/);
      assert.doesNotMatch(tmuxLog, /-t devsess:0/);
      assert.match(tmuxLog, /Team alpha:/);
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');
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
        leader_pane_id: '%92',
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
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');
    });
  });

  it('does not send a generic periodic leader nudge when the leader is not stale', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'fresh-leader';
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
        tmux_session: 'omx-team-fresh',
        leader_pane_id: '%95',
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date().toISOString(),
        turn_count: 2,
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_NUDGE_MS: '30000' });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /Team fresh-leader/, 'non-stale leader should not receive generic periodic follow-up');
      }
    });
  });

  it('uses a 30s cadence for stale leader follow-up nudges', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stale-cadence';
      const teamDir = join(stateDir, 'team', teamName);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const now = Date.now();

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
        tmux_session: 'omx-team-stale-cadence',
        leader_pane_id: '%96',
      });

      const staleHud = {
        last_turn_at: new Date(now - 300_000).toISOString(),
        turn_count: 5,
      };

      await writeJson(join(stateDir, 'hud-state.json'), staleHud);
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        last_nudged_by_team: {
          [teamName]: {
            at: new Date(now - 20_000).toISOString(),
            last_message_id: '',
          },
        },
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const blocked = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_NUDGE_MS: '30000' });
      assert.equal(blocked.status, 0, `notify-hook failed: ${blocked.stderr || blocked.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const firstLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(firstLog, /Team stale-cadence:/, 'stale follow-up should be blocked inside the 30s window');
      }

      await writeJson(join(stateDir, 'hud-state.json'), staleHud);
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        last_nudged_by_team: {
          [teamName]: {
            at: new Date(now - 31_000).toISOString(),
            last_message_id: '',
          },
        },
      });

      const allowed = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_NUDGE_MS: '30000' });
      assert.equal(allowed.status, 0, `notify-hook failed: ${allowed.stderr || allowed.stdout}`);

      const finalLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(finalLog, /Team stale-cadence:/);
      assert.match(finalLog, /leader stale/);
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
        leader_pane_id: '%93',
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
      assert.notEqual(nudgeEvent.reason, 'leader_pane_missing_no_injection');
    });
  });

  it('defers leader nudge when leader_pane_id is missing', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'gamma-missing-pane';
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
        tmux_session: 'devsess:0',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'msg-missing-pane',
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

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t .*devsess/, 'must not fall back to session target');
      }

      const eventsPath = join(eventsDir, 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const eventsContent = await readFile(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));
      const deferred = events.find((e: { type?: string; reason?: string }) =>
        e.type === 'leader_notification_deferred' && e.reason === 'leader_pane_missing_no_injection');
      assert.ok(deferred);
      assert.equal(deferred.type, 'leader_notification_deferred');
      assert.equal(deferred.worker, 'leader-fixed');
      assert.equal(deferred.to_worker, 'leader-fixed');
      assert.equal(deferred.tmux_session, 'devsess:0');
      assert.equal(deferred.leader_pane_id, null);
      assert.equal(deferred.tmux_injection_attempted, false);

      const nudgeStatePath = join(stateDir, 'team-leader-nudge.json');
      assert.ok(existsSync(nudgeStatePath), 'nudge state should still advance on deferred leader visibility');
      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.ok(nudgeState.last_nudged_by_team?.[teamName]?.at);
    });
  });

  it('bounds repeated all-workers-idle nudges by cooldown', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'idle-bounded';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'idle-bounded:0',
        leader_pane_id: '%98',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
      });
      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: new Date().toISOString(),
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_ALL_IDLE_COOLDOWN_MS: '600000' });
      assert.equal(first.status, 0, `notify-hook failed: ${first.stderr || first.stdout}`);
      const second = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_ALL_IDLE_COOLDOWN_MS: '600000' });
      assert.equal(second.status, 0, `notify-hook failed: ${second.stderr || second.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const sends = tmuxLog.match(/send-keys -t %98 -l \[OMX\] All 2 workers idle/g) || [];
      assert.equal(sends.length, 1, 'cooldown should keep repeated all-workers-idle leader nudges bounded');
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
        leader_pane_id: '%94',
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
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');

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
