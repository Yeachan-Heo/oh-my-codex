import { join } from 'node:path';
import { updateModeState, startMode, readModeState } from '../modes/base.js';
import { monitorTeam, resumeTeam, shutdownTeam, startTeam, type TeamRuntime, type TeamSnapshot } from '../team/runtime.js';
import { DEFAULT_MAX_WORKERS } from '../team/state.js';
import { sanitizeTeamName } from '../team/tmux-session.js';
import { readTeamEvents, waitForTeamEvent } from '../team/state/events.js';
import type { TeamEvent, TeamTask, WorkerInfo, WorkerStatus } from '../team/state.js';
import { parseWorktreeMode, type WorktreeMode } from '../team/worktree.js';
import { classifyTaskSize } from '../hooks/task-size-detector.js';
import { routeTaskToRole } from '../team/role-router.js';
import { allocateTasksToWorkers } from '../team/allocation-policy.js';
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
import { teamReadConfig as readTeamConfig, teamReadTaskApproval as readTaskApproval } from '../team/team-ops.js';

type TeamWorkerCli = Exclude<WorkerInfo['worker_cli'], undefined>;

interface TeamCliOptions {
  verbose?: boolean;
}

interface ParsedTeamArgs {
  workerCount: number;
  agentType: string;
  explicitAgentType: boolean;
  explicitWorkerCount: boolean;
  task: string;
  teamName: string;
  ralph: boolean;
}

const MIN_WORKER_COUNT = 1;
const DEFAULT_SPARKSHELL_TAIL_LINES = 400;
const MIN_SPARKSHELL_TAIL_LINES = 100;
const MAX_SPARKSHELL_TAIL_LINES = 1000;
const TEAM_HELP = `
Usage: omx team [ralph] [N:agent-type] "<task description>"
       omx team status <team-name> [--json] [--tail-lines <100-1000>]
       omx team await <team-name> [--timeout-ms <ms>] [--after-event-id <id>] [--json]
       omx team resume <team-name>
       omx team shutdown <team-name> [--force] [--ralph]
       omx team api <operation> [--input <json>] [--json]
       omx team api --help

Examples:
  omx team 3:executor "fix failing tests"
  omx team status my-team
  omx team status my-team --json
  omx team status my-team --tail-lines 600
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
  'read-events': ['team_name'],
  'await-event': ['team_name'],
  'read-idle-state': ['team_name'],
  'read-stall-state': ['team_name'],
  'get-summary': ['team_name'],
  'cleanup': ['team_name'],
  'orphan-cleanup': ['team_name'],
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
  'cleanup': ['force', 'ralph'],
  'transition-task-status': ['result', 'error'],
  'read-shutdown-ack': ['min_updated_at'],
  'write-worker-identity': [
    'assigned_tasks', 'pid', 'pane_id', 'working_dir',
    'worktree_path', 'worktree_branch', 'worktree_detached', 'team_state_root',
  ],
  'append-event': ['task_id', 'message_id', 'reason'],
  'read-events': ['after_event_id', 'wakeable_only', 'type', 'worker', 'task_id'],
  'await-event': ['after_event_id', 'timeout_ms', 'poll_ms', 'wakeable_only', 'type', 'worker', 'task_id'],
  'write-task-approval': ['required'],
};

const TEAM_API_OPERATION_NOTES: Partial<Record<TeamApiOperation, string>> = {
  'update-task': 'Only non-lifecycle task metadata can be updated.',
  'release-task-claim': 'Use this only for rollback/requeue to pending (not for completion).',
  'transition-task-status': 'Lifecycle flow is claim-safe and typically transitions in_progress -> completed|failed.',
  'cleanup': 'Uses the runtime shutdown contract; use orphan-cleanup only for known orphan recovery.',
  'orphan-cleanup': 'Destructive escape hatch for known orphan recovery. Bypasses shutdown orchestration.',
  'read-events': 'Events are returned in canonical form; worker_idle log entries normalize to type worker_state_changed with source_type worker_idle. wakeable_only defaults to false; set wakeable_only=true to mirror omx team await semantics.',
  'await-event': 'Waits for the next matching event and returns status=timeout when no matching event arrives before timeout_ms. wakeable_only defaults to false; set wakeable_only=true to mirror omx team await semantics.',
  'read-idle-state': 'Builds a structured idle summary from the existing monitor snapshot, team summary, and recent events.',
  'read-stall-state': 'Builds a structured stall summary from the existing monitor snapshot, team summary, and recent events.',
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
    case 'result': return 'Verification:\nPASS - example';
    case 'error': return 'Verification failed';
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
    case 'after_event_id': return 'evt-123';
    case 'wakeable_only': return true;
    case 'timeout_ms': return 500;
    case 'poll_ms': return 100;
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

function buildJsonBase(): { schema_version: string; timestamp: string } {
  return {
    schema_version: '1.0',
    timestamp: new Date().toISOString(),
  };
}

function parseStatusTailLines(args: string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--tail-lines') {
      const next = args[index + 1];
      const parsed = Number.parseInt(next || '', 10);
      if (!Number.isFinite(parsed) || parsed < MIN_SPARKSHELL_TAIL_LINES || parsed > MAX_SPARKSHELL_TAIL_LINES) {
        throw new Error(`Usage: omx team status <team-name> [--json] [--tail-lines <${MIN_SPARKSHELL_TAIL_LINES}-${MAX_SPARKSHELL_TAIL_LINES}>]`);
      }
      return parsed;
    }
    if (token.startsWith('--tail-lines=')) {
      const parsed = Number.parseInt(token.slice('--tail-lines='.length), 10);
      if (!Number.isFinite(parsed) || parsed < MIN_SPARKSHELL_TAIL_LINES || parsed > MAX_SPARKSHELL_TAIL_LINES) {
        throw new Error(`Usage: omx team status <team-name> [--json] [--tail-lines <${MIN_SPARKSHELL_TAIL_LINES}-${MAX_SPARKSHELL_TAIL_LINES}>]`);
      }
      return parsed;
    }
  }
  return DEFAULT_SPARKSHELL_TAIL_LINES;
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

async function readTeamPaneStatus(
  config: Awaited<ReturnType<typeof readTeamConfig>>,
  cwd: string = process.cwd(),
  snapshot?: Pick<TeamSnapshot, 'teamName' | 'deadWorkers' | 'nonReportingWorkers' | 'workers' | 'tasks'>,
  tailLines: number = DEFAULT_SPARKSHELL_TAIL_LINES,
): Promise<{
  leader_pane_id: string | null;
  hud_pane_id: string | null;
  worker_panes: Record<string, string>;
  sparkshell_hint: string | null;
  sparkshell_commands: Record<string, string>;
  recommended_inspect_targets: string[];
  recommended_inspect_reasons: Record<string, string>;
  recommended_inspect_clis: Record<string, TeamWorkerCli | null>;
  recommended_inspect_roles: Record<string, string | null>;
  recommended_inspect_indexes: Record<string, number | null>;
  recommended_inspect_alive: Record<string, boolean | null>;
  recommended_inspect_turn_counts: Record<string, number | null>;
  recommended_inspect_turns_without_progress: Record<string, number | null>;
  recommended_inspect_last_turn_at: Record<string, string | null>;
  recommended_inspect_status_updated_at: Record<string, string | null>;
  recommended_inspect_pids: Record<string, number | null>;
  recommended_inspect_worktree_paths: Record<string, string | null>;
  recommended_inspect_worktree_repo_roots: Record<string, string | null>;
  recommended_inspect_worktree_branches: Record<string, string | null>;
  recommended_inspect_worktree_detached: Record<string, boolean | null>;
  recommended_inspect_worktree_created: Record<string, boolean | null>;
  recommended_inspect_team_state_roots: Record<string, string | null>;
  recommended_inspect_workdirs: Record<string, string | null>;
  recommended_inspect_assigned_tasks: Record<string, string[]>;
  recommended_inspect_task_statuses: Record<string, TeamTask['status'] | null>;
  recommended_inspect_task_results: Record<string, string | null>;
  recommended_inspect_task_errors: Record<string, string | null>;
  recommended_inspect_task_versions: Record<string, number | null>;
  recommended_inspect_task_created_at: Record<string, string | null>;
  recommended_inspect_task_completed_at: Record<string, string | null>;
  recommended_inspect_task_depends_on: Record<string, string[]>;
  recommended_inspect_task_claim_present: Record<string, boolean | null>;
  recommended_inspect_task_claim_owners: Record<string, string | null>;
  recommended_inspect_task_claim_tokens: Record<string, string | null>;
  recommended_inspect_task_claim_leases: Record<string, string | null>;
  recommended_inspect_task_claim_lock_paths: Record<string, string | null>;
  recommended_inspect_approval_required: Record<string, boolean | null>;
  recommended_inspect_requires_code_change: Record<string, boolean | null>;
  recommended_inspect_descriptions: Record<string, string | null>;
  recommended_inspect_blocked_by: Record<string, string[]>;
  recommended_inspect_task_roles: Record<string, string | null>;
  recommended_inspect_task_owners: Record<string, string | null>;
  recommended_inspect_approval_statuses: Record<string, string | null>;
  recommended_inspect_approval_reviewers: Record<string, string | null>;
  recommended_inspect_approval_reasons: Record<string, string | null>;
  recommended_inspect_approval_decided_at: Record<string, string | null>;
  recommended_inspect_approval_record_present: Record<string, boolean | null>;
  recommended_inspect_states: Record<string, WorkerStatus['state'] | null>;
  recommended_inspect_state_reasons: Record<string, string | null>;
  recommended_inspect_tasks: Record<string, string | null>;
  recommended_inspect_subjects: Record<string, string | null>;
  recommended_inspect_task_paths: Record<string, string | null>;
  recommended_inspect_approval_paths: Record<string, string | null>;
  recommended_inspect_worker_state_dirs: Record<string, string | null>;
  recommended_inspect_worker_status_paths: Record<string, string | null>;
  recommended_inspect_worker_heartbeat_paths: Record<string, string | null>;
  recommended_inspect_worker_identity_paths: Record<string, string | null>;
  recommended_inspect_worker_inbox_paths: Record<string, string | null>;
  recommended_inspect_worker_mailbox_paths: Record<string, string | null>;
  recommended_inspect_worker_shutdown_request_paths: Record<string, string | null>;
  recommended_inspect_worker_shutdown_ack_paths: Record<string, string | null>;
  recommended_inspect_team_config_paths: Record<string, string | null>;
  recommended_inspect_team_manifest_paths: Record<string, string | null>;
  recommended_inspect_team_events_paths: Record<string, string | null>;
  recommended_inspect_team_dispatch_paths: Record<string, string | null>;
  recommended_inspect_team_dir_paths: Record<string, string | null>;
  recommended_inspect_team_phase_paths: Record<string, string | null>;
  recommended_inspect_team_monitor_snapshot_paths: Record<string, string | null>;
  recommended_inspect_team_summary_snapshot_paths: Record<string, string | null>;
  recommended_inspect_panes: Record<string, string | null>;
  recommended_inspect_command: string | null;
  recommended_inspect_commands: string[];
  recommended_inspect_summary: string | null;
  recommended_inspect_items: Array<{
    target: string;
    pane_id: string;
    worker_cli: TeamWorkerCli | null;
    role: string | null;
    index: number | null;
    alive: boolean | null;
    turn_count: number | null;
    turns_without_progress: number | null;
    last_turn_at: string | null;
    status_updated_at: string | null;
    pid: number | null;
    worktree_repo_root: string | null;
    worktree_path: string | null;
    worktree_branch: string | null;
    worktree_detached: boolean | null;
    worktree_created: boolean | null;
    team_state_root: string | null;
    working_dir: string | null;
    assigned_tasks: string[];
    task_status: TeamTask['status'] | null;
    task_result: string | null;
    task_error: string | null;
    task_version: number | null;
    task_created_at: string | null;
    task_completed_at: string | null;
    task_depends_on: string[];
    task_claim_present: boolean | null;
    task_claim_owner: string | null;
    task_claim_token: string | null;
    task_claim_leased_until: string | null;
    task_claim_lock_path: string | null;
    approval_required: boolean | null;
    requires_code_change: boolean | null;
    task_description: string | null;
    blocked_by: string[];
    task_role: string | null;
    task_owner: string | null;
    approval_status: string | null;
    approval_reviewer: string | null;
    approval_reason: string | null;
    approval_decided_at: string | null;
    approval_record_present: boolean | null;
    reason: string;
    state: WorkerStatus['state'] | null;
    state_reason: string | null;
    task_id: string | null;
    task_subject: string | null;
    task_path: string | null;
    approval_path: string | null;
    worker_state_dir: string | null;
    worker_status_path: string | null;
    worker_heartbeat_path: string | null;
    worker_identity_path: string | null;
    worker_inbox_path: string | null;
    worker_mailbox_path: string | null;
    worker_shutdown_request_path: string | null;
    worker_shutdown_ack_path: string | null;
    team_dir_path: string | null;
    team_config_path: string | null;
    team_manifest_path: string | null;
    team_events_path: string | null;
    team_dispatch_path: string | null;
    team_phase_path: string | null;
    team_monitor_snapshot_path: string | null;
    team_summary_snapshot_path: string | null;
    command: string;
  }>;
}> {
  if (!config) {
    return {
      leader_pane_id: null,
      hud_pane_id: null,
      worker_panes: {},
      sparkshell_hint: null,
      sparkshell_commands: {},
      recommended_inspect_targets: [],
      recommended_inspect_reasons: {},
      recommended_inspect_clis: {},
      recommended_inspect_roles: {},
      recommended_inspect_indexes: {},
      recommended_inspect_alive: {},
      recommended_inspect_turn_counts: {},
      recommended_inspect_turns_without_progress: {},
      recommended_inspect_last_turn_at: {},
      recommended_inspect_status_updated_at: {},
      recommended_inspect_pids: {},
      recommended_inspect_worktree_paths: {},
      recommended_inspect_worktree_repo_roots: {},
      recommended_inspect_worktree_branches: {},
      recommended_inspect_worktree_detached: {},
      recommended_inspect_worktree_created: {},
      recommended_inspect_team_state_roots: {},
      recommended_inspect_workdirs: {},
      recommended_inspect_assigned_tasks: {},
      recommended_inspect_task_statuses: {},
      recommended_inspect_task_results: {},
      recommended_inspect_task_errors: {},
      recommended_inspect_task_versions: {},
      recommended_inspect_task_created_at: {},
      recommended_inspect_task_completed_at: {},
      recommended_inspect_task_depends_on: {},
      recommended_inspect_task_claim_present: {},
      recommended_inspect_task_claim_owners: {},
      recommended_inspect_task_claim_tokens: {},
      recommended_inspect_task_claim_leases: {},
      recommended_inspect_task_claim_lock_paths: {},
      recommended_inspect_approval_required: {},
      recommended_inspect_requires_code_change: {},
      recommended_inspect_descriptions: {},
      recommended_inspect_blocked_by: {},
      recommended_inspect_task_roles: {},
      recommended_inspect_task_owners: {},
      recommended_inspect_approval_statuses: {},
      recommended_inspect_approval_reviewers: {},
      recommended_inspect_approval_reasons: {},
      recommended_inspect_approval_decided_at: {},
      recommended_inspect_approval_record_present: {},
      recommended_inspect_states: {},
      recommended_inspect_state_reasons: {},
      recommended_inspect_tasks: {},
      recommended_inspect_subjects: {},
      recommended_inspect_task_paths: {},
      recommended_inspect_approval_paths: {},
      recommended_inspect_worker_state_dirs: {},
      recommended_inspect_worker_status_paths: {},
      recommended_inspect_worker_heartbeat_paths: {},
      recommended_inspect_worker_identity_paths: {},
      recommended_inspect_worker_inbox_paths: {},
      recommended_inspect_worker_mailbox_paths: {},
      recommended_inspect_worker_shutdown_request_paths: {},
      recommended_inspect_worker_shutdown_ack_paths: {},
      recommended_inspect_team_dir_paths: {},
      recommended_inspect_team_config_paths: {},
      recommended_inspect_team_manifest_paths: {},
      recommended_inspect_team_events_paths: {},
      recommended_inspect_team_dispatch_paths: {},
      recommended_inspect_team_phase_paths: {},
      recommended_inspect_team_monitor_snapshot_paths: {},
      recommended_inspect_team_summary_snapshot_paths: {},
      recommended_inspect_panes: {},
      recommended_inspect_command: null,
      recommended_inspect_commands: [],
      recommended_inspect_summary: null,
      recommended_inspect_items: [],
    };
  }

  const leaderPaneId = config.leader_pane_id?.trim() || null;
  const hudPaneId = config.hud_pane_id?.trim() || null;

  const workerPanes = Object.fromEntries(
    config.workers
      .map((worker) => {
        const paneId = worker.pane_id?.trim();
        return paneId ? [worker.name, paneId] : null;
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );

  const sparkshellCommands = Object.fromEntries(
    [
      leaderPaneId ? ['leader', `omx sparkshell --tmux-pane ${leaderPaneId} --tail-lines ${tailLines}`] : null,
      hudPaneId ? ['hud', `omx sparkshell --tmux-pane ${hudPaneId} --tail-lines ${tailLines}`] : null,
      ...Object.entries(workerPanes).map(([workerName, paneId]) => [
        workerName,
        `omx sparkshell --tmux-pane ${paneId} --tail-lines ${tailLines}`,
      ] as const),
    ].filter((entry): entry is [string, string] => entry !== null),
  );

  const recommendedInspectTargets = [
    ...(snapshot?.deadWorkers ?? []),
    ...(snapshot?.nonReportingWorkers ?? []),
  ].filter((workerName, index, values) => (
    Object.hasOwn(workerPanes, workerName) && values.indexOf(workerName) === index
  ));
  const recommendedInspectReasons = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      (snapshot?.deadWorkers ?? []).includes(target) ? 'dead_worker' : 'non_reporting_worker',
    ]),
  );
  const recommendedInspectClis = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.worker_cli ?? null];
    }),
  );
  const recommendedInspectRoles = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.role ?? null];
    }),
  );
  const recommendedInspectIndexes = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.index ?? null];
    }),
  );
  const recommendedInspectAlive = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.alive ?? null];
    }),
  );
  const recommendedInspectTurnCounts = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.heartbeat?.turn_count ?? null];
    }),
  );
  const recommendedInspectTurnsWithoutProgress = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.turnsWithoutProgress ?? null];
    }),
  );
  const recommendedInspectLastTurnAt = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.heartbeat?.last_turn_at ?? null];
    }),
  );
  const recommendedInspectStatusUpdatedAt = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.status.updated_at ?? null];
    }),
  );
  const recommendedInspectPids = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.pid ?? null];
    }),
  );
  const recommendedInspectWorktreePaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.worktree_path ?? null];
    }),
  );
  const recommendedInspectWorktreeRepoRoots = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.worktree_repo_root ?? null];
    }),
  );
  const recommendedInspectWorktreeBranches = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.worktree_branch ?? null];
    }),
  );
  const recommendedInspectWorktreeDetached = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.worktree_detached ?? null];
    }),
  );
  const recommendedInspectWorktreeCreated = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.worktree_created ?? null];
    }),
  );
  const recommendedInspectTeamStateRoots = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.team_state_root ?? null];
    }),
  );
  const recommendedInspectWorkdirs = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.working_dir ?? worker?.worktree_path ?? null];
    }),
  );
  const recommendedInspectAssignedTasks = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = config.workers.find((candidate) => candidate.name === target);
      return [target, worker?.assigned_tasks ?? []];
    }),
  );
  const recommendedInspectTasks = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.status.current_task_id ?? null];
    }),
  );
  const taskStatusById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.status] as const));
  const taskResultById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.result ?? null] as const));
  const taskErrorById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.error ?? null] as const));
  const taskVersionById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.version ?? null] as const));
  const taskCreatedAtById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.created_at ?? null] as const));
  const taskCompletedAtById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.completed_at ?? null] as const));
  const taskDependsOnById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.depends_on ?? task.blocked_by ?? []] as const));
  const taskClaimPresentById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.claim != null] as const));
  const taskClaimOwnerById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.claim?.owner ?? null] as const));
  const taskClaimTokenById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.claim?.token ?? null] as const));
  const taskClaimLeaseById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.claim?.leased_until ?? null] as const));
  const taskRequiresCodeChangeById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.requires_code_change ?? null] as const));
  const recommendedInspectTaskStatuses = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskStatusById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskResults = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskResultById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskErrors = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskErrorById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskVersions = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskVersionById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskCreatedAt = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskCreatedAtById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskCompletedAt = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskCompletedAtById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskDependsOn = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskDependsOnById.get(taskId) ?? []) : []];
    }),
  );
  const recommendedInspectTaskClaimPresent = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskClaimPresentById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskClaimOwners = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskClaimOwnerById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskClaimTokens = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskClaimTokenById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskClaimLeases = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskClaimLeaseById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskClaimLockPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId && snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'claims', `task-${taskId}.lock`) : null];
    }),
  );
  const recommendedInspectRequiresCodeChange = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskRequiresCodeChangeById.get(taskId) ?? null) : null];
    }),
  );
  const taskDescriptionById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.description] as const));
  const recommendedInspectDescriptions = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskDescriptionById.get(taskId) ?? null) : null];
    }),
  );
  const taskBlockedById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.blocked_by ?? []] as const));
  const recommendedInspectBlockedBy = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskBlockedById.get(taskId) ?? []) : []];
    }),
  );
  const taskRoleById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.role ?? null] as const));
  const recommendedInspectTaskRoles = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskRoleById.get(taskId) ?? null) : null];
    }),
  );
  const taskOwnerById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.owner ?? null] as const));
  const recommendedInspectTaskOwners = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskOwnerById.get(taskId) ?? null) : null];
    }),
  );
  const approvalRecordByTaskId = new Map<string, Awaited<ReturnType<typeof readTaskApproval>>>();
  for (const taskId of new Set(Object.values(recommendedInspectTasks).filter((value): value is string => typeof value === 'string' && value.length > 0))) {
    approvalRecordByTaskId.set(taskId, snapshot?.teamName ? await readTaskApproval(snapshot.teamName, taskId, cwd) : null);
  }
  const recommendedInspectApprovalStatuses = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (approvalRecordByTaskId.get(taskId)?.status ?? null) : null];
    }),
  );
  const recommendedInspectApprovalRequired = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (approvalRecordByTaskId.get(taskId)?.required ?? null) : null];
    }),
  );
  const recommendedInspectApprovalReviewers = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (approvalRecordByTaskId.get(taskId)?.reviewer ?? null) : null];
    }),
  );
  const recommendedInspectApprovalReasons = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (approvalRecordByTaskId.get(taskId)?.decision_reason ?? null) : null];
    }),
  );
  const recommendedInspectApprovalDecidedAt = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (approvalRecordByTaskId.get(taskId)?.decided_at ?? null) : null];
    }),
  );
  const recommendedInspectApprovalRecordPresent = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? approvalRecordByTaskId.get(taskId) !== null : null];
    }),
  );
  const recommendedInspectPanes = Object.fromEntries(
    recommendedInspectTargets.map((target) => [target, workerPanes[target] ?? null]),
  );
  const taskSubjectById = new Map((snapshot?.tasks.items ?? []).map((task) => [task.id, task.subject] as const));
  const recommendedInspectSubjects = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId ? (taskSubjectById.get(taskId) ?? null) : null];
    }),
  );
  const recommendedInspectTaskPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId && snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'tasks', `task-${taskId}.json`) : null];
    }),
  );
  const recommendedInspectApprovalPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const taskId = recommendedInspectTasks[target];
      return [target, taskId && snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'approvals', `task-${taskId}.json`) : null];
    }),
  );
  const recommendedInspectWorkerStateDirs = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target) : null,
    ]),
  );
  const recommendedInspectWorkerStatusPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target, 'status.json') : null,
    ]),
  );
  const recommendedInspectWorkerHeartbeatPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target, 'heartbeat.json') : null,
    ]),
  );
  const recommendedInspectWorkerIdentityPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target, 'identity.json') : null,
    ]),
  );
  const recommendedInspectWorkerInboxPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target, 'inbox.md') : null,
    ]),
  );
  const recommendedInspectWorkerMailboxPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'mailbox', `${target}.json`) : null,
    ]),
  );
  const recommendedInspectWorkerShutdownRequestPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target, 'shutdown-request.json') : null,
    ]),
  );
  const recommendedInspectWorkerShutdownAckPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'workers', target, 'shutdown-ack.json') : null,
    ]),
  );
  const recommendedInspectTeamConfigPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'config.json') : null,
    ]),
  );
  const recommendedInspectTeamManifestPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'manifest.v2.json') : null,
    ]),
  );
  const recommendedInspectTeamEventsPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'events', 'events.ndjson') : null,
    ]),
  );
  const recommendedInspectTeamDispatchPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'dispatch', 'requests.json') : null,
    ]),
  );
  const recommendedInspectTeamDirPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName) : null,
    ]),
  );
  const recommendedInspectTeamPhasePaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'phase.json') : null,
    ]),
  );
  const recommendedInspectTeamMonitorSnapshotPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'monitor-snapshot.json') : null,
    ]),
  );
  const recommendedInspectTeamSummarySnapshotPaths = Object.fromEntries(
    recommendedInspectTargets.map((target) => [
      target,
      snapshot?.teamName ? join(cwd, '.omx', 'state', 'team', snapshot.teamName, 'summary-snapshot.json') : null,
    ]),
  );
  const recommendedInspectStates = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.status.state ?? null];
    }),
  );
  const recommendedInspectStateReasons = Object.fromEntries(
    recommendedInspectTargets.map((target) => {
      const worker = snapshot?.workers.find((candidate) => candidate.name === target);
      return [target, worker?.status.reason ?? null];
    }),
  );
  const recommendedInspectCommand = recommendedInspectTargets.length > 0
    ? sparkshellCommands[recommendedInspectTargets[0]!] ?? null
    : null;
  const recommendedInspectCommands = recommendedInspectTargets
    .map((target) => sparkshellCommands[target])
    .filter((command): command is string => typeof command === 'string' && command.length > 0);
  const recommendedInspectSummary = recommendedInspectTargets.length > 0
    ? [
      `target=${recommendedInspectTargets[0]}`,
      recommendedInspectPanes[recommendedInspectTargets[0]!] ? `pane=${recommendedInspectPanes[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectClis[recommendedInspectTargets[0]!] ? `cli=${recommendedInspectClis[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectRoles[recommendedInspectTargets[0]!] ? `role=${recommendedInspectRoles[recommendedInspectTargets[0]!]}` : '',
      typeof recommendedInspectAlive[recommendedInspectTargets[0]!] === 'boolean' ? `alive=${recommendedInspectAlive[recommendedInspectTargets[0]!]}` : '',
      typeof recommendedInspectTurnCounts[recommendedInspectTargets[0]!] === 'number' ? `turn_count=${recommendedInspectTurnCounts[recommendedInspectTargets[0]!]}` : '',
      typeof recommendedInspectTurnsWithoutProgress[recommendedInspectTargets[0]!] === 'number'
        ? `turns_without_progress=${recommendedInspectTurnsWithoutProgress[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectReasons[recommendedInspectTargets[0]!] ? `reason=${recommendedInspectReasons[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectStates[recommendedInspectTargets[0]!] ? `state=${recommendedInspectStates[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectTasks[recommendedInspectTargets[0]!] ? `task=${recommendedInspectTasks[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectSubjects[recommendedInspectTargets[0]!] ? `subject=${recommendedInspectSubjects[recommendedInspectTargets[0]!]}` : '',
      recommendedInspectCommand ? `command=${recommendedInspectCommand}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
    : null;
  const recommendedInspectItems = recommendedInspectTargets
    .map((target) => {
      const command = sparkshellCommands[target];
      const paneId = recommendedInspectPanes[target];
      if (!command || !paneId) return null;
      return {
        target,
        pane_id: paneId,
        worker_cli: recommendedInspectClis[target] ?? null,
        role: recommendedInspectRoles[target] ?? null,
        index: recommendedInspectIndexes[target] ?? null,
        alive: recommendedInspectAlive[target] ?? null,
        turn_count: recommendedInspectTurnCounts[target] ?? null,
        turns_without_progress: recommendedInspectTurnsWithoutProgress[target] ?? null,
        last_turn_at: recommendedInspectLastTurnAt[target] ?? null,
        status_updated_at: recommendedInspectStatusUpdatedAt[target] ?? null,
        pid: recommendedInspectPids[target] ?? null,
        worktree_repo_root: recommendedInspectWorktreeRepoRoots[target] ?? null,
        worktree_path: recommendedInspectWorktreePaths[target] ?? null,
        worktree_branch: recommendedInspectWorktreeBranches[target] ?? null,
        worktree_detached: recommendedInspectWorktreeDetached[target] ?? null,
        worktree_created: recommendedInspectWorktreeCreated[target] ?? null,
        team_state_root: recommendedInspectTeamStateRoots[target] ?? null,
        working_dir: recommendedInspectWorkdirs[target] ?? null,
        assigned_tasks: recommendedInspectAssignedTasks[target] ?? [],
        task_status: recommendedInspectTaskStatuses[target] ?? null,
        task_result: recommendedInspectTaskResults[target] ?? null,
        task_error: recommendedInspectTaskErrors[target] ?? null,
        task_version: recommendedInspectTaskVersions[target] ?? null,
        task_created_at: recommendedInspectTaskCreatedAt[target] ?? null,
        task_completed_at: recommendedInspectTaskCompletedAt[target] ?? null,
        task_depends_on: recommendedInspectTaskDependsOn[target] ?? [],
        task_claim_present: recommendedInspectTaskClaimPresent[target] ?? null,
        task_claim_owner: recommendedInspectTaskClaimOwners[target] ?? null,
        task_claim_token: recommendedInspectTaskClaimTokens[target] ?? null,
        task_claim_leased_until: recommendedInspectTaskClaimLeases[target] ?? null,
        task_claim_lock_path: recommendedInspectTaskClaimLockPaths[target] ?? null,
        approval_required: recommendedInspectApprovalRequired[target] ?? null,
        requires_code_change: recommendedInspectRequiresCodeChange[target] ?? null,
        task_description: recommendedInspectDescriptions[target] ?? null,
        blocked_by: recommendedInspectBlockedBy[target] ?? [],
        task_role: recommendedInspectTaskRoles[target] ?? null,
        task_owner: recommendedInspectTaskOwners[target] ?? null,
        approval_status: recommendedInspectApprovalStatuses[target] ?? null,
        approval_reviewer: recommendedInspectApprovalReviewers[target] ?? null,
        approval_reason: recommendedInspectApprovalReasons[target] ?? null,
        approval_decided_at: recommendedInspectApprovalDecidedAt[target] ?? null,
        approval_record_present: recommendedInspectApprovalRecordPresent[target] ?? null,
        reason: recommendedInspectReasons[target] ?? 'unknown',
        state: recommendedInspectStates[target] ?? null,
        state_reason: recommendedInspectStateReasons[target] ?? null,
        task_id: recommendedInspectTasks[target] ?? null,
        task_subject: recommendedInspectSubjects[target] ?? null,
        task_path: recommendedInspectTaskPaths[target] ?? null,
        approval_path: recommendedInspectApprovalPaths[target] ?? null,
        worker_state_dir: recommendedInspectWorkerStateDirs[target] ?? null,
        worker_status_path: recommendedInspectWorkerStatusPaths[target] ?? null,
        worker_heartbeat_path: recommendedInspectWorkerHeartbeatPaths[target] ?? null,
        worker_identity_path: recommendedInspectWorkerIdentityPaths[target] ?? null,
        worker_inbox_path: recommendedInspectWorkerInboxPaths[target] ?? null,
        worker_mailbox_path: recommendedInspectWorkerMailboxPaths[target] ?? null,
        worker_shutdown_request_path: recommendedInspectWorkerShutdownRequestPaths[target] ?? null,
        worker_shutdown_ack_path: recommendedInspectWorkerShutdownAckPaths[target] ?? null,
        team_dir_path: recommendedInspectTeamDirPaths[target] ?? null,
        team_config_path: recommendedInspectTeamConfigPaths[target] ?? null,
        team_manifest_path: recommendedInspectTeamManifestPaths[target] ?? null,
        team_events_path: recommendedInspectTeamEventsPaths[target] ?? null,
        team_dispatch_path: recommendedInspectTeamDispatchPaths[target] ?? null,
        team_phase_path: recommendedInspectTeamPhasePaths[target] ?? null,
        team_monitor_snapshot_path: recommendedInspectTeamMonitorSnapshotPaths[target] ?? null,
        team_summary_snapshot_path: recommendedInspectTeamSummarySnapshotPaths[target] ?? null,
        command,
      };
    })
    .filter((item): item is Exclude<typeof item, null> => item !== null);

  return {
    leader_pane_id: leaderPaneId,
    hud_pane_id: hudPaneId,
    worker_panes: workerPanes,
    sparkshell_hint: Object.keys(workerPanes).length > 0
      ? 'omx sparkshell --tmux-pane <pane-id> --tail-lines 400'
      : null,
    sparkshell_commands: sparkshellCommands,
    recommended_inspect_targets: recommendedInspectTargets,
    recommended_inspect_reasons: recommendedInspectReasons,
    recommended_inspect_clis: recommendedInspectClis,
    recommended_inspect_roles: recommendedInspectRoles,
    recommended_inspect_indexes: recommendedInspectIndexes,
    recommended_inspect_alive: recommendedInspectAlive,
    recommended_inspect_turn_counts: recommendedInspectTurnCounts,
    recommended_inspect_turns_without_progress: recommendedInspectTurnsWithoutProgress,
    recommended_inspect_last_turn_at: recommendedInspectLastTurnAt,
    recommended_inspect_status_updated_at: recommendedInspectStatusUpdatedAt,
    recommended_inspect_pids: recommendedInspectPids,
    recommended_inspect_worktree_paths: recommendedInspectWorktreePaths,
    recommended_inspect_worktree_repo_roots: recommendedInspectWorktreeRepoRoots,
    recommended_inspect_worktree_branches: recommendedInspectWorktreeBranches,
    recommended_inspect_worktree_detached: recommendedInspectWorktreeDetached,
    recommended_inspect_worktree_created: recommendedInspectWorktreeCreated,
    recommended_inspect_team_state_roots: recommendedInspectTeamStateRoots,
    recommended_inspect_workdirs: recommendedInspectWorkdirs,
    recommended_inspect_assigned_tasks: recommendedInspectAssignedTasks,
    recommended_inspect_task_statuses: recommendedInspectTaskStatuses,
    recommended_inspect_task_results: recommendedInspectTaskResults,
    recommended_inspect_task_errors: recommendedInspectTaskErrors,
    recommended_inspect_task_versions: recommendedInspectTaskVersions,
    recommended_inspect_task_created_at: recommendedInspectTaskCreatedAt,
    recommended_inspect_task_completed_at: recommendedInspectTaskCompletedAt,
    recommended_inspect_task_depends_on: recommendedInspectTaskDependsOn,
    recommended_inspect_task_claim_present: recommendedInspectTaskClaimPresent,
    recommended_inspect_task_claim_owners: recommendedInspectTaskClaimOwners,
    recommended_inspect_task_claim_tokens: recommendedInspectTaskClaimTokens,
    recommended_inspect_task_claim_leases: recommendedInspectTaskClaimLeases,
    recommended_inspect_task_claim_lock_paths: recommendedInspectTaskClaimLockPaths,
    recommended_inspect_approval_required: recommendedInspectApprovalRequired,
    recommended_inspect_requires_code_change: recommendedInspectRequiresCodeChange,
    recommended_inspect_descriptions: recommendedInspectDescriptions,
    recommended_inspect_blocked_by: recommendedInspectBlockedBy,
    recommended_inspect_task_roles: recommendedInspectTaskRoles,
    recommended_inspect_task_owners: recommendedInspectTaskOwners,
    recommended_inspect_approval_statuses: recommendedInspectApprovalStatuses,
    recommended_inspect_approval_reviewers: recommendedInspectApprovalReviewers,
    recommended_inspect_approval_reasons: recommendedInspectApprovalReasons,
    recommended_inspect_approval_decided_at: recommendedInspectApprovalDecidedAt,
    recommended_inspect_approval_record_present: recommendedInspectApprovalRecordPresent,
    recommended_inspect_states: recommendedInspectStates,
    recommended_inspect_state_reasons: recommendedInspectStateReasons,
    recommended_inspect_tasks: recommendedInspectTasks,
    recommended_inspect_subjects: recommendedInspectSubjects,
    recommended_inspect_task_paths: recommendedInspectTaskPaths,
    recommended_inspect_approval_paths: recommendedInspectApprovalPaths,
    recommended_inspect_worker_state_dirs: recommendedInspectWorkerStateDirs,
    recommended_inspect_worker_status_paths: recommendedInspectWorkerStatusPaths,
    recommended_inspect_worker_heartbeat_paths: recommendedInspectWorkerHeartbeatPaths,
    recommended_inspect_worker_identity_paths: recommendedInspectWorkerIdentityPaths,
    recommended_inspect_worker_inbox_paths: recommendedInspectWorkerInboxPaths,
    recommended_inspect_worker_mailbox_paths: recommendedInspectWorkerMailboxPaths,
    recommended_inspect_worker_shutdown_request_paths: recommendedInspectWorkerShutdownRequestPaths,
    recommended_inspect_worker_shutdown_ack_paths: recommendedInspectWorkerShutdownAckPaths,
    recommended_inspect_team_dir_paths: recommendedInspectTeamDirPaths,
    recommended_inspect_team_config_paths: recommendedInspectTeamConfigPaths,
    recommended_inspect_team_manifest_paths: recommendedInspectTeamManifestPaths,
    recommended_inspect_team_events_paths: recommendedInspectTeamEventsPaths,
    recommended_inspect_team_dispatch_paths: recommendedInspectTeamDispatchPaths,
    recommended_inspect_team_phase_paths: recommendedInspectTeamPhasePaths,
    recommended_inspect_team_monitor_snapshot_paths: recommendedInspectTeamMonitorSnapshotPaths,
    recommended_inspect_team_summary_snapshot_paths: recommendedInspectTeamSummarySnapshotPaths,
    recommended_inspect_panes: recommendedInspectPanes,
    recommended_inspect_command: recommendedInspectCommand,
    recommended_inspect_commands: recommendedInspectCommands,
    recommended_inspect_summary: recommendedInspectSummary,
    recommended_inspect_items: recommendedInspectItems,
  };
}

function renderTeamPaneStatus(
  paneStatus: Awaited<ReturnType<typeof readTeamPaneStatus>>,
): void {
  if (paneStatus.leader_pane_id || paneStatus.hud_pane_id) {
    console.log(`panes: leader=${paneStatus.leader_pane_id || '-'} hud=${paneStatus.hud_pane_id || '-'}`);
  }

  const workerPanePairs = Object.entries(paneStatus.worker_panes).map(([workerName, paneId]) => `${workerName}=${paneId}`);
  if (workerPanePairs.length > 0) {
    console.log(`worker_panes: ${workerPanePairs.join(' ')}`);
  }

  if (paneStatus.sparkshell_hint) {
    console.log('sparkshell_hint: omx sparkshell --tmux-pane <pane-id> --tail-lines 400');
  }

  if (paneStatus.recommended_inspect_targets.length > 0) {
    console.log(`recommended_inspect_targets: ${paneStatus.recommended_inspect_targets.join(' ')}`);
  }
  for (const [target, reason] of Object.entries(paneStatus.recommended_inspect_reasons)) {
    console.log(`inspect_reason_${target}: ${reason}`);
  }
  for (const [target, workerCli] of Object.entries(paneStatus.recommended_inspect_clis)) {
    if (workerCli) {
      console.log(`inspect_cli_${target}: ${workerCli}`);
    }
  }
  for (const [target, role] of Object.entries(paneStatus.recommended_inspect_roles)) {
    if (role) {
      console.log(`inspect_role_${target}: ${role}`);
    }
  }
  for (const [target, index] of Object.entries(paneStatus.recommended_inspect_indexes)) {
    if (typeof index === 'number') {
      console.log(`inspect_index_${target}: ${index}`);
    }
  }
  for (const [target, alive] of Object.entries(paneStatus.recommended_inspect_alive)) {
    if (typeof alive === 'boolean') {
      console.log(`inspect_alive_${target}: ${alive}`);
    }
  }
  for (const [target, turnCount] of Object.entries(paneStatus.recommended_inspect_turn_counts)) {
    if (typeof turnCount === 'number') {
      console.log(`inspect_turn_count_${target}: ${turnCount}`);
    }
  }
  for (const [target, turnsWithoutProgress] of Object.entries(paneStatus.recommended_inspect_turns_without_progress)) {
    if (typeof turnsWithoutProgress === 'number') {
      console.log(`inspect_turns_without_progress_${target}: ${turnsWithoutProgress}`);
    }
  }
  for (const [target, lastTurnAt] of Object.entries(paneStatus.recommended_inspect_last_turn_at)) {
    if (lastTurnAt) {
      console.log(`inspect_last_turn_at_${target}: ${lastTurnAt}`);
    }
  }
  for (const [target, statusUpdatedAt] of Object.entries(paneStatus.recommended_inspect_status_updated_at)) {
    if (statusUpdatedAt) {
      console.log(`inspect_status_updated_at_${target}: ${statusUpdatedAt}`);
    }
  }
  for (const [target, pid] of Object.entries(paneStatus.recommended_inspect_pids)) {
    if (typeof pid === 'number') {
      console.log(`inspect_pid_${target}: ${pid}`);
    }
  }
  for (const [target, worktreePath] of Object.entries(paneStatus.recommended_inspect_worktree_paths)) {
    if (worktreePath) {
      console.log(`inspect_worktree_path_${target}: ${worktreePath}`);
    }
  }
  for (const [target, worktreeRepoRoot] of Object.entries(paneStatus.recommended_inspect_worktree_repo_roots)) {
    if (worktreeRepoRoot) {
      console.log(`inspect_worktree_repo_root_${target}: ${worktreeRepoRoot}`);
    }
  }
  for (const [target, worktreeBranch] of Object.entries(paneStatus.recommended_inspect_worktree_branches)) {
    if (worktreeBranch) {
      console.log(`inspect_worktree_branch_${target}: ${worktreeBranch}`);
    }
  }
  for (const [target, worktreeDetached] of Object.entries(paneStatus.recommended_inspect_worktree_detached)) {
    if (typeof worktreeDetached === 'boolean') {
      console.log(`inspect_worktree_detached_${target}: ${worktreeDetached}`);
    }
  }
  for (const [target, worktreeCreated] of Object.entries(paneStatus.recommended_inspect_worktree_created)) {
    if (typeof worktreeCreated === 'boolean') {
      console.log(`inspect_worktree_created_${target}: ${worktreeCreated}`);
    }
  }
  for (const [target, teamStateRoot] of Object.entries(paneStatus.recommended_inspect_team_state_roots)) {
    if (teamStateRoot) {
      console.log(`inspect_team_state_root_${target}: ${teamStateRoot}`);
    }
  }
  for (const [target, workdir] of Object.entries(paneStatus.recommended_inspect_workdirs)) {
    if (workdir) {
      console.log(`inspect_workdir_${target}: ${workdir}`);
    }
  }
  for (const [target, assignedTasks] of Object.entries(paneStatus.recommended_inspect_assigned_tasks)) {
    if (assignedTasks.length > 0) {
      console.log(`inspect_assigned_tasks_${target}: ${assignedTasks.join(' ')}`);
    }
  }
  for (const [target, taskStatus] of Object.entries(paneStatus.recommended_inspect_task_statuses)) {
    if (taskStatus) {
      console.log(`inspect_task_status_${target}: ${taskStatus}`);
    }
  }
  for (const [target, taskResult] of Object.entries(paneStatus.recommended_inspect_task_results)) {
    if (taskResult) {
      console.log(`inspect_task_result_${target}: ${taskResult}`);
    }
  }
  for (const [target, taskError] of Object.entries(paneStatus.recommended_inspect_task_errors)) {
    if (taskError) {
      console.log(`inspect_task_error_${target}: ${taskError}`);
    }
  }
  for (const [target, taskVersion] of Object.entries(paneStatus.recommended_inspect_task_versions)) {
    if (typeof taskVersion === 'number') {
      console.log(`inspect_task_version_${target}: ${taskVersion}`);
    }
  }
  for (const [target, taskCreatedAt] of Object.entries(paneStatus.recommended_inspect_task_created_at)) {
    if (taskCreatedAt) {
      console.log(`inspect_task_created_at_${target}: ${taskCreatedAt}`);
    }
  }
  for (const [target, taskCompletedAt] of Object.entries(paneStatus.recommended_inspect_task_completed_at)) {
    if (taskCompletedAt) {
      console.log(`inspect_task_completed_at_${target}: ${taskCompletedAt}`);
    }
  }
  for (const [target, taskDependsOn] of Object.entries(paneStatus.recommended_inspect_task_depends_on)) {
    if (taskDependsOn.length > 0) {
      console.log(`inspect_task_depends_on_${target}: ${taskDependsOn.join(' ')}`);
    }
  }
  for (const [target, taskClaimPresent] of Object.entries(paneStatus.recommended_inspect_task_claim_present)) {
    if (typeof taskClaimPresent === 'boolean') {
      console.log(`inspect_task_claim_present_${target}: ${taskClaimPresent}`);
    }
  }
  for (const [target, taskClaimOwner] of Object.entries(paneStatus.recommended_inspect_task_claim_owners)) {
    if (taskClaimOwner) {
      console.log(`inspect_task_claim_owner_${target}: ${taskClaimOwner}`);
    }
  }
  for (const [target, taskClaimToken] of Object.entries(paneStatus.recommended_inspect_task_claim_tokens)) {
    if (taskClaimToken) {
      console.log(`inspect_task_claim_token_${target}: ${taskClaimToken}`);
    }
  }
  for (const [target, taskClaimLease] of Object.entries(paneStatus.recommended_inspect_task_claim_leases)) {
    if (taskClaimLease) {
      console.log(`inspect_task_claim_leased_until_${target}: ${taskClaimLease}`);
    }
  }
  for (const [target, taskClaimLockPath] of Object.entries(paneStatus.recommended_inspect_task_claim_lock_paths)) {
    if (taskClaimLockPath) {
      console.log(`inspect_task_claim_lock_path_${target}: ${taskClaimLockPath}`);
    }
  }
  for (const [target, approvalRequired] of Object.entries(paneStatus.recommended_inspect_approval_required)) {
    if (typeof approvalRequired === 'boolean') {
      console.log(`inspect_approval_required_${target}: ${approvalRequired}`);
    }
  }
  for (const [target, requiresCodeChange] of Object.entries(paneStatus.recommended_inspect_requires_code_change)) {
    if (typeof requiresCodeChange === 'boolean') {
      console.log(`inspect_requires_code_change_${target}: ${requiresCodeChange}`);
    }
  }
  for (const [target, description] of Object.entries(paneStatus.recommended_inspect_descriptions)) {
    if (description) {
      console.log(`inspect_description_${target}: ${description}`);
    }
  }
  for (const [target, blockedBy] of Object.entries(paneStatus.recommended_inspect_blocked_by)) {
    if (blockedBy.length > 0) {
      console.log(`inspect_blocked_by_${target}: ${blockedBy.join(' ')}`);
    }
  }
  for (const [target, taskRole] of Object.entries(paneStatus.recommended_inspect_task_roles)) {
    if (taskRole) {
      console.log(`inspect_task_role_${target}: ${taskRole}`);
    }
  }
  for (const [target, taskOwner] of Object.entries(paneStatus.recommended_inspect_task_owners)) {
    if (taskOwner) {
      console.log(`inspect_task_owner_${target}: ${taskOwner}`);
    }
  }
  for (const [target, approvalStatus] of Object.entries(paneStatus.recommended_inspect_approval_statuses)) {
    if (approvalStatus) {
      console.log(`inspect_approval_status_${target}: ${approvalStatus}`);
    }
  }
  for (const [target, approvalReviewer] of Object.entries(paneStatus.recommended_inspect_approval_reviewers)) {
    if (approvalReviewer) {
      console.log(`inspect_approval_reviewer_${target}: ${approvalReviewer}`);
    }
  }
  for (const [target, approvalReason] of Object.entries(paneStatus.recommended_inspect_approval_reasons)) {
    if (approvalReason) {
      console.log(`inspect_approval_reason_${target}: ${approvalReason}`);
    }
  }
  for (const [target, approvalDecidedAt] of Object.entries(paneStatus.recommended_inspect_approval_decided_at)) {
    if (approvalDecidedAt) {
      console.log(`inspect_approval_decided_at_${target}: ${approvalDecidedAt}`);
    }
  }
  for (const [target, approvalRecordPresent] of Object.entries(paneStatus.recommended_inspect_approval_record_present)) {
    if (typeof approvalRecordPresent === 'boolean') {
      console.log(`inspect_approval_record_present_${target}: ${approvalRecordPresent}`);
    }
  }
  for (const [target, state] of Object.entries(paneStatus.recommended_inspect_states)) {
    if (state) {
      console.log(`inspect_state_${target}: ${state}`);
    }
  }
  for (const [target, stateReason] of Object.entries(paneStatus.recommended_inspect_state_reasons)) {
    if (stateReason) {
      console.log(`inspect_state_reason_${target}: ${stateReason}`);
    }
  }
  for (const [target, taskId] of Object.entries(paneStatus.recommended_inspect_tasks)) {
    if (taskId) {
      console.log(`inspect_task_${target}: ${taskId}`);
    }
  }
  for (const [target, subject] of Object.entries(paneStatus.recommended_inspect_subjects)) {
    if (subject) {
      console.log(`inspect_subject_${target}: ${subject}`);
    }
  }
  for (const [target, taskPath] of Object.entries(paneStatus.recommended_inspect_task_paths)) {
    if (taskPath) {
      console.log(`inspect_task_path_${target}: ${taskPath}`);
    }
  }
  for (const [target, approvalPath] of Object.entries(paneStatus.recommended_inspect_approval_paths)) {
    if (approvalPath) {
      console.log(`inspect_approval_path_${target}: ${approvalPath}`);
    }
  }
  for (const [target, workerStateDir] of Object.entries(paneStatus.recommended_inspect_worker_state_dirs)) {
    if (workerStateDir) {
      console.log(`inspect_worker_state_dir_${target}: ${workerStateDir}`);
    }
  }
  for (const [target, workerStatusPath] of Object.entries(paneStatus.recommended_inspect_worker_status_paths)) {
    if (workerStatusPath) {
      console.log(`inspect_worker_status_path_${target}: ${workerStatusPath}`);
    }
  }
  for (const [target, workerHeartbeatPath] of Object.entries(paneStatus.recommended_inspect_worker_heartbeat_paths)) {
    if (workerHeartbeatPath) {
      console.log(`inspect_worker_heartbeat_path_${target}: ${workerHeartbeatPath}`);
    }
  }
  for (const [target, workerIdentityPath] of Object.entries(paneStatus.recommended_inspect_worker_identity_paths)) {
    if (workerIdentityPath) {
      console.log(`inspect_worker_identity_path_${target}: ${workerIdentityPath}`);
    }
  }
  for (const [target, workerInboxPath] of Object.entries(paneStatus.recommended_inspect_worker_inbox_paths)) {
    if (workerInboxPath) {
      console.log(`inspect_worker_inbox_path_${target}: ${workerInboxPath}`);
    }
  }
  for (const [target, workerMailboxPath] of Object.entries(paneStatus.recommended_inspect_worker_mailbox_paths)) {
    if (workerMailboxPath) {
      console.log(`inspect_worker_mailbox_path_${target}: ${workerMailboxPath}`);
    }
  }
  for (const [target, workerShutdownRequestPath] of Object.entries(paneStatus.recommended_inspect_worker_shutdown_request_paths)) {
    if (workerShutdownRequestPath) {
      console.log(`inspect_worker_shutdown_request_path_${target}: ${workerShutdownRequestPath}`);
    }
  }
  for (const [target, workerShutdownAckPath] of Object.entries(paneStatus.recommended_inspect_worker_shutdown_ack_paths)) {
    if (workerShutdownAckPath) {
      console.log(`inspect_worker_shutdown_ack_path_${target}: ${workerShutdownAckPath}`);
    }
  }
  for (const [target, teamDirPath] of Object.entries(paneStatus.recommended_inspect_team_dir_paths)) {
    if (teamDirPath) {
      console.log(`inspect_team_dir_path_${target}: ${teamDirPath}`);
    }
  }
  for (const [target, teamConfigPath] of Object.entries(paneStatus.recommended_inspect_team_config_paths)) {
    if (teamConfigPath) {
      console.log(`inspect_team_config_path_${target}: ${teamConfigPath}`);
    }
  }
  for (const [target, teamManifestPath] of Object.entries(paneStatus.recommended_inspect_team_manifest_paths)) {
    if (teamManifestPath) {
      console.log(`inspect_team_manifest_path_${target}: ${teamManifestPath}`);
    }
  }
  for (const [target, teamEventsPath] of Object.entries(paneStatus.recommended_inspect_team_events_paths)) {
    if (teamEventsPath) {
      console.log(`inspect_team_events_path_${target}: ${teamEventsPath}`);
    }
  }
  for (const [target, teamDispatchPath] of Object.entries(paneStatus.recommended_inspect_team_dispatch_paths)) {
    if (teamDispatchPath) {
      console.log(`inspect_team_dispatch_path_${target}: ${teamDispatchPath}`);
    }
  }
  for (const [target, teamPhasePath] of Object.entries(paneStatus.recommended_inspect_team_phase_paths)) {
    if (teamPhasePath) {
      console.log(`inspect_team_phase_path_${target}: ${teamPhasePath}`);
    }
  }
  for (const [target, teamMonitorSnapshotPath] of Object.entries(paneStatus.recommended_inspect_team_monitor_snapshot_paths)) {
    if (teamMonitorSnapshotPath) {
      console.log(`inspect_team_monitor_snapshot_path_${target}: ${teamMonitorSnapshotPath}`);
    }
  }
  for (const [target, teamSummarySnapshotPath] of Object.entries(paneStatus.recommended_inspect_team_summary_snapshot_paths)) {
    if (teamSummarySnapshotPath) {
      console.log(`inspect_team_summary_snapshot_path_${target}: ${teamSummarySnapshotPath}`);
    }
  }
  for (const [target, paneId] of Object.entries(paneStatus.recommended_inspect_panes)) {
    if (paneId) {
      console.log(`inspect_pane_${target}: ${paneId}`);
    }
  }
  if (paneStatus.recommended_inspect_command) {
    console.log(`inspect_next: ${paneStatus.recommended_inspect_command}`);
  }
  if (paneStatus.recommended_inspect_summary) {
    console.log(`inspect_summary: ${paneStatus.recommended_inspect_summary}`);
  }
  for (const [index, command] of paneStatus.recommended_inspect_commands.entries()) {
    console.log(`inspect_priority_${index + 1}: ${command}`);
  }
  for (const [index, item] of paneStatus.recommended_inspect_items.entries()) {
    const panePart = item.pane_id ? ` pane=${item.pane_id}` : '';
    const cliPart = item.worker_cli ? ` cli=${item.worker_cli}` : '';
    const rolePart = item.role ? ` role=${item.role}` : '';
    const indexPart = typeof item.index === 'number' ? ` index=${item.index}` : '';
    const alivePart = typeof item.alive === 'boolean' ? ` alive=${item.alive}` : '';
    const turnCountPart = typeof item.turn_count === 'number' ? ` turn_count=${item.turn_count}` : '';
    const turnsWithoutProgressPart = typeof item.turns_without_progress === 'number'
      ? ` turns_without_progress=${item.turns_without_progress}`
      : '';
    const lastTurnPart = item.last_turn_at ? ` last_turn_at=${item.last_turn_at}` : '';
    const statusUpdatedPart = item.status_updated_at ? ` status_updated_at=${item.status_updated_at}` : '';
    const pidPart = typeof item.pid === 'number' ? ` pid=${item.pid}` : '';
    const worktreeRepoRootPart = item.worktree_repo_root ? ` worktree_repo_root=${item.worktree_repo_root}` : '';
    const worktreePathPart = item.worktree_path ? ` worktree_path=${item.worktree_path}` : '';
    const worktreeBranchPart = item.worktree_branch ? ` worktree_branch=${item.worktree_branch}` : '';
    const worktreeDetachedPart = typeof item.worktree_detached === 'boolean'
      ? ` worktree_detached=${item.worktree_detached}`
      : '';
    const worktreeCreatedPart = typeof item.worktree_created === 'boolean'
      ? ` worktree_created=${item.worktree_created}`
      : '';
    const teamStateRootPart = item.team_state_root ? ` team_state_root=${item.team_state_root}` : '';
    const workdirPart = item.working_dir ? ` workdir=${item.working_dir}` : '';
    const assignedTasksPart = item.assigned_tasks.length > 0 ? ` assigned_tasks=${item.assigned_tasks.join(',')}` : '';
    const taskStatusPart = item.task_status ? ` task_status=${item.task_status}` : '';
    const taskResultPart = item.task_result ? ` task_result=${item.task_result}` : '';
    const taskErrorPart = item.task_error ? ` task_error=${item.task_error}` : '';
    const taskVersionPart = typeof item.task_version === 'number' ? ` task_version=${item.task_version}` : '';
    const taskCreatedAtPart = item.task_created_at ? ` task_created_at=${item.task_created_at}` : '';
    const taskCompletedAtPart = item.task_completed_at ? ` task_completed_at=${item.task_completed_at}` : '';
    const taskDependsOnPart = item.task_depends_on.length > 0 ? ` task_depends_on=${item.task_depends_on.join(',')}` : '';
    const taskClaimPresentPart = typeof item.task_claim_present === 'boolean'
      ? ` task_claim_present=${item.task_claim_present}`
      : '';
    const taskClaimOwnerPart = item.task_claim_owner ? ` task_claim_owner=${item.task_claim_owner}` : '';
    const taskClaimTokenPart = item.task_claim_token ? ` task_claim_token=${item.task_claim_token}` : '';
    const taskClaimLeasePart = item.task_claim_leased_until ? ` task_claim_leased_until=${item.task_claim_leased_until}` : '';
    const taskClaimLockPathPart = item.task_claim_lock_path ? ` task_claim_lock_path=${item.task_claim_lock_path}` : '';
    const approvalRequiredPart = typeof item.approval_required === 'boolean' ? ` approval_required=${item.approval_required}` : '';
    const requiresCodeChangePart = typeof item.requires_code_change === 'boolean'
      ? ` requires_code_change=${item.requires_code_change}`
      : '';
    const taskDescriptionPart = item.task_description ? ` description=${item.task_description}` : '';
    const blockedByPart = item.blocked_by.length > 0 ? ` blocked_by=${item.blocked_by.join(',')}` : '';
    const taskRolePart = item.task_role ? ` task_role=${item.task_role}` : '';
    const taskOwnerPart = item.task_owner ? ` task_owner=${item.task_owner}` : '';
    const approvalStatusPart = item.approval_status ? ` approval_status=${item.approval_status}` : '';
    const approvalReviewerPart = item.approval_reviewer ? ` approval_reviewer=${item.approval_reviewer}` : '';
    const approvalReasonPart = item.approval_reason ? ` approval_reason=${item.approval_reason}` : '';
    const approvalDecidedAtPart = item.approval_decided_at ? ` approval_decided_at=${item.approval_decided_at}` : '';
    const approvalRecordPresentPart = typeof item.approval_record_present === 'boolean'
      ? ` approval_record_present=${item.approval_record_present}`
      : '';
    const statePart = item.state ? ` state=${item.state}` : '';
    const stateReasonPart = item.state_reason ? ` state_reason=${item.state_reason}` : '';
    const taskPart = item.task_id ? ` task=${item.task_id}` : '';
    const subjectPart = item.task_subject ? ` subject=${item.task_subject}` : '';
    const taskPathPart = item.task_path ? ` task_path=${item.task_path}` : '';
    const approvalPathPart = item.approval_path ? ` approval_path=${item.approval_path}` : '';
    const workerStateDirPart = item.worker_state_dir ? ` worker_state_dir=${item.worker_state_dir}` : '';
    const workerStatusPathPart = item.worker_status_path ? ` worker_status_path=${item.worker_status_path}` : '';
    const workerHeartbeatPathPart = item.worker_heartbeat_path ? ` worker_heartbeat_path=${item.worker_heartbeat_path}` : '';
    const workerIdentityPathPart = item.worker_identity_path ? ` worker_identity_path=${item.worker_identity_path}` : '';
    const workerInboxPathPart = item.worker_inbox_path ? ` worker_inbox_path=${item.worker_inbox_path}` : '';
    const workerMailboxPathPart = item.worker_mailbox_path ? ` worker_mailbox_path=${item.worker_mailbox_path}` : '';
    const workerShutdownRequestPathPart = item.worker_shutdown_request_path ? ` worker_shutdown_request_path=${item.worker_shutdown_request_path}` : '';
    const workerShutdownAckPathPart = item.worker_shutdown_ack_path ? ` worker_shutdown_ack_path=${item.worker_shutdown_ack_path}` : '';
    const teamDirPathPart = item.team_dir_path ? ` team_dir_path=${item.team_dir_path}` : '';
    const teamConfigPathPart = item.team_config_path ? ` team_config_path=${item.team_config_path}` : '';
    const teamManifestPathPart = item.team_manifest_path ? ` team_manifest_path=${item.team_manifest_path}` : '';
    const teamEventsPathPart = item.team_events_path ? ` team_events_path=${item.team_events_path}` : '';
    const teamDispatchPathPart = item.team_dispatch_path ? ` team_dispatch_path=${item.team_dispatch_path}` : '';
    const teamPhasePathPart = item.team_phase_path ? ` team_phase_path=${item.team_phase_path}` : '';
    const teamMonitorSnapshotPathPart = item.team_monitor_snapshot_path ? ` team_monitor_snapshot_path=${item.team_monitor_snapshot_path}` : '';
    const teamSummarySnapshotPathPart = item.team_summary_snapshot_path ? ` team_summary_snapshot_path=${item.team_summary_snapshot_path}` : '';
    console.log(`inspect_item_${index + 1}: target=${item.target}${panePart}${cliPart}${rolePart}${indexPart}${alivePart}${turnCountPart}${turnsWithoutProgressPart}${lastTurnPart}${statusUpdatedPart}${pidPart}${worktreeRepoRootPart}${worktreePathPart}${worktreeBranchPart}${worktreeDetachedPart}${worktreeCreatedPart}${teamStateRootPart}${workdirPart}${assignedTasksPart}${taskStatusPart}${taskResultPart}${taskErrorPart}${taskVersionPart}${taskCreatedAtPart}${taskCompletedAtPart}${taskDependsOnPart}${taskClaimPresentPart}${taskClaimOwnerPart}${taskClaimTokenPart}${taskClaimLeasePart}${taskClaimLockPathPart}${approvalRequiredPart}${requiresCodeChangePart}${taskDescriptionPart}${blockedByPart}${taskRolePart}${taskOwnerPart}${approvalStatusPart}${approvalReviewerPart}${approvalReasonPart}${approvalDecidedAtPart}${approvalRecordPresentPart}${stateReasonPart}${taskPart}${subjectPart}${taskPathPart}${approvalPathPart}${workerStateDirPart}${workerStatusPathPart}${workerHeartbeatPathPart}${workerIdentityPathPart}${workerInboxPathPart}${workerMailboxPathPart}${workerShutdownRequestPathPart}${workerShutdownAckPathPart}${teamDirPathPart}${teamConfigPathPart}${teamManifestPathPart}${teamEventsPathPart}${teamDispatchPathPart}${teamPhasePathPart}${teamMonitorSnapshotPathPart}${teamSummarySnapshotPathPart} reason=${item.reason}${statePart} command=${item.command}`);
  }

  for (const [target, command] of Object.entries(paneStatus.sparkshell_commands)) {
    console.log(`inspect_${target}: ${command}`);
  }
}

function parseTeamArgs(args: string[]): ParsedTeamArgs {
  const tokens = [...args];
  let ralph = false;
  let workerCount = 3;
  let agentType = 'executor';
  let explicitAgentType = false;
  let explicitWorkerCount = false;

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
    explicitWorkerCount = true;
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
  return { workerCount, agentType, explicitAgentType, explicitWorkerCount, task, teamName, ralph };
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
type DecompositionStrategy = 'numbered' | 'bulleted' | 'conjunction' | 'atomic';

interface DecompositionCandidate {
  subject: string;
  description: string;
}

interface DecompositionPlan {
  strategy: DecompositionStrategy;
  subtasks: DecompositionCandidate[];
}

export interface TeamExecutionPlan {
  workerCount: number;
  tasks: Array<{ subject: string; description: string; owner: string; role?: string }>;
}

function resolveImplicitTeamFallbackRole(agentType: string, explicitAgentType: boolean): string {
  return !explicitAgentType && agentType === 'executor' ? 'team-executor' : agentType;
}

function looksLikeLowConfidenceAnalysisTask(task: string): boolean {
  const normalized = task.trim();
  return ANALYSIS_TASK_PREFIX.test(normalized)
    && (ANALYSIS_DELIVERABLE_SIGNAL.test(normalized)
      || countWords(normalized) > 18
      || CONTEXTUAL_DECOMPOSITION_CLAUSE.test(normalized));
}

function resolveTeamFanoutLimit(
  task: string,
  requestedWorkerCount: number,
  explicitAgentType: boolean,
  explicitWorkerCount: boolean,
  plan: DecompositionPlan,
): number {
  if (requestedWorkerCount <= 1 || explicitAgentType || explicitWorkerCount || plan.strategy === 'numbered' || plan.strategy === 'bulleted') {
    return requestedWorkerCount;
  }

  const size = classifyTaskSize(task).size;
  if (plan.strategy === 'atomic') {
    if (looksLikeLowConfidenceAnalysisTask(task)) {
      return 1;
    }

    if (size === 'small') {
      const proseHeavyAtomicTask = countWords(task) > 18 || CONTEXTUAL_DECOMPOSITION_CLAUSE.test(task);
      if (!proseHeavyAtomicTask) return 1;
    }

    if (!hasAtomicParallelizationSignals(task, size)) {
      return 1;
    }
  }

  if (plan.strategy === 'conjunction' && size !== 'large') {
    return Math.min(requestedWorkerCount, Math.max(2, plan.subtasks.length));
  }

  return requestedWorkerCount;
}

export function buildTeamExecutionPlan(
  task: string,
  workerCount: number,
  agentType: string,
  explicitAgentType: boolean,
  explicitWorkerCount = false,
): TeamExecutionPlan {
  const plan = splitTaskString(task);
  const effectiveWorkerCount = resolveTeamFanoutLimit(
    task,
    workerCount,
    explicitAgentType,
    explicitWorkerCount,
    plan,
  );
  const fallbackRole = resolveImplicitTeamFallbackRole(agentType, explicitAgentType);

  let subtasks = plan.subtasks;
  const usedAspectSubtasks = subtasks.length <= 1 && effectiveWorkerCount > 1;
  if (subtasks.length <= 1 && effectiveWorkerCount > 1) {
    subtasks = createAspectSubtasks(task, effectiveWorkerCount);
  }

  const tasksWithRoles = subtasks.map((st) => {
    if (explicitAgentType) {
      return { ...st, role: agentType };
    }
    const result = routeTaskToRole(st.subject, st.description, 'team-exec', fallbackRole);
    return { ...st, role: result.role };
  });

  const normalizedRoles = new Set(tasksWithRoles.map((task) => (task.role ?? '').trim()));
  const tasks = usedAspectSubtasks && tasksWithRoles.length > 1 && normalizedRoles.size <= 1
    ? tasksWithRoles.map((task, index) => ({
      ...task,
      owner: `worker-${(index % effectiveWorkerCount) + 1}`,
    }))
    : distributeTasksToWorkers(
      tasksWithRoles,
      effectiveWorkerCount,
      explicitAgentType ? agentType : undefined,
    );

  return {
    workerCount: effectiveWorkerCount,
    tasks,
  };
}

export function decomposeTaskString(
  task: string,
  workerCount: number,
  agentType: string,
  explicitAgentType: boolean,
  explicitWorkerCount = false,
): Array<{ subject: string; description: string; owner: string; role?: string }> {
  return buildTeamExecutionPlan(task, workerCount, agentType, explicitAgentType, explicitWorkerCount).tasks;
}

const ACTIONABLE_TASK_PREFIX = /^(?:add|analy(?:se|ze)|audit|benchmark|build|clean(?:\s+up)?|create|debug|design|document|draft|fix|implement|improve|investigate|migrate|optimi(?:s|z)e|profile|refactor|repair|research|review|ship|summari(?:s|z)e|test|update|validate|verify|write)\b/i;
const TASK_LABEL_PREFIX = /^(?:task|step|phase|part)\s+[\w-]+(?:\s+[\w-]+)?$/i;
const ANALYSIS_TASK_PREFIX = /^(?:analy(?:se|ze)|audit|assess|evaluate|explore|investigate|research|review|study|summari(?:s|z)e)\b/i;
const ANALYSIS_DELIVERABLE_SIGNAL = /\b(?:actionable recommendations?|evidence(?: pointers?)?|findings?|issue|operator|report|root cause|summary|user impact|write-?up)\b/i;
const CONTEXTUAL_DECOMPOSITION_CLAUSE = /\b(?:focusing on|focus on|including|covers?|covering|with|while|without|ensuring|suitable for|root cause|user impact|evidence pointers|actionable recommendations)\b/i;
const BULLET_LINE_PATTERN = /^(?:[-*•]|(?:\[\s?[xX]?\]))\s+(.+)$/;
const FILE_REFERENCE_PATTERN = /(?:^|[\s`'"])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?=$|[\s`'",;:])/g;
const CODE_SYMBOL_PATTERN = /[`'][A-Za-z_][A-Za-z0-9_.-]*[`']/g;
const PARALLELIZATION_SIGNAL = /\b(?:acceptance criteria|cross[\s-]cutting|independent|in parallel|separately|verification|verify|tests?|docs?|documentation|benchmarks?|migration|rollout)\b/i;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countDistinctMatches(text: string, pattern: RegExp): number {
  const matches = new Set<string>();
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
    const value = (match[1] ?? match[0] ?? '').trim().toLowerCase();
    if (value) matches.add(value);
  }
  return matches.size;
}

function hasAtomicParallelizationSignals(task: string, size: ReturnType<typeof classifyTaskSize>['size']): boolean {
  const fileRefCount = countDistinctMatches(task, FILE_REFERENCE_PATTERN);
  const symbolRefCount = countDistinctMatches(task, CODE_SYMBOL_PATTERN);
  if (fileRefCount >= 2) return true;
  if (fileRefCount >= 1 && symbolRefCount >= 1) return true;
  if (PARALLELIZATION_SIGNAL.test(task) && size === 'large') return true;
  return size === 'large' && countWords(task) >= 24;
}

function looksLikeStandaloneWeakSubtask(part: string): boolean {
  const normalized = part.trim().replace(/^[*-]\s*/, '');
  return ACTIONABLE_TASK_PREFIX.test(normalized) || TASK_LABEL_PREFIX.test(normalized);
}

function canSafelySplitWeakTaskList(task: string, parts: string[]): boolean {
  if (parts.length < 2) return false;
  if (countWords(task) > 18) return false;
  if (CONTEXTUAL_DECOMPOSITION_CLAUSE.test(task)) return false;
  return parts.every((part) => countWords(part) <= 8 && looksLikeStandaloneWeakSubtask(part));
}

/** Split a task string into sub-tasks using numbered lists or conservative delimiters. */
function splitTaskString(task: string): DecompositionPlan {
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
    if (parts.length >= 2) return { strategy: 'numbered', subtasks: parts };
  }

  const bulletParts = task
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .map((line) => line.match(BULLET_LINE_PATTERN)?.[1]?.trim() ?? '')
    .filter((line) => line.length > 0);
  if (bulletParts.length >= 2) {
    return {
      strategy: 'bulleted',
      subtasks: bulletParts.map((part) => ({ subject: part.slice(0, 80), description: part })),
    };
  }

  const strongParts = task.split(/;\s+/).map(s => s.trim()).filter(s => s.length > 0);
  if (strongParts.length >= 2) {
    return {
      strategy: 'conjunction',
      subtasks: strongParts.map((part) => ({ subject: part.slice(0, 80), description: part })),
    };
  }

  // Commas / "and" only split when the overall input already looks like a flat task list.
  const weakParts = task.split(/(?:,\s+and\s+|,\s+|\s+and\s+)/i).map(s => s.trim()).filter(s => s.length > 0);
  if (canSafelySplitWeakTaskList(task, weakParts)) {
    return {
      strategy: 'conjunction',
      subtasks: weakParts.map((part) => ({ subject: part.slice(0, 80), description: part })),
    };
  }

  return {
    strategy: 'atomic',
    subtasks: [{ subject: task.slice(0, 80), description: task }],
  };
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

/** Distribute tasks across workers using an inspectable allocation policy. */
function distributeTasksToWorkers(
  tasks: Array<{ subject: string; description: string; role?: string; blocked_by?: string[] }>,
  workerCount: number,
  workerRole?: string,
): Array<{ subject: string; description: string; owner: string; role?: string }> {
  const workers = Array.from({ length: workerCount }, (_, index) => ({
    name: `worker-${index + 1}`,
    role: workerRole,
  }));
  return allocateTasksToWorkers(tasks, workers).map(({ allocation_reason: _allocationReason, ...task }) => task);
}

async function ensureTeamModeState(
  parsed: ParsedTeamArgs,
  tasks?: Array<{ role?: string }>,
): Promise<void> {
  const fallbackRole = resolveImplicitTeamFallbackRole(parsed.agentType, parsed.explicitAgentType);
  const roleDistribution = tasks && tasks.length > 0
    ? [...new Set(tasks.map(t => t.role ?? parsed.agentType))].join(',')
    : parsed.agentType;

  const availableAgentTypes = await resolveAvailableAgentTypes(process.cwd());
  const staffingPlan = buildFollowupStaffingPlan('team', parsed.task, availableAgentTypes, {
    workerCount: parsed.workerCount,
    fallbackRole,
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
    if (parsed.ralph) {
      await ensureLinkedRalphModeState(parsed);
    }
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

  if (parsed.ralph) {
    await ensureLinkedRalphModeState(parsed);
  }
}

function isLinkedRalphProfile(
  config: { lifecycle_profile?: unknown } | null | undefined,
): boolean {
  return config?.lifecycle_profile === 'linked_ralph';
}

async function ensureLinkedRalphModeState(parsed: ParsedTeamArgs): Promise<void> {
  const existing = await readModeState('ralph').catch(() => null);
  const nextPhase = existing?.active === true
    && typeof existing.current_phase === 'string'
    && !['complete', 'failed', 'cancelled'].includes(existing.current_phase)
    ? existing.current_phase
    : 'executing';

  if (!existing?.active) {
    await startMode('ralph', parsed.task, 50);
  }

  await updateModeState('ralph', {
    active: true,
    task_description: parsed.task,
    current_phase: nextPhase,
    completed_at: undefined,
    linked_team: true,
    linked_mode: 'team',
    team_name: parsed.teamName,
    linked_team_terminal_phase: undefined,
    linked_team_terminal_at: undefined,
  });
}

export function buildLeaderMonitoringHints(teamName: string): string[] {
  const sanitized = sanitizeTeamName(teamName);
  return [
    `leader_check: omx team status ${sanitized}`,
    `leader_loop_hint: while ON, keep checking state (example: sleep 30 && omx team status ${sanitized})`,
  ];
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
  for (const hint of buildLeaderMonitoringHints(runtime.teamName)) {
    console.log(hint);
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
    const jsonBase = buildJsonBase();
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
    const wantsJson = teamArgs.includes('--json');
    if (!name) throw new Error('Usage: omx team status <team-name> [--json]');
    const snapshot = await monitorTeam(name, cwd);
    if (!snapshot) {
      if (wantsJson) {
        console.log(JSON.stringify({
          ...buildJsonBase(),
          command: 'omx team status',
          team_name: name,
          status: 'missing',
        }));
        return;
      }
      console.log(`No team state found for ${name}`);
      return;
    }
    const tailLines = parseStatusTailLines(teamArgs.slice(2));
    const paneStatus = await readTeamPaneStatus(await readTeamConfig(name, cwd), cwd, snapshot, tailLines);
    if (wantsJson) {
      console.log(JSON.stringify({
        ...buildJsonBase(),
        command: 'omx team status',
        team_name: snapshot.teamName,
        status: 'ok',
        tail_lines: tailLines,
        phase: snapshot.phase,
        dead_workers: snapshot.deadWorkers,
        non_reporting_workers: snapshot.nonReportingWorkers,
        workers: {
          total: snapshot.workers.length,
          dead: snapshot.deadWorkers.length,
          non_reporting: snapshot.nonReportingWorkers.length,
        },
        tasks: {
          total: snapshot.tasks.total,
          pending: snapshot.tasks.pending,
          blocked: snapshot.tasks.blocked,
          in_progress: snapshot.tasks.in_progress,
          completed: snapshot.tasks.completed,
          failed: snapshot.tasks.failed,
        },
        performance: snapshot.performance ?? null,
        panes: paneStatus,
      }));
      return;
    }
    console.log(`team=${snapshot.teamName} phase=${snapshot.phase}`);
    console.log(`workers: total=${snapshot.workers.length} dead=${snapshot.deadWorkers.length} non_reporting=${snapshot.nonReportingWorkers.length}`);
    if (snapshot.deadWorkers.length > 0) {
      console.log(`dead_workers: ${snapshot.deadWorkers.join(' ')}`);
    }
    if (snapshot.nonReportingWorkers.length > 0) {
      console.log(`non_reporting_workers: ${snapshot.nonReportingWorkers.join(' ')}`);
    }
    console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} blocked=${snapshot.tasks.blocked} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
    if (snapshot.performance) {
      console.log(
        `monitor_perf_ms: total=${snapshot.performance.total_ms} list=${snapshot.performance.list_tasks_ms} workers=${snapshot.performance.worker_scan_ms} mailbox=${snapshot.performance.mailbox_delivery_ms}`
      );
    }
    renderTeamPaneStatus(paneStatus);
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
    const persistedRalph = isLinkedRalphProfile(runtime.config);
    const preservedRalph = persistedRalph || (
      existingState?.active === true
      && existingState?.team_name === runtime.teamName
      && existingState?.linked_ralph === true
    );
    await ensureTeamModeState({
      task: runtime.config.task,
      workerCount: runtime.config.worker_count,
      agentType: runtime.config.agent_type,
      explicitAgentType: false,
      explicitWorkerCount: false,
      teamName: runtime.teamName,
      ralph: preservedRalph,
    });
    const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
    const staffingPlan = buildFollowupStaffingPlan('team', runtime.config.task, availableAgentTypes, {
      workerCount: runtime.config.worker_count,
      fallbackRole: resolveImplicitTeamFallbackRole(runtime.config.agent_type, false),
    });
    await renderStartSummary(runtime, staffingPlan);
    return;
  }

  if (subcommand === 'shutdown') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team shutdown <team-name> [--force] [--ralph]');
    const force = teamArgs.includes('--force');
    const ralphFlag = teamArgs.includes('--ralph');
    const persistedConfig = await readTeamConfig(name, cwd).catch(() => null);
    const ralphFromState = !ralphFlag
      ? (
        isLinkedRalphProfile(persistedConfig)
        || await readModeState('team').then(
          (s) => s?.active === true && s?.linked_ralph === true && s?.team_name === name,
          () => false,
        )
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
  const executionPlan = buildTeamExecutionPlan(
    parsed.task,
    parsed.workerCount,
    parsed.agentType,
    parsed.explicitAgentType,
    parsed.explicitWorkerCount,
  );
  const tasks = executionPlan.tasks;
  const effectiveParsed = executionPlan.workerCount === parsed.workerCount
    ? parsed
    : { ...parsed, workerCount: executionPlan.workerCount };
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('team', parsed.task, availableAgentTypes, {
    workerCount: executionPlan.workerCount,
    fallbackRole: resolveImplicitTeamFallbackRole(parsed.agentType, parsed.explicitAgentType),
  });
  const runtime = await startTeam(
    parsed.teamName,
    parsed.task,
    parsed.agentType,
    executionPlan.workerCount,
    tasks,
    cwd,
    { worktreeMode: parsedWorktree.mode, ralph: parsed.ralph },
  );

  await ensureTeamModeState(effectiveParsed, tasks);
  if (options.verbose) {
    console.log(`linked_ralph=${parsed.ralph}`);
  }
  await renderStartSummary(runtime, staffingPlan);
}
