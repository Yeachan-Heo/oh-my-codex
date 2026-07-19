import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile, readFile, mkdir, open, rename, utimes, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  ABSOLUTE_MAX_WORKERS,
  DEFAULT_MAX_WORKERS,
  cleanupTeamState,
  createTask,
  claimTask,
  computeTaskReadiness,
  getTeamSummary,
  initTeamState,
  listTasks,
  migrateV1ToV2,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  recoverTeamMembershipTaskTransaction,
  commitTeamMembershipTaskTransaction,
  withTeamTaskBarrier,
  readTeamManifestV2,
  transitionTaskStatus,
  releaseTaskClaim,
  reclaimExpiredTaskClaim,
  sendDirectMessage,
  broadcastMessage,
  markMessageDelivered,
  markMessageNotified,
  listMailboxMessages,
  writeTaskApproval,
  readTaskApproval,
  readWorkerHeartbeat,
  readWorkerStatus,
  updateTask,
  updateWorkerHeartbeat,
  writeAtomic,
  setWriteAtomicRenameForTests,
  resetWriteAtomicRenameForTests,
  setWriteAtomicOpenForTests,
  resetWriteAtomicOpenForTests,
  setWriteAtomicPlatformForTests,
  resetWriteAtomicPlatformForTests,
  writeWorkerInbox,
  enqueueDispatchRequest,
  listDispatchRequests,
  markDispatchRequestNotified,
  markDispatchRequestDelivered,
  transitionDispatchRequest,
  readDispatchRequest,
  readMonitorSnapshot,
  resolveDispatchLockTimeoutMs,
  writeTeamManifestV2,
  removeDispatchRequestsForWorkers,
  withScalingLock,

} from '../state.js';
import { normalizeDispatchRequest } from '../state/dispatch.js';
import { claimTask as claimTaskWithDeps } from '../state/tasks.js';
import { withScalingLock as withScalingLeaseLock, withTeamLock } from '../state/locks.js';
import type { TeamTaskV2 } from '../state/types.js';
import type { TeamReminderIntent } from '../reminder-intents.js';


const ORIGINAL_OMX_TEAM_STATE_ROOT = process.env.OMX_TEAM_STATE_ROOT;

beforeEach(() => {
  delete process.env.OMX_TEAM_STATE_ROOT;
});

afterEach(() => {
  resetWriteAtomicRenameForTests();
  resetWriteAtomicOpenForTests();
  resetWriteAtomicPlatformForTests();
  if (typeof ORIGINAL_OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = ORIGINAL_OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;
});

async function writeCompatRuntimeFixture(runtimePath: string, runtimeLogPath: string): Promise<void> {
  await writeFile(
    runtimePath,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(runtimeLogPath)}, argv.join(' ') + '\\n');

function argValue(prefix) {
  const entry = argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function stateDir() {
  return argValue('--state-dir=') || process.cwd();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n');
}

function nowIso() {
  return new Date().toISOString();
}

if (argv[0] === 'schema') {
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    commands: [
      'acquire-authority',
      'renew-authority',
      'queue-dispatch',
      'mark-notified',
      'mark-delivered',
      'mark-failed',
      'request-replay',
      'remove-dispatch-records',

      'capture-snapshot',
    ],
    events: [],
    transport: 'tmux',
  }) + '\\n');
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
  case 'QueueDispatch': {
    dispatch.records.push({
      request_id: command.request_id,
      target: command.target,
      status: 'pending',
      created_at: timestamp,
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: command.metadata ?? null,
    });
    writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'DispatchQueued', request_id: command.request_id, target: command.target, metadata: command.metadata ?? null }) + '\\n');
    process.exit(0);
  }
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
  case 'RemoveDispatchRecords': {
    const ids = new Set(command.request_ids || []);
    if (process.env.OMX_TEST_ACK_RETAIN_DISPATCH !== '1') {
      dispatch.records = dispatch.records.filter((entry) => !ids.has(entry.request_id));
      writeJson(dispatchPath, dispatch);
    }
    process.stdout.write(JSON.stringify({ event: 'DispatchRecordsRemoved', request_ids: command.request_ids || [] }) + '\\n');
    process.exit(0);
  }
  case 'CaptureSnapshot': {
    if (process.env.OMX_TEST_SKIP_SNAPSHOT_COMPAT_WRITE !== '1') writeJson(dispatchPath, dispatch);
    process.stdout.write(JSON.stringify({ event: 'SnapshotCaptured' }) + '\\n');
    process.exit(0);
  }

  case 'CreateMailboxMessage': {
    mailbox.records.push({
      message_id: command.message_id,
      from_worker: command.from_worker,
      to_worker: command.to_worker,
      body: command.body,
      created_at: timestamp,
      notified_at: null,
      delivered_at: null,
    });
    writeJson(mailboxPath, mailbox);
    process.stdout.write(JSON.stringify({ event: 'MailboxMessageCreated', message_id: command.message_id, from_worker: command.from_worker, to_worker: command.to_worker }) + '\\n');
    process.exit(0);
  }
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
    process.exit(1);
}
`,
  );
  await chmod(runtimePath, 0o755);
}

describe('team state', () => {
  it('initTeamState creates correct directory structure and config.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const cfg = await initTeamState('team-1', 'do stuff', 'executor', 2, cwd);

      const root = join(cwd, '.omx', 'state', 'team', 'team-1');
      assert.equal(existsSync(root), true);
      assert.equal(existsSync(join(root, 'workers')), true);
      assert.equal(existsSync(join(root, 'workers', 'worker-1')), true);
      assert.equal(existsSync(join(root, 'workers', 'worker-2')), true);
      assert.equal(existsSync(join(root, 'tasks')), true);
      assert.equal(existsSync(join(root, 'claims')), true);
      assert.equal(existsSync(join(root, 'mailbox')), true);
      assert.equal(existsSync(join(root, 'events')), true);
      assert.equal(existsSync(join(root, 'manifest.v2.json')), true);

      const configPath = join(root, 'config.json');
      assert.equal(existsSync(configPath), true);
      const diskCfg = JSON.parse(readFileSync(configPath, 'utf8')) as unknown as { [key: string]: unknown };

      assert.equal(cfg.name, 'team-1');
      assert.equal(diskCfg.name, 'team-1');
      assert.equal(diskCfg.task, 'do stuff');
      assert.equal(diskCfg.agent_type, 'executor');
      assert.equal(diskCfg.worker_count, 2);
      assert.equal(diskCfg.max_workers, DEFAULT_MAX_WORKERS);
      assert.equal(diskCfg.tmux_session, 'omx-team-team-1');
      assert.equal(diskCfg.lifecycle_profile, 'default');
      assert.equal(diskCfg.leader_pane_id, null);
      assert.equal(diskCfg.leader_pane_pid, null);
      assert.equal(diskCfg.hud_pane_pid, null);
      assert.equal(diskCfg.hud_pane_id, null);
      assert.equal(diskCfg.resize_hook_name, null);
      assert.equal(diskCfg.resize_hook_target, null);
      assert.equal(typeof diskCfg.next_task_id, 'number');
      assert.ok(Array.isArray(diskCfg.workers));
      assert.equal(diskCfg.workers.length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a stale full config save without overwriting a newer canonical generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-config-generation-'));
    try {
      await initTeamState('team-generation', 'generation test', 'executor', 1, cwd);
      const first = await readTeamConfig('team-generation', cwd);
      const stale = await readTeamConfig('team-generation', cwd);
      assert.ok(first);
      assert.ok(stale);
      if (!first || !stale) throw new Error('missing config');
      first.task = 'newer canonical value';
      await saveTeamConfig(first, cwd);
      stale.task = 'stale overwrite';
      await assert.rejects(() => saveTeamConfig(stale, cwd), /team_config_stale_generation:team-generation:0:1/);
      assert.equal((await readTeamConfig('team-generation', cwd))?.task, 'newer canonical value');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers an interrupted config-first save to one old generation before exposing state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-config-pair-recovery-'));
    try {
      const teamName = 'config-pair-recovery';
      await initTeamState(teamName, 'old task', 'executor', 1, cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
      const manifestPath = join(teamRoot, 'manifest.v2.json');
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) throw new Error('missing config');
      config.task = 'new task';

      setWriteAtomicRenameForTests(async (from, to) => {
        if (to === manifestPath) throw new Error('injected_manifest_publish_failure');
        await rename(from, to);
      });
      await assert.rejects(() => saveTeamConfig(config, cwd), /injected_manifest_publish_failure/);
      assert.equal(existsSync(join(teamRoot, '.membership-task-transaction.json')), true);

      resetWriteAtomicRenameForTests();
      const [recoveredConfig, recoveredManifest] = await Promise.all([
        readTeamConfig(teamName, cwd),
        readTeamManifestV2(teamName, cwd),
      ]);
      assert.equal(recoveredConfig?.task, 'old task');
      assert.equal(recoveredConfig?.config_generation ?? 0, 0);
      assert.equal(recoveredManifest?.task, 'old task');
      assert.equal(recoveredManifest?.config_generation ?? 0, 0);
      assert.equal(existsSync(join(teamRoot, '.membership-task-transaction.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a stale membership transaction without overwriting the accepted generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-membership-generation-'));
    try {
      await initTeamState('membership-generation', 'generation test', 'executor', 1, cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'membership-generation');
      const [oldConfig, oldManifest] = await Promise.all([
        readFile(join(teamRoot, 'config.json'), 'utf8'),
        readFile(join(teamRoot, 'manifest.v2.json'), 'utf8'),
      ]);
      const accepted = await readTeamConfig('membership-generation', cwd);
      assert.ok(accepted);
      if (!accepted) throw new Error('missing config');
      accepted.task = 'accepted update';
      await saveTeamConfig(accepted, cwd);
      const staleConfig = { ...JSON.parse(oldConfig) as object, worker_count: 0, workers: [] };
      const staleManifest = { ...JSON.parse(oldManifest) as object, worker_count: 0, workers: [] };
      await assert.rejects(
        withTeamTaskBarrier('membership-generation', cwd, () => commitTeamMembershipTaskTransaction('membership-generation', cwd, {
          baseGeneration: 0,
          tasks: [],
          config: { oldBytes: oldConfig, newBytes: JSON.stringify(staleConfig, null, 2) },
          manifest: { oldBytes: oldManifest, newBytes: JSON.stringify(staleManifest, null, 2) },
        })),
        /team_membership_stale_generation:membership-generation:0:1/,
      );
      const [config, manifest] = await Promise.all([
        readTeamConfig('membership-generation', cwd),
        readTeamManifestV2('membership-generation', cwd),
      ]);
      assert.equal(config?.task, 'accepted update');
      assert.equal(config?.config_generation, 1);
      assert.equal(manifest?.config_generation, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent scale and shutdown membership generations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-membership-concurrent-generation-'));
    try {
      await initTeamState('membership-concurrent', 'generation test', 'executor', 1, cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'membership-concurrent');
      const [oldConfig, oldManifest] = await Promise.all([
        readFile(join(teamRoot, 'config.json'), 'utf8'),
        readFile(join(teamRoot, 'manifest.v2.json'), 'utf8'),
      ]);
      const commit = (task: string) => withTeamTaskBarrier('membership-concurrent', cwd, () =>
        commitTeamMembershipTaskTransaction('membership-concurrent', cwd, {
          baseGeneration: 0,
          tasks: [],
          config: { oldBytes: oldConfig, newBytes: JSON.stringify({ ...JSON.parse(oldConfig) as object, task }, null, 2) },
          manifest: { oldBytes: oldManifest, newBytes: JSON.stringify({ ...JSON.parse(oldManifest) as object, task }, null, 2) },
        }),
      );
      const results = await Promise.allSettled([commit('scale update'), commit('shutdown update')]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const [config, manifest] = await Promise.all([
        readTeamConfig('membership-concurrent', cwd),
        readTeamManifestV2('membership-concurrent', cwd),
      ]);
      assert.equal(config?.config_generation, 1);
      assert.equal(manifest?.config_generation, 1);
      assert.ok(config?.task === 'scale update' || config?.task === 'shutdown update');
      assert.equal(manifest?.task, config?.task);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState persists the default lifecycle profile', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-lifecycle-profile-'));
    try {
      const cfg = await initTeamState(
        'team-linked',
        'do stuff',
        'executor',
        1,
        cwd,
        DEFAULT_MAX_WORKERS,
        process.env,
        {},
        'default',
      );

      assert.equal(cfg.lifecycle_profile, 'default');
      const readCfg = await readTeamConfig('team-linked', cwd);
      const manifest = await readTeamManifestV2('team-linked', cwd);
      assert.equal(readCfg?.lifecycle_profile, 'default');
      assert.equal(manifest?.lifecycle_profile, 'default');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('migrateV1ToV2 writes manifest.v2.json idempotently from legacy config.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-migrate-'));
    try {
      await initTeamState('team-mig', 't', 'executor', 1, cwd);

      // Simulate a legacy team by removing v2 manifest.
      const root = join(cwd, '.omx', 'state', 'team', 'team-mig');
      await rm(join(root, 'manifest.v2.json'), { force: true });

      const m1 = await migrateV1ToV2('team-mig', cwd);
      assert.ok(m1);
      const onDisk1 = await readTeamManifestV2('team-mig', cwd);
      assert.ok(onDisk1);
      assert.equal(onDisk1?.lifecycle_profile, 'default');

      const m2 = await migrateV1ToV2('team-mig', cwd);
      assert.deepEqual(m2, onDisk1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves missing or blank tmux pane owner ids as unavailable in legacy manifests', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-pane-owner-unavailable-'));
    try {
      await initTeamState('team-pane-owner-unavailable', 't', 'executor', 1, cwd);
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-pane-owner-unavailable', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      delete manifest.tmux_pane_owner_id;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const loadedManifest = await readTeamManifestV2('team-pane-owner-unavailable', cwd);
      const loadedConfig = await readTeamConfig('team-pane-owner-unavailable', cwd);
      assert.equal(loadedManifest?.tmux_pane_owner_id, undefined);
      assert.equal(loadedConfig?.tmux_pane_owner_id, undefined);

      await writeTeamManifestV2({
        ...loadedManifest!,
        tmux_pane_owner_id: '   ',
      }, cwd);

      const blankNormalized = await readTeamManifestV2('team-pane-owner-unavailable', cwd);
      assert.equal(blankNormalized?.tmux_pane_owner_id, undefined);
      const persisted = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      assert.equal(persisted.tmux_pane_owner_id, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('normalizes legacy manifest policy with dispatch defaults, timeout bounds, and governance split', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-manifest-policy-'));
    try {
      await initTeamState('team-policy', 't', 'executor', 1, cwd);
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-policy', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const policy = (manifest.policy ?? {}) as Record<string, unknown>;
      delete policy.dispatch_mode;
      policy.dispatch_ack_timeout_ms = 999_999;
      policy.delegation_only = true;
      policy.nested_teams_allowed = true;
      policy.cleanup_requires_all_workers_inactive = false;
      policy.team_decomposition = { decomposition_source: 'dag_sidecar' };
      manifest.policy = policy;
      delete manifest.governance;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const loaded = await readTeamManifestV2('team-policy', cwd);
      assert.equal(loaded?.policy.dispatch_mode, 'hook_preferred_with_fallback');
      assert.equal(loaded?.policy.dispatch_ack_timeout_ms, 10_000);
      assert.equal(loaded?.governance.delegation_only, true);
      assert.equal(loaded?.governance.nested_teams_allowed, true);
      assert.equal(loaded?.governance.cleanup_requires_all_workers_inactive, false);
      assert.equal('delegation_only' in (loaded?.policy ?? {}), false);
      assert.equal('nested_teams_allowed' in (loaded?.policy ?? {}), false);
      assert.equal('cleanup_requires_all_workers_inactive' in (loaded?.policy ?? {}), false);
      assert.equal('team_decomposition' in (loaded?.policy ?? {}), false);
      assert.deepEqual(loaded?.team_decomposition, { decomposition_source: 'dag_sidecar' });

      const freshCwd = await mkdtemp(join(tmpdir(), 'omx-team-manifest-policy-default-'));
      try {
        await initTeamState('team-policy-default', 't', 'executor', 1, freshCwd);
        const fresh = await readTeamManifestV2('team-policy-default', freshCwd);
        assert.equal(fresh?.policy.dispatch_ack_timeout_ms, 2_000);
        assert.equal(fresh?.governance.cleanup_requires_all_workers_inactive, true);

        const freshManifestPath = join(freshCwd, '.omx', 'state', 'team', 'team-policy-default', 'manifest.v2.json');
        const persisted = JSON.parse(await readFile(freshManifestPath, 'utf8')) as {
          policy?: Record<string, unknown>;
          governance?: Record<string, unknown>;
        };
        assert.equal('delegation_only' in (persisted.policy ?? {}), false);
        assert.equal(persisted.governance?.delegation_only, false);
      } finally {
        await rm(freshCwd, { recursive: true, force: true });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('dispatch bridge queue uses the same request id as the TS store', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-bridge-sync-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    try {
      await initTeamState('team-dispatch-sync', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'dispatch.json'), JSON.stringify({ records: [] }));
      await writeFile(
        join(fakeBinDir, 'omx-runtime'),
        `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "${runtimeLogPath}"
if [[ "\${1:-}" == "schema" ]]; then
  printf '{"schema_version":1,"commands":["acquire-authority","renew-authority","queue-dispatch","mark-notified","mark-delivered","mark-failed","remove-dispatch-records","request-replay","capture-snapshot"],"events":[],"transport":"tmux"}\n'
  exit 0
fi
if [[ "\${1:-}" == "exec" ]]; then
  if [[ "$*" == *'"command":"CaptureSnapshot"'* ]]; then
    printf '{"event":"SnapshotCaptured"}\n'
  else
    printf '{"event":"DispatchQueued","request_id":"ok","target":"worker-1"}\n'
  fi
  exit 0
fi
exit 1
`,
      );
      await chmod(join(fakeBinDir, 'omx-runtime'), 0o755);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');

      const queued = await enqueueDispatchRequest(
        'team-dispatch-sync',
        {
          kind: 'inbox',
          to_worker: 'worker-1',
          trigger_message: 'ping',
          intent: 'followup-relaunch',
        },
        cwd,
      );

      const runtimeLog = await readFile(runtimeLogPath, 'utf8');
      const queueLine = runtimeLog.split('\n').find((line) => line.startsWith('exec {"command":"QueueDispatch"'));
      assert.ok(queueLine, 'expected QueueDispatch bridge call');
      const jsonStart = queueLine.indexOf('{');
      const stateDirFlag = queueLine.lastIndexOf(' --state-dir=');
      const jsonPayload = stateDirFlag > jsonStart ? queueLine.slice(jsonStart, stateDirFlag) : queueLine.slice(jsonStart);
      const payload = JSON.parse(jsonPayload) as { request_id: string; metadata?: { intent?: string } };
      assert.equal(payload.request_id, queued.request.request_id);
      assert.equal(payload.metadata?.intent, 'followup-relaunch');
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('coalesces mailbox wakes only for an exact target proof and releases on acknowledgement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-store-'));
    try {
      await initTeamState('team-dispatch', 't', 'executor', 2, cwd);
      await initTeamState('team-dispatch-other', 't', 'executor', 1, cwd);
      const input = (to_worker: string, message_id: string, pane_id = 'pane-1', intent: TeamReminderIntent = 'pending-mailbox-review') => ({
        kind: 'mailbox' as const,
        to_worker,
        pane_id,
        message_id,
        trigger_message: 'check mailbox',
        intent,
      });
      const first = await enqueueDispatchRequest('team-dispatch', input('worker-1', 'msg-1'), cwd);
      const pendingSibling = await enqueueDispatchRequest('team-dispatch', input('worker-1', 'msg-2'), cwd);
      assert.equal(pendingSibling.deduped, true);
      assert.equal(pendingSibling.request.request_id, first.request.request_id);

      const notified = await markDispatchRequestNotified('team-dispatch', first.request.request_id, {}, cwd);
      assert.equal(notified?.status, 'notified');
      const notifiedSibling = await enqueueDispatchRequest('team-dispatch', input('worker-1', 'msg-3'), cwd);
      assert.equal(notifiedSibling.deduped, true);
      assert.equal(notifiedSibling.request.request_id, first.request.request_id);

      const differentWorker = await enqueueDispatchRequest('team-dispatch', input('worker-2', 'msg-4'), cwd);
      const differentPane = await enqueueDispatchRequest('team-dispatch', input('worker-1', 'msg-5', 'pane-2'), cwd);
      const differentIntent = await enqueueDispatchRequest('team-dispatch', input('worker-1', 'msg-6', 'pane-1', 'followup-relaunch'), cwd);
      const differentTeam = await enqueueDispatchRequest('team-dispatch-other', input('worker-1', 'msg-7'), cwd);
      assert.equal(differentWorker.deduped, false);
      assert.equal(differentPane.deduped, false);
      assert.equal(differentIntent.deduped, false);
      assert.equal(differentTeam.deduped, false);

      const delivered = await markDispatchRequestDelivered('team-dispatch', first.request.request_id, {}, cwd);
      assert.equal(delivered?.status, 'delivered');
      const successor = await enqueueDispatchRequest('team-dispatch', input('worker-1', 'msg-8'), cwd);
      assert.equal(successor.deduped, false);
      assert.notEqual(successor.request.request_id, first.request.request_id);

      const listed = await listDispatchRequests('team-dispatch', cwd, { kind: 'mailbox' });
      assert.equal(listed.length, 5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prefers bridge-authored dispatch records without mutating the legacy requests file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-bridge-authority-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    try {
      await initTeamState('team-dispatch-bridge-authority', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');

      const legacyPath = join(cwd, '.omx', 'state', 'team', 'team-dispatch-bridge-authority', 'dispatch', 'requests.json');
      const before = await readFile(legacyPath, 'utf8');
      assert.equal(JSON.parse(before).length, 0);

      const queued = await enqueueDispatchRequest(
        'team-dispatch-bridge-authority',
        {
          kind: 'mailbox',
          to_worker: 'worker-1',
          message_id: 'bridge-msg-1',
          trigger_message: 'check mailbox',
        },
        cwd,
      );

      const requests = await listDispatchRequests('team-dispatch-bridge-authority', cwd);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.request_id, queued.request.request_id);
      assert.equal(requests[0]?.message_id, 'bridge-msg-1');

      await markDispatchRequestNotified('team-dispatch-bridge-authority', queued.request.request_id, {}, cwd);
      await markDispatchRequestDelivered('team-dispatch-bridge-authority', queued.request.request_id, {}, cwd);
      const delivered = await readDispatchRequest('team-dispatch-bridge-authority', queued.request.request_id, cwd);
      assert.equal(delivered?.status, 'delivered');

      const after = await readFile(legacyPath, 'utf8');
      assert.deepEqual(JSON.parse(after), [], 'bridge-success path should not rewrite legacy dispatch requests.json');
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves legacy rollback evidence when authoritative dispatch absence verification is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-authority-unavailable-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousSkipSnapshotWrite = process.env.OMX_TEST_SKIP_SNAPSHOT_COMPAT_WRITE;
    try {
      const teamName = 'dispatch-unavailable';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      await mkdir(fakeBinDir, { recursive: true });
      const runtimePath = join(fakeBinDir, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_SKIP_SNAPSHOT_COMPAT_WRITE = '1';
      const legacyPath = join(cwd, '.omx', 'state', 'team', teamName, 'dispatch', 'requests.json');
      const legacyBytes = JSON.stringify([{
        request_id: 'legacy-preserved',
        kind: 'inbox',
        team_name: teamName,
        to_worker: 'worker-1',
        trigger_message: 'preserve rollback evidence',
        transport_preference: 'hook_preferred_with_fallback',
        fallback_allowed: true,
        status: 'pending',
        attempt_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }], null, 2);
      await writeFile(legacyPath, legacyBytes);
      const dispatchPath = join(cwd, '.omx', 'state', 'dispatch.json');

      const unavailableFixtures: Array<() => Promise<void>> = [
        async () => { await rm(dispatchPath, { recursive: true, force: true }); },
        async () => { await rm(dispatchPath, { recursive: true, force: true }); await writeFile(dispatchPath, '{'); },
        async () => { await rm(dispatchPath, { recursive: true, force: true }); await writeFile(dispatchPath, JSON.stringify({ records: [{}] })); },
        async () => { await rm(dispatchPath, { recursive: true, force: true }); await mkdir(dispatchPath); },
      ];
      for (const arrange of unavailableFixtures) {
        await arrange();
        await assert.rejects(() => removeDispatchRequestsForWorkers(teamName, ['worker-1'], cwd), /dispatch compatibility output/);
        assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes);
      }
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      if (typeof previousSkipSnapshotWrite === 'string') process.env.OMX_TEST_SKIP_SNAPSHOT_COMPAT_WRITE = previousSkipSnapshotWrite;
      else delete process.env.OMX_TEST_SKIP_SNAPSHOT_COMPAT_WRITE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('scopes bridge rollback IDs to the target team legacy file and preserves same-target foreign records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-rollback-scope-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;

    try {
      await initTeamState('team-rollback-a', 't', 'executor', 1, cwd);
      await initTeamState('team-rollback-b', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';


      process.env.OMX_RUNTIME_BRIDGE = '0';
      const scopedRequest = await enqueueDispatchRequest('team-rollback-a', {
        kind: 'inbox',
        to_worker: 'worker-1',
        trigger_message: 'rollback scoped request',
      }, cwd);
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const teamRoot = join(cwd, '.omx', 'state', 'team');
      const legacyPath = join(teamRoot, 'team-rollback-a', 'dispatch', 'requests.json');
      const rootDispatchPath = join(cwd, '.omx', 'state', 'dispatch.json');
      const scopedRequestId = scopedRequest.request.request_id;
      await writeFile(rootDispatchPath, JSON.stringify({ records: [
        { request_id: scopedRequestId, target: 'worker-1', status: 'pending', created_at: new Date().toISOString(), notified_at: null, delivered_at: null, failed_at: null, reason: null, metadata: { team_name: 'team-rollback-a' } },
        { request_id: 'team-b-worker-1', target: 'worker-1', status: 'pending', created_at: new Date().toISOString(), notified_at: null, delivered_at: null, failed_at: null, reason: null, metadata: { team_name: 'team-rollback-b' } },
        { request_id: 'unscoped-worker-1', target: 'worker-1', status: 'pending', created_at: new Date().toISOString(), notified_at: null, delivered_at: null, failed_at: null, reason: null, metadata: null },
      ] }, null, 2));

      await removeDispatchRequestsForWorkers('team-rollback-a', ['worker-1'], cwd);

      assert.deepEqual(JSON.parse(await readFile(legacyPath, 'utf8')), []);
      const runtimeLog = await readFile(runtimeLogPath, 'utf8');
      const removalLine = runtimeLog.split('\n').find((line) => line.startsWith('exec {"command":"RemoveDispatchRecords"'));
      assert.ok(removalLine);
      const removalPayload = JSON.parse(removalLine.slice(removalLine.indexOf('{'), removalLine.lastIndexOf(' --state-dir='))) as { request_ids: string[] };
      assert.deepEqual(removalPayload.request_ids, [scopedRequestId]);
      assert.match(runtimeLog, /CaptureSnapshot/);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves malformed legacy rollback evidence byte-for-byte', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-legacy-malformed-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const teamName = 'dispatch-legacy-malformed';
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const legacyPath = join(cwd, '.omx', 'state', 'team', teamName, 'dispatch', 'requests.json');
      const legacyBytes = '{\n  "records": "not-an-array"\n}\n';
      await writeFile(legacyPath, legacyBytes);

      await assert.rejects(
        () => removeDispatchRequestsForWorkers(teamName, ['worker-1'], cwd),
        /legacy dispatch rollback evidence is malformed or unrecognized/,
      );
      assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes);
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an acknowledged retained dispatch ID even when its scope fields changed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-retained-id-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousAckRetain = process.env.OMX_TEST_ACK_RETAIN_DISPATCH;
    try {
      const teamName = 'dispatch-retained-id';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      await mkdir(fakeBinDir, { recursive: true });
      const runtimePath = join(fakeBinDir, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '0';
      const queued = await enqueueDispatchRequest(teamName, {
        kind: 'inbox',
        to_worker: 'worker-1',
        trigger_message: 'remove by exact ID',
      }, cwd);
      const legacyPath = join(cwd, '.omx', 'state', 'team', teamName, 'dispatch', 'requests.json');
      const legacyBytes = await readFile(legacyPath, 'utf8');
      const dispatchPath = join(cwd, '.omx', 'state', 'dispatch.json');
      await writeFile(dispatchPath, JSON.stringify({ records: [{
        request_id: queued.request.request_id,
        target: 'worker-renamed',
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
        notified_at: null,
        delivered_at: null,
        failed_at: null,
        reason: null,
        metadata: { team_name: 'different-team' },
      }] }, null, 2));
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_ACK_RETAIN_DISPATCH = '1';

      await assert.rejects(
        () => removeDispatchRequestsForWorkers(teamName, ['worker-1'], cwd),
        /authoritative_dispatch_rollback_verification_failed/,
      );
      assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      if (typeof previousAckRetain === 'string') process.env.OMX_TEST_ACK_RETAIN_DISPATCH = previousAckRetain;
      else delete process.env.OMX_TEST_ACK_RETAIN_DISPATCH;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('dispatch request store keeps failed requests failed while allowing reason patches', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-store-failed-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('team-dispatch-failed', 't', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest(
        'team-dispatch-failed',
        {
          kind: 'inbox',
          to_worker: 'worker-1',
          trigger_message: 'ping',
        },
        cwd,
      );
      await transitionDispatchRequest(
        'team-dispatch-failed',
        queued.request.request_id,
        'pending',
        'failed',
        { last_reason: 'initial_failure' },
        cwd,
      );

      const recovered = await markDispatchRequestNotified(
        'team-dispatch-failed',
        queued.request.request_id,
        { last_reason: 'fallback_confirmed:tmux_send_keys_sent', failed_at: undefined },
        cwd,
      );
      assert.equal(recovered, null);

      const patched = await transitionDispatchRequest(
        'team-dispatch-failed',
        queued.request.request_id,
        'failed',
        'failed',
        { last_reason: 'fallback_confirmed_after_failed_receipt:tmux_send_keys_sent' },
        cwd,
      );
      assert.equal(patched?.status, 'failed');
      assert.equal(patched?.last_reason, 'fallback_confirmed_after_failed_receipt:tmux_send_keys_sent');
      const reread = await readDispatchRequest('team-dispatch-failed', queued.request.request_id, cwd);
      assert.equal(reread?.status, 'failed');
      assert.equal(reread?.failed_at, patched?.failed_at);
      assert.equal(reread?.last_reason, 'fallback_confirmed_after_failed_receipt:tmux_send_keys_sent');
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState persists workspace metadata to config + manifest', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-metadata-'));
    try {
      const cfg = await initTeamState(
        'team-meta',
        't',
        'executor',
        1,
        cwd,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: '/tmp/leader',
          team_state_root: '/tmp/leader/.omx/state',
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: false, name: 'feature/team-meta' },
        },
      );
      assert.equal(cfg.leader_cwd, '/tmp/leader');
      assert.equal(cfg.team_state_root, '/tmp/leader/.omx/state');
      assert.equal(cfg.workspace_mode, 'worktree');
      assert.deepEqual(cfg.worktree_mode, { enabled: true, detached: false, name: 'feature/team-meta' });

      const manifest = await readTeamManifestV2('team-meta', cwd);
      assert.ok(manifest);
      assert.equal(manifest?.leader_cwd, '/tmp/leader');
      assert.equal(manifest?.team_state_root, '/tmp/leader/.omx/state');
      assert.equal(manifest?.workspace_mode, 'worktree');
      assert.deepEqual(manifest?.worktree_mode, { enabled: true, detached: false, name: 'feature/team-meta' });
      assert.equal(manifest?.lifecycle_profile, 'default');
      assert.equal(manifest?.leader_pane_id, null);
      assert.equal(manifest?.leader_pane_pid, null);
      assert.equal(manifest?.hud_pane_pid, null);
      assert.equal(manifest?.hud_pane_id, null);
      assert.equal(manifest?.resize_hook_name, null);
      assert.equal(manifest?.resize_hook_target, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves task/mailbox/approval paths under explicit OMX_TEAM_STATE_ROOT from a worker cwd (worker-env contamination regression)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-team-explicit-root-'));
    const leaderCwd = join(root, 'leader');
    const workerCwd = join(root, 'worker-worktree');
    const explicitStateRoot = join(leaderCwd, '.omx', 'state');
    const prevRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await mkdir(leaderCwd, { recursive: true });
      await mkdir(workerCwd, { recursive: true });
      await initTeamState('team-explicit-root', 't', 'executor', 1, leaderCwd);
      process.env.OMX_TEAM_STATE_ROOT = explicitStateRoot;

      const task = await createTask(
        'team-explicit-root',
        { subject: 'explicit root task', description: 'regression guard', status: 'pending' },
        workerCwd,
      );
      const claim = await claimTask('team-explicit-root', task.id, 'worker-1', task.version ?? 1, workerCwd);
      assert.equal(claim.ok, true);

      await sendDirectMessage('team-explicit-root', 'worker-1', 'leader-fixed', 'hello from worker cwd', workerCwd);
      const messages = await listMailboxMessages('team-explicit-root', 'leader-fixed', workerCwd);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.body, 'hello from worker cwd');

      const approvalRecord = {
        task_id: task.id,
        required: true,
        status: 'approved' as const,
        reviewer: 'leader-fixed',
        decision_reason: 'path guard uses resolved team state root',
        decided_at: new Date().toISOString(),
      };
      await writeTaskApproval('team-explicit-root', approvalRecord, workerCwd);
      const approval = await readTaskApproval('team-explicit-root', task.id, workerCwd);
      assert.equal(approval?.status, 'approved');
      assert.equal(approval?.reviewer, 'leader-fixed');

      const explicitTeamRoot = join(explicitStateRoot, 'team', 'team-explicit-root');
      assert.equal(existsSync(join(explicitTeamRoot, 'tasks', `task-${task.id}.json`)), true);
      assert.equal(existsSync(join(explicitTeamRoot, 'mailbox', 'leader-fixed.json')), true);
      assert.equal(existsSync(join(explicitTeamRoot, 'approvals', `task-${task.id}.json`)), true);
      assert.equal(existsSync(join(workerCwd, '.omx', 'state', 'team', 'team-explicit-root')), false);
    } finally {
      if (typeof prevRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('claimTask enforces dependency readiness (blocked_dependency)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-'));
    try {
      await initTeamState('team-deps', 't', 'executor', 1, cwd);
      const dep = await createTask('team-deps', { subject: 'dep', description: 'd', status: 'pending' }, cwd);
      const t = await createTask(
        'team-deps',
        { subject: 'main', description: 'd', status: 'pending', depends_on: [dep.id] },
        cwd
      );

      const readiness = await computeTaskReadiness('team-deps', t.id, cwd);
      assert.equal(readiness.ready, false);

      const claim = await claimTask('team-deps', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, false);
      assert.equal(claim.ok ? 'x' : claim.error, 'blocked_dependency');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask rejects in-progress claim takeover when expectedVersion is null (issue-172)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-inprogress-'));
    try {
      await initTeamState('team-claim-inprogress', 't', 'executor', 2, cwd);
      const t = await createTask('team-claim-inprogress', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      // worker-1 claims the task successfully
      const claim1 = await claimTask('team-claim-inprogress', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim1.ok, true);

      // worker-2 tries to steal the claim with no expectedVersion (null) — must fail
      const steal = await claimTask('team-claim-inprogress', t.id, 'worker-2', null, cwd);
      assert.equal(steal.ok, false);
      assert.equal(steal.ok ? 'x' : steal.error, 'claim_conflict');

      // Verify worker-1 still owns the task
      const task = await readTask('team-claim-inprogress', t.id, cwd);
      assert.equal(task?.owner, 'worker-1');
      assert.equal(task?.status, 'in_progress');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask rejects in-progress claim takeover even with a matching version', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-inprogress-ver-'));
    try {
      await initTeamState('team-claim-inprogress-ver', 't', 'executor', 2, cwd);
      const t = await createTask('team-claim-inprogress-ver', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      // worker-1 claims the task, advancing version to 2
      const claim1 = await claimTask('team-claim-inprogress-ver', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim1.ok, true);
      const claimedVersion = claim1.ok ? claim1.task.version : 0;

      // worker-2 tries to steal using the current (post-claim) version — must still fail
      const steal = await claimTask('team-claim-inprogress-ver', t.id, 'worker-2', claimedVersion, cwd);
      assert.equal(steal.ok, false);
      assert.equal(steal.ok ? 'x' : steal.error, 'claim_conflict');

      const task = await readTask('team-claim-inprogress-ver', t.id, cwd);
      assert.equal(task?.owner, 'worker-1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask claim locking yields deterministic claim_conflict', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-lock-'));
    try {
      // Use 2 workers so both claimants are registered in the team.
      await initTeamState('team-lock', 't', 'executor', 2, cwd);
      const t = await createTask('team-lock', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      // Both try to claim based on the same expected version; only one should succeed.
      const [c1, c2] = await Promise.all([
        claimTask('team-lock', t.id, 'worker-1', t.version ?? 1, cwd),
        claimTask('team-lock', t.id, 'worker-2', t.version ?? 1, cwd),
      ]);

      const oks = [c1, c2].filter((c) => c.ok).length;
      const conflicts = [c1, c2].filter((c) => !c.ok && c.error === 'claim_conflict').length;
      assert.equal(oks, 1);
      assert.equal(conflicts, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask revalidates a stale member under its claim lock when expectedVersion is null', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-member-boundary-'));
    try {
      const teamName = 'team-claim-member-boundary';
      await initTeamState(teamName, 't', 'executor', 2, cwd);
      const task = await createTask(teamName, { subject: 'a', description: 'd', status: 'pending' }, cwd);

      const claim = await claimTaskWithDeps(task.id, 'worker-2', null, {
        teamName,
        cwd,
        readTask,
        readTeamConfig,
        withTaskClaimLock: async (_teamName, _taskId, _cwd, fn) => {
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
          await saveTeamConfig(config, cwd);
          return { ok: true, value: await fn() };
        },
        normalizeTask: (current) => current as TeamTaskV2,
        isTerminalTaskStatus: (status) => status === 'completed' || status === 'failed',
        taskFilePath: (_teamName, taskId, _cwd) => join(cwd, '.omx', 'state', 'team', teamName, 'tasks', `task-${taskId}.json`),
        writeAtomic,
      });

      assert.deepEqual(claim, { ok: false, error: 'worker_not_found' });
      const persisted = await readTask(teamName, task.id, cwd);
      assert.equal(persisted?.status, 'pending');
      assert.equal(persisted?.owner, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask rejects a removed worker for a task created after the scale-down snapshot', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-post-snapshot-'));
    try {
      const teamName = 'team-claim-post-snapshot';
      await initTeamState(teamName, 't', 'executor', 2, cwd);
      const scaleDownSnapshot = await readTeamConfig(teamName, cwd);
      assert.ok(scaleDownSnapshot?.workers.some((worker) => worker.name === 'worker-2'));
      const postSnapshotTask = await createTask(teamName, { subject: 'post snapshot', description: 'd', status: 'pending' }, cwd);

      const claim = await claimTaskWithDeps(postSnapshotTask.id, 'worker-2', null, {
        teamName,
        cwd,
        readTask,
        readTeamConfig,
        withTaskClaimLock: async (_teamName, _taskId, _cwd, fn) => {
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
          await saveTeamConfig(config, cwd);
          return { ok: true, value: await fn() };
        },
        normalizeTask: (current) => current as TeamTaskV2,
        isTerminalTaskStatus: (status) => status === 'completed' || status === 'failed',
        taskFilePath: (_teamName, taskId, _cwd) => join(cwd, '.omx', 'state', 'team', teamName, 'tasks', `task-${taskId}.json`),
        writeAtomic,
      });

      assert.deepEqual(claim, { ok: false, error: 'worker_not_found' });
      const persisted = await readTask(teamName, postSnapshotTask.id, cwd);
      assert.equal(persisted?.status, 'pending');
      assert.equal(persisted?.owner, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask recovers a stale task claim lock and proceeds', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-stale-lock-'));
    try {
      await initTeamState('team-stale-lock', 't', 'executor', 1, cwd);
      const t = await createTask('team-stale-lock', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      const staleLockDir = join(cwd, '.omx', 'state', 'team', 'team-stale-lock', 'claims', `task-${t.id}.lock`);
      await mkdir(staleLockDir, { recursive: true });
      await writeFile(join(staleLockDir, 'owner'), 'stale-owner');
      const staleTs = new Date(Date.now() - 10 * 60_000);
      await utimes(staleLockDir, staleTs, staleTs);

      const claim = await claimTask('team-stale-lock', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask owner write failure cleans up claim lock without orphan lock dir', { concurrency: false }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-owner-write-fail-'));
    let previousUmask: number | null = null;
    try {
      await initTeamState('team-owner-write-fail', 't', 'executor', 1, cwd);
      const t = await createTask('team-owner-write-fail', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      previousUmask = process.umask(0o222);
      const probeDir = join(cwd, 'claim-lock-permission-probe');
      await mkdir(probeDir);
      try {
        await writeFile(join(probeDir, 'owner'), 'probe');
        // Root and some permissive filesystems can still write through the
        // umask-created non-writable directory, so this failure mode cannot be
        // exercised deterministically in that environment.
        return;
      } catch {
        // Expected on normal non-root POSIX filesystems; continue with the
        // claim-lock cleanup assertion below.
      } finally {
        await rm(probeDir, { recursive: true, force: true });
      }

      await assert.rejects(
        () => claimTask('team-owner-write-fail', t.id, 'worker-1', t.version ?? 1, cwd),
        /(EACCES|EPERM|permission denied)/i,
      );

      const lockDir = join(cwd, '.omx', 'state', 'team', 'team-owner-write-fail', 'claims', `task-${t.id}.lock`);
      assert.equal(existsSync(lockDir), false);
    } finally {
      if (typeof previousUmask === 'number') process.umask(previousUmask);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask rejects a pending task with residual owner/claim metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-residual-claim-'));
    try {
      await initTeamState('team-claim-residual', 't', 'executor', 1, cwd);
      const t = await createTask('team-claim-residual', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-claim-residual', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.owner = 'worker-1';
      current.claim = {
        owner: 'worker-1',
        token: 'stale-token',
        leased_until: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      const claim = await claimTask('team-claim-residual', t.id, 'worker-1', null, cwd);
      assert.equal(claim.ok, false);
      assert.equal(claim.ok ? 'x' : claim.error, 'claim_conflict');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask allows a worker to claim its own pre-assigned pending task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-assigned-owner-'));
    try {
      await initTeamState('team-claim-assigned-owner', 't', 'executor', 2, cwd);
      const t = await createTask(
        'team-claim-assigned-owner',
        { subject: 'a', description: 'd', status: 'pending', owner: 'worker-1' },
        cwd,
      );

      const claim = await claimTask('team-claim-assigned-owner', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;
      assert.equal(claim.task.status, 'in_progress');
      assert.equal(claim.task.owner, 'worker-1');
      assert.ok(claim.task.claim);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask rejects pending task pre-assigned to a different worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-owner-mismatch-'));
    try {
      await initTeamState('team-claim-owner-mismatch', 't', 'executor', 2, cwd);
      const t = await createTask(
        'team-claim-owner-mismatch',
        { subject: 'a', description: 'd', status: 'pending', owner: 'worker-1' },
        cwd,
      );

      const claim = await claimTask('team-claim-owner-mismatch', t.id, 'worker-2', t.version ?? 1, cwd);
      assert.equal(claim.ok, false);
      assert.equal(claim.ok ? 'x' : claim.error, 'claim_conflict');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus returns invalid_transition for illegal transition', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-transition-'));
    try {
      await initTeamState('team-trans', 't', 'executor', 1, cwd);
      const t = await createTask('team-trans', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-trans', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const bad = await transitionTaskStatus('team-trans', t.id, 'pending', 'completed', claim.claimToken, cwd);
      assert.equal(bad.ok, false);
      assert.equal(bad.ok ? 'x' : bad.error, 'invalid_transition');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus rejects non-terminal transitions from in_progress', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-transition-nonterminal-'));
    try {
      await initTeamState('team-trans-nonterminal', 't', 'executor', 1, cwd);
      const t = await createTask('team-trans-nonterminal', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-trans-nonterminal', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const bad = await transitionTaskStatus('team-trans-nonterminal', t.id, 'in_progress', 'pending', claim.claimToken, cwd);
      assert.equal(bad.ok, false);
      assert.equal(bad.ok ? 'x' : bad.error, 'invalid_transition');

      const reread = await readTask('team-trans-nonterminal', t.id, cwd);
      assert.equal(reread?.status, 'in_progress');
      assert.equal(reread?.owner, 'worker-1');
      assert.ok(reread?.claim);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus returns claim_conflict when claim owner diverges from task owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-transition-owner-diverge-'));
    try {
      await initTeamState('team-trans-owner-diverge', 't', 'executor', 2, cwd);
      const t = await createTask('team-trans-owner-diverge', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-trans-owner-diverge', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-trans-owner-diverge', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.owner = 'worker-2';
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      const result = await transitionTaskStatus('team-trans-owner-diverge', t.id, 'in_progress', 'completed', claim.claimToken, cwd);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? 'x' : result.error, 'claim_conflict');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus appends task_completed event when task completes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-events-'));
    try {
      await initTeamState('team-events', 't', 'executor', 1, cwd);
      const t = await createTask('team-events', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-events', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      const token = claim.ok ? claim.claimToken : 'x';

      const tr = await transitionTaskStatus('team-events', t.id, 'in_progress', 'completed', token, cwd);
      assert.equal(tr.ok, true);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-events', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      assert.match(content, /\"type\":\"task_completed\"/);
      assert.match(content, new RegExp(`\"task_id\":\"${t.id}\"`));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus rejects broad delegated completion without spawn evidence or skip reason', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-delegation-evidence-'));
    try {
      await initTeamState('team-delegation-evidence', 't', 'executor', 1, cwd);
      const t = await createTask('team-delegation-evidence', {
        subject: 'Investigate flaky runtime behavior',
        description: 'Search runtime and debug flaky assignment behavior',
        status: 'pending',
        delegation: {
          mode: 'auto',
          required_parallel_probe: true,
          skip_allowed_reason_required: true,
        },
      }, cwd);
      const claim = await claimTask('team-delegation-evidence', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const missing = await transitionTaskStatus(
        'team-delegation-evidence',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        { result: 'Verification:\nPASS - focused regression' },
      );

      assert.equal(missing.ok, false);
      assert.equal(missing.ok ? 'x' : missing.error, 'missing_delegation_compliance_evidence');
      const reread = await readTask('team-delegation-evidence', t.id, cwd);
      assert.equal(reread?.status, 'in_progress');

      const completedWithSpawnEvidence = await transitionTaskStatus(
        'team-delegation-evidence',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        {
          result: [
            'Verification:',
            'PASS - focused regression',
            'Subagent spawn evidence: spawned 2 native subagents for runtime map and test probe',
          ].join('\n'),
        },
      );
      assert.equal(completedWithSpawnEvidence.ok, true);
      assert.equal(completedWithSpawnEvidence.task.delegation_compliance?.status, 'spawned');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus requires evidence when optional delegation carries required parallel probe', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-optional-required-probe-'));
    try {
      await initTeamState('team-optional-required-probe', 't', 'executor', 1, cwd);
      const t = await createTask('team-optional-required-probe', {
        subject: 'Investigate optional delegated runtime behavior',
        description: 'Optional mode was elevated by a required parallel probe from review enforcement',
        status: 'pending',
        delegation: {
          mode: 'optional',
          required_parallel_probe: true,
          skip_allowed_reason_required: true,
        },
      }, cwd);
      const claim = await claimTask('team-optional-required-probe', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const missing = await transitionTaskStatus(
        'team-optional-required-probe',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        { result: 'Verification:\nPASS - focused regression' },
      );

      assert.equal(missing.ok, false);
      assert.equal(missing.ok ? 'x' : missing.error, 'missing_delegation_compliance_evidence');
      const reread = await readTask('team-optional-required-probe', t.id, cwd);
      assert.equal(reread?.status, 'in_progress');

      const completed = await transitionTaskStatus(
        'team-optional-required-probe',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        {
          result: [
            'Verification:',
            'PASS - focused regression',
            'Subagent spawn evidence: spawned 1 native subagent for delegation evidence regression mapping',
          ].join('\n'),
        },
      );

      assert.equal(completed.ok, true);
      assert.equal(completed.task.delegation_compliance?.status, 'spawned');
      assert.equal(completed.task.delegation_compliance?.source, 'terminal_result');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus accepts documented skip reason for broad delegated completion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-delegation-skip-'));
    try {
      await initTeamState('team-delegation-skip', 't', 'executor', 1, cwd);
      const t = await createTask('team-delegation-skip', {
        subject: 'Review focused regression',
        description: 'Audit one already-isolated failing test',
        status: 'pending',
        delegation: {
          mode: 'auto',
          required_parallel_probe: true,
          skip_allowed_reason_required: true,
        },
      }, cwd);
      const claim = await claimTask('team-delegation-skip', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const completed = await transitionTaskStatus(
        'team-delegation-skip',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        {
          result: [
            'Verification:',
            'PASS - focused regression',
            'Subagent skip reason: task scope collapsed to one isolated assertion; spawning would duplicate serial verification',
          ].join('\n'),
        },
      );

      assert.equal(completed.ok, true);
      assert.equal(completed.task.delegation_compliance?.status, 'skipped');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus rejects coordinated completion without boundary evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-coordination-evidence-'));
    try {
      await initTeamState('team-coordination-evidence', 't', 'executor', 1, cwd);
      const t = await createTask('team-coordination-evidence', {
        subject: 'Integrate shared runtime and tests',
        description: 'Coordinate a handoff across shared runtime boundaries.',
        status: 'pending',
        coordination: {
          mode: 'coordinated',
          activation_reasons: ['cross_boundary_or_handoff_language'],
          required_mechanisms: ['shared_mental_model', 'closed_loop_communication'],
        },
      }, cwd);
      const claim = await claimTask('team-coordination-evidence', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const missing = await transitionTaskStatus(
        'team-coordination-evidence',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        { result: 'Verification:\nPASS - focused regression' },
      );

      assert.equal(missing.ok, false);
      assert.equal(missing.ok ? 'x' : missing.error, 'missing_coordination_compliance_evidence');

      const completed = await transitionTaskStatus(
        'team-coordination-evidence',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        {
          result: [
            'Verification:',
            'PASS - focused regression',
            'Coordination protocol: coordinated - shared runtime handoff and downstream boundary checks verified',
          ].join('\n'),
        },
      );

      assert.equal(completed.ok, true);
      assert.equal(completed.task.coordination_compliance?.status, 'checked');
      assert.equal(completed.task.coordination_compliance?.source, 'terminal_result');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus accepts documented no-boundary rationale for coordinated tasks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-coordination-no-boundary-'));
    try {
      await initTeamState('team-coordination-no-boundary', 't', 'executor', 1, cwd);
      const t = await createTask('team-coordination-no-boundary', {
        subject: 'Coordinate shared verification',
        description: 'Original plan had a handoff, but implementation collapsed to one isolated check.',
        status: 'pending',
        coordination: {
          mode: 'coordinated',
          activation_reasons: ['cross_boundary_or_handoff_language'],
        },
      }, cwd);
      const claim = await claimTask('team-coordination-no-boundary', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const completed = await transitionTaskStatus(
        'team-coordination-no-boundary',
        t.id,
        'in_progress',
        'completed',
        claim.claimToken,
        cwd,
        {
          result: [
            'Verification:',
            'PASS - focused regression',
            'Coordination protocol: no boundary handoff - scope collapsed before execution; no peer-facing artifact changed',
          ].join('\n'),
        },
      );

      assert.equal(completed.ok, true);
      assert.equal(completed.task.coordination_compliance?.status, 'no_boundary_handoff');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus persists terminal result and error payloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-transition-payload-'));
    try {
      await initTeamState('team-transition-payload', 't', 'executor', 1, cwd);

      const completedTask = await createTask('team-transition-payload', { subject: 'done', description: 'd', status: 'pending' }, cwd);
      const completedClaim = await claimTask('team-transition-payload', completedTask.id, 'worker-1', completedTask.version ?? 1, cwd);
      assert.equal(completedClaim.ok, true);
      if (!completedClaim.ok) return;

      const completedResult = 'Verification:\nPASS - bootstrap state exists';
      const completedTransition = await transitionTaskStatus(
        'team-transition-payload',
        completedTask.id,
        'in_progress',
        'completed',
        completedClaim.claimToken,
        cwd,
        { result: completedResult },
      );
      assert.equal(completedTransition.ok, true);

      const completedReread = await readTask('team-transition-payload', completedTask.id, cwd);
      assert.equal(completedReread?.result, completedResult);
      assert.equal(completedReread?.error, undefined);

      const failedTask = await createTask('team-transition-payload', { subject: 'fail', description: 'd', status: 'pending' }, cwd);
      const failedClaim = await claimTask('team-transition-payload', failedTask.id, 'worker-1', failedTask.version ?? 1, cwd);
      assert.equal(failedClaim.ok, true);
      if (!failedClaim.ok) return;

      const failedError = 'Verification failed: missing bootstrap evidence';
      const failedTransition = await transitionTaskStatus(
        'team-transition-payload',
        failedTask.id,
        'in_progress',
        'failed',
        failedClaim.claimToken,
        cwd,
        { error: failedError },
      );
      assert.equal(failedTransition.ok, true);

      const failedReread = await readTask('team-transition-payload', failedTask.id, cwd);
      assert.equal(failedReread?.error, failedError);
      assert.equal(failedReread?.result, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus appends task_failed event (not worker_stopped) when task fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-failed-'));
    try {
      await initTeamState('team-failed', 't', 'executor', 1, cwd);
      const t = await createTask('team-failed', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-failed', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      const token = claim.ok ? claim.claimToken : 'x';

      const tr = await transitionTaskStatus('team-failed', t.id, 'in_progress', 'failed', token, cwd);
      assert.equal(tr.ok, true);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-failed', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      assert.match(content, /\"type\":\"task_failed\"/);
      assert.match(content, new RegExp(`\"task_id\":\"${t.id}\"`));
      assert.doesNotMatch(content, /\"type\":\"worker_stopped\"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releaseTaskClaim reverts a claimed task back to pending under claim lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-release-'));
    try {
      await initTeamState('team-release', 't', 'executor', 1, cwd);
      const t = await createTask('team-release', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-release', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const released = await releaseTaskClaim('team-release', t.id, claim.claimToken, 'worker-1', cwd);
      assert.equal(released.ok, true);

      const reread = await readTask('team-release', t.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releaseTaskClaim returns claim_conflict when claim token changed, even for the owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-release-owner-'));
    try {
      await initTeamState('team-release-owner', 't', 'executor', 1, cwd);
      const t = await createTask('team-release-owner', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-release-owner', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      // Simulate token drift while ownership/status remain in_progress.
      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-release-owner', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.token = 'different-token';
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      const released = await releaseTaskClaim('team-release-owner', t.id, claim.claimToken, 'worker-1', cwd);
      assert.equal(released.ok, false);
      assert.equal(released.ok ? 'x' : released.error, 'claim_conflict');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releaseTaskClaim on a completed task returns already_terminal and does not reopen it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-release-terminal-'));
    try {
      await initTeamState('team-release-terminal', 't', 'executor', 1, cwd);
      const t = await createTask('team-release-terminal', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-release-terminal', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const tr = await transitionTaskStatus('team-release-terminal', t.id, 'in_progress', 'completed', claim.claimToken, cwd);
      assert.equal(tr.ok, true);

      // Verify claim was stripped on completion
      const afterComplete = await readTask('team-release-terminal', t.id, cwd);
      assert.equal(afterComplete?.status, 'completed');
      assert.equal(afterComplete?.claim, undefined);

      // Attempt to release the claim of a completed task — must be rejected
      const released = await releaseTaskClaim('team-release-terminal', t.id, claim.claimToken, 'worker-1', cwd);
      assert.equal(released.ok, false);
      assert.equal(released.ok ? 'x' : released.error, 'already_terminal');

      // Task must remain completed, not reopened
      const reread = await readTask('team-release-terminal', t.id, cwd);
      assert.equal(reread?.status, 'completed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('transitionTaskStatus returns lease_expired when claim lease has passed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-lease-trans-'));
    try {
      await initTeamState('team-lease-trans', 't', 'executor', 1, cwd);
      const t = await createTask('team-lease-trans', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-lease-trans', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      // Backdate leased_until to the past to simulate expiry.
      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-lease-trans', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1000).toISOString();
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      const result = await transitionTaskStatus('team-lease-trans', t.id, 'in_progress', 'completed', claim.claimToken, cwd);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? 'x' : result.error, 'lease_expired');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releaseTaskClaim on a failed task returns already_terminal and does not reopen it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-release-failed-'));
    try {
      await initTeamState('team-release-failed', 't', 'executor', 1, cwd);
      const t = await createTask('team-release-failed', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-release-failed', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const tr = await transitionTaskStatus('team-release-failed', t.id, 'in_progress', 'failed', claim.claimToken, cwd);
      assert.equal(tr.ok, true);

      const released = await releaseTaskClaim('team-release-failed', t.id, claim.claimToken, 'worker-1', cwd);
      assert.equal(released.ok, false);
      assert.equal(released.ok ? 'x' : released.error, 'already_terminal');

      const reread = await readTask('team-release-failed', t.id, cwd);
      assert.equal(reread?.status, 'failed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releaseTaskClaim returns lease_expired when lease has expired and caller is not the owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-lease-release-'));
    try {
      await initTeamState('team-lease-release', 't', 'executor', 1, cwd);
      const t = await createTask('team-lease-release', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-lease-release', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      // Backdate leased_until and change owner so ownerMatches is also false.
      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-lease-release', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1000).toISOString();
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      // Different worker tries to release with the expired token.
      const result = await releaseTaskClaim('team-lease-release', t.id, claim.claimToken, 'worker-2', cwd);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? 'x' : result.error, 'lease_expired');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releaseTaskClaim returns lease_expired when lease has expired, even for the owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-lease-release-owner-'));
    try {
      await initTeamState('team-lease-release-owner', 't', 'executor', 1, cwd);
      const t = await createTask('team-lease-release-owner', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-lease-release-owner', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      // Backdate leased_until so the claim token is no longer valid.
      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-lease-release-owner', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1000).toISOString();
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      // Same worker releases — should now fail because owner-only bypass is removed.
      const result = await releaseTaskClaim('team-lease-release-owner', t.id, claim.claimToken, 'worker-1', cwd);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? 'x' : result.error, 'lease_expired');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('reclaimExpiredTaskClaim reopens an expired in-progress task so another worker can claim it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-reclaim-expired-'));
    try {
      await initTeamState('team-reclaim-expired', 't', 'executor', 2, cwd);
      const t = await createTask('team-reclaim-expired', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-reclaim-expired', t.id, 'worker-1', t.version ?? 1, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) return;

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-reclaim-expired', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1000).toISOString();
      await writeFile(taskPath, JSON.stringify(current, null, 2));

      const reclaimed = await reclaimExpiredTaskClaim('team-reclaim-expired', t.id, cwd);
      assert.equal(reclaimed.ok, true);
      if (!reclaimed.ok) return;
      assert.equal(reclaimed.reclaimed, true);
      assert.equal(reclaimed.task.status, 'pending');
      assert.equal(reclaimed.task.claim, undefined);

      const secondClaim = await claimTask('team-reclaim-expired', t.id, 'worker-2', reclaimed.task.version ?? null, cwd);
      assert.equal(secondClaim.ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('mailbox APIs: DM, broadcast, and mark delivered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-'));
    try {
      await initTeamState('team-msg', 't', 'executor', 2, cwd);

      const dm = await sendDirectMessage('team-msg', 'worker-1', 'worker-2', 'hello', cwd);
      assert.equal(dm.to_worker, 'worker-2');

      const delivered = await markMessageDelivered('team-msg', 'worker-2', dm.message_id, cwd);
      assert.equal(delivered, true);

      const b = await broadcastMessage('team-msg', 'worker-1', 'all', cwd);
      assert.equal(b.length, 1);
      assert.equal(b[0]?.to_worker, 'worker-2');

      const mailboxDisk = await readFile(join(cwd, '.omx', 'state', 'team', 'team-msg', 'mailbox', 'worker-2.json'), 'utf8');
      const parsed = JSON.parse(mailboxDisk) as { messages: Array<{ delivered_at?: string }> };
      assert.ok(parsed.messages.some((m) => typeof m.delivered_at === 'string'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses bridge-authored mailbox records while shadowing legacy mailbox bodies for recovery', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-bridge-authority-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    try {
      await initTeamState('team-mailbox-bridge-authority', 't', 'executor', 2, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');

      const legacyPath = join(cwd, '.omx', 'state', 'team', 'team-mailbox-bridge-authority', 'mailbox', 'worker-2.json');
      assert.equal(existsSync(legacyPath), false);

      const message = await sendDirectMessage('team-mailbox-bridge-authority', 'worker-1', 'worker-2', 'hello', cwd);
      assert.equal(message.to_worker, 'worker-2');
      await markMessageNotified('team-mailbox-bridge-authority', 'worker-2', message.message_id, cwd);
      await markMessageDelivered('team-mailbox-bridge-authority', 'worker-2', message.message_id, cwd);

      const messages = await listMailboxMessages('team-mailbox-bridge-authority', 'worker-2', cwd);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.message_id, message.message_id);
      assert.equal(messages[0]?.body, 'hello');
      assert.equal(typeof messages[0]?.notified_at, 'string');
      assert.equal(typeof messages[0]?.delivered_at, 'string');

      assert.equal(existsSync(legacyPath), true, 'bridge-success path should shadow-write legacy mailbox JSON for body recovery');
      const after = JSON.parse(await readFile(legacyPath, 'utf8')) as { messages: Array<{ message_id: string; body: string }> };
      assert.equal(after.messages.length, 1);
      assert.equal(after.messages[0]?.message_id, message.message_id);
      assert.equal(after.messages[0]?.body, 'hello');

      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ message_id: string; body: string }> };
      const compatRecord = compat.records.find((entry) => entry.message_id === message.message_id);
      assert.ok(compatRecord);

      const runtimeLogBefore = await readFile(runtimeLogPath, 'utf8');
      const deliveredCallsBefore = runtimeLogBefore.split('MarkMailboxDelivered').length - 1;
      const deliveredAgain = await markMessageDelivered('team-mailbox-bridge-authority', 'worker-2', message.message_id, cwd);
      assert.equal(deliveredAgain, true, 'already-delivered bridge message should be treated as delivered');
      const runtimeLogAfter = await readFile(runtimeLogPath, 'utf8');
      const deliveredCallsAfter = runtimeLogAfter.split('MarkMailboxDelivered').length - 1;
      assert.equal(deliveredCallsAfter, deliveredCallsBefore, 'idempotent delivered calls should not invoke bridge a second time');

      compatRecord!.body = '';
      await writeFile(compatPath, JSON.stringify(compat, null, 2));

      const recovered = await listMailboxMessages('team-mailbox-bridge-authority', 'worker-2', cwd);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.body, 'hello', 'legacy shadow mailbox should backfill blank compat bodies');
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendDirectMessage recreates mailbox directory when missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-'));
    try {
      await initTeamState('team-msg-recreate-mailbox', 't', 'executor', 2, cwd);
      await rm(join(cwd, '.omx', 'state', 'team', 'team-msg-recreate-mailbox', 'mailbox'), {
        recursive: true,
        force: true,
      });

      const dm = await sendDirectMessage(
        'team-msg-recreate-mailbox',
        'worker-1',
        'worker-2',
        'hello',
        cwd,
      );
      assert.equal(dm.to_worker, 'worker-2');
      assert.equal(
        existsSync(
          join(cwd, '.omx', 'state', 'team', 'team-msg-recreate-mailbox', 'mailbox', 'worker-2.json'),
        ),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendDirectMessage throws team not found after team cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-'));
    try {
      await initTeamState('team-msg-missing-team', 't', 'executor', 2, cwd);
      await rm(join(cwd, '.omx', 'state', 'team', 'team-msg-missing-team'), {
        recursive: true,
        force: true,
      });
      await assert.rejects(
        () => sendDirectMessage('team-msg-missing-team', 'worker-1', 'worker-2', 'hello', cwd),
        /Team team-msg-missing-team not found/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('markMessageNotified stores notified_at without forcing delivered_at', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-'));
    try {
      await initTeamState('team-msg-notify', 't', 'executor', 2, cwd);
      const dm = await sendDirectMessage('team-msg-notify', 'worker-1', 'worker-2', 'hello', cwd);

      const marked = await markMessageNotified('team-msg-notify', 'worker-2', dm.message_id, cwd);
      assert.equal(marked, true);

      const msgs = await listMailboxMessages('team-msg-notify', 'worker-2', cwd);
      const msg = msgs.find((m) => m.message_id === dm.message_id);
      assert.ok(msg);
      assert.equal(typeof msg?.notified_at, 'string');
      assert.equal(msg?.delivered_at, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('mailbox does not lose messages under concurrent sends', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-'));
    try {
      await initTeamState('team-msg-concurrent', 't', 'executor', 3, cwd);
      const sends = Array.from({ length: 25 }, (_, idx) =>
        sendDirectMessage('team-msg-concurrent', 'worker-1', 'worker-2', `hello-${idx}`, cwd),
      );
      const delivered = await Promise.all(sends);
      const expectedIds = new Set(delivered.map((m) => m.message_id));
      assert.equal(expectedIds.size, 25);

      const mailbox = await listMailboxMessages('team-msg-concurrent', 'worker-2', cwd);
      const actualIds = new Set(mailbox.map((m) => m.message_id));
      for (const id of expectedIds) {
        assert.equal(actualIds.has(id), true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendDirectMessage reuses identical undelivered messages instead of appending duplicates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-'));
    try {
      await initTeamState('team-msg-dedupe', 't', 'executor', 2, cwd);
      const first = await sendDirectMessage('team-msg-dedupe', 'worker-1', 'leader-fixed', 'same-body', cwd);
      const second = await sendDirectMessage('team-msg-dedupe', 'worker-1', 'leader-fixed', 'same-body', cwd);

      assert.equal(second.message_id, first.message_id);

      const mailbox = await listMailboxMessages('team-msg-dedupe', 'leader-fixed', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.body, 'same-body');

      const delivered = await markMessageDelivered('team-msg-dedupe', 'leader-fixed', first.message_id, cwd);
      assert.equal(delivered, true);

      const third = await sendDirectMessage('team-msg-dedupe', 'worker-1', 'leader-fixed', 'same-body', cwd);
      assert.notEqual(third.message_id, first.message_id);
      const mailboxAfter = await listMailboxMessages('team-msg-dedupe', 'leader-fixed', cwd);
      assert.equal(mailboxAfter.length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeTaskApproval writes record and emits approval_decision event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approval-'));
    try {
      await initTeamState('team-approval-record', 't', 'executor', 1, cwd);
      const t = await createTask('team-approval-record', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      await writeTaskApproval(
        'team-approval-record',
        {
          task_id: t.id,
          required: true,
          status: 'approved',
          reviewer: 'leader-fixed',
          decision_reason: 'ok',
          decided_at: new Date().toISOString(),
        },
        cwd
      );

      const reread = await readTaskApproval('team-approval-record', t.id, cwd);
      assert.ok(reread);
      assert.equal(reread?.status, 'approved');

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-approval-record', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      assert.match(content, /\"type\":\"approval_decision\"/);
      assert.match(content, new RegExp(`\"task_id\":\"${t.id}\"`));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState rejects workerCount > max_workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState('team-2', 't', 'executor', DEFAULT_MAX_WORKERS + 1, cwd, DEFAULT_MAX_WORKERS),
        /exceeds maxWorkers/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState rejects maxWorkers > ABSOLUTE_MAX_WORKERS', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState('team-abs', 't', 'executor', 1, cwd, ABSOLUTE_MAX_WORKERS + 1),
        /exceeds ABSOLUTE_MAX_WORKERS/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createTask auto-increments IDs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-3', 't', 'executor', 1, cwd);
      const t1 = await createTask(
        'team-3',
        { subject: 'a', description: 'd', status: 'pending' },
        cwd
      );
      const t2 = await createTask(
        'team-3',
        { subject: 'b', description: 'd', status: 'pending' },
        cwd
      );

      assert.equal(t1.id, '1');
      assert.equal(t2.id, '2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createTask does not overwrite existing tasks when config next_task_id is missing (legacy)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-legacy', 't', 'executor', 1, cwd);

      // Simulate legacy config by removing next_task_id field.
      const configPath = join(cwd, '.omx', 'state', 'team', 'team-legacy', 'config.json');
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as unknown as { [key: string]: unknown };
      delete cfg.next_task_id;
      await writeAtomic(configPath, JSON.stringify(cfg, null, 2));

      // Create an existing task-1.json, then create another task; it must get id=2.
      const t1 = await createTask('team-legacy', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      assert.equal(t1.id, '1');

      // Remove next_task_id again to simulate older config still missing field.
      const cfg2 = JSON.parse(readFileSync(configPath, 'utf8')) as unknown as { [key: string]: unknown };
      delete cfg2.next_task_id;
      await writeAtomic(configPath, JSON.stringify(cfg2, null, 2));

      const t2 = await createTask('team-legacy', { subject: 'b', description: 'd', status: 'pending' }, cwd);
      assert.equal(t2.id, '2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createTask does not overwrite existing tasks when manifest/config next_task_id lags disk', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-stale-next-id', 't', 'executor', 1, cwd);

      const first = await createTask('team-stale-next-id', { subject: 'first', description: 'd', status: 'pending' }, cwd);
      assert.equal(first.id, '1');

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-stale-next-id');
      const configPath = join(teamRoot, 'config.json');
      const manifestPath = join(teamRoot, 'manifest.v2.json');

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.next_task_id = 1;
      await writeAtomic(configPath, JSON.stringify(config, null, 2));

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.next_task_id = 1;
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));

      const second = await createTask('team-stale-next-id', { subject: 'second', description: 'd', status: 'pending' }, cwd);
      assert.equal(second.id, '2');

      const firstTask = JSON.parse(await readFile(join(teamRoot, 'tasks', 'task-1.json'), 'utf8')) as { subject?: string };
      const secondTask = JSON.parse(await readFile(join(teamRoot, 'tasks', 'task-2.json'), 'utf8')) as { subject?: string };
      assert.equal(firstTask.subject, 'first');
      assert.equal(secondTask.subject, 'second');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('listTasks returns sorted by ID', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-4', 't', 'executor', 1, cwd);
      await createTask('team-4', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      await createTask('team-4', { subject: 'b', description: 'd', status: 'pending' }, cwd);
      await createTask('team-4', { subject: 'c', description: 'd', status: 'pending' }, cwd);

      const tasks = await listTasks('team-4', cwd);
      assert.deepEqual(
        tasks.map((t) => t.id),
        ['1', '2', '3']
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('listTasks reads task files in parallel', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-list-parallel-'));
    try {
      await initTeamState('team-parallel', 't', 'executor', 1, cwd);
      const N = 20;
      for (let i = 0; i < N; i++) {
        await createTask('team-parallel', { subject: `task-${i}`, description: 'd', status: 'pending' }, cwd);
      }
      const tasks = await listTasks('team-parallel', cwd);
      assert.equal(tasks.length, N);
      // IDs should be consecutive strings '1'..'N' in sorted order
      const ids = tasks.map((t) => t.id);
      assert.deepEqual(ids, Array.from({ length: N }, (_, i) => String(i + 1)));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('listTasks ignores malformed and id-mismatched task payloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-list-validate-'));
    try {
      await initTeamState('team-list-validate', 't', 'executor', 1, cwd);
      await createTask('team-list-validate', { subject: 'ok', description: 'd', status: 'pending' }, cwd);

      // Internal payload id mismatches filename id -> should be ignored.
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-list-validate', 'tasks', 'task-2.json'),
        JSON.stringify({
          id: '999',
          subject: 'mismatch',
          description: 'bad',
          status: 'pending',
          created_at: new Date().toISOString(),
        }, null, 2),
      );

      // Malformed payload -> should be ignored.
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-list-validate', 'tasks', 'task-3.json'),
        JSON.stringify({ nope: true }, null, 2),
      );

      const tasks = await listTasks('team-list-validate', cwd);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, '1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTask returns null for non-existent task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-5', 't', 'executor', 1, cwd);
      const task = await readTask('team-5', '999', cwd);
      assert.equal(task, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTask returns null for malformed JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-6', 't', 'executor', 1, cwd);
      const badPath = join(cwd, '.omx', 'state', 'team', 'team-6', 'tasks', 'task-1.json');
      await writeFile(badPath, '{not json', 'utf8');
      const task = await readTask('team-6', '1', cwd);
      assert.equal(task, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('updateTask merges updates correctly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-7', 't', 'executor', 1, cwd);
      const created = await createTask(
        'team-7',
        { subject: 's', description: 'd', status: 'pending', owner: undefined },
        cwd
      );

      const updated = await updateTask(
        'team-7',
        created.id,
        { status: 'completed', owner: 'worker-1', result: 'done', completed_at: new Date().toISOString() },
        cwd
      );

      assert.ok(updated);
      assert.equal(updated?.id, created.id);
      assert.equal(updated?.status, 'completed');
      assert.equal(updated?.owner, 'worker-1');
      assert.equal(updated?.result, 'done');

      const reread = await readTask('team-7', created.id, cwd);
      assert.equal(reread?.status, 'completed');
      assert.equal(reread?.owner, 'worker-1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('updateTask rejects empty string status and leaves task readable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-upd-empty-status', 't', 'executor', 1, cwd);
      const created = await createTask(
        'team-upd-empty-status',
        { subject: 's', description: 'd', status: 'pending' },
        cwd
      );

      await assert.rejects(
        () => updateTask('team-upd-empty-status', created.id, { status: '' as never }, cwd),
        /Invalid task status/
      );

      // Task must still be readable after the rejected update.
      const reread = await readTask('team-upd-empty-status', created.id, cwd);
      assert.ok(reread, 'task should still be readable after invalid update was rejected');
      assert.equal(reread?.status, 'pending');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('updateTask coerces non-array depends_on to [] so claimTask does not crash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-upd-bad-deps', 't', 'executor', 1, cwd);
      const created = await createTask(
        'team-upd-bad-deps',
        { subject: 's', description: 'd', status: 'pending' },
        cwd
      );

      // Pass a non-array depends_on to simulate a bad MCP payload.
      await updateTask('team-upd-bad-deps', created.id, { depends_on: 'not-an-array' as never }, cwd);

      // claimTask must not throw "deps.map is not a function".
      const claim = await claimTask('team-upd-bad-deps', created.id, 'worker-1', null, cwd);
      assert.equal(claim.ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('updateTask is safe under concurrent calls (no lost updates)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-update-concurrent', 't', 'executor', 1, cwd);
      const created = await createTask(
        'team-update-concurrent',
        { subject: 's', description: 'd', status: 'pending', owner: undefined },
        cwd
      );

      await Promise.all([
        updateTask('team-update-concurrent', created.id, { result: 'r1' }, cwd),
        updateTask('team-update-concurrent', created.id, { error: 'e2' }, cwd),
      ]);

      const reread = await readTask('team-update-concurrent', created.id, cwd);
      assert.equal(reread?.result, 'r1');
      assert.equal(reread?.error, 'e2');
      assert.ok((reread?.version ?? 0) >= 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic creates file and is safe to call concurrently (basic)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic.txt');
      await Promise.all([writeAtomic(p, 'a'), writeAtomic(p, 'b')]);
      assert.equal(existsSync(p), true);
      const content = readFileSync(p, 'utf8');
      assert.ok(content === 'a' || content === 'b');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic does not swallow ENOENT when destination content differs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-fallback.txt');
      await writeFile(p, 'old', 'utf8');

      setWriteAtomicRenameForTests(async () => {
        const err = new Error('missing temp') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      await assert.rejects(() => writeAtomic(p, 'new'), (error: unknown) => {
        const err = error as NodeJS.ErrnoException;
        return err.code === 'ENOENT';
      });
      assert.equal(readFileSync(p, 'utf8'), 'old');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic keeps ENOENT fallback when destination already has expected content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-fallback-safe.txt');
      await writeFile(p, 'same-content', 'utf8');

      setWriteAtomicRenameForTests(async () => {
        const err = new Error('missing temp') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      await writeAtomic(p, 'same-content');
      assert.equal(readFileSync(p, 'utf8'), 'same-content');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR'] as const) {
    it(`writeAtomic tolerates unsupported parent directory sync ${code} after fsyncing the file`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
      try {
        const p = join(cwd, `atomic-parent-sync-${code}.txt`);
        let fileSyncs = 0;
        setWriteAtomicOpenForTests(async (...args) => {
          const [path] = args;
          const handle = await open(...args);
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (path === cwd) {
              const error = new Error(`unsupported parent sync: ${code}`) as NodeJS.ErrnoException;
              error.code = code;
              throw error;
            }
            fileSyncs += 1;
            await sync();
          };
          return handle;
        });

        await writeAtomic(p, 'durable data');

        assert.equal(fileSyncs, 1);
        assert.equal(readFileSync(p, 'utf8'), 'durable data');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it('writeAtomic tolerates Windows EPERM opening the parent directory after fsyncing the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-parent-open-eperm.txt');
      let fileSyncs = 0;
      setWriteAtomicPlatformForTests('win32');
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        if (path === cwd) {
          const error = new Error('Windows cannot open directory for sync') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await writeAtomic(p, 'durable data');

      assert.equal(fileSyncs, 1);
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic tolerates Windows EPERM syncing the parent directory after fsyncing the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-parent-sync-eperm.txt');
      let fileSyncs = 0;
      setWriteAtomicPlatformForTests('win32');
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (path === cwd) {
            const error = new Error('Windows cannot sync directory') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await writeAtomic(p, 'durable data');

      assert.equal(fileSyncs, 1);
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic surfaces POSIX EPERM opening the parent directory after fsyncing the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-parent-open-posix-eperm.txt');
      let fileSyncs = 0;
      setWriteAtomicPlatformForTests('linux');
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        if (path === cwd) {
          const error = new Error('POSIX parent open denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await assert.rejects(() => writeAtomic(p, 'durable data'), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      });
      assert.equal(fileSyncs, 1);
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic surfaces POSIX EPERM syncing the parent directory after fsyncing the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-parent-sync-posix-eperm.txt');
      let fileSyncs = 0;
      setWriteAtomicPlatformForTests('linux');
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (path === cwd) {
            const error = new Error('POSIX parent sync denied') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await assert.rejects(() => writeAtomic(p, 'durable data'), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      });
      assert.equal(fileSyncs, 1);
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic surfaces unexpected parent directory open failures after fsyncing the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-parent-open-unexpected.txt');
      let fileSyncs = 0;
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        if (path === cwd) {
          const error = new Error('parent open failed') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await assert.rejects(() => writeAtomic(p, 'durable data'), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'EIO';
      });
      assert.equal(fileSyncs, 1);
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic surfaces unexpected parent directory sync failures after fsyncing the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-parent-sync-unexpected.txt');
      let fileSyncs = 0;
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (path === cwd) {
            const error = new Error('parent sync failed') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await assert.rejects(() => writeAtomic(p, 'durable data'), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'EIO';
      });
      assert.equal(fileSyncs, 1);
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerStatus returns {state:\'unknown\'} on missing file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-8', 't', 'executor', 1, cwd);
      const status = await readWorkerStatus('team-8', 'worker-1', cwd);
      assert.equal(status.state, 'unknown');
      assert.ok(!Number.isNaN(Date.parse(status.updated_at)));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerHeartbeat returns null on missing file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-9', 't', 'executor', 1, cwd);
      const hb = await readWorkerHeartbeat('team-9', 'worker-1', cwd);
      assert.equal(hb, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeWorkerInbox writes content to the correct path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-10', 't', 'executor', 1, cwd);
      await writeWorkerInbox('team-10', 'worker-1', 'hello worker', cwd);

      const inboxPath = join(cwd, '.omx', 'state', 'team', 'team-10', 'workers', 'worker-1', 'inbox.md');
      assert.equal(existsSync(inboxPath), true);
      assert.equal(readFileSync(inboxPath, 'utf8'), 'hello worker');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('getTeamSummary aggregates task counts correctly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-11', 't', 'executor', 2, cwd);
      const t1 = await createTask('team-11', { subject: 'p', description: 'd', status: 'pending' }, cwd);
      await createTask('team-11', { subject: 'ip', description: 'd', status: 'in_progress' }, cwd);
      await createTask('team-11', { subject: 'c', description: 'd', status: 'completed' }, cwd);
      await createTask('team-11', { subject: 'f', description: 'd', status: 'failed' }, cwd);

      // Simulate a worker who is turning without progress on task 1.
      await updateWorkerHeartbeat(
        'team-11',
        'worker-1',
        { pid: 123, last_turn_at: new Date().toISOString(), turn_count: 6, alive: true },
        cwd
      );
      const statusPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-11',
        'workers',
        'worker-1',
        'status.json'
      );
      await writeAtomic(
        statusPath,
        JSON.stringify(
          {
            state: 'working',
            current_task_id: t1.id,
            updated_at: new Date().toISOString(),
          },
          null,
          2
        )
      );

      const first = await getTeamSummary('team-11', cwd);
      assert.ok(first);
      assert.equal(first?.teamName, 'team-11');
      assert.equal(first?.workerCount, 2);
      assert.deepEqual(first?.tasks, {
        total: 4,
        pending: 1,
        blocked: 0,
        in_progress: 1,
        completed: 1,
        failed: 1,
      });
      const firstW1 = first?.workers.find((w) => w.name === 'worker-1');
      assert.equal(firstW1?.alive, true);
      assert.equal(firstW1?.turnsWithoutProgress, 0);

      // Subsequent turns without task status progress should show delta.
      await updateWorkerHeartbeat(
        'team-11',
        'worker-1',
        { pid: 123, last_turn_at: new Date().toISOString(), turn_count: 12, alive: true },
        cwd
      );

      const second = await getTeamSummary('team-11', cwd);
      assert.ok(second?.nonReportingWorkers.includes('worker-1'));
      const secondW1 = second?.workers.find((w) => w.name === 'worker-1');
      assert.equal(secondW1?.turnsWithoutProgress, 6);
      assert.ok(second?.performance);
      assert.equal(second?.performance?.task_count, 4);
      assert.equal(second?.performance?.worker_count, 2);
      assert.ok((second?.performance?.tasks_loaded_ms ?? -1) >= 0);
      assert.ok((second?.performance?.workers_polled_ms ?? -1) >= 0);
      assert.ok((second?.performance?.total_ms ?? -1) >= 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cleanupTeamState removes the directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-12', 't', 'executor', 1, cwd);
      const root = join(cwd, '.omx', 'state', 'team', 'team-12');
      assert.equal(existsSync(root), true);
      await cleanupTeamState('team-12', cwd);
      assert.equal(existsSync(root), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('cleanupTeamState rejects unsafe team names before path construction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-unsafe-'));
    try {
      const victim = join(cwd, '.omx', 'state', 'victim');
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, 'keep.txt'), 'keep');

      await assert.rejects(() => cleanupTeamState('../victim', cwd), /invalid_team_name/);
      assert.equal(existsSync(join(victim, 'keep.txt')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('validateTeamName rejects invalid names (via initTeamState throwing)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState('Bad Name', 't', 'executor', 1, cwd),
        /Invalid team name/
      );
      await assert.rejects(
        () => initTeamState('-bad', 't', 'executor', 1, cwd),
        /Invalid team name/
      );
      await assert.rejects(
        () => initTeamState('a'.repeat(31), 't', 'executor', 1, cwd),
        /Invalid team name/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState snapshots permissions and display mode from env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState(
        'team-env',
        't',
        'executor',
        1,
        cwd,
        DEFAULT_MAX_WORKERS,
        {
          ...process.env,
          OMX_TEAM_DISPLAY_MODE: 'tmux',
          OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt',
          CODEX_APPROVAL_MODE: 'on-request',
          CODEX_SANDBOX_MODE: 'workspace-write',
          CODEX_NETWORK_ACCESS: '0',
          OMX_SESSION_ID: 'session-xyz',
        },
      );

      const manifest = await readTeamManifestV2('team-env', cwd);
      const config = await readTeamConfig('team-env', cwd);
      assert.ok(manifest);
      assert.ok(config);
      assert.equal(manifest?.policy.display_mode, 'split_pane');
      assert.equal(manifest?.policy.worker_launch_mode, 'prompt');
      assert.equal(manifest?.governance.cleanup_requires_all_workers_inactive, true);
      assert.equal(config?.worker_launch_mode, 'prompt');
      assert.equal(manifest?.permissions_snapshot.approval_mode, 'on-request');
      assert.equal(manifest?.permissions_snapshot.sandbox_mode, 'workspace-write');
      assert.equal(manifest?.permissions_snapshot.network_access, false);
      assert.equal(manifest?.leader.session_id, 'session-xyz');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState rejects invalid OMX_TEAM_WORKER_LAUNCH_MODE values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState(
          'team-env-invalid',
          't',
          'executor',
          1,
          cwd,
          DEFAULT_MAX_WORKERS,
          {
            ...process.env,
            OMX_TEAM_WORKER_LAUNCH_MODE: 'tmux',
          },
        ),
        /Invalid OMX_TEAM_WORKER_LAUNCH_MODE value/i,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('claimTask returns task_not_found for non-existent task id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-claim-missing-'));
    try {
      await initTeamState('team-x', 'task', 'executor', 1, cwd);
      const result = await claimTask('team-x', 'non-existent-999', 'worker-1', null, cwd);
      assert.equal(result.ok, false);
      assert.equal((result as { ok: false; error: string }).error, 'task_not_found');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolveDispatchLockTimeoutMs returns default when env not set', () => {
    assert.equal(resolveDispatchLockTimeoutMs({}), 15_000);
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: '' }), 15_000);
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: 'not-a-number' }), 15_000);
  });

  it('resolveDispatchLockTimeoutMs reads from env and clamps to bounds', () => {
    // Reads value from env
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: '30000' }), 30_000);
    // Clamps to minimum
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: '0' }), 1_000);
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: '-500' }), 1_000);
    // Clamps to maximum
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: '999999' }), 120_000);
    // Floors non-integer
    assert.equal(resolveDispatchLockTimeoutMs({ OMX_DISPATCH_LOCK_TIMEOUT_MS: '5000.9' }), 5_000);
  });

  it('dispatch lock error message includes timeout hint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-lock-timeout-'));
    try {
      await initTeamState('team-lock-hint', 'task', 'executor', 1, cwd);
      // Hold the lock by creating the lock directory manually
      const lockDir = join(cwd, '.omx', 'state', 'team', 'team-lock-hint', 'dispatch', '.lock');
      await mkdir(lockDir, { recursive: true });

      // Use a very short timeout via env override so the test is fast
      const origEnv = process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS;
      process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS = '1000';
      try {
        await assert.rejects(
          () => enqueueDispatchRequest('team-lock-hint', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'test' }, cwd),
          (err: Error) => {
            assert.ok(err.message.includes('OMX_DISPATCH_LOCK_TIMEOUT_MS'), `Expected hint in error, got: ${err.message}`);
            return true;
          }
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS;
        } else {
          process.env.OMX_DISPATCH_LOCK_TIMEOUT_MS = origEnv;
        }
        await rm(lockDir, { recursive: true, force: true });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats dispatch status as authoritative over incompatible timestamps', () => {
    const pending = normalizeDispatchRequest('team-contract-dispatch', {
      kind: 'inbox',
      to_worker: 'worker-1',
      trigger_message: 'ping',
      status: 'pending',
      notified_at: '2026-04-04T00:00:00.000Z',
      delivered_at: '2026-04-04T00:01:00.000Z',
      failed_at: '2026-04-04T00:02:00.000Z',
    });
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.notified_at, undefined);
    assert.equal(pending?.delivered_at, undefined);
    assert.equal(pending?.failed_at, undefined);

    const notified = normalizeDispatchRequest('team-contract-dispatch', {
      kind: 'inbox',
      to_worker: 'worker-1',
      trigger_message: 'ping',
      status: 'notified',
      notified_at: '2026-04-04T00:00:00.000Z',
      delivered_at: '2026-04-04T00:01:00.000Z',
      failed_at: '2026-04-04T00:02:00.000Z',
    });
    assert.equal(notified?.status, 'notified');
    assert.equal(notified?.notified_at, '2026-04-04T00:00:00.000Z');
    assert.equal(notified?.delivered_at, undefined);
    assert.equal(notified?.failed_at, undefined);

    const delivered = normalizeDispatchRequest('team-contract-dispatch', {
      kind: 'inbox',
      to_worker: 'worker-1',
      trigger_message: 'ping',
      status: 'delivered',
      notified_at: '2026-04-04T00:00:00.000Z',
      delivered_at: '2026-04-04T00:01:00.000Z',
      failed_at: '2026-04-04T00:02:00.000Z',
    });
    assert.equal(delivered?.status, 'delivered');
    assert.equal(delivered?.notified_at, '2026-04-04T00:00:00.000Z');
    assert.equal(delivered?.delivered_at, '2026-04-04T00:01:00.000Z');
    assert.equal(delivered?.failed_at, undefined);

    const failed = normalizeDispatchRequest('team-contract-dispatch', {
      kind: 'inbox',
      to_worker: 'worker-1',
      trigger_message: 'ping',
      status: 'failed',
      notified_at: '2026-04-04T00:00:00.000Z',
      delivered_at: '2026-04-04T00:01:00.000Z',
      failed_at: '2026-04-04T00:02:00.000Z',
    });
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.notified_at, '2026-04-04T00:00:00.000Z');
    assert.equal(failed?.delivered_at, undefined);
    assert.equal(failed?.failed_at, '2026-04-04T00:02:00.000Z');
  });

  it('sanitizes persisted integration snapshot statuses to the contract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-monitor-contract-'));
    try {
      await initTeamState('team-monitor-contract', 't', 'executor', 1, cwd);
      const monitorPath = join(cwd, '.omx', 'state', 'team', 'team-monitor-contract', 'monitor-snapshot.json');
      await writeFile(monitorPath, JSON.stringify({
        taskStatusById: {},
        workerAliveByName: {},
        workerStateByName: {},
        workerTurnCountByName: {},
        workerTaskIdByName: {},
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
        integrationByWorker: {
          'worker-1': {
            status: 'integrated',
            last_integrated_head: 'abc123',
          },
          'worker-2': {
            status: 'mystery_state',
            last_integrated_head: 'def456',
          },
        },
      }, null, 2));

      const snapshot = await readMonitorSnapshot('team-monitor-contract', cwd);
      assert.equal(snapshot?.integrationByWorker?.['worker-1']?.status, 'integrated');
      assert.equal(snapshot?.integrationByWorker?.['worker-1']?.last_integrated_head, 'abc123');
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.status, undefined);
      assert.equal(snapshot?.integrationByWorker?.['worker-2']?.last_integrated_head, 'def456');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('heartbeats live scaling and membership leases while reclaiming stale crashed locks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-lock-lease-'));
    const teamName = 'team-lock-lease';
    const staleMs = 90;
    const deps = {
      teamDir: (name: string, root: string) => join(root, '.omx', 'state', 'team', name),
      taskClaimLockDir: (name: string, taskId: string, root: string) => join(root, '.omx', 'state', 'team', name, 'claims', `task-${taskId}.lock`),
      mailboxLockDir: (name: string, worker: string, root: string) => join(root, '.omx', 'state', 'team', name, 'mailboxes', `${worker}.lock`),
    };
    const locks = [
      {
        label: 'scaling',
        lockDir: join(cwd, '.omx', 'state', '.team-locks', `${teamName}.scaling`),
        acquire: (fn: () => Promise<void>) => withScalingLeaseLock(teamName, cwd, staleMs, deps, fn),
      },
      {
        label: 'membership',
        lockDir: join(cwd, '.omx', 'state', '.team-locks', `${teamName}.membership`),
        acquire: (fn: () => Promise<void>) => withTeamLock(teamName, cwd, staleMs, deps, fn),
      },
    ];

    try {
      for (const lock of locks) {
        let releaseHeld!: () => void;
        const heldRelease = new Promise<void>((resolve) => { releaseHeld = resolve; });
        let heldEntered!: () => void;
        const heldEnteredPromise = new Promise<void>((resolve) => { heldEntered = resolve; });
        const held = lock.acquire(async () => {
          heldEntered();
          await heldRelease;
        });
        await heldEnteredPromise;

        let contenderEntered = false;
        const contender = lock.acquire(async () => { contenderEntered = true; });
        await new Promise((resolve) => setTimeout(resolve, staleMs * 3));
        assert.equal(contenderEntered, false, `live ${lock.label} lock must not be reclaimed after its directory mtime becomes stale`);
        releaseHeld();
        await Promise.all([held, contender]);

        await mkdir(lock.lockDir, { recursive: true });
        await writeFile(join(lock.lockDir, 'owner'), 'crashed-owner');
        await writeFile(join(lock.lockDir, 'lease'), 'crashed-owner');
        const staleTime = new Date(Date.now() - staleMs * 2);
        await utimes(lock.lockDir, staleTime, staleTime);
        await utimes(join(lock.lockDir, 'lease'), staleTime, staleTime);

        let reclaimed = false;
        await lock.acquire(async () => { reclaimed = true; });
        assert.equal(reclaimed, true, `stale ${lock.label} lock must be reclaimed after its lease expires`);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes cleanup with concurrent scaling and claims without recreating team state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-lock-race-'));
    const teamName = 'team-cleanup-lock-race';
    const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
    let releaseScale!: () => void;
    const scaleReleased = new Promise<void>((resolve) => { releaseScale = resolve; });
    let scaleEntered!: () => void;
    const scaleEnteredPromise = new Promise<void>((resolve) => { scaleEntered = resolve; });

    try {
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const task = await createTask(teamName, { subject: 'racy', description: 'd', status: 'pending' }, cwd);

      const scale = withScalingLock(teamName, cwd, async () => {
        scaleEntered();
        await scaleReleased;
      });
      await scaleEnteredPromise;

      const cleanup = cleanupTeamState(teamName, cwd);
      const claim = await claimTask(teamName, task.id, 'worker-1', task.version, cwd);
      assert.equal(claim.ok, true, 'claim must finish before the queued cleanup deletes canonical state');

      releaseScale();
      await Promise.all([scale, cleanup]);
      assert.equal(existsSync(teamRoot), false);

      await assert.rejects(
        () => createTask(teamName, { subject: 'must not recreate', description: 'd', status: 'pending' }, cwd),
        /Team team-cleanup-lock-race not found/,
      );
      const afterCleanupClaim = await claimTask(teamName, task.id, 'worker-1', null, cwd);
      assert.deepEqual(afterCleanupClaim, { ok: false, error: 'task_not_found' });
      assert.equal(existsSync(teamRoot), false, 'post-cleanup operations must not recreate a fake team root');
    } finally {
      releaseScale?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('membership transaction recovery path authority', () => {
  it('rejects foreign absolute paths before mutating any victim or canonical file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-membership-foreign-path-'));
    try {
      const teamName = 'foreign-path';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      const teamDir = join(cwd, '.omx', 'state', 'team', teamName);
      const configPath = join(teamDir, 'config.json');
      const configBytes = await readFile(configPath, 'utf8');
      const victimPath = join(cwd, 'victim.txt');
      await writeFile(victimPath, 'ORIGINAL');
      await writeFile(join(teamDir, '.membership-task-transaction.json'), JSON.stringify({
        schemaVersion: 1,
        phase: 'committed',
        files: [
          { path: configPath, oldBytes: configBytes, newBytes: configBytes },
          { path: victimPath, oldBytes: 'ORIGINAL', newBytes: 'PWNED' },
        ],
      }));

      await assert.rejects(recoverTeamMembershipTaskTransaction(teamName, cwd), /escapes expected team files/);
      assert.equal(await readFile(victimPath, 'utf8'), 'ORIGINAL');
      assert.equal(await readFile(configPath, 'utf8'), configBytes);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked tasks directory before writing through it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-membership-symlink-path-'));
    try {
      const teamName = 'symlink-path';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      const teamDir = join(cwd, '.omx', 'state', 'team', teamName);
      const configPath = join(teamDir, 'config.json');
      const configBytes = await readFile(configPath, 'utf8');
      const tasksDir = join(teamDir, 'tasks');
      const outsideTasksDir = join(cwd, 'outside-tasks');
      await rm(tasksDir, { recursive: true, force: true });
      await mkdir(outsideTasksDir);
      await writeFile(join(outsideTasksDir, 'task-1.json'), 'ORIGINAL');
      await symlink(outsideTasksDir, tasksDir, 'dir');
      await writeFile(join(teamDir, '.membership-task-transaction.json'), JSON.stringify({
        schemaVersion: 1,
        phase: 'committed',
        files: [
          { path: configPath, oldBytes: configBytes, newBytes: configBytes },
          { path: join(tasksDir, 'task-1.json'), oldBytes: 'ORIGINAL', newBytes: 'PWNED' },
        ],
      }));

      await assert.rejects(recoverTeamMembershipTaskTransaction(teamName, cwd), /tasks root escapes canonical team root/);
      assert.equal(await readFile(join(outsideTasksDir, 'task-1.json'), 'utf8'), 'ORIGINAL');
      assert.equal(await readFile(configPath, 'utf8'), configBytes);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
