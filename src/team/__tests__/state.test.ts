import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, utimes } from 'fs/promises';
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
  readTeamManifestV2,
  transitionTaskStatus,
  releaseTaskClaim,
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
  writeWorkerInbox,
} from '../state.js';

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
      assert.equal(typeof diskCfg.next_task_id, 'number');
      assert.ok(Array.isArray(diskCfg.workers));
      assert.equal(diskCfg.workers.length, 2);
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

      const m2 = await migrateV1ToV2('team-mig', cwd);
      assert.deepEqual(m2, onDisk1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
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

  it('claimTask claim locking yields deterministic claim_conflict', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-claim-lock-'));
    try {
      await initTeamState('team-lock', 't', 'executor', 1, cwd);
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

  it('releaseTaskClaim can recover with owner match when claim token changed', async () => {
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
      assert.equal(released.ok, true);

      const reread = await readTask('team-release-owner', t.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
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
          CODEX_APPROVAL_MODE: 'on-request',
          CODEX_SANDBOX_MODE: 'workspace-write',
          CODEX_NETWORK_ACCESS: '0',
          OMX_SESSION_ID: 'session-xyz',
        },
      );

      const manifest = await readTeamManifestV2('team-env', cwd);
      assert.ok(manifest);
      assert.equal(manifest?.policy.display_mode, 'split_pane');
      assert.equal(manifest?.permissions_snapshot.approval_mode, 'on-request');
      assert.equal(manifest?.permissions_snapshot.sandbox_mode, 'workspace-write');
      assert.equal(manifest?.permissions_snapshot.network_access, false);
      assert.equal(manifest?.leader.session_id, 'session-xyz');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
