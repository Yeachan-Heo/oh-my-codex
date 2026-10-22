import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDefaultBridge, RuntimeBridge, type DispatchRecord, type RuntimeCommand } from '../../runtime/bridge.js';
import { drainPendingTeamDispatch } from '../../scripts/notify-hook/team-dispatch.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { queueDirectMailboxMessage } from '../mcp-comm.js';
import {
  enqueueDispatchRequest, initTeamState, listDispatchRequests, listMailboxMessages,
  markDispatchRequestNotified, readDispatchRequest, removeDispatchRequestsForWorkers,
  sendDirectMessage, teamEventLogPath, type TeamDispatchRequestInput,
} from '../state.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeBinary = process.env.OMX_RUNTIME_BINARY
  ?? join(repoRoot, 'target/debug', process.platform === 'win32' ? 'omx-runtime.exe' : 'omx-runtime');
const rootEnvKeys = ['OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_TEAM_WORKER',
  'OMX_TEAM_LEADER_CWD', 'OMX_SESSION_ID', 'CODEX_SESSION_ID', 'SESSION_ID', 'OMX_RUNTIME_BRIDGE', 'OMX_RUNTIME_BINARY'];

let savedEnv: ReadonlyArray<readonly [string, string | undefined]>;
beforeEach(() => {
  savedEnv = rootEnvKeys.map(key => [key, process.env[key]] as const);
  for (const key of rootEnvKeys) delete process.env[key];
  process.env.OMX_RUNTIME_BINARY = runtimeBinary;
});
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fixture(t: TestContext): Promise<string> {
  assert.ok(existsSync(runtimeBinary), 'Build the runtime with npm run build:runtime before running these tests.');
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'omx-delivery-recovery-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await initTeamState('recovery', 'delivery recovery', 'executor', 2, cwd);
  return cwd;
}

function inboxInput(): TeamDispatchRequestInput {
  return { kind: 'inbox', to_worker: 'worker-1', worker_index: 1,
    trigger_message: 'execute the assigned task', inbox_correlation_key: 'startup:worker-1' };
}

async function seedDispatch(cwd: string, requestId: string, teamName = 'recovery'): Promise<void> {
  const { to_worker, ...metadata } = inboxInput();
  getDefaultBridge(join(cwd, '.omx/state')).execCommand({ command: 'QueueDispatch',
    request_id: requestId, target: to_worker, metadata: { ...metadata, team_name: teamName } });
}

for (const status of ['pending', 'notified'] as const) {
  for (const reverse of [false, true]) {
    it(`retires a single ${status} mailbox wake after ${reverse ? 'reverse' : 'ordered'} acknowledgements`, async t => {
      const cwd = await fixture(t);
      const messages = await Promise.all(['first', 'second'].map(body =>
        sendDirectMessage('recovery', 'worker-1', 'worker-2', body, cwd)));
      const input = (messageId: string): TeamDispatchRequestInput => ({ kind: 'mailbox',
        to_worker: 'worker-2', worker_index: 2, message_id: messageId,
        trigger_message: 'check mailbox', intent: 'pending-mailbox-review' });
      const wake = await enqueueDispatchRequest('recovery', input(messages[0].message_id), cwd);
      assert.equal((await enqueueDispatchRequest('recovery', input(messages[1].message_id), cwd)).deduped, true);
      if (status === 'notified') await markDispatchRequestNotified('recovery', wake.request.request_id, {}, cwd);
      const order = reverse ? [...messages].reverse() : messages;
      for (const [index, message] of order.entries()) {
        const result = await executeTeamApiOperation('mailbox-mark-delivered', {
          team_name: 'recovery', worker: 'worker-2', message_id: message.message_id,
        }, cwd);
        assert.equal(result.ok, true);
        const current = await readDispatchRequest('recovery', wake.request.request_id, cwd);
        assert.equal(current?.status, index === 0 ? status : 'delivered');
      }
      const next = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'third', cwd);
      assert.equal((await enqueueDispatchRequest('recovery', input(next.message_id), cwd)).deduped, false);
      let injections = 0;
      await drainPendingTeamDispatch({ cwd, injector: async () => {
        injections += 1;
        return { ok: true, reason: 'confirmed', delivery_confirmed: true,
          pane: null, pane_source: null, readiness_evidence: null, pane_current_command: null,
          exact_pane_proof: null, tmux_injection_attempted: true };
      } });
      assert.equal(injections, 1);
    });
  }
}

it('does not retire a mailbox wake for an unknown acknowledgement', async t => {
  const cwd = await fixture(t);
  const message = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'pending', cwd);
  const wake = await enqueueDispatchRequest('recovery', { kind: 'mailbox', to_worker: 'worker-2',
    message_id: message.message_id, trigger_message: 'check mailbox' }, cwd);
  const result = await executeTeamApiOperation('mailbox-mark-delivered', {
    team_name: 'recovery', worker: 'worker-2', message_id: 'unknown-message',
  }, cwd);
  assert.ok(result.ok);
  assert.equal(result.data.updated, false);
  assert.equal(result.data.dispatch_updated, false);
  assert.equal((await readDispatchRequest('recovery', wake.request.request_id, cwd))?.status, 'pending');
});

for (const damaged of ['empty', 'missing'] as const) {
  it(`recovers a committed dispatch before retrying with a ${damaged} projection`, async t => {
    const cwd = await fixture(t);
    await seedDispatch(cwd, 'original');
    await seedDispatch(cwd, 'other-team', 'other');
    const path = join(cwd, '.omx/state/dispatch.json');
    if (damaged === 'empty') await writeFile(path, '{"records":[]}');
    else await unlink(path);
    const retry = await enqueueDispatchRequest('recovery', inboxInput(), cwd);
    assert.equal(retry.deduped, true);
    assert.equal(retry.request.request_id, 'original');
    assert.equal((await listDispatchRequests('recovery', cwd)).length, 1);
    assert.equal(getDefaultBridge(join(cwd, '.omx/state')).readDispatchRecordsStrict().length, 2);
  });

  it(`discovers worker dispatches behind a ${damaged} projection before retirement`, async t => {
    const cwd = await fixture(t);
    await seedDispatch(cwd, 'retire-me');
    await seedDispatch(cwd, 'preserve-other-team', 'other');
    const path = join(cwd, '.omx/state/dispatch.json');
    if (damaged === 'empty') await writeFile(path, '{"records":[]}');
    else await unlink(path);
    await removeDispatchRequestsForWorkers('recovery', ['worker-1'], cwd);
    const bridge = getDefaultBridge(join(cwd, '.omx/state'));
    bridge.execCommand({ command: 'CaptureSnapshot' });
    assert.deepEqual(bridge.readDispatchRecordsStrict().map(record => record.request_id), ['preserve-other-team']);
  });
}

it('does not coalesce new work into a stale pending projection of a delivered request', async t => {
  const cwd = await fixture(t);
  await seedDispatch(cwd, 'completed');
  const path = join(cwd, '.omx/state/dispatch.json');
  const stale = await readFile(path);
  const bridge = getDefaultBridge(join(cwd, '.omx/state'));
  bridge.execCommand({ command: 'MarkNotified', request_id: 'completed', channel: 'test' });
  bridge.execCommand({ command: 'MarkDelivered', request_id: 'completed' });
  await writeFile(path, stale);
  const queued = await enqueueDispatchRequest('recovery', inboxInput(), cwd);
  assert.equal(queued.deduped, false);
  assert.notEqual(queued.request.request_id, 'completed');
  assert.equal((await readDispatchRequest('recovery', 'completed', cwd))?.status, 'delivered');
});

it('retires worker requests from returned snapshots despite a replaced compatibility projection', async t => {
  const cwd = await fixture(t);
  await seedDispatch(cwd, 'retire-me');
  await seedDispatch(cwd, 'other-team', 'other');
  const path = join(cwd, '.omx/state/dispatch.json');
  const exec = RuntimeBridge.prototype.execCommand;
  const patched = t.mock.method(RuntimeBridge.prototype, 'execCommand', function (this: RuntimeBridge, command: RuntimeCommand) {
    const result = exec.call(this, command);
    if (command.command === 'CaptureSnapshot') writeFileSync(path, '{"records":[]}');
    return result;
  });
  await removeDispatchRequestsForWorkers('recovery', ['worker-1'], cwd);
  patched.mock.restore();
  const snapshot = getDefaultBridge(join(cwd, '.omx/state')).execCommand({ command: 'CaptureSnapshot' });
  assert.equal(snapshot.event, 'SnapshotCaptured');
  if (snapshot.event === 'SnapshotCaptured') {
    assert.deepEqual(snapshot.dispatch_records?.map(record => record.request_id), ['other-team']);
  }
});

it('does not create a new dispatch when committed state cannot be recovered', async t => {
  const cwd = await fixture(t);
  await seedDispatch(cwd, 'original');
  await writeFile(join(cwd, '.omx/state/dispatch.json'), '{"records":[]}');
  const eventsPath = join(cwd, '.omx/state/events.json');
  const requestsPath = join(cwd, '.omx/state/team/recovery/dispatch/requests.json');
  const before = await Promise.all([readFile(eventsPath), readFile(requestsPath)]);
  process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
  await assert.rejects(enqueueDispatchRequest('recovery', inboxInput(), cwd));
  assert.deepEqual(await Promise.all([readFile(eventsPath), readFile(requestsPath)]), before);
});

it('supports older snapshot responses without returned dispatch records', async t => {
  const cwd = await fixture(t);
  await seedDispatch(cwd, 'original');
  await seedDispatch(cwd, 'other-team', 'other');
  const exec = RuntimeBridge.prototype.execCommand;
  t.mock.method(RuntimeBridge.prototype, 'execCommand', function (this: RuntimeBridge, command: RuntimeCommand) {
    const result = exec.call(this, command);
    return command.command === 'CaptureSnapshot' ? { event: 'SnapshotCaptured' as const } : result;
  });
  const retry = await enqueueDispatchRequest('recovery', inboxInput(), cwd);
  assert.equal(retry.deduped, true);
  assert.equal(retry.request.request_id, 'original');
  await removeDispatchRequestsForWorkers('recovery', ['worker-1'], cwd);
  assert.deepEqual(getDefaultBridge(join(cwd, '.omx/state')).readDispatchRecordsStrict()
    .map(record => record.request_id), ['other-team']);
});

for (const invalid of ['row', 'null'] as const) {
  it(`rejects malformed returned records (${invalid}) before enqueue or worker retirement`, async t => {
    const cwd = await fixture(t);
    await seedDispatch(cwd, 'original');
    const eventsPath = join(cwd, '.omx/state/events.json');
    const before = await readFile(eventsPath);
    const exec = RuntimeBridge.prototype.execCommand;
    t.mock.method(RuntimeBridge.prototype, 'execCommand', function (this: RuntimeBridge, command: RuntimeCommand) {
      const result = exec.call(this, command);
      return command.command === 'CaptureSnapshot'
        ? { event: 'SnapshotCaptured' as const, dispatch_records: (invalid === 'null' ? null : [{}]) as unknown as DispatchRecord[] } : result;
    });
    await assert.rejects(enqueueDispatchRequest('recovery', inboxInput(), cwd), /invalid recovered dispatch records/);
    await assert.rejects(removeDispatchRequestsForWorkers('recovery', ['worker-1'], cwd), /rollback_discovery_failed/);
    assert.deepEqual(await readFile(eventsPath), before);
  });
}

it('retains rollback evidence after invalid removal verification and safely retries', async t => {
  const cwd = await fixture(t);
  const queued = await enqueueDispatchRequest('recovery', inboxInput(), cwd);
  await seedDispatch(cwd, 'other-team', 'other');
  const requestsPath = join(cwd, '.omx/state/team/recovery/dispatch/requests.json');
  const before = JSON.stringify([queued.request]);
  await writeFile(requestsPath, before);
  const exec = RuntimeBridge.prototype.execCommand;
  let snapshots = 0;
  const patched = t.mock.method(RuntimeBridge.prototype, 'execCommand', function (this: RuntimeBridge, command: RuntimeCommand) {
    const result = exec.call(this, command);
    return command.command === 'CaptureSnapshot' && ++snapshots === 2
      ? { event: 'SnapshotCaptured' as const, dispatch_records: [{} as DispatchRecord] } : result;
  });
  await assert.rejects(removeDispatchRequestsForWorkers('recovery', ['worker-1'], cwd), /rollback_verification_failed/);
  assert.equal(await readFile(requestsPath, 'utf8'), before);
  patched.mock.restore();
  await removeDispatchRequestsForWorkers('recovery', ['worker-1'], cwd);
  assert.deepEqual(JSON.parse(await readFile(requestsPath, 'utf8')), []);
  assert.deepEqual(getDefaultBridge(join(cwd, '.omx/state')).readDispatchRecordsStrict()
    .map(record => record.request_id), ['other-team']);
});

for (const sendFirst of [false, true]) {
  it(`keeps unread work covered when send and acknowledgement race (send first: ${sendFirst})`, async t => {
    const cwd = await fixture(t);
    const send = (body: string) => queueDirectMailboxMessage({ teamName: 'recovery', cwd,
      fromWorker: 'worker-1', toWorker: 'worker-2', body, triggerMessage: 'check mailbox',
      notify: async () => ({ ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }) });
    const first = await send('first');
    assert.ok(first.request_id);
    await markDispatchRequestNotified('recovery', first.request_id, {}, cwd);
    const acknowledge = () => executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: 'recovery', worker: 'worker-2', message_id: first.message_id,
    }, cwd);
    const results = await Promise.all(sendFirst ? [send('second'), acknowledge()] : [acknowledge(), send('second')]);
    assert.ok(results.every(result => result.ok || ('reason' in result && result.reason === 'duplicate_pending_dispatch_request')));
    assert.equal((await listMailboxMessages('recovery', 'worker-2', cwd)).filter(message => !message.delivered_at).length, 1);
    const active = (await listDispatchRequests('recovery', cwd)).filter(request =>
      request.status === 'pending' || request.status === 'notified');
    assert.equal(active.length, 1);
  });
}

for (const contents of ['{"messages":[', '{"worker":"other","messages":[]}', 'null']) {
  it(`preserves a damaged fallback mailbox (${contents}) when a new send is attempted`, async t => {
    const cwd = await fixture(t);
    process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
    const original = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'original', cwd);
    const path = join(cwd, '.omx/state/team/recovery/mailbox/worker-2.json');
    await writeFile(path, contents);
    const eventsBefore = await readFile(teamEventLogPath('recovery', cwd), 'utf8');
    assert.ok(eventsBefore.includes(original.message_id));
    await assert.rejects(sendDirectMessage('recovery', 'worker-1', 'worker-2', 'new', cwd));
    assert.equal(await readFile(path, 'utf8'), contents);
    assert.equal(await readFile(teamEventLogPath('recovery', cwd), 'utf8'), eventsBefore);
  });
}

it('preserves unread fallback messages after a mailbox permission error', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const cwd = await fixture(t);
  process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
  const original = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'original', cwd);
  const path = join(cwd, '.omx/state/team/recovery/mailbox/worker-2.json');
  const before = await readFile(path, 'utf8');
  await chmod(path, 0o000);
  try {
    await assert.rejects(sendDirectMessage('recovery', 'worker-1', 'worker-2', 'new', cwd),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES');
  } finally {
    await chmod(path, 0o600);
  }
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await listMailboxMessages('recovery', 'worker-2', cwd))[0]?.message_id, original.message_id);
});
