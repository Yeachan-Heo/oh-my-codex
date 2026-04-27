import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

  it('invokes omx-runtime exec via shared bridge fallback', async () => {
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
  printf '{"schema_version":1,"commands":["acquire-authority","renew-authority","queue-dispatch","mark-notified","mark-delivered","mark-failed","request-replay","capture-snapshot"],"events":[],"transport":"tmux"}\n'
  exit 0
fi
if [[ "\${1:-}" == "exec" ]]; then
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
      assert.match(runtimeLog, /^exec \{"command":"MarkNotified"/m);

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
      assert.equal(mailbox.length, 1);
      assert.ok(mailbox[0]?.notified_at, 'expected canonical bridge mailbox record to gain notified_at');
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


  it('logs structured evidence when bridge dispatch compat cannot be parsed and legacy requests are used', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);
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
if [[ "\${1:-}" == "exec" ]]; then
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
      assert.match(tmuxLog, /send-keys -t %99/);
      assert.match(tmuxLog, /mailbox\/leader-fixed\.json; worker-1 sent a new message/);
      assert.doesNotMatch(tmuxLog, /send-keys -t .*devsess/);
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('leader-fixed dispatch prefers the canonical codex pane over a stale HUD leader pane id', async () => {
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
    echo "node dist/cli/omx.js hud --watch"
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
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf "%%42\\t1\\tnode\\tcodex\\n%%91\\t0\\tnode\\tnode dist/cli/omx.js hud --watch\\n"
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
      assert.match(tmuxLog, /send-keys -t %42/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %91/);
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
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf "%%77\\t1\\tcodex\\tcodex\\n"
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

  it('retries submit with isolated C-m and does not retype when trigger already present', async () => {
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
      const cmMatches = tmuxLog.match(/send-keys -t %42 C-m/g) || [];
      assert.ok(cmMatches.length > 0, 'submit should use C-m');
      assert.ok(!/send-keys[^\n]*-l[^\n]*C-m/.test(tmuxLog), 'must not mix -l payload with C-m submit');

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


  it('resolves session-only dispatch targets without managed leader session context', async () => {
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
      assert.notEqual(request?.status, 'failed');
      assert.doesNotMatch(JSON.stringify(request), /target_resolution_failed/);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /list-panes -t omx-team-session-target/);
      assert.match(tmuxLog, /send-keys -t %42 -l dispatch ping/);
    } finally {
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
