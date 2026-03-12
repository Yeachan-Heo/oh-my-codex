import { describe, it } from 'bun:test';
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
