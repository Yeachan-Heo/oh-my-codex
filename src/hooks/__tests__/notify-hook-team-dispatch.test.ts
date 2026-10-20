import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initTeamState,
  enqueueDispatchRequest,
  readDispatchRequest,
  listMailboxMessages,
  sendDirectMessage,
  readTeamConfig,
  saveTeamConfig,
} from '../../team/state.js';
import { pathToFileURL } from 'node:url';
import { getDefaultBridge, RuntimeBridge } from '../../runtime/bridge.js';

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
    exit 0
  fi
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
if [[ "$cmd" == "show-option" && "$*" == *"@omx_team_pane_owner_id" ]]; then
  echo "team:alpha"
  exit 0
fi

if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  if [[ "$*" == *"#{pane_dead}"* ]]; then
    if [[ -n "\${OMX_TEST_EXACT_PANE_SEQUENCE_FILE:-}" && -f "\${OMX_TEST_EXACT_PANE_SEQUENCE_FILE}" ]]; then
      counterFile="\${OMX_TEST_EXACT_PANE_COUNTER_FILE:-\${OMX_TEST_EXACT_PANE_SEQUENCE_FILE}.idx}"
      idx=0
      if [[ -f "$counterFile" ]]; then idx="$(cat "$counterFile")"; fi
      lineNo=$((idx + 1))
      line="$(sed -n "\${lineNo}p" "\${OMX_TEST_EXACT_PANE_SEQUENCE_FILE}" || true)"
      if [[ -z "$line" ]]; then
        line="$(tail -n 1 "\${OMX_TEST_EXACT_PANE_SEQUENCE_FILE}" || true)"
      fi
      echo "$lineNo" > "$counterFile"
      if [[ "$line" != "__EMPTY__" ]]; then printf '%b\n' "$line"; fi
      exit 0
    fi
    printf '%%42\t0\t4242\n%%99\t0\t9999\n'
    exit 0
  fi
  echo "%42 1"
  exit 0
fi
exit 0
`;
}

function assertFreshExactProofBeforePaneEffects(tmuxLog: string, paneId: string): void {
  const commands = tmuxLog.trim().split('\n').filter(Boolean);
  const exactGlobalPaneProof = /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/;
  const ownerProof = new RegExp(`^show-option -qv -p -t ${paneId} @omx_team_pane_owner_id$`);
  const effects = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => (
      command.startsWith(`paste-buffer -t ${paneId} `)
      || command.startsWith(`kill-pane -t ${paneId} `)
      || (command.startsWith(`send-keys -t ${paneId} `) && !command.includes(' -l '))
    ));

  assert.ok(effects.length > 0, `expected explicit pane effects for ${paneId}:\n${commands.join('\n')}`);
  for (const { command, index } of effects) {
    assert.match(commands[index - 1] ?? '', exactGlobalPaneProof, `final PID proof must immediately precede ${command}`);
    assert.match(commands[index - 2] ?? '', ownerProof, `owner proof must immediately precede the final PID proof for ${command}`);
    assert.match(commands[index - 3] ?? '', exactGlobalPaneProof, `initial PID proof must precede owner proof for ${command}`);
  }
}

function bindCanonicalTeamPaneAuthority(config: { tmux_pane_owner_id?: string; hud_pane_id?: string | null }, hudPaneId = '%88'): void {
  config.tmux_pane_owner_id = 'team:alpha';
  config.hud_pane_id = hudPaneId;
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

async function listDispatchProcessingLeases(cwd: string, teamName: string): Promise<string[]> {
  const dispatchDir = join(cwd, '.omx', 'state', 'team', teamName, 'dispatch');
  return (await readdir(dispatchDir).catch(() => []))
    .filter((entry) => entry.startsWith('.processing-'))
    .sort();
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
  process.stdout.write(JSON.stringify({ schema_version: 1, capabilities: ['team-mailbox-scope-v1'], commands: ['acquire-authority','renew-authority','queue-dispatch','mark-notified','mark-delivered','mark-failed','remove-dispatch-records','request-replay','capture-snapshot'], events: [], transport: 'tmux' }) + '\\n');
  process.exit(0);
}
if (argv[0] !== 'exec' && argv[0] !== 'exec-scoped') process.exit(1);
const command = JSON.parse(argv[1] || '{}');
const dir = stateDir();
const dispatchPath = path.join(dir, 'dispatch.json');
const mailboxPath = path.join(dir, 'mailbox.json');
const dispatch = readJson(dispatchPath, { records: [] });
const mailbox = readJson(mailboxPath, { records: [] });
const timestamp = nowIso();
switch (command.command) {
  case 'QueueDispatch':
    writeJson(path.join(dir, 'events.json'), [...readJson(path.join(dir, 'events.json'), []), { event: 'DispatchQueued', request_id: command.request_id, metadata: command.metadata }]);
    writeJson(path.join(dir, 'dispatch-seen.json'), { schema_version: 2, ledger_epoch: 1, request_ids: [...readJson(path.join(dir, 'dispatch-seen.json'), { request_ids: [] }).request_ids, command.request_id] });
    dispatch.records.push({ request_id: command.request_id, target: command.target, status: 'pending', created_at: timestamp, notified_at: null, delivered_at: null, failed_at: null, reason: null, metadata: command.metadata ?? null });
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchQueued', request_id: command.request_id, target: command.target }) + '\\n');
    process.exit(0);
  case 'MarkNotified': {
    if (process.env.OMX_TEST_REJECT_MARK_NOTIFIED === '1') {
      process.stderr.write('invalid notification transition\\n');
      process.exit(1);
    }
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
      if (record.status !== 'notified') process.exit(1);
      record.status = 'delivered';
      record.delivered_at = timestamp;
      writeJson(dispatchPath, dispatch);
    }
    process.stdout.write(JSON.stringify({ event: 'DispatchDelivered', request_id: command.request_id }) + '\\n');
    process.exit(0);
  }
  case 'MarkFailed': {
    const record = dispatch.records.find((entry) => entry.request_id === command.request_id);
    if (record) {
      record.status = 'failed';
      record.failed_at = timestamp;
      record.reason = command.reason;
      writeJson(dispatchPath, dispatch);
    }
    process.stdout.write(JSON.stringify({ event: 'DispatchFailed', request_id: command.request_id, reason: command.reason }) + '\\n');
    process.exit(0);
  }
  case 'CreateMailboxMessage':
    mailbox.records.push({ team_name: command.team_name, message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker, body: command.body, created_at: timestamp, notified_at: null, delivered_at: null });
    writeJson(mailboxPath, mailbox);
    process.stdout.write(JSON.stringify({ event: 'MailboxMessageCreated', message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker }) + '\\n');
    process.exit(0);
  case 'MarkMailboxNotified': {
    const candidates = mailbox.records.filter((entry) => entry.message_id === command.message_id);
    const scoped = candidates.filter((entry) => command.team_name != null && entry.team_name === command.team_name);
    const record = scoped.length === 1 ? scoped[0] : scoped.length === 0 && candidates.length === 1 && candidates[0].team_name == null ? candidates[0] : null;
    if (!record) process.exit(1);
    if (record) {
      record.notified_at = timestamp;
      writeJson(mailboxPath, mailbox);
    }
    process.stdout.write(JSON.stringify({ event: 'MailboxNotified', message_id: command.message_id }) + '\\n');
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

async function waitForMailboxNotifiedAt(teamName: string, workerName: string, messageId: string, cwd: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const mailbox = await listMailboxMessages(teamName, workerName, cwd);
    const message = mailbox.find((entry) => entry.message_id === messageId);
    if (message?.notified_at) return message.notified_at;
    if (attempt < 4) await sleep(25);
  }
  return undefined;
}

describe('notify-hook team dispatch consumer', () => {
  const originalTeamWorker = process.env.OMX_TEAM_WORKER;
  const originalTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;

  before(() => {
    delete process.env.OMX_TEAM_WORKER;
    delete process.env.OMX_TEAM_STATE_ROOT;
  });

  after(() => {
    if (originalTeamWorker === undefined) {
      delete process.env.OMX_TEAM_WORKER;
    } else {
      process.env.OMX_TEAM_WORKER = originalTeamWorker;
    }

    if (originalTeamStateRoot === undefined) {
      delete process.env.OMX_TEAM_STATE_ROOT;
    } else {
      process.env.OMX_TEAM_STATE_ROOT = originalTeamStateRoot;
    }
  });

  it('reads and finalizes requests in the explicitly selected state directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-selected-root-'));
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      const stateDir = join(cwd, 'selected-state');
      const selected = join(stateDir, 'team/alpha/dispatch/requests.json');
      const decoy = join(cwd, '.omx/state/team/alpha/dispatch/requests.json');
      const request = { kind: 'inbox', team_name: 'alpha', to_worker: 'worker-1', trigger_message: 'ping', status: 'pending' };
      for (const root of [stateDir, join(cwd, '.omx/state')]) await mkdir(join(root, 'team/alpha/dispatch'), { recursive: true });
      await writeFile(selected, JSON.stringify([{ ...request, request_id: 'selected' }]));
      await writeFile(decoy, JSON.stringify([{ ...request, request_id: 'decoy' }]));
      const before = await readFile(decoy, 'utf8');
      const injected: string[] = [];
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      const drain = () => drainPendingTeamDispatch({ cwd, stateDir, injector: async request => {
        injected.push(request.request_id);
        return { ok: true, reason: 'selected-root-test' };
      } });
      assert.equal((await drain()).processed, 1);
      assert.deepEqual(injected, ['selected']);
      assert.equal(JSON.parse(await readFile(selected, 'utf8'))[0].status, 'notified');
      assert.equal((await drain()).processed, 0);
      assert.equal(await readFile(decoy, 'utf8'), before);
    } finally {
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps repeated idle drains read-only and discovers event-only queued work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-idle-refresh-'));
    try {
      for (const team of ['alpha', 'beta']) await initTeamState(team, 'task', 'executor', 1, cwd);
      await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'authority', cwd);
      const stateDir = join(cwd, '.omx/state');
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      const idle = () => drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('idle injection'); } });
      await idle();
      const paths = ['events.json', 'dispatch.json', 'mailbox.json', 'snapshot.json'].map(name => join(stateDir, name));
      const before = await Promise.all(paths.map(async path => ({ body: await readFile(path, 'utf8'), mtime: (await stat(path, { bigint: true })).mtimeNs })));
      for (let tick = 0; tick < 5; tick += 1) await idle();
      assert.deepEqual(await Promise.all(paths.map(async path => ({ body: await readFile(path, 'utf8'), mtime: (await stat(path, { bigint: true })).mtimeNs }))), before);

      const stale = await readFile(join(stateDir, 'dispatch.json'), 'utf8');
      const queued = await enqueueDispatchRequest('beta', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'event-only' }, cwd);
      await writeFile(join(stateDir, 'dispatch.json'), stale);
      let injected = 0;
      await drainPendingTeamDispatch({ cwd, injector: async request => {
        assert.equal(request.request_id, queued.request.request_id);
        injected += 1;
        return { ok: true, reason: 'injected_for_test' };
      } });
      assert.equal(injected, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refreshes again when another Team gains a durable status during injection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-cross-team-refresh-'));
    try {
      const ids = new Map<string, string>();
      for (const team of ['alpha', 'beta']) {
        await initTeamState(team, 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest(team, { kind: 'inbox', to_worker: 'worker-1', trigger_message: team }, cwd);
        ids.set(team, queued.request.request_id);
      }
      const stateDir = join(cwd, '.omx/state');
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      let injected = 0;
      await drainPendingTeamDispatch({ cwd, injector: async request => {
        assert.equal(request.request_id, ids.get('alpha'));
        injected += 1;
        const path = join(stateDir, 'dispatch.json');
        const stale = await readFile(path, 'utf8');
        getDefaultBridge(stateDir).execCommand({ command: 'MarkNotified', request_id: ids.get('beta')!, channel: 'other process' });
        await writeFile(path, stale);
        return { ok: true, reason: 'injected_for_test' };
      } });
      assert.equal(injected, 1);
      assert.equal((await readDispatchRequest('beta', ids.get('beta')!, cwd))?.status, 'notified');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses runtime-returned records when a stale projection is published after refresh', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-refresh-publish-race-'));
    const stateDir = join(cwd, '.omx/state');
    const bridge = getDefaultBridge(stateDir);
    const originalExec = RuntimeBridge.prototype.execCommand;
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'already notified',
      }, cwd);
      const path = join(stateDir, 'dispatch.json');
      const stale = await readFile(path, 'utf8');
      bridge.execCommand({ command: 'MarkNotified', request_id: queued.request.request_id, channel: 'tmux' });
      let captures = 0;
      RuntimeBridge.prototype.execCommand = function(command, options) {
        const event = originalExec.call(this, command, options);
        if (command.command === 'CaptureSnapshot') {
          assert.equal(event.event, 'SnapshotCaptured');
          assert.ok('dispatch_records' in event && Array.isArray(event.dispatch_records));
          captures += 1;
          writeFileSync(path, stale);
        }
        return event;
      };
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await drainPendingTeamDispatch({ cwd, injector: async () => {
          assert.fail('stale pending projection must not reinject a notified request');
        } });
        assert.equal(result.processed, 0);
      }
      assert.equal(captures, 2, 'a stale replacement must not enter the verified projection cache');
    } finally {
      RuntimeBridge.prototype.execCommand = originalExec;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not cache snapshots from older runtimes without returned dispatch records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-legacy-snapshot-'));
    const bridge = getDefaultBridge(join(cwd, '.omx/state'));
    const originalExec = RuntimeBridge.prototype.execCommand;
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'notified' }, cwd);
      bridge.execCommand({ command: 'MarkNotified', request_id: queued.request.request_id, channel: 'tmux' });
      let captures = 0;
      RuntimeBridge.prototype.execCommand = function(command, options) {
        const event = originalExec.call(this, command, options);
        if (event.event === 'SnapshotCaptured') {
          captures += 1;
          return { event: 'SnapshotCaptured' };
        }
        return event;
      };
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.equal((await drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('notified request reinjected'); } })).processed, 0);
      }
      assert.equal(captures, 2);
    } finally {
      RuntimeBridge.prototype.execCommand = originalExec;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refreshes durable dispatch events before claiming a stale pending projection', async () => {
    for (const status of ['notified', 'delivered'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-event-replay-'));
      try {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox', to_worker: 'worker-1', trigger_message: 'must not reinject',
          transport_preference: 'hook_preferred_with_fallback',
        }, cwd);
        const stateDir = join(cwd, '.omx', 'state');
        const projectionPath = join(stateDir, 'dispatch.json');
        const staleProjection = await readFile(projectionPath, 'utf8');
        const bridge = getDefaultBridge(stateDir);
        bridge.execCommand({ command: 'MarkNotified', request_id: queued.request.request_id, channel: 'tmux' });
        if (status === 'delivered') bridge.execCommand({ command: 'MarkDelivered', request_id: queued.request.request_id });
        await writeFile(projectionPath, staleProjection);
        let injections = 0;
        const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await drainPendingTeamDispatch({ cwd, injector: async () => {
            injections += 1;
            return { ok: true, reason: 'unexpected injection' };
          } });
          assert.equal(result.processed, 0);
        }
        assert.equal(injections, 0);
        assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, status);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('preserves pending retry counts across Team refreshes with cooldowns disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-replay-retries-'));
    const previousIssue = process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
    const previousTrigger = process.env.OMX_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS;
    try {
      process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = '0';
      process.env.OMX_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS = '0';
      const ids = new Map<string, string>();
      for (const team of ['alpha', 'beta']) {
        await initTeamState(team, 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest(team, {
          kind: 'inbox', to_worker: 'worker-1', trigger_message: 'retry ' + team,
        }, cwd);
        ids.set(team, queued.request.request_id);
      }
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      let injections = 0;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await drainPendingTeamDispatch({ cwd, injector: async () => {
          injections += 1;
          return { ok: true, reason: 'tmux_send_keys_unconfirmed' };
        } });
        for (const [team, id] of ids) {
          const record = await readDispatchRequest(team, id, cwd);
          if (attempt < 3) assert.equal(record?.attempt_count, attempt);
          assert.equal(record?.status, attempt === 3 ? 'failed' : 'pending');
        }
      }
      await drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('failed request reinjected'); } });
      assert.equal(injections, 6);
    } finally {
      if (previousIssue === undefined) delete process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
      else process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = previousIssue;
      if (previousTrigger === undefined) delete process.env.OMX_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS;
      else process.env.OMX_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS = previousTrigger;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks pending request as notified and preserves mailbox notified_at semantics', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'worker-1', 'hello', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'worker-1',
        worker_index: 1,
        message_id: msg.message_id,
        trigger_message: 'check mailbox',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
      assert.ok(request?.notified_at, 'expected dispatch state to record notified_at');
      const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
      const mailboxMessage = mailbox.find((entry) => entry.message_id === msg.message_id);
      assert.ok(mailboxMessage, 'expected the queued mailbox message to remain readable');
      const notifiedAt = await waitForMailboxNotifiedAt('alpha', 'worker-1', msg.message_id, cwd);
      assert.ok(notifiedAt || request.notified_at, 'expected dispatch state or mailbox shadow to record notified_at');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('leader-fixed dispatch remains pending with leader_pane_missing_deferred when pane missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'check leader mailbox',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      assert.equal(result.processed, 0);
      assert.ok(result.skipped >= 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'leader_pane_missing_deferred');

      const mailbox = await listMailboxMessages('alpha', 'leader-fixed', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.notified_at, undefined);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'events', 'events.ndjson');
      const eventsRaw = await readFile(eventsPath, 'utf-8');
      const events = eventsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferred = events.find((event: {
        type?: string;
        reason?: string;
        request_id?: string;
        to_worker?: string;
      }) =>
        event.type === 'leader_notification_deferred'
        && event.reason === 'leader_pane_missing_deferred'
        && event.request_id === queued.request.request_id
        && event.to_worker === 'leader-fixed');
      assert.ok(deferred, 'expected leader_notification_deferred event for missing leader pane');
      assert.equal(deferred.source_type, 'team_dispatch');
      assert.equal(typeof deferred.tmux_session, 'string');
      assert.ok(deferred.tmux_session.length > 0);
      assert.equal(deferred.leader_pane_id, null);
      assert.equal(deferred.tmux_injection_attempted, false);

      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLogs = (await readFile(dispatchLogPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredLog = dispatchLogs.find((entry: { type?: string; request_id?: string }) =>
        entry.type === 'dispatch_deferred' && entry.request_id === queued.request.request_id);
      assert.ok(deferredLog, 'expected dispatch_deferred log entry');
      assert.equal(typeof deferredLog.tmux_session, 'string');
      assert.ok(deferredLog.tmux_session.length > 0);
      assert.equal(deferredLog.leader_pane_id, null);
      assert.equal(deferredLog.tmux_injection_attempted, false);

      const deliveryLog = await readTeamDeliveryLog(cwd);
      assert.ok(deliveryLog.some((entry) =>
        entry.event === 'dispatch_result'
        && entry.source === 'notify-hook.team-dispatch'
        && entry.request_id === queued.request.request_id
        && entry.result === 'deferred'
        && entry.reason === 'leader_pane_missing_deferred'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not duplicate deferred leader artifacts across repeated drain ticks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'check leader mailbox',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector: async () => ({ ok: true, reason: 'injected_for_test' }) });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector: async () => ({ ok: true, reason: 'injected_for_test' }) });

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredEvents = events.filter((event: { type?: string; request_id?: string }) =>
        event.type === 'leader_notification_deferred' && event.request_id === queued.request.request_id);
      assert.equal(deferredEvents.length, 1, 'should only write one deferred event per missing-pane request until state changes');

      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLogs = (await readFile(dispatchLogPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredLogs = dispatchLogs.filter((entry: { type?: string; request_id?: string }) =>
        entry.type === 'dispatch_deferred' && entry.request_id === queued.request.request_id);
      assert.equal(deferredLogs.length, 1, 'should only log one dispatch_deferred artifact per missing-pane request until state changes');

      const deliveryLog = await readTeamDeliveryLog(cwd);
      const deferredDeliveryLogs = deliveryLog.filter((entry) =>
        entry.event === 'dispatch_result'
        && entry.source === 'notify-hook.team-dispatch'
        && entry.request_id === queued.request.request_id
        && entry.result === 'deferred');
      assert.equal(deferredDeliveryLogs.length, 1, 'should only log one deferred team-delivery artifact per missing-pane request until state changes');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('invokes omx-runtime exec-scoped via shared bridge fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const runtimeLogPath = join(cwd, 'runtime.log');
    const previousPath = process.env.PATH;
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'omx-runtime'),
        `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "${runtimeLogPath}"
if [[ "\${1:-}" == "schema" ]]; then
  printf '{"schema_version":1,"capabilities":["team-mailbox-scope-v1"],"commands":["acquire-authority","renew-authority","queue-dispatch","mark-notified","mark-delivered","mark-failed","remove-dispatch-records","request-replay","capture-snapshot"],"events":[],"transport":"tmux"}\n'
  exit 0
fi
if [[ "\${1:-}" == "exec-scoped" ]]; then
  printf '{"event":"DispatchNotified","request_id":"runtime-fallback","channel":"tmux"}\n'
  exit 0
fi
exit 1
`,
      );
      await chmod(join(fakeBinDir, 'omx-runtime'), 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      const runtimeLog = await readFile(runtimeLogPath, 'utf8');
      assert.match(runtimeLog, /^exec-scoped \{"command":"MarkNotified"/m);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not commit a shadow-only mailbox receipt when runtime disappears after injection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-mailbox-transport-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime);
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const message = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'receipt', cwd);
      const request = await enqueueDispatchRequest('alpha', { kind: 'mailbox', to_worker: 'worker-1',
        message_id: message.message_id, trigger_message: 'read receipt' }, cwd);
      const shadowPath = join(cwd, '.omx/state/team/alpha/mailbox/worker-1.json');
      const shadow = await readFile(shadowPath, 'utf8');
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      assert.equal((await drainPendingTeamDispatch({ cwd, injector: async () => {
        await rm(runtime);
        return { ok: true, reason: 'confirmed injection', delivery_confirmed: true,
          pane: null, pane_source: null, readiness_evidence: null, pane_current_command: null,
          exact_pane_proof: null, tmux_injection_attempted: false };
      } })).processed, 1);
      assert.equal(await readFile(shadowPath, 'utf8'), shadow);
      await writeCompatRuntimeFixture(runtime);
      await drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('confirmed injection repeated'); } });
      assert.equal((await readDispatchRequest('alpha', request.request.request_id, cwd))?.status, 'delivered');
      assert.equal((await listMailboxMessages('alpha', 'worker-1', cwd))[0].notified_at, undefined);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks bridge-authored mailbox state as notified on canonical hook success paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const runtimePath = join(fakeBinDir, 'omx-runtime');
    const previousPath = process.env.PATH;
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(runtimePath);
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'worker-1', 'hello', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'worker-1',
        worker_index: 1,
        message_id: msg.message_id,
        trigger_message: 'check mailbox',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      assert.equal(result.processed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');

      const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
      assert.ok(mailbox.some((message) => message.message_id === msg.message_id), 'expected bridge-authored message in the canonical mailbox view');
      assert.ok(mailbox.find((message) => message.message_id === msg.message_id)?.notified_at);
      assert.ok(request?.notified_at, 'expected dispatch state to expose the notification timestamp');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not notify another Team mailbox ID even through a polluted shadow and dispatch request', async () => {
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      for (const legacy of [false, true]) {
        const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-mailbox-isolation-'));
        try {
          const runtimePath = join(cwd, 'omx-runtime');
          await writeCompatRuntimeFixture(runtimePath);
          process.env.OMX_RUNTIME_BINARY = runtimePath;
          process.env.OMX_RUNTIME_BRIDGE = '1';
          await initTeamState('alpha', 'task', 'executor', 1, cwd);
          await initTeamState('beta', 'task', 'executor', 1, cwd);
          const foreign = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'alpha only', cwd);
          const own = await sendDirectMessage('beta', 'leader-fixed', 'worker-1', 'beta only', cwd);
          await writeFile(join(cwd, '.omx', 'state', 'team', 'beta', 'mailbox', 'worker-1.json'),
            JSON.stringify({ worker: 'worker-1', messages: [foreign, own] }));
          const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
          if (legacy) {
            const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
            for (const record of compat.records) delete record.team_name;
            await writeFile(compatPath, JSON.stringify(compat));
          }
          for (const message of [foreign, own]) {
            await enqueueDispatchRequest('beta', {
              kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
              message_id: message.message_id, trigger_message: `check ${message.message_id}`,
            }, cwd);
          }
          const mod = await import('../../scripts/notify-hook/team-dispatch.js');
          await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5,
            injector: async () => ({ ok: true, reason: 'injected_for_test' }) });
          const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ message_id: string; notified_at: string | null }> };
          assert.equal(compat.records.find((record) => record.message_id === foreign.message_id)?.notified_at, null);
          assert.equal(typeof compat.records.find((record) => record.message_id === own.message_id)?.notified_at, 'string');
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
    }
  });

  it('rejects an incompatible runtime before injecting pending requests on repeated ticks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-runtime-preflight-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const requests = [];
      for (const trigger of ['investigate ABC-123', 'investigate ABC-456']) {
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox', to_worker: 'worker-1', worker_index: 1, trigger_message: trigger,
        }, cwd);
        requests.push(queued.request.request_id);
      }
      const supported = await readFile(runtimePath, 'utf8');
      await writeFile(runtimePath, supported.replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []'));
      let injections = 0;
      const mod = await import('../../scripts/notify-hook/team-dispatch.js');
      const drain = () => mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5,
        injector: async () => { injections += 1; return { ok: true, reason: 'injected_for_test' }; } });
      for (let tick = 0; tick < 2; tick += 1) {
        await assert.rejects(drain, /team-mailbox-scope-v1/);
        assert.equal(injections, 0);
        const cooldownPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'dispatch', 'issue-cooldown.json');
        assert.deepEqual(JSON.parse(await readFile(cooldownPath, 'utf8').catch(() => '{"by_issue":{}}')).by_issue, {});
        assert.deepEqual(await listDispatchProcessingLeases(cwd, 'alpha'), []);
        for (const requestId of requests) assert.equal((await readDispatchRequest('alpha', requestId, cwd))?.status, 'pending');
      }
      await writeFile(runtimePath, supported);
      assert.equal((await drain()).processed, 2);
      assert.equal(injections, 2);
      assert.equal((await drain()).processed, 0);
      assert.equal(injections, 2);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not dispatch unscoped runtime records to the Team currently being scanned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-unscoped-dispatch-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const compatPath = join(cwd, '.omx', 'state', 'dispatch.json');
      const compat = JSON.stringify({ records: [{
        request_id: 'legacy-unscoped',
        target: 'worker-1',
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
        notified_at: null,
        delivered_at: null,
        failed_at: null,
        reason: 'foreign prompt',
        metadata: { kind: 'inbox', trigger_message: 'foreign prompt' },
      }] });
      await writeFile(compatPath, compat);

      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      let injections = 0;
      assert.deepEqual(await drainPendingTeamDispatch({ cwd, injector: async () => {
        injections += 1;
        return { ok: true, reason: 'injected_for_test' };
      } }), { processed: 0, skipped: 0, failed: 0 });
      assert.equal(injections, 0);
      assert.equal(await readFile(compatPath, 'utf8'), compat);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  for (const corruption of ['invalid-json', 'null-row', 'invalid-row', 'mixed-rows']) {
    it(`persists an injected request when runtime compatibility changes after preflight (${corruption})`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-runtime-swap-'));
      const previousBinary = process.env.OMX_RUNTIME_BINARY;
      const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
      try {
        const runtimePath = join(cwd, 'omx-runtime');
        await writeCompatRuntimeFixture(runtimePath);
        process.env.OMX_RUNTIME_BINARY = runtimePath;
        process.env.OMX_RUNTIME_BRIDGE = '1';
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox', to_worker: 'worker-1', worker_index: 1, trigger_message: 'investigate ABC-123',
        }, cwd);
        const supported = await readFile(runtimePath, 'utf8');
        const projectionPath = join(cwd, '.omx/state/dispatch.json');
        const pendingProjection = await readFile(projectionPath, 'utf8');
        let injections = 0;
        const mod = await import('../../scripts/notify-hook/team-dispatch.js');
        const drain = () => mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5,
          injector: async () => {
            injections += 1;
            await writeFile(runtimePath, supported.replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []'));
            const records = JSON.parse(pendingProjection).records;
            const damagedProjection = corruption === 'invalid-json' ? '{"records":'
              : JSON.stringify({ records: corruption === 'null-row' ? [null]
                : corruption === 'invalid-row' ? [{}] : [...records, null] });
            await writeFile(projectionPath, damagedProjection);
            return { ok: true, reason: 'injected_for_test' };
          } });

        assert.equal((await drain()).processed, 1);
        assert.equal(await readDispatchRequest('alpha', queued.request.request_id, cwd), null,
          'an unavailable projection must not expose runtime-owned shadows');
        const shadows = JSON.parse(await readFile(join(cwd, '.omx/state/team/alpha/dispatch/requests.json'), 'utf8'));
        assert.equal(shadows.find((request: { request_id: string; status: string }) => request.request_id === queued.request.request_id)?.status, 'notified');
        assert.equal(injections, 1);
        assert.equal(JSON.parse((await readFile(join(cwd, '.omx/state/team/alpha/dispatch/runtime-finalizations.jsonl'), 'utf8')).trim()).command, 'MarkNotified');
        await assert.rejects(drain, /team-mailbox-scope-v1/);
        await writeFile(runtimePath, supported);
        await writeFile(projectionPath, pendingProjection);
        assert.equal((await drain()).processed, 0);
        assert.equal(injections, 1, 'post-injection schema drift must not leave the request eligible for replay');
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it('journals an injected request when the runtime disappears after preflight', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-runtime-unavailable-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', worker_index: 1, trigger_message: 'investigate ABC-789',
      }, cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const projectionPath = join(stateDir, 'dispatch.json');
      const pendingProjection = await readFile(projectionPath, 'utf8');
      const supported = await readFile(runtimePath, 'utf8');
      let injections = 0;
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      const drain = () => drainPendingTeamDispatch({ cwd, maxPerTick: 5,
        injector: async () => {
          injections += 1;
          await rm(runtimePath);
          return { ok: true, reason: 'injected_for_test' };
        } });

      assert.equal((await drain()).processed, 1);
      const journalPath = join(stateDir, 'team/alpha/dispatch/runtime-finalizations.jsonl');
      assert.equal(JSON.parse((await readFile(journalPath, 'utf8')).trim()).command, 'MarkNotified');
      assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, 'notified');

      await writeFile(runtimePath, supported);
      await chmod(runtimePath, 0o755);
      await writeFile(projectionPath, pendingProjection);
      assert.equal((await drain()).processed, 0);
      assert.equal(injections, 1, 'transport failure after injection must not leave the request eligible for replay');
      assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, 'notified');
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('journals confirmed injection before semantic failure and recovers without reinjection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-semantic-finalization-failure-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousRejectNotified = process.env.OMX_TEST_REJECT_MARK_NOTIFIED;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'semantic finalization failure',
      }, cwd);
      process.env.OMX_TEST_REJECT_MARK_NOTIFIED = '1';
      let injections = 0;
      const injector = async () => {
        injections += 1;
        return {
          ok: true,
          reason: 'injected_for_test',
          delivery_confirmed: true,
          pane: null,
          pane_source: null,
          readiness_evidence: null,
          pane_current_command: null,
          exact_pane_proof: null,
          tmux_injection_attempted: false,
        };
      };

      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      await assert.rejects(
        () => drainPendingTeamDispatch({ cwd, injector }),
        /exec-scoped failed/,
      );
      assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, 'pending');
      const journalPath = join(cwd, '.omx/state/team/alpha/dispatch/runtime-finalizations.jsonl');
      assert.deepEqual((await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).command),
        ['MarkNotified', 'MarkDelivered']);

      delete process.env.OMX_TEST_REJECT_MARK_NOTIFIED;
      assert.equal((await drainPendingTeamDispatch({ cwd, injector })).processed, 0);
      assert.equal(injections, 1, 'a confirmed injection must never be retried while its receipt is reconciled');
      assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, 'delivered');
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousRejectNotified === undefined) delete process.env.OMX_TEST_REJECT_MARK_NOTIFIED;
      else process.env.OMX_TEST_REJECT_MARK_NOTIFIED = previousRejectNotified;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers confirmed delivery when the default injector loses its runtime', async () => {
    for (const failure of ['missing', 'incompatible']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-delivery-recovery-'));
      const previousBinary = process.env.OMX_RUNTIME_BINARY;
      const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
      const previousPath = process.env.PATH;
      try {
        const runtime = join(cwd, 'omx-runtime');
        await writeCompatRuntimeFixture(runtime);
        const supported = await readFile(runtime, 'utf8');
        process.env.OMX_RUNTIME_BINARY = runtime;
        process.env.OMX_RUNTIME_BRIDGE = '1';
        const bin = join(cwd, 'bin');
        await mkdir(bin);
        const sabotage = failure === 'missing' ? `rm -f "${runtime}"`
          : `printf '#!/usr/bin/env node\nconsole.log("{}");\n' > "${runtime}"`;
        await writeFile(join(bin, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')).replace(
          'if [[ "$cmd" == "send-keys" ]]; then',
          `if [[ "$cmd" == "send-keys" ]]; then\n  ${sabotage}`,
        ));
        await chmod(join(bin, 'tmux'), 0o755);
        process.env.PATH = `${bin}:${previousPath || ''}`;
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const config = await readTeamConfig('alpha', cwd);
        assert.ok(config);
        config.workers[0].pane_id = '%42';
        config.workers[0].pid = 4242;
        bindCanonicalTeamPaneAuthority(config);
        await saveTeamConfig(config, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox', to_worker: 'worker-1', worker_index: 1, pane_id: '%42', trigger_message: 'receipt',
        }, cwd);
        const projectionPath = join(cwd, '.omx/state/dispatch.json');
        const pendingProjection = await readFile(projectionPath, 'utf8');
        const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
        assert.equal((await drainPendingTeamDispatch({ cwd, maxPerTick: 5 })).processed, 1);
        const journal = join(cwd, '.omx/state/team/alpha/dispatch/runtime-finalizations.jsonl');
        assert.deepEqual((await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line).command), ['MarkNotified', 'MarkDelivered', 'MarkNotified', 'MarkDelivered']);
        await writeFile(runtime, supported);
        await chmod(runtime, 0o755);
        await writeFile(projectionPath, pendingProjection);
        assert.equal((await drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('delivered request reinjected'); } })).processed, 0);
        assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, 'delivered');
        await assert.rejects(readFile(journal), { code: 'ENOENT' });
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('requires Team ownership proof for hook notifications with the bridge disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-disabled-ownership-'));
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await initTeamState('beta', 'task', 'executor', 1, cwd);
      const foreign = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'alpha only', cwd);
      const own = await sendDirectMessage('beta', 'leader-fixed', 'worker-1', 'beta only', cwd);
      const shadowPath = join(cwd, '.omx/state/team/beta/mailbox/worker-1.json');
      await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [foreign, own] }));
      for (const message of [foreign, own]) {
        await enqueueDispatchRequest('beta', { kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
          message_id: message.message_id, trigger_message: `read ${message.message_id}` }, cwd);
      }
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      assert.equal((await drainPendingTeamDispatch({ cwd, maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }) })).processed, 2);
      const shadow = JSON.parse(await readFile(shadowPath, 'utf8'));
      assert.deepEqual(shadow.messages[0], JSON.parse(JSON.stringify(foreign)));
      assert.ok(shadow.messages[1].notified_at);
      assert.equal((await listMailboxMessages('alpha', 'worker-1', cwd))[0].notified_at, undefined);
    } finally {
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps pure JSON requests visible after a runtime swap', async () => {
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    for (const mode of ['disabled', 'unavailable', 'mixed']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-json-runtime-swap-'));
      try {
        process.env.OMX_RUNTIME_BRIDGE = mode === 'disabled' ? '0' : '1';
        process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const requests = [];
        for (const trigger of ['first legacy instruction', 'second legacy instruction']) {
          requests.push((await enqueueDispatchRequest('alpha', {
            kind: 'inbox', to_worker: 'worker-1', worker_index: 1, trigger_message: trigger,
          }, cwd)).request.request_id);
        }
        if (mode === 'mixed') await writeFile(join(cwd, '.omx', 'state', 'events.json'), '[]');
        const runtimePath = join(cwd, 'runtime');
        await writeCompatRuntimeFixture(runtimePath);
        const supported = await readFile(runtimePath, 'utf8');
        process.env.OMX_RUNTIME_BINARY = runtimePath;
        process.env.OMX_RUNTIME_BRIDGE = '1';
        let injections = 0;
        const mod = await import('../../scripts/notify-hook/team-dispatch.js');
        const drain = () => mod.drainPendingTeamDispatch({ cwd, maxPerTick: 1,
          injector: async () => {
            injections += 1;
            if (injections === 1) await writeFile(runtimePath, supported.replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []'));
            return { ok: true, reason: 'injected_for_test' };
          } });
        assert.equal((await drain()).processed, 1);
        assert.equal((await readDispatchRequest('alpha', requests[1], cwd))?.status, 'pending');
        await assert.rejects(drain, /team-mailbox-scope-v1/);
        await writeFile(runtimePath, supported);
        assert.equal((await drain()).processed, 1);
        assert.equal((await drain()).processed, 0);
        assert.equal(injections, 2);
        for (const id of requests) assert.equal((await readDispatchRequest('alpha', id, cwd))?.status, 'notified');
        for (const file of ['snapshot.json', 'mailbox.json', 'team/alpha/dispatch/runtime-finalizations.jsonl', ...(mode !== 'mixed' ? ['events.json'] : []), ...(mode === 'disabled' ? ['dispatch.json'] : [])]) {
          await assert.rejects(readFile(join(cwd, '.omx', 'state', file)), { code: 'ENOENT' });
        }
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('finalizes claims when the runtime becomes incompatible after injection', async () => {
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousPath = process.env.PATH;
    try {
      for (const mode of ['notified', 'failed', 'default-injector']) {
        const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-runtime-swap-'));
        try {
          const runtimePath = join(cwd, 'omx-runtime');
          await writeCompatRuntimeFixture(runtimePath);
          const supported = await readFile(runtimePath, 'utf8');
          const incompatible = supported.replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []');
          process.env.OMX_RUNTIME_BINARY = runtimePath;
          process.env.OMX_RUNTIME_BRIDGE = '1';
          await initTeamState('alpha', 'task', 'executor', 1, cwd);
          const message = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'read once', cwd);
          const queued = await enqueueDispatchRequest('alpha', {
            kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
            message_id: message.message_id, trigger_message: 'read once',
          }, cwd);
          const stateDir = join(cwd, '.omx', 'state');
          const compatPath = join(stateDir, 'dispatch.json');
          const pending = await readFile(compatPath, 'utf8');
          const tmuxLogPath = join(cwd, 'tmux.log');
          let injections = 0;
          const mod = await import('../../scripts/notify-hook/team-dispatch.js');
          const options = mode === 'default-injector' ? {} : {
            injector: async () => {
              injections += 1;
              await writeFile(runtimePath, incompatible);
              return { ok: mode === 'notified', reason: 'injected_for_test' };
            },
          };
          if (mode === 'default-injector') {
            const binDir = join(cwd, 'bin');
            await mkdir(binDir);
            const oldBinary = join(cwd, 'old-runtime');
            await writeFile(oldBinary, incompatible);
            await writeFile(join(binDir, 'tmux'), buildFakeTmux(tmuxLogPath).replace(
              'if [[ "$cmd" == "send-keys" ]]; then',
              `if [[ "$cmd" == "send-keys" ]]; then\n  cp "${oldBinary}" "${runtimePath}"`,
            ));
            await chmod(join(binDir, 'tmux'), 0o755);
            process.env.PATH = `${binDir}:${previousPath || ''}`;
            const config = await readTeamConfig('alpha', cwd);
            assert.ok(config);
            config.workers[0].pane_id = '%42';
            config.workers[0].pid = 4242;
            bindCanonicalTeamPaneAuthority(config);
            await saveTeamConfig(config, cwd);
          }
          const drain = () => mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, ...options });
          assert.equal((await drain()).processed, 1);
          const expectedStatus = mode === 'failed' ? 'failed' : mode === 'default-injector' ? 'delivered' : 'notified';
          assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, expectedStatus);
          assert.deepEqual(await listDispatchProcessingLeases(cwd, 'alpha'), []);
          assert.equal((await listMailboxMessages('alpha', 'worker-1', cwd))[0].notified_at, undefined);
          // Model a later runtime command rebuilding compatibility output from its pending event history.
          await writeFile(compatPath, pending);
          const journalPath = join(stateDir, 'team', 'alpha', 'dispatch', 'runtime-finalizations.jsonl');
          const journal = await readFile(journalPath, 'utf8');
          const journalCommands = journal.trim().split('\n').map((line) => JSON.parse(line).command);
          assert.deepEqual(journalCommands, mode === 'default-injector'
            ? ['MarkNotified', 'MarkDelivered', 'MarkNotified', 'MarkDelivered']
            : [mode === 'failed' ? 'MarkFailed' : 'MarkNotified']);
          await assert.rejects(drain, /team-mailbox-scope-v1/);
          assert.equal(await readFile(journalPath, 'utf8'), journal);
          process.env.OMX_RUNTIME_BRIDGE = '0';
          await assert.rejects(drain, /runtime finalizations require the runtime bridge/);
          process.env.OMX_RUNTIME_BRIDGE = '1';
          await writeFile(runtimePath, supported);
          assert.equal((await drain()).processed, 0);
          assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.status, expectedStatus);
          assert.equal((await drain()).processed, 0);
          await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
          if (mode === 'default-injector') {
            const log = await readFile(tmuxLogPath, 'utf8');
            assert.equal(log.split('\n').filter((line) => line.startsWith('paste-buffer -t %42 ')).length, 1);
            assert.equal(log.split('\n').filter((line) => line === 'send-keys -t %42 Enter').length, 2);
          } else assert.equal(injections, 1);
        } finally {
          process.env.PATH = previousPath;
          await rm(cwd, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('keeps hook shadow updates safe on runtime rejection, recovery collisions, and clock drift', async () => {
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      for (const mode of ['rejected', 'recovery', 'bodyless-drift', 'old-runtime']) {
        const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-shadow-identity-'));
        try {
          const runtimePath = join(cwd, 'omx-runtime');
          await writeCompatRuntimeFixture(runtimePath);
          process.env.OMX_RUNTIME_BINARY = runtimePath;
          process.env.OMX_RUNTIME_BRIDGE = '1';
          await initTeamState('alpha', 'task', 'executor', 1, cwd);
          const own = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'own', cwd);
          const shadowPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'mailbox', 'worker-1.json');
          const recovery = { ...own, body: 'recover this payload' };
          if (mode === 'recovery') await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [recovery, recovery, own] }));
          const shadowBefore = await readFile(shadowPath, 'utf8');
          const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
          const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
          if (mode === 'rejected') compat.records.push({ ...compat.records[0], body: 'ambiguous' });
          if (mode === 'bodyless-drift') {
            compat.records[0].body = '';
            compat.records[0].created_at = '2020-01-01T00:00:00.000Z';
          }
          await writeFile(compatPath, JSON.stringify(compat));
          const authoritativeBefore = await readFile(compatPath, 'utf8');
          await enqueueDispatchRequest('alpha', { kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
            message_id: own.message_id, trigger_message: 'check mailbox' }, cwd);
          if (mode === 'old-runtime') {
            await writeFile(runtimePath, (await readFile(runtimePath, 'utf8')).replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []'));
          }
          const mod = await import('../../scripts/notify-hook/team-dispatch.js');
          await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5,
            injector: async () => ({ ok: true, reason: 'injected_for_test' }) }).catch((error) => {
              if (mode !== 'old-runtime') throw error;
              assert.match(String(error), /team-mailbox-scope-v1/);
            });
          if (mode === 'rejected' || mode === 'old-runtime') {
            assert.equal(await readFile(shadowPath, 'utf8'), shadowBefore);
            if (mode === 'old-runtime') assert.equal(await readFile(compatPath, 'utf8'), authoritativeBefore);
            const after = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ notified_at: string | null }> };
            assert.ok(after.records.every((record) => record.notified_at === null));
          } else {
            const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: Array<typeof own> };
            assert.equal(shadow.messages.length, mode === 'recovery' ? 3 : 1);
            if (mode === 'recovery') assert.deepEqual(shadow.messages.slice(0, 2), [recovery, recovery].map((message) => JSON.parse(JSON.stringify(message))));
            const [message] = await listMailboxMessages('alpha', 'worker-1', cwd);
            assert.equal(message.body, 'own');
            assert.ok(message.notified_at);
          }
        } finally { await rm(cwd, { recursive: true, force: true }); }
      }
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
    }
  });

  it('notifies only the scoped Team record when a legacy record has the same ID', async () => {
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      for (const scoped of [false, true]) {
        const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-mailbox-collision-'));
        try {
          const runtimePath = join(cwd, 'omx-runtime');
          await writeCompatRuntimeFixture(runtimePath);
          process.env.OMX_RUNTIME_BINARY = runtimePath;
          process.env.OMX_RUNTIME_BRIDGE = '1';
          await initTeamState('alpha', 'task', 'executor', 1, cwd);
          await initTeamState('beta', 'task', 'executor', 1, cwd);
          const foreign = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'alpha only', cwd);
          const own = await sendDirectMessage('beta', 'leader-fixed', 'worker-1', 'beta only', cwd);
          const betaDir = join(cwd, '.omx', 'state', 'team', 'beta');
          const shadowPath = join(betaDir, 'mailbox', 'worker-1.json');
          await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [{ ...own, message_id: foreign.message_id }] }));
          const journalPath = join(betaDir, 'events', 'events.ndjson');
          await writeFile(journalPath, (await readFile(journalPath, 'utf8')).replaceAll(own.message_id, foreign.message_id));
          const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
          const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
          delete compat.records[0].team_name;
          compat.records[1].message_id = foreign.message_id;
          if (!scoped) delete compat.records[1].team_name;
          await writeFile(compatPath, JSON.stringify(compat));
          await enqueueDispatchRequest('beta', {
            kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
            message_id: foreign.message_id, trigger_message: 'check mailbox',
          }, cwd);
          const mod = await import('../../scripts/notify-hook/team-dispatch.js');
          await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5,
            injector: async () => ({ ok: true, reason: 'injected_for_test' }) });
          const after = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ notified_at: string | null }> };
          assert.equal(after.records[0].notified_at, null);
          assert.equal(Boolean(after.records[1].notified_at), scoped);
          const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: Array<{ notified_at?: string }> };
          assert.equal(Boolean(shadow.messages[0].notified_at), scoped);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
    }
  });

  it('notifies a Team-proven shadow message when the runtime compatibility mailbox is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-mailbox-legacy-notified-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('legacy-notified', 'task', 'executor', 1, cwd);
      const message = await sendDirectMessage('legacy-notified', 'leader-fixed', 'worker-1', 'recoverable', cwd);
      const queued = await enqueueDispatchRequest('legacy-notified', {
        kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
        message_id: message.message_id, trigger_message: 'check mailbox',
      }, cwd);
      await rm(join(cwd, '.omx', 'state', 'mailbox.json'), { force: true });

      const mod = await import('../../scripts/notify-hook/team-dispatch.js');
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }) });

      assert.equal(result.processed, 1);
      const mailbox = await listMailboxMessages('legacy-notified', 'worker-1', cwd);
      assert.ok(mailbox.find((entry) => entry.message_id === message.message_id)?.notified_at);
      assert.equal((await readDispatchRequest('legacy-notified', queued.request.request_id, cwd))?.status, 'notified');
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('logs structured evidence when bridge dispatch compat cannot be parsed and legacy requests are used', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await writeFile(join(cwd, '.omx', 'state', 'dispatch.json'), '{ broken bridge json');

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      assert.equal(result.processed, 1, 'legacy request fallback must still process the pending request');
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');

      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLogs = (await readFile(dispatchLogPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const fallback = dispatchLogs.find((entry: { type?: string; fallback?: boolean; bridge_operation?: string }) =>
        entry.type === 'bridge_fallback' && entry.bridge_operation === 'readBridgeDispatchRequests' && entry.fallback === true);
      assert.ok(fallback, 'expected structured bridge fallback evidence in dispatch log');
      assert.equal(fallback.team, 'alpha');
      assert.equal(fallback.fallback_target, 'legacy_dispatch_requests');
      assert.equal(fallback.counter, 'team_dispatch_bridge_fallback_total');
      assert.match(fallback.reason, /parse_failed|invalid_dispatch_compat/);

      const deliveryLog = await readTeamDeliveryLog(cwd);
      assert.ok(deliveryLog.some((entry) =>
        entry.event === 'bridge_fallback'
        && entry.source === 'notify-hook.team-dispatch'
        && entry.bridge_operation === 'readBridgeDispatchRequests'
        && entry.fallback_target === 'legacy_dispatch_requests'
        && entry.counter === 'team_dispatch_bridge_fallback_total'));
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('logs structured evidence when runtimeExec fails and JS state remains authoritative', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'omx-runtime'),
        `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "schema" ]]; then
  printf '{"schema_version":1,"capabilities":["team-mailbox-scope-v1"],"commands":["acquire-authority","renew-authority","queue-dispatch","mark-notified","mark-delivered","mark-failed","remove-dispatch-records","request-replay","capture-snapshot"]}\n'
  exit 0
fi
if [[ "\${1:-}" == "exec-scoped" ]]; then
  if [[ "$*" == *'"command":"QueueDispatch"'* ]]; then
    printf '{"event":"DispatchQueued","request_id":"request","target":"worker-1"}\n'
    exit 0
  fi
  echo "runtime schema drift" >&2
  exit 43
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'omx-runtime'), 0o755);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      assert.equal(result.processed, 1, 'JS fallback path must still finish the dispatch');
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');

      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLogs = (await readFile(dispatchLogPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const fallback = dispatchLogs.find((entry: { type?: string; bridge_operation?: string; request_id?: string }) =>
        entry.type === 'bridge_fallback' && entry.bridge_operation === 'runtimeExec' && entry.request_id === queued.request.request_id);
      assert.ok(fallback, 'expected structured runtimeExec fallback evidence in dispatch log');
      assert.equal(fallback.command, 'MarkNotified');
      assert.equal(fallback.team, 'alpha');
      assert.equal(fallback.fallback_target, 'js_state_mutation');
      assert.equal(fallback.counter, 'team_dispatch_bridge_fallback_total');
      assert.match(fallback.reason, /runtime schema drift|failed/);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('leader-fixed dispatch uses pane target only when leader_pane_id exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const prevPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      process.env.PATH = `${fakeBinDir}:${prevPath || ''}`;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('alpha', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.leader_pane_id = '%99';
      cfg.leader_pane_pid = 9999;
      bindCanonicalTeamPaneAuthority(cfg);
      await saveTeamConfig(cfg, cwd);

      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'Read .omx/state/team/alpha/mailbox/leader-fixed.json; worker-1 sent a new message. Review it and decide the next concrete step.',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.processed, 1);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assertFreshExactProofBeforePaneEffects(tmuxLog, '%99');
      assert.match(tmuxLog, /send-keys -t %99/);
      assert.match(tmuxLog, /mailbox\/leader-fixed\.json; worker-1 sent a new message/);
      assert.doesNotMatch(tmuxLog, /send-keys -t .*devsess/);
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('uses the persisted worker pane as an exact identity without generic resolution', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('alpha', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.workers[0].pane_id = '%99';
      cfg.workers[0].pid = 9999;
      bindCanonicalTeamPaneAuthority(cfg);
      await saveTeamConfig(cfg, cwd);
      await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'use the configured worker pane',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.processed, 1);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assertFreshExactProofBeforePaneEffects(tmuxLog, '%99');
      assert.match(tmuxLog, /send-keys -t %99/);
      assert.doesNotMatch(tmuxLog, /display-message -p -t %99 #\{pane_id\}/);
      assert.doesNotMatch(tmuxLog, /list-panes -t /);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed without a canonical PID for explicit worker and leader panes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-missing-pane-pid-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.leader_pane_id = '%99';
      await saveTeamConfig(config, cwd);
      const worker = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', worker_index: 1, trigger_message: 'do not send',
      }, cwd);
      const leader = await enqueueDispatchRequest('alpha', {
        kind: 'nudge', to_worker: 'leader-fixed', trigger_message: 'leader do not send',
      }, cwd);
      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.failed, 2);
      assert.equal((await readDispatchRequest('alpha', worker.request.request_id, cwd))?.last_reason, 'missing_exact_pane_pid');
      assert.equal((await readDispatchRequest('alpha', leader.request.request_id, cwd))?.last_reason, 'missing_exact_pane_pid');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not send when a guarded worker pane is reused before input effects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-pane-pid-reuse-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const proofSequencePath = join(cwd, 'exact-pane-sequence.txt');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(proofSequencePath, [
        '%42\\t0\\t4242', '%42\\t0\\t4242', '%42\\t0\\t4242',
        '%42\\t0\\t4242', '%42\\t0\\t4242', '%42\\t0\\t4242',
        '%42\\t0\\t5252',
      ].join('\n'));
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE = proofSequencePath;
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 4242;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', worker_index: 1, trigger_message: 'do not send',
      }, cwd);
      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.failed, 1);
      assert.equal((await readDispatchRequest('alpha', queued.request.request_id, cwd))?.last_reason, 'exact_pane_unavailable');
      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.doesNotMatch(tmuxLog, /(?:paste-buffer|send-keys) -t %42/, 'replacement pane must receive no input effect');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE;
      delete process.env.OMX_TEST_EXACT_PANE_COUNTER_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed before tmux effects when request and configured panes differ', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('alpha', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.workers[0].pane_id = '%99';
      await saveTeamConfig(cfg, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'must not be redirected',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.failed, 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'exact_pane_mismatch');
      assert.equal(await readFile(tmuxLogPath, 'utf8').catch(() => ''), '');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('fails an invalid request pane without session or index fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('alpha', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.tmux_session = 'must-not-resolve';
      delete cfg.workers[0].pane_id;
      await saveTeamConfig(cfg, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: 'invalid-pane-id',
        trigger_message: 'must not be sent',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.failed, 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.last_reason, 'exact_pane_unavailable');
      assert.equal(await readFile(tmuxLogPath, 'utf8').catch(() => ''), '');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the persisted leader pane as an exact identity without resolver healing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const prevPath = process.env.PATH;
    const prevTmuxPane = process.env.TMUX_PANE;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      const fakeTmux = `#!/usr/bin/env bash
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
  if [[ "$fmt" == "#S" ]]; then
    echo "devsess"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_start_command}" && "$target" == "%91" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "show-option" && "$*" == *"@omx_team_pane_owner_id" ]]; then
  echo "team:alpha"
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  if [[ "$*" == *"#{pane_dead}"* ]]; then
    printf "%%42\\t0\\t4242\\n%%91\\t0\\t9191\\n"
  else
    printf "%%42\\t1\\tnode\\tcodex\\n%%91\\t0\\tnode\\tnode dist/cli/omx.js hud --watch\\n"
  fi
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      process.env.PATH = `${fakeBinDir}:${prevPath || ''}`;
      process.env.TMUX_PANE = '%42';

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('alpha', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.leader_pane_id = '%91';
      cfg.leader_pane_pid = 9191;
      bindCanonicalTeamPaneAuthority(cfg);
      await saveTeamConfig(cfg, cwd);

      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'Read .omx/state/team/alpha/mailbox/leader-fixed.json; worker-1 sent a new message. Review it and decide the next concrete step.',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.processed, 1);

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /send-keys -t %91/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %42/);
      assert.doesNotMatch(tmuxLog, /display-message -p -t %91 #\{pane_id\}/, 'configured leader pane must bypass the generic resolver');

      cfg.hud_pane_id = '%91';
      await saveTeamConfig(cfg, cwd);
      const hudMsg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'second leader message', cwd);
      const hudQueued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: hudMsg.message_id,
        trigger_message: 'must not target the HUD pane',
      }, cwd);
      const hudResult = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(hudResult.failed, 1);
      const hudRequest = await readDispatchRequest('alpha', hudQueued.request.request_id, cwd);
      assert.equal(hudRequest?.last_reason, 'hud_pane_target');
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('leader-fixed dispatch fails without false notification when the resolved leader pane is in copy-mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const prevPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
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
  if [[ "$fmt" == "#{pane_in_mode}" && "$target" == "%77" ]]; then
    echo "1"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_id}" && "$target" == "%77" ]]; then
    echo "%77"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_path}" ]]; then
    dirname "${tmuxLogPath}"
    exit 0
  fi
  if [[ "$fmt" == "#{pane_current_command}" && "$target" == "%77" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$fmt" == "#S" ]]; then
    echo "devsess"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "show-option" && "$*" == *"@omx_team_pane_owner_id" ]]; then
  echo "team:alpha"
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  if [[ "$*" == *"#{pane_dead}"* ]]; then
    printf "%%77\\t0\\t7777\\n"
  else
    printf "%%77\\t1\\tcodex\\tcodex\\n"
  fi
  exit 0
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      process.env.PATH = `${fakeBinDir}:${prevPath || ''}`;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('alpha', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.leader_pane_id = '%77';
      cfg.leader_pane_pid = 7777;
      bindCanonicalTeamPaneAuthority(cfg);
      await saveTeamConfig(cfg, cwd);

      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'Read .omx/state/team/alpha/mailbox/leader-fixed.json; worker-1 sent a new message. Review it and decide the next concrete step.',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.processed, 1);
      assert.equal(result.failed, 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'scroll_active');

      const mailbox = await listMailboxMessages('alpha', 'leader-fixed', cwd);
      const mailboxMessage = mailbox.find((entry) => entry.message_id === msg.message_id);
      assert.equal(mailboxMessage?.notified_at, undefined, 'guard failure should not mark leader mailbox message notified');

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.match(tmuxLog, /display-message -p -t %77 #\{pane_in_mode\}/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %77/, 'copy-mode leader pane must not receive injected keys');
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses explicit stateDir when marking mailbox notified_at', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const stateDir = join(cwd, 'custom-state-root');
    const previousStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_TEAM_STATE_ROOT = './custom-state-root';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'worker-1', 'hello', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'worker-1',
        worker_index: 1,
        message_id: msg.message_id,
        trigger_message: 'check mailbox',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        stateDir,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      assert.equal(result.processed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
      assert.ok(request?.notified_at, 'expected dispatch state to record notified_at');
      const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
      const mailboxMessage = mailbox.find((entry) => entry.message_id === msg.message_id);
      assert.ok(mailboxMessage, 'expected the queued mailbox message to remain readable');
      const notifiedAt = await waitForMailboxNotifiedAt('alpha', 'worker-1', msg.message_id, cwd);
      assert.ok(notifiedAt || request.notified_at, 'expected dispatch state or mailbox shadow to record notified_at');
    } finally {
      if (typeof previousStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('is idempotent across repeated ticks (no duplicate processing)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      const second = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(second.processed, 0);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases the global dispatch lock before slow tmux injection so mailbox sends do not wedge mid-run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const previousLockTimeout = process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS = '1000';
      process.env.OMX_RUNTIME_BRIDGE = '0';

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'startup ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const slowDrain = mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 1,
        injector: async () => {
          await sleep(1_200);
          return { ok: true, reason: 'tmux_send_keys_confirmed' };
        },
      });

      await sleep(100);
      await assert.doesNotReject(async () => {
        await enqueueDispatchRequest('alpha', {
          kind: 'mailbox',
          to_worker: 'worker-1',
          worker_index: 1,
          trigger_message: 'check mailbox',
          message_id: 'msg-1',
        }, cwd);
      });

      const result = await slowDrain;
      assert.equal(result.processed, 1);
      assert.equal(result.failed, 0);
      const requests = JSON.parse(
        await readFile(join(cwd, '.omx', 'state', 'team', 'alpha', 'dispatch', 'requests.json'), 'utf-8'),
      ) as Array<{ request_id?: string; kind?: string; status?: string }>;
      const mailboxRequest = requests.find((entry) => entry.kind === 'mailbox');
      assert.equal(mailboxRequest?.status, 'pending');
    } finally {
      if (typeof previousLockTimeout === 'string') process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS = previousLockTimeout;
      else delete process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reserves per-issue cooldown before releasing the dispatch lock to a concurrent drain', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const previousIssueCooldown = process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
    let markInjectorStarted = () => {};
    const injectorStarted = new Promise<void>((resolve) => {
      markInjectorStarted = () => resolve();
    });
    let releaseInjector = () => {};
    const blockFirstInjector = new Promise<void>((resolve) => {
      releaseInjector = () => resolve();
    });
    let injectCount = 0;
    try {
      process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = '900000';
      await initTeamState('alpha', 'task', 'executor', 2, cwd);
      const first = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'IND-123 first follow-up',
      }, cwd);
      const second = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-2',
        worker_index: 2,
        trigger_message: 'IND-123 second follow-up',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const slowDrain = mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 1,
        injector: async () => {
          injectCount += 1;
          if (injectCount === 1) {
            markInjectorStarted();
            await blockFirstInjector;
          }
          return { ok: true, reason: 'tmux_send_keys_confirmed' };
        },
      });

      await injectorStarted;
      const concurrentDrain = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 1,
        injector: async () => {
          injectCount += 1;
          return { ok: true, reason: 'tmux_send_keys_confirmed' };
        },
      });
      releaseInjector();
      const firstResult = await slowDrain;

      assert.equal(injectCount, 1, 'concurrent drain must not inject same-issue follow-up while first claim is in flight');
      assert.equal(firstResult.processed, 1);
      assert.equal(concurrentDrain.processed, 0);
      assert.ok(concurrentDrain.skipped >= 1);

      const firstRequest = await readDispatchRequest('alpha', first.request.request_id, cwd);
      const secondRequest = await readDispatchRequest('alpha', second.request.request_id, cwd);
      assert.equal(firstRequest?.status, 'notified');
      assert.equal(secondRequest?.status, 'pending');
      assert.equal(secondRequest?.attempt_count, 0);
    } finally {
      releaseInjector();
      if (typeof previousIssueCooldown === 'string') process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = previousIssueCooldown;
      else delete process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases every preclaimed dispatch lease when a claimed injector throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 2, cwd);
      const first = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'first request',
      }, cwd);
      const second = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-2',
        worker_index: 2,
        trigger_message: 'second request',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      let attempt = 0;
      await assert.rejects(
        () => mod.drainPendingTeamDispatch({
          cwd,
          maxPerTick: 5,
          injector: async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('injector exploded');
            return { ok: true, reason: 'tmux_send_keys_confirmed' };
          },
        }),
        /injector exploded/,
      );

      assert.deepEqual(await listDispatchProcessingLeases(cwd, 'alpha'), []);

      const retry = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_confirmed' }),
      });
      assert.equal(retry.processed, 2, 'later drain should not be blocked by stale preclaimed leases');

      const firstRequest = await readDispatchRequest('alpha', first.request.request_id, cwd);
      const secondRequest = await readDispatchRequest('alpha', second.request.request_id, cwd);
      assert.equal(firstRequest?.status, 'notified');
      assert.equal(secondRequest?.status, 'notified');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('leaves unconfirmed injection as pending for retry (#391)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      // First tick: injector returns unconfirmed → should stay pending
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_unconfirmed' }),
      });
      assert.equal(result.processed, 0, 'unconfirmed should not count as processed');
      assert.ok(result.skipped >= 1, 'unconfirmed should be skipped for retry');
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending', 'status should remain pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks unconfirmed as failed after max attempts (#391)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const injector = async () => ({ ok: true, reason: 'tmux_send_keys_unconfirmed' });
      // Drain 3 times to exhaust max attempts (MAX_UNCONFIRMED_ATTEMPTS=3)
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      assert.equal(result.processed, 1, 'should transition to failed on 3rd attempt');
      assert.equal(result.failed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('confirmed injection marks notified immediately (#391)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_confirmed' }),
      });
      assert.equal(result.processed, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps retry_pending derived-only and does not persist transient tags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_unconfirmed' }),
      });

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
      assert.notEqual(request?.status, 'retry_pending');

      const rawRequests = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'alpha', 'dispatch', 'requests.json'), 'utf8'));
      const persisted = rawRequests.find((entry: { request_id?: string }) => entry?.request_id === queued.request.request_id);
      assert.ok(persisted);
      assert.equal(persisted.status, 'pending');
      assert.ok(!('retry_mode' in persisted), 'retry_mode must not be persisted');
      assert.ok(!('retry_tag' in persisted), 'retry_tag must not be persisted');
      assert.ok(!('status_tag' in persisted), 'status_tag must not be persisted');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retries submit with isolated named Enter and does not retype when trigger already present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureFile = join(cwd, 'capture.txt');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(captureFile, '... ping ...');
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_CAPTURE_FILE = captureFile;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 4242;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
      assert.equal(typeMatches.length, 1, 'fresh attempt should type once; retries with draft should be submit-only');
      const enterMatches = tmuxLog.match(/send-keys -t %42 Enter/g) || [];
      assert.ok(enterMatches.length > 0, 'submit should use the named Enter key');
      assert.ok(!/send-keys[^\n]*-l[^\n]*Enter/.test(tmuxLog), 'must not mix -l payload with Enter submit');

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.attempt_count, 2);
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_CAPTURE_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retypes on every retry when trigger is not in narrow input area', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureSeqFile = join(cwd, 'capture-seq.txt');
    const captureCounterFile = join(cwd, 'capture-seq.idx');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // Shared preflight now adds one 80-line capture per tick before the
      // narrow retry check. Pre-capture on retries still returns "ready"
      // (no trigger) so the request is retyped on every retry.
      await writeFile(captureSeqFile, [
        // tick1: 1 shared preflight + 3 verify rounds × 2 captures = 7
        'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
        // tick2: 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
        // tick3: 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
      ].join('\n'));
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_CAPTURE_SEQUENCE_FILE = captureSeqFile;
      process.env.OMX_TEST_CAPTURE_COUNTER_FILE = captureCounterFile;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 4242;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
      // With narrow capture, retypes on every retry when trigger is not in input area
      assert.equal(typeMatches.length, 3, 'should retype on every retry when trigger not in narrow capture (fresh + 2 retries)');

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_CAPTURE_SEQUENCE_FILE;
      delete process.env.OMX_TEST_CAPTURE_COUNTER_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not confirm when narrow misses but wide tail still has unsent trigger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureSeqFile = join(cwd, 'capture-seq.txt');
    const captureCounterFile = join(cwd, 'capture-seq.idx');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // Each verify round uses narrow + wide capture.
      // Narrow captures are whitespace-only (trigger absent), while wide captures
      // still include the trigger near tail => should remain unconfirmed.
      await writeFile(captureSeqFile, [
        '   ', 'ping',
        '   ', 'ping',
        '   ', 'ping',
      ].join('\n'));
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_CAPTURE_SEQUENCE_FILE = captureSeqFile;
      process.env.OMX_TEST_CAPTURE_COUNTER_FILE = captureCounterFile;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 4242;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.processed, 0, 'must not mark notified when wide tail still shows trigger');
      assert.ok(result.skipped >= 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_CAPTURE_SEQUENCE_FILE;
      delete process.env.OMX_TEST_CAPTURE_COUNTER_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not confirm while pane is still bootstrapping even when trigger is absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureSeqFile = join(cwd, 'capture-seq.txt');
    const captureCounterFile = join(cwd, 'capture-seq.idx');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // verify rounds: narrow capture empty, wide capture still loading.
      await writeFile(captureSeqFile, [
        '   ', 'model: loading',
        '   ', 'model: loading',
        '   ', 'model: loading',
      ].join('\n'));
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_CAPTURE_SEQUENCE_FILE = captureSeqFile;
      process.env.OMX_TEST_CAPTURE_COUNTER_FILE = captureCounterFile;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 4242;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.processed, 0);
      assert.ok(result.skipped >= 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_CAPTURE_SEQUENCE_FILE;
      delete process.env.OMX_TEST_CAPTURE_COUNTER_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applies per-issue cooldown to avoid repeated reinjection in one drain tick', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const previousIssueCooldown = process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
    try {
      process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = '900000';
      await initTeamState('alpha', 'task', 'executor', 2, cwd);
      const first = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: '› IND-123 only...',
      }, cwd);
      const second = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-2',
        worker_index: 2,
        trigger_message: 'IND-123 only...',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 1);
      assert.ok(result.skipped >= 1);

      const firstReq = await readDispatchRequest('alpha', first.request.request_id, cwd);
      const secondReq = await readDispatchRequest('alpha', second.request.request_id, cwd);
      assert.equal(firstReq?.status, 'notified');
      assert.equal(secondReq?.status, 'pending');
      assert.equal(secondReq?.attempt_count, 0);
    } finally {
      if (typeof previousIssueCooldown === 'string') process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = previousIssueCooldown;
      else delete process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips repeated same-issue reinjection during per-issue cooldown window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const previousCooldown = process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
    let injectCount = 0;
    try {
      process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = '900000';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const first = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'IND-123 only...',
      }, cwd);
      const second = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'IND-123 only: retry',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const injector = async () => {
        injectCount += 1;
        return { ok: true, reason: 'tmux_send_keys_unconfirmed' };
      };

      const firstTick = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      const secondTick = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });

      assert.equal(firstTick.processed, 0);
      assert.ok(firstTick.skipped >= 1);
      assert.equal(secondTick.processed, 0);
      assert.ok(secondTick.skipped >= 2);
      assert.equal(injectCount, 1, 'same issue should not be reinjected while cooldown is active');

      const firstRequest = await readDispatchRequest('alpha', first.request.request_id, cwd);
      const secondRequest = await readDispatchRequest('alpha', second.request.request_id, cwd);
      assert.equal(firstRequest?.status, 'pending');
      assert.equal(firstRequest?.attempt_count, 1);
      assert.equal(secondRequest?.status, 'pending');
      assert.equal(secondRequest?.attempt_count, 0, 'cooldown-blocked request should remain untouched');
    } finally {
      if (typeof previousCooldown === 'string') process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = previousCooldown;
      else delete process.env.OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('rejects a session-only dispatch target without an exact Team pane binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-session-target-'));
    const stateDir = join(cwd, '.omx', 'state');
    const logsDir = join(cwd, '.omx', 'logs');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const fakeBinDir = join(cwd, 'fake-bin');
    try {
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      await initTeamState('session-target-team', 'task', 'executor', 1, cwd);
      const cfg = await readTeamConfig('session-target-team', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.tmux_session = 'omx-team-session-target';
      cfg.leader_pane_id = '%42';
      if (Array.isArray(cfg.workers) && cfg.workers[0]) {
        delete cfg.workers[0].pane_id;
      }
      await saveTeamConfig(cfg, cwd);

      await enqueueDispatchRequest('session-target-team', {
        kind: 'nudge',
        to_worker: 'worker-1',
        trigger_message: 'dispatch ping',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const prevPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}:${prevPath || ''}`;
      try {
        await mod.drainPendingTeamDispatch({ cwd, stateDir, logsDir, maxPerTick: 5 });
      } finally {
        process.env.PATH = prevPath;
      }

      const requests = JSON.parse(await readFile(join(stateDir, 'team', 'session-target-team', 'dispatch', 'requests.json'), 'utf-8'));
      const request = requests.find((entry: { to_worker?: string }) => entry.to_worker === 'worker-1');
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'missing_tmux_target');
      assert.equal(await readFile(tmuxLogPath, 'utf-8').catch(() => ''), '');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid explicit pane proofs without resolving or targeting another pane', async () => {
    const scenarios = [
      ['similar', '%420\\t0\\t4200'],
      ['dead', '%42\\t1\\t4242'],
      ['missing', '__EMPTY__'],
      ['unavailable', 'malformed snapshot'],
    ] as const;

    for (const [name, snapshot] of scenarios) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-hook-exact-pane-${name}-`));
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const exactPaneSequencePath = join(cwd, 'exact-pane-sequence.txt');
      const previousPath = process.env.PATH;
      try {
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
        await chmod(join(fakeBinDir, 'tmux'), 0o755);
        await writeFile(exactPaneSequencePath, `${snapshot}\n`);
        process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
        process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE = exactPaneSequencePath;

        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const config = await readTeamConfig('alpha', cwd);
        assert.ok(config?.workers[0]);
        if (!config?.workers[0]) throw new Error('missing worker');
        config.workers[0].pane_id = '%42';
        config.workers[0].pid = 4242;
        bindCanonicalTeamPaneAuthority(config);
        await saveTeamConfig(config, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          pane_id: '%42',
          trigger_message: 'do not retarget this request',
        }, cwd);

        const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
        const mod = await import(pathToFileURL(modulePath).href);
        const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        assert.equal(result.failed, 1, `${name} proof should fail the request`);

        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'failed');
        assert.equal(request?.last_reason, 'exact_pane_unavailable');

        const tmuxLog = await readFile(tmuxLogPath, 'utf8');
        const commands = tmuxLog.trim().split('\n').filter(Boolean);
        assert.match(commands[0] || '', /^list-panes -a(?:\s|$)/, `${name} must prove the global pane first`);
        assert.doesNotMatch(tmuxLog, /display-message|capture-pane|send-keys|paste-buffer/);
        assert.doesNotMatch(tmuxLog, /list-panes -t /, `${name} must not use the session resolver fallback`);
        const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
        const dispatchLog = (await readFile(dispatchLogPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const failure = dispatchLog.find((entry) => entry.request_id === queued.request.request_id && entry.type === 'dispatch_failed');
        assert.equal(failure?.exact_pane_proof?.status, name === 'unavailable' ? 'unavailable' : 'gone');
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        delete process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE;
        delete process.env.OMX_TEST_EXACT_PANE_COUNTER_FILE;
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects a recycled configured worker pane before dispatch effects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-recycled-worker-pane-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const exactPaneSequencePath = join(cwd, 'exact-pane-sequence.txt');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(exactPaneSequencePath, '%42\t0\t4242\n');
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE = exactPaneSequencePath;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) return;
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 1111;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'must not reach recycled pane',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.failed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'exact_pane_unavailable');
      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.doesNotMatch(tmuxLog, /display-message|capture-pane|send-keys|paste-buffer|set-buffer/);
      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLog = (await readFile(dispatchLogPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const failure = dispatchLog.find((entry) => entry.request_id === queued.request.request_id && entry.type === 'dispatch_failed');
      assert.equal(failure?.exact_pane_proof?.reason, 'pane_pid_changed');
      assert.equal(failure?.exact_pane_proof?.expectedPid, 1111);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE;
      delete process.env.OMX_TEST_EXACT_PANE_COUNTER_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('stops explicit-pane dispatch after a later exact proof is lost', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-exact-pane-loss-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const exactPaneSequencePath = join(cwd, 'exact-pane-sequence.txt');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(exactPaneSequencePath, [
        '%42\t0\t4242', // readiness mode: initial PID proof
        '%42\t0\t4242', // readiness mode: final PID proof after owner read
        '%42\t0\t4242', // readiness start-command: initial PID proof
        '%42\t0\t4242', // readiness start-command: final PID proof after owner read
        '%42\t0\t4242', // readiness current-command: initial PID proof
        '%42\t0\t4242', // readiness current-command: final PID proof after owner read
        '%42\t0\t4242', // readiness capture: initial PID proof
        '%42\t0\t4242', // readiness capture: final PID proof after owner read
        '%42\t0\t4242', // readiness capture: initial PID proof
        '%42\t0\t4242', // readiness capture: final PID proof after owner read
        '%42\t0\t4242', // readiness capture: initial PID proof
        '%42\t0\t4242', // readiness capture: final PID proof after owner read
        '%42\t0\t4242', // send: initial identity proof before HUD guard
        '%42\t0\t4242', // send: final identity proof before HUD guard
        '%42\t0\t4242', // send: final identity proof after HUD guard
        '%42\t0\t4242', // send: initial proof before buffer setup
        '%42\t0\t4242', // send: final proof after HUD guard
        '%42\t0\t4242', // clear composer: initial PID proof before owner read
        '%42\t0\t4242', // clear composer: final PID proof after owner read
        '%42\t0\t4242', // clear composer: final PID proof after owner read
        '%42\t0\t4242', // paste buffer: initial PID proof before owner read
        '%42\t0\t4242', // paste buffer: final PID proof after owner read
        '%42\t0\t4242', // paste buffer verification: initial PID proof
        '%42\t0\t4242', // paste buffer verification: final PID proof after owner read
        '%42\t1\t4242', // paste buffer: final PID proof must block
      ].join('\n'));
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE = exactPaneSequencePath;

      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const config = await readTeamConfig('alpha', cwd);
      assert.ok(config?.workers[0]);
      if (!config?.workers[0]) throw new Error('missing worker');
      config.workers[0].pane_id = '%42';
      config.workers[0].pid = 4242;
      bindCanonicalTeamPaneAuthority(config);
      await saveTeamConfig(config, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        pane_id: '%42',
        trigger_message: 'stop after proof loss',
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      assert.equal(result.failed, 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'exact_pane_unavailable');

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const commands = tmuxLog.trim().split('\n').filter(Boolean);
      const exactGlobalPaneProof = /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/;
      assert.match(commands[0] || '', exactGlobalPaneProof);
      assert.match(tmuxLog, /send-keys -t %42 C-u/, 'the live proof should permit the clear effect');
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 (?:C-m|Enter)/);
      const ownerProof = 'show-option -qv -p -t %42 @omx_team_pane_owner_id';
      for (const [index, command] of commands.entries()) {
        if (!/^(send-keys|paste-buffer)\b/.test(command) || !command.includes('-t %42') || /^send-keys\b.*\s-l\s/.test(command)) continue;
        assert.match(commands[index - 1] || '', exactGlobalPaneProof, `final PID proof must immediately precede ${command}`);
        assert.equal(commands[index - 2], ownerProof, `owner proof must precede final PID proof for ${command}`);
        assert.match(commands[index - 3] || '', exactGlobalPaneProof, `initial PID proof must precede owner proof for ${command}`);
      }
      const lastProof = commands.map((command, index) => exactGlobalPaneProof.test(command) ? index : -1).filter((index) => index >= 0).at(-1);
      assert.notEqual(lastProof, undefined);
      const commandsAfterLostProof = commands.slice((lastProof || 0) + 1);
      assert.equal(commandsAfterLostProof.length, 1, 'only non-pane buffer cleanup may follow proof loss');
      assert.match(commandsAfterLostProof[0] || '', /^delete-buffer -b /);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      delete process.env.OMX_TEST_EXACT_PANE_SEQUENCE_FILE;
      delete process.env.OMX_TEST_EXACT_PANE_COUNTER_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips non-hook transport preferences in hook consumer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
        transport_preference: 'transport_direct',
        fallback_allowed: false,
      }, cwd);

      const modulePath = new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 0);
      assert.equal(result.failed, 0);
      assert.ok(result.skipped >= 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
