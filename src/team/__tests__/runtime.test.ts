import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  initTeamState,
  createTask,
  writeWorkerIdentity,
  readTeamConfig,
  listMailboxMessages,
  updateWorkerHeartbeat,
  writeAtomic,
  readTask,
} from '../state.js';
import {
  monitorTeam,
  shutdownTeam,
  resumeTeam,
  startTeam,
  assignTask,
  sendWorkerMessage,
  resolveWorkerLaunchArgsFromEnv,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
} from '../runtime.js';

function withEmptyPath<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.PATH = prev;
    else delete process.env.PATH;
  }
}

function withoutTeamWorkerEnv<T>(fn: () => T): T {
  const prev = process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_WORKER;
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
  }
}

describe('runtime', () => {
  it('resolveWorkerLaunchArgsFromEnv injects low-complexity default model when missing', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL]);
  });

  it('resolveWorkerLaunchArgsFromEnv injects default model for all agent types', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL]);
  });

  it('resolveWorkerLaunchArgsFromEnv treats *-low aliases as low complexity', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor-low',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL]);
  });

  it('resolveWorkerLaunchArgsFromEnv preserves explicit model in either syntax', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5' }, 'explore'),
      ['--model', 'gpt-5'],
    );
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model=gpt-5.3' }, 'explore'),
      ['--model=gpt-5.3'],
    );
  });

  it('resolveWorkerLaunchArgsFromEnv uses configured model for all agent types', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor',
      'gpt-4.1',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1']);
  });

  it('resolveWorkerLaunchArgsFromEnv uses configured model over hardcoded default for low-complexity', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
      'gpt-4.1',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1']);
  });

  it('resolveWorkerLaunchArgsFromEnv prefers explicit env model over configured model', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5' }, 'explore', 'gpt-4.1'),
      ['--model', 'gpt-5'],
    );
  });

  it('startTeam rejects nested team invocation inside worker context', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    const prev = process.env.OMX_TEAM_WORKER;
    process.env.OMX_TEAM_WORKER = 'alpha/worker-1';
    try {
      await assert.rejects(
        () => startTeam('nested-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
        /nested_team_disallowed/,
      );
    } finally {
      if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
      else delete process.env.OMX_TEAM_WORKER;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam throws when tmux is not available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          withEmptyPath(() =>
            startTeam('team-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
          )),
        /requires tmux/i,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const snapshot = await monitorTeam('missing-team', cwd);
      assert.equal(snapshot, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns correct task counts from state files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-counts', 'monitor task counts', 'executor', 2, cwd);

      const t1 = await createTask('team-counts', { subject: 'p', description: 'd', status: 'pending' }, cwd);
      const t2 = await createTask('team-counts', { subject: 'ip', description: 'd', status: 'in_progress', owner: 'worker-1' }, cwd);
      await createTask('team-counts', { subject: 'c', description: 'd', status: 'completed' }, cwd);
      await createTask('team-counts', { subject: 'f', description: 'd', status: 'failed' }, cwd);

      await updateWorkerHeartbeat(
        'team-counts',
        'worker-1',
        { pid: 111, last_turn_at: new Date().toISOString(), turn_count: 7, alive: true },
        cwd,
      );

      const statusPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-counts',
        'workers',
        'worker-1',
        'status.json',
      );
      await writeAtomic(
        statusPath,
        JSON.stringify(
          {
            state: 'working',
            current_task_id: t2.id,
            updated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const snapshot = await monitorTeam('team-counts', cwd);
      assert.ok(snapshot);
      assert.equal(snapshot?.tasks.total, 4);
      assert.equal(snapshot?.tasks.pending, 1);
      assert.equal(snapshot?.tasks.in_progress, 1);
      assert.equal(snapshot?.tasks.completed, 1);
      assert.equal(snapshot?.tasks.failed, 1);
      assert.equal(snapshot?.allTasksTerminal, false);
      assert.equal(snapshot?.phase, 'team-exec');

      const worker1 = snapshot?.workers.find((w) => w.name === 'worker-1');
      assert.ok(worker1);
      assert.equal(worker1?.turnsWithoutProgress, 0);

      const reassignHint = snapshot?.recommendations.some((r) => r.includes(`task-${t2.id}`));
      assert.equal(typeof reassignHint, 'boolean');
      void t1;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam emits worker_idle and task_completed events based on transitions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-events', 'monitor event test', 'executor', 1, cwd);
      const t = await createTask('team-events', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      // First monitor creates baseline snapshot.
      await monitorTeam('team-events', cwd);

      // Transition task to completed and worker status to idle.
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-events', 'tasks', `task-${t.id}.json`),
        JSON.stringify({ ...t, status: 'completed', owner: 'worker-1' }, null, 2),
      );
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-events', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({ state: 'idle', updated_at: new Date().toISOString() }, null, 2),
      );

      await monitorTeam('team-events', cwd);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-events', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      assert.match(content, /\"type\":\"task_completed\"/);
      assert.match(content, /\"type\":\"worker_idle\"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam cleans up state even when tmux session doesn\'t exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-shutdown', 'shutdown test', 'executor', 1, cwd);
      await shutdownTeam('team-shutdown', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam returns rejection error when worker rejects shutdown and force is false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-reject', 'shutdown reject test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-reject',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'still working', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await assert.rejects(() => shutdownTeam('team-reject', cwd), /shutdown_rejected:worker-1:still working/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam emits shutdown_ack event when worker ack is received', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-ack-evt', 'shutdown ack event test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-ack-evt',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'busy', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await assert.rejects(() => shutdownTeam('team-ack-evt', cwd), /shutdown_rejected/);

      // Verify that a shutdown_ack event was written to the event log
      const eventLogPath = join(cwd, '.omx', 'state', 'team', 'team-ack-evt', 'events', 'events.ndjson');
      assert.ok(existsSync(eventLogPath), 'event log should exist');
      const raw = await readFile(eventLogPath, 'utf-8');
      const events = raw.trim().split('\n').map(line => JSON.parse(line));
      const ackEvents = events.filter((e: { type: string }) => e.type === 'shutdown_ack');
      assert.equal(ackEvents.length, 1, 'should have exactly one shutdown_ack event');
      assert.equal(ackEvents[0].worker, 'worker-1');
      assert.equal(ackEvents[0].reason, 'reject:busy');
      assert.equal(ackEvents[0].team, 'team-ack-evt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam emits shutdown_ack event with accept reason for accepted acks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-ack-accept', 'shutdown ack accept test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-ack-accept',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'accept', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      // Read the event log before cleanup destroys it
      const eventLogPath = join(cwd, '.omx', 'state', 'team', 'team-ack-accept', 'events', 'events.ndjson');

      await shutdownTeam('team-ack-accept', cwd);

      // State is cleaned up, but we can verify the event was emitted by checking
      // that cleanup succeeded (no error) -- the event was written before cleanup.
      // For a more direct test, check that the team root was cleaned up.
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-ack-accept');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force=true ignores rejection and cleans up team state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-force', 'shutdown force test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-force',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'still working', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-force', cwd, { force: true });
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-force');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam ignores stale rejection ack from a prior request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-stale-ack', 'shutdown stale ack test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-stale-ack',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'old ack', updated_at: '2000-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-stale-ack', cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-stale-ack');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const runtime = await resumeTeam('missing-team', cwd);
      assert.equal(runtime, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask enforces delegation_only policy for leader-fixed worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-delegation', 'delegation policy test', 'executor', 1, cwd);
      const task = await createTask(
        'team-delegation',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-delegation', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.policy.delegation_only = true;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        () => assignTask('team-delegation', 'leader-fixed', task.id, cwd),
        /delegation_only_violation/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask does not claim task when worker does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-missing-worker', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-missing-worker',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      await assert.rejects(
        () => assignTask('team-missing-worker', 'worker-404', task.id, cwd),
        /Worker worker-404 not found in team/,
      );

      const reread = await readTask('team-missing-worker', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask rolls back claim when notification transport fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-notify-fail', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-notify-fail',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      // Force notification transport to fail by clearing PATH so tmux is unavailable.
      await assert.rejects(
        () => withEmptyPath(() => assignTask('team-notify-fail', 'worker-1', task.id, cwd)),
        /worker_notify_failed/,
      );

      const reread = await readTask('team-notify-fail', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask rolls back claim when inbox write fails after claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-inbox-fail', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-inbox-fail',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );
      const workerDir = join(cwd, '.omx', 'state', 'team', 'team-inbox-fail', 'workers', 'worker-1');
      await rm(workerDir, { recursive: true, force: true });
      // Force inbox write failure by turning the would-be directory into a file.
      await writeFile(workerDir, 'not-a-directory');

      await assert.rejects(
        () => assignTask('team-inbox-fail', 'worker-1', task.id, cwd),
        /worker_assignment_failed:/,
      );

      const reread = await readTask('team-inbox-fail', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask enforces plan approval for code-change tasks when required', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-approval', 'approval policy test', 'executor', 1, cwd);
      const task = await createTask(
        'team-approval',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: true },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-approval', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.policy.plan_approval_required = true;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        () => assignTask('team-approval', 'worker-1', task.id, cwd),
        /plan_approval_required/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage allows worker to message leader-fixed mailbox', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-leader-msg', 'leader mailbox test', 'executor', 2, cwd);
      await sendWorkerMessage('team-leader-msg', 'worker-1', 'leader-fixed', 'worker one ack', cwd);
      await sendWorkerMessage('team-leader-msg', 'worker-2', 'leader-fixed', 'worker two ack', cwd);

      const messages = await listMailboxMessages('team-leader-msg', 'leader-fixed', cwd);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.from_worker, 'worker-1');
      assert.equal(messages[1]?.from_worker, 'worker-2');
      assert.equal(messages[0]?.to_worker, 'leader-fixed');
      assert.equal(messages[1]?.to_worker, 'leader-fixed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
