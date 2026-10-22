import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, unlink, writeFile, readFile, mkdir, open, rename, utimes, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import fs, { existsSync, readFileSync } from 'fs';
import { syncBuiltinESMExports } from 'node:module';
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
  markDispatchRequestFailed,
  transitionDispatchRequest,
  readDispatchRequest,
  readDispatchRequests,
  readMonitorSnapshot,
  resolveDispatchLockTimeoutMs,
  writeTeamManifestV2,
  removeDispatchRequestsForWorkers,
  retireTeamMailboxMessages,
  withScalingLock,

} from '../state.js';
import { normalizeDispatchRequest, normalizeBridgeDispatchRecord } from '../state/dispatch.js';
import { queueDirectMailboxMessage, queueBroadcastMailboxMessage, type TeamNotifier } from '../mcp-comm.js';
import { claimTask as claimTaskWithDeps } from '../state/tasks.js';
import { sendDirectMessage as sendDirectMessageWithDeps, markMessageDelivered as markMessageDeliveredWithDeps, needsLegacyMailboxEvidence, normalizeBridgeMailboxMessage, type TeamMailbox } from '../state/mailbox.js';
import { isStrictDispatchRecord } from '../../runtime/bridge.js';
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
    capabilities: ['team-mailbox-scope-v1'],
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

if (argv[0] !== 'exec' && argv[0] !== 'exec-scoped') process.exit(1);

const command = JSON.parse(argv[1] || '{}');
const dir = stateDir();
const dispatchPath = path.join(dir, 'dispatch.json');
const mailboxPath = path.join(dir, 'mailbox.json');
const dispatch = readJson(dispatchPath, { records: [] });
const mailbox = readJson(mailboxPath, { records: [] });
const timestamp = nowIso();

switch (command.command) {
  case 'QueueDispatch': {
    if (process.env.OMX_TEST_REJECT_QUEUE_DISPATCH === '1') {
      process.stderr.write('runtime state could not load\\n');
      process.exit(1);
    }
    writeJson(path.join(dir, 'events.json'), [...readJson(path.join(dir, 'events.json'), []), { event: 'DispatchQueued', request_id: command.request_id, metadata: command.metadata }]);
    writeJson(path.join(dir, 'dispatch-seen.json'), { schema_version: 2, ledger_epoch: 1, request_ids: [...readJson(path.join(dir, 'dispatch-seen.json'), { request_ids: [] }).request_ids, command.request_id] });
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
    if (process.env.OMX_TEST_REJECT_MARK_DELIVERED === '1') {
      process.stderr.write('invalid delivered transition\\n');
      process.exit(1);
    }
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
    if ([...ids].some((id) => !dispatch.records.some((entry) => entry.request_id === id))) {
      process.stderr.write('unknown dispatch request\\n');
      process.exit(1);
    }
    if (process.env.OMX_TEST_ACK_RETAIN_DISPATCH !== '1') {
      dispatch.records = dispatch.records.filter((entry) => !ids.has(entry.request_id));
      writeJson(dispatchPath, dispatch);
    }
    process.stdout.write(JSON.stringify({ event: 'DispatchRecordsRemoved', request_ids: command.request_ids || [] }) + '\\n');
    process.exit(0);
  }
  case 'CaptureSnapshot': {
    if (process.env.OMX_TEST_SKIP_SNAPSHOT_COMPAT_WRITE !== '1') writeJson(dispatchPath, dispatch);
    if (process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE === '1') {
      const events = readJson(path.join(dir, 'events.json'), []);
      for (const event of events) {
        if (event?.event !== 'MailboxMessageCreated' || typeof event.message_id !== 'string'
          || mailbox.records.some((record) => record?.message_id === event.message_id && record.team_name === event.team_name)) continue;
        mailbox.records.push({
          team_name: event.team_name ?? null,
          message_id: event.message_id,
          from_worker: event.from_worker,
          to_worker: event.to_worker,
          body: event.body ?? '',
          created_at: timestamp,
          notified_at: null,
          delivered_at: null,
        });
      }
      writeJson(mailboxPath, mailbox);
    }
    process.stdout.write(JSON.stringify({ event: 'SnapshotCaptured' }) + '\\n');
    process.exit(0);
  }

  case 'CreateMailboxMessage': {
    mailbox.records.push({ team_name: command.team_name,
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
    const candidates = mailbox.records.filter((entry) => entry.message_id === command.message_id);
    const scoped = candidates.filter((entry) => command.team_name != null && entry.team_name === command.team_name);
    const record = scoped.length === 1 ? scoped[0] : scoped.length === 0 && candidates.length === 1 && candidates[0].team_name == null ? candidates[0] : null;
    if (!record || record.delivered_at) process.exit(1);
    if (record) {
      record.notified_at = timestamp;
      writeJson(mailboxPath, mailbox);
    }
    process.stdout.write(JSON.stringify({ event: 'MailboxNotified', message_id: command.message_id }) + '\\n');
    process.exit(0);
  }
  case 'MarkMailboxDelivered': {
    const candidates = mailbox.records.filter((entry) => entry.message_id === command.message_id);
    const scoped = candidates.filter((entry) => command.team_name != null && entry.team_name === command.team_name);
    const record = scoped.length === 1 ? scoped[0] : scoped.length === 0 && candidates.length === 1 && candidates[0].team_name == null ? candidates[0] : null;
    if (!record || record.delivered_at) process.exit(1);
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
  printf '{"schema_version":1,"capabilities":["team-mailbox-scope-v1"],"commands":["acquire-authority","renew-authority","queue-dispatch","mark-notified","mark-delivered","mark-failed","remove-dispatch-records","request-replay","capture-snapshot"],"events":[],"transport":"tmux"}\n'
  exit 0
fi
if [[ "\${1:-}" == "exec-scoped" ]]; then
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
      const queueLine = runtimeLog.split('\n').find((line) => line.startsWith('exec-scoped {"command":"QueueDispatch"'));
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

  it('hides unscoped bridge dispatch records instead of assigning them to the caller Team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-unscoped-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('dispatch-scope-alpha', 't', 'executor', 1, cwd);
      await initTeamState('dispatch-scope-beta', 't', 'executor', 1, cwd);
      await writeFile(join(cwd, '.omx', 'state', 'events.json'), '[]');
      const compatPath = join(cwd, '.omx', 'state', 'dispatch.json');
      await writeFile(compatPath, JSON.stringify({ records: [
        {
          request_id: 'unscoped-request', target: 'worker-1', status: 'pending', created_at: '2026-01-01T00:00:00.000Z',
          notified_at: null, delivered_at: null, failed_at: null, reason: 'foreign prompt', metadata: { kind: 'inbox' },
        },
        {
          request_id: 'beta-request', target: 'worker-1', status: 'pending', created_at: '2026-01-01T00:00:00.000Z',
          notified_at: null, delivered_at: null, failed_at: null, reason: 'beta prompt',
          metadata: { kind: 'inbox', team_name: 'dispatch-scope-beta', trigger_message: 'beta prompt' },
        },
      ] }));

      assert.deepEqual(await listDispatchRequests('dispatch-scope-alpha', cwd), []);
      assert.deepEqual((await listDispatchRequests('dispatch-scope-beta', cwd)).map((request) => request.request_id), ['beta-request']);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not convert semantic QueueDispatch failures into JSON-only requests', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-semantic-failure-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousRejectQueue = process.env.OMX_TEST_REJECT_QUEUE_DISPATCH;
    try {
      const teamName = 'dispatch-semantic-failure';
      const runtimePath = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_REJECT_QUEUE_DISPATCH = '1';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      await writeFile(join(cwd, '.omx', 'state', 'events.json'), '[]');

      await assert.rejects(
        () => enqueueDispatchRequest(teamName, {
          kind: 'inbox', to_worker: 'worker-1', trigger_message: 'do not queue on corrupted runtime state',
        }, cwd),
        /exec-scoped failed/,
      );
      assert.deepEqual(await listDispatchRequests(teamName, cwd), []);
      const compatPath = join(cwd, '.omx', 'state', 'dispatch.json');
      assert.deepEqual(JSON.parse(await readFile(compatPath, 'utf8')).records, []);
      assert.deepEqual(JSON.parse(await readFile(join(cwd, '.omx', 'state', 'events.json'), 'utf8')), []);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousRejectQueue === undefined) delete process.env.OMX_TEST_REJECT_QUEUE_DISPATCH;
      else process.env.OMX_TEST_REJECT_QUEUE_DISPATCH = previousRejectQueue;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not downgrade semantic dispatch finalization failures to JSON success', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-dispatch-finalization-semantic-failure-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousRejectDelivered = process.env.OMX_TEST_REJECT_MARK_DELIVERED;
    try {
      const teamName = 'disp-final-semantic-failure';
      const runtimePath = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const request = (await enqueueDispatchRequest(teamName, {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'do not fake delivery',
      }, cwd)).request;
      await markDispatchRequestNotified(teamName, request.request_id, {}, cwd);

      process.env.OMX_TEST_REJECT_MARK_DELIVERED = '1';
      await assert.rejects(
        () => markDispatchRequestDelivered(teamName, request.request_id, {}, cwd),
        /exec-scoped failed/,
      );
      assert.equal((await readDispatchRequest(teamName, request.request_id, cwd))?.status, 'notified');
      await assert.rejects(
        readFile(join(cwd, '.omx', 'state', 'team', teamName, 'dispatch', 'runtime-finalizations.jsonl')),
        { code: 'ENOENT' },
      );
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousRejectDelivered === undefined) delete process.env.OMX_TEST_REJECT_MARK_DELIVERED;
      else process.env.OMX_TEST_REJECT_MARK_DELIVERED = previousRejectDelivered;
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
      const removalLine = runtimeLog.split('\n').find((line) => line.startsWith('exec-scoped {"command":"RemoveDispatchRecords"'));
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

  it('removes mixed fallback and runtime dispatches without sending local-only IDs to Rust', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-mixed-removal-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'dispatch', 'executor', 2, cwd);
      await initTeamState('beta', 'dispatch', 'executor', 1, cwd);
      const local = [];
      for (const worker of ['worker-1', 'worker-2']) {
        local.push((await enqueueDispatchRequest('alpha', {
          kind: 'inbox', to_worker: worker, trigger_message: 'degraded ' + worker,
        }, cwd)).request.request_id);
      }
      const runtime = join(cwd, 'runtime');
      const log = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtime, log);
      process.env.OMX_RUNTIME_BINARY = runtime;
      const native = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'runtime owned',
      }, cwd);
      const foreign = await enqueueDispatchRequest('beta', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'foreign runtime request',
      }, cwd);
      assert.equal((await listDispatchRequests('alpha', cwd)).length, 3);
      await removeDispatchRequestsForWorkers('alpha', ['worker-1'], cwd);
      assert.deepEqual((await listDispatchRequests('alpha', cwd)).map(row => row.request_id), [local[1]]);
      await removeDispatchRequestsForWorkers('alpha', ['worker-2'], cwd);
      assert.deepEqual(await listDispatchRequests('alpha', cwd), []);
      assert.deepEqual(JSON.parse(await readFile(join(cwd, '.omx/state/team/alpha/dispatch/requests.json'), 'utf8')), []);
      assert.equal((await readDispatchRequest('beta', foreign.request.request_id, cwd))?.status, 'pending');
      const removals = (await readFile(log, 'utf8')).split('\n')
        .filter(line => line.startsWith('exec-scoped {"command":"RemoveDispatchRecords"'))
        .map(line => JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf(' --state-dir='))).request_ids);
      assert.deepEqual(removals, [[native.request.request_id]]);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
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

  it('retains terminal dispatch metadata without changing authoritative lifecycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-terminal-metadata-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('terminal-metadata', 'dispatch', 'executor', 1, cwd);
      for (const status of ['failed', 'delivered'] as const) {
        const { request } = await enqueueDispatchRequest('terminal-metadata', {
          kind: 'inbox', to_worker: 'worker-1', trigger_message: status,
        }, cwd);
        if (status === 'failed') await markDispatchRequestFailed('terminal-metadata', request.request_id, 'hook_failed', cwd);
        else {
          await markDispatchRequestNotified('terminal-metadata', request.request_id, {}, cwd);
          await markDispatchRequestDelivered('terminal-metadata', request.request_id, {}, cwd);
        }
        const original = await readDispatchRequest('terminal-metadata', request.request_id, cwd);
        const projection = await readFile(join(cwd, '.omx/state/dispatch.json'), 'utf8');
        const patched = await transitionDispatchRequest('terminal-metadata', request.request_id, status, status, {
          last_reason: 'fallback_confirmed_after_failed_receipt:tmux', attempt_count: 9,
          failed_at: 'untrusted', delivered_at: 'untrusted',
        }, cwd);
        const reread = await readDispatchRequest('terminal-metadata', request.request_id, cwd);
        assert.deepEqual(patched, reread);
        assert.equal(reread?.last_reason, 'fallback_confirmed_after_failed_receipt:tmux');
        assert.equal(reread?.attempt_count, 9);
        assert.equal(reread?.status, status);
        assert.equal(reread?.failed_at, original?.failed_at);
        assert.equal(reread?.delivered_at, original?.delivered_at);
        assert.equal((await listDispatchRequests('terminal-metadata', cwd)).find(row => row.request_id === request.request_id)?.attempt_count, 9);
        assert.equal(await readFile(join(cwd, '.omx/state/dispatch.json'), 'utf8'), projection);
      }
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retains retry metadata after authoritative dispatch transitions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-transition-metadata-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('transition-metadata', 'dispatch', 'executor', 1, cwd);
      const { request } = await enqueueDispatchRequest('transition-metadata', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'transition',
      }, cwd);
      const notified = await transitionDispatchRequest('transition-metadata', request.request_id, 'pending', 'notified', {
        attempt_count: 4, last_reason: 'notified locally', notified_at: 'untrusted',
      }, cwd);
      assert.equal(notified?.attempt_count, 4);
      assert.notEqual(notified?.notified_at, 'untrusted');
      const delivered = await transitionDispatchRequest('transition-metadata', request.request_id, 'notified', 'delivered', {
        attempt_count: 7, last_reason: 'delivery confirmed locally', delivered_at: 'untrusted',
      }, cwd);
      assert.equal(delivered?.attempt_count, 7);
      assert.equal(delivered?.last_reason, 'delivery confirmed locally');
      assert.equal(delivered?.status, 'delivered');
      assert.notEqual(delivered?.delivered_at, 'untrusted');
      assert.deepEqual(await readDispatchRequest('transition-metadata', request.request_id, cwd), delivered);
      const projection = JSON.parse(await readFile(join(cwd, '.omx/state/dispatch.json'), 'utf8'));
      assert.notEqual(projection.records[0].reason, 'delivery confirmed locally');
      const second = await enqueueDispatchRequest('transition-metadata', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'default retry count',
      }, cwd);
      assert.equal((await transitionDispatchRequest('transition-metadata', second.request.request_id, 'pending', 'failed', {}, cwd))?.attempt_count, 1);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('tolerates a finalization journal removed between its existence check and read', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-journal-race-'));
    const stateDir = join(cwd, '.omx/state');
    const journal = join(stateDir, 'team/alpha/dispatch/runtime-finalizations.jsonl');
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const originalExistsSync = fs.existsSync;
    try {
      await mkdir(join(stateDir, 'team/alpha/dispatch'), { recursive: true });
      await writeFile(join(stateDir, 'team/alpha/dispatch/requests.json'), '[]');
      await writeFile(join(stateDir, 'events.json'), '[]');
      await writeFile(journal, '{"command":"MarkDelivered","request_id":"gone"}\n');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      t.mock.method(fs, 'existsSync', (path: fs.PathLike) => {
        const exists = originalExistsSync(path);
        if (path === journal && exists) fs.unlinkSync(journal);
        return exists;
      });
      syncBuiltinESMExports();
      assert.deepEqual(await readDispatchRequests('alpha', cwd, [], stateDir), []);
      await rm(journal, { force: true });
      assert.deepEqual(await readDispatchRequests('alpha', cwd, [], stateDir), []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
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
      assert.equal(await markMessageDelivered('missing-team', 'worker-2', 'missing-message', cwd), false);
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

  it('skips legacy ownership scans when shadow messages have complete scoped runtime records', () => {
    const message = {
      message_id: 'scoped-message',
      from_worker: 'leader-fixed',
      to_worker: 'worker-1',
      body: 'complete payload',
      created_at: '2026-10-16T00:00:00.000Z',
    };
    const mailbox = { worker: 'worker-1', messages: [message] };
    const scopedRecord = { ...message, team_name: 'alpha', notified_at: null, delivered_at: null };
    assert.equal(needsLegacyMailboxEvidence('alpha', 'worker-1', mailbox, [scopedRecord]), false);
    assert.equal(needsLegacyMailboxEvidence('alpha', 'worker-1', mailbox, []), true);
    assert.equal(needsLegacyMailboxEvidence('alpha', 'worker-1', mailbox, [{ ...scopedRecord, body: '' }]), true);
  });

  it('keeps concurrent delivery acknowledgements idempotent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-concurrent-ack-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const teamName = 'concurrent-ack';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage(teamName, 'leader-fixed', 'worker-1', 'hello', cwd);
      let lockTail: Promise<void> = Promise.resolve();
      const deps = {
        teamName, cwd,
        withMailboxLock: async <T>(_team: string, _worker: string, _cwd: string, fn: () => Promise<T>): Promise<T> => {
          const previous = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>((resolve) => { release = resolve; });
          await previous;
          try { return await fn(); } finally { release(); }
        },
        readMailbox: async (): Promise<TeamMailbox> => {
          const records = JSON.parse(readFileSync(join(cwd, '.omx', 'state', 'mailbox.json'), 'utf8')).records;
          const snapshot = { worker: 'worker-1', messages: records.map(normalizeBridgeMailboxMessage) };
          // Let concurrent callers observe the same pending snapshot before either acknowledges it.
          await new Promise<void>((resolve) => setImmediate(resolve));
          return snapshot;
        },
        writeMailbox: async (_team: string, mailbox: TeamMailbox) => {
          await writeFile(join(cwd, '.omx', 'state', 'team', teamName, 'mailbox', 'worker-1.json'), JSON.stringify(mailbox));
        },
        appendTeamEvent: async () => {},
        readTeamConfig: async () => null,
      };
      assert.deepEqual(await Promise.allSettled([
        markMessageDeliveredWithDeps('worker-1', message.message_id, deps),
        markMessageDeliveredWithDeps('worker-1', message.message_id, deps),
      ]), [{ status: 'fulfilled', value: true }, { status: 'fulfilled', value: true }]);
      assert.equal((await readFile(runtimeLogPath, 'utf8')).split('MarkMailboxDelivered').length - 1, 1);
      assert.ok((await listMailboxMessages(teamName, 'worker-1', cwd))[0].delivered_at);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers direct and broadcast dispatch after a post-notify runtime downgrade', async () => {
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
    for (const mode of ['direct', 'broadcast'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-mcp-runtime-swap-'));
      try {
        const teamName = 'runtime-swap';
        await initTeamState(teamName, 't', 'executor', 2, cwd);
        const runtimePath = join(cwd, 'runtime');
        const logPath = join(cwd, 'runtime.log');
        await writeCompatRuntimeFixture(runtimePath, logPath);
        process.env.OMX_RUNTIME_BINARY = runtimePath;
        process.env.OMX_RUNTIME_BRIDGE = '1';
        const notified: string[] = [];
        const notify: TeamNotifier = async (target) => {
          notified.push(target.workerName);
          if (notified.length === 1) await writeFile(runtimePath, '#!/usr/bin/env node\nconsole.log(JSON.stringify({version:1,capabilities:[]}));\n');
          return { ok: true, transport: 'tmux_send_keys', reason: 'sent' };
        };
        const send = () => mode === 'direct'
          ? queueDirectMailboxMessage({ teamName, fromWorker: 'leader-fixed', toWorker: 'worker-1', toWorkerIndex: 1,
            body: 'direct', triggerMessage: 'read inbox', cwd, notify })
          : queueBroadcastMailboxMessage({ teamName, fromWorker: 'leader-fixed', body: 'broadcast', cwd, notify,
            recipients: [{ workerName: 'worker-1', workerIndex: 1 }, { workerName: 'worker-2', workerIndex: 2 }],
            triggerFor: () => 'read broadcast inbox' });
        await assert.rejects(send, /team-mailbox-scope-v1/);
        assert.equal((await listDispatchRequests(teamName, cwd))[0].status, 'notified');
        const stateDir = join(cwd, '.omx', 'state');
        const journal = join(stateDir, 'team', teamName, 'dispatch', 'runtime-finalizations.jsonl');
        assert.equal(JSON.parse((await readFile(journal, 'utf8')).trim()).command, 'MarkNotified');
        assert.equal((await listMailboxMessages(teamName, 'worker-1', cwd))[0].notified_at, undefined);
        await writeCompatRuntimeFixture(runtimePath, logPath);
        // Model runtime event replay replacing the temporary JS projection.
        const projectionPath = join(stateDir, 'dispatch.json');
        const projection = JSON.parse(await readFile(projectionPath, 'utf8'));
        for (const record of projection.records) record.status = 'pending';
        await writeFile(projectionPath, JSON.stringify(projection));
        let reinjections = 0;
        const drain = () => drainPendingTeamDispatch({ cwd, injector: async () => {
          reinjections += 1;
          return { ok: true, reason: 'unexpected' };
        } });
        await drain();
        assert.equal(reinjections, 0);
        assert.equal(existsSync(journal), false);
        await send();
        assert.deepEqual(notified, mode === 'direct' ? ['worker-1'] : ['worker-1', 'worker-2']);
        await drain();
        assert.equal(reinjections, 0);
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('finishes direct and broadcast notification when workers acknowledge before notify returns', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-fast-consumer-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const teamName = 'fast-consumer';
      await initTeamState(teamName, 't', 'executor', 2, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      const logPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, logPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const notified: string[] = [];
      const notify: TeamNotifier = async (target, _text, context) => {
        assert.ok(context.message_id);
        assert.equal(await markMessageDelivered(teamName, target.workerName, context.message_id, cwd), true);
        notified.push(target.workerName);
        return { ok: true, transport: 'tmux_send_keys', reason: 'sent' };
      };
      const direct = await queueDirectMailboxMessage({
        teamName, fromWorker: 'leader-fixed', toWorker: 'worker-1', toWorkerIndex: 1,
        body: 'direct', triggerMessage: 'read inbox', cwd, notify,
      });
      assert.equal(direct.ok, true);
      const broadcast = await queueBroadcastMailboxMessage({
        teamName, fromWorker: 'leader-fixed', body: 'broadcast', cwd, notify,
        recipients: [{ workerName: 'worker-1', workerIndex: 1 }, { workerName: 'worker-2', workerIndex: 2 }],
        triggerFor: () => 'read broadcast inbox',
      });
      assert.deepEqual(broadcast.map((outcome) => outcome.ok), [true, true]);
      assert.deepEqual(notified, ['worker-1', 'worker-1', 'worker-2']);
      assert.deepEqual((await listDispatchRequests(teamName, cwd)).map((request) => request.status), ['notified', 'notified', 'notified']);
      assert.equal((await readFile(logPath, 'utf8')).includes('MarkMailboxNotified'), false);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('publishes fallback mailbox ownership before releasing the mailbox lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-fallback-dedupe-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
    process.env.OMX_RUNTIME_BRIDGE = '1';
    let lockTail: Promise<void> = Promise.resolve();
    let lockHeld = false;
    let mailbox: TeamMailbox = { worker: 'worker-1', messages: [] };
    let writes = 0;
    let events = 0;
    const eventIds = new Set<string>();
    const copyMailbox = (source: TeamMailbox): TeamMailbox => ({
      worker: source.worker,
      messages: source.messages.map((message) => ({ ...message })),
    });
    const deps = {
      teamName: 'mailbox-fallback-dedupe',
      cwd,
      withMailboxLock: async <T>(_teamName: string, _workerName: string, _cwd: string, fn: () => Promise<T>): Promise<T> => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        lockHeld = true;
        try {
          return await fn();
        } finally {
          lockHeld = false;
          release();
        }
      },
      readMailbox: async (): Promise<TeamMailbox> => copyMailbox({
        worker: mailbox.worker,
        messages: mailbox.messages.filter((message) => eventIds.has(message.message_id)),
      }),
      readLegacyMailbox: async (): Promise<TeamMailbox> => copyMailbox(mailbox),
      writeMailbox: async (_teamName: string, updated: TeamMailbox): Promise<void> => {
        mailbox = copyMailbox(updated);
        writes += 1;
      },
      appendTeamEvent: async (_teamName: string, event: { message_id?: string | null }): Promise<void> => {
        assert.equal(lockHeld, true, 'fallback ownership evidence must be published under the mailbox lock');
        events += 1;
        if (typeof event.message_id === 'string') eventIds.add(event.message_id);
      },
      readTeamConfig: async (): Promise<{ created_at: string; workers: Array<{ name: string }> }> => ({
        created_at: '2000-01-01T00:00:00.000Z',
        workers: [],
      }),
    };

    try {
      const [first, second] = await Promise.all([
        sendDirectMessageWithDeps('leader-fixed', 'worker-1', 'same body', deps),
        sendDirectMessageWithDeps('leader-fixed', 'worker-1', 'same body', deps),
      ]);
      assert.equal(first.message_id, second.message_id);
      assert.equal(mailbox.messages.length, 1);
      assert.equal(writes, 1);
      assert.equal(events, 1);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('isolates shared bridge mailboxes and mutations by Team, including repeated recipient names', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-isolation-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('mailbox-alpha', 't', 'executor', 1, cwd);
      await initTeamState('mailbox-beta', 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';

      for (const recipient of ['worker-1', 'leader-fixed']) {
        const alpha = await sendDirectMessage('mailbox-alpha', 'worker-1', recipient, 'same body', cwd);
        // Old readers could have copied Alpha's records into Beta's shadow.
        const betaShadowPath = join(cwd, '.omx', 'state', 'team', 'mailbox-beta', 'mailbox', `${recipient}.json`);
        await writeFile(betaShadowPath, JSON.stringify({ worker: recipient, messages: [alpha] }));
        assert.deepEqual(await listMailboxMessages('mailbox-beta', recipient, cwd), []);
        const logBefore = await readFile(runtimeLogPath, 'utf8');
        assert.equal(await markMessageNotified('mailbox-beta', recipient, alpha.message_id, cwd), false);
        assert.equal(await markMessageDelivered('mailbox-beta', recipient, alpha.message_id, cwd), false);
        assert.equal(await readFile(runtimeLogPath, 'utf8'), logBefore, 'foreign IDs must not reach the runtime');

        const beta = await sendDirectMessage('mailbox-beta', 'worker-1', recipient, 'same body', cwd);
        assert.notEqual(alpha.message_id, beta.message_id, 'deduplication must stay within the Team');
        assert.deepEqual((await listMailboxMessages('mailbox-alpha', recipient, cwd)).map((m) => m.message_id), [alpha.message_id]);
        assert.deepEqual((await listMailboxMessages('mailbox-beta', recipient, cwd)).map((m) => m.message_id), [beta.message_id]);
        assert.equal(await markMessageNotified('mailbox-beta', recipient, beta.message_id, cwd), true);
        assert.equal(await markMessageDelivered('mailbox-beta', recipient, beta.message_id, cwd), true);
        const [pending] = await listMailboxMessages('mailbox-alpha', recipient, cwd);
        assert.equal(pending.notified_at, undefined);
        assert.equal(pending.delivered_at, undefined);
      }
      await assert.rejects(() => retireTeamMailboxMessages('mailbox-beta', [], cwd), /authoritative_mailbox_retirement_discovery_failed/);
      assert.equal(await retireTeamMailboxMessages('mailbox-alpha', [], cwd), 2);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires creation evidence for unscoped legacy records even when another Team shadow is polluted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-legacy-ownership-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('legacy-alpha', 't', 'executor', 1, cwd);
      await initTeamState('legacy-beta', 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const alpha = await sendDirectMessage('legacy-alpha', 'leader-fixed', 'worker-1', 'same', cwd);
      const beta = await sendDirectMessage('legacy-beta', 'leader-fixed', 'worker-1', 'different', cwd);
      const orphan = { ...alpha, message_id: 'unproven' };
      const shadowPath = (team: string) => join(cwd, '.omx', 'state', 'team', team, 'mailbox', 'worker-1.json');
      await writeFile(shadowPath('legacy-alpha'), JSON.stringify({ worker: 'worker-1', messages: [alpha, orphan] }));
      await writeFile(shadowPath('legacy-beta'), JSON.stringify({ worker: 'worker-1', messages: [alpha, beta] }));
      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
      for (const record of compat.records) delete record.team_name;
      compat.records.push({ ...compat.records[0], message_id: orphan.message_id });
      await writeFile(compatPath, JSON.stringify(compat));

      assert.deepEqual((await listMailboxMessages('legacy-alpha', 'worker-1', cwd)).map((m) => m.message_id), [alpha.message_id]);
      assert.deepEqual((await listMailboxMessages('legacy-beta', 'worker-1', cwd)).map((m) => m.message_id), [beta.message_id]);
      assert.equal(await markMessageNotified('legacy-beta', 'worker-1', alpha.message_id, cwd), false);
      assert.equal(await markMessageDelivered('legacy-beta', 'worker-1', alpha.message_id, cwd), false);
      const fresh = await sendDirectMessage('legacy-beta', 'leader-fixed', 'worker-1', 'same', cwd);
      assert.notEqual(fresh.message_id, alpha.message_id, 'polluted shadows must not deduplicate foreign messages');
      await assert.rejects(() => retireTeamMailboxMessages('legacy-beta', ['worker-1'], cwd), /authoritative_mailbox_retirement_discovery_failed/);
      const remaining = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ message_id: string; delivered_at: string | null }> };
      assert.equal(remaining.records.find((r) => r.message_id === alpha.message_id)?.delivered_at, null);
      assert.equal(remaining.records.find((r) => r.message_id === orphan.message_id)?.delivered_at, null);
      assert.equal(await markMessageNotified('legacy-alpha', 'worker-1', alpha.message_id, cwd), true);
      assert.equal(await markMessageDelivered('legacy-alpha', 'worker-1', alpha.message_id, cwd), true);
      const shadow = JSON.parse(await readFile(shadowPath('legacy-alpha'), 'utf8')) as { messages: typeof alpha[] };
      assert.deepEqual(shadow.messages.find((message) => message.message_id === orphan.message_id), JSON.parse(JSON.stringify(orphan)));
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an incompatible runtime before writing a provisional mailbox row', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-send-preflight-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('send-preflight', 't', 'executor', 1, cwd);
      await sendDirectMessage('send-preflight', 'leader-fixed', 'worker-1', 'existing', cwd);
      const root = join(cwd, '.omx', 'state');
      const teamDir = join(root, 'team', 'send-preflight');
      const shadowPath = join(teamDir, 'mailbox', 'worker-1.json');
      const eventPath = join(teamDir, 'events', 'events.ndjson');
      const before = await Promise.all([shadowPath, eventPath, join(root, 'mailbox.json')].map((path) => readFile(path, 'utf8')));
      const supported = await readFile(runtimePath, 'utf8');
      await writeFile(runtimePath, supported.replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []'));
      for (const recipient of ['worker-1', 'leader-fixed']) {
        for (let retry = 0; retry < 2; retry += 1) {
          await assert.rejects(() => sendDirectMessage('send-preflight', 'leader-fixed', recipient, 'new', cwd), /team-mailbox-scope-v1/);
          assert.deepEqual(await Promise.all([shadowPath, eventPath, join(root, 'mailbox.json')].map((path) => readFile(path, 'utf8'))), before);
          assert.equal(existsSync(join(teamDir, 'mailbox', 'leader-fixed.json')), false);
        }
      }
      await writeFile(runtimePath, supported);
      await sendDirectMessage('send-preflight', 'leader-fixed', 'worker-1', 'new', cwd);
      assert.equal(await retireTeamMailboxMessages('send-preflight', ['worker-1'], cwd), 2);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes only its provisional row if the runtime changes after send preflight', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-send-preflight-race-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('preflight-race', 't', 'executor', 1, cwd);
      const existing = await sendDirectMessage('preflight-race', 'leader-fixed', 'worker-1', 'existing', cwd);
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'preflight-race', 'mailbox', 'worker-1.json');
      const recovery = { ...existing, body: 'keep this recovery payload' };
      await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [recovery, existing] }, null, 2));
      const before = await readFile(shadowPath, 'utf8');
      const supported = await readFile(runtimePath, 'utf8');
      let replaced = false;
      setWriteAtomicRenameForTests(async (source, destination) => {
        if (!replaced && destination === shadowPath) {
          replaced = true;
          await writeFile(runtimePath, supported.replace("capabilities: ['team-mailbox-scope-v1']", 'capabilities: []'));
        }
        await rename(source, destination);
      });
      await assert.rejects(() => sendDirectMessage('preflight-race', 'leader-fixed', 'worker-1', 'new', cwd), /team-mailbox-scope-v1/);
      assert.equal(replaced, true);
      assert.equal(await readFile(shadowPath, 'utf8'), before);
      resetWriteAtomicRenameForTests();
      await writeFile(runtimePath, supported);
      await assert.rejects(() => retireTeamMailboxMessages('preflight-race', ['worker-1'], cwd), /authoritative_mailbox_retirement_discovery_failed/);
    } finally {
      resetWriteAtomicRenameForTests();
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('propagates rejected mailbox acknowledgements without changing shadow data', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-rejected-ack-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('ambiguous-ack', 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const own = await sendDirectMessage('ambiguous-ack', 'leader-fixed', 'worker-1', 'own', cwd);
      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
      compat.records.push({ ...compat.records[0], body: 'ambiguous' });
      await writeFile(compatPath, JSON.stringify(compat));
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'ambiguous-ack', 'mailbox', 'worker-1.json');
      const before = await readFile(shadowPath, 'utf8');
      const authoritativeBefore = await readFile(compatPath, 'utf8');
      for (const mutate of [markMessageNotified, markMessageDelivered]) {
        await assert.rejects(() => mutate('ambiguous-ack', 'worker-1', own.message_id, cwd), /omx-runtime exec-scoped failed/);
        assert.equal(await readFile(shadowPath, 'utf8'), before);
        assert.equal(await readFile(compatPath, 'utf8'), authoritativeBefore);
      }
      compat.records[0].delivered_at = new Date().toISOString();
      await writeFile(compatPath, JSON.stringify(compat));
      await assert.rejects(() => markMessageDelivered('ambiguous-ack', 'worker-1', own.message_id, cwd), /omx-runtime exec-scoped failed/);
      assert.equal(await readFile(shadowPath, 'utf8'), before);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves colliding recovery rows when mirroring a scoped acknowledgement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-shadow-collision-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('shadow-collision', 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const own = await sendDirectMessage('shadow-collision', 'leader-fixed', 'worker-1', 'own', cwd);
      const recovery = { ...own, body: 'recover this legacy payload' };
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'shadow-collision', 'mailbox', 'worker-1.json');
      await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [recovery, recovery, own] }));
      for (const mutate of [
        () => markMessageNotified('shadow-collision', 'worker-1', own.message_id, cwd),
        () => markMessageDelivered('shadow-collision', 'worker-1', own.message_id, cwd),
      ]) {
        assert.equal(await mutate(), true);
        const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: typeof own[] };
        assert.deepEqual(shadow.messages.filter((message) => message.body === recovery.body), [recovery, recovery].map((message) => JSON.parse(JSON.stringify(message))));
        assert.equal(shadow.messages.length, 3);
      }
      const before = await readFile(shadowPath, 'utf8');
      for (let retry = 0; retry < 2; retry += 1) {
        await assert.rejects(() => retireTeamMailboxMessages('shadow-collision', ['worker-1'], cwd), /authoritative_mailbox_retirement_discovery_failed/);
        assert.equal(await readFile(shadowPath, 'utf8'), before);
        assert.ok(await readTeamConfig('shadow-collision', cwd));
      }
      const shadow = JSON.parse(before) as TeamMailbox;
      shadow.messages = shadow.messages.filter((message) => message.body !== recovery.body);
      await writeFile(shadowPath, JSON.stringify(shadow));
      assert.equal(await retireTeamMailboxMessages('shadow-collision', ['worker-1'], cwd), 0);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects colliding legacy IDs even with valid creation evidence for both Teams', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-id-collision-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('collision-alpha', 't', 'executor', 1, cwd);
      await initTeamState('collision-beta', 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const alpha = await sendDirectMessage('collision-alpha', 'leader-fixed', 'worker-1', 'alpha secret', cwd);
      const beta = await sendDirectMessage('collision-beta', 'leader-fixed', 'worker-1', 'beta secret', cwd);
      const betaDir = join(cwd, '.omx', 'state', 'team', 'collision-beta');
      await writeFile(join(betaDir, 'mailbox', 'worker-1.json'), JSON.stringify({
        worker: 'worker-1', messages: [{ ...beta, message_id: alpha.message_id }],
      }));
      const journalPath = join(betaDir, 'events', 'events.ndjson');
      await writeFile(journalPath, (await readFile(journalPath, 'utf8')).replaceAll(beta.message_id, alpha.message_id));
      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
      for (const record of compat.records) {
        delete record.team_name;
        record.message_id = alpha.message_id;
      }
      const before = JSON.stringify(compat);
      await writeFile(compatPath, before);
      const logBefore = await readFile(runtimeLogPath, 'utf8');
      for (const team of ['collision-alpha', 'collision-beta']) {
        assert.deepEqual(await listMailboxMessages(team, 'worker-1', cwd), []);
        assert.equal(await markMessageNotified(team, 'worker-1', alpha.message_id, cwd), false);
        assert.equal(await markMessageDelivered(team, 'worker-1', alpha.message_id, cwd), false);
        await assert.rejects(() => retireTeamMailboxMessages(team, ['worker-1'], cwd), /authoritative_mailbox_retirement_discovery_failed/);
      }
      assert.equal(await readFile(compatPath, 'utf8'), before);
      assert.doesNotMatch((await readFile(runtimeLogPath, 'utf8')).slice(logBefore.length), /MarkMailbox/, 'ambiguous IDs must not be acknowledged');
      const fresh = await sendDirectMessage('collision-beta', 'leader-fixed', 'worker-1', 'beta secret', cwd);
      assert.notEqual(fresh.message_id, alpha.message_id, 'deduplication must not reuse an ambiguous ID');
      assert.equal(await markMessageDelivered('collision-beta', 'worker-1', fresh.message_id, cwd), true);
      const mixed = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
      mixed.records[1].team_name = 'collision-beta';
      await writeFile(compatPath, JSON.stringify(mixed));
      assert.equal((await listMailboxMessages('collision-beta', 'worker-1', cwd))
        .find((message) => message.message_id === alpha.message_id)?.body, 'beta secret');
      assert.equal((await listMailboxMessages('collision-alpha', 'worker-1', cwd))
        .find((message) => message.message_id === alpha.message_id)?.body, 'alpha secret');
      assert.equal(await markMessageNotified('collision-beta', 'worker-1', alpha.message_id, cwd), true);
      assert.equal(await retireTeamMailboxMessages('collision-beta', ['worker-1'], cwd), 1);
      const after = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ notified_at: string | null; delivered_at: string | null }> };
      assert.equal(after.records[0].notified_at, null);
      assert.equal(after.records[0].delivered_at, null);
      assert.ok(after.records[1].notified_at);
      assert.ok(after.records[1].delivered_at);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a proven legacy message when a foreign scoped row reuses its ID', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-foreign-scoped-id-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('legacy-scope-alpha', 't', 'executor', 1, cwd);
      await initTeamState('legacy-scope-beta', 't', 'executor', 1, cwd);
      const own = await sendDirectMessage('legacy-scope-alpha', 'leader-fixed', 'worker-1', 'alpha private message', cwd);
      const retirement = await sendDirectMessage('legacy-scope-alpha', 'leader-fixed', 'worker-1', 'retirement message', cwd);

      const stateDir = join(cwd, '.omx', 'state');
      const foreign = [own, retirement].map((message) => ({
        team_name: 'legacy-scope-beta',
        message_id: message.message_id,
        from_worker: 'leader-fixed',
        to_worker: 'worker-1',
        body: 'beta private message',
        created_at: new Date().toISOString(),
        notified_at: null,
        delivered_at: null,
      }));
      await writeFile(join(stateDir, 'mailbox.json'), JSON.stringify({ records: foreign }));
      await writeFile(join(stateDir, 'events.json'), '[]');
      const runtimePath = join(cwd, 'runtime');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';

      assert.deepEqual((await listMailboxMessages('legacy-scope-alpha', 'worker-1', cwd)).map((message) => message.body), [own.body, retirement.body]);
      await enqueueDispatchRequest('legacy-scope-alpha', { kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
        message_id: own.message_id, trigger_message: 'read own fallback' }, cwd);
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      await drainPendingTeamDispatch({ cwd, injector: async () => ({ ok: true, reason: 'injected_for_test' }) });
      assert.equal(typeof (await listMailboxMessages('legacy-scope-alpha', 'worker-1', cwd))
        .find((message) => message.message_id === own.message_id)?.notified_at, 'string');
      assert.equal(await markMessageNotified('legacy-scope-alpha', 'worker-1', own.message_id, cwd), true);
      assert.equal(await markMessageDelivered('legacy-scope-alpha', 'worker-1', own.message_id, cwd), true);
      assert.equal(await retireTeamMailboxMessages('legacy-scope-alpha', ['worker-1'], cwd), 1);

      const shadowPath = join(stateDir, 'team', 'legacy-scope-alpha', 'mailbox', 'worker-1.json');
      const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: Array<{ message_id: string; delivered_at?: string }> };
      assert.equal(typeof shadow.messages.find((message) => message.message_id === own.message_id)?.delivered_at, 'string');
      assert.equal(typeof shadow.messages.find((message) => message.message_id === retirement.message_id)?.delivered_at, 'string');
      const compat = JSON.parse(await readFile(join(stateDir, 'mailbox.json'), 'utf8')) as {
        records: Array<{ team_name: string; message_id: string; delivered_at: string | null }>;
      };
      assert.deepEqual(compat.records, foreign);
      assert.doesNotMatch(await readFile(runtimeLogPath, 'utf8'), /MarkMailbox(Notified|Delivered)/);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps bridge-disabled reads, deduplication, and retirement scoped by Team evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-disabled-bridge-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('disabled-alpha', 't', 'executor', 1, cwd);
      await initTeamState('disabled-beta', 't', 'executor', 1, cwd);
      const foreign = await sendDirectMessage('disabled-beta', 'leader-fixed', 'worker-1', 'foreign private data', cwd);
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'disabled-alpha', 'mailbox', 'worker-1.json');
      await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [foreign] }));

      assert.deepEqual(await listMailboxMessages('disabled-alpha', 'worker-1', cwd), []);
      assert.equal(await markMessageNotified('disabled-alpha', 'worker-1', foreign.message_id, cwd), false);
      assert.equal(await markMessageDelivered('disabled-alpha', 'worker-1', foreign.message_id, cwd), false);
      const beforeRetirement = await readFile(shadowPath, 'utf8');
      await assert.rejects(() => retireTeamMailboxMessages('disabled-alpha', ['worker-1'], cwd), /authoritative_mailbox_retirement_discovery_failed/);
      assert.equal(await readFile(shadowPath, 'utf8'), beforeRetirement);

      const own = await sendDirectMessage('disabled-alpha', 'leader-fixed', 'worker-1', 'foreign private data', cwd);
      assert.notEqual(own.message_id, foreign.message_id, 'unproven foreign shadows must not deduplicate local sends');
      assert.deepEqual((await listMailboxMessages('disabled-alpha', 'worker-1', cwd)).map((message) => message.message_id), [own.message_id]);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reads and retires scoped bridge messages when their compatibility shadow is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-missing-shadow-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('scoped-alpha', 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage('scoped-alpha', 'leader-fixed', 'worker-1', 'durable', cwd);
      await unlink(join(cwd, '.omx', 'state', 'team', 'scoped-alpha', 'mailbox', 'worker-1.json'));
      assert.equal((await listMailboxMessages('scoped-alpha', 'worker-1', cwd))[0]?.message_id, message.message_id);
      assert.equal(await retireTeamMailboxMessages('scoped-alpha', ['worker-1'], cwd), 1);
      assert.equal(typeof (await listMailboxMessages('scoped-alpha', 'worker-1', cwd))[0]?.delivered_at, 'string');
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retires a unique scoped provisional shadow without a creation journal', async () => {
    for (const action of ['retire', 'notify', 'deliver', 'hook']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-provisional-retire-'));
      const previousBinary = process.env.OMX_RUNTIME_BINARY;
      const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
      try {
        const runtime = join(cwd, 'runtime');
        await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
        process.env.OMX_RUNTIME_BINARY = runtime;
        process.env.OMX_RUNTIME_BRIDGE = '1';
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const message = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'provisional', cwd);
        const shadowPath = join(cwd, '.omx/state/team/alpha/mailbox/worker-1.json');
        await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [{ ...message, created_at: '2000-01-01T00:00:00Z' }] }));
        await writeFile(join(cwd, '.omx/state/team/alpha/events/events.ndjson'), '');
        if (action === 'notify') assert.equal(await markMessageNotified('alpha', 'worker-1', message.message_id, cwd), true);
        if (action === 'deliver') assert.equal(await markMessageDelivered('alpha', 'worker-1', message.message_id, cwd), true);
        if (action === 'hook') {
          await enqueueDispatchRequest('alpha', { kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
            message_id: message.message_id, trigger_message: 'read provisional' }, cwd);
          const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
          assert.equal((await drainPendingTeamDispatch({ cwd,
            injector: async () => ({ ok: true, reason: 'injected_for_test' }) })).processed, 1);
        }
        assert.equal(JSON.parse(await readFile(shadowPath, 'utf8')).messages.length, 1);
        assert.equal(await retireTeamMailboxMessages('alpha', ['worker-1'], cwd), action === 'deliver' ? 0 : 1);
        const shadow = JSON.parse(await readFile(shadowPath, 'utf8'));
        assert.equal(shadow.messages.length, 1);
        assert.ok(shadow.messages[0].delivered_at);
        assert.ok((await listMailboxMessages('alpha', 'worker-1', cwd))[0].delivered_at);
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('refreshes durable mailbox creations before retiring fallback shadows', async () => {
    for (const shadowState of ['pending', 'delivered', 'missing']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-retire-stale-projection-'));
      const previousBinary = process.env.OMX_RUNTIME_BINARY;
      const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
      const previousCapture = process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
      try {
        process.env.OMX_RUNTIME_BRIDGE = '0';
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const message = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'interrupted creation', cwd);
        if (shadowState === 'delivered') assert.equal(await markMessageDelivered('alpha', 'worker-1', message.message_id, cwd), true);
        const stateDir = join(cwd, '.omx/state');
        await writeFile(join(stateDir, 'mailbox.json'), JSON.stringify({ records: [{ ...message, team_name: 'beta', notified_at: null, delivered_at: null }] }));
        await writeFile(join(stateDir, 'events.json'), JSON.stringify([{ ...message, event: 'MailboxMessageCreated', team_name: 'alpha' }]));
        process.env.OMX_RUNTIME_BRIDGE = '1';
        process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
        const shadowPath = join(stateDir, 'team/alpha/mailbox/worker-1.json');
        if (shadowState === 'missing') await rm(shadowPath);
        const before = await readFile(shadowPath, 'utf8').catch(() => null);
        await assert.rejects(() => retireTeamMailboxMessages('alpha', ['worker-1'], cwd));
        assert.equal(await readFile(shadowPath, 'utf8').catch(() => null), before);
        const runtime = join(cwd, 'runtime');
        await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
        process.env.OMX_RUNTIME_BINARY = runtime;
        process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = '1';
        assert.equal(await retireTeamMailboxMessages('alpha', [], cwd), shadowState === 'delivered' ? 0 : 1);
        const records = JSON.parse(await readFile(join(stateDir, 'mailbox.json'), 'utf8')).records;
        assert.equal(records.length, 2);
        assert.equal(records[0].team_name, 'beta');
        assert.equal(records[0].delivered_at, null);
        assert.equal(records[1].team_name, 'alpha');
        assert.ok(records[1].delivered_at);
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        if (previousCapture === undefined) delete process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
        else process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = previousCapture;
        await rm(cwd, { recursive: true, force: true });
    }
    }
  });

  it('journals runtime finalization while event and compatibility files are mid-write', async () => {
    const { recordRuntimeFinalization } = await import('../state/dispatch-recovery.js');
    const cwd = await mkdtemp(join(tmpdir(), 'omx-finalization-identity-'));
    const command = { command: 'MarkNotified' as const, request_id: 'owned', channel: 'tmux' };
    const journal = join(cwd, 'team/alpha/dispatch/runtime-finalizations.jsonl');
    try {
      await writeFile(join(cwd, 'events.json'), '[{"event":');
      await writeFile(join(cwd, 'dispatch.json'), '{"records":');
      recordRuntimeFinalization(cwd, 'alpha', command);
      assert.equal(existsSync(journal), false);
      for (const version of [{ schema_version: 1 }, { schema_version: 2, ledger_epoch: 1 }]) {
        await writeFile(join(cwd, 'dispatch-seen.json'), JSON.stringify({ ...version, request_ids: ['owned'] }));
        recordRuntimeFinalization(cwd, 'alpha', { ...command, request_id: 'json-only' });
        assert.equal(existsSync(journal), false);
        recordRuntimeFinalization(cwd, 'alpha', command);
        assert.deepEqual(JSON.parse((await readFile(journal, 'utf8')).trim()), command);
        await unlink(journal);
      }
      await writeFile(join(cwd, 'dispatch-seen.json'), JSON.stringify({ schema_version: 2, ledger_epoch: 99, request_ids: ['owned'] }));
      assert.throws(() => recordRuntimeFinalization(cwd, 'alpha', command), /invalid runtime dispatch identity ledger/);
      assert.equal(existsSync(journal), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects mailbox creation failures without publishing a successful fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mailbox-create-failure-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      for (const failure of [
        "process.stderr.write('failed to load authoritative runtime state'); process.exit(1);",
        "process.stdout.write('truncated response'); process.exit(0);",
        "process.stdout.write('{}'); process.exit(0);",
        "process.stdout.write('null'); process.exit(0);",
        "process.stdout.write('[]'); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'SnapshotCaptured'})); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'MailboxMessageCreated',message_id:'wrong-id',from_worker:command.from_worker,to_worker:command.to_worker})); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'MailboxMessageCreated',message_id:command.message_id,from_worker:'other',to_worker:command.to_worker})); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'MailboxMessageCreated',message_id:command.message_id,from_worker:command.from_worker,to_worker:'other'})); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'MailboxMessageCreated',message_id:command.message_id,from_worker:command.from_worker,to_worker:command.to_worker,team_name:'other'})); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'MailboxMessageCreated',message_id:command.message_id,from_worker:command.from_worker,to_worker:command.to_worker,body:'other'})); process.exit(0);",
      ]) {
        await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
        const fixture = await readFile(runtime, 'utf8');
        await writeFile(runtime, fixture.replace("const dir = stateDir();", `if (command.command === 'CreateMailboxMessage') { ${failure} }\nconst dir = stateDir();`));
        await assert.rejects(() => sendDirectMessage('alpha', 'leader-fixed', 'worker-1', failure, cwd),
          /failed to load authoritative runtime state|non-JSON output|invalid mailbox creation acknowledgement/);
        assert.deepEqual(await listMailboxMessages('alpha', 'worker-1', cwd), []);
        const shadow = JSON.parse(await readFile(join(cwd, '.omx/state/team/alpha/mailbox/worker-1.json'), 'utf8'));
        assert.deepEqual(shadow.messages, []);
        assert.doesNotMatch(await readFile(join(cwd, '.omx/state/team/alpha/events/events.ndjson'), 'utf8').catch(() => ''), /message_received/);
      }
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      const fallback = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'offline fallback', cwd);
      assert.equal((await listMailboxMessages('alpha', 'worker-1', cwd))[0]?.message_id, fallback.message_id);
      process.env.OMX_RUNTIME_BINARY = runtime;
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      const native = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'runtime restored', cwd);
      assert.ok((await listMailboxMessages('alpha', 'worker-1', cwd)).some((message) => message.message_id === native.message_id));
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers a partially persisted mailbox creation before allowing a retry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mailbox-partial-persist-'));
    const keys = ['OMX_RUNTIME_BINARY', 'OMX_RUNTIME_BRIDGE', 'OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      const runtime = join(cwd, 'runtime');
      const log = join(cwd, 'runtime.log');
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await writeCompatRuntimeFixture(runtime, log);
      const fixture = await readFile(runtime, 'utf8');
      await writeFile(runtime, fixture.replace("  case 'CreateMailboxMessage': {", `  case 'CreateMailboxMessage': {
    writeJson(path.join(dir, 'events.json'), [{ ...command, event: 'MailboxMessageCreated' }]);
    process.stderr.write('persist failed: mailbox snapshot is read-only'); process.exit(1);`));
      const send = () => sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'partial creation', cwd);
      await assert.rejects(send, /persist failed/);
      const stateDir = join(cwd, '.omx/state');
      const eventsPath = join(stateDir, 'events.json');
      const committed = await readFile(eventsPath, 'utf8');
      const originalId = JSON.parse(committed)[0].message_id;
      assert.deepEqual(await listMailboxMessages('alpha', 'worker-1', cwd), []);
      await writeFile(join(stateDir, 'mailbox.json'), JSON.stringify({ records: [] }));
      for (const response of [
        "process.stderr.write('recovery unavailable'); process.exit(1);",
        "process.stdout.write('{}'); process.exit(0);",
        "process.stdout.write(JSON.stringify({event:'SnapshotCaptured'})); process.exit(0);",
      ]) {
        await writeFile(runtime, fixture.replace("  case 'CaptureSnapshot': {", `  case 'CaptureSnapshot': { ${response}`));
        await assert.rejects(send, /recovery unavailable|mailbox creation recovery/);
        assert.equal(await readFile(eventsPath, 'utf8'), committed);
      }
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      await assert.rejects(send, /omx-runtime/);
      process.env.OMX_RUNTIME_BINARY = runtime;
      await writeFile(eventsPath, '{}');
      await assert.rejects(send, /invalid runtime mailbox event log/);
      await writeFile(eventsPath, committed);
      await writeFile(runtime, fixture);
      const retried = await Promise.all(Array.from({ length: 4 }, send));
      assert.ok(retried.every(message => message.message_id === originalId));
      assert.equal((await listMailboxMessages('alpha', 'worker-1', cwd)).length, 1);
      assert.equal(await readFile(eventsPath, 'utf8'), committed);
      assert.equal((await readFile(log, 'utf8')).split('"command":"CreateMailboxMessage"').length - 1, 1);
      assert.equal(await markMessageDelivered('alpha', 'worker-1', originalId, cwd), true);
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      const offline = await send();
      assert.notEqual(offline.message_id, originalId, 'a confirmed delivered message must not block normal offline fallback');
      assert.ok((await listMailboxMessages('alpha', 'worker-1', cwd)).some(message => message.message_id === offline.message_id));
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('deduplicates against the verified projection when another reader refreshes it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mailbox-refresh-race-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const stateDir = join(cwd, '.omx/state');
      await mkdir(stateDir, { recursive: true });
      const message = {
        message_id: 'committed', from_worker: 'leader-fixed', to_worker: 'worker-1',
        body: 'retry', created_at: new Date().toISOString(),
      };
      await writeFile(join(stateDir, 'events.json'), JSON.stringify([{
        ...message, event: 'MailboxMessageCreated', team_name: 'alpha',
      }]));
      let reads = 0;
      const result = await sendDirectMessageWithDeps('leader-fixed', 'worker-1', 'retry', {
        teamName: 'alpha', cwd,
        withMailboxLock: async (_team, _worker, _cwd, fn) => await fn(),
        readMailbox: async () => {
          assert.equal(++reads, 1, 'deduplication must use the same projection that was verified');
          await writeFile(join(stateDir, 'mailbox.json'), JSON.stringify({ records: [{
            ...message, team_name: 'foreign', message_id: 'foreign', notified_at: null, delivered_at: null,
          }, {
            ...message, team_name: 'alpha', notified_at: null, delivered_at: null,
          }] }));
          return { worker: 'worker-1', messages: [] };
        },
        readLegacyMailbox: async () => ({ worker: 'worker-1', messages: [] }),
        writeMailbox: async () => assert.fail('must not create a second provisional message'),
        appendTeamEvent: async () => assert.fail('must not publish a second creation'),
        readTeamConfig: async () => null,
      });
      assert.equal(result.message_id, message.message_id);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps concurrent degraded Team dispatches isolated without writing the Rust projection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-isolated-fallback-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      for (const team of ['alpha', 'beta']) await initTeamState(team, 'dispatch', 'executor', 1, cwd);
      const queued = await Promise.all(['alpha', 'beta'].map((team) => enqueueDispatchRequest(team, {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: team,
      }, cwd)));
      for (const [index, team] of ['alpha', 'beta'].entries()) {
        assert.deepEqual((await listDispatchRequests(team, cwd)).map((request) => request.request_id), [queued[index].request.request_id]);
        assert.equal(queued[index].request.creation_transport, 'legacy-json');
        assert.equal((await enqueueDispatchRequest(team, { kind: 'inbox', to_worker: 'worker-1', trigger_message: team }, cwd)).deduped, true);
      }
      assert.equal(existsSync(join(cwd, '.omx/state/dispatch.json')), false);
      const oldProjection = join(cwd, '.omx/state/dispatch.json');
      await writeFile(oldProjection, JSON.stringify({ records: [{
        request_id: queued[0].request.request_id, target: 'worker-1', status: 'pending',
        created_at: queued[0].request.created_at, metadata: { ...queued[0].request, team_name: 'alpha' },
      }] }));
      assert.equal((await markDispatchRequestNotified('alpha', queued[0].request.request_id, {}, cwd))?.status, 'notified');
      assert.equal((await readDispatchRequest('alpha', queued[0].request.request_id, cwd))?.status, 'notified');
      assert.equal((await listDispatchRequests('beta', cwd)).length, 1);
      await unlink(oldProjection);
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      const native = await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'native request',
      }, cwd);
      const projection = await readFile(join(cwd, '.omx/state/dispatch.json'), 'utf8');
      assert.equal((await listDispatchRequests('alpha', cwd)).length, 2);
      assert.equal((await listDispatchRequests('beta', cwd)).length, 1);
      for (const [index, team] of ['alpha', 'beta'].entries()) {
        const id = queued[index].request.request_id;
        assert.equal((await markDispatchRequestNotified(team, id, {}, cwd))?.status, 'notified');
        assert.equal((await markDispatchRequestDelivered(team, id, {}, cwd))?.status, 'delivered');
      }
      assert.equal(await readFile(join(cwd, '.omx/state/dispatch.json'), 'utf8'), projection);
      assert.equal((await readDispatchRequest('alpha', native.request.request_id, cwd))?.status, 'pending');
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('filters removed and unproven dispatch shadows when the authoritative projection is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-projection-gap-'));
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'dispatch', 'executor', 1, cwd);
      const stateDir = join(cwd, '.omx/state');
      const request = { kind: 'inbox', team_name: 'alpha', to_worker: 'worker-1', trigger_message: 'ping', status: 'pending' };
      const requestsPath = join(stateDir, 'team/alpha/dispatch/requests.json');
      await writeFile(requestsPath, JSON.stringify([
        { ...request, request_id: 'removed', creation_transport: 'legacy-json' },
        { ...request, request_id: 'unmarked' },
        { ...request, request_id: 'safe', creation_transport: 'legacy-json' },
      ]));
      await writeFile(join(stateDir, 'dispatch-seen.json'), JSON.stringify({ schema_version: 2, ledger_epoch: 1, request_ids: ['removed'] }));
      const before = await readFile(requestsPath, 'utf8');
      const malformedRow = {
        request_id: 'invalid-status', target: 'worker-1', status: 'unknown',
        created_at: '2026-01-01T00:00:00.000Z', notified_at: null, delivered_at: null,
        failed_at: null, reason: null, metadata: { team_name: 'alpha', trigger_message: 'invalid' },
      };
      for (const projection of [undefined, 'broken', '{}', '{"records":[]}',
        '{"records":[null]}', '{"records":[{}]}', JSON.stringify({ records: [malformedRow] }),
        JSON.stringify({ records: [{ ...malformedRow, status: 'pending' }, null] }),
      ]) {
        if (projection === undefined) await rm(join(stateDir, 'dispatch.json'), { force: true });
        else await writeFile(join(stateDir, 'dispatch.json'), projection);
        assert.deepEqual((await listDispatchRequests('alpha', cwd)).map(request => request.request_id), ['safe']);
        assert.equal(await readDispatchRequest('alpha', 'removed', cwd), null);
        assert.equal(await readFile(requestsPath, 'utf8'), before);
      }
      assert.deepEqual((await readDispatchRequests('alpha', cwd, JSON.parse('[null]'))).map(row => row.request_id), ['safe']);
    } finally {
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('filters legacy-json fallbacks not in the runtime dispatch identity ledger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-ledger-perf-'));
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'dispatch', 'executor', 1, cwd);
      const stateDir = join(cwd, '.omx/state');
      const request = { kind: 'inbox', team_name: 'alpha', to_worker: 'worker-1', trigger_message: 'ping', status: 'pending' };
      const requestsPath = join(stateDir, 'team/alpha/dispatch/requests.json');
      
      // Create multiple legacy-json fallbacks
      const fallbackCount = 5;
      const fallbacks = Array.from({ length: fallbackCount }, (_, i) => ({ 
        ...request, 
        request_id: `fallback-${i}`, 
        creation_transport: 'legacy-json' as const 
      }));
      await writeFile(requestsPath, JSON.stringify(fallbacks));
      
      // Create dispatch-seen.json with some IDs to filter
      const seenIds = ['fallback-0', 'fallback-2'];
      await writeFile(join(stateDir, 'dispatch-seen.json'), JSON.stringify({ 
        schema_version: 2, 
        ledger_epoch: 1, 
        request_ids: seenIds 
      }));
      
      // Read dispatch requests and verify filtering
      const result = await readDispatchRequests('alpha', cwd);
      
      // Verify behavior: only fallbacks not in dispatch-seen should be returned
      // This ensures the ledger is used for filtering
      assert.deepEqual(
        result.filter(r => r.creation_transport === 'legacy-json').map(r => r.request_id).sort(),
        ['fallback-1', 'fallback-3', 'fallback-4']
      );
    } finally {
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects QueueDispatch schema failures without polluting existing runtime state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-queue-schema-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await enqueueDispatchRequest('alpha', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'existing' }, cwd);
      const files = ['dispatch.json', 'events.json', 'team/alpha/dispatch/requests.json'];
      const before = await Promise.all(files.map(f => readFile(join(cwd, '.omx/state', f), 'utf8')));
      for (const probe of [
        'console.log(JSON.stringify({version:1,capabilities:[]}));',
        'process.exit(1);',
        'process.kill(process.pid, "SIGTERM");',
      ]) {
        await writeFile(runtime, `#!/usr/bin/env node\n${probe}\n`);
        await assert.rejects(() => enqueueDispatchRequest('alpha', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'rejected' }, cwd), /team-mailbox-scope-v1|schema failed/);
        assert.deepEqual(await Promise.all(files.map(f => readFile(join(cwd, '.omx/state', f), 'utf8'))), before);
      }

      await rm(runtime);
      await assert.rejects(() => enqueueDispatchRequest('alpha', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'missing binary' }, cwd));
      assert.deepEqual(await Promise.all(files.map(f => readFile(join(cwd, '.omx/state', f), 'utf8'))), before);
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      await chmod(runtime, 0o644);
      await assert.rejects(() => enqueueDispatchRequest('alpha', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'not executable' }, cwd));
      assert.deepEqual(await Promise.all(files.map(f => readFile(join(cwd, '.omx/state', f), 'utf8'))), before);

    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects cross-source identity collisions with a single unscoped runtime record', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-cross-source-collision-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const own = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'alpha fallback', cwd);
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const path = join(cwd, '.omx/state/mailbox.json');
      const record = { ...own, team_name: null, body: 'foreign secret', notified_at: null, delivered_at: null };
      for (const conflict of [record, { ...record, body: own.body, to_worker: 'worker-2' }]) {
        await writeFile(path, JSON.stringify({ records: [conflict] }));
        const before = await readFile(path, 'utf8');
        assert.deepEqual(await listMailboxMessages('alpha', 'worker-1', cwd), []);
        assert.equal(await markMessageNotified('alpha', 'worker-1', own.message_id, cwd), false);
        assert.equal(await markMessageDelivered('alpha', 'worker-1', own.message_id, cwd), false);
        await assert.rejects(() => retireTeamMailboxMessages('alpha', ['worker-1'], cwd), /authoritative_mailbox_retirement_discovery_failed/);
        await enqueueDispatchRequest('alpha', { kind: 'mailbox', to_worker: 'worker-1', worker_index: 1,
          message_id: own.message_id, trigger_message: 'read collision ' + conflict.to_worker }, cwd);
        const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
        await drainPendingTeamDispatch({ cwd, injector: async () => ({ ok: true, reason: 'injected_for_test' }) });
        assert.equal(await readFile(path, 'utf8'), before);
        const shadow = JSON.parse(await readFile(join(cwd, '.omx/state/team/alpha/mailbox/worker-1.json'), 'utf8'));
        assert.equal(shadow.messages[0].notified_at, undefined);
        assert.equal(shadow.messages[0].delivered_at, undefined);
      }
      // Historical timestamp drift and missing event bodies remain recoverable.
      await writeFile(path, JSON.stringify({ records: [{ ...record, body: '', created_at: '2000-01-01T00:00:00Z' }] }));
      assert.equal((await listMailboxMessages('alpha', 'worker-1', cwd))[0].body, own.body);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves proven fallback messages alongside existing bridge records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mixed-mailbox-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await initTeamState('beta', 'task', 'executor', 1, cwd);
      const original = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'runtime owned', cwd);
      const foreign = await sendDirectMessage('beta', 'leader-fixed', 'worker-1', 'foreign', cwd);
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      const fallback = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'fallback', cwd);
      const retire = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'retire fallback', cwd);
      const shadowPath = join(cwd, '.omx/state/team/alpha/mailbox/worker-1.json');
      const shadow = JSON.parse(await readFile(shadowPath, 'utf8'));
      shadow.messages.push(foreign);
      await writeFile(shadowPath, JSON.stringify(shadow));
      assert.deepEqual((await listMailboxMessages('alpha', 'worker-1', cwd)).map(m => m.message_id),
        [original.message_id, fallback.message_id, retire.message_id]);
      await assert.rejects(() => markMessageNotified('alpha', 'worker-1', fallback.message_id, cwd));
      await assert.rejects(() => markMessageDelivered('alpha', 'worker-1', fallback.message_id, cwd));
      process.env.OMX_RUNTIME_BINARY = runtime;
      assert.equal(await markMessageNotified('alpha', 'worker-1', fallback.message_id, cwd), true);
      assert.equal(await markMessageDelivered('alpha', 'worker-1', fallback.message_id, cwd), true);
      const afterRestore = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'retire fallback', cwd);
      assert.equal(afterRestore.message_id, retire.message_id);
      assert.equal(await markMessageNotified('alpha', 'worker-1', retire.message_id, cwd), true);
      assert.equal(await markMessageDelivered('alpha', 'worker-1', retire.message_id, cwd), true);
      assert.equal(await markMessageDelivered('alpha', 'worker-1', foreign.message_id, cwd), false);
      assert.equal((await listMailboxMessages('beta', 'worker-1', cwd))[0].delivered_at, undefined);
      const records = JSON.parse(await readFile(join(cwd, '.omx/state/mailbox.json'), 'utf8')).records;
      assert.equal(records.some((r: { message_id: string }) => r.message_id === fallback.message_id), false);
      const cleaned = JSON.parse(await readFile(shadowPath, 'utf8'));
      cleaned.messages = cleaned.messages.filter((m: { message_id: string }) => m.message_id !== foreign.message_id);
      await writeFile(shadowPath, JSON.stringify(cleaned));
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      const pending = await sendDirectMessage('alpha', 'leader-fixed', 'worker-1', 'pending retirement', cwd);
      process.env.OMX_RUNTIME_BINARY = runtime;
      assert.equal(await retireTeamMailboxMessages('alpha', ['worker-1'], cwd), 2);
      assert.ok((await listMailboxMessages('alpha', 'worker-1', cwd)).find(m => m.message_id === pending.message_id)?.delivered_at);
      assert.equal((await listMailboxMessages('beta', 'worker-1', cwd))[0].delivered_at, undefined);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers delivered dispatch receipts after a runtime downgrade and replay', async () => {
    for (const initialStatus of ['pending', 'notified']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-delivered-recovery-'));
      const previousBinary = process.env.OMX_RUNTIME_BINARY;
      const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
      try {
        const runtime = join(cwd, 'runtime');
        const log = join(cwd, 'runtime.log');
        await writeCompatRuntimeFixture(runtime, log);
        process.env.OMX_RUNTIME_BINARY = runtime;
        process.env.OMX_RUNTIME_BRIDGE = '1';
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const request = (await enqueueDispatchRequest('alpha', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'receipt' }, cwd)).request;
        if (initialStatus === 'notified') await markDispatchRequestNotified('alpha', request.request_id, {}, cwd);
        await writeFile(runtime, '#!/usr/bin/env node\nconsole.log(JSON.stringify({version:1,capabilities:[]}));\n');
        if (initialStatus === 'pending') {
          assert.equal(await markDispatchRequestDelivered('alpha', request.request_id, {}, cwd), null);
          await markDispatchRequestNotified('alpha', request.request_id, {}, cwd);
        }
        assert.equal((await markDispatchRequestDelivered('alpha', request.request_id, {}, cwd))?.status, 'delivered');
        const stateDir = join(cwd, '.omx/state');
        const journal = join(stateDir, 'team/alpha/dispatch/runtime-finalizations.jsonl');
        assert.equal(JSON.parse((await readFile(journal, 'utf8')).trim().split('\n').at(-1)!).command, 'MarkDelivered');
        await writeCompatRuntimeFixture(runtime, log);
        const projection = JSON.parse(await readFile(join(stateDir, 'dispatch.json'), 'utf8'));
        projection.records[0].status = initialStatus;
        await writeFile(join(stateDir, 'dispatch.json'), JSON.stringify(projection));
        const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
        await drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('delivered request reinjected'); } });
        assert.equal((await readDispatchRequest('alpha', request.request_id, cwd))?.status, 'delivered');
        assert.equal(existsSync(journal), false);
      } finally {
        if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
        else process.env.OMX_RUNTIME_BINARY = previousBinary;
        if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
        else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('journals dispatch finalizations when the runtime is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-transport-recovery-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const runtime = join(cwd, 'runtime');
      const missingRuntime = join(cwd, 'missing-runtime');
      await writeCompatRuntimeFixture(runtime, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtime;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const request = (await enqueueDispatchRequest('alpha', {
        kind: 'inbox', to_worker: 'worker-1', trigger_message: 'transport recovery',
      }, cwd)).request;
      await markDispatchRequestNotified('alpha', request.request_id, {}, cwd);

      process.env.OMX_RUNTIME_BINARY = missingRuntime;
      assert.equal((await markDispatchRequestDelivered('alpha', request.request_id, {}, cwd))?.status, 'delivered');
      const stateDir = join(cwd, '.omx', 'state');
      const journal = join(stateDir, 'team', 'alpha', 'dispatch', 'runtime-finalizations.jsonl');
      assert.equal(JSON.parse((await readFile(journal, 'utf8')).trim()).command, 'MarkDelivered');

      process.env.OMX_RUNTIME_BINARY = runtime;
      const projection = JSON.parse(await readFile(join(stateDir, 'dispatch.json'), 'utf8'));
      projection.records[0].status = 'notified';
      await writeFile(join(stateDir, 'dispatch.json'), JSON.stringify(projection));
      const { drainPendingTeamDispatch } = await import('../../scripts/notify-hook/team-dispatch.js');
      await drainPendingTeamDispatch({ cwd, injector: async () => { assert.fail('delivered request reinjected'); } });
      assert.equal((await readDispatchRequest('alpha', request.request_id, cwd))?.status, 'delivered');
      assert.equal(existsSync(journal), false);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('acknowledges proven JSON-only messages after a compatible runtime is enabled', async () => {
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      for (const creationMode of ['disabled', 'unavailable']) {
        const cwd = await mkdtemp(join(tmpdir(), 'omx-legacy-ack-enable-'));
        try {
          process.env.OMX_RUNTIME_BRIDGE = creationMode === 'disabled' ? '0' : '1';
          process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
          await initTeamState('legacy-ack', 'task', 'executor', 1, cwd);
          const own = await sendDirectMessage('legacy-ack', 'leader-fixed', 'worker-1', 'legacy only', cwd);
          const orphan = { ...own, message_id: 'unproven-orphan', body: 'keep for recovery' };
          const shadowPath = join(cwd, '.omx', 'state', 'team', 'legacy-ack', 'mailbox', 'worker-1.json');
          await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [own, orphan] }));
          const runtimePath = join(cwd, 'runtime');
          const runtimeLogPath = join(cwd, 'runtime.log');
          await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
          process.env.OMX_RUNTIME_BINARY = runtimePath;
          process.env.OMX_RUNTIME_BRIDGE = '1';
          assert.equal(existsSync(join(cwd, '.omx', 'state', 'mailbox.json')), false);
          assert.deepEqual((await listMailboxMessages('legacy-ack', 'worker-1', cwd)).map((message) => message.message_id), [own.message_id]);
          for (const name of ['events.json', 'snapshot.json', 'mailbox.json']) {
            const authorityPath = join(cwd, '.omx', 'state', name);
            await writeFile(authorityPath, '{invalid');
            await assert.rejects(() => markMessageNotified('legacy-ack', 'worker-1', own.message_id, cwd), /omx-runtime exec-scoped failed/);
            await assert.rejects(() => markMessageDelivered('legacy-ack', 'worker-1', own.message_id, cwd), /omx-runtime exec-scoped failed/);
            await rm(authorityPath);
          }
          const runtimeLogBefore = await readFile(runtimeLogPath, 'utf8');
          assert.equal(await markMessageNotified('legacy-ack', 'worker-1', own.message_id, cwd), true);
          assert.equal(await markMessageDelivered('legacy-ack', 'worker-1', own.message_id, cwd), true);
          assert.equal(await markMessageNotified('legacy-ack', 'worker-1', orphan.message_id, cwd), false);
          assert.equal(await markMessageDelivered('legacy-ack', 'worker-1', orphan.message_id, cwd), false);
          const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: typeof own[] };
          assert.ok(shadow.messages[0].notified_at);
          assert.ok(shadow.messages[0].delivered_at);
          assert.deepEqual(shadow.messages[1], JSON.parse(JSON.stringify(orphan)));
          assert.doesNotMatch((await readFile(runtimeLogPath, 'utf8')).slice(runtimeLogBefore.length), /MarkMailbox(Notified|Delivered)/);
        } finally { await rm(cwd, { recursive: true, force: true }); }
      }
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
    }
  });

  it('materializes existing runtime authority before acknowledging a JSON-only mailbox message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-legacy-ack-existing-runtime-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousMaterialize = process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      await initTeamState('legacy-ack-authority', 'task', 'executor', 1, cwd);
      const own = await sendDirectMessage('legacy-ack-authority', 'leader-fixed', 'worker-1', 'legacy only', cwd);
      const runtimeStateDir = join(cwd, '.omx', 'state');
      await writeFile(join(runtimeStateDir, 'events.json'), '[]');

      const runtimePath = join(cwd, 'runtime');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = '1';

      assert.equal(await markMessageNotified('legacy-ack-authority', 'worker-1', own.message_id, cwd), true);
      assert.equal(await markMessageDelivered('legacy-ack-authority', 'worker-1', own.message_id, cwd), true);
      const shadowPath = join(runtimeStateDir, 'team', 'legacy-ack-authority', 'mailbox', 'worker-1.json');
      const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: typeof own[] };
      assert.ok(shadow.messages[0]?.notified_at);
      assert.ok(shadow.messages[0]?.delivered_at);
      assert.deepEqual(JSON.parse(await readFile(join(runtimeStateDir, 'mailbox.json'), 'utf8')), { records: [] });
      assert.match(await readFile(runtimeLogPath, 'utf8'), /CaptureSnapshot/);
      assert.doesNotMatch(await readFile(runtimeLogPath, 'utf8'), /MarkMailbox(Notified|Delivered)/);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousMaterialize === undefined) delete process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
      else process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = previousMaterialize;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refreshes a stale projection without confusing a foreign scoped collision for the legacy row', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-legacy-ack-stale-projection-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousMaterialize = process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      await initTeamState('legacy-ack-stale', 'task', 'executor', 1, cwd);
      const own = await sendDirectMessage('legacy-ack-stale', 'leader-fixed', 'worker-1', 'alpha private message', cwd);
      const runtimeStateDir = join(cwd, '.omx', 'state');
      await writeFile(join(runtimeStateDir, 'events.json'), JSON.stringify([{
        event: 'MailboxMessageCreated',
        team_name: 'foreign-team',
        message_id: own.message_id,
        from_worker: 'leader-fixed',
        to_worker: 'worker-1',
        body: 'foreign message',
      }]));
      await writeFile(join(runtimeStateDir, 'mailbox.json'), JSON.stringify({ records: [] }));

      const runtimePath = join(cwd, 'runtime');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await writeCompatRuntimeFixture(runtimePath, runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = '1';

      assert.deepEqual((await listMailboxMessages('legacy-ack-stale', 'worker-1', cwd)).map((message) => message.body), [own.body]);
      const shadowPath = join(runtimeStateDir, 'team', 'legacy-ack-stale', 'mailbox', 'worker-1.json');
      assert.equal(await markMessageNotified('legacy-ack-stale', 'worker-1', own.message_id, cwd), true);
      const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: typeof own[] };
      assert.ok(shadow.messages[0]?.notified_at);
      const compat = JSON.parse(await readFile(join(runtimeStateDir, 'mailbox.json'), 'utf8')) as {
        records: Array<{ team_name: string; message_id: string; body: string }>;
      };
      assert.deepEqual(compat.records.map(({ team_name, message_id, body }) => ({ team_name, message_id, body })), [{
        team_name: 'foreign-team', message_id: own.message_id, body: 'foreign message',
      }]);
      assert.deepEqual((await listMailboxMessages('legacy-ack-stale', 'worker-1', cwd)).map((message) => message.body), [own.body]);
      assert.doesNotMatch(await readFile(runtimeLogPath, 'utf8'), /MarkMailboxNotified/);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousMaterialize === undefined) delete process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
      else process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = previousMaterialize;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects acknowledgements when stale mailbox refresh loses the runtime after schema validation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-stale-mailbox-refresh-transport-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    const previousMaterialize = process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
    try {
      const teamName = 'refresh-transport';
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      const message = await sendDirectMessage(teamName, 'leader-fixed', 'worker-1', 'durable creation', cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const shadowPath = join(stateDir, 'team', teamName, 'mailbox', 'worker-1.json');
      const compatPath = join(stateDir, 'mailbox.json');
      await writeFile(join(stateDir, 'events.json'), JSON.stringify([{
        ...message, event: 'MailboxMessageCreated', team_name: teamName,
      }]));
      await writeFile(compatPath, JSON.stringify({ records: [] }));
      const shadowBefore = await readFile(shadowPath, 'utf8');
      const compatBefore = await readFile(compatPath, 'utf8');
      const runtimePath = join(cwd, 'runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      const runtime = await readFile(runtimePath, 'utf8');
      const disappearingRuntime = runtime.replace("if (argv[0] === 'schema') {",
        "if (argv[0] === 'schema') { fs.unlinkSync(process.argv[1]);");
      assert.notEqual(disappearingRuntime, runtime);
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = '1';
      for (const mutate of [markMessageNotified, markMessageDelivered]) {
        await writeFile(runtimePath, disappearingRuntime, { mode: 0o755 });
        await assert.rejects(() => mutate(teamName, 'worker-1', message.message_id, cwd), /omx-runtime exec-scoped failed/);
        assert.equal(await readFile(shadowPath, 'utf8'), shadowBefore);
        assert.equal(await readFile(compatPath, 'utf8'), compatBefore);
      }
      await writeFile(runtimePath, runtime, { mode: 0o755 });
      assert.equal(await markMessageNotified(teamName, 'worker-1', message.message_id, cwd), true);
      assert.equal(await markMessageDelivered(teamName, 'worker-1', message.message_id, cwd), true);
      assert.ok(JSON.parse(await readFile(compatPath, 'utf8')).records[0].delivered_at);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      if (previousMaterialize === undefined) delete process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE;
      else process.env.OMX_TEST_MATERIALIZE_MAILBOX_ON_CAPTURE = previousMaterialize;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not report authoritative acknowledgement success when runtime transport fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-ack-transport-'));
    const previousBinary = process.env.OMX_RUNTIME_BINARY;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      const teamName = 'ack-transport';
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const runtimePath = join(cwd, 'omx-runtime');
      await writeCompatRuntimeFixture(runtimePath, join(cwd, 'runtime.log'));
      process.env.OMX_RUNTIME_BINARY = runtimePath;
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage(teamName, 'leader-fixed', 'worker-1', 'pending', cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const shadowPath = join(stateDir, 'team', teamName, 'mailbox', 'worker-1.json');
      const shadowBefore = await readFile(shadowPath, 'utf8');
      const compatPath = join(stateDir, 'mailbox.json');
      const compatBefore = await readFile(compatPath, 'utf8');

      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      await assert.rejects(() => markMessageNotified(teamName, 'worker-1', message.message_id, cwd), /omx-runtime schema failed/);
      await assert.rejects(() => markMessageDelivered(teamName, 'worker-1', message.message_id, cwd), /omx-runtime schema failed/);
      assert.equal(await readFile(shadowPath, 'utf8'), shadowBefore);
      assert.equal(await readFile(compatPath, 'utf8'), compatBefore);

      process.env.OMX_RUNTIME_BINARY = runtimePath;
      assert.equal(await markMessageNotified(teamName, 'worker-1', message.message_id, cwd), true);
      assert.equal(await markMessageDelivered(teamName, 'worker-1', message.message_id, cwd), true);
    } finally {
      if (previousBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousBinary;
      if (previousBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves unproven shadow records when notifying and delivering through the JSON fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-fallback-preserve-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await initTeamState('fallback-alpha', 't', 'executor', 1, cwd);
      const own = await sendDirectMessage('fallback-alpha', 'leader-fixed', 'worker-1', 'own', cwd);
      const orphan = { ...own, message_id: 'crashed-before-creation-event', body: 'recover me' };
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'fallback-alpha', 'mailbox', 'worker-1.json');
      await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [own, orphan] }));
      process.env.OMX_RUNTIME_BRIDGE = '1';
      process.env.OMX_RUNTIME_BINARY = join(cwd, 'missing-runtime');
      assert.deepEqual((await listMailboxMessages('fallback-alpha', 'worker-1', cwd)).map((m) => m.message_id), [own.message_id]);
      for (const mutate of [markMessageNotified, markMessageDelivered]) {
        assert.equal(await mutate('fallback-alpha', 'worker-1', own.message_id, cwd), true);
        const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: typeof own[] };
        assert.deepEqual(shadow.messages.find((message) => message.message_id === orphan.message_id), JSON.parse(JSON.stringify(orphan)));
        assert.deepEqual((await listMailboxMessages('fallback-alpha', 'worker-1', cwd)).map((m) => m.message_id), [own.message_id]);
      }
      for (const records of [{}, [null]]) {
        await writeFile(join(cwd, '.omx', 'state', 'mailbox.json'), JSON.stringify({ records }));
        const fresh = await sendDirectMessage('fallback-alpha', 'leader-fixed', 'worker-1', JSON.stringify(records), cwd);
        assert.notEqual(fresh.message_id, orphan.message_id);
        assert.ok((await listMailboxMessages('fallback-alpha', 'worker-1', cwd)).some((message) => message.message_id === fresh.message_id));
        const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: typeof own[] };
        assert.deepEqual(shadow.messages.find((message) => message.message_id === orphan.message_id), JSON.parse(JSON.stringify(orphan)));
      }
      await writeFile(shadowPath, JSON.stringify({ worker: 'worker-1', messages: [own, { ...own, body: 'ambiguous' }] }));
      assert.deepEqual(await listMailboxMessages('fallback-alpha', 'worker-1', cwd), []);
      assert.equal(await markMessageDelivered('fallback-alpha', 'worker-1', own.message_id, cwd), false);
    } finally {
      if (previousRuntimeBinary === undefined) delete process.env.OMX_RUNTIME_BINARY;
      else process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      if (previousRuntimeBridge === undefined) delete process.env.OMX_RUNTIME_BRIDGE;
      else process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retires only mailbox IDs proven by the selected Team shadow', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-retire-'));
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      process.env.OMX_RUNTIME_BRIDGE = '0';
      await Promise.all([
        initTeamState('team-retire-a', 't', 'executor', 1, cwd),
        initTeamState('team-retire-b', 't', 'executor', 1, cwd),
      ]);
      const alpha = await sendDirectMessage('team-retire-a', 'leader-fixed', 'worker-1', 'alpha', cwd);
      const bravo = await sendDirectMessage('team-retire-b', 'leader-fixed', 'worker-1', 'bravo', cwd);

      assert.equal(await retireTeamMailboxMessages('team-retire-a', [], cwd), 1);
      const alphaMailbox = await listMailboxMessages('team-retire-a', 'worker-1', cwd);
      const bravoMailbox = await listMailboxMessages('team-retire-b', 'worker-1', cwd);
      assert.equal(typeof alphaMailbox.find((message) => message.message_id === alpha.message_id)?.delivered_at, 'string');
      assert.equal(bravoMailbox.find((message) => message.message_id === bravo.message_id)?.delivered_at, undefined);
    } finally {
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retires a proven Team mailbox message through the authoritative bridge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-retire-bridge-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('team-retire-bridge', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage('team-retire-bridge', 'leader-fixed', 'worker-1', 'done', cwd);

      assert.equal(await retireTeamMailboxMessages('team-retire-bridge', ['worker-1'], cwd), 1);
      const compat = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'mailbox.json'), 'utf8')) as {
        records: Array<{ message_id: string; delivered_at: string | null }>;
      };
      assert.equal(typeof compat.records.find((record) => record.message_id === message.message_id)?.delivered_at, 'string');
      assert.match(await readFile(runtimeLogPath, 'utf8'), /MarkMailboxDelivered/);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('converges when the authoritative mailbox record was already delivered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-retire-already-delivered-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('team-retire-already-delivered', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage('team-retire-already-delivered', 'leader-fixed', 'worker-1', 'done', cwd);
      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as {
        records: Array<{ message_id: string; delivered_at: string | null }>;
      };
      const record = compat.records.find((entry) => entry.message_id === message.message_id);
      assert.ok(record);
      record.delivered_at = new Date().toISOString();
      await writeFile(compatPath, JSON.stringify(compat, null, 2));

      assert.equal(await retireTeamMailboxMessages('team-retire-already-delivered', ['worker-1'], cwd), 1);
      const shadow = await listMailboxMessages('team-retire-already-delivered', 'worker-1', cwd);
      assert.equal(typeof shadow.find((entry) => entry.message_id === message.message_id)?.delivered_at, 'string');
      const deliveredCalls = (await readFile(runtimeLogPath, 'utf8')).split('MarkMailboxDelivered').length - 1;
      assert.equal(deliveredCalls, 0);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a matching authoritative mailbox record is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-retire-malformed-record-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('team-retire-malformed-record', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage('team-retire-malformed-record', 'leader-fixed', 'worker-1', 'pending', cwd);
      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<Record<string, unknown>> };
      const record = compat.records.find((entry) => entry.message_id === message.message_id);
      assert.ok(record);
      const original = { ...record };
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'team-retire-malformed-record', 'mailbox', 'worker-1.json');
      const shadowBefore = await readFile(shadowPath, 'utf8');
      for (const invalid of [{ body: null }, ...[0, false, {}, [], '', ' ', 'invalid/name'].map((team_name) => ({ team_name }))]) {
        Object.assign(record, original, invalid);
        await writeFile(compatPath, JSON.stringify(compat, null, 2));
        await assert.rejects(
          retireTeamMailboxMessages('team-retire-malformed-record', ['worker-1'], cwd),
          /authoritative_mailbox_retirement_discovery_failed/,
        );
        assert.equal(await readFile(shadowPath, 'utf8'), shadowBefore);
      }
      assert.equal((await readFile(runtimeLogPath, 'utf8')).split('MarkMailboxDelivered').length - 1, 0);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reconciles an authoritative pending record after a delivered shadow fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-retire-shadow-fallback-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    try {
      await initTeamState('team-retire-shadow-fallback', 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage('team-retire-shadow-fallback', 'leader-fixed', 'worker-1', 'pending', cwd);
      const shadowPath = join(cwd, '.omx', 'state', 'team', 'team-retire-shadow-fallback', 'mailbox', 'worker-1.json');
      const shadow = JSON.parse(await readFile(shadowPath, 'utf8')) as { messages: Array<{ message_id: string; delivered_at?: string }> };
      shadow.messages.find((entry) => entry.message_id === message.message_id)!.delivered_at = new Date().toISOString();
      await writeFile(shadowPath, JSON.stringify(shadow, null, 2));

      assert.equal(await retireTeamMailboxMessages('team-retire-shadow-fallback', ['worker-1'], cwd), 0);
      const compat = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'mailbox.json'), 'utf8')) as {
        records: Array<{ message_id: string; delivered_at: string | null }>;
      };
      assert.equal(typeof compat.records.find((record) => record.message_id === message.message_id)?.delivered_at, 'string');
      assert.equal((await readFile(runtimeLogPath, 'utf8')).split('MarkMailboxDelivered').length - 1, 1);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when authoritative mailbox compatibility output is absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-mailbox-retire-missing-compat-'));
    const previousRuntimeBinary = process.env.OMX_RUNTIME_BINARY;
    const previousRuntimeBridge = process.env.OMX_RUNTIME_BRIDGE;
    const teamName = 'team-retire-missing-compat';
    try {
      await initTeamState(teamName, 't', 'executor', 1, cwd);
      const fakeBinDir = join(cwd, 'fake-bin');
      const runtimeLogPath = join(cwd, 'runtime.log');
      await mkdir(fakeBinDir, { recursive: true });
      await writeCompatRuntimeFixture(join(fakeBinDir, 'omx-runtime'), runtimeLogPath);
      process.env.OMX_RUNTIME_BINARY = join(fakeBinDir, 'omx-runtime');
      process.env.OMX_RUNTIME_BRIDGE = '1';
      const message = await sendDirectMessage(teamName, 'leader-fixed', 'worker-1', 'pending', cwd);
      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      await unlink(compatPath);

      await assert.rejects(
        retireTeamMailboxMessages(teamName, ['worker-1'], cwd),
        /authoritative_mailbox_retirement_discovery_failed/,
      );
      const shadow = await listMailboxMessages(teamName, 'worker-1', cwd);
      assert.equal(shadow.find((entry) => entry.message_id === message.message_id)?.delivered_at, undefined);
      assert.doesNotMatch(await readFile(runtimeLogPath, 'utf8'), /MarkMailboxDelivered/);
    } finally {
      if (typeof previousRuntimeBinary === 'string') process.env.OMX_RUNTIME_BINARY = previousRuntimeBinary;
      else delete process.env.OMX_RUNTIME_BINARY;
      if (typeof previousRuntimeBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousRuntimeBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
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
      const after = JSON.parse(await readFile(legacyPath, 'utf8')) as { messages: Array<{ message_id: string; body: string; created_at: string }> };
      assert.equal(after.messages.length, 1);
      assert.equal(after.messages[0]?.message_id, message.message_id);
      assert.equal(after.messages[0]?.body, 'hello');

      const compatPath = join(cwd, '.omx', 'state', 'mailbox.json');
      const compat = JSON.parse(await readFile(compatPath, 'utf8')) as { records: Array<{ message_id: string; body: string; created_at: string }> };
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
      compatRecord!.created_at = '2026-01-01T00:00:00.000Z';
      await writeFile(compatPath, JSON.stringify(compat, null, 2));

      const recovered = await listMailboxMessages('team-mailbox-bridge-authority', 'worker-2', cwd);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.body, 'hello', 'legacy shadow mailbox should backfill blank compat bodies');
      assert.equal(await markMessageNotified('team-mailbox-bridge-authority', 'worker-2', message.message_id, cwd), true);
      const repairedShadow = JSON.parse(await readFile(legacyPath, 'utf8')) as { messages: Array<{ created_at: string }> };
      assert.equal(repairedShadow.messages.length, 1, 'old runtime clock drift must not duplicate a proven shadow');
      assert.equal(repairedShadow.messages[0].created_at, after.messages[0].created_at);
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

  it('writeAtomic tolerates Windows EPERM syncing the temp file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic-file-sync-eperm.txt');
      let fileSyncs = 0;
      setWriteAtomicPlatformForTests('win32');
      setWriteAtomicOpenForTests(async (...args) => {
        const [path] = args;
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          // Only throw EPERM when syncing the temp file, not the parent directory
          if (String(path).endsWith('.txt.tmp')) {
            fileSyncs += 1;
            const error = new Error('Windows cannot fsync this file') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          fileSyncs += 1;
          await sync();
        };
        return handle;
      });

      await writeAtomic(p, 'durable data');

      assert.equal(fileSyncs, 2); // One for temp file (EPERM), one for parent dir
      assert.equal(readFileSync(p, 'utf8'), 'durable data');
    } finally {
      resetWriteAtomicPlatformForTests();
      resetWriteAtomicOpenForTests();
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

  it('rejects dispatch records with padded request_id or target', () => {
    const paddedRequestId = {
      request_id: ' req-123 ',
      target: 'worker-1',
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: null,
    };
    assert.equal(isStrictDispatchRecord(paddedRequestId), false, 'padded request_id should be rejected');

    const paddedTarget = {
      request_id: 'req-123',
      target: ' worker-1 ',
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: null,
    };
    assert.equal(isStrictDispatchRecord(paddedTarget), false, 'padded target should be rejected');

    const bothPadded = {
      request_id: ' req-123 ',
      target: ' worker-1 ',
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: null,
    };
    assert.equal(isStrictDispatchRecord(bothPadded), false, 'both padded should be rejected');

    const cleanRecord = {
      request_id: 'req-123',
      target: 'worker-1',
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: null,
    };
    assert.equal(isStrictDispatchRecord(cleanRecord), true, 'clean record should pass');

    // Test that normalizeBridgeDispatchRecord would also reject padded values via isStrictDispatchRecord
    // (it doesn't call isStrictDispatchRecord directly, but the caller does before calling normalizeBridgeDispatchRecord)
  });

  it('normalizes bridge dispatch records and preserves request_id and target for comparison', () => {
    const record = {
      request_id: 'bridge-req-123',
      target: 'worker-1',
      status: 'pending' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      notified_at: null,
      delivered_at: null,
      failed_at: null,
      reason: null,
      metadata: { team_name: 'test-team', kind: 'inbox' },
    };
    const normalized = normalizeBridgeDispatchRecord('test-team', record);
    assert.ok(normalized !== null);
    assert.equal(normalized?.request_id, 'bridge-req-123');
    assert.equal(normalized?.to_worker, 'worker-1');
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
