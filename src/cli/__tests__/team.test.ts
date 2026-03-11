import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLeaderMonitoringHints, parseTeamStartArgs, teamCommand } from '../team.js';
import { DEFAULT_MAX_WORKERS } from '../../team/state.js';
import {
  appendTeamEvent,
  createTask,
  initTeamState,
  updateWorkerHeartbeat,
  writeMonitorSnapshot,
  writeTaskApproval,
  writeWorkerStatus,
} from '../../team/state.js';

describe('parseTeamStartArgs', () => {
  it('parses default team start args without worktree', () => {
    const result = parseTeamStartArgs(['2:executor', 'build', 'feature']);
    assert.deepEqual(result.worktreeMode, { enabled: false });
    assert.equal(result.parsed.workerCount, 2);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'build feature');
    assert.equal(result.parsed.teamName, 'build-feature');
  });

  it('parses detached worktree mode and strips the flag', () => {
    const result = parseTeamStartArgs(['--worktree', '3:debugger', 'fix', 'bug']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: true, name: null });
    assert.equal(result.parsed.workerCount, 3);
    assert.equal(result.parsed.agentType, 'debugger');
    assert.equal(result.parsed.task, 'fix bug');
    assert.equal(result.parsed.teamName, 'fix-bug');
  });

  it('parses named worktree mode with ralph prefix', () => {
    const result = parseTeamStartArgs(['ralph', '--worktree=feature/demo', '4:executor', 'ship', 'it']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: false, name: 'feature/demo' });
    assert.equal(result.parsed.ralph, true);
    assert.equal(result.parsed.workerCount, 4);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'ship it');
    assert.equal(result.parsed.teamName, 'ship-it');
  });

  it('accepts the maximum supported worker count', () => {
    const result = parseTeamStartArgs([`${DEFAULT_MAX_WORKERS}:executor`, 'ship', 'it']);
    assert.equal(result.parsed.workerCount, DEFAULT_MAX_WORKERS);
  });

  it('rejects worker count above the supported maximum', () => {
    assert.throws(
      () => parseTeamStartArgs([`${DEFAULT_MAX_WORKERS + 1}:executor`, 'ship', 'it']),
      new RegExp(`Expected 1-${DEFAULT_MAX_WORKERS}`),
    );
  });
});

describe('teamCommand shutdown --force parsing', () => {
  it('parses --force flag from shutdown args', () => {
    const teamArgs = ['shutdown', 'my-team', '--force'];
    const force = teamArgs.includes('--force');
    assert.equal(force, true);
  });

  it('does not set force when --force is absent', () => {
    const teamArgs = ['shutdown', 'my-team'];
    const force = teamArgs.includes('--force');
    assert.equal(force, false);
  });

  it('parses --force regardless of position after subcommand', () => {
    const teamArgs = ['shutdown', '--force', 'my-team'];
    const force = teamArgs.includes('--force');
    assert.equal(force, true);
  });
});

describe('teamCommand api', () => {
  it('builds leader monitoring hints that keep team status visible while ON', () => {
    const hints = buildLeaderMonitoringHints('My Team');
    assert.equal(hints[0], 'leader_check: omx team status my-team');
    assert.match(hints[1] ?? '', /while ON, keep checking state/);
    assert.match(hints[1] ?? '', /sleep 30 && omx team status my-team/);
  });

  it('prints team-specific help for omx team --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team \[ralph\] \[N:agent-type\]/);
      assert.match(logs[0] ?? '', /omx team api <operation>/);
      assert.match(logs[0] ?? '', /omx team await <team-name>/);
      assert.match(logs[0] ?? '', /omx team await <team-name>/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-specific help for omx team help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team \[ralph\] \[N:agent-type\]/);
      assert.match(logs[0] ?? '', /omx team api <operation>/);
      assert.match(logs[0] ?? '', /omx team await <team-name>/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-api-specific help for omx team api --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', '--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api <operation>/);
      assert.match(logs[0] ?? '', /send-message/);
      assert.match(logs[0] ?? '', /transition-task-status/);
      assert.match(logs[0] ?? '', /read-idle-state/);
      assert.match(logs[0] ?? '', /read-stall-state/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-api-specific help for omx team api help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api <operation>/);
      assert.match(logs[0] ?? '', /send-message/);
      assert.match(logs[0] ?? '', /transition-task-status/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints operation-specific help for omx team api <operation> --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'send-message', '--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api send-message --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /Required input fields/);
      assert.match(logs[0] ?? '', /from_worker/);
      assert.match(logs[0] ?? '', /to_worker/);
      assert.match(logs[0] ?? '', /body/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints operation-specific help for omx team api <operation> help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'claim-task', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api claim-task --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /expected_version/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints event query help for omx team api read-events help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'read-events', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api read-events --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /after_event_id/);
      assert.match(logs[0] ?? '', /wakeable_only/);
      assert.match(logs[0] ?? '', /worker_idle/);
    } finally {
      console.log = originalLog;
    }
  });

  it('executes read-events via CLI api with canonical JSON results', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-read-events-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-read-events', 'api event test', 'executor', 1, wd);
      await appendTeamEvent('api-read-events', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'read-events',
        '--input',
        JSON.stringify({
          team_name: 'api-read-events',
          type: 'worker_idle',
          worker: 'worker-1',
          task_id: '1',
        }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: {
          count?: number;
          events?: Array<{ type?: string; source_type?: string; worker?: string; task_id?: string }>;
        };
      };
      assert.equal(envelope.command, 'omx team api read-events');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'read-events');
      assert.equal(envelope.data?.count, 1);
      assert.equal(envelope.data?.events?.[0]?.type, 'worker_state_changed');
      assert.equal(envelope.data?.events?.[0]?.source_type, 'worker_idle');
      assert.equal(envelope.data?.events?.[0]?.worker, 'worker-1');
      assert.equal(envelope.data?.events?.[0]?.task_id, '1');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('executes read-idle-state via CLI api with structured JSON results', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-read-idle-state-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-read-idle', 'api idle state test', 'executor', 2, wd);
      await writeMonitorSnapshot('api-read-idle', {
        taskStatusById: {},
        workerAliveByName: { 'worker-1': true, 'worker-2': true },
        workerStateByName: { 'worker-1': 'idle', 'worker-2': 'working' },
        workerTurnCountByName: { 'worker-1': 2, 'worker-2': 4 },
        workerTaskIdByName: { 'worker-1': '', 'worker-2': '1' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, wd);
      await appendTeamEvent('api-read-idle', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'read-idle-state',
        '--input',
        JSON.stringify({ team_name: 'api-read-idle' }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: {
          all_workers_idle?: boolean;
          idle_worker_count?: number;
          idle_workers?: string[];
          non_idle_workers?: string[];
          last_idle_transition_by_worker?: Record<string, { source_type?: string } | null>;
        };
      };
      assert.equal(envelope.command, 'omx team api read-idle-state');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'read-idle-state');
      assert.equal(envelope.data?.all_workers_idle, false);
      assert.equal(envelope.data?.idle_worker_count, 1);
      assert.deepEqual(envelope.data?.idle_workers, ['worker-1']);
      assert.deepEqual(envelope.data?.non_idle_workers, ['worker-2']);
      assert.equal(envelope.data?.last_idle_transition_by_worker?.['worker-1']?.source_type, 'worker_idle');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('executes read-stall-state via CLI api with structured JSON results', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-read-stall-state-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-read-stall', 'api stall state test', 'executor', 2, wd);
      const task = await createTask('api-read-stall', {
        subject: 'Pending work',
        description: 'Needs leader attention',
        status: 'pending',
      }, wd);
      await writeWorkerStatus('api-read-stall', 'worker-1', {
        state: 'working',
        current_task_id: task.id,
        updated_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      await writeWorkerStatus('api-read-stall', 'worker-2', {
        state: 'idle',
        updated_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('api-read-stall', 'worker-1', {
        alive: true,
        pid: 201,
        turn_count: 1,
        last_turn_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('api-read-stall', 'worker-2', {
        alive: true,
        pid: 202,
        turn_count: 1,
        last_turn_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand([
        'api',
        'get-summary',
        '--input',
        JSON.stringify({ team_name: 'api-read-stall' }),
        '--json',
      ]);
      logs.length = 0;

      await updateWorkerHeartbeat('api-read-stall', 'worker-1', {
        alive: true,
        pid: 201,
        turn_count: 8,
        last_turn_at: '2026-03-10T10:05:00.000Z',
      }, wd);
      await writeMonitorSnapshot('api-read-stall', {
        taskStatusById: { [task.id]: 'pending' },
        workerAliveByName: { 'worker-1': true, 'worker-2': true },
        workerStateByName: { 'worker-1': 'idle', 'worker-2': 'idle' },
        workerTurnCountByName: { 'worker-1': 8, 'worker-2': 1 },
        workerTaskIdByName: { 'worker-1': task.id, 'worker-2': '' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, wd);
      await appendTeamEvent('api-read-stall', {
        type: 'all_workers_idle',
        worker: 'worker-2',
        worker_count: 2,
      }, wd);
      await appendTeamEvent('api-read-stall', {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: 'all_workers_idle',
      }, wd);

      await teamCommand([
        'api',
        'read-stall-state',
        '--input',
        JSON.stringify({ team_name: 'api-read-stall' }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: {
          team_stalled?: boolean;
          leader_stale?: boolean;
          stalled_workers?: string[];
          reasons?: string[];
        };
      };
      assert.equal(envelope.command, 'omx team api read-stall-state');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'read-stall-state');
      assert.equal(envelope.data?.team_stalled, true);
      assert.equal(envelope.data?.leader_stale, true);
      assert.deepEqual(envelope.data?.stalled_workers, ['worker-1']);
      assert.match((envelope.data?.reasons ?? []).join(' '), /leader_attention_pending:team_leader_nudge/);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('executes CLI interop operation with stable JSON envelope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-team', 'api test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'send-message',
        '--input',
        JSON.stringify({
          team_name: 'api-team',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'ACK',
        }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: { message?: { body?: string } };
      };
      assert.equal(envelope.schema_version, '1.0');
      assert.equal(typeof envelope.timestamp, 'string');
      assert.equal(envelope.command, 'omx team api send-message');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'send-message');
      assert.equal(envelope.data?.message?.body, 'ACK');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns deterministic JSON errors for invalid api usage with --json', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      process.exitCode = 0;
      await teamCommand(['api', 'unknown-operation', '--json']);
      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        ok?: boolean;
        operation?: string;
        error?: { code?: string; message?: string };
      };
      assert.equal(envelope.schema_version, '1.0');
      assert.equal(typeof envelope.timestamp, 'string');
      assert.equal(envelope.command, 'omx team api');
      assert.equal(envelope.ok, false);
      assert.equal(envelope.operation, 'unknown');
      assert.equal(envelope.error?.code, 'invalid_input');
      assert.match(envelope.error?.message ?? '', /Usage: omx team api/);
      assert.equal(process.exitCode, 1);
    } finally {
      console.log = originalLog;
      process.exitCode = 0;
    }
  });

  it('supports claim-safe lifecycle via CLI api (create -> claim -> transition)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-lifecycle-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('lifecycle-team', 'lifecycle test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'create-task',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          subject: 'Lifecycle task',
          description: 'Created through CLI interop',
        }),
        '--json',
      ]);
      const created = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { task?: { id?: string } };
      };
      assert.equal(created.ok, true);
      const taskId = created.data?.task?.id;
      assert.equal(typeof taskId, 'string');

      await teamCommand([
        'api',
        'claim-task',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          task_id: taskId,
          worker: 'worker-1',
          expected_version: 1,
        }),
        '--json',
      ]);
      const claimed = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { claimToken?: string };
      };
      assert.equal(claimed.ok, true);
      const claimToken = claimed.data?.claimToken;
      assert.equal(typeof claimToken, 'string');

      await teamCommand([
        'api',
        'transition-task-status',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          task_id: taskId,
          from: 'in_progress',
          to: 'completed',
          claim_token: claimToken,
        }),
        '--json',
      ]);
      const transitioned = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { ok?: boolean; task?: { status?: string } };
      };
      assert.equal(transitioned.ok, true);
      assert.equal(transitioned.data?.ok, true);
      assert.equal(transitioned.data?.task?.status, 'completed');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('accepts new canonical event types via CLI api append-event', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-event-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('event-team', 'event test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'append-event',
        '--input',
        JSON.stringify({
          team_name: 'event-team',
          type: 'leader_notification_deferred',
          worker: 'worker-1',
          to_worker: 'leader-fixed',
          source_type: 'worker_idle',
          reason: 'leader_pane_missing_no_injection',
        }),
        '--json',
      ]);

      const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { event?: { type?: string; to_worker?: string; reason?: string; source_type?: string } };
      };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data?.event?.type, 'leader_notification_deferred');
      assert.equal(envelope.data?.event?.to_worker, 'leader-fixed');
      assert.equal(envelope.data?.event?.source_type, 'worker_idle');
      assert.equal(envelope.data?.event?.reason, 'leader_pane_missing_no_injection');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});


describe('teamCommand status', () => {
  it('prints pane ids and sparkshell hint when tmux panes are recorded', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-panes-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await initTeamState('pane-team', 'inspect worker panes', 'executor', 2, wd);
      await createTask('pane-team', {
        subject: 'Recover worker-1 progress',
        description: 'Inspect worker-1 pane',
        status: 'pending',
        version: 3,
        requires_code_change: true,
        role: 'debugger',
        owner: 'worker-1',
      }, wd);
      await createTask('pane-team', {
        subject: 'Recover worker-2 progress',
        description: 'Inspect worker-2 pane',
        status: 'pending',
        version: 4,
        requires_code_change: false,
        blocked_by: ['1'],
        depends_on: ['1'],
        role: 'test-engineer',
        owner: 'worker-2',
        result: 'waiting on worker-1',
        error: 'blocked by dependency',
      }, wd);
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-1.json'),
        `${JSON.stringify({
          ...JSON.parse(await readFile(join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-1.json'), 'utf-8')) as Record<string, unknown>,
          created_at: '2026-03-10T23:55:00.000Z',
          claim: {
            owner: 'worker-1',
            token: 'claim-token-1',
            leased_until: '2026-03-11T00:10:00.000Z',
          },
        }, null, 2)}\n`,
      );
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-2.json'),
        `${JSON.stringify({
          ...JSON.parse(await readFile(join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-2.json'), 'utf-8')) as Record<string, unknown>,
          created_at: '2026-03-10T23:56:00.000Z',
          completed_at: '2026-03-11T00:06:00.000Z',
        }, null, 2)}\n`,
      );
      config.workers[0]!.worker_cli = 'codex';
      config.workers[1]!.worker_cli = 'gemini';
      config.workers[0]!.pid = 101;
      config.workers[1]!.pid = 102;
      config.workers[0]!.assigned_tasks = ['1'];
      config.workers[1]!.assigned_tasks = ['2', '3'];
      config.leader_pane_id = '%10';
      config.hud_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      config.workers[1]!.pane_id = '%22';
      config.workers[0]!.working_dir = '/tmp/pane-team/worker-1';
      config.workers[1]!.working_dir = '/tmp/pane-team/worker-2';
      config.workers[0]!.worktree_repo_root = '/tmp/pane-team/repo';
      config.workers[1]!.worktree_repo_root = '/tmp/pane-team/repo';
      config.workers[0]!.team_state_root = '/tmp/pane-team/.omx/state';
      config.workers[1]!.team_state_root = '/tmp/pane-team/.omx/state';
      config.workers[0]!.worktree_path = '/tmp/pane-team/worktrees/worker-1';
      config.workers[1]!.worktree_path = '/tmp/pane-team/worktrees/worker-2';
      config.workers[0]!.worktree_branch = 'feat/pane-team-worker-1';
      config.workers[1]!.worktree_branch = 'feat/pane-team-worker-2';
      config.workers[0]!.worktree_detached = false;
      config.workers[1]!.worktree_detached = true;
      config.workers[0]!.worktree_created = true;
      config.workers[1]!.worktree_created = false;
      await writeWorkerStatus('pane-team', 'worker-1', {
        state: 'working',
        current_task_id: '1',
        reason: 'recovering progress',
        updated_at: '2026-03-11T00:00:00.000Z',
      }, wd);
      await writeWorkerStatus('pane-team', 'worker-2', {
        state: 'blocked',
        current_task_id: '2',
        reason: 'waiting for dependency 1',
        updated_at: '2026-03-11T00:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('pane-team', 'worker-1', {
        pid: 101,
        last_turn_at: '2026-03-11T00:01:00.000Z',
        turn_count: 3,
        alive: false,
      }, wd);
      await updateWorkerHeartbeat('pane-team', 'worker-2', {
        pid: 102,
        last_turn_at: '2026-03-11T00:02:00.000Z',
        turn_count: 4,
        alive: false,
      }, wd);
      await writeTaskApproval('pane-team', {
        task_id: '1',
        required: true,
        status: 'approved',
        reviewer: 'leader-fixed',
        decision_reason: 'Looks good',
        decided_at: '2026-03-11T00:05:00.000Z',
      }, wd);
      const manifestPath = join(wd, '.omx', 'state', 'team', 'pane-team', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        leader_pane_id?: string | null;
        hud_pane_id?: string | null;
        workers?: Array<{ pane_id?: string }>;
      };
      manifest.leader_pane_id = config.leader_pane_id;
      manifest.hud_pane_id = config.hud_pane_id;
      manifest.workers = config.workers.map((worker) => ({
        ...worker,
        pane_id: worker.pane_id,
      }));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-team', 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['status', 'pane-team']);

      const output = logs.join('\n');
      assert.match(output, /dead_workers: worker-1 worker-2/);
      assert.match(output, /recommended_inspect_targets: worker-1 worker-2/);
      assert.match(output, /inspect_reason_worker-1: dead_worker/);
      assert.match(output, /inspect_reason_worker-2: dead_worker/);
      assert.match(output, /inspect_cli_worker-1: codex/);
      assert.match(output, /inspect_cli_worker-2: gemini/);
      assert.match(output, /inspect_role_worker-1: executor/);
      assert.match(output, /inspect_role_worker-2: executor/);
      assert.match(output, /inspect_index_worker-1: 1/);
      assert.match(output, /inspect_index_worker-2: 2/);
      assert.match(output, /inspect_alive_worker-1: false/);
      assert.match(output, /inspect_alive_worker-2: false/);
      assert.match(output, /inspect_turn_count_worker-1: 3/);
      assert.match(output, /inspect_turn_count_worker-2: 4/);
      assert.match(output, /inspect_turns_without_progress_worker-1: 0/);
      assert.match(output, /inspect_turns_without_progress_worker-2: 0/);
      assert.match(output, /inspect_last_turn_at_worker-1: 2026-03-11T00:01:00.000Z/);
      assert.match(output, /inspect_last_turn_at_worker-2: 2026-03-11T00:02:00.000Z/);
      assert.match(output, /inspect_status_updated_at_worker-1: 2026-03-11T00:00:00.000Z/);
      assert.match(output, /inspect_status_updated_at_worker-2: 2026-03-11T00:00:00.000Z/);
      assert.match(output, /inspect_pid_worker-1: 101/);
      assert.match(output, /inspect_pid_worker-2: 102/);
      assert.match(output, /inspect_worktree_path_worker-1: \/tmp\/pane-team\/worktrees\/worker-1/);
      assert.match(output, /inspect_worktree_path_worker-2: \/tmp\/pane-team\/worktrees\/worker-2/);
      assert.match(output, /inspect_worktree_repo_root_worker-1: \/tmp\/pane-team\/repo/);
      assert.match(output, /inspect_worktree_repo_root_worker-2: \/tmp\/pane-team\/repo/);
      assert.match(output, /inspect_worktree_branch_worker-1: feat\/pane-team-worker-1/);
      assert.match(output, /inspect_worktree_branch_worker-2: feat\/pane-team-worker-2/);
      assert.match(output, /inspect_worktree_detached_worker-1: false/);
      assert.match(output, /inspect_worktree_detached_worker-2: true/);
      assert.match(output, /inspect_worktree_created_worker-1: true/);
      assert.match(output, /inspect_worktree_created_worker-2: false/);
      assert.match(output, /inspect_team_state_root_worker-1: \/tmp\/pane-team\/\.omx\/state/);
      assert.match(output, /inspect_team_state_root_worker-2: \/tmp\/pane-team\/\.omx\/state/);
      assert.match(output, /inspect_workdir_worker-1: \/tmp\/pane-team\/worker-1/);
      assert.match(output, /inspect_workdir_worker-2: \/tmp\/pane-team\/worker-2/);
      assert.match(output, /inspect_assigned_tasks_worker-1: 1/);
      assert.match(output, /inspect_assigned_tasks_worker-2: 2 3/);
      assert.match(output, /inspect_task_status_worker-1: pending/);
      assert.match(output, /inspect_task_status_worker-2: pending/);
      assert.match(output, /inspect_task_result_worker-2: waiting on worker-1/);
      assert.match(output, /inspect_task_error_worker-2: blocked by dependency/);
      assert.match(output, /inspect_task_version_worker-1: 1/);
      assert.match(output, /inspect_task_version_worker-2: 1/);
      assert.match(output, /inspect_task_created_at_worker-1: 2026-03-10T23:55:00.000Z/);
      assert.match(output, /inspect_task_created_at_worker-2: 2026-03-10T23:56:00.000Z/);
      assert.match(output, /inspect_task_completed_at_worker-2: 2026-03-11T00:06:00.000Z/);
      assert.match(output, /inspect_task_depends_on_worker-2: 1/);
      assert.match(output, /inspect_task_claim_present_worker-1: true/);
      assert.match(output, /inspect_task_claim_present_worker-2: false/);
      assert.match(output, /inspect_task_claim_owner_worker-1: worker-1/);
      assert.match(output, /inspect_task_claim_token_worker-1: claim-token-1/);
      assert.match(output, /inspect_task_claim_leased_until_worker-1: 2026-03-11T00:10:00.000Z/);
      assert.match(output, /inspect_approval_required_worker-1: true/);
      assert.match(output, /inspect_requires_code_change_worker-1: true/);
      assert.match(output, /inspect_requires_code_change_worker-2: false/);
      assert.match(output, /inspect_description_worker-1: Inspect worker-1 pane/);
      assert.match(output, /inspect_description_worker-2: Inspect worker-2 pane/);
      assert.match(output, /inspect_blocked_by_worker-2: 1/);
      assert.match(output, /inspect_task_role_worker-1: debugger/);
      assert.match(output, /inspect_task_role_worker-2: test-engineer/);
      assert.match(output, /inspect_task_owner_worker-1: worker-1/);
      assert.match(output, /inspect_task_owner_worker-2: worker-2/);
      assert.match(output, /inspect_approval_status_worker-1: approved/);
      assert.match(output, /inspect_approval_reviewer_worker-1: leader-fixed/);
      assert.match(output, /inspect_approval_reason_worker-1: Looks good/);
      assert.match(output, /inspect_approval_decided_at_worker-1: 2026-03-11T00:05:00.000Z/);
      assert.match(output, /inspect_approval_record_present_worker-1: true/);
      assert.match(output, /inspect_state_worker-1: working/);
      assert.match(output, /inspect_state_worker-2: blocked/);
      assert.match(output, /inspect_state_reason_worker-1: recovering progress/);
      assert.match(output, /inspect_state_reason_worker-2: waiting for dependency 1/);
      assert.match(output, /inspect_task_worker-1: 1/);
      assert.match(output, /inspect_task_worker-2: 2/);
      assert.match(output, /inspect_subject_worker-1: Recover worker-1 progress/);
      assert.match(output, /inspect_subject_worker-2: Recover worker-2 progress/);
      assert.match(output, /inspect_task_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/tasks\/task-1\.json/);
      assert.match(output, /inspect_task_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/tasks\/task-2\.json/);
      assert.match(output, /inspect_approval_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/approvals\/task-1\.json/);
      assert.match(output, /inspect_approval_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/approvals\/task-2\.json/);
      assert.match(output, /inspect_worker_state_dir_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1/);
      assert.match(output, /inspect_worker_state_dir_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2/);
      assert.match(output, /inspect_worker_status_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1\/status\.json/);
      assert.match(output, /inspect_worker_status_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2\/status\.json/);
      assert.match(output, /inspect_worker_heartbeat_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1\/heartbeat\.json/);
      assert.match(output, /inspect_worker_heartbeat_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2\/heartbeat\.json/);
      assert.match(output, /inspect_worker_identity_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1\/identity\.json/);
      assert.match(output, /inspect_worker_identity_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2\/identity\.json/);
      assert.match(output, /inspect_worker_inbox_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1\/inbox\.md/);
      assert.match(output, /inspect_worker_inbox_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2\/inbox\.md/);
      assert.match(output, /inspect_worker_mailbox_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/mailbox\/worker-1\.json/);
      assert.match(output, /inspect_worker_mailbox_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/mailbox\/worker-2\.json/);
      assert.match(output, /inspect_worker_shutdown_request_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1\/shutdown-request\.json/);
      assert.match(output, /inspect_worker_shutdown_request_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2\/shutdown-request\.json/);
      assert.match(output, /inspect_worker_shutdown_ack_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-1\/shutdown-ack\.json/);
      assert.match(output, /inspect_worker_shutdown_ack_path_worker-2: .*\/\.omx\/state\/team\/pane-team\/workers\/worker-2\/shutdown-ack\.json/);
      assert.match(output, /inspect_team_dir_path_worker-1: .*\/\.omx\/state\/team\/pane-team/);
      assert.match(output, /inspect_team_config_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/config\.json/);
      assert.match(output, /inspect_team_manifest_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/manifest\.v2\.json/);
      assert.match(output, /inspect_team_events_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/events\/events\.ndjson/);
      assert.match(output, /inspect_team_dispatch_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/dispatch\/requests\.json/);
      assert.match(output, /inspect_team_phase_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/phase\.json/);
      assert.match(output, /inspect_team_monitor_snapshot_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/monitor-snapshot\.json/);
      assert.match(output, /inspect_team_summary_snapshot_path_worker-1: .*\/\.omx\/state\/team\/pane-team\/summary-snapshot\.json/);
      assert.match(output, /inspect_pane_worker-1: %21/);
      assert.match(output, /inspect_pane_worker-2: %22/);
      assert.match(output, /inspect_next: omx sparkshell --tmux-pane %21 --tail-lines 400/);
      assert.match(output, /inspect_summary: target=worker-1 pane=%21 cli=codex role=executor alive=false turn_count=3 turns_without_progress=0 reason=dead_worker state=working task=1 subject=Recover worker-1 progress command=omx sparkshell --tmux-pane %21 --tail-lines 400/);
      assert.match(output, /inspect_priority_1: omx sparkshell --tmux-pane %21 --tail-lines 400/);
      assert.match(output, /inspect_priority_2: omx sparkshell --tmux-pane %22 --tail-lines 400/);
      assert.match(output, /inspect_item_1: .*team_dir_path=.*\/\.omx\/state\/team\/pane-team .*team_config_path=.*\/\.omx\/state\/team\/pane-team\/config\.json .*team_manifest_path=.*\/\.omx\/state\/team\/pane-team\/manifest\.v2\.json .*command=omx sparkshell --tmux-pane %21 --tail-lines 400/);
      assert.match(output, /inspect_item_2: .*team_dir_path=.*\/\.omx\/state\/team\/pane-team .*team_config_path=.*\/\.omx\/state\/team\/pane-team\/config\.json .*team_manifest_path=.*\/\.omx\/state\/team\/pane-team\/manifest\.v2\.json .*command=omx sparkshell --tmux-pane %22 --tail-lines 400/);
      assert.match(output, /panes: leader=%10 hud=%11/);
      assert.match(output, /worker_panes: worker-1=%21 worker-2=%22/);
      assert.match(output, /sparkshell_hint: omx sparkshell --tmux-pane <pane-id> --tail-lines 400/);
      assert.match(output, /inspect_leader: omx sparkshell --tmux-pane %10 --tail-lines 400/);
      assert.match(output, /inspect_hud: omx sparkshell --tmux-pane %11 --tail-lines 400/);
      assert.match(output, /inspect_worker-1: omx sparkshell --tmux-pane %21 --tail-lines 400/);
      assert.match(output, /inspect_worker-2: omx sparkshell --tmux-pane %22 --tail-lines 400/);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns pane ids and sparkshell hint in JSON mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-json-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await initTeamState('pane-json-team', 'inspect worker panes', 'executor', 1, wd);
      await createTask('pane-json-team', {
        subject: 'Recover worker-1 progress',
        description: 'Inspect worker-1 pane',
        status: 'pending',
        version: 7,
        requires_code_change: true,
        role: 'debugger',
        owner: 'worker-1',
      }, wd);
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-json-team', 'tasks', 'task-1.json'),
        `${JSON.stringify({
          ...JSON.parse(await readFile(join(wd, '.omx', 'state', 'team', 'pane-json-team', 'tasks', 'task-1.json'), 'utf-8')) as Record<string, unknown>,
          created_at: '2026-03-10T23:57:00.000Z',
          claim: {
            owner: 'worker-1',
            token: 'claim-token-1',
            leased_until: '2026-03-11T00:11:00.000Z',
          },
        }, null, 2)}\n`,
      );
      config.workers[0]!.worker_cli = 'claude';
      config.workers[0]!.pid = 201;
      config.workers[0]!.assigned_tasks = ['1', 'extra-2'];
      config.leader_pane_id = '%30';
      config.hud_pane_id = '%31';
      config.workers[0]!.pane_id = '%41';
      config.workers[0]!.working_dir = '/tmp/pane-json-team/worker-1';
      config.workers[0]!.worktree_repo_root = '/tmp/pane-json-team/repo';
      config.workers[0]!.team_state_root = '/tmp/pane-json-team/.omx/state';
      config.workers[0]!.worktree_path = '/tmp/pane-json-team/worktrees/worker-1';
      config.workers[0]!.worktree_branch = 'feat/pane-json-team-worker-1';
      config.workers[0]!.worktree_detached = false;
      config.workers[0]!.worktree_created = true;
      await writeWorkerStatus('pane-json-team', 'worker-1', {
        state: 'working',
        current_task_id: '1',
        reason: 'recovering progress',
        updated_at: '2026-03-11T00:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('pane-json-team', 'worker-1', {
        pid: 201,
        last_turn_at: '2026-03-11T00:03:00.000Z',
        turn_count: 5,
        alive: false,
      }, wd);
      await writeTaskApproval('pane-json-team', {
        task_id: '1',
        required: true,
        status: 'approved',
        reviewer: 'leader-fixed',
        decision_reason: 'Looks good',
        decided_at: '2026-03-11T00:05:00.000Z',
      }, wd);
      const manifestPath = join(wd, '.omx', 'state', 'team', 'pane-json-team', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        leader_pane_id?: string | null;
        hud_pane_id?: string | null;
        workers?: Array<{ pane_id?: string }>;
      };
      manifest.leader_pane_id = config.leader_pane_id;
      manifest.hud_pane_id = config.hud_pane_id;
      manifest.workers = config.workers.map((worker) => ({
        ...worker,
        pane_id: worker.pane_id,
      }));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-json-team', 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['status', 'pane-json-team', '--json']);

      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        team_name?: string;
        status?: string;
        dead_workers?: string[];
        non_reporting_workers?: string[];
        panes?: {
          leader_pane_id?: string | null;
          hud_pane_id?: string | null;
          worker_panes?: Record<string, string>;
          sparkshell_hint?: string | null;
          sparkshell_commands?: Record<string, string>;
          recommended_inspect_targets?: string[];
          recommended_inspect_reasons?: Record<string, string>;
          recommended_inspect_clis?: Record<string, string | null>;
          recommended_inspect_roles?: Record<string, string | null>;
          recommended_inspect_indexes?: Record<string, number | null>;
          recommended_inspect_alive?: Record<string, boolean | null>;
          recommended_inspect_turn_counts?: Record<string, number | null>;
          recommended_inspect_turns_without_progress?: Record<string, number | null>;
          recommended_inspect_last_turn_at?: Record<string, string | null>;
          recommended_inspect_status_updated_at?: Record<string, string | null>;
          recommended_inspect_pids?: Record<string, number | null>;
          recommended_inspect_worktree_paths?: Record<string, string | null>;
          recommended_inspect_worktree_repo_roots?: Record<string, string | null>;
          recommended_inspect_worktree_branches?: Record<string, string | null>;
          recommended_inspect_worktree_detached?: Record<string, boolean | null>;
          recommended_inspect_worktree_created?: Record<string, boolean | null>;
          recommended_inspect_team_state_roots?: Record<string, string | null>;
          recommended_inspect_workdirs?: Record<string, string | null>;
          recommended_inspect_assigned_tasks?: Record<string, string[]>;
          recommended_inspect_task_statuses?: Record<string, string | null>;
          recommended_inspect_task_results?: Record<string, string | null>;
          recommended_inspect_task_errors?: Record<string, string | null>;
          recommended_inspect_task_versions?: Record<string, number | null>;
          recommended_inspect_task_created_at?: Record<string, string | null>;
          recommended_inspect_task_completed_at?: Record<string, string | null>;
          recommended_inspect_task_depends_on?: Record<string, string[]>;
          recommended_inspect_task_claim_present?: Record<string, boolean | null>;
          recommended_inspect_task_claim_owners?: Record<string, string | null>;
          recommended_inspect_task_claim_tokens?: Record<string, string | null>;
          recommended_inspect_task_claim_leases?: Record<string, string | null>;
          recommended_inspect_approval_required?: Record<string, boolean | null>;
          recommended_inspect_requires_code_change?: Record<string, boolean | null>;
          recommended_inspect_descriptions?: Record<string, string | null>;
          recommended_inspect_blocked_by?: Record<string, string[]>;
          recommended_inspect_task_roles?: Record<string, string | null>;
          recommended_inspect_task_owners?: Record<string, string | null>;
          recommended_inspect_approval_statuses?: Record<string, string | null>;
          recommended_inspect_approval_reviewers?: Record<string, string | null>;
          recommended_inspect_approval_reasons?: Record<string, string | null>;
          recommended_inspect_approval_decided_at?: Record<string, string | null>;
          recommended_inspect_approval_record_present?: Record<string, boolean | null>;
          recommended_inspect_states?: Record<string, string | null>;
          recommended_inspect_state_reasons?: Record<string, string | null>;
          recommended_inspect_tasks?: Record<string, string | null>;
          recommended_inspect_subjects?: Record<string, string | null>;
          recommended_inspect_task_paths?: Record<string, string | null>;
          recommended_inspect_approval_paths?: Record<string, string | null>;
          recommended_inspect_worker_state_dirs?: Record<string, string | null>;
          recommended_inspect_worker_status_paths?: Record<string, string | null>;
          recommended_inspect_worker_heartbeat_paths?: Record<string, string | null>;
          recommended_inspect_worker_identity_paths?: Record<string, string | null>;
          recommended_inspect_worker_inbox_paths?: Record<string, string | null>;
          recommended_inspect_worker_mailbox_paths?: Record<string, string | null>;
          recommended_inspect_worker_shutdown_request_paths?: Record<string, string | null>;
          recommended_inspect_worker_shutdown_ack_paths?: Record<string, string | null>;
          recommended_inspect_team_dir_paths?: Record<string, string | null>;
          recommended_inspect_team_config_paths?: Record<string, string | null>;
          recommended_inspect_team_manifest_paths?: Record<string, string | null>;
          recommended_inspect_team_events_paths?: Record<string, string | null>;
          recommended_inspect_team_dispatch_paths?: Record<string, string | null>;
          recommended_inspect_team_phase_paths?: Record<string, string | null>;
          recommended_inspect_team_monitor_snapshot_paths?: Record<string, string | null>;
          recommended_inspect_team_summary_snapshot_paths?: Record<string, string | null>;
          recommended_inspect_panes?: Record<string, string | null>;
          recommended_inspect_command?: string | null;
          recommended_inspect_commands?: string[];
          recommended_inspect_summary?: string | null;
          recommended_inspect_items?: Array<{
            target?: string;
            pane_id?: string;
            worker_cli?: string | null;
            role?: string | null;
            index?: number | null;
            alive?: boolean | null;
            turn_count?: number | null;
            turns_without_progress?: number | null;
            last_turn_at?: string | null;
            status_updated_at?: string | null;
            pid?: number | null;
            worktree_repo_root?: string | null;
            worktree_path?: string | null;
            worktree_branch?: string | null;
            worktree_detached?: boolean | null;
            worktree_created?: boolean | null;
            team_state_root?: string | null;
            working_dir?: string | null;
            assigned_tasks?: string[];
            task_status?: string | null;
            task_result?: string | null;
            task_error?: string | null;
            task_version?: number | null;
            task_created_at?: string | null;
            task_completed_at?: string | null;
            task_depends_on?: string[];
            task_claim_present?: boolean | null;
            task_claim_owner?: string | null;
            task_claim_token?: string | null;
            task_claim_leased_until?: string | null;
            approval_required?: boolean | null;
            requires_code_change?: boolean | null;
            task_description?: string | null;
            blocked_by?: string[];
            task_role?: string | null;
            task_owner?: string | null;
            approval_status?: string | null;
            approval_reviewer?: string | null;
            approval_reason?: string | null;
            approval_decided_at?: string | null;
            approval_record_present?: boolean | null;
            reason?: string;
            state?: string | null;
            state_reason?: string | null;
            task_id?: string | null;
            task_subject?: string | null;
            task_path?: string | null;
            approval_path?: string | null;
            worker_state_dir?: string | null;
            worker_status_path?: string | null;
            worker_heartbeat_path?: string | null;
            worker_identity_path?: string | null;
            worker_inbox_path?: string | null;
            worker_mailbox_path?: string | null;
            worker_shutdown_request_path?: string | null;
            worker_shutdown_ack_path?: string | null;
            team_dir_path?: string | null;
            team_config_path?: string | null;
            team_manifest_path?: string | null;
            team_events_path?: string | null;
            team_dispatch_path?: string | null;
            team_phase_path?: string | null;
            team_monitor_snapshot_path?: string | null;
            team_summary_snapshot_path?: string | null;
            command?: string;
          }>;
        };
      };
      assert.equal(payload.schema_version, '1.0');
      assert.equal(typeof payload.timestamp, 'string');
      assert.equal(payload.command, 'omx team status');
      assert.equal(payload.team_name, 'pane-json-team');
      assert.equal(payload.status, 'ok');
      assert.deepEqual(payload.dead_workers, ['worker-1']);
      assert.deepEqual(payload.non_reporting_workers, []);
      assert.deepEqual(payload.panes?.recommended_inspect_targets, ['worker-1']);
      assert.deepEqual(payload.panes?.recommended_inspect_reasons, { 'worker-1': 'dead_worker' });
      assert.deepEqual(payload.panes?.recommended_inspect_clis, { 'worker-1': 'claude' });
      assert.deepEqual(payload.panes?.recommended_inspect_roles, { 'worker-1': 'executor' });
      assert.deepEqual(payload.panes?.recommended_inspect_indexes, { 'worker-1': 1 });
      assert.deepEqual(payload.panes?.recommended_inspect_alive, { 'worker-1': false });
      assert.deepEqual(payload.panes?.recommended_inspect_turn_counts, { 'worker-1': 5 });
      assert.deepEqual(payload.panes?.recommended_inspect_turns_without_progress, { 'worker-1': 0 });
      assert.deepEqual(payload.panes?.recommended_inspect_last_turn_at, { 'worker-1': '2026-03-11T00:03:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_status_updated_at, { 'worker-1': '2026-03-11T00:00:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_pids, { 'worker-1': 201 });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_paths, { 'worker-1': '/tmp/pane-json-team/worktrees/worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_repo_roots, { 'worker-1': '/tmp/pane-json-team/repo' });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_branches, { 'worker-1': 'feat/pane-json-team-worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_detached, { 'worker-1': false });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_created, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_team_state_roots, { 'worker-1': '/tmp/pane-json-team/.omx/state' });
      assert.deepEqual(payload.panes?.recommended_inspect_workdirs, { 'worker-1': '/tmp/pane-json-team/worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_assigned_tasks, { 'worker-1': ['1', 'extra-2'] });
      assert.deepEqual(payload.panes?.recommended_inspect_task_statuses, { 'worker-1': 'pending' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_results, { 'worker-1': null });
      assert.deepEqual(payload.panes?.recommended_inspect_task_errors, { 'worker-1': null });
      assert.deepEqual(payload.panes?.recommended_inspect_task_versions, { 'worker-1': 1 });
      assert.deepEqual(payload.panes?.recommended_inspect_task_created_at, { 'worker-1': '2026-03-10T23:57:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_completed_at, { 'worker-1': null });
      assert.deepEqual(payload.panes?.recommended_inspect_task_depends_on, { 'worker-1': [] });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_present, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_owners, { 'worker-1': 'worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_tokens, { 'worker-1': 'claim-token-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_leases, { 'worker-1': '2026-03-11T00:11:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_required, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_requires_code_change, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_descriptions, { 'worker-1': 'Inspect worker-1 pane' });
      assert.deepEqual(payload.panes?.recommended_inspect_blocked_by, { 'worker-1': [] });
      assert.deepEqual(payload.panes?.recommended_inspect_task_roles, { 'worker-1': 'debugger' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_owners, { 'worker-1': 'worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_statuses, { 'worker-1': 'approved' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_reviewers, { 'worker-1': 'leader-fixed' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_reasons, { 'worker-1': 'Looks good' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_decided_at, { 'worker-1': '2026-03-11T00:05:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_record_present, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_states, { 'worker-1': 'working' });
      assert.deepEqual(payload.panes?.recommended_inspect_state_reasons, { 'worker-1': 'recovering progress' });
      assert.deepEqual(payload.panes?.recommended_inspect_tasks, { 'worker-1': '1' });
      assert.deepEqual(payload.panes?.recommended_inspect_subjects, { 'worker-1': 'Recover worker-1 progress' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/tasks/task-1.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/approvals/task-1.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_state_dirs, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_status_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1/status.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_heartbeat_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1/heartbeat.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_identity_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1/identity.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_inbox_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1/inbox.md` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_mailbox_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/mailbox/worker-1.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_shutdown_request_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-request.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_shutdown_ack_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-ack.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_dir_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_config_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/config.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_manifest_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/manifest.v2.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_events_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/events/events.ndjson` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_dispatch_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/dispatch/requests.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_phase_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/phase.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_monitor_snapshot_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/monitor-snapshot.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_summary_snapshot_paths, { 'worker-1': `${wd}/.omx/state/team/pane-json-team/summary-snapshot.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_panes, { 'worker-1': '%41' });
      assert.equal(payload.panes?.recommended_inspect_command, 'omx sparkshell --tmux-pane %41 --tail-lines 400');
      assert.deepEqual(payload.panes?.recommended_inspect_commands, ['omx sparkshell --tmux-pane %41 --tail-lines 400']);
      assert.equal(payload.panes?.recommended_inspect_summary, 'target=worker-1 pane=%41 cli=claude role=executor alive=false turn_count=5 turns_without_progress=0 reason=dead_worker state=working task=1 subject=Recover worker-1 progress command=omx sparkshell --tmux-pane %41 --tail-lines 400');
      assert.deepEqual(payload.panes?.recommended_inspect_items, [{
        target: 'worker-1',
        pane_id: '%41',
        worker_cli: 'claude',
        role: 'executor',
        index: 1,
        alive: false,
        turn_count: 5,
        turns_without_progress: 0,
        last_turn_at: '2026-03-11T00:03:00.000Z',
        status_updated_at: '2026-03-11T00:00:00.000Z',
        pid: 201,
        worktree_repo_root: '/tmp/pane-json-team/repo',
        worktree_path: '/tmp/pane-json-team/worktrees/worker-1',
        worktree_branch: 'feat/pane-json-team-worker-1',
        worktree_detached: false,
        worktree_created: true,
        team_state_root: '/tmp/pane-json-team/.omx/state',
        working_dir: '/tmp/pane-json-team/worker-1',
        assigned_tasks: ['1', 'extra-2'],
        task_status: 'pending',
        task_result: null,
        task_error: null,
        task_version: 1,
        task_created_at: '2026-03-10T23:57:00.000Z',
        task_completed_at: null,
        task_depends_on: [],
        task_claim_present: true,
        task_claim_owner: 'worker-1',
        task_claim_token: 'claim-token-1',
        task_claim_leased_until: '2026-03-11T00:11:00.000Z',
        task_claim_lock_path: `${wd}/.omx/state/team/pane-json-team/claims/task-1.lock`,
        approval_required: true,
        requires_code_change: true,
        task_description: 'Inspect worker-1 pane',
        blocked_by: [],
        task_role: 'debugger',
        task_owner: 'worker-1',
        approval_status: 'approved',
        approval_reviewer: 'leader-fixed',
        approval_reason: 'Looks good',
        approval_decided_at: '2026-03-11T00:05:00.000Z',
        approval_record_present: true,
        reason: 'dead_worker',
        state: 'working',
        state_reason: 'recovering progress',
        task_id: '1',
        task_subject: 'Recover worker-1 progress',
        task_path: `${wd}/.omx/state/team/pane-json-team/tasks/task-1.json`,
        approval_path: `${wd}/.omx/state/team/pane-json-team/approvals/task-1.json`,
        worker_state_dir: `${wd}/.omx/state/team/pane-json-team/workers/worker-1`,
        worker_status_path: `${wd}/.omx/state/team/pane-json-team/workers/worker-1/status.json`,
        worker_heartbeat_path: `${wd}/.omx/state/team/pane-json-team/workers/worker-1/heartbeat.json`,
        worker_identity_path: `${wd}/.omx/state/team/pane-json-team/workers/worker-1/identity.json`,
        worker_inbox_path: `${wd}/.omx/state/team/pane-json-team/workers/worker-1/inbox.md`,
        worker_mailbox_path: `${wd}/.omx/state/team/pane-json-team/mailbox/worker-1.json`,
        worker_shutdown_request_path: `${wd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-request.json`,
        worker_shutdown_ack_path: `${wd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-ack.json`,
        team_dir_path: `${wd}/.omx/state/team/pane-json-team`,
        team_config_path: `${wd}/.omx/state/team/pane-json-team/config.json`,
        team_manifest_path: `${wd}/.omx/state/team/pane-json-team/manifest.v2.json`,
        team_events_path: `${wd}/.omx/state/team/pane-json-team/events/events.ndjson`,
        team_dispatch_path: `${wd}/.omx/state/team/pane-json-team/dispatch/requests.json`,
        team_phase_path: `${wd}/.omx/state/team/pane-json-team/phase.json`,
        team_monitor_snapshot_path: `${wd}/.omx/state/team/pane-json-team/monitor-snapshot.json`,
        team_summary_snapshot_path: `${wd}/.omx/state/team/pane-json-team/summary-snapshot.json`,
        command: 'omx sparkshell --tmux-pane %41 --tail-lines 400',
      }]);
      assert.equal(payload.panes?.leader_pane_id, '%30');
      assert.equal(payload.panes?.hud_pane_id, '%31');
      assert.deepEqual(payload.panes?.worker_panes, { 'worker-1': '%41' });
      assert.equal(payload.panes?.sparkshell_hint, 'omx sparkshell --tmux-pane <pane-id> --tail-lines 400');
      assert.deepEqual(payload.panes?.sparkshell_commands, {
        leader: 'omx sparkshell --tmux-pane %30 --tail-lines 400',
        hud: 'omx sparkshell --tmux-pane %31 --tail-lines 400',
        'worker-1': 'omx sparkshell --tmux-pane %41 --tail-lines 400',
      });
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns a missing envelope in JSON mode when team state is absent', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-missing-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['status', 'missing-team', '--json']);

      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        team_name?: string;
        status?: string;
      };
      assert.equal(payload.schema_version, '1.0');
      assert.equal(typeof payload.timestamp, 'string');
      assert.equal(payload.command, 'omx team status');
      assert.equal(payload.team_name, 'missing-team');
      assert.equal(payload.status, 'missing');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports custom tail lines for generated sparkshell commands', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-tail-lines-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await initTeamState('pane-tail-team', 'inspect worker panes', 'executor', 1, wd);
      config.workers[0]!.pane_id = '%51';
      const manifestPath = join(wd, '.omx', 'state', 'team', 'pane-tail-team', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        workers?: Array<{ pane_id?: string }>;
      };
      manifest.workers = config.workers.map((worker) => ({
        ...worker,
        pane_id: worker.pane_id,
      }));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-tail-team', 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['status', 'pane-tail-team', '--tail-lines', '600']);
      assert.match(logs.join('\n'), /inspect_worker-1: omx sparkshell --tmux-pane %51 --tail-lines 600/);

      logs.length = 0;
      await teamCommand(['status', 'pane-tail-team', '--json', '--tail-lines=550']);
      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        tail_lines?: number;
        panes?: { sparkshell_commands?: Record<string, string> };
      };
      assert.equal(payload.tail_lines, 550);
      assert.equal(payload.panes?.sparkshell_commands?.['worker-1'], 'omx sparkshell --tmux-pane %51 --tail-lines 550');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('teamCommand await', () => {
  it('returns next canonical event for a team in JSON mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-await-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('await-team', 'await test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      const waitPromise = teamCommand(['await', 'await-team', '--json', '--timeout-ms', '500']);
      setTimeout(() => {
        void appendTeamEvent('await-team', {
          type: 'worker_state_changed',
          worker: 'worker-1',
          state: 'blocked',
          prev_state: 'working',
          reason: 'needs_follow_up',
        }, wd);
      }, 50);
      await waitPromise;

      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        team_name?: string;
        status?: string;
        cursor?: string;
        event?: { type?: string; state?: string; prev_state?: string; reason?: string } | null;
      };
      assert.equal(payload.team_name, 'await-team');
      assert.equal(payload.status, 'event');
      assert.equal(typeof payload.cursor, 'string');
      assert.equal(payload.event?.type, 'worker_state_changed');
      assert.equal(payload.event?.state, 'blocked');
      assert.equal(payload.event?.prev_state, 'working');
      assert.equal(payload.event?.reason, 'needs_follow_up');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns a dead-worker event for the prompt-launch smoke path instead of timing out', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-await-prompt-dead-'));
    const binDir = join(wd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const logs: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const teamTask = 'issue 662 prompt dead worker smoke';
    const teamName = parseTeamStartArgs(['1:executor', teamTask]).parsed.teamName;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
setTimeout(() => process.exit(0), 150);
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
`,
    );
    await chmod(fakeCodexPath, 0o755);

    try {
      process.chdir(wd);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      delete process.env.TMUX;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      await teamCommand(['1:executor', teamTask]);
      await new Promise((resolve) => setTimeout(resolve, 500));

      logs.length = 0;
      stderr.length = 0;
      await teamCommand(['status', teamName]);
      assert.match(logs.join('\n'), /phase=failed/);
      assert.doesNotMatch(stderr.join('\n'), /ESRCH/);

      logs.length = 0;
      await teamCommand(['await', teamName, '--json', '--timeout-ms', '250']);
      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        team_name?: string;
        status?: string;
        event?: { type?: string; worker?: string; reason?: string | null } | null;
      };
      assert.equal(payload.team_name, teamName);
      assert.equal(payload.status, 'event');
      assert.equal(payload.event?.type, 'worker_stopped');
      assert.equal(payload.event?.worker, 'worker-1');
    } finally {
      console.log = originalLog;
      process.stderr.write = originalStderrWrite;
      process.chdir(previousCwd);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('establishes Ralph-side linked state for real omx team ralph launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-ralph-link-'));
    const binDir = join(wd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
setTimeout(() => process.exit(0), 150);
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
`,
    );
    await chmod(fakeCodexPath, 0o755);

    try {
      process.chdir(wd);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      delete process.env.TMUX;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';

      const teamTask = 'issue 742 linked ralph launch';
      const teamName = parseTeamStartArgs(['ralph', '1:executor', teamTask]).parsed.teamName;
      await teamCommand(['ralph', '1:executor', teamTask]);

      const teamState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'team-state.json'), 'utf-8')) as Record<string, unknown>;
      const ralphState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;

      assert.equal(teamState.linked_ralph, true);
      assert.equal(teamState.team_name, teamName);
      assert.equal(ralphState.active, true);
      assert.equal(ralphState.current_phase, 'executing');
      assert.equal(ralphState.linked_team, true);
      assert.equal(ralphState.linked_mode, 'team');
      assert.equal(ralphState.team_name, teamName);
      assert.equal(ralphState.linked_team_terminal_phase, undefined);
      assert.equal(ralphState.linked_team_terminal_at, undefined);
    } finally {
      process.chdir(previousCwd);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
