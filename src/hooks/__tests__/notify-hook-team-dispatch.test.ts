import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initTeamState,
  enqueueDispatchRequest,
  readDispatchRequest,
  listMailboxMessages,
  sendDirectMessage,
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

describe('notify-hook team dispatch consumer', () => {
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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
      assert.ok(mailbox[0]?.notified_at);
    } finally {
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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
      const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
      assert.ok(mailbox[0]?.notified_at);
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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

  it('allows exactly one retry fallback retype when retry pre-capture is missing trigger', async () => {
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
      await writeFile(captureSeqFile, [
        'ping', 'ping', 'ping', // tick1 verify rounds => unconfirmed
        'ready', // tick2 pre-capture => fallback retype eligible
        'ping', 'ping', 'ping', // tick2 verify => still unconfirmed
        'ready', // tick3 pre-capture => no more fallback retype (attempt>=2)
        'ping', 'ping', 'ping', // tick3 verify => fail at max retries
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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
      const mod = await import(pathToFileURL(modulePath).href);
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
      assert.equal(typeMatches.length, 2, 'should allow one fallback retry retype total (fresh + one retry)');

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

      const modulePath = new URL('../../../scripts/notify-hook/team-dispatch.js', import.meta.url).pathname;
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
