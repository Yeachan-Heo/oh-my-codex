import { describe, it } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initTeamState, enqueueDispatchRequest, readDispatchRequest } from '../../team/state.js';
import { buildTmuxSessionName, buildWindowsMsysBackgroundHelperBootstrapScript } from '../../cli/index.js';
import { writeSessionStart } from '../session.js';

const DEFAULT_AUTO_NUDGE_RESPONSE = 'continue with the current task only if it is already authorized';

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

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, 'utf-8').catch(() => '');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeCanonicalWatcherTeamFixture(
  wd: string,
  {
    teamName = 'dispatch-team',
    sessionId = 'sess-current',
    ownerSessionId = sessionId,
    coarseState = 'missing',
    terminal = false,
  }: {
    teamName?: string;
    sessionId?: string;
    ownerSessionId?: string;
    coarseState?: 'missing' | 'inactive' | 'active';
    terminal?: boolean;
  } = {},
): Promise<void> {
  const stateDir = join(wd, '.omx', 'state');
  const teamDir = join(stateDir, 'team', teamName);
  const nowIso = new Date().toISOString();

  await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
  await mkdir(join(teamDir, 'workers'), { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
  if (coarseState !== 'missing') {
    await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
      active: coarseState === 'active',
      team_name: teamName,
      current_phase: terminal ? 'complete' : 'team-exec',
      ...(terminal ? { completed_at: nowIso } : {}),
    }, null, 2));
  }
  await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
    last_turn_at: new Date(Date.now() - 300_000).toISOString(),
    turn_count: 3,
  }, null, 2));
  const manifest = {
    schema_version: 2,
    name: teamName,
    task: 'canonical watcher fallback repro',
    leader: {
      session_id: ownerSessionId,
      worker_id: 'leader-fixed',
      role: 'coordinator',
    },
    policy: {
      worker_launch_mode: 'interactive',
      display_mode: 'split_pane',
      dispatch_mode: 'hook_preferred_with_fallback',
      dispatch_ack_timeout_ms: 2000,
    },
    governance: {
      delegation_only: false,
      plan_approval_required: false,
      nested_teams_allowed: false,
      one_team_per_leader_session: true,
      cleanup_requires_all_workers_inactive: true,
    },
    lifecycle_profile: 'default',
    permissions_snapshot: {
      approval_mode: 'never',
      sandbox_mode: 'danger-full-access',
      network_access: true,
    },
    tmux_session: `${teamName}:0`,
    leader_pane_id: '%42',
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    worker_count: 1,
    next_task_id: 1,
    workers: [
      { name: 'worker-1', index: 1, pane_id: '%42', role: 'executor' },
    ],
    created_at: nowIso,
  };
  await writeFile(join(teamDir, 'manifest.v2.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(teamDir, 'config.json'), JSON.stringify({
    name: teamName,
    tmux_session: `${teamName}:0`,
    leader_pane_id: '%42',
    workers: [
      { name: 'worker-1', pane_id: '%42' },
    ],
  }, null, 2));
  await writeFile(join(teamDir, 'phase.json'), JSON.stringify({
    current_phase: terminal ? 'complete' : 'team-exec',
    updated_at: nowIso,
    transitions: terminal ? [{ from: 'team-exec', to: 'complete', at: nowIso }] : [],
  }, null, 2));
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

function defaultAutoNudgePattern(targetPane: string): RegExp {
  return new RegExp(`send-keys -t ${targetPane} -l ${DEFAULT_AUTO_NUDGE_RESPONSE.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} \\[OMX_TMUX_INJECT\\]`);
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
    echo "\${OMX_TEST_TMUX_SESSION_NAME:-session-test}"
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
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t)
        shift
        target="$1"
        ;;
    esac
    shift || true
  done
  if [[ -n "$target" ]]; then
    printf "%%42\tcodex\tcodex\n"
    exit 0
  fi
  echo "%42 1"
  exit 0
fi
exit 0
`;
}

function buildManagedRalphTmux(
  tmuxLogPath: string,
  options: {
    cwd: string;
    managedSessionName: string;
    anchorPane: string;
    livePane: string;
    codexPanes?: Array<{ paneId: string; active?: boolean; currentCommand?: string; startCommand?: string }>;
    missingAnchor?: boolean;
  },
): string {
  const { cwd, managedSessionName, anchorPane, livePane, codexPanes, missingAnchor = false } = options;
  const panes = (codexPanes && codexPanes.length > 0)
    ? codexPanes
    : [{ paneId: livePane, active: true, currentCommand: 'codex', startCommand: 'codex' }];
  const listPaneOutput = panes
    .map((pane) => {
      const paneId = pane.paneId;
      const active = pane.active ? '1' : '0';
      const currentCommand = pane.currentCommand || 'codex';
      const startCommand = pane.startCommand || 'codex';
      return `${paneId}\t${active}\t${currentCommand}\t${startCommand}`;
    })
    .join('\n');
  const paneCommandBranches = panes
    .map((pane) => {
      const currentCommand = (pane.currentCommand || 'codex').replace(/"/g, '\\"');
      const startCommand = (pane.startCommand || 'codex').replace(/"/g, '\\"');
      return `  if [[ "$format" == "#{pane_current_command}" && "$target" == "${pane.paneId}" ]]; then
    echo "${currentCommand}"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "${pane.paneId}" ]]; then
    echo "${startCommand}"
    exit 0
  fi`;
    })
    .join('\n');
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$target" == "${anchorPane}" && "${missingAnchor ? '1' : '0'}" == "1" ]]; then
    echo "pane missing" >&2
    exit 1
  fi
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{pane_id}" ]]; then
    echo "$target"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" ]]; then
    echo "${cwd}"
    exit 0
  fi
${paneCommandBranches}
  if [[ "$format" == "#S" ]]; then
    if [[ "$target" == "${anchorPane}" || "$target" == "${livePane}" ]]; then
      echo "${managedSessionName}"
      exit 0
    fi
    echo "unknown target" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -F) shift 2 ;;
      -t) shift; target="$1" ;;
    esac
    shift || true
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf '%s\n' "${listPaneOutput}"
    exit 0
  fi
  echo "can't find session" >&2
  exit 1
fi
if [[ "$cmd" == "capture-pane" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
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
  it('uses offset-bounded rollout reads instead of re-reading whole tracked files', async () => {
    const source = await readFile(new URL('../../scripts/notify-fallback-watcher.js', import.meta.url), 'utf-8');

    assert.match(source, /async function readFileDelta/);
    assert.match(source, /while \(totalBytesRead < length\)/);
    assert.match(source, /nextOffset: offset \+ totalBytesRead/);
    assert.match(source, /new StringDecoder\('utf8'\)/);
    assert.match(source, /decoder\.write\(bytes\)/);
    assert.match(source, /const fileStat = await stat\(path\)\.catch\(\(\) => null\);\s*if \(!fileStat\)\s*continue;/);
    assert.match(source, /if \(currentSize < meta\.offset\) \{\s*meta\.offset = 0;\s*meta\.partial = '';/);
    assert.doesNotMatch(source, /const content = await readFile\(path, 'utf-8'\)[\s\S]*const delta = content\.slice\(meta\.offset\)/);
    assert.doesNotMatch(source, /stat\(path\)\.catch\(\(\) => \(\{ size: 0 \}\)\)/);
  });

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

      const fallbackLog = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const fallbackEntries = await readJsonLines(fallbackLog);
      assert.deepEqual(fallbackEntries.map((entry) => entry.type), ['fallback_notify']);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
      await rm(rolloutPath, { force: true });
    }
  });

  it('rotates notify-fallback logs when the size cap is exceeded', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-once-rotate-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = randomUUID();
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-rotate-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const threadId = `thread-${sid}`;
      const turnIds = ['first', 'second', 'third'].map((label) => `turn-${label}-${sid}`);
      const nowIso = new Date(Date.now() + 2_000).toISOString();
      const lines = [
        {
          timestamp: nowIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        },
        ...turnIds.map((turnId) => ({
          timestamp: nowIso,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: turnId,
            last_agent_message: `message for ${turnId}`,
          },
        })),
      ];
      await writeFile(rolloutPath, `${lines.map(v => JSON.stringify(v)).join('\n')}\n`);

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50', '--log-max-bytes', '1'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv({ HOME: tempHome }) }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const fallbackLog = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const rotatedLog = `${fallbackLog}.1`;
      const currentEntries = await readJsonLines(fallbackLog);
      const rotatedEntries = await readJsonLines(rotatedLog);

      assert.equal(currentEntries.length, 1);
      assert.equal(rotatedEntries.length, 1);
      assert.equal(currentEntries[0]?.turn_id, turnIds[2]);
      assert.equal(rotatedEntries[0]?.turn_id, turnIds[1]);
      assert.deepEqual(currentEntries.map((entry) => entry.type), ['fallback_notify']);
      assert.deepEqual(rotatedEntries.map((entry) => entry.type), ['fallback_notify']);
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

  it('streaming mode preserves multibyte text split across polling reads', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stream-utf8-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = randomUUID();
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-stream-utf8-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const nowIso = new Date().toISOString();
      const threadId = `thread-${sid}`;
      const utf8Turn = `turn-utf8-${sid}`;
      const emojiMessage = 'split emoji 🧪 preserved';

      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          timestamp: nowIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        })}\n`
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

      const eventLine = `${JSON.stringify({
        timestamp: new Date(Date.now() + 500).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: utf8Turn,
          last_agent_message: emojiMessage,
        },
      })}\n`;
      const bytes = Buffer.from(eventLine, 'utf8');
      const emojiOffset = bytes.indexOf(Buffer.from('🧪', 'utf8'));
      assert.ok(emojiOffset > 0, 'expected test payload to contain emoji bytes');

      await appendFile(rolloutPath, bytes.subarray(0, emojiOffset + 1));
      await sleep(250);
      assert.equal((await readLines(turnLog)).length, 0, 'incomplete UTF-8 and JSON line should not emit');

      const hiddenRolloutPath = `${rolloutPath}.missing`;
      await rename(rolloutPath, hiddenRolloutPath);
      await sleep(250);
      assert.equal((await readLines(turnLog)).length, 0, 'transient missing file should preserve buffered bytes');
      await rename(hiddenRolloutPath, rolloutPath);

      await appendFile(rolloutPath, bytes.subarray(emojiOffset + 1));
      await waitFor(async () => {
        const turnLines = await readLines(turnLog);
        return turnLines.length === 1 && turnLines[0]!.includes(utf8Turn) && turnLines[0]!.includes(emojiMessage);
      }, 4000, 75);

      child.kill('SIGTERM');
      await once(child, 'exit');

      const turnLines = await readLines(turnLog);
      assert.equal(turnLines.length, 1);
      assert.match(turnLines[0], new RegExp(utf8Turn));
      assert.match(turnLines[0], /split emoji 🧪 preserved/);
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

  it('suppresses idle no-op lifecycle and control-plane logs during authority-only one-shot ticks', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-authority-noop-'));
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--authority-only', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv() },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.authority_only, true);
      assert.equal(watcherState.dispatch_drain?.run_count, 1);
      assert.equal(watcherState.dispatch_drain?.last_result?.processed ?? 0, 0);
      assert.equal(watcherState.leader_nudge?.run_count, 1);
      assert.equal(watcherState.leader_nudge?.precomputed_leader_stale, false);
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'hud_state_missing');

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logContent = await readFile(logPath, 'utf-8').catch(() => '');
      assert.equal(logContent.trim(), '');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses authority-only control-plane ticks when only skill-active-state carries the deep-interview input lock', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-authority-skill-lock-'));
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'],
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--authority-only', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env: buildCleanNotifyEnv() },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.authority_only, true);
      assert.equal(watcherState.dispatch_drain?.run_count, 1);
      assert.equal(watcherState.leader_nudge?.run_count, 0);
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'init');

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logContent = await readFile(logPath, 'utf-8').catch(() => '');
      assert.equal(logContent.trim(), '');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('backs off authority-only nudge ticks when the primary watcher is healthy', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-authority-backed-off-'));
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
      await writeSessionStart(wd, 'sess-managed-fallback');
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-managed-fallback'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'sessions', 'sess-managed-fallback', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 6_000).toISOString(),
        turn_count: 7,
        last_agent_output: 'Keep going and finish the cleanup from here.',
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'notify-fallback.pid'), JSON.stringify({
        pid: process.pid,
        cwd: wd,
        started_at: new Date().toISOString(),
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'notify-fallback-state.json'), JSON.stringify({
        pid: process.pid,
        cwd: wd,
        authority_only: false,
        poll_ms: 250,
        dispatch_drain: { last_tick_at: new Date().toISOString() },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--authority-only', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
            CODEX_HOME: codexHome,
            OMX_SESSION_ID: 'sess-managed-fallback',
            TMUX: '1',
            TMUX_PANE: '%42',
            OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS: '5000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%42'));

      const watcherState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'notify-fallback-state.json'), 'utf-8'));
      assert.equal(watcherState.pid, process.pid, 'authority backoff should preserve the primary watcher state owner');
      assert.equal(watcherState.authority_only, false, 'authority backoff should not overwrite primary watcher ownership');
      assert.equal(watcherState.authority_backoff?.active, true);
      assert.equal(watcherState.authority_backoff?.reason, 'primary_watcher_healthy');
      assert.equal(watcherState.authority_backoff?.primary_pid, process.pid);
      assert.match(watcherState.dispatch_drain?.last_tick_at ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const logPath = join(wd, '.omx', 'logs', `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logContent = await readFile(logPath, 'utf-8').catch(() => '');
      assert.equal(logContent.trim(), '');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });



  it('treats symlinked cwd aliases as the same primary watcher during authority handoff', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-cwd-alias-'));
    const aliasWd = `${wd}-alias`;
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await symlink(wd, aliasWd, process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeSessionStart(wd, 'sess-cwd-alias');
      await writeFile(join(wd, '.omx', 'state', 'notify-fallback.pid'), JSON.stringify({
        pid: process.pid,
        cwd: wd,
        started_at: new Date().toISOString(),
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'notify-fallback-state.json'), JSON.stringify({
        pid: process.pid,
        cwd: wd,
        authority_only: false,
        poll_ms: 250,
        dispatch_drain: { last_tick_at: new Date().toISOString() },
      }, null, 2));

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--authority-only', '--cwd', aliasWd, '--notify-script', notifyHook, '--poll-ms', '50'],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
            OMX_SESSION_ID: 'sess-cwd-alias',
            TMUX: '1',
            TMUX_PANE: '%42',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const watcherState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'notify-fallback-state.json'), 'utf-8'));
      assert.equal(watcherState.authority_backoff?.active, true);
      assert.equal(watcherState.authority_backoff?.reason, 'primary_watcher_healthy');
      assert.equal(watcherState.authority_backoff?.primary_pid, process.pid);
    } finally {
      await rm(aliasWd, { recursive: true, force: true });
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
      assert.doesNotMatch(tmuxLog, new RegExp(`${DEFAULT_AUTO_NUDGE_RESPONSE.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} \\[OMX_TMUX_INJECT\\]`));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('disables fallback watcher nudges when only skill-active-state carries the deep-interview input lock', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-deep-interview-skill-lock-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      await writeFile(join(wd, '.omx', 'state', 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'],
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
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
      assert.doesNotMatch(tmuxLog, new RegExp(`${DEFAULT_AUTO_NUDGE_RESPONSE.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} \\[OMX_TMUX_INJECT\\]`));
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
            OMX_SESSION_ID: 'sess-canonical-inactive',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l Team dispatch-team: leader stale, \d+ worker pane\(s\) still active\./);

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

      const deliveryLogPath = join(wd, '.omx', 'logs', `team-delivery-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const deliveryEntries = await readJsonLines(deliveryLogPath);
      assert.ok(deliveryEntries.some((entry) =>
        entry.event === 'nudge_triggered'
        && entry.source === 'notify_fallback_watcher'
        && entry.transport === 'send-keys'
        && entry.result === 'sent'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs leader nudge checks from canonical fallback when coarse team-state is inactive', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-leader-nudge-canonical-inactive-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeCanonicalWatcherTeamFixture(wd, {
        teamName: 'dispatch-team',
        sessionId: 'sess-canonical-inactive',
        ownerSessionId: 'sess-canonical-inactive',
        coarseState: 'inactive',
      });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook],
        {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
            PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
            OMX_SESSION_ID: 'sess-canonical-inactive',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l Team dispatch-team: leader stale, \d+ worker pane\(s\) still active\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores invalid session_id before watcher session path joins', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-invalid-session-id-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeCanonicalWatcherTeamFixture(wd, {
        teamName: 'dispatch-team',
        sessionId: 'safe-session',
        ownerSessionId: 'safe-session',
        coarseState: 'inactive',
      });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: '../escape',
        cwd: wd,
        pid: process.pid,
        started_at: new Date().toISOString(),
      }, null, 2));
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

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
      assert.equal(tmuxLog, '', 'invalid session_id should not reach session-scoped or canonical follow-up joins');
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
            OMX_SESSION_ID: 'sess-canonical-inactive',
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
      const logEntries = await readJsonLines(logPath);
      const nudgeEvent = logEntries.find((entry: { type?: string }) => entry.type === 'leader_nudge_tick');
      assert.equal(nudgeEvent, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs stalled-worker leader nudges from the fallback watcher even when the leader is not stale', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-worker-stall-nudge-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'workers', 'worker-1'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'tasks'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      const tmuxScript = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
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
    echo "omx-team-dispatch-team"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t)
        shift
        target="$1"
        ;;
    esac
    shift || true
  done
  if [[ -n "$target" ]]; then
    printf "%%42 12345\n%%10 12346\n%%11 12347\n"
    exit 0
  fi
  echo "%42 1"
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), tmuxScript);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const now = Date.now();
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
        workers: [
          { name: 'worker-1', index: 1, pane_id: '%10' },
          { name: 'worker-2', index: 2, pane_id: '%11' },
        ],
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json'), JSON.stringify({
        id: '1',
        subject: 'Pending work',
        description: 'Needs attention',
        status: 'pending',
        created_at: new Date().toISOString(),
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'status.json'), JSON.stringify({
        state: 'working',
        current_task_id: '1',
        updated_at: new Date(now - 180_000).toISOString(),
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'heartbeat.json'), JSON.stringify({
        alive: true,
        pid: 101,
        turn_count: 2,
        last_turn_at: new Date(now - 180_000).toISOString(),
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'team-leader-nudge.json'), JSON.stringify({
        last_nudged_by_team: {
          'dispatch-team': {
            at: new Date(now - 5_000).toISOString(),
            last_message_id: '',
            reason: 'new_mailbox_message',
          },
        },
        progress_by_team: {
          'dispatch-team': {
            signature: JSON.stringify({
              tasks: [{ id: '1', owner: '', status: 'pending' }],
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
            }),
            last_progress_at: new Date(now - 180_000).toISOString(),
          },
        },
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
            OMX_TEAM_PROGRESS_STALL_MS: '60000',
            OMX_TEAM_LEADER_NUDGE_MS: '30000',
            OMX_TEAM_LEADER_STALE_MS: '60000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l Team dispatch-team: worker panes stalled, no progress 3m\./);
      assert.doesNotMatch(tmuxLog, /leader stale/);

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.leader_nudge?.enabled, true);
      assert.equal(watcherState.leader_nudge?.leader_only, true);
      assert.equal(watcherState.leader_nudge?.run_count, 1);
      assert.equal(watcherState.leader_nudge?.precomputed_leader_stale, false);
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
      await writeSessionStart(wd, 'sess-managed-fallback');
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-managed-fallback'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'sessions', 'sess-managed-fallback', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 6_000).toISOString(),
        turn_count: 7,
        last_agent_output: 'Keep going and finish the cleanup from here.',
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
            OMX_SESSION_ID: 'sess-managed-fallback',
            OMX_TEST_TMUX_SESSION_NAME: 'omx-fallback-auto-nudge-stalled-managed',
            TMUX: '1',
            TMUX_PANE: '%42',
            OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS: '5000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%42'));

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'sent');
      assert.equal(watcherState.fallback_auto_nudge?.last_turn_count, 7);
      assert.match(watcherState.fallback_auto_nudge?.last_nudged_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('respects `.omx/tmux-hook.json` enabled:false for fallback auto-nudge', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-auto-nudge-disabled-'));
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
      await writeFile(join(wd, '.omx', 'tmux-hook.json'), JSON.stringify({
        enabled: false,
        target: { type: 'pane', value: '%42' },
      }, null, 2));
      await writeSessionStart(wd, 'sess-managed-fallback');
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-managed-fallback'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'sessions', 'sess-managed-fallback', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 6_000).toISOString(),
        turn_count: 7,
        last_agent_output: 'Keep going and finish the cleanup from here.',
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
            OMX_SESSION_ID: 'sess-managed-fallback',
            TMUX: '1',
            TMUX_PANE: '%42',
            OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS: '5000',
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%42'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses fallback unmanaged-session auto-nudge skip logs while idle', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-auto-nudge-unmanaged-'));
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
        turn_count: 9,
        last_agent_output: 'Keep going and finish the cleanup from here.',
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
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%42'));

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'eligible_but_not_sent');

      const tmuxHookLogPath = join(wd, '.omx', 'logs', `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const tmuxHookLog = await readFile(tmuxHookLogPath, 'utf-8').catch(() => '');
      assert.equal(tmuxHookLog.trim(), '');
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
        last_agent_output: 'Keep going and finish the cleanup from here.',
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
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%42'));

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
    const lastMessage = 'Keep going and finish the cleanup from here.';
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
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%42'));

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'already_nudged_for_signature');
      assert.equal(watcherState.fallback_auto_nudge?.last_turn_count, 7);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not fallback auto-nudge the same stalled hud turn again after TTL expiry', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-auto-nudge-exact-dedup-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const codexHome = join(wd, 'codex-home');
    const lastTurnAt = '2026-03-01T00:00:00.000Z';
    const lastMessage = 'Keep going and finish the cleanup from here.';
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        autoNudge: { enabled: true, delaySec: 0, ttlMs: 5000 },
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: lastTurnAt,
        turn_count: 7,
        last_agent_output: lastMessage,
      }, null, 2));
      await writeFile(join(wd, '.omx', 'state', 'auto-nudge-state.json'), JSON.stringify({
        nudgeCount: 1,
        lastNudgeAt: '2026-03-01T00:00:10.000Z',
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
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%42'));

      const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.fallback_auto_nudge?.last_reason, 'already_nudged_for_signature');
      assert.equal(watcherState.fallback_auto_nudge?.last_turn_count, 7);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs bounded non-turn team dispatch drain tick in leader context', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
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
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips dispatch drain in worker context (leader-only guard)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-worker-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
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
      const logEntries = await readJsonLines(logPath);
      const drainEvent = logEntries.find((entry: { type?: string }) => entry.type === 'dispatch_drain_tick');
      assert.equal(drainEvent, undefined);
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('watcher retry does not retype when pre-capture still contains trigger', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-cm-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const captureFile = join(wd, 'capture.txt');
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(captureFile, '... ping ...');

      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
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
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
      assert.equal(typeMatches.length, 1, 'fresh attempt should type once; retries with draft should be submit-only');
      const cmMatches = tmuxLog.match(/send-keys -t %42 C-m/g) || [];
      assert.ok(cmMatches.length > 0, 'submit should use C-m');
      assert.ok(!/send-keys[^\n]*-l[^\n]*C-m/.test(tmuxLog), 'must keep -l payload and C-m submits isolated');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.attempt_count, 2);
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
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

  it('suppresses Ralph continue steer when session-scoped Ralph is stuck in stale starting phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-starting-stale-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const sessionId = 'sess-starting-stale';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeSessionStart(wd, sessionId);
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: new Date(Date.now() - 180_000).toISOString(),
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 180_000).toISOString(),
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
      assert.equal(sends.length, 0, 'stale starting phase should suppress continue steer');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'starting_stale');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses Ralph continue steer while tracked native subagents are still active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-subagents-active-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const statePath = join(stateDir, 'notify-fallback-state.json');
    const omxSessionId = 'sess-current';
    const codexSessionId = 'codex-session-1';
    try {
      await mkdir(join(stateDir, 'sessions', omxSessionId), { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeSessionStart(wd, omxSessionId);
      await writeFile(join(stateDir, 'sessions', omxSessionId, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: '%42',
        owner_omx_session_id: omxSessionId,
        owner_codex_session_id: codexSessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'sessions', omxSessionId, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
      }, null, 2));
      await writeFile(statePath, JSON.stringify({
        ralph_continue_steer: {
          last_sent_at: new Date(Date.now() - 61_000).toISOString(),
        },
      }, null, 2));
      await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [codexSessionId]: {
            session_id: codexSessionId,
            leader_thread_id: 'leader-thread',
            updated_at: new Date(Date.now() - 15_000).toISOString(),
            threads: {
              'leader-thread': {
                thread_id: 'leader-thread',
                kind: 'leader',
                first_seen_at: new Date(Date.now() - 30_000).toISOString(),
                last_seen_at: new Date(Date.now() - 15_000).toISOString(),
                turn_count: 1,
                mode: 'ralph',
              },
              'sub-thread-1': {
                thread_id: 'sub-thread-1',
                kind: 'subagent',
                first_seen_at: new Date(Date.now() - 30_000).toISOString(),
                last_seen_at: new Date(Date.now() - 15_000).toISOString(),
                turn_count: 1,
                mode: 'ralph',
              },
            },
          },
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
      assert.equal(sends.length, 0, 'active native subagents should block fallback continue steer');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'subagents_active');
      assert.equal(watcherState.ralph_continue_steer?.subagent_session_id, codexSessionId);
      assert.deepEqual(watcherState.ralph_continue_steer?.active_subagent_thread_ids, ['sub-thread-1']);
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
          pane_id: '%7',
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
      assert.equal(watcherState.ralph_continue_steer?.pane_id, '%42');

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
      assert.equal(watcherState.ralph_continue_steer?.pane_id, '%42');

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

  it('rebinds a stale-but-present session-scoped Ralph shell pane to the live pane before continue steer', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-rebind-stale-anchor-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const sessionId = 'sess-ralph-rebind';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const anchorPane = '%99';
    const livePane = '%42';
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeSessionStart(wd, sessionId);
      const managedSessionName = buildTmuxSessionName(wd, sessionId);
      await writeFile(join(fakeBinDir, 'tmux'), buildManagedRalphTmux(tmuxLogPath, {
        cwd: wd,
        managedSessionName,
        anchorPane,
        livePane,
        codexPanes: [
          { paneId: anchorPane, active: false, currentCommand: 'sh', startCommand: 'bash' },
          { paneId: '%41', active: false, currentCommand: 'codex', startCommand: 'codex' },
          { paneId: livePane, active: true, currentCommand: 'codex', startCommand: 'codex' },
        ],
      }));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: anchorPane,
      }, null, 2));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
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

      const persistedRalph = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
      assert.equal(persistedRalph.tmux_pane_id, livePane);
      assert.match(persistedRalph.tmux_pane_set_at ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'sent');
      assert.equal(watcherState.ralph_continue_steer?.pane_id, livePane);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves newer Ralph state fields when a pane rebound happens after the state file advances', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-rebind-state-merge-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const sessionId = 'sess-ralph-rebind-merge';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const anchorPane = '%99';
    const livePane = '%42';
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeSessionStart(wd, sessionId);
      const managedSessionName = buildTmuxSessionName(wd, sessionId);
      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{pane_id}" ]]; then
    echo "$target"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" ]]; then
    echo "${wd}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "${anchorPane}" ]]; then
    echo "sh"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "${anchorPane}" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "${anchorPane}" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -F) shift 2 ;;
      -t) shift; target="$1" ;;
    esac
    shift || true
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    cat > "${ralphStatePath}" <<'JSON'
{
  "active": true,
  "current_phase": "reviewing",
  "iteration": 11,
  "owner_codex_session_id": "codex-updated-owner",
  "tmux_pane_id": "%99"
}
JSON
    printf "%%99\t0\tsh\tbash\n%%42\t1\tcodex\tcodex\n"
    exit 0
  fi
  echo "can't find session" >&2
  exit 1
fi
if [[ "$cmd" == "capture-pane" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        iteration: 1,
        owner_codex_session_id: 'codex-stale-owner',
        tmux_pane_id: anchorPane,
      }, null, 2));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
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

      const persistedRalph = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
      assert.equal(persistedRalph.tmux_pane_id, livePane);
      assert.equal(persistedRalph.current_phase, 'reviewing');
      assert.equal(persistedRalph.iteration, 11);
      assert.equal(persistedRalph.owner_codex_session_id, 'codex-updated-owner');
      assert.match(persistedRalph.tmux_pane_set_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps the verified Ralph anchor pane when another codex pane is focused in the same managed session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-keep-anchor-pane-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const sessionId = 'sess-ralph-keep-anchor';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const anchorPane = '%99';
    const livePane = '%42';
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeSessionStart(wd, sessionId);
      const managedSessionName = buildTmuxSessionName(wd, sessionId);
      await writeFile(join(fakeBinDir, 'tmux'), buildManagedRalphTmux(tmuxLogPath, {
        cwd: wd,
        managedSessionName,
        anchorPane,
        livePane,
        codexPanes: [
          { paneId: anchorPane, active: false, currentCommand: 'codex', startCommand: 'codex' },
          { paneId: livePane, active: true, currentCommand: 'codex', startCommand: 'codex' },
        ],
      }));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: anchorPane,
      }, null, 2));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
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

      const persistedRalph = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
      assert.equal(persistedRalph.tmux_pane_id, anchorPane);
      assert.equal(typeof persistedRalph.tmux_pane_set_at, 'undefined');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'sent');
      assert.equal(watcherState.ralph_continue_steer?.pane_id, anchorPane);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %99 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rebinds a shell-degraded codex anchor to the live pane before continue steer', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-rebind-degraded-codex-anchor-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const sessionId = 'sess-ralph-degraded-codex-anchor';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const anchorPane = '%99';
    const livePane = '%42';
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeSessionStart(wd, sessionId);
      const managedSessionName = buildTmuxSessionName(wd, sessionId);
      await writeFile(join(fakeBinDir, 'tmux'), buildManagedRalphTmux(tmuxLogPath, {
        cwd: wd,
        managedSessionName,
        anchorPane,
        livePane,
        codexPanes: [
          { paneId: anchorPane, active: true, currentCommand: 'bash', startCommand: 'codex --model gpt-5' },
          { paneId: livePane, active: false, currentCommand: 'codex', startCommand: 'codex' },
        ],
      }));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: anchorPane,
      }, null, 2));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
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

      const persistedRalph = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
      assert.equal(persistedRalph.tmux_pane_id, livePane);
      assert.match(persistedRalph.tmux_pane_set_at ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'sent');
      assert.equal(watcherState.ralph_continue_steer?.pane_id, livePane);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to the current managed session pane when the stored Ralph pane anchor is dead', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-rebind-dead-anchor-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const stateDir = join(wd, '.omx', 'state');
    const tmuxLogPath = join(wd, 'tmux.log');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const sessionId = 'sess-ralph-dead-anchor';
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    const ralphStatePath = join(sessionStateDir, 'ralph-state.json');
    const anchorPane = '%99';
    const livePane = '%42';
    try {
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeSessionStart(wd, sessionId);
      const managedSessionName = buildTmuxSessionName(wd, sessionId);
      await writeFile(join(fakeBinDir, 'tmux'), buildManagedRalphTmux(tmuxLogPath, {
        cwd: wd,
        managedSessionName,
        anchorPane,
        livePane,
        codexPanes: [
          { paneId: '%41', active: false, currentCommand: 'codex', startCommand: 'codex' },
          { paneId: livePane, active: true, currentCommand: 'codex', startCommand: 'codex' },
        ],
        missingAnchor: true,
      }));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(ralphStatePath, JSON.stringify({
        active: true,
        current_phase: 'executing',
        tmux_pane_id: anchorPane,
      }, null, 2));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 61_000).toISOString(),
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

      const persistedRalph = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
      assert.equal(persistedRalph.tmux_pane_id, livePane);
      assert.match(persistedRalph.tmux_pane_set_at ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'sent');
      assert.equal(watcherState.ralph_continue_steer?.pane_id, livePane);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /display-message -p -t %99 #S/);
      assert.match(tmuxLog, /list-panes -s -t .*sess-ralph-dead-anchor/);
      assert.match(tmuxLog, /send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('sends the first Ralph continue steer immediately when persisted steer state is empty', async () => {
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf8').catch(() => '');
      const sends = tmuxLog.match(/send-keys -t %42 -l Ralph loop active continue \[OMX_TMUX_INJECT\]/g) || [];
      assert.equal(sends.length, 1, 'empty startup state should send the first Ralph steer immediately once progress is stale');

      const watcherState = JSON.parse(await readFile(statePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'sent');
      assert.match(
        watcherState.ralph_continue_steer?.last_sent_at ?? '',
        /^\d{4}-\d{2}-\d{2}T/,
        'first steer should persist a real send timestamp for active-state signaling',
      );
      assert.equal(
        watcherState.ralph_continue_steer?.cooldown_anchor_at,
        watcherState.ralph_continue_steer?.last_sent_at,
        'first steer should anchor subsequent cooldowns to the real send time',
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

  it('treats blocked_on_user as terminal so Ralph continue steer stays off', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-blocked-on-user-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        current_phase: 'blocked_on_user',
        completed_at: new Date().toISOString(),
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
      assert.equal(sends.length, 0, 'blocked_on_user should suppress Ralph continue steer');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.active, false);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'terminal');
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

  it('treats a long-running starting phase as terminal so Ralph steer stops', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-starting-phase-stale-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    const staleStartedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: staleStartedAt,
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 5 * 60_000).toISOString(),
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
      assert.equal(sends.length, 0, 'stale starting phase should block Ralph continue steer');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.active, false);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'terminal');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('treats an explicit blocked_on_user run_outcome as terminal for Ralph continue steer', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-ralph-blocked-on-user-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const watcherStatePath = join(stateDir, 'notify-fallback-state.json');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        run_outcome: 'blocked_on_user',
        tmux_pane_id: '%42',
      }, null, 2));
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_progress_at: new Date(Date.now() - 5 * 60_000).toISOString(),
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
      assert.equal(sends.length, 0, 'blocked_on_user should suppress Ralph continue steer');

      const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
      assert.equal(watcherState.ralph_continue_steer?.active, false);
      assert.equal(watcherState.ralph_continue_steer?.last_reason, 'terminal');
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
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
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
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('retypes on every retry when trigger is not in narrow input area', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-dispatch-cm-fallback-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const captureSeqFile = join(wd, 'capture-seq.txt');
    const captureCounterFile = join(wd, 'capture-seq.idx');
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // Shared preflight now adds one 80-line capture per tick before the
      // narrow retry check. Pre-capture on retries still returns "ready"
      // (no trigger) so the request is retyped on every retry.
      await writeFile(captureSeqFile, [
        // Run 1 (attempt 0): 1 shared preflight + 3 verify rounds × 2 captures = 7
        'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
        // Run 2 (attempt 1): 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
        // Run 3 (attempt 2): 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
      ].join('\n'));

      await initTeamState('dispatch-team', 'task', 'executor', 1, wd);
      const queued = await enqueueDispatchRequest('dispatch-team', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
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
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
      assert.equal(typeMatches.length, 3, 'should retype on every retry when trigger not in narrow capture (fresh + 2 retries)');

      const request = await readDispatchRequest('dispatch-team', queued.request.request_id, wd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
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
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({
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

  it('stays alive after parent exit when coarse team-state is missing but canonical team is active for the current session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-canonical-team-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-canonical-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeCanonicalWatcherTeamFixture(wd, {
        teamName: 'dispatch-team',
        sessionId: 'sess-parent-canonical',
        ownerSessionId: 'sess-parent-canonical',
      });
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

      assert.ok(isPidAlive(child.pid), 'expected watcher to stay alive while canonical team panes remain active');
    } finally {
      if (child && isPidAlive(child.pid)) {
        child.kill('SIGTERM');
        await waitForExit(child, 4000).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('does not defer parent-loss shutdown when canonical owner session is blank and coarse team-state is missing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-ownerless-team-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-parent-gone-ownerless-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeCanonicalWatcherTeamFixture(wd, {
        teamName: 'dispatch-team',
        sessionId: 'sess-parent-ownerless',
        ownerSessionId: '',
      });
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
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_stop' && entry.reason === 'parent_gone'
      )));
      assert.ok(!logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_team'
      )), 'ownerless canonical team must not defer parent-loss shutdown');
    } finally {
      if (child && isPidAlive(child.pid)) {
        child.kill('SIGTERM');
        await waitForExit(child, 4000).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects invalid session_id before resolving session-scoped team paths', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-invalid-session-team-path-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-invalid-session-team-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const maliciousTeamDir = join(stateDir, 'team', 'dispatch-team');
    const sessionPath = join(stateDir, 'session.json');
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(maliciousTeamDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeSessionStart(wd, 'sess-valid');
      const validSession = JSON.parse(await readFile(sessionPath, 'utf-8')) as Record<string, unknown>;
      await writeFile(sessionPath, JSON.stringify({
        ...validSession,
        session_id: '../team/dispatch-team',
      }, null, 2));

      await writeFile(join(maliciousTeamDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(maliciousTeamDir, 'config.json'), JSON.stringify({
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
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_stop' && entry.reason === 'parent_gone'
      )));
      assert.ok(!logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_team'
      )), 'invalid session_id must not be used for session-scoped team path resolution');
    } finally {
      if (child && isPidAlive(child.pid)) {
        child.kill('SIGTERM');
        await waitForExit(child, 4000).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects invalid team_name before resolving watcher team paths', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-invalid-team-path-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-invalid-team-home-'));
    const fakeBinDir = join(wd, 'fake-bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const stateDir = join(wd, '.omx', 'state');
    const validTeamDir = join(stateDir, 'team', 'dispatch-team');
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(validTeamDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: '../team/dispatch-team',
        current_phase: 'team-exec',
      }, null, 2));
      await writeFile(join(validTeamDir, 'config.json'), JSON.stringify({
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
      assert.ok(logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_stop' && entry.reason === 'parent_gone'
      )));
      assert.ok(!logEntries.some((entry: { type?: string; reason?: string }) => (
        entry.type === 'watcher_parent_guard' && entry.reason === 'parent_gone_deferred_for_active_team'
      )), 'invalid team_name must not be used for watcher team path resolution');
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

  it('backs off idle polling and resets to the base cadence after fresh rollout activity', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-idle-backoff-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-idle-backoff-home-'));
    const sid = randomUUID();
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-idle-backoff-${sid}.jsonl`);
    const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
    const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
    const watcherStatePath = join(wd, '.omx', 'state', 'notify-fallback-state.json');
    const turnLogPath = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });
      await writeFile(rolloutPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: { id: `thread-${sid}`, cwd: wd },
      })}
`);

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
          '--idle-max-poll-ms',
          '200',
          '--parent-pid',
          String(process.pid),
          '--max-lifetime-ms',
          '5000',
        ],
        {
          cwd: wd,
          stdio: 'ignore',
          env: buildCleanNotifyEnv({ HOME: tempHome, OMX_NOTIFY_FALLBACK_IDLE_MAX_POLL_MS: '200' }),
        }
      );

      await waitFor(async () => {
        try {
          const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
          return watcherState.adaptive_poll?.current_ms === 200 && watcherState.adaptive_poll?.idle_streak >= 2;
        } catch {
          return false;
        }
      }, 4000, 50);

      const freshTurnId = `turn-fresh-${sid}`;
      await appendLine(rolloutPath, {
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: freshTurnId,
          last_agent_message: 'fresh message after idle backoff',
        },
      });

      await waitFor(async () => {
        const turnLines = await readLines(turnLogPath);
        if (!turnLines.some((line) => line.includes(freshTurnId))) return false;
        const watcherState = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
        return watcherState.adaptive_poll?.current_ms === 50
          && watcherState.adaptive_poll?.idle_streak === 0
          && watcherState.adaptive_poll?.last_activity_reason === 'rollout_event';
      }, 4000, 50);
    } finally {
      if (child && isPidAlive(child.pid)) {
        child.kill('SIGTERM');
        await waitForExit(child, 4000).catch(() => {});
      }
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
      await rm(rolloutPath, { force: true });
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
  it('keeps the detached helper alive after the hidden bootstrap exits', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-bootstrap-survival-'));
    const readyPath = join(wd, 'helper-ready.json');
    const helperScriptPath = join(wd, 'helper-survival.js');

    try {
      await writeFile(helperScriptPath, `
const fs = require('node:fs');
const readyPath = process.argv[2];
fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
setInterval(() => {}, 1000);
`);

      const bootstrap = spawnSync(
        process.execPath,
        [
          '-e',
          buildWindowsMsysBackgroundHelperBootstrapScript([helperScriptPath, readyPath], wd),
        ],
        {
          cwd: wd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);

      const helperPid = Number.parseInt((bootstrap.stdout || '').trim(), 10);
      assert.ok(Number.isFinite(helperPid) && helperPid > 0, 'expected detached helper pid from bootstrap');

      await waitFor(async () => {
        try {
          const ready = JSON.parse(await readFile(readyPath, 'utf-8')) as { pid?: number };
          return ready.pid === helperPid;
        } catch {
          return false;
        }
      }, 4000, 50);

      assert.ok(isPidAlive(helperPid), 'expected detached helper to survive after bootstrap exit');
      process.kill(helperPid, 'SIGTERM');
      await waitFor(async () => !isPidAlive(helperPid), 4000, 50);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
