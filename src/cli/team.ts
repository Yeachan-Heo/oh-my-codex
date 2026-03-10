import { updateModeState, startMode, readModeState } from '../modes/base.js';
import { monitorTeam, resumeTeam, shutdownTeam, startTeam, type TeamRuntime, type TeamSnapshot } from '../team/runtime.js';
import { DEFAULT_MAX_WORKERS } from '../team/state.js';
import { sanitizeTeamName } from '../team/tmux-session.js';
import { readTeamEvents, waitForTeamEvent } from '../team/state/events.js';
import type { TeamEvent } from '../team/state.js';
import { parseWorktreeMode, type WorktreeMode } from '../team/worktree.js';
import { routeTaskToRole } from '../team/role-router.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
  type FollowupStaffingPlan,
} from '../team/followup-planner.js';
import {
  TEAM_API_OPERATIONS,
  resolveTeamApiOperation,
  executeTeamApiOperation,
  type TeamApiOperation,
} from '../team/api-interop.js';
import { teamReadConfig as readTeamConfig } from '../team/team-ops.js';

interface TeamCliOptions {
  verbose?: boolean;
}

interface ParsedTeamArgs {
  workerCount: number;
  agentType: string;
  explicitAgentType: boolean;
  task: string;
  teamName: string;
  ralph: boolean;
}

const MIN_WORKER_COUNT = 1;
const TEAM_HELP = `
Usage: omx team [ralph] [N:agent-type] "<task description>"
       omx team status <team-name>
       omx team await <team-name> [--timeout-ms <ms>] [--after-event-id <id>] [--json]
       omx team resume <team-name>
       omx team shutdown <team-name> [--force] [--ralph]
       omx team api <operation> [--input <json>] [--json]
       omx team api --help

Examples:
  omx team 3:executor "fix failing tests"
  omx team status my-team
  omx team api send-message --input '{"team_name":"my-team","from_worker":"worker-1","to_worker":"leader-fixed","body":"ACK"}' --json
`;

const TEAM_API_HELP = `
Usage: omx team api <operation> [--input <json>] [--json]
       omx team api <operation> --help

Supported operations:
  ${TEAM_API_OPERATIONS.join('\n  ')}

Examples:
  omx team api list-tasks --input '{"team_name":"my-team"}' --json
  omx team api claim-task --input '{"team_name":"my-team","task_id":"1","worker":"worker-1","expected_version":1}' --json
`;

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

const TEAM_API_OPERATION_REQUIRED_FIELDS: Record<TeamApiOperation, string[]> = {
  'send-message': ['team_name', 'from_worker', 'to_worker', 'body'],
  'broadcast': ['team_name', 'from_worker', 'body'],
  'mailbox-list': ['team_name', 'worker'],
  'mailbox-mark-delivered': ['team_name', 'worker', 'message_id'],
  'mailbox-mark-notified': ['team_name', 'worker', 'message_id'],
  'create-task': ['team_name', 'subject', 'description'],
  'read-task': ['team_name', 'task_id'],
  'list-tasks': ['team_name'],
  'update-task': ['team_name', 'task_id'],
  'claim-task': ['team_name', 'task_id', 'worker'],
  'transition-task-status': ['team_name', 'task_id', 'from', 'to', 'claim_token'],
  'release-task-claim': ['team_name', 'task_id', 'claim_token', 'worker'],
  'read-config': ['team_name'],
  'read-manifest': ['team_name'],
  'read-worker-status': ['team_name', 'worker'],
  'read-worker-heartbeat': ['team_name', 'worker'],
  'update-worker-heartbeat': ['team_name', 'worker', 'pid', 'turn_count', 'alive'],
  'write-worker-inbox': ['team_name', 'worker', 'content'],
  'write-worker-identity': ['team_name', 'worker', 'index', 'role'],
  'append-event': ['team_name', 'type', 'worker'],
  'get-summary': ['team_name'],
  'cleanup': ['team_name'],
  'write-shutdown-request': ['team_name', 'worker', 'requested_by'],
  'read-shutdown-ack': ['team_name', 'worker'],
  'read-monitor-snapshot': ['team_name'],
  'write-monitor-snapshot': ['team_name', 'snapshot'],
  'read-task-approval': ['team_name', 'task_id'],
  'write-task-approval': ['team_name', 'task_id', 'status', 'reviewer', 'decision_reason'],
};

const TEAM_API_OPERATION_OPTIONAL_FIELDS: Partial<Record<TeamApiOperation, string[]>> = {
  'create-task': ['owner', 'blocked_by', 'requires_code_change'],
  'update-task': ['subject', 'description', 'blocked_by', 'requires_code_change'],
  'claim-task': ['expected_version'],
  'read-shutdown-ack': ['min_updated_at'],
  'write-worker-identity': [
    'assigned_tasks', 'pid', 'pane_id', 'working_dir',
    'worktree_path', 'worktree_branch', 'worktree_detached', 'team_state_root',
  ],
  'append-event': ['task_id', 'message_id', 'reason'],
  'write-task-approval': ['required'],
};

const TEAM_API_OPERATION_NOTES: Partial<Record<TeamApiOperation, string>> = {
  'update-task': 'Only non-lifecycle task metadata can be updated.',
  'release-task-claim': 'Use this only for rollback/requeue to pending (not for completion).',
  'transition-task-status': 'Lifecycle flow is claim-safe and typically transitions in_progress -> completed|failed.',
};

function sampleValueForTeamApiField(field: string): unknown {
  switch (field) {
    case 'team_name': return 'my-team';
    case 'from_worker': return 'worker-1';
    case 'to_worker': return 'leader-fixed';
    case 'worker': return 'worker-1';
    case 'body': return 'ACK';
    case 'subject': return 'Demo task';
    case 'description': return 'Created through CLI interop';
    case 'task_id': return '1';
    case 'message_id': return 'msg-123';
    case 'from': return 'in_progress';
    case 'to': return 'completed';
    case 'claim_token': return 'claim-token';
    case 'expected_version': return 1;
    case 'pid': return 12345;
    case 'turn_count': return 12;
    case 'alive': return true;
    case 'content': return '# Inbox update\nProceed with task 2.';
    case 'index': return 1;
    case 'role': return 'executor';
    case 'assigned_tasks': return ['1', '2'];
    case 'type': return 'task_completed';
    case 'requested_by': return 'leader-fixed';
    case 'min_updated_at': return '2026-03-04T00:00:00.000Z';
    case 'snapshot':
      return {
        taskStatusById: { '1': 'completed' },
        workerAliveByName: { 'worker-1': true },
        workerStateByName: { 'worker-1': 'idle' },
        workerTurnCountByName: { 'worker-1': 12 },
        workerTaskIdByName: { 'worker-1': '1' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: { '1': true },
      };
    case 'status': return 'approved';
    case 'reviewer': return 'leader-fixed';
    case 'decision_reason': return 'approved in demo';
    case 'required': return true;
    default: return `<${field}>`;
  }
}

function buildTeamApiOperationHelp(operation: TeamApiOperation): string {
  const requiredFields = TEAM_API_OPERATION_REQUIRED_FIELDS[operation] ?? [];
  const optionalFields = TEAM_API_OPERATION_OPTIONAL_FIELDS[operation] ?? [];
  const sampleInput: Record<string, unknown> = {};

  for (const field of requiredFields) {
    sampleInput[field] = sampleValueForTeamApiField(field);
  }
  const sampleInputJson = JSON.stringify(sampleInput);
  const required = requiredFields.length > 0
    ? requiredFields.map((field) => `  - ${field}`).join('\n')
    : '  (none)';
  const optional = optionalFields.length > 0
    ? `\nOptional input fields:\n${optionalFields.map((field) => `  - ${field}`).join('\n')}\n`
    : '\n';
  const note = TEAM_API_OPERATION_NOTES[operation]
    ? `\nNote:\n  ${TEAM_API_OPERATION_NOTES[operation]}\n`
    : '';

  return `
Usage: omx team api ${operation} --input <json> [--json]

Required input fields:
${required}${optional}${note}Example:
  omx team api ${operation} --input '${sampleInputJson}' --json
`.trim();
}

export interface ParsedTeamStartArgs {
  parsed: ParsedTeamArgs;
  worktreeMode: WorktreeMode;
}

function parseTeamApiArgs(args: string[]): {
  operation: TeamApiOperation;
  input: Record<string, unknown>;
  json: boolean;
} {
  const operation = resolveTeamApiOperation(args[0] || '');
  if (!operation) {
    throw new Error(`Usage: omx team api <operation> [--input <json>] [--json]\nSupported operations: ${TEAM_API_OPERATIONS.join(', ')}`);
  }
  let input: Record<string, unknown> = {};
  let json = false;
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--input') {
      const next = args[i + 1];
      if (!next) throw new Error('Missing value after --input');
      try {
        const parsed = JSON.parse(next) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('input must be a JSON object');
        }
        input = parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      i += 1;
      continue;
    }
    if (token.startsWith('--input=')) {
      const raw = token.slice('--input='.length);
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('input must be a JSON object');
        }
        input = parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    throw new Error(`Unknown argument for "omx team api": ${token}`);
  }
  return { operation, input, json };
}

function slugifyTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'team-task';
}

function snapshotHasDeadWorkerStall(snapshot: TeamSnapshot): boolean {
  return snapshot.deadWorkers.length > 0 && (snapshot.tasks.pending + snapshot.tasks.in_progress) > 0;
}

function buildDeadWorkerAwaitEvent(teamName: string, snapshot: TeamSnapshot): TeamEvent | null {
  const deadWorker = snapshot.workers.find((worker) => worker.alive === false);
  if (!deadWorker) return null;
  return {
    event_id: `snapshot-${Date.now()}`,
    team: sanitizeTeamName(teamName),
    type: 'worker_stopped',
    worker: deadWorker.name,
    task_id: deadWorker.status.current_task_id,
    message_id: null,
    reason: deadWorker.status.reason ?? 'dead_worker_detected_during_await',
    created_at: deadWorker.status.updated_at || new Date().toISOString(),
    source_type: 'await_snapshot',
  };
}

function parseTeamArgs(args: string[]): ParsedTeamArgs {
  const tokens = [...args];
  let ralph = false;
  let workerCount = 3;
  let agentType = 'executor';
  let explicitAgentType = false;

  if (tokens[0]?.toLowerCase() === 'ralph') {
    ralph = true;
    tokens.shift();
  }

  const first = tokens[0] || '';
  const match = first.match(/^(\d+)(?::([a-z][a-z0-9-]*))?$/i);
  if (match) {
    const count = Number.parseInt(match[1], 10);
    if (!Number.isFinite(count) || count < MIN_WORKER_COUNT || count > DEFAULT_MAX_WORKERS) {
      throw new Error(`Invalid worker count "${match[1]}". Expected ${MIN_WORKER_COUNT}-${DEFAULT_MAX_WORKERS}.`);
    }
    workerCount = count;
    if (match[2]) {
      agentType = match[2];
      explicitAgentType = true;
    }
    tokens.shift();
  }

  const task = tokens.join(' ').trim();
  if (!task) {
    throw new Error('Usage: omx team [ralph] [N:agent-type] "<task description>"');
  }

  const teamName = sanitizeTeamName(slugifyTask(task));
  return { workerCount, agentType, explicitAgentType, task, teamName, ralph };
}

export function parseTeamStartArgs(args: string[]): ParsedTeamStartArgs {
  const parsedWorktree = parseWorktreeMode(args);
  return {
    parsed: parseTeamArgs(parsedWorktree.remainingArgs),
    worktreeMode: parsedWorktree.mode,
  };
}

/**
 * Decompose a compound task string into distinct sub-tasks with role assignments.
 *
 * Decomposition strategy:
 * 1. Numbered list detection: "1. ... 2. ... 3. ..."
 * 2. Conjunction splitting: split on " and ", ", ", "; "
 * 3. Fallback for atomic tasks: create implementation + test + doc sub-tasks
 *
 * When the user specifies an explicit agent-type (e.g., `3:executor`), all tasks
 * get that role (backward compat). Otherwise, heuristic routing assigns roles.
 */
export function decomposeTaskString(
  task: string,
  workerCount: number,
  agentType: string,
  explicitAgentType: boolean,
): Array<{ subject: string; description: string; owner: string; role?: string }> {
  // Try to split the task into distinct sub-goals
  let subtasks = splitTaskString(task);

  // If no decomposition possible, create aspect-scoped sub-tasks for N>1
  if (subtasks.length <= 1 && workerCount > 1) {
    subtasks = createAspectSubtasks(task, workerCount);
  }

  // Assign roles: skip heuristic routing if user specified explicit agent-type
  const tasksWithRoles = subtasks.map((st) => {
    if (explicitAgentType) {
      return { ...st, role: agentType };
    }
    const result = routeTaskToRole(st.subject, st.description, 'team-exec', agentType);
    return { ...st, role: result.role };
  });

  // Distribute tasks across workers
  return distributeTasksToWorkers(tasksWithRoles, workerCount);
}

/** Split a task string into sub-tasks using numbered lists or conjunctions. */
function splitTaskString(task: string): Array<{ subject: string; description: string }> {
  // Try numbered list: "1. foo 2. bar 3. baz" or "1) foo 2) bar"
  const numberedPattern = /(?:^|\s)(\d+)[.)]\s+/g;
  const numberedMatches = [...task.matchAll(numberedPattern)];
  if (numberedMatches.length >= 2) {
    const parts: Array<{ subject: string; description: string }> = [];
    for (let i = 0; i < numberedMatches.length; i++) {
      const prefixLen = numberedMatches[i][0].length;
      const contentStart = numberedMatches[i].index! + prefixLen;
      const end = i + 1 < numberedMatches.length ? numberedMatches[i + 1].index! : task.length;
      const text = task.slice(contentStart, end).trim();
      if (text) {
        parts.push({ subject: text.slice(0, 80), description: text });
      }
    }
    if (parts.length >= 2) return parts;
  }

  // Try conjunction splitting: " and ", ", ", "; "
  // Only split on top-level conjunctions (not inside quoted strings)
  const conjunctionPattern = /(?:,\s+|\s+and\s+|;\s+)/i;
  const parts = task.split(conjunctionPattern).map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length >= 2) {
    return parts.map(p => ({ subject: p.slice(0, 80), description: p }));
  }

  // Single atomic task
  return [{ subject: task.slice(0, 80), description: task }];
}

/** Create aspect-scoped sub-tasks for an atomic task that can't be split. */
function createAspectSubtasks(
  task: string,
  workerCount: number,
): Array<{ subject: string; description: string }> {
  const aspects = [
    { subject: `Implement: ${task}`.slice(0, 80), description: `Implement the core functionality for: ${task}` },
    { subject: `Test: ${task}`.slice(0, 80), description: `Write tests and verify: ${task}` },
    { subject: `Review and document: ${task}`.slice(0, 80), description: `Review code quality and update documentation for: ${task}` },
  ];

  // Return up to workerCount aspects, repeating implementation for extra workers
  const result = aspects.slice(0, workerCount);
  while (result.length < workerCount) {
    const idx = result.length - aspects.length;
    result.push({
      subject: `Additional work (${idx + 1}): ${task}`.slice(0, 80),
      description: `Continue implementation work on: ${task}`,
    });
  }
  return result;
}

/** Distribute tasks across workers, assigning owners round-robin. */
function distributeTasksToWorkers(
  tasks: Array<{ subject: string; description: string; role?: string }>,
  workerCount: number,
): Array<{ subject: string; description: string; owner: string; role?: string }> {
  return tasks.map((t, i) => ({
    ...t,
    owner: `worker-${(i % workerCount) + 1}`,
  }));
}

async function ensureTeamModeState(
  parsed: ParsedTeamArgs,
  tasks?: Array<{ role?: string }>,
): Promise<void> {
  const roleDistribution = tasks && tasks.length > 0
    ? [...new Set(tasks.map(t => t.role ?? parsed.agentType))].join(',')
    : parsed.agentType;

  const availableAgentTypes = await resolveAvailableAgentTypes(process.cwd());
  const staffingPlan = buildFollowupStaffingPlan('team', parsed.task, availableAgentTypes, {
    workerCount: parsed.workerCount,
    fallbackRole: parsed.agentType,
  });

  const existing = await readModeState('team');
  if (existing?.active) {
    await updateModeState('team', {
      task_description: parsed.task,
      current_phase: 'team-exec',
      linked_ralph: parsed.ralph,
      team_name: parsed.teamName,
      agent_count: parsed.workerCount,
      agent_types: roleDistribution,
      available_agent_types: availableAgentTypes,
      staffing_summary: staffingPlan.staffingSummary,
      staffing_allocations: staffingPlan.allocations,
    });
    return;
  }

  await startMode('team', parsed.task, 50);
  await updateModeState('team', {
    current_phase: 'team-exec',
    linked_ralph: parsed.ralph,
    team_name: parsed.teamName,
    agent_count: parsed.workerCount,
    agent_types: roleDistribution,
    available_agent_types: availableAgentTypes,
    staffing_summary: staffingPlan.staffingSummary,
    staffing_allocations: staffingPlan.allocations,
  });
}

async function renderStartSummary(runtime: TeamRuntime, staffingPlan?: FollowupStaffingPlan): Promise<void> {
  console.log(`Team started: ${runtime.teamName}`);
  console.log(`tmux target: ${runtime.sessionName}`);
  console.log(`workers: ${runtime.config.worker_count}`);
  console.log(`agent_type: ${runtime.config.agent_type}`);
  if (staffingPlan) {
    console.log(`available_agent_types: ${staffingPlan.rosterSummary}`);
    console.log(`staffing_plan: ${staffingPlan.staffingSummary}`);
  }

  const snapshot = await monitorTeam(runtime.teamName, runtime.cwd);
  if (!snapshot) {
    console.log('warning: team snapshot unavailable immediately after startup');
    return;
  }
  console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} blocked=${snapshot.tasks.blocked} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
  if (snapshot.performance) {
    console.log(
      `monitor_perf_ms: total=${snapshot.performance.total_ms} list=${snapshot.performance.list_tasks_ms} workers=${snapshot.performance.worker_scan_ms} mailbox=${snapshot.performance.mailbox_delivery_ms}`
    );
  }
}

export async function teamCommand(args: string[], options: TeamCliOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const parsedWorktree = parseWorktreeMode(args);
  const teamArgs = parsedWorktree.remainingArgs;
  const [subcommandRaw] = teamArgs;
  const subcommand = (subcommandRaw || '').toLowerCase();

  if (HELP_TOKENS.has(subcommand)) {
    console.log(TEAM_HELP.trim());
    return;
  }

  if (subcommand === 'api') {
    const apiSubcommand = (teamArgs[1] || '').toLowerCase();
    if (HELP_TOKENS.has(apiSubcommand)) {
      const operationFromHelpAlias = resolveTeamApiOperation((teamArgs[2] || '').toLowerCase());
      if (operationFromHelpAlias) {
        console.log(buildTeamApiOperationHelp(operationFromHelpAlias));
        return;
      }
      console.log(TEAM_API_HELP.trim());
      return;
    }
    const operation = resolveTeamApiOperation(apiSubcommand);
    if (operation) {
      const trailing = teamArgs.slice(2).map((token) => token.toLowerCase());
      if (trailing.some((token) => HELP_TOKENS.has(token))) {
        console.log(buildTeamApiOperationHelp(operation));
        return;
      }
    }
    const wantsJson = teamArgs.includes('--json');
    const jsonBase = {
      schema_version: '1.0',
      timestamp: new Date().toISOString(),
    };
    let parsedApi: ReturnType<typeof parseTeamApiArgs>;
    try {
      parsedApi = parseTeamApiArgs(teamArgs.slice(1));
    } catch (error) {
      if (wantsJson) {
        console.log(JSON.stringify({
          ...jsonBase,
          ok: false,
          command: 'omx team api',
          operation: 'unknown',
          error: {
            code: 'invalid_input',
            message: error instanceof Error ? error.message : String(error),
          },
        }));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    const envelope = await executeTeamApiOperation(parsedApi.operation, parsedApi.input, cwd);
    if (parsedApi.json) {
      console.log(JSON.stringify({
        ...jsonBase,
        command: `omx team api ${parsedApi.operation}`,
        ...envelope,
      }));
      if (!envelope.ok) process.exitCode = 1;
      return;
    }
    if (envelope.ok) {
      console.log(`ok operation=${envelope.operation}`);
      console.log(JSON.stringify(envelope.data, null, 2));
      return;
    }
    console.error(`error operation=${envelope.operation} code=${envelope.error.code}: ${envelope.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (subcommand === 'status') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team status <team-name>');
    const snapshot = await monitorTeam(name, cwd);
    if (!snapshot) {
      console.log(`No team state found for ${name}`);
      return;
    }
    console.log(`team=${snapshot.teamName} phase=${snapshot.phase}`);
    console.log(`workers: total=${snapshot.workers.length} dead=${snapshot.deadWorkers.length} non_reporting=${snapshot.nonReportingWorkers.length}`);
    console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} blocked=${snapshot.tasks.blocked} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
    if (snapshot.performance) {
      console.log(
        `monitor_perf_ms: total=${snapshot.performance.total_ms} list=${snapshot.performance.list_tasks_ms} workers=${snapshot.performance.worker_scan_ms} mailbox=${snapshot.performance.mailbox_delivery_ms}`
      );
    }
    return;
  }

  if (subcommand === 'await') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team await <team-name> [--timeout-ms <ms>] [--after-event-id <id>] [--json]');
    const wantsJson = teamArgs.includes('--json');
    const timeoutIdx = teamArgs.indexOf('--timeout-ms');
    const afterIdx = teamArgs.indexOf('--after-event-id');
    const timeoutMs = timeoutIdx >= 0 && teamArgs[timeoutIdx + 1]
      ? Math.max(1, Number.parseInt(teamArgs[timeoutIdx + 1]!, 10) || 0)
      : 30_000;
    const afterEventId = afterIdx >= 0 ? (teamArgs[afterIdx + 1] || '') : '';
    const config = await readTeamConfig(name, cwd);
    if (!config) {
      if (wantsJson) {
        console.log(JSON.stringify({ team_name: name, status: 'missing', cursor: afterEventId || '', event: null }));
      } else {
        console.log(`No team state found for ${name}`);
      }
      return;
    }

    const baselineCursor = afterEventId || (await readTeamEvents(name, cwd, { wakeableOnly: true }).then((events) => events.at(-1)?.event_id ?? ''));
    const snapshot = await monitorTeam(name, cwd);
    const immediateEvent = await readTeamEvents(name, cwd, {
      afterEventId: baselineCursor || undefined,
      wakeableOnly: true,
    }).then((events) => events[0]);

    const result =
      immediateEvent
        ? { status: 'event' as const, cursor: immediateEvent.event_id, event: immediateEvent }
        : snapshot && snapshotHasDeadWorkerStall(snapshot)
          ? await readTeamEvents(name, cwd, { wakeableOnly: true }).then((events) => {
            const latestWakeableEvent = events.at(-1);
            if (latestWakeableEvent) {
              return {
                status: 'event' as const,
                cursor: latestWakeableEvent.event_id,
                event: latestWakeableEvent,
              };
            }
            const fallbackEvent = buildDeadWorkerAwaitEvent(name, snapshot);
            return fallbackEvent
              ? { status: 'event' as const, cursor: baselineCursor, event: fallbackEvent }
              : { status: 'timeout' as const, cursor: baselineCursor };
          })
          : await waitForTeamEvent(name, cwd, {
            afterEventId: baselineCursor || undefined,
            timeoutMs,
            pollMs: 100,
            wakeableOnly: true,
          });

    if (wantsJson) {
      console.log(JSON.stringify({
        team_name: sanitizeTeamName(name),
        status: result.status,
        cursor: result.cursor,
        event: result.event ?? null,
      }));
      return;
    }

    if (result.status === 'timeout') {
      console.log(`No new event for ${name} before timeout (${timeoutMs}ms).`);
      return;
    }

    const event = result.event!;
    const context = [
      `team=${name}`,
      `event=${event.type}`,
      `worker=${event.worker}`,
      event.state ? `state=${event.state}` : '',
      event.prev_state ? `prev=${event.prev_state}` : '',
      event.task_id ? `task=${event.task_id}` : '',
      `cursor=${result.cursor}`,
    ].filter(Boolean).join(' ');
    console.log(context);
    return;
  }

  if (subcommand === 'resume') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team resume <team-name>');
    const runtime = await resumeTeam(name, cwd);
    if (!runtime) {
      console.log(`No resumable team found for ${name}`);
      return;
    }
    const existingState = await readModeState('team').catch(() => null);
    const preservedRalph = existingState?.active === true
      && existingState?.team_name === runtime.teamName
      && existingState?.linked_ralph === true;
    await ensureTeamModeState({
      task: runtime.config.task,
      workerCount: runtime.config.worker_count,
      agentType: runtime.config.agent_type,
      explicitAgentType: false,
      teamName: runtime.teamName,
      ralph: preservedRalph,
    });
    const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
    const staffingPlan = buildFollowupStaffingPlan('team', runtime.config.task, availableAgentTypes, {
      workerCount: runtime.config.worker_count,
      fallbackRole: runtime.config.agent_type,
    });
    await renderStartSummary(runtime, staffingPlan);
    return;
  }

  if (subcommand === 'shutdown') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team shutdown <team-name> [--force] [--ralph]');
    const force = teamArgs.includes('--force');
    const ralphFlag = teamArgs.includes('--ralph');
    const ralphFromState = !ralphFlag
      ? await readModeState('team').then(
          (s) => s?.active === true && s?.linked_ralph === true && s?.team_name === name,
          () => false,
        )
      : false;
    await shutdownTeam(name, cwd, { force, ralph: ralphFlag || ralphFromState });
    await updateModeState('team', {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }).catch((error: unknown) => {
      console.warn('[omx] warning: failed to persist team mode shutdown state', {
        team: name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    console.log(`Team shutdown complete: ${name}`);
    return;
  }

  const parsed = parseTeamArgs(teamArgs);
  const tasks = decomposeTaskString(parsed.task, parsed.workerCount, parsed.agentType, parsed.explicitAgentType);
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('team', parsed.task, availableAgentTypes, {
    workerCount: parsed.workerCount,
    fallbackRole: parsed.agentType,
  });
  const runtime = await startTeam(
    parsed.teamName,
    parsed.task,
    parsed.agentType,
    parsed.workerCount,
    tasks,
    cwd,
    { worktreeMode: parsedWorktree.mode, ralph: parsed.ralph },
  );

  await ensureTeamModeState(parsed, tasks);
  if (options.verbose) {
    console.log(`linked_ralph=${parsed.ralph}`);
  }
  await renderStartSummary(runtime, staffingPlan);
}
