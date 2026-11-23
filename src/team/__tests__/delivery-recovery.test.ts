import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDefaultBridge, RuntimeBridge, type DispatchRecord, type RuntimeCommand } from '../../runtime/bridge.js';
import { drainPendingTeamDispatch } from '../../scripts/notify-hook/team-dispatch.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { queueDirectMailboxMessage } from '../mcp-comm.js';
import { readTeamConfig, readTeamManifestV2, saveTeamConfig } from '../state.js';
import {
  enqueueDispatchRequest, initTeamState, listDispatchRequests, listMailboxMessages,
  markDispatchRequestNotified, readDispatchRequest, readMonitorSnapshot, removeDispatchRequestsForWorkers,
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

async function fixtureWithLiveWorkers(t: TestContext): Promise<{ cwd: string; workers: ReturnType<typeof spawn>[] }> {
  const cwd = await fixture(t);
  const workers: ReturnType<typeof spawn>[] = [];
  
  // Create live worker processes (sleepers that stay alive)
  for (let i = 0; i < 2; i++) {
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
    workers.push(worker);
  }
  
  // Update config to use prompt mode with live worker PIDs
  const config = await readTeamConfig('recovery', cwd);
  assert.ok(config);
  config.worker_launch_mode = 'prompt';
  config.workers[0]!.pid = workers[0]!.pid;
  config.workers[1]!.pid = workers[1]!.pid;
  await saveTeamConfig(config, cwd);
  
  // Update manifest to match
  const manifestPath = join(cwd, '.omx', 'state', 'team', 'recovery', 'manifest.v2.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
  manifest.policy = { ...(manifest.policy || {}), worker_launch_mode: 'prompt' };
  manifest.workers[0].pid = workers[0]!.pid;
  manifest.workers[1].pid = workers[1]!.pid;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  
  // Cleanup workers after test
  t.after(async () => {
    for (const worker of workers) {
      try { worker.kill('SIGKILL'); } catch {}
    }
  });
  
  return { cwd, workers };
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

it('does not enqueue stale wakes when monitor and acknowledgement race', async t => {
  const cwd = await fixture(t);
  // Send a message that the monitor will find unnotified.
  const message = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'unnotified', cwd);
  assert.ok(!message.notified_at);
  // Create a dispatch request for this message (simulating monitor's enqueue).
  const pending = await enqueueDispatchRequest('recovery', {
    kind: 'mailbox',
    to_worker: 'worker-2',
    worker_index: 2,
    message_id: message.message_id,
    trigger_message: 'check mailbox',
    intent: 'pending-mailbox-review',
  }, cwd);
  assert.equal(pending.deduped, false);
  await markDispatchRequestNotified('recovery', pending.request.request_id, {}, cwd);
  // Now acknowledge the message (what the worker does).
  const ackResult = await executeTeamApiOperation('mailbox-mark-delivered', {
    team_name: 'recovery',
    worker: 'worker-2',
    message_id: message.message_id,
  }, cwd);
  assert.equal(ackResult.ok, true);
  assert.equal(ackResult.data.dispatch_updated, true);
  // The dispatch request should be marked as delivered.
  const updated = await readDispatchRequest('recovery', pending.request.request_id, cwd);
  assert.equal(updated?.status, 'delivered');
  // Send a new message to verify it doesn't get coalesced into stale wakes.
  const second = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'second', cwd);
  const secondPending = await enqueueDispatchRequest('recovery', {
    kind: 'mailbox',
    to_worker: 'worker-2',
    worker_index: 2,
    message_id: second.message_id,
    trigger_message: 'check mailbox',
    intent: 'pending-mailbox-review',
  }, cwd);
  // The second message should create a new dispatch request, not coalesce into the old one.
  assert.equal(secondPending.deduped, false);
  // Verify no stale wakes remain: we should have exactly one pending dispatch (for the new message).
  const active = (await listDispatchRequests('recovery', cwd)).filter(r => r.status === 'pending' || r.status === 'notified');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.message_id, second.message_id);
});

it('enqueue inside barrier after final re-validation prevents stale wakes', async t => {
  const { cwd } = await fixtureWithLiveWorkers(t);
  // Set up a scenario where an ack lands between Phase 1 discovery and Phase 1.5 enqueue.
  // Send an unnotified message.
  const message = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'unnotified', cwd);
  assert.ok(!message.notified_at);
  
  // Use the test hook to inject an ack after Phase 1 (discovery) completes but before Phase 1.5 enqueue.
  // This simulates an ack arriving between Phase 1 discovery and Phase 1.5 enqueue/re-validation.
  let hookInvoked = false;
  const { setMailboxDeliveryAfterPhase1HookForTest } = await import('../runtime.js');
  setMailboxDeliveryAfterPhase1HookForTest(async (teamName: string, cwd: string) => {
    hookInvoked = true;
    // Acknowledge the message after Phase 1 discovery but before Phase 1.5 enqueue.
    // The Phase 1.5 re-validation should catch this and skip the enqueue.
    await executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: teamName,
      worker: 'worker-2',
      message_id: message.message_id,
    }, cwd);
  });
  
  try {
    // Call monitorTeam to trigger Phase 1 discovery, Phase 1.5 re-validation (with hook running), and potential enqueue.
    // The Phase 1.5 re-validation should catch that the message was delivered by the hook and skip the enqueue.
    await (await import('../runtime.js')).monitorTeam('recovery', cwd);
    assert.equal(hookInvoked, true, 'test hook should have been invoked');
    
    // Verify that the hook's acknowledgement took effect.
    const mailbox = await listMailboxMessages('recovery', 'worker-2', cwd);
    const msgAfterMonitor = mailbox.find(m => m.message_id === message.message_id);
    assert.ok(msgAfterMonitor?.delivered_at, 'message should have delivered_at set after hook ack');
    
    // Verify that Phase 1.5 re-validation prevented the enqueue of the now-delivered message.
    // No dispatch request should exist for this message after monitorTeam.
    const dispatchRequests = (await listDispatchRequests('recovery', cwd))
      .filter(r => r.message_id === message.message_id && (r.status === 'pending' || r.status === 'notified'));
    assert.equal(dispatchRequests.length, 0, 'Phase 1.5 re-validation should have prevented enqueue of already-delivered message');
  } finally {
    // Clean up: clear the test hook.
    setMailboxDeliveryAfterPhase1HookForTest(null);
  }
});

it('skips notification after intervening acknowledgement in transport_direct', async t => {
  const { cwd } = await fixtureWithLiveWorkers(t);
  // Set up a team with transport_direct mode to test the direct notification path.
  const config = await readTeamConfig('recovery', cwd);
  assert.ok(config);
  const manifestPath = join(cwd, '.omx', 'state', 'team', 'recovery', 'manifest.v2.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
  manifest.policy = { ...(manifest.policy || {}), dispatch_mode: 'transport_direct' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  
  // Send an unnotified message.
  const message = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'test-msg', cwd);
  assert.ok(!message.notified_at);
  
  // Use the hook to acknowledge the message after Phase 1 but before Phase 1.5 enqueue.
  let hookInvoked = false;
  const { setMailboxDeliveryAfterPhase1HookForTest } = await import('../runtime.js');
  setMailboxDeliveryAfterPhase1HookForTest(async (teamName: string, cwd: string) => {
    hookInvoked = true;
    // Acknowledge after Phase 1 but before enqueue.
    await executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: teamName,
      worker: 'worker-2',
      message_id: message.message_id,
    }, cwd);
  });
  
  try {
    // Call monitorTeam. The re-validation should prevent the enqueue, so no notification should be sent.
    await (await import('../runtime.js')).monitorTeam('recovery', cwd);
    assert.equal(hookInvoked, true, 'test hook should have been invoked');
    
    // Verify that no dispatch request was created (Phase 1.5 re-validation prevented it).
    const dispatchRequests = (await listDispatchRequests('recovery', cwd))
      .filter(r => r.message_id === message.message_id && (r.status === 'pending' || r.status === 'notified'));
    assert.equal(dispatchRequests.length, 0, 'Phase 1.5 re-validation should have prevented enqueue');
    
    // Verify that the message is marked as delivered.
    const mailbox = await listMailboxMessages('recovery', 'worker-2', cwd);
    const msgAfter = mailbox.find(m => m.message_id === message.message_id);
    assert.ok(msgAfter?.delivered_at, 'message should be marked as delivered');
  } finally {
    setMailboxDeliveryAfterPhase1HookForTest(null);
  }
});

it('does not mark message notified when dispatch snapshot is corrupted during finalization', async t => {
  const { cwd } = await fixtureWithLiveWorkers(t);
  
  // Set up a team with transport_direct mode to test the direct notification path.
  const config = await readTeamConfig('recovery', cwd);
  assert.ok(config);
  const manifestPath = join(cwd, '.omx', 'state', 'team', 'recovery', 'manifest.v2.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
  manifest.policy = { ...(manifest.policy || {}), dispatch_mode: 'transport_direct' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  
  // Disable the runtime bridge to ensure there's no authoritative fallback.
  // This forces readDispatchRequests to rely on the local shadow, so corruption causes real failure.
  // Set to '0' (the recognized disabled value) since isBridgeEnabled() returns true for all other values.
  process.env.OMX_RUNTIME_BRIDGE = '0';
  t.after(() => {
    delete process.env.OMX_RUNTIME_BRIDGE;
  });
  
  // Send an unnotified message.
  const message = await sendDirectMessage('recovery', 'worker-1', 'worker-2', 'test-msg', cwd);
  assert.ok(!message.notified_at, 'message should start unnotified');
  
  // Use the hook to corrupt the dispatch snapshot after Phase 1.5 enqueue.
  let hookInvoked = false;
  let requestsPath = '';
  let originalContent = '';
  const { setMailboxDeliveryAfterEnqueueHookForTest } = await import('../runtime.js');
  setMailboxDeliveryAfterEnqueueHookForTest(async (teamName: string, cwd: string) => {
    hookInvoked = true;
    // Corrupt the snapshot after Phase 1.5 enqueue but before Phase 2 finalization.
    // This allows the test to exercise the finalization code path that handles corrupted snapshots.
    requestsPath = join(cwd, '.omx', 'state', 'team', teamName, 'dispatch', 'requests.json');
    originalContent = await readFile(requestsPath, 'utf8');
    await writeFile(requestsPath, '{invalid json');
  });
  
  try {
    // Call monitorTeam. The dispatch will be enqueued in Phase 1.5, and then the hook
    // will corrupt the snapshot. The finalization will see a corrupted snapshot and 
    // should return a retryable failure. This means the message should NOT be marked as notified.
    const { monitorTeam } = await import('../runtime.js');
    await monitorTeam('recovery', cwd);
    assert.equal(hookInvoked, true, 'test hook should have been invoked');
    
    // Verify that the message is NOT marked as notified (snapshot corruption should prevent it).
    const mailbox = await listMailboxMessages('recovery', 'worker-2', cwd);
    const msgAfter = mailbox.find(m => m.message_id === message.message_id);
    assert.ok(!msgAfter?.notified_at, 'message should NOT be marked notified when dispatch snapshot is corrupted');
    
    // Verify that the monitor snapshot does not have a notification record for this message.
    const snapshot = await readMonitorSnapshot('recovery', cwd);
    assert.ok(snapshot, 'monitor snapshot should exist');
    const hasNotificationRecord = message.message_id in snapshot.mailboxNotifiedByMessageId;
    assert.ok(!hasNotificationRecord, 'monitor snapshot should not have notification record for corrupted dispatch');
  } finally {
    setMailboxDeliveryAfterEnqueueHookForTest(null);
    // Restore the snapshot for cleanup
    if (originalContent && requestsPath) {
      try {
        await writeFile(requestsPath, originalContent);
      } catch {}
    }
  }
});
