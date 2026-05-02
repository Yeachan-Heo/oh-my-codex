import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  initTeamState,
  readTeamConfig,
  saveTeamConfig,
  listMailboxMessages,
  listDispatchRequests,
  readDispatchRequest,
  createTask,
  updateWorkerHeartbeat,
  writeWorkerStatus,
} from '../state.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { sendWorkerMessage, broadcastWorkerMessage } from '../runtime.js';
import { drainPendingTeamDispatch } from '../../scripts/notify-hook/team-dispatch.js';
import { teamCommand } from '../../cli/team.js';

function buildFakeTmux(tmuxLogPath: string): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "capture-pane" ]]; then
  printf "› ready\\n"
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
  if [[ "$fmt" == "#{pane_start_command}" ]]; then
    echo "codex"
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
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf '%%10\t111\n%%11\t112\n%%12\t113\n%%95\t195\n'
  exit 0
fi
exit 0
`;
}

async function writeCompatRuntimeFixture(runtimePath: string): Promise<void> {
  await writeFile(
    runtimePath,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
function argValue(prefix) {
  const entry = argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}
function stateDir() {
  return argValue('--state-dir=') || process.cwd();
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n');
}
function nowIso() { return new Date().toISOString(); }
if (argv[0] === 'schema') {
  process.stdout.write(JSON.stringify({ schema_version: 1, commands: ['acquire-authority','renew-authority','queue-dispatch','mark-notified','mark-delivered','mark-failed','request-replay','capture-snapshot'], events: [], transport: 'tmux' }) + '\\n');
  process.exit(0);
}
if (argv[0] !== 'exec') process.exit(1);
const command = JSON.parse(argv[1] || '{}');
const dir = stateDir();
const dispatchPath = path.join(dir, 'dispatch.json');
const mailboxPath = path.join(dir, 'mailbox.json');
const dispatch = readJson(dispatchPath, { records: [] });
const mailbox = readJson(mailboxPath, { records: [] });
const timestamp = nowIso();
switch (command.command) {
  case 'QueueDispatch':
    dispatch.records.push({ request_id: command.request_id, target: command.target, status: 'pending', created_at: timestamp, notified_at: null, delivered_at: null, failed_at: null, reason: null, metadata: command.metadata ?? null });
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchQueued', request_id: command.request_id, target: command.target }) + '\\n');
    process.exit(0);
  case 'MarkNotified': {
    const record = dispatch.records.find((entry) => entry.request_id === command.request_id);
    if (record) {
      record.status = 'notified';
      record.notified_at = timestamp;
      record.reason = command.channel;
      writeJson(dispatchPath, dispatch);
    }
    process.stdout.write(JSON.stringify({ event: 'DispatchNotified', request_id: command.request_id, channel: command.channel }) + '\\n');
    process.exit(0);
  }
  case 'MarkDelivered': {
    const record = dispatch.records.find((entry) => entry.request_id === command.request_id);
    if (record) {
      record.status = 'delivered';
      record.delivered_at = timestamp;
      writeJson(dispatchPath, dispatch);
    }
    process.stdout.write(JSON.stringify({ event: 'DispatchDelivered', request_id: command.request_id }) + '\\n');
    process.exit(0);
  }
  case 'CreateMailboxMessage':
    mailbox.records.push({ message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker, body: command.body, created_at: timestamp, notified_at: null, delivered_at: null });
    writeJson(mailboxPath, mailbox);
    process.stdout.write(JSON.stringify({ event: 'MailboxMessageCreated', message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker }) + '\\n');
    process.exit(0);
  case 'MarkMailboxNotified': {
    const record = mailbox.records.find((entry) => entry.message_id === command.message_id);
    if (record) {
      record.notified_at = timestamp;
      writeJson(mailboxPath, mailbox);
    }
    process.stdout.write(JSON.stringify({ event: 'MailboxNotified', message_id: command.message_id }) + '\\n');
    process.exit(0);
  }
  case 'MarkMailboxDelivered': {
    const record = mailbox.records.find((entry) => entry.message_id === command.message_id);
    if (record) {
      record.delivered_at = timestamp;
      writeJson(mailboxPath, mailbox);
    }
    process.stdout.write(JSON.stringify({ event: 'MailboxDelivered', message_id: command.message_id }) + '\\n');
    process.exit(0);
  }
  default:
    process.stdout.write(JSON.stringify({ event: 'ok' }) + '\\n');
    process.exit(0);
}
`,
  );
  await chmod(runtimePath, 0o755);
}

async function setupTeam(name: string, workerCount: number = 2): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `omx-delivery-e2e-${name}-`));
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  process.env.OMX_TEAM_STATE_ROOT = join(cwd, '.omx', 'state');
  await initTeamState(name, 'delivery smoke test', 'executor', workerCount, cwd);
  return {
    cwd,
    cleanup: async () => {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function withFakeTmux<T>(cwd: string, fn: (tmuxLogPath: string) => Promise<T>): Promise<T> {
  const fakeBinDir = join(cwd, 'fake-bin');
  const tmuxLogPath = join(cwd, 'tmux.log');
  const previousPath = process.env.PATH;
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
  await chmod(join(fakeBinDir, 'tmux'), 0o755);
  process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
  try {
    return await fn(tmuxLogPath);
  } finally {
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
  }
}

async function withBridgeFixture<T>(cwd: string, fn: (runtimePath: string) => Promise<T>): Promise<T> {
  const fakeBin = join(cwd, 'runtime-bin');
  const runtimePath = join(fakeBin, 'omx-runtime');
  const previousPath = process.env.PATH;
  const previousBinary = process.env.OMX_RUNTIME_BINARY;
  const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
  await mkdir(fakeBin, { recursive: true });
  await writeCompatRuntimeFixture(runtimePath);
  process.env.PATH = `${fakeBin}:${previousPath || ''}`;
  process.env.OMX_RUNTIME_BINARY = runtimePath;
  process.env.OMX_RUNTIME_BRIDGE = '1';
  try {
    return await fn(runtimePath);
  } finally {
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
    if (typeof previousBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousBinary;
    else delete process.env.OMX_RUNTIME_BINARY;
    if (typeof previousBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousBridge;
    else delete process.env.OMX_RUNTIME_BRIDGE;
  }
}

async function configurePaneIds(teamName: string, cwd: string, leaderPaneId: string, workerPaneIds: Record<string, string>): Promise<void> {
  const config = await readTeamConfig(teamName, cwd);
  assert.ok(config, 'missing team config');
  if (!config) throw new Error('missing team config');
  config.leader_pane_id = leaderPaneId;
  config.workers = config.workers.map((worker) => ({
    ...worker,
    pane_id: workerPaneIds[worker.name] ?? worker.pane_id,
  }));
  await saveTeamConfig(config, cwd);
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function buildCleanNotifyEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
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

describe('team message delivery end-to-end smoke tests', () => {
  it('worker -> leader: send-message API creates mailbox, dispatches, and marks leader notification', async () => {
    const { cwd, cleanup } = await setupTeam('worker-leader-api', 2);
    try {
      await withFakeTmux(cwd, async () => {
        await configurePaneIds('worker-leader-api', cwd, '%95', { 'worker-1': '%10', 'worker-2': '%11' });

        const result = await executeTeamApiOperation('send-message', {
          team_name: 'worker-leader-api',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'worker ack to leader',
        }, cwd);

        assert.equal(result.ok, true);
        if (!result.ok) throw new Error('expected successful send-message result');

        const mailbox = await listMailboxMessages('worker-leader-api', 'leader-fixed', cwd);
        const workerMessages = mailbox.filter((message) =>
          message.from_worker === 'worker-1' && message.body === 'worker ack to leader');
        assert.equal(workerMessages.length, 1);
        assert.ok(workerMessages[0]?.notified_at, 'leader mailbox message should be notified');

        const requests = await listDispatchRequests('worker-leader-api', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
        const workerRequests = requests.filter((request) => request.message_id === workerMessages[0]?.message_id);
        assert.equal(workerRequests.length, 1);
        assert.equal(workerRequests[0]?.status, 'notified');
        assert.match(workerRequests[0]?.last_reason ?? '', /leader_mailbox_notified/);
      });
    } finally {
      await cleanup();
    }
  });

  it('worker -> leader: fallback watcher nudges the leader when an undelivered worker message lingers', async () => {
    const { cwd, cleanup } = await setupTeam('worker-leader-fallback', 1);
    try {
      await withFakeTmux(cwd, async (tmuxLogPath) => {
        await configurePaneIds('worker-leader-fallback', cwd, '', { 'worker-1': '%10' });
        await sendWorkerMessage('worker-leader-fallback', 'worker-1', 'leader-fixed', 'please read mailbox', cwd);
        await configurePaneIds('worker-leader-fallback', cwd, '%95', { 'worker-1': '%10' });

        await writeFile(join(cwd, '.omx', 'state', 'team-state.json'), JSON.stringify({
          active: true,
          team_name: 'worker-leader-fallback',
          current_phase: 'team-exec',
        }, null, 2));
        await writeFile(join(cwd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
          last_turn_at: new Date(Date.now() - 300_000).toISOString(),
          turn_count: 9,
        }, null, 2));

        const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
        const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
        const result = spawnSync(process.execPath, [watcherScript, '--once', '--cwd', cwd, '--notify-script', notifyHook], {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv(),
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);

        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.match(tmuxLog, /send-keys -t %95 -l Team worker-leader-fallback:/);
        assert.match(tmuxLog, /msg\(s\) pending|msg\(s\) for leader/);
      });
    } finally {
      await cleanup();
    }
  });

  it('worker -> leader: concurrent worker sends preserve every message across mailbox and dispatch seams', async () => {
    const { cwd, cleanup } = await setupTeam('worker-leader-concurrent', 3);
    try {
      await withFakeTmux(cwd, async () => {
        await configurePaneIds('worker-leader-concurrent', cwd, '%95', {
          'worker-1': '%10',
          'worker-2': '%11',
          'worker-3': '%12',
        });

        await Promise.all([
          executeTeamApiOperation('send-message', { team_name: 'worker-leader-concurrent', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'msg-1' }, cwd),
          executeTeamApiOperation('send-message', { team_name: 'worker-leader-concurrent', from_worker: 'worker-2', to_worker: 'leader-fixed', body: 'msg-2' }, cwd),
          executeTeamApiOperation('send-message', { team_name: 'worker-leader-concurrent', from_worker: 'worker-3', to_worker: 'leader-fixed', body: 'msg-3' }, cwd),
        ]);

        const mailbox = await listMailboxMessages('worker-leader-concurrent', 'leader-fixed', cwd);
        const workerMessages = mailbox.filter((message) =>
          message.from_worker.startsWith('worker-') && /^msg-[123]$/.test(message.body));
        assert.equal(workerMessages.length, 3);
        assert.deepEqual(new Set(workerMessages.map((message) => message.body)), new Set(['msg-1', 'msg-2', 'msg-3']));
        assert.equal(new Set(workerMessages.map((message) => message.message_id)).size, 3);
        assert.equal(workerMessages.filter((message) => message.notified_at).length, 3);

        const requests = await listDispatchRequests('worker-leader-concurrent', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
        const workerMessageIds = new Set(workerMessages.map((message) => message.message_id));
        const workerRequests = requests.filter((request) => request.message_id && workerMessageIds.has(request.message_id));
        assert.equal(workerRequests.length, 3);
        assert.equal(workerRequests.filter((request) => request.status === 'notified').length, 3);
      });
    } finally {
      await cleanup();
    }
  });

  it('leader -> worker: leader send creates mailbox and hook notification for the target worker', async () => {
    const { cwd, cleanup } = await setupTeam('leader-worker-send', 2);
    try {
      await withFakeTmux(cwd, async (tmuxLogPath) => {
        await configurePaneIds('leader-worker-send', cwd, '%95', { 'worker-1': '%10', 'worker-2': '%11' });
        await sendWorkerMessage('leader-worker-send', 'leader-fixed', 'worker-1', 'leader guidance', cwd);

        const mailbox = await listMailboxMessages('leader-worker-send', 'worker-1', cwd);
        assert.equal(mailbox.length, 1);
        assert.equal(mailbox[0]?.body, 'leader guidance');
        assert.ok(mailbox[0]?.notified_at);

        const requests = await listDispatchRequests('leader-worker-send', cwd, { kind: 'mailbox', to_worker: 'worker-1' });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.status, 'notified');

        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.match(tmuxLog, /send-keys -t %10/);
      });
    } finally {
      await cleanup();
    }
  });

  it('leader -> worker: broadcast fans out to every worker mailbox and notification path', async () => {
    const { cwd, cleanup } = await setupTeam('leader-broadcast', 3);
    try {
      await withFakeTmux(cwd, async () => {
        await configurePaneIds('leader-broadcast', cwd, '%95', {
          'worker-1': '%10',
          'worker-2': '%11',
          'worker-3': '%12',
        });
        await broadcastWorkerMessage('leader-broadcast', 'leader-fixed', 'broadcast hello', cwd);

        for (const worker of ['worker-1', 'worker-2', 'worker-3']) {
          const mailbox = await listMailboxMessages('leader-broadcast', worker, cwd);
          assert.equal(mailbox.length, 1, `${worker} should receive one broadcast`);
          assert.equal(mailbox[0]?.body, 'broadcast hello');
          assert.ok(mailbox[0]?.notified_at, `${worker} should have notified_at set`);
        }

        const requests = await listDispatchRequests('leader-broadcast', cwd, { kind: 'mailbox' });
        assert.equal(requests.length, 3);
        assert.equal(requests.filter((request) => request.status === 'notified').length, 3);
      });
    } finally {
      await cleanup();
    }
  });

  it('leader -> worker: offline worker send persists mailbox and leaves delivery pending for later pickup', async () => {
    const { cwd, cleanup } = await setupTeam('leader-worker-offline', 1);
    try {
      const config = await readTeamConfig('leader-worker-offline', cwd);
      assert.ok(config);
      if (!config) throw new Error('missing team config');
      config.workers[0] = { ...config.workers[0], pane_id: '' };
      await saveTeamConfig(config, cwd);

      const result = await executeTeamApiOperation('send-message', {
        team_name: 'leader-worker-offline',
        from_worker: 'leader-fixed',
        to_worker: 'worker-1',
        body: 'pickup later',
      }, cwd);

      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('expected successful send-message result');

      const mailbox = await listMailboxMessages('leader-worker-offline', 'worker-1', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.body, 'pickup later');
      assert.equal(mailbox[0]?.notified_at, undefined);

      const requests = await listDispatchRequests('leader-worker-offline', cwd, { kind: 'mailbox', to_worker: 'worker-1' });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.status, 'pending');
    } finally {
      await cleanup();
    }
  });

  it('cross-seam: TS CLI send-message flows through bridge mailbox compat and back through TS hook notification', async () => {
    const { cwd, cleanup } = await setupTeam('cli-bridge-send', 1);
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      await withBridgeFixture(cwd, async (runtimePath) => {
        process.chdir(cwd);
        const config = await readTeamConfig('cli-bridge-send', cwd);
        assert.ok(config);
        if (!config) throw new Error('missing team config');
        config.workers[0] = { ...config.workers[0], pane_id: '' };
        await saveTeamConfig(config, cwd);

        console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
        await teamCommand([
          'api',
          'send-message',
          '--input',
          JSON.stringify({ team_name: 'cli-bridge-send', from_worker: 'leader-fixed', to_worker: 'worker-1', body: 'cli bridge hello' }),
          '--json',
        ]);

        assert.equal(logs.length, 1);
        const envelope = JSON.parse(logs[0]) as { ok?: boolean; data?: { message?: { message_id?: string } } };
        assert.equal(envelope.ok, true);
        const messageId = envelope.data?.message?.message_id ?? '';
        assert.ok(messageId);

        await drainPendingTeamDispatch({
          cwd,
          maxPerTick: 5,
          injector: async () => ({ ok: true, transport: 'hook', reason: 'injected_for_test' }),
        });

        const mailboxCompat = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'mailbox.json'), 'utf-8')) as { records: Array<{ message_id: string }> };
        assert.equal(mailboxCompat.records.some((record) => record.message_id === messageId), true);

        const mailbox = await listMailboxMessages('cli-bridge-send', 'worker-1', cwd);
        const message = mailbox.find((entry) => entry.message_id === messageId);
        assert.ok(message, 'expected CLI-created message in canonical mailbox view');
        assert.ok(message?.notified_at, 'expected TS hook path to persist notified_at');

        const requests = await listDispatchRequests('cli-bridge-send', cwd, { kind: 'mailbox', to_worker: 'worker-1' });
        assert.equal(requests[0]?.status, 'notified');
        assert.equal(existsSync(runtimePath), true);
      });
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await cleanup();
    }
  });

  it('cross-seam: fallback watcher nudges for stalled workers even when the leader itself is fresh (PR #1217 guard)', async () => {
    const { cwd, cleanup } = await setupTeam('stalled-worker-fresh-leader', 1);
    try {
      await withFakeTmux(cwd, async (tmuxLogPath) => {
        await configurePaneIds('stalled-worker-fresh-leader', cwd, '%95', { 'worker-1': '%10' });
        const task = await createTask('stalled-worker-fresh-leader', {
          subject: 'stalled task',
          description: 'stalled worker regression guard',
          status: 'pending',
        }, cwd);
        await writeWorkerStatus('stalled-worker-fresh-leader', 'worker-1', {
          state: 'working',
          current_task_id: task.id,
          updated_at: new Date().toISOString(),
        }, cwd);
        await updateWorkerHeartbeat('stalled-worker-fresh-leader', 'worker-1', {
          pid: 1234,
          turn_count: 5,
          alive: true,
          last_turn_at: new Date(Date.now() - 60_000).toISOString(),
        }, cwd);

        await writeFile(join(cwd, '.omx', 'state', 'team-state.json'), JSON.stringify({
          active: true,
          team_name: 'stalled-worker-fresh-leader',
          current_phase: 'team-exec',
        }, null, 2));
        await writeFile(join(cwd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
          last_turn_at: new Date().toISOString(),
          turn_count: 2,
        }, null, 2));
        await writeFile(join(cwd, '.omx', 'state', 'team-leader-nudge.json'), JSON.stringify({
          last_nudged_by_team: {},
          last_idle_nudged_by_team: {},
          progress_by_team: {
            'stalled-worker-fresh-leader': {
              signature: JSON.stringify({
                tasks: [{ id: task.id, owner: '', status: 'pending' }],
                workers: [{
                  worker: 'worker-1',
                  state: 'working',
                  current_task_id: task.id,
                  status_missing: false,
                  turn_count: 5,
                  heartbeat_missing: false,
                }],
              }),
              last_progress_at: new Date(Date.now() - 60_000).toISOString(),
              observed_at: new Date(Date.now() - 60_000).toISOString(),
              missing_signal_workers: 0,
              work_remaining: true,
              leader_action_state: 'still_actionable',
            },
          },
        }, null, 2));

        const watcherScript = new URL('../../../dist/scripts/notify-fallback-watcher.js', import.meta.url).pathname;
        const notifyHook = new URL('../../../dist/scripts/notify-hook.js', import.meta.url).pathname;
        const result = spawnSync(process.execPath, [watcherScript, '--once', '--cwd', cwd, '--notify-script', notifyHook], {
          encoding: 'utf-8',
          env: buildCleanNotifyEnv({
          }),
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);

        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /worker panes stalled/);
        assert.doesNotMatch(tmuxLog, /leader stale/);
      });
    } finally {
      await cleanup();
    }
  });

  it('cross-seam: hook-owned bridge success keeps mailbox notification visible in the canonical mailbox view', async () => {
    const { cwd, cleanup } = await setupTeam('hook-bridge-success', 1);
    try {
      await withBridgeFixture(cwd, async () => {
        const config = await readTeamConfig('hook-bridge-success', cwd);
        assert.ok(config);
        if (!config) throw new Error('missing team config');
        config.workers[0] = { ...config.workers[0], pane_id: '' };
        await saveTeamConfig(config, cwd);

        const result = await executeTeamApiOperation('send-message', {
          team_name: 'hook-bridge-success',
          from_worker: 'leader-fixed',
          to_worker: 'worker-1',
          body: 'bridge hook success',
        }, cwd);
        assert.equal(result.ok, true);
        if (!result.ok) throw new Error('expected successful send-message result');

        await drainPendingTeamDispatch({
          cwd,
          maxPerTick: 5,
          injector: async () => ({ ok: true, transport: 'hook', reason: 'injected_for_test' }),
        });

        const mailbox = await listMailboxMessages('hook-bridge-success', 'worker-1', cwd);
        assert.equal(mailbox.length, 1);
        assert.ok(mailbox[0]?.notified_at, 'bridge success path should preserve notified_at in canonical view');

        const request = (await listDispatchRequests('hook-bridge-success', cwd, { kind: 'mailbox', to_worker: 'worker-1' }))[0];
        assert.equal(request?.status, 'notified');
      });
    } finally {
      await cleanup();
    }
  });

  it('edge: duplicate same from/to/body send dedupes without adding a second mailbox record', async () => {
    const { cwd, cleanup } = await setupTeam('dedupe-smoke', 1);
    try {
      await withFakeTmux(cwd, async () => {
        await configurePaneIds('dedupe-smoke', cwd, '%95', { 'worker-1': '%10' });
        await executeTeamApiOperation('send-message', { team_name: 'dedupe-smoke', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'same-body' }, cwd);
        await executeTeamApiOperation('send-message', { team_name: 'dedupe-smoke', from_worker: 'worker-1', to_worker: 'leader-fixed', body: 'same-body' }, cwd);

        const mailbox = await listMailboxMessages('dedupe-smoke', 'leader-fixed', cwd);
        const workerMessages = mailbox.filter((message) =>
          message.from_worker === 'worker-1' && message.body === 'same-body');
        assert.equal(workerMessages.length, 1);

        const requests = await listDispatchRequests('dedupe-smoke', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
        const workerRequests = requests.filter((request) => request.message_id === workerMessages[0]?.message_id);
        assert.equal(workerRequests.length, 1);
      });
    } finally {
      await cleanup();
    }
  });

  it('edge: mailbox-mark-delivered updates dispatch and removes the message from active undelivered reads', async () => {
    const { cwd, cleanup } = await setupTeam('mark-delivered-smoke', 1);
    try {
      await withBridgeFixture(cwd, async () => {
        const config = await readTeamConfig('mark-delivered-smoke', cwd);
        assert.ok(config);
        if (!config) throw new Error('missing team config');
        config.workers[0] = { ...config.workers[0], pane_id: '' };
        await saveTeamConfig(config, cwd);

        const sendResult = await executeTeamApiOperation('send-message', {
          team_name: 'mark-delivered-smoke',
          from_worker: 'leader-fixed',
          to_worker: 'worker-1',
          body: 'deliver me',
        }, cwd);
        assert.equal(sendResult.ok, true);
        if (!sendResult.ok) throw new Error('expected send-message success');
        const messageId = String((sendResult.data.message as { message_id?: string }).message_id ?? '');
        assert.ok(messageId);

        await drainPendingTeamDispatch({
          cwd,
          maxPerTick: 5,
          injector: async () => ({ ok: true, transport: 'hook', reason: 'injected_for_test' }),
        });

        const deliveredResult = await executeTeamApiOperation('mailbox-mark-delivered', {
          team_name: 'mark-delivered-smoke',
          worker: 'worker-1',
          message_id: messageId,
        }, cwd);
        assert.equal(deliveredResult.ok, true);
        if (!deliveredResult.ok) throw new Error('expected mailbox-mark-delivered success');
        assert.equal(deliveredResult.data.dispatch_updated, true);

        const requestId = String(deliveredResult.data.dispatch_request_id ?? '');
        const request = await readDispatchRequest('mark-delivered-smoke', requestId, cwd);
        assert.equal(request?.status, 'delivered');

        const undelivered = await executeTeamApiOperation('mailbox-list', {
          team_name: 'mark-delivered-smoke',
          worker: 'worker-1',
          include_delivered: false,
        }, cwd);
        assert.equal(undelivered.ok, true);
        if (!undelivered.ok) throw new Error('expected mailbox-list success');
        assert.equal(undelivered.data.count, 0);
      });
    } finally {
      await cleanup();
    }
  });

  it('edge: delivery still completes through the pure TS fallback path when the bridge is disabled', async () => {
    const { cwd, cleanup } = await setupTeam('bridge-disabled-fallback', 1);
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await withFakeTmux(cwd, async (tmuxLogPath) => {
        await configurePaneIds('bridge-disabled-fallback', cwd, '%95', { 'worker-1': '%10' });
        await sendWorkerMessage('bridge-disabled-fallback', 'leader-fixed', 'worker-1', 'ts fallback only', cwd);

        const mailbox = await listMailboxMessages('bridge-disabled-fallback', 'worker-1', cwd);
        assert.equal(mailbox.length, 1);
        assert.equal(mailbox[0]?.body, 'ts fallback only');
        assert.ok(mailbox[0]?.notified_at);

        const requests = await listDispatchRequests('bridge-disabled-fallback', cwd, { kind: 'mailbox', to_worker: 'worker-1' });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.status, 'notified');

        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.match(tmuxLog, /send-keys -t %10/);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'mailbox.json')), false, 'bridge compat mailbox should not be created when bridge is disabled');
      });
    } finally {
      if (typeof previousBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await cleanup();
    }
  });
});
