import { describe, it } from 'node:test';
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

function buildFakeTmux(tmuxLogPath: string): string {
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
  if [[ "$fmt" == "#S" ]]; then
    echo "session-test"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
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
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '75'],
        {
          cwd: wd,
          stdio: 'ignore',
          env: { ...process.env, HOME: tempHome },
        }
      );
      await sleep(150);

      await appendLine(rolloutPath, {
        timestamp: new Date(Date.now() + 500).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: newTurn,
          last_agent_message: 'new message',
        },
      });

      await sleep(500);
      child.kill('SIGTERM');
      await sleep(100);

      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
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

  it('watcher retry allows one fallback retype only when pre-capture misses trigger', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-cm-fallback-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const captureSeqFile = join(wd, 'capture-seq.txt');
    const captureCounterFile = join(wd, 'capture-seq.idx');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(captureSeqFile, [
        'dispatch ping', 'dispatch ping', 'dispatch ping',
        'ready',
        'dispatch ping', 'dispatch ping', 'dispatch ping',
        'ready',
        'dispatch ping', 'dispatch ping', 'dispatch ping',
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l dispatch ping/g) || [];
      assert.equal(typeMatches.length, 2, 'fresh + one retry fallback retype max');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
