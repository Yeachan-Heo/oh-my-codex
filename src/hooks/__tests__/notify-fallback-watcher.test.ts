import { describe, it } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initTeamState, enqueueDispatchRequest, readDispatchRequest } from '../../team/state.js';
import { writeSessionStart } from '../session.js';

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
    dirname "${tmuxLogPath}"
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

function buildCleanNotifyEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OMX_TEAM_WORKER: '',
    OMX_TEAM_STATE_ROOT: '',
    OMX_TEAM_LEADER_CWD: '',
    OMX_MODEL_INSTRUCTIONS_FILE: '',
    TMUX: '',
    TMUX_PANE: '',
    ...overrides,
  };
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

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv({ HOME: tempHome }) }
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

  it('streaming mode buffers partial JSON lines until the newline arrives', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stream-partial-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = randomUUID();
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-stream-partial-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const nowIso = new Date().toISOString();
      const threadId = `thread-${sid}`;
      const partialTurn = `turn-partial-${sid}`;

      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          timestamp: nowIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        })}
`
      );

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '75'],
        { cwd: wd, stdio: 'ignore', env: buildCleanNotifyEnv({ HOME: tempHome }) }
      );

      await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
          return state.tracked_files === 1;
        } catch {
          return false;
        }
      });

      const partialPrefix = JSON.stringify({
        timestamp: new Date(Date.now() + 500).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: partialTurn,
          last_agent_message: 'partial message',
        },
      });
      const splitAt = Math.floor(partialPrefix.length / 2);
      await writeFile(rolloutPath, `${await readFile(rolloutPath, 'utf-8')}${partialPrefix.slice(0, splitAt)}`);

      await sleep(250);
      const beforeLines = await readLines(turnLog);
      assert.equal(beforeLines.length, 0, 'partial line should not be emitted before newline completes it');

      await writeFile(rolloutPath, `${await readFile(rolloutPath, 'utf-8')}${partialPrefix.slice(splitAt)}\n`);

      await waitFor(async () => {
        const turnLines = await readLines(turnLog);
        return turnLines.length === 1 && new RegExp(partialTurn).test(turnLines[0] ?? '');
      }, 4000, 75);

      child.kill('SIGTERM');
      await once(child, 'exit');

      const turnLines = await readLines(turnLog);
      assert.equal(turnLines.length, 1);
      assert.match(turnLines[0], new RegExp(partialTurn));
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

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '75'],
        {
          cwd: wd,
          stdio: 'ignore',
          env: buildCleanNotifyEnv({ HOME: tempHome }),
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

  it('records explicit leader-only dispatch drain state and log visibility in one-shot mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-state-'));
    try {
      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, wd);

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv() },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.dispatch_drain?.enabled, true);
      assert.equal(watcherState.dispatch_drain?.leader_only, true);
      assert.equal(watcherState.dispatch_drain?.max_per_tick, 1);
      assert.equal(watcherState.dispatch_drain?.run_count, 1);
      assert.equal(watcherState.dispatch_drain?.last_result?.processed, 1);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.ok(drainEvent, 'expected dispatch_drain_tick log event');
      assert.equal(drainEvent.leader_only, true);
      assert.equal(drainEvent.processed, 1);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('disables fallback watcher nudges when deep-interview state is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-deep-interview-suppressed-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      await writeFile(join(wd, '.omx', 'state', 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 3,
        last_agent_output: 'Would you like me to continue?',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'config.json'), JSON.stringify({
        name: 'dispatch-team',
        tmux_session: 'omx-team-dispatch-team',
        leader_pane_id: '%42',
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({ PATH: `${fakeBinDir}:${process.env.PATH || ''}` }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /Ralph loop active continue/);
      assert.doesNotMatch(tmuxLog, /Team dispatch-team:/);
      assert.doesNotMatch(tmuxLog, /yes, proceed \[OMX_TMUX_INJECT\]/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs leader nudge checks from the fallback watcher so stale alerts do not wait for a leader turn', async () => {
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

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l Team dispatch-team: leader stale/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.poll_ms, 250);
      assert.equal(watcherState.leader_nudge?.enabled, true);
      assert.equal(watcherState.leader_nudge?.leader_only, true);
      assert.equal(watcherState.leader_nudge?.run_count, 1);
      assert.equal(watcherState.leader_nudge?.precomputed_leader_stale, true);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const nudgeEvent = logEntries.find((entry: { type?: string }) => entry.type === 'leader_nudge_tick');
      assert.ok(nudgeEvent, 'expected leader_nudge_tick log event');
      assert.equal(nudgeEvent.leader_only, true);
      assert.equal(nudgeEvent.precomputed_leader_stale, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('skips fallback watcher leader nudges when the leader is not stale even if mailbox messages exist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-leader-nudge-fresh-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'mailbox'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      await writeFile(join(wd, '.omx', 'state', 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date().toISOString(),
        turn_count: 3,
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'config.json'), JSON.stringify({
        name: 'dispatch-team',
        tmux_session: 'omx-team-dispatch-team',
        leader_pane_id: '%42',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'mailbox', 'leader-fixed.json'), JSON.stringify({
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'msg-1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'fresh mailbox message',
            created_at: new Date().toISOString(),
          },
        ],
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 -l Team dispatch-team:/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.leader_nudge?.enabled, true);
      assert.equal(watcherState.leader_nudge?.leader_only, true);
      assert.equal(watcherState.leader_nudge?.run_count, 1);
      assert.equal(watcherState.leader_nudge?.precomputed_leader_stale, false);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const nudgeEvent = logEntries.find((entry: { type?: string }) => entry.type === 'leader_nudge_tick');
      assert.ok(nudgeEvent, 'expected leader_nudge_tick log event');
      assert.equal(nudgeEvent.precomputed_leader_stale, false);
      assert.equal(nudgeEvent.reason, 'leader_nudge_skipped_not_stale');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('auto-nudges stalled session output even when no active mode state exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-auto-nudge-stalled-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const codexHome = join(wd, 'codex-home');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        autoNudge: { enabled: true, delaySec: 0, ttlMs: 30_000 },
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 6_000).toISOString(),
        turn_count: 7,
        last_agent_output: 'If you want, I can keep going from here.',
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
            CODEX_HOME: codexHome,
            TMUX: '1',
            TMUX_PANE: '%42',
            OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS: '5000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l yes, proceed \[OMX_TMUX_INJECT\]/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'sent');
      assert.equal(watcherState.fallback_auto_nudge?.last_turn_count, 7);
      assert.match(watcherState.fallback_auto_nudge?.last_nudged_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-nudge stalled-like output when the latest turn is still fresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-auto-nudge-fresh-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const codexHome = join(wd, 'codex-home');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        autoNudge: { enabled: true, delaySec: 0 },
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 1_000).toISOString(),
        turn_count: 8,
        last_agent_output: 'If you want, I can keep going from here.',
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
            CODEX_HOME: codexHome,
            TMUX: '1',
            TMUX_PANE: '%42',
            OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS: '5000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 -l yes, proceed \[OMX_TMUX_INJECT\]/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'recent_turn_activity');
      assert.equal(watcherState.fallback_auto_nudge?.last_turn_count, 8);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not fallback auto-nudge a stalled hud snapshot that notify-hook already nudged', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-auto-nudge-dedup-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const codexHome = join(wd, 'codex-home');
    const lastTurnAt = new Date(Date.now() - 6_000).toISOString();
    const lastMessage = 'If you want, I can keep going from here.';
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        autoNudge: { enabled: true, delaySec: 0 },
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: lastTurnAt,
        turn_count: 7,
        last_agent_output: lastMessage,
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'auto-nudge-state.json'), JSON.stringify({
        nudgeCount: 1,
        lastNudgeAt: new Date().toISOString(),
        lastSignature: `hud:7|${lastTurnAt}|stall:proceed_intent`,
        lastSemanticSignature: 'stall:proceed_intent',
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
            CODEX_HOME: codexHome,
            TMUX: '1',
            TMUX_PANE: '%42',
            OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS: '5000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 -l yes, proceed \[OMX_TMUX_INJECT\]/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'ttl_active');
      assert.equal(watcherState.fallback_auto_nudge?.last_turn_count, 7);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs bounded non-turn team dispatch drain tick in leader context', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-'));
    try {
      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'dispatch ping',
      }, wd);
      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv() },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.ok(request);
      assert.notEqual(request?.status, 'pending');
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
      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv({ OMX_TEAM_WORKER: 'dispatch-team/worker-1', OMX_TEAM_STATE_ROOT: join(wd, '.omx', 'state') }) },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'pending');

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.dispatch_drain?.leader_only, false);
      assert.equal(watcherState.dispatch_drain?.last_result?.reason, 'worker_context');
      assert.equal(watcherState.dispatch_drain?.last_result?.processed, 0);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.ok(drainEvent, 'expected dispatch_drain_tick log event');
      assert.equal(drainEvent.leader_only, false);
      assert.equal(drainEvent.reason, 'worker_context');
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

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l dispatch ping/g) || [];
      assert.equal(typeMatches.length, 1, 'watcher retries should be submit-only when draft remains visible');
      assert.ok(!/send-keys[^\n]*-l[^\n]*C-m/.test(tmuxLog), 'must keep -l payload and C-m submits isolated');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('sends bounded periodic Ralph continue steer while Ralph state stays active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-active-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    const sharedTimestampPath = join(stateDir, 'ralph-last-steer-at');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const first = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const persistedAfterFirst = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.match(
        persistedAfterFirst.ralph_continue_steer?.last_sent_at ?? '',
        /^\d{4}-\d{2}-\d{2}T/,
        'successful steer should persist a round-trippable ISO last_sent_at',
      );
      assert.equal(
        persistedAfterFirst.ralph_continue_steer?.cooldown_anchor_at,
        persistedAfterFirst.ralph_continue_steer?.last_sent_at,
        'successful steer should advance the fallback cooldown anchor to the real send time',
      );

      const second = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const boundedLog = await readFile(tmuxLogPath, 'utf8');
      let sends = boundedLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 1, 'cadence should suppress a second Ralph steer inside 60s');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      const agedIso = new Date(Date.now() - 61_000).toISOString();
      watcherState.ralph_continue_steer.last_sent_at = agedIso;
      watcherState.ralph_continue_steer.shared_last_sent_at = agedIso;
      await writeFile(statePath, JSON.stringify(watcherState, null, 2));
      await writeFile(sharedTimestampPath, `${agedIso}\n`);

      const third = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(third.status, 0, third.stderr || third.stdout);

      const finalLog = await readFile(tmuxLogPath, 'utf8');
      sends = finalLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 2, 'Ralph steer should fire again once the 60s cadence elapses');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses Ralph continue steer when hud progress is still fresh after cooldown', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-progress-fresh-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 5_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0, 'fresh progress should suppress continue steer even after cooldown elapses');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'progress_fresh');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('still sends Ralph continue steer when hud progress is stale after cooldown', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-progress-stale-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 1, 'stale progress should still allow continue steer once cooldown elapses');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'sent');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when Ralph hud progress is missing or invalid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-progress-guard-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const missingRun = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(missingRun.status, 0, missingRun.stderr || missingRun.stdout);
      let watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'progress_missing');

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: 'not-a-date',
      }, null, 2));
      const invalidRun = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(invalidRun.status, 0, invalidRun.stderr || invalidRun.stdout);
      watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'progress_invalid');

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0, 'missing or invalid progress should fail closed without sending steer');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when active Ralph state has no bound tmux pane', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-pane-missing-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'pane_missing');
      assert.equal(watcherState.ralph_continue_steer?.pane_id, '');

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.equal(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/.test(tmuxLog), false);
      assert.equal(/display-message -p -t %42 #{pane_id}/.test(tmuxLog), false, 'watcher should not guess a pane when tmux_pane_id is missing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('waits a full cadence from startup when persisted Ralph steer state is empty', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-startup-cooldown-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: '',
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0, 'empty startup state should wait one cadence period before the first Ralph steer');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'startup_cooldown');
      assert.equal(watcherState.ralph_continue_steer?.last_sent_at, '');
      assert.match(
        watcherState.ralph_continue_steer?.cooldown_anchor_at ?? '',
        /^\d{4}-\d{2}-\d{2}T/,
        'startup cooldown should persist an anchor so restarts stay throttled',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to an aged persisted cooldown anchor when last_sent_at is invalid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-invalid-last-sent-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: 'not-a-date',
          cooldown_anchor_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 1, 'invalid last_sent_at should fall back to the persisted cooldown anchor once 60s have elapsed');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.match(
        watcherState.ralph_continue_steer?.last_sent_at ?? '',
        /^\d{4}-\d{2}-\d{2}T/,
        'successful fallback send should replace the invalid last_sent_at with a valid ISO timestamp',
      );
      assert.equal(
        watcherState.ralph_continue_steer?.cooldown_anchor_at,
        watcherState.ralph_continue_steer?.last_sent_at,
        'fallback send should also refresh the persisted cooldown anchor',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('stops Ralph continue steer immediately once Ralph state is terminal or cleared', async () => {
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
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(watcherStatePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const first = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      watcherState.ralph_continue_steer.last_sent_at = new Date(Date.now() - 61_000).toISOString();
      await writeFile(watcherStatePath, JSON.stringify(watcherState, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(ralphStatePath, JSON.stringify({
        active: false,
        current_phase: 'complete',
        completed_at: new Date().toISOString(),
        tmux_pane_id: '%42',
      }, null, 2));

      const terminalRun = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(terminalRun.status, 0, terminalRun.stderr || terminalRun.stdout);

      await rm(ralphStatePath, { force: true });
      const clearedRun = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env },
      );
      assert.equal(clearedRun.status, 0, clearedRun.stderr || clearedRun.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 1, 'terminal/cleared Ralph state must stop additional periodic steer sends');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('globally debounces Ralph continue steer across concurrent watcher instances', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-global-debounce-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const sharedTimestampPath = join(stateDir, 'ralph-last-steer-at');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(join(stateDir, 'notify-fallback-state.json'), JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      };

      const first = spawn(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { cwd: wd, stdio: 'pipe', env },
      );
      const second = spawn(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { cwd: wd, stdio: 'pipe', env },
      );

      await Promise.all([waitForExit(first, 4000), waitForExit(second, 4000)]);
      assert.equal(first.exitCode, 0);
      assert.equal(second.exitCode, 0);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 1, 'shared timestamp + lock should allow only one concurrent Ralph steer send');

      const sharedTimestamp = (await readFile(sharedTimestampPath, 'utf-8')).trim();
      assert.match(sharedTimestamp, /^\d{4}-\d{2}-\d{2}T/, 'concurrent send winner should persist a shared cooldown timestamp');

      const watcherState = JSON.parse(await readFile(join(stateDir, 'notify-fallback-state.json'), 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.shared_timestamp_path, sharedTimestampPath);
      assert.equal(watcherState.ralph_continue_steer?.shared_last_sent_at, sharedTimestamp);
      assert.match(
        watcherState.ralph_continue_steer?.last_reason ?? '',
        /^(sent|global_cooldown|global_lock_busy)$/,
        'final watcher state should reflect either the winner or a globally throttled loser',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps team control-plane pumping when Ralph continue steer fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-control-plane-split-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath, {
        failSendKeysMatch: 'Ralph loop active continue',
      }));
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
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'notify-fallback-state.json'), JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--dispatch-max-per-tick', '1'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.ok(request);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.dispatch_drain?.run_count, 1);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'send_failed');
      assert.match(watcherState.ralph_continue_steer?.last_error ?? '', /send failed/i);
      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t .* -l dispatch ping/);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.ok(drainEvent, 'expected dispatch_drain_tick log event');
      const ralphFailureEvent = logEntries.find((entry: { type?: string; reason?: string }) => (
        entry.type === 'ralph_continue_steer' && entry.reason === 'send_failed'
      ));
      assert.ok(ralphFailureEvent, 'expected Ralph failure to be logged without aborting team control-plane pumping');
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

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const env = {
        ...buildCleanNotifyEnv(),
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l dispatch ping/g) || [];
      assert.equal(typeMatches.length, 3, 'initial + retype on every retry when trigger absent from narrow area');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('exits when the tracked parent pid is gone', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-exit-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-home-'));
    const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
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
          env: buildCleanNotifyEnv({ HOME: tempHome }),
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


  it('ignores stale session-scoped Ralph state when the current session identity is stale', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stale-session-ralph-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const sessionId = 'sess-stale';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: wd,
        pid: Number.MAX_SAFE_INTEGER,
      }, null, 2));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(watcherStatePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          }),
        },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0, 'stale current-session identity must block Ralph continue injection');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.active, false);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'stale_current_session');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores stale root Ralph state when the current session has not started Ralph', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stale-root-ralph-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const sessionId = 'sess-fresh';
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeSessionStart(wd, sessionId);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(watcherStatePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const run = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          }),
        },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 0, 'fresh sessions must ignore stale root Ralph state');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.active, false);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'blocked_by_current_session');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps ticking for active session-scoped Ralph after parent loss, then stops once Ralph is terminal', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-ralph-active-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-ralph-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const sessionId = 'sess-active-ralph';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
    const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeSessionStart(wd, sessionId);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(join(stateDir, 'notify-fallback-state.json'), JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
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
          env: buildCleanNotifyEnv({ HOME: tempHome, PATH: `${fakeBinDir}:${process.env.PATH || ''}` }),
        }
      );

      await waitFor(async () => {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
        return /send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/.test(tmuxLog);
      }, 4000, 50);

      assert.ok(isPidAlive(child.pid), 'expected watcher to stay alive while Ralph remains active');

      await writeFile(ralphStatePath, JSON.stringify({
        active: false,
        current_phase: 'complete',
        completed_at: new Date().toISOString(),
        tmux_pane_id: '%42',
      }, null, 2));

      await waitForExit(child, 4000);
      assert.equal(child.exitCode, 0);

      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_ralph'
      )));
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

  it('stays alive after parent exit while an active team still has live worker panes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-team-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-team-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const teamStatePath = join(wd, '.omx', 'state', 'team-state.json');
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(teamStatePath, JSON.stringify({
        active: true,
        team_name: 'dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'config.json'), JSON.stringify({
        name: 'dispatch-team',
        tmux_session: 'dispatch-team:0',
        leader_pane_id: '%99',
        workers: [
          { name: 'worker-1', pane_id: '%42' },
        ],
      }, null, 2));
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);

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
          env: buildCleanNotifyEnv({ HOME: tempHome, PATH: `${fakeBinDir}:${process.env.PATH || ''}` }),
        }
      );

      await waitFor(async () => isPidAlive(child?.pid), 4000, 50);
      await waitFor(async () => {
        const logEntries = (await readFile(logPath, 'utf-8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return logEntries.some((entry: { type?: string; reason?: string }) => (
          entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_team'
        ));
      }, 4000, 50);

      assert.ok(isPidAlive(child.pid), 'expected watcher to stay alive while team worker panes remain active');

      await writeFile(teamStatePath, JSON.stringify({
        active: false,
        team_name: 'dispatch-team',
        current_phase: 'complete',
        completed_at: new Date().toISOString(),
      }, null, 2));

      await waitForExit(child, 4000);
      assert.equal(child.exitCode, 0);

      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_team'
      )));
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

  it('does not defer parent-loss shutdown for a team that is already terminal in phase.json', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-terminal-team-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-terminal-team-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'phase.json'), JSON.stringify({
        current_phase: 'complete',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'config.json'), JSON.stringify({
        name: 'dispatch-team',
        tmux_session: 'dispatch-team:0',
        leader_pane_id: '%99',
        workers: [
          { name: 'worker-1', pane_id: '%42' },
        ],
      }, null, 2));
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);

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
          env: buildCleanNotifyEnv({ HOME: tempHome, PATH: `${fakeBinDir}:${process.env.PATH || ''}` }),
        }
      );

      await waitForExit(child, 4000);
      assert.equal(child.exitCode, 0);

      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_team'
      )), false);
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

  it('replaces a stale watcher from the per-cwd pid file', async () => {
    const replacementTimeoutMs = 20000; // c8-instrumented Node20 full runs can delay watcher handoff well beyond 8s.
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stale-pid-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-stale-home-'));
    const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
    const pidPath = join(wd, '.omx', 'state', 'notify-fallback.pid');
    let first: ReturnType<typeof spawn> | undefined;
    let second: ReturnType<typeof spawn> | undefined;

    try {
      first = spawn(
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
          String(process.pid),
          '--max-lifetime-ms',
          '5000',
        ],
        {
          cwd: wd,
          stdio: 'ignore',
          env: buildCleanNotifyEnv({ HOME: tempHome }),
        }
      );
      assert.ok(first.pid, 'expected first watcher pid');

      await waitFor(async () => {
        try {
          const pidFile = JSON.parse(await readFile(pidPath, 'utf-8')) as { pid?: number; owner_token?: string };
          assert.match(pidFile.owner_token ?? '', /^\d+-\d+-/, 'pid file should include an ownership token');
          return pidFile.pid === first?.pid;
        } catch {
          return false;
        }
      }, replacementTimeoutMs, 50);

      second = spawn(
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
          String(process.pid),
          '--max-lifetime-ms',
          '5000',
        ],
        {
          cwd: wd,
          stdio: 'ignore',
          env: buildCleanNotifyEnv({ HOME: tempHome }),
        }
      );
      assert.ok(second.pid, 'expected second watcher pid');

      await waitForExit(first, replacementTimeoutMs);
      assert.equal(first.exitCode, 0);

      await waitFor(async () => {
        try {
          const pidFile = JSON.parse(await readFile(pidPath, 'utf-8')) as { pid?: number; owner_token?: string };
          assert.match(pidFile.owner_token ?? '', /^\d+-\d+-/, 'replacement pid file should keep ownership metadata');
          return pidFile.pid === second?.pid;
        } catch {
          return false;
        }
      }, replacementTimeoutMs, 50);

      assert.ok(isPidAlive(second.pid), 'expected replacement watcher to remain alive');
    } finally {
      if (second && isPidAlive(second.pid)) {
        second.kill('SIGTERM');
        await waitForExit(second, replacementTimeoutMs).catch(() => {});
      }
      if (first && isPidAlive(first.pid)) {
        first.kill('SIGTERM');
        await waitForExit(first, replacementTimeoutMs).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('exits after the configured max lifetime', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-max-life-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-max-home-'));
    const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
    const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
    let child: ReturnType<typeof spawn> | undefined;

    try {
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
          String(process.pid),
          '--max-lifetime-ms',
          '200',
        ],
        {
          cwd: wd,
          stdio: 'ignore',
          env: buildCleanNotifyEnv({ HOME: tempHome }),
        }
      );

      await waitForExit(child, 4000);
      assert.equal(child.exitCode, 0);

      const logEntries = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_stop' && entry.reason === 'max_lifetime_exceeded'
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
