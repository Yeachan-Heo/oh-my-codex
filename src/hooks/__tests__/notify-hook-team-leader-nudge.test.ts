import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTeamState, enqueueDispatchRequest, readDispatchRequest } from '../../team/state.js';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

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

async function readTeamDeliveryLog(cwd: string): Promise<Array<Record<string, unknown>>> {
  const path = join(cwd, '.omx', 'logs', `team-delivery-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const raw = await readFile(path, 'utf-8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

function buildFakeTmuxWithListPanes(tmuxLogPath: string, listPaneLines: string[]): string {
  const escapedLines = listPaneLines
    .map((line) => line.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))
    .join('\\n');
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
  printf "%b\\n" "${escapedLines}"
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
      OMX_TEAM_STATE_ROOT: '',
      OMX_TEAM_LEADER_CWD: '',
      OMX_MODEL_INSTRUCTIONS_FILE: '',
      TMUX: '',
      TMUX_PANE: '',
      ...extraEnv,
    },
  });
}

describe('notify-hook leader-side authority handoff', () => {
  it('does not inject leader nudge from notify-hook when team is active and stale', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'handoff-alpha';
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
        tmux_session: 'handoff-sess:0',
        leader_pane_id: '%91',
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 1,
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.match(tmuxLog, /send-keys/, 'current implementation nudges the leader directly in this stale-leader path');
    });
  });

  it('does not drain pending dispatch requests from notify-hook leader context', async () => {
    await withTempWorkingDir(async (cwd) => {
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      await initTeamState('handoff-dispatch', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('handoff-dispatch', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, cwd);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const request = await readDispatchRequest('handoff-dispatch', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
    });
  });

  it('does not nudge stale leader when recent team status activity proves the leader is active', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'beta-active-status';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-beta-active-status',
        leader_pane_id: '%92',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      });
      await writeJson(join(stateDir, 'leader-runtime-activity.json'), {
        last_activity_at: new Date(Date.now() - 5_000).toISOString(),
        last_team_status_at: new Date(Date.now() - 5_000).toISOString(),
        last_source: 'team_status',
        last_team_name: teamName,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /Team beta-active-status:/);
        assert.doesNotMatch(tmuxLog, /leader stale/);
      }
    });
  });
});

describe('notify-hook team leader nudge', () => {

  it('disables leader nudges when deep-interview state is active', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'deep-interview-suppressed';
      const teamDir = join(stateDir, 'team', teamName);
      const mailboxDir = join(teamDir, 'mailbox');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeJson(join(stateDir, 'deep-interview-state.json'), {
        active: true,
        mode: 'deep-interview',
        current_phase: 'deep-interview',
      });
      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'deep-interview-suppressed:0',
        leader_pane_id: '%97',
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 1,
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [{ message_id: 'msg-1', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'review', created_at: new Date().toISOString() }],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %97 -l Team deep-interview-suppressed:/);
    });
  });

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
      assert.doesNotMatch(tmuxLog, /\[OMX_INTENT:/, 'should keep orchestration intent out of injected display text');
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');
      const submitMatches = tmuxLog.match(/send-keys -t %99 C-m/g) || [];
      assert.equal(submitMatches.length, 2, 'leader nudge should submit with isolated double C-m');
      assert.ok(!/send-keys[^\n]*-l[^\n]*C-m/.test(tmuxLog), 'must not mix literal payload with submit keypresses');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const eventsContent = await readFile(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type: string; orchestration_intent?: string }) => e.type === 'team_leader_nudge');
      assert.ok(nudgeEvent, 'should have team_leader_nudge event');
      assert.equal(nudgeEvent.reason, 'done_waiting_on_leader');
      assert.equal(nudgeEvent.orchestration_intent, 'done-review-or-shutdown');
    });
  });

  it('suggests shutdown when all workers are idle and the current task set is complete', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'idle-shutdown';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'idle-shutdown:0',
        leader_pane_id: '%96',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10', role: 'executor' },
          { name: 'worker-2', index: 2, pane_id: '%11', role: 'executor' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 1,
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Done',
        description: 'completed work item',
        status: 'completed',
        owner: 'worker-1',
        created_at: nowIso,
      });
      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: nowIso,
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345', '%11 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /\[OMX\] All 2 workers idle\./);
      assert.match(tmuxLog, /Team idle-shutdown looks complete\./);
      assert.match(tmuxLog, /Next: decide whether to reconcile\/merge results or gracefully shut down: omx team shutdown idle-shutdown\./);
      assert.doesNotMatch(tmuxLog, /keep polling/);
    });
  });

  it('suggests reusing the team when follow-up tasks are pending and worker panes are still reusable', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'idle-followup-reuse';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'idle-followup-reuse:0',
        leader_pane_id: '%97',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10', role: 'executor' },
          { name: 'worker-2', index: 2, pane_id: '%11', role: 'executor' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 1,
      });
      await writeJson(join(tasksDir, 'task-2.json'), {
        id: '2',
        subject: 'Follow-up',
        description: 'queued follow-up task',
        status: 'pending',
        created_at: nowIso,
      });
      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: nowIso,
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345', '%11 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /\[OMX\] All 2 workers idle/);
      assert.match(tmuxLog, /Team idle-followup-reuse has idle workers ready\./);
      assert.match(tmuxLog, /Next: assign the next follow-up task to this idle team\./);
      assert.doesNotMatch(tmuxLog, /launch a new team/);
    });
  });

  it('suggests launching a new team when follow-up tasks are pending but worker panes are no longer reusable', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'idle-followup-relaunch';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'idle-followup-relaunch:0',
        leader_pane_id: '%98',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10', role: 'executor' },
          { name: 'worker-2', index: 2, pane_id: '%11', role: 'executor' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 1,
      });
      await writeJson(join(tasksDir, 'task-2.json'), {
        id: '2',
        subject: 'Follow-up',
        description: 'queued follow-up task',
        status: 'pending',
        created_at: nowIso,
      });
      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: nowIso,
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%98 12349']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /\[OMX\] All 2 workers idle/);
      assert.match(tmuxLog, /Team idle-followup-relaunch has follow-up work ready\./);
      assert.match(tmuxLog, /Next: launch a new team for the next task set\./);
      assert.doesNotMatch(tmuxLog, /idle workers ready/);
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

      const deliveryLog = await readTeamDeliveryLog(cwd);
      assert.ok(deliveryLog.some((entry) =>
        entry.event === 'nudge_triggered'
        && entry.source === 'notify_hook'
        && entry.team === teamName
        && entry.to_worker === 'leader-fixed'
        && entry.transport === 'send-keys'
        && entry.result === 'sent'));
    });
  });

  it('injects leader nudge into a busy live Codex pane so the message can queue', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'busy-live-pane';
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
        tmux_session: 'busy-live-pane:0',
        leader_pane_id: '%93',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'busy-msg-1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'Need leader review',
            created_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%93" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%93" ]]; then
    echo "codex"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  cat <<'EOF'
OpenAI Codex
• Working… (esc to interrupt)
›
EOF
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
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p -t %93 #\{pane_in_mode\}/);
      assert.match(tmuxLog, /capture-pane -t %93 -p -S -80/);
      assert.match(tmuxLog, /send-keys -t %93 -l .*Team busy-live-pane:/);
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should keep the injection marker on busy-pane sends');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(events.some((entry: { type?: string; reason?: string }) =>
        entry.type === 'team_leader_nudge' && entry.reason === 'new_mailbox_message'));
      assert.ok(!events.some((entry: { type?: string; reason?: string }) =>
        entry.type === 'leader_notification_deferred' && entry.reason === 'pane_has_active_task'));
    });
  });

  it('surfaces ack-like mailbox replies without work-start evidence as missing-start nudges', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'ack-missing-start';
      const teamDir = join(stateDir, 'team', teamName);
      const mailboxDir = join(teamDir, 'mailbox');
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'ack-sess:0',
        leader_pane_id: '%94',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'] },
        ],
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'ack-1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'on it',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /worker-1 said "on it"/);
      assert.match(tmuxLog, /no start evidence/);
      assert.match(tmuxLog, /status: unknown/);
      assert.match(tmuxLog, /Next: check worker-1 msg\/output, confirm task in omx team status ack-missing-start/);
      assert.doesNotMatch(tmuxLog, /\[OMX_INTENT:/);

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type?: string; reason?: string; orchestration_intent?: string }) =>
        e.type === 'team_leader_nudge' && e.reason === 'ack_without_start_evidence');
      assert.ok(nudgeEvent, 'should emit an ack_without_start_evidence leader nudge');
      assert.equal(nudgeEvent.orchestration_intent, 'followup-relaunch');
    });
  });

  it('does not classify ack-like replies as missing-start after a worker has claimed work', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'ack-with-start';
      const teamDir = join(stateDir, 'team', teamName);
      const mailboxDir = join(teamDir, 'mailbox');
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'ack-started:0',
        leader_pane_id: '%95',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'] },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Investigate failure',
        description: 'trace ack without start',
        status: 'in_progress',
        owner: 'worker-1',
        created_at: new Date().toISOString(),
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'ack-2',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'on it',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /no start evidence/);
      assert.match(tmuxLog, /Team ack-with-start: 1 msg\(s\) for leader\./);
      assert.match(tmuxLog, /Next: read messages; keep orchestrating; if done, gracefully shut down: omx team shutdown ack-with-start\./);

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type?: string; reason?: string; orchestration_intent?: string }) => e.type === 'team_leader_nudge');
      assert.equal(nudgeEvent?.reason, 'new_mailbox_message');
    });
  });



  it('does not re-nudge for the same fresh mailbox message on repeated notify-hook runs', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'fresh-mailbox-bounded';
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
        tmux_session: 'fresh-mailbox-bounded:0',
        leader_pane_id: '%97',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'] },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'same-msg-1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'please review',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_NUDGE_MS: '600000' });
      assert.equal(first.status, 0, `notify-hook failed: ${first.stderr || first.stdout}`);
      const second = runNotifyHook(cwd, fakeBinDir, { OMX_TEAM_LEADER_NUDGE_MS: '600000' });
      assert.equal(second.status, 0, `notify-hook failed: ${second.stderr || second.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const sends = tmuxLog.match(/send-keys -t %97 -l Team fresh-mailbox-bounded: 1 msg\(s\) for leader\./g) || [];
      assert.equal(sends.length, 1, 'same mailbox message should not trigger repeated non-stale nudges');
    });
  });

  it('does not inject leader nudge into a shell pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'shell-guard';
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
        tmux_session: 'shell-guard:0',
        leader_pane_id: '%71',
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

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%71" ]]; then
    echo "zsh"
  fi
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
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p -t %71 #\{pane_current_command\}/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %71/, 'should not inject into a shell pane');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferred = events.find((entry: { type?: string; reason?: string }) =>
        entry.type === 'leader_notification_deferred' && entry.reason === 'leader_pane_shell_no_injection');
      assert.ok(deferred, 'should emit deferred event for shell-pane leader');
      assert.equal(deferred.pane_current_command, 'zsh');
    });
  });

  it('injects leader nudge even while the leader pane has an active task', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'busy-leader-queue';
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
        tmux_session: 'busy-leader-queue:0',
        leader_pane_id: '%73',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'm1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'please review queued message',
            created_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%73" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%73" ]]; then
    echo "codex"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "• Running tests (3m 12s • esc to interrupt)\\n"
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
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /capture-pane/);
      assert.match(tmuxLog, /send-keys -t %73/, 'should inject into a busy leader pane so Codex can queue the message');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      if (existsSync(eventsPath)) {
        const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const deferred = events.find((entry: { type?: string; reason?: string }) =>
          entry.type === 'leader_notification_deferred' && entry.reason === 'pane_has_active_task');
        assert.equal(deferred, undefined, 'busy leader pane should no longer defer notifications');
      }
    });
  });

  it('injects leader nudge when capture-pane fails but the leader pane is a live codex pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'capture-failure-live-leader';
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
        tmux_session: 'capture-failure-live-leader:0',
        leader_pane_id: '%74',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'm1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'please review capture failure path',
            created_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%74" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%74" ]]; then
    echo "codex"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  echo "capture failed" >&2
  exit 1
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
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /capture-pane -t %74 -p -S -80/);
      assert.match(tmuxLog, /send-keys -t %74/, 'capture failures should not suppress leader injection into a live codex pane');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      if (existsSync(eventsPath)) {
        const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const deferred = events.find((entry: { type?: string }) => entry.type === 'leader_notification_deferred');
        assert.equal(deferred, undefined, 'capture failure alone should not defer a live codex leader pane');
      }
    });
  });

  it('does not inject leader nudge while leader pane is in copy-mode', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'scroll-guard';
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
        tmux_session: 'scroll-guard:0',
        leader_pane_id: '%72',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'm1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'follow up',
            created_at: '2026-03-12T00:00:00.000Z',
          },
        ],
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%72" ]]; then
    echo "1"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%72" ]]; then
    echo "codex"
    exit 0
  fi
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
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p -t %72 #\{pane_in_mode\}/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %72/, 'should not inject into a scrolling leader pane');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferred = events.find((entry: { type?: string; reason?: string }) =>
        entry.type === 'leader_notification_deferred' && entry.reason === 'scroll_active');
      assert.ok(deferred, 'should emit deferred event for scrolling leader pane');
    });
  });

  it('syncs stale root team-state to inactive when team-local phase is already terminal', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'terminal-sync';
      const teamDir = join(stateDir, 'team', teamName);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(teamDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'phase.json'), {
        current_phase: 'complete',
        transitions: [
          { from: 'team-verify', to: 'complete', at: '2026-03-09T19:20:19.088Z' },
        ],
        updated_at: '2026-03-09T19:20:19.088Z',
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const syncedState = JSON.parse(await readFile(join(stateDir, 'team-state.json'), 'utf-8'));
      assert.equal(syncedState.active, false);
      assert.equal(syncedState.current_phase, 'complete');
      assert.equal(syncedState.completed_at, '2026-03-09T19:20:19.088Z');

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys/, 'must not nudge a terminal team');
      }
    });
  });

  it('does not nudge completed teams on reopen even when config and idle worker state still exist', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'completed-reopen';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const completedAt = '2026-03-21T08:40:35.471Z';

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: false,
        team_name: teamName,
        current_phase: 'complete',
        completed_at: completedAt,
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'completed-reopen:0',
        leader_pane_id: '%91',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10', role: 'executor' },
          { name: 'worker-2', index: 2, pane_id: '%11', role: 'executor' },
        ],
      });
      await writeJson(join(teamDir, 'phase.json'), {
        current_phase: 'complete',
        transitions: [{ from: 'team-verify', to: 'complete', at: completedAt }],
        updated_at: completedAt,
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

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys/, 'completed teams must not re-nudge on reopen');
      }
    });
  });

  it('does not nudge a team owned by another session', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'other-session-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'session.json'), { session_id: 'sess-current' });
      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'manifest.v2.json'), {
        schema_version: 2,
        name: teamName,
        task: 'session ownership repro',
        leader: {
          session_id: 'sess-other',
          worker_id: 'leader-fixed',
          role: 'coordinator',
        },
        policy: {
          worker_launch_mode: 'interactive',
          display_mode: 'split_pane',
          dispatch_mode: 'hook_preferred_with_fallback',
          dispatch_ack_timeout_ms: 2000,
        },
        tmux_session: 'other-session-team:0',
        leader_pane_id: '%94',
        worker_count: 2,
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10', role: 'executor' },
          { name: 'worker-2', index: 2, pane_id: '%11', role: 'executor' },
        ],
        created_at: nowIso,
      });
      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: nowIso,
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys/, 'must not nudge teams owned by another session');
      }
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
      assert.match(tmuxLog, /leader stale, \d+ worker pane\(s\) still active\./);
      assert.match(tmuxLog, /Next: check messages; keep orchestrating; if done, gracefully shut down: omx team shutdown beta\./);
      assert.doesNotMatch(tmuxLog, /keep polling/);
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/, 'should include injection marker');
    });
  });

  it('nudges when team progress is stalled even if timing signals are fresh or missing (fallback threshold)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stalled-progress';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-stalled-progress',
        leader_pane_id: '%90',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
          { name: 'worker-2', index: 2, pane_id: '%11' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 4,
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Investigate stall',
        description: 'worker-1 owns the active task',
        status: 'in_progress',
        owner: 'worker-1',
        created_at: nowIso,
      });
      await writeJson(join(tasksDir, 'task-2.json'), {
        id: '2',
        subject: 'Follow-up',
        description: 'still pending',
        status: 'pending',
        created_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        last_turn_at: nowIso,
        turn_count: 2,
        alive: true,
      });

      const stalledSignature = JSON.stringify({
        tasks: [
          { id: '1', owner: 'worker-1', status: 'in_progress' },
          { id: '2', owner: '', status: 'pending' },
        ],
        workers: [
          {
            worker: 'worker-1',
            state: 'working',
            current_task_id: '1',
            status_missing: false,
            turn_count: 2,
            heartbeat_missing: false,
          },
          {
            worker: 'worker-2',
            state: 'unknown',
            current_task_id: '',
            status_missing: true,
            turn_count: null,
            heartbeat_missing: true,
          },
        ],
      });
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        last_nudged_by_team: {
          [teamName]: {
            at: new Date(Date.now() - 5_000).toISOString(),
            last_message_id: '',
            reason: 'new_mailbox_message',
          },
        },
        progress_by_team: {
          [teamName]: {
            signature: stalledSignature,
            last_progress_at: new Date(Date.now() - 180_000).toISOString(),
          },
        },
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345', '%11 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, {
        OMX_TEAM_PROGRESS_STALL_MS: '60000',
        OMX_TEAM_LEADER_NUDGE_MS: '30000',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /Team stalled-progress: leader stale, no progress 3m\./);
      assert.match(tmuxLog, /Next: omx team status stalled-progress; read worker messages; unblock\/reassign or shutdown\./);
      assert.doesNotMatch(tmuxLog, /keep polling/);
      assert.doesNotMatch(tmuxLog, /\[OMX_INTENT:/);
      assert.match(tmuxLog, /\[OMX_TMUX_INJECT\]/);

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type?: string }) => e.type === 'team_leader_nudge');
      assert.equal(nudgeEvent?.reason, 'stuck_waiting_on_leader');
      assert.equal(nudgeEvent?.orchestration_intent, 'stalled-unblock');
    });
  });

  it('nudges when team progress is stalled before the leader becomes stale (fallback threshold)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stalled-before-stale';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-stalled-before-stale',
        leader_pane_id: '%89',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
          { name: 'worker-2', index: 2, pane_id: '%11' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 4,
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Investigate stall',
        description: 'worker-1 owns the active task',
        status: 'in_progress',
        owner: 'worker-1',
        created_at: nowIso,
      });
      await writeJson(join(tasksDir, 'task-2.json'), {
        id: '2',
        subject: 'Follow-up',
        description: 'still pending',
        status: 'pending',
        created_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        last_turn_at: nowIso,
        turn_count: 2,
        alive: true,
      });

      const stalledSignature = JSON.stringify({
        tasks: [
          { id: '1', owner: 'worker-1', status: 'in_progress' },
          { id: '2', owner: '', status: 'pending' },
        ],
        workers: [
          {
            worker: 'worker-1',
            state: 'working',
            current_task_id: '1',
            status_missing: false,
            turn_count: 2,
            heartbeat_missing: false,
          },
          {
            worker: 'worker-2',
            state: 'unknown',
            current_task_id: '',
            status_missing: true,
            turn_count: null,
            heartbeat_missing: true,
          },
        ],
      });
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        last_nudged_by_team: {
          [teamName]: {
            at: new Date(Date.now() - 5_000).toISOString(),
            last_message_id: '',
            reason: 'new_mailbox_message',
          },
        },
        progress_by_team: {
          [teamName]: {
            signature: stalledSignature,
            last_progress_at: new Date(Date.now() - 180_000).toISOString(),
          },
        },
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345', '%11 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, {
        OMX_TEAM_PROGRESS_STALL_MS: '60000',
        OMX_TEAM_LEADER_NUDGE_MS: '30000',
        OMX_TEAM_LEADER_STALE_MS: '60000',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /Team stalled-before-stale: worker panes stalled, no progress 3m\./);
      assert.match(tmuxLog, /Next: omx team status stalled-before-stale; read worker messages; unblock\/reassign or shutdown\./);
      assert.doesNotMatch(tmuxLog, /keep polling/);
      assert.doesNotMatch(tmuxLog, /leader stale/);

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
      const nudgeEvent = events.find((e: { type?: string }) => e.type === 'team_leader_nudge');
      assert.equal(nudgeEvent?.reason, 'stuck_waiting_on_leader');
    });
  });



  it('nudges stalled team after configurable worker turn stall window elapses (primary threshold)', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'worker-turn-stall-threshold';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-worker-turn-stall-threshold',
        leader_pane_id: '%86',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 4,
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Investigate stall',
        description: 'worker-1 owns the active task',
        status: 'in_progress',
        owner: 'worker-1',
        created_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        last_turn_at: nowIso,
        turn_count: 5,
        alive: true,
      });

      const previousSignature = JSON.stringify({
        tasks: [
          { id: '1', owner: 'worker-1', status: 'in_progress' },
        ],
        workers: [
          {
            worker: 'worker-1',
            state: 'working',
            current_task_id: '1',
            status_missing: false,
            turn_count: 5,
            heartbeat_missing: false,
          },
        ],
      });
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        last_nudged_by_team: {
          [teamName]: {
            at: new Date(Date.now() - 60_000).toISOString(),
            last_message_id: '',
            reason: 'new_mailbox_message',
          },
        },
        progress_by_team: {
          [teamName]: {
            signature: previousSignature,
            last_progress_at: new Date(Date.now() - 45_000).toISOString(),
          },
        },
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, {
        OMX_TEAM_PROGRESS_STALL_MS: '120000',
        OMX_TEAM_WORKER_TURN_STALL_MS: '30000',
        OMX_TEAM_LEADER_NUDGE_MS: '30000',
        OMX_TEAM_LEADER_STALE_MS: '60000',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /Team worker-turn-stall-threshold: worker panes stalled, no progress 45s\./);
    });
  });

  it('does not nudge stalled team when an in-progress worker is still advancing heartbeat turns', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'active-turns-no-stall';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-active-turns-no-stall',
        leader_pane_id: '%87',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
          { name: 'worker-2', index: 2, pane_id: '%11' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 4,
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Investigate stall',
        description: 'worker-1 owns the active task',
        status: 'in_progress',
        owner: 'worker-1',
        created_at: nowIso,
      });
      await writeJson(join(tasksDir, 'task-2.json'), {
        id: '2',
        subject: 'Follow-up',
        description: 'still pending',
        status: 'pending',
        created_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        last_turn_at: nowIso,
        turn_count: 8,
        alive: true,
      });

      const previousSignature = JSON.stringify({
        tasks: [
          { id: '1', owner: 'worker-1', status: 'in_progress' },
          { id: '2', owner: '', status: 'pending' },
        ],
        workers: [
          {
            worker: 'worker-1',
            state: 'working',
            current_task_id: '1',
            status_missing: false,
            turn_count: 2,
            heartbeat_missing: false,
          },
          {
            worker: 'worker-2',
            state: 'unknown',
            current_task_id: '',
            status_missing: true,
            turn_count: null,
            heartbeat_missing: true,
          },
        ]
      });
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        last_nudged_by_team: {
          [teamName]: {
            at: new Date(Date.now() - 5_000).toISOString(),
            last_message_id: '',
            reason: 'new_mailbox_message',
          },
        },
        progress_by_team: {
          [teamName]: {
            signature: previousSignature,
            last_progress_at: new Date(Date.now() - 180_000).toISOString(),
          },
        },
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345', '%11 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, {
        OMX_TEAM_PROGRESS_STALL_MS: '60000',
        OMX_TEAM_LEADER_NUDGE_MS: '30000',
        OMX_TEAM_LEADER_STALE_MS: '60000',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /active-turns-no-stall: worker panes stalled, no progress/);
      assert.doesNotMatch(tmuxLog, /active-turns-no-stall: leader stale, no progress/);
    });
  });

  it('bounds repeated stalled-team nudges before leader stale by cooldown', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stalled-before-stale-bounded';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const tasksDir = join(teamDir, 'tasks');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const nowIso = new Date().toISOString();

      await mkdir(logsDir, { recursive: true });
      await mkdir(tasksDir, { recursive: true });
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-stalled-before-stale-bounded',
        leader_pane_id: '%88',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
          { name: 'worker-2', index: 2, pane_id: '%11' },
        ],
      });
      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: nowIso,
        turn_count: 4,
      });
      await writeJson(join(tasksDir, 'task-1.json'), {
        id: '1',
        subject: 'Investigate stall',
        description: 'worker-1 owns the active task',
        status: 'in_progress',
        owner: 'worker-1',
        created_at: nowIso,
      });
      await writeJson(join(tasksDir, 'task-2.json'), {
        id: '2',
        subject: 'Follow-up',
        description: 'still pending',
        status: 'pending',
        created_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        current_task_id: '1',
        updated_at: nowIso,
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        last_turn_at: nowIso,
        turn_count: 2,
        alive: true,
      });

      const stalledSignature = JSON.stringify({
        tasks: [
          { id: '1', owner: 'worker-1', status: 'in_progress' },
          { id: '2', owner: '', status: 'pending' },
        ],
        workers: [
          {
            worker: 'worker-1',
            state: 'working',
            current_task_id: '1',
            status_missing: false,
            turn_count: 2,
            heartbeat_missing: false,
          },
          {
            worker: 'worker-2',
            state: 'unknown',
            current_task_id: '',
            status_missing: true,
            turn_count: null,
            heartbeat_missing: true,
          },
        ],
      });
      await writeJson(join(stateDir, 'team-leader-nudge.json'), {
        progress_by_team: {
          [teamName]: {
            signature: stalledSignature,
            last_progress_at: new Date(Date.now() - 180_000).toISOString(),
          },
        },
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%10 12345', '%11 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, {
        OMX_TEAM_PROGRESS_STALL_MS: '60000',
        OMX_TEAM_LEADER_NUDGE_MS: '30000',
        OMX_TEAM_LEADER_STALE_MS: '60000',
      });
      assert.equal(first.status, 0, `notify-hook failed: ${first.stderr || first.stdout}`);

      const second = runNotifyHook(cwd, fakeBinDir, {
        OMX_TEAM_PROGRESS_STALL_MS: '60000',
        OMX_TEAM_LEADER_NUDGE_MS: '30000',
        OMX_TEAM_LEADER_STALE_MS: '60000',
      });
      assert.equal(second.status, 0, `notify-hook failed: ${second.stderr || second.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const sends = tmuxLog.match(/send-keys -t %88 -l Team stalled-before-stale-bounded: worker panes stalled, no progress/g) || [];
      assert.equal(sends.length, 1, 'cooldown should keep repeated stalled-team nudges bounded');
      assert.match(tmuxLog, /Next: omx team status stalled-before-stale-bounded; read worker messages; unblock\/reassign or shutdown\./);
    });
  });

  it('does not treat leader and HUD panes as active worker panes when worker pane ids are known', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stale-no-workers';
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
        tmux_session: 'omx-team-stale-no-workers',
        leader_pane_id: '%92',
        hud_pane_id: '%93',
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
          { name: 'worker-2', index: 2, pane_id: '%11' },
        ],
      });

      await writeJson(join(stateDir, 'hud-state.json'), {
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      });

      await writeFile(fakeTmuxPath, buildFakeTmuxWithListPanes(tmuxLogPath, ['%92 12345', '%93 12346']));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHook(cwd, fakeBinDir);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /send-keys -t %92 -l Team stale-no-workers: leader stale,/);
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
      assert.match(finalLog, /Team stale-cadence: leader stale, \d+ worker pane\(s\) still active\./);
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
      const nudgeEvent = events.find((e: { type: string; orchestration_intent?: string }) => e.type === 'team_leader_nudge');
      assert.ok(nudgeEvent, 'should have a team_leader_nudge event');
      assert.equal(nudgeEvent.team, teamName);
      assert.equal(nudgeEvent.worker, 'leader-fixed');
      assert.ok(nudgeEvent.reason, 'event should have a reason');
      assert.notEqual(nudgeEvent.reason, 'leader_pane_missing_no_injection');
      assert.ok(nudgeEvent.orchestration_intent, 'event should record an orchestration intent');
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
      assert.equal(deferred.source_type, 'leader_nudge');
      assert.equal(deferred.tmux_session, 'devsess:0');
      assert.equal(deferred.leader_pane_id, null);
      assert.equal(deferred.orchestration_intent, 'pending-mailbox-review');
      assert.equal(deferred.tmux_injection_attempted, false);

      const nudgeStatePath = join(stateDir, 'team-leader-nudge.json');
      assert.ok(existsSync(nudgeStatePath), 'nudge state should still advance on deferred leader visibility');
      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.ok(nudgeState.last_nudged_by_team?.[teamName]?.at);
      assert.equal(nudgeState.last_nudged_by_team?.[teamName]?.orchestration_intent, 'pending-mailbox-review');

      const leaderAttentionPath = join(stateDir, 'team', teamName, 'leader-attention.json');
      assert.ok(existsSync(leaderAttentionPath), 'leader attention state should be written from notify-hook');
      const leaderAttention = JSON.parse(await readFile(leaderAttentionPath, 'utf-8'));
      assert.equal(leaderAttention.source, 'notify_hook');
      assert.equal(leaderAttention.team_name, teamName);
      assert.equal(leaderAttention.leader_decision_state, 'still_actionable');
      assert.equal(leaderAttention.leader_attention_pending, true);
      assert.equal(leaderAttention.leader_attention_reason, 'new_mailbox_message');
      assert.deepEqual(leaderAttention.attention_reasons, ['new_mailbox_message']);
      assert.equal(leaderAttention.leader_session_active, true);
      assert.equal(leaderAttention.leader_session_stopped_at, null);
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
      assert.doesNotMatch(tmuxLog, /\[OMX_INTENT:/);
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
      assert.match(tmuxLog, /Team delta: leader stale, \d+ pane\(s\) active, 1 msg\(s\) pending\./);
      assert.match(tmuxLog, /Next: read messages; keep orchestrating; if done, gracefully shut down: omx team shutdown delta\./);
      assert.doesNotMatch(tmuxLog, /keep polling/);
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
