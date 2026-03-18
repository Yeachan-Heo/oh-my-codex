import { describe, it } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initTeamState, enqueueDispatchRequest, readDispatchRequest } from '../../team/state.js';

async function appendLine(path: string, line: object): Promise<void> {
  const prev = await readFile(path, 'utf-8');
  const content = prev + `${JSON.stringify(line)}\n`;
  await writeFile(path, content);
}

function todaySessionDir(baseHome: string): string {
  const now = new Date();
  return join(
    baseHome,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  );
}

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf-8').catch(() => '');
  return content.split('\n').map(s => s.trim()).filter(Boolean);
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number = 3000, stepMs: number = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number = 4000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    sleep(timeoutMs).then(() => {
      throw new Error(`process ${child.pid ?? 'unknown'} did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

function buildFakeTmux(
  tmuxLogPath: string,
  options: { failSendKeys?: boolean; failSendKeysMatch?: string } = {},
): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "capture-pane" ]]; then
  if [[ -n "\${OMX_TEST_CAPTURE_SEQUENCE_FILE:-}" && -f "\${OMX_TEST_CAPTURE_SEQUENCE_FILE}" ]]; then
    counterFile="\${OMX_TEST_CAPTURE_COUNTER_FILE:-\${OMX_TEST_CAPTURE_SEQUENCE_FILE}.idx}"
    idx=0
    if [[ -f "$counterFile" ]]; then idx="$(cat "$counterFile")"; fi
    lineNo=$((idx + 1))
    line="$(sed -n "\${lineNo}p" "\${OMX_TEST_CAPTURE_SEQUENCE_FILE}" || true)"
    if [[ -z "$line" ]]; then
      line="$(tail -n 1 "\${OMX_TEST_CAPTURE_SEQUENCE_FILE}" || true)"
    fi
    printf "%s\\n" "$line"
    echo "$lineNo" > "$counterFile"
    exit 0
  fi
  if [[ -n "\${OMX_TEST_CAPTURE_FILE:-}" && -f "\${OMX_TEST_CAPTURE_FILE}" ]]; then
    cat "\${OMX_TEST_CAPTURE_FILE}"
  fi
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  target=""
  fmt=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t)
        shift
        target="$1"
        ;;
      *)
        fmt="$1"
        ;;
    esac
    shift || true
  done
  if [[ "$fmt" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_id}" ]]; then
    echo "\${target:-%42}"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_path}" ]]; then
    pwd
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$fmt" == "#S" ]]; then
    echo "session-test"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  sendKeysArgs="$*"
  if [[ "${options.failSendKeys === true ? '1' : '0'}" == "1" ]]; then
    echo "send failed" >&2
    exit 1
  fi
  if [[ -n "${options.failSendKeysMatch || ''}" && "$sendKeysArgs" == *"${options.failSendKeysMatch || ''}"* ]]; then
    echo "send failed" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%42 1"
  exit 0
fi
exit 0
`;
}

describe('notify-fallback watcher', () => {
  it('one-shot mode forwards only recent task_complete events', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-once-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-once-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const staleIso = new Date(Date.now() - 60_000).toISOString();
      const freshIso = new Date(Date.now() + 2_000).toISOString();
      const threadId = `thread-${sid}`;
      const staleTurn = `turn-stale-${sid}`;
      const freshTurn = `turn-fresh-${sid}`;

      const lines = [
        {
          timestamp: freshIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        },
        {
          timestamp: staleIso,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: staleTurn,
            last_agent_message: 'stale message',
          },
        },
        {
          timestamp: freshIso,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: freshTurn,
            last_agent_message: 'fresh message',
          },
        },
      ];
      await writeFile(rolloutPath, `${lines.map(v => JSON.stringify(v)).join('\n')}\n`);

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env: { ...process.env, HOME: tempHome } }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const turnLines = await readLines(turnLog);
      assert.equal(turnLines.length, 1);
      assert.match(turnLines[0], new RegExp(freshTurn));
      assert.doesNotMatch(turnLines[0], new RegExp(staleTurn));
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
      await rm(rolloutPath, { force: true });
    }
  });

  it('streaming mode tails from EOF and does not replay backlog', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stream-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = randomUUID();
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-stream-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const nowIso = new Date().toISOString();
      const threadId = `thread-${sid}`;
      const oldTurn = `turn-old-${sid}`;
      const newTurn = `turn-new-${sid}`;

      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          timestamp: nowIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        })}\n${
          JSON.stringify({
            timestamp: nowIso,
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              turn_id: oldTurn,
              last_agent_message: 'old message',
            },
          })
        }\n`
      );

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '75'],
        {
          cwd: wd,
          stdio: 'ignore',
          env: { ...process.env, HOME: tempHome },
        }
      );

      await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
          return state.tracked_files === 1;
        } catch {
          return false;
        }
      });

      await appendLine(rolloutPath, {
        timestamp: new Date(Date.now() + 500).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: newTurn,
          last_agent_message: 'new message',
        },
      });

      await waitFor(async () => {
        const turnLines = await readLines(turnLog);
        return turnLines.length === 1 && new RegExp(newTurn).test(turnLines[0] ?? '');
      }, 4000, 75);

      child.kill('SIGTERM');
      await once(child, 'exit');

      const turnLines = await readLines(turnLog);
      assert.equal(turnLines.length, 1);
      assert.match(turnLines[0], new RegExp(newTurn));
      assert.doesNotMatch(turnLines[0], new RegExp(oldTurn));
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
      await rm(rolloutPath, { force: true });
    }
  });

  it('records skipped dispatch drain state when HUD is the required authority in one-shot mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-state-'));
    try {
      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, wd);

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8' },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.dispatch_drain?.enabled, false);
      assert.equal(watcherState.dispatch_drain?.leader_only, true);
      assert.equal(watcherState.dispatch_drain?.max_per_tick, 1);
      assert.equal(watcherState.dispatch_drain?.run_count, 1);
      assert.equal(watcherState.dispatch_drain?.last_result?.processed, 0);
      assert.equal(watcherState.dispatch_drain?.last_result?.reason, 'hud_authority_required');

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.ok(drainEvent, 'expected dispatch_drain_tick log event');
      assert.equal(drainEvent.leader_only, true);
      assert.equal(drainEvent.processed, 0);
      assert.equal(drainEvent.reason, 'hud_authority_required');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('records skipped leader nudge checks when HUD is the required authority', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-leader-nudge-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      await writeFile(join(wd, '.omx', 'state', 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 3,
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'config.json'), JSON.stringify({
        name: 'dispatch-team',
        tmux_session: 'omx-team-dispatch-team',
        leader_pane_id: '%42',
      }, null, 2));

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 -l Team dispatch-team: leader stale/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.poll_ms, 250);
      assert.equal(watcherState.leader_nudge?.enabled, false);
      assert.equal(watcherState.leader_nudge?.leader_only, true);
      assert.equal(watcherState.leader_nudge?.run_count, 1);
      assert.equal(watcherState.leader_nudge?.precomputed_leader_stale, null);
      assert.equal(watcherState.leader_nudge?.last_error, 'hud_authority_required');

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const nudgeEvent = logEntries.find((entry: { type?: string }) => entry.type === 'leader_nudge_tick');
      assert.ok(nudgeEvent, 'expected leader_nudge_tick log event');
      assert.equal(nudgeEvent.leader_only, true);
      assert.equal(nudgeEvent.reason, 'hud_authority_required');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('leaves dispatch pending in leader context when HUD is the required authority', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-'));
    try {
      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, wd);
      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8' },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.ok(request);
      assert.equal(request?.status, 'pending');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips dispatch drain in worker context (leader-only guard)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-worker-'));
    try {
      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, wd);
      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8', env: { ...process.env, OMX_TEAM_WORKER: 'dispatch-team/worker-1' } },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'pending');

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.dispatch_drain?.leader_only, false);
      assert.equal(watcherState.dispatch_drain?.last_result?.reason, 'hud_authority_required');
      assert.equal(watcherState.dispatch_drain?.last_result?.processed, 0);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.ok(drainEvent, 'expected dispatch_drain_tick log event');
      assert.equal(drainEvent.leader_only, false);
      assert.equal(drainEvent.reason, 'hud_authority_required');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('watcher retry does not retype when pre-capture still contains trigger', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-cm-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const captureFile = join(wd, 'capture.txt');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(captureFile, 'dispatch ping');

      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'dispatch ping',
      }, wd);

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEST_CAPTURE_FILE: captureFile,
      };

      const first = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8', env },
      );
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8', env },
      );
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l dispatch ping/g) || [];
      assert.equal(typeMatches.length, 0, 'watcher should not type when HUD authority owns the control path');
      assert.ok(!/send-keys[^\n]*-l[^\n]*C-m/.test(tmuxLog), 'must keep -l payload and C-m submits isolated');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not send Ralph continue steer while HUD is the required authority', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-active-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(wd, '.omx', 'state', 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const first = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const boundedLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = boundedLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0, 'fallback watcher should not steer Ralph when HUD is authoritative');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.enabled, false);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'hud_authority_required');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('never sends Ralph continue steer once HUD authority is required', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-terminal-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const ralphStatePath = join(stateDir, 'ralph-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'hud_authority_required');

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps state/log pumping when Ralph steer is skipped for HUD authority', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-control-plane-split-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, wd);
      await writeFile(join(wd, '.omx', 'state', 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.ok(request);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.dispatch_drain?.run_count, 1);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'hud_authority_required');
      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /Ralph loop active continue/);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.ok(drainEvent, 'expected dispatch_drain_tick log event');
      const ralphSkipEvent = logEntries.find((entry: { type?: string; reason?: string }) => (
        entry.type === 'dispatch_drain_tick' && entry.reason === 'hud_authority_required'
      ));
      assert.ok(ralphSkipEvent, 'expected skip state to be logged while control-plane pumping continues');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('retypes on every retry when trigger is not in narrow input area', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-cm-fallback-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const captureSeqFile = join(wd, 'capture-seq.txt');
    const captureCounterFile = join(wd, 'capture-seq.idx');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // Shared preflight now adds one 80-line capture per tick before the
      // narrow retry check. Pre-capture on retries still returns "ready"
      // (no trigger) so the request is retyped on every retry.
      await writeFile(captureSeqFile, [
        // Run 1 (attempt 0): 1 shared preflight + 3 verify rounds × 2 captures = 7
        'ready', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping',
        // Run 2 (attempt 1): 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping',
        // Run 3 (attempt 2): 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping', 'dispatch ping',
      ].join('\n'));

      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'dispatch ping',
      }, wd);

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEST_CAPTURE_SEQUENCE_FILE: captureSeqFile,
        OMX_TEST_CAPTURE_COUNTER_FILE: captureCounterFile,
      };

      for (let i = 0; i < 3; i += 1) {
        const run = spawnSync(
          process.execPath,
          [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
          { encoding: 'utf-8', env },
        );
        assert.equal(run.status, 0, run.stderr || run.stdout);
      }

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l dispatch ping/g) || [];
      assert.equal(typeMatches.length, 0, 'watcher should not type retries when HUD authority owns the control path');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'pending');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('exits when the tracked parent pid is gone', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-exit-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-home-'));
    const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
    const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
    let child: ReturnType<typeof spawn> | undefined;

    try {
      const shortLivedParent = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10)'], {
        stdio: 'ignore',
      });
      assert.ok(shortLivedParent.pid, 'expected short-lived parent pid');
      const parentPid = shortLivedParent.pid as number;
      await once(shortLivedParent, 'exit');

      child = spawn(
        process.execPath,
        [
          watcherScript,
          '--cwd',
          wd,
          '--notify-script',
          notifyHook,
          '--poll-ms',
          '50',
          '--parent-pid',
          String(parentPid),
          '--max-lifetime-ms',
          '5000',
        ],
        {
          cwd: wd,
          stdio: 'ignore',
          env: { ...process.env, HOME: tempHome },
        }
      );

      await waitForExit(child, 4000);
      assert.equal(child.exitCode, 0);

      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_stop' && entry.reason === 'parent_gone'
      )));
    } finally {
      if (child && isPidAlive(child.pid)) {
        child.kill('SIGTERM');
        await waitForExit(child, 4000).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('stops after parent loss when HUD authority disables fallback Ralph steering', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-ralph-active-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-ralph-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const sessionId = 'sess-active-ralph';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
    const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const shortLivedParent = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10)'], {
        stdio: 'ignore',
      });
      assert.ok(shortLivedParent.pid, 'expected short-lived parent pid');
      const parentPid = shortLivedParent.pid as number;
      await once(shortLivedParent, 'exit');

      child = spawn(
        process.execPath,
        [
          watcherScript,
          '--cwd',
          wd,
          '--notify-script',
          notifyHook,
          '--poll-ms',
          '50',
          '--parent-pid',
          String(parentPid),
          '--max-lifetime-ms',
          '5000',
        ],
        {
          cwd: wd,
          stdio: 'ignore',
          env: { ...process.env, HOME: tempHome, PATH: `${fakeBinDir}:${process.env.PATH || ''}` },
        }
      );

      await waitForExit(child, 4000);
      assert.equal(child.exitCode, 0);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /Ralph loop active continue/);

      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_stop' && entry.reason === 'parent_gone'
      )));
    } finally {
      if (child && isPidAlive(child.pid)) {
        child.kill('SIGTERM');
        await waitForExit(child, 4000).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
