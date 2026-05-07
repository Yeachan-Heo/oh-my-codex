import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateModeState, startMode, readModeState } from '../modes/base.js';
import { getStateFilePath, getStatePath, validateSessionId } from '../mcp/state-paths.js';
import { monitorTeam, resumeTeam, shutdownTeam, startTeam, type TeamRuntime, type TeamSnapshot } from '../team/runtime.js';
import { buildRepoAwareTeamExecutionPlan } from '../team/repo-aware-decomposition.js';
import { DEFAULT_MAX_WORKERS } from '../team/state.js';
import { sanitizeTeamName } from '../team/tmux-session.js';
import { readTeamEvents, waitForTeamEvent } from '../team/state/events.js';
import type { TeamEvent } from '../team/state.js';
import { parseWorktreeMode, type WorktreeMode } from '../team/worktree.js';
import { classifyTaskSize } from '../hooks/task-size-detector.js';
import {
  readApprovedExecutionLaunchHint,
  readApprovedExecutionLaunchHintOutcome,
  type ApprovedExecutionLaunchHint,
  type ApprovedRepositoryContextSummary,
} from '../planning/artifacts.js';
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
import { teamReadConfig as readTeamConfig, teamReadPhase as readTeamPhase } from '../team/team-ops.js';
import { resolveTeamNameForCurrentContext } from '../team/team-identity.js';
import { recordLeaderRuntimeActivity } from '../team/leader-activity.js';
import { readTeamPaneStatus } from '../team/pane-status.js';
import {
  buildApprovedTeamExecutionBinding,
  resolvePersistedApprovedTeamExecutionContinuityStateSync,
  type ApprovedTeamExecutionBinding,
} from '../team/approved-execution.js';
import { resolveCodexHomeForLaunch } from './codex-home.js';

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
  displayName?: string;
  allowRepoAwareDagHandoff: boolean;
  approvedRepositoryContextSummary?: ApprovedRepositoryContextSummary;
  approvedExecution?: ApprovedTeamExecutionBinding;
}

interface TeamFollowupContext {
  task: string;
  workerCount: number;
  explicitWorkerCount: boolean;
  agentType?: string;
  explicitAgentType?: boolean;
  approvedHint?: ApprovedExecutionLaunchHint;
}

function persistExactTeamModeState(
  cwd: string,
  updates: Record<string, unknown>,
  sessionId?: string,
): boolean {
  const statePath = getStatePath('team', cwd, sessionId);
  if (!existsSync(statePath)) return false;

  try {
    const current = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...current, ...updates }, null, 2));
    return true;
  } catch {
    return false;
  }
}

function readPersistedTeamFollowupState(cwd: string): {
  active?: boolean;
  team_name?: string;
  team_state_root?: string;
  task?: string;
  task_description?: string;
  workerCount?: number;
  agent_count?: number;
  agentType?: string;
  agent_types?: string;
  linkedRalph?: boolean;
} | null {
  const readState = (path: string) => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as {
        active?: boolean;
        team_name?: string;
        team_state_root?: string;
        task?: string;
        workerCount?: number;
        agentType?: string;
        linkedRalph?: boolean;
        task_description?: string;
        agent_count?: number;
        agent_types?: string;
      };
    } catch {
      return null;
    }
  };

  const isActiveTeamState = (state: {
    active?: boolean;
    team_name?: string;
  } | null): state is {
    active: true;
    team_name: string;
    team_state_root?: string;
    task?: string;
    task_description?: string;
    workerCount?: number;
    agent_count?: number;
    agentType?: string;
    agent_types?: string;
    linkedRalph?: boolean;
  } => state?.active === true && typeof state.team_name === 'string' && state.team_name.trim() !== '';

  const sessionStatePath = getStateFilePath('session.json', cwd);
  let scopedSessionId: string | undefined;
  if (existsSync(sessionStatePath)) {
    try {
      const parsed = JSON.parse(readFileSync(sessionStatePath, 'utf-8')) as { session_id?: unknown };
      scopedSessionId = validateSessionId(parsed.session_id);
    } catch {
      // Best-effort state lookup only.
    }
  }

  if (scopedSessionId) {
    const scopedState = readState(getStatePath('team', cwd, scopedSessionId));
    if (isActiveTeamState(scopedState)) {
      return scopedState;
    }
  }

  const path = getStatePath('team', cwd);
  if (!existsSync(path)) return null;
  const state = readState(path);
  return isActiveTeamState(state) ? state : null;
}

function resolveApprovedTeamFollowupContext(cwd: string, task: string): TeamFollowupContext | null {
  const normalizedTask = task.trim();
  if (!normalizedTask) return null;

  const shortFollowup = ['team', 'team으로 해줘', 'team으로 해주세요'].includes(normalizedTask);
  if (!shortFollowup) return null;

  const existingTeamState = readPersistedTeamFollowupState(cwd);
  const persistedTeamName = typeof existingTeamState?.team_name === 'string'
    ? existingTeamState.team_name.trim()
    : '';
  const persistedTeamStateRoot = typeof existingTeamState?.team_state_root === 'string'
    && existingTeamState.team_state_root.trim() !== ''
    ? existingTeamState.team_state_root.trim()
    : undefined;
  let approvedHint: ApprovedExecutionLaunchHint | null = null;

  if (persistedTeamName !== '') {
    const continuity = resolvePersistedApprovedTeamExecutionContinuityStateSync(
      persistedTeamName,
      cwd,
      persistedTeamStateRoot,
    );
    if (continuity.status === 'malformed') {
      throw new Error(`approved_execution_binding_malformed:${persistedTeamName}`);
    }
    if (continuity.status === 'ambiguous') {
      throw new Error(
        `approved_execution_binding_ambiguous:${continuity.binding.prd_path}:${continuity.binding.task}`,
      );
    }
    if (continuity.status === 'stale') {
      throw new Error(`approved_execution_binding_stale:${continuity.binding.prd_path}:${continuity.binding.task}`);
    }
    if (continuity.status === 'valid') {
      approvedHint = continuity.approvedHint;
    }
  }

  if (!approvedHint) {
    const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team');
    if (approvedHintOutcome.status === 'ambiguous') {
      throw new Error('approved_execution_hint_ambiguous:team');
    }
    if (approvedHintOutcome.status !== 'resolved') return null;
    approvedHint = approvedHintOutcome.hint;
  }

  const persistedTask = typeof existingTeamState?.task_description === 'string'
    ? existingTeamState.task_description
    : typeof existingTeamState?.task === 'string'
      ? existingTeamState.task
      : null;
  const persistedWorkerCount = typeof existingTeamState?.agent_count === 'number'
    ? existingTeamState.agent_count
    : typeof existingTeamState?.workerCount === 'number'
      ? existingTeamState.workerCount
      : null;
  if (persistedTask && persistedWorkerCount && persistedTask.trim() === approvedHint.task.trim()) {
    return {
      task: persistedTask,
      workerCount: persistedWorkerCount,
      explicitWorkerCount: true,
      agentType: approvedHint.agentType,
      explicitAgentType: approvedHint.agentType != null,
      approvedHint,
    };
  }

  return {
    task: approvedHint.task,
    workerCount: approvedHint.workerCount ?? 3,
    explicitWorkerCount: approvedHint.workerCount != null,
    agentType: approvedHint.agentType,
    explicitAgentType: approvedHint.agentType != null,
    approvedHint,
  };
}

const MIN_WORKER_COUNT = 1;
const DEFAULT_SPARKSHELL_TAIL_LINES = 400;
const MIN_SPARKSHELL_TAIL_LINES = 100;
const MAX_SPARKSHELL_TAIL_LINES = 1000;

function isTerminalModePhase(phase: string): boolean {
  return ['complete', 'failed', 'cancelled'].includes(phase);
}

const TEAM_HELP = `
Usage: omx team [N:agent-type] "<task description>"
       omx team status <team-name> [--json] [--tail-lines <100-1000>] [--model-inspect]
       omx team await <team-name> [--timeout-ms <ms>] [--after-event-id <id>] [--json]
       omx team resume <team-name>
       omx team shutdown <team-name> [--force] [--confirm-issues]
       omx team api <operation> [--input <json>] [--json]
       omx team api --help

Notes:
  team workers use dedicated worktrees automatically by default.
  --worktree is deprecated for omx team and is now only a backward-compatible no-op override.
  omx team is a tmux-runtime surface by default; in Codex App or plain outside-tmux sessions, launch OMX CLI from shell first instead of treating team as directly available.
  use native Codex subagents for small in-session fanout; use omx team for durable tmux/state/worktree coordination.
  repo-aware DAG handoff is opt-in: Team only imports a DAG when the invocation matches the latest approved PRD/test-spec launch hint (or a short approved follow-up like \`omx team team\`).

Examples:
  omx team 3:executor "fix failing tests"
  omx team status my-team
  omx team status my-team --json
  omx team status my-team --model-inspect --tail-lines 600
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

Safety:
  team status prints raw tmux capture commands by default so inspect hints do not spend Spark/model quota.
  pass --model-inspect to print omx sparkshell summary commands intentionally.
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
  'cleanup': ['force', 'confirm_issues'],
  'transition-task-status': ['result', 'error'],
  'read-shutdown-ack': ['min_updated_at'],
  'write-worker-identity': [
    'assigned_tasks', 'pid', 'pane_id', 'working_dir',
    'worktree_path', 'worktree_branch', 'worktree_detached', 'team_state_root',
  ],
  'append-event': ['task_id', 'message_id', 'reason', 'state', 'prev_state', 'to_worker', 'worker_count', 'source_type', 'metadata'],
  'read-events': ['after_event_id', 'wakeable_only', 'type', 'worker', 'task_id'],
  'await-event': ['after_event_id', 'timeout_ms', 'poll_ms', 'wakeable_only', 'type', 'worker', 'task_id'],
  'write-task-approval': ['required'],
};

const TEAM_API_OPERATION_NOTES: Partial<Record<TeamApiOperation, string>> = {
  'update-task': 'Only non-lifecycle task metadata can be updated.',
  'release-task-claim': 'Use this only for rollback/requeue to pending (not for completion).',
  'transition-task-status': 'Lifecycle flow is claim-safe and typically transitions in_progress -> completed|failed.',
  'cleanup': 'Uses the runtime shutdown contract; add confirm_issues=true when failed tasks are acknowledged and shutdown should still proceed.',
  'orphan-cleanup': 'Destructive escape hatch for known orphan recovery. Bypasses shutdown orchestration.',
  'read-events': 'Events are returned in canonical form; worker_idle log entries normalize to type worker_state_changed with source_type worker_idle. wakeable_only defaults to false; set wakeable_only=true to mirror omx team await semantics (wakeable events now include merge conflicts and per-signal stale alerts).',
  'await-event': 'Waits for the next matching event and returns status=timeout when no matching event arrives before timeout_ms. wakeable_only defaults to false; set wakeable_only=true to mirror omx team await semantics (wakeable events now include merge conflicts and per-signal stale alerts).',
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
    case 'metadata':
      return {
        summary: 'worker diff report',
        worktree_path: '/tmp/team/worktrees/worker-1',
        diff_path: '/tmp/team/worktrees/worker-1/.omx/diff.md',
        full_diff_available: true,
      };
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

function parseStatusModelInspect(args: string[]): boolean {
  return args.includes('--model-inspect');
}

function rawTmuxCaptureCommand(paneId: string, tailLines: number): string {
  return `tmux capture-pane -p -t ${paneId} -S -${tailLines}`;
}

export interface ParsedTeamStartArgs {
  parsed: ParsedTeamArgs;
  worktreeMode: WorktreeMode;
}

function resolveDefaultTeamWorktreeMode(mode: WorktreeMode): WorktreeMode {
  if (mode.enabled) return mode;
  return { enabled: true, detached: true, name: null };
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


type TeamPaneStatus = Awaited<ReturnType<typeof readTeamPaneStatus>>;
type TeamInspectItem = TeamPaneStatus['recommended_inspect_items'][number];

function logInspectEntries<T>(
  prefix: string,
  entries: Record<string, T>,
  shouldLog: (value: T) => boolean,
  formatValue: (value: T) => string = (value) => String(value),
): void {
  for (const [target, value] of Object.entries(entries)) {
    if (shouldLog(value)) {
      console.log(`${prefix}_${target}: ${formatValue(value)}`);
    }
  }
}

type InspectEntryDescriptor<T> = {
  prefix: string;
  entries: Record<string, T>;
  shouldLog: (value: T) => boolean;
  formatValue?: (value: T) => string;
};

function logInspectEntryDescriptors(descriptors: InspectEntryDescriptor<unknown>[]): void {
  for (const descriptor of descriptors) {
    logInspectEntries(descriptor.prefix, descriptor.entries, descriptor.shouldLog, descriptor.formatValue);
  }
}

function inspectEntryDescriptors(paneStatus: TeamPaneStatus): InspectEntryDescriptor<unknown>[] {
  const isPresentString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const isNumber = (value: unknown): value is number => typeof value === 'number';
  const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
  const hasItems = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0;
  const joinSpace = (value: unknown): string => Array.isArray(value) ? value.join(' ') : String(value);

  return [
    { prefix: 'inspect_reason', entries: paneStatus.recommended_inspect_reasons, shouldLog: isPresentString },
    { prefix: 'inspect_cli', entries: paneStatus.recommended_inspect_clis, shouldLog: isPresentString },
    { prefix: 'inspect_role', entries: paneStatus.recommended_inspect_roles, shouldLog: isPresentString },
    { prefix: 'inspect_index', entries: paneStatus.recommended_inspect_indexes, shouldLog: isNumber },
    { prefix: 'inspect_alive', entries: paneStatus.recommended_inspect_alive, shouldLog: isBoolean },
    { prefix: 'inspect_turn_count', entries: paneStatus.recommended_inspect_turn_counts, shouldLog: isNumber },
    { prefix: 'inspect_turns_without_progress', entries: paneStatus.recommended_inspect_turns_without_progress, shouldLog: isNumber },
    { prefix: 'inspect_last_turn_at', entries: paneStatus.recommended_inspect_last_turn_at, shouldLog: isPresentString },
    { prefix: 'inspect_status_updated_at', entries: paneStatus.recommended_inspect_status_updated_at, shouldLog: isPresentString },
    { prefix: 'inspect_pid', entries: paneStatus.recommended_inspect_pids, shouldLog: isNumber },
    { prefix: 'inspect_worktree_path', entries: paneStatus.recommended_inspect_worktree_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worktree_repo_root', entries: paneStatus.recommended_inspect_worktree_repo_roots, shouldLog: isPresentString },
    { prefix: 'inspect_worktree_branch', entries: paneStatus.recommended_inspect_worktree_branches, shouldLog: isPresentString },
    { prefix: 'inspect_worktree_detached', entries: paneStatus.recommended_inspect_worktree_detached, shouldLog: isBoolean },
    { prefix: 'inspect_worktree_created', entries: paneStatus.recommended_inspect_worktree_created, shouldLog: isBoolean },
    { prefix: 'inspect_team_state_root', entries: paneStatus.recommended_inspect_team_state_roots, shouldLog: isPresentString },
    { prefix: 'inspect_workdir', entries: paneStatus.recommended_inspect_workdirs, shouldLog: isPresentString },
    { prefix: 'inspect_assigned_tasks', entries: paneStatus.recommended_inspect_assigned_tasks, shouldLog: hasItems, formatValue: joinSpace },
    { prefix: 'inspect_task_status', entries: paneStatus.recommended_inspect_task_statuses, shouldLog: isPresentString },
    { prefix: 'inspect_task_result', entries: paneStatus.recommended_inspect_task_results, shouldLog: isPresentString },
    { prefix: 'inspect_task_error', entries: paneStatus.recommended_inspect_task_errors, shouldLog: isPresentString },
    { prefix: 'inspect_task_version', entries: paneStatus.recommended_inspect_task_versions, shouldLog: isNumber },
    { prefix: 'inspect_task_created_at', entries: paneStatus.recommended_inspect_task_created_at, shouldLog: isPresentString },
    { prefix: 'inspect_task_completed_at', entries: paneStatus.recommended_inspect_task_completed_at, shouldLog: isPresentString },
    { prefix: 'inspect_task_depends_on', entries: paneStatus.recommended_inspect_task_depends_on, shouldLog: hasItems, formatValue: joinSpace },
    { prefix: 'inspect_task_claim_present', entries: paneStatus.recommended_inspect_task_claim_present, shouldLog: isBoolean },
    { prefix: 'inspect_task_claim_owner', entries: paneStatus.recommended_inspect_task_claim_owners, shouldLog: isPresentString },
    { prefix: 'inspect_task_claim_token', entries: paneStatus.recommended_inspect_task_claim_tokens, shouldLog: isPresentString },
    { prefix: 'inspect_task_claim_leased_until', entries: paneStatus.recommended_inspect_task_claim_leases, shouldLog: isPresentString },
    { prefix: 'inspect_task_claim_lock_path', entries: paneStatus.recommended_inspect_task_claim_lock_paths, shouldLog: isPresentString },
    { prefix: 'inspect_approval_required', entries: paneStatus.recommended_inspect_approval_required, shouldLog: isBoolean },
    { prefix: 'inspect_requires_code_change', entries: paneStatus.recommended_inspect_requires_code_change, shouldLog: isBoolean },
    { prefix: 'inspect_description', entries: paneStatus.recommended_inspect_descriptions, shouldLog: isPresentString },
    { prefix: 'inspect_blocked_by', entries: paneStatus.recommended_inspect_blocked_by, shouldLog: hasItems, formatValue: joinSpace },
    { prefix: 'inspect_task_role', entries: paneStatus.recommended_inspect_task_roles, shouldLog: isPresentString },
    { prefix: 'inspect_task_owner', entries: paneStatus.recommended_inspect_task_owners, shouldLog: isPresentString },
    { prefix: 'inspect_approval_status', entries: paneStatus.recommended_inspect_approval_statuses, shouldLog: isPresentString },
    { prefix: 'inspect_approval_reviewer', entries: paneStatus.recommended_inspect_approval_reviewers, shouldLog: isPresentString },
    { prefix: 'inspect_approval_reason', entries: paneStatus.recommended_inspect_approval_reasons, shouldLog: isPresentString },
    { prefix: 'inspect_approval_decided_at', entries: paneStatus.recommended_inspect_approval_decided_at, shouldLog: isPresentString },
    { prefix: 'inspect_approval_record_present', entries: paneStatus.recommended_inspect_approval_record_present, shouldLog: isBoolean },
    { prefix: 'inspect_state', entries: paneStatus.recommended_inspect_states, shouldLog: isPresentString },
    { prefix: 'inspect_state_reason', entries: paneStatus.recommended_inspect_state_reasons, shouldLog: isPresentString },
    { prefix: 'inspect_task', entries: paneStatus.recommended_inspect_tasks, shouldLog: isPresentString },
    { prefix: 'inspect_subject', entries: paneStatus.recommended_inspect_subjects, shouldLog: isPresentString },
    { prefix: 'inspect_task_path', entries: paneStatus.recommended_inspect_task_paths, shouldLog: isPresentString },
    { prefix: 'inspect_approval_path', entries: paneStatus.recommended_inspect_approval_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_state_dir', entries: paneStatus.recommended_inspect_worker_state_dirs, shouldLog: isPresentString },
    { prefix: 'inspect_worker_status_path', entries: paneStatus.recommended_inspect_worker_status_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_heartbeat_path', entries: paneStatus.recommended_inspect_worker_heartbeat_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_identity_path', entries: paneStatus.recommended_inspect_worker_identity_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_inbox_path', entries: paneStatus.recommended_inspect_worker_inbox_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_mailbox_path', entries: paneStatus.recommended_inspect_worker_mailbox_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_shutdown_request_path', entries: paneStatus.recommended_inspect_worker_shutdown_request_paths, shouldLog: isPresentString },
    { prefix: 'inspect_worker_shutdown_ack_path', entries: paneStatus.recommended_inspect_worker_shutdown_ack_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_dir_path', entries: paneStatus.recommended_inspect_team_dir_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_config_path', entries: paneStatus.recommended_inspect_team_config_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_manifest_path', entries: paneStatus.recommended_inspect_team_manifest_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_events_path', entries: paneStatus.recommended_inspect_team_events_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_dispatch_path', entries: paneStatus.recommended_inspect_team_dispatch_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_phase_path', entries: paneStatus.recommended_inspect_team_phase_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_monitor_snapshot_path', entries: paneStatus.recommended_inspect_team_monitor_snapshot_paths, shouldLog: isPresentString },
    { prefix: 'inspect_team_summary_snapshot_path', entries: paneStatus.recommended_inspect_team_summary_snapshot_paths, shouldLog: isPresentString },
    { prefix: 'inspect_pane', entries: paneStatus.recommended_inspect_panes, shouldLog: isPresentString },
  ];
}

function formatInspectItemLine(index: number, item: TeamInspectItem, modelInspect = false, tailLines = DEFAULT_SPARKSHELL_TAIL_LINES): string {
  const command = modelInspect ? item.command : rawTmuxCaptureCommand(item.pane_id, tailLines);
  const parts = [
    `inspect_item_${index + 1}:`,
    `target=${item.target}`,
    item.pane_id ? `pane=${item.pane_id}` : '',
    item.worker_cli ? `cli=${item.worker_cli}` : '',
    item.role ? `role=${item.role}` : '',
    typeof item.index === 'number' ? `index=${item.index}` : '',
    typeof item.alive === 'boolean' ? `alive=${item.alive}` : '',
    typeof item.turn_count === 'number' ? `turn_count=${item.turn_count}` : '',
    typeof item.turns_without_progress === 'number' ? `turns_without_progress=${item.turns_without_progress}` : '',
    item.last_turn_at ? `last_turn_at=${item.last_turn_at}` : '',
    item.status_updated_at ? `status_updated_at=${item.status_updated_at}` : '',
    typeof item.pid === 'number' ? `pid=${item.pid}` : '',
    item.worktree_repo_root ? `worktree_repo_root=${item.worktree_repo_root}` : '',
    item.worktree_path ? `worktree_path=${item.worktree_path}` : '',
    item.worktree_branch ? `worktree_branch=${item.worktree_branch}` : '',
    typeof item.worktree_detached === 'boolean' ? `worktree_detached=${item.worktree_detached}` : '',
    typeof item.worktree_created === 'boolean' ? `worktree_created=${item.worktree_created}` : '',
    item.team_state_root ? `team_state_root=${item.team_state_root}` : '',
    item.working_dir ? `workdir=${item.working_dir}` : '',
    item.assigned_tasks.length > 0 ? `assigned_tasks=${item.assigned_tasks.join(',')}` : '',
    item.task_status ? `task_status=${item.task_status}` : '',
    item.task_result ? `task_result=${item.task_result}` : '',
    item.task_error ? `task_error=${item.task_error}` : '',
    typeof item.task_version === 'number' ? `task_version=${item.task_version}` : '',
    item.task_created_at ? `task_created_at=${item.task_created_at}` : '',
    item.task_completed_at ? `task_completed_at=${item.task_completed_at}` : '',
    item.task_depends_on.length > 0 ? `task_depends_on=${item.task_depends_on.join(',')}` : '',
    typeof item.task_claim_present === 'boolean' ? `task_claim_present=${item.task_claim_present}` : '',
    item.task_claim_owner ? `task_claim_owner=${item.task_claim_owner}` : '',
    item.task_claim_token ? `task_claim_token=${item.task_claim_token}` : '',
    item.task_claim_leased_until ? `task_claim_leased_until=${item.task_claim_leased_until}` : '',
    item.task_claim_lock_path ? `task_claim_lock_path=${item.task_claim_lock_path}` : '',
    typeof item.approval_required === 'boolean' ? `approval_required=${item.approval_required}` : '',
    typeof item.requires_code_change === 'boolean' ? `requires_code_change=${item.requires_code_change}` : '',
    item.task_description ? `description=${item.task_description}` : '',
    item.blocked_by.length > 0 ? `blocked_by=${item.blocked_by.join(',')}` : '',
    item.task_role ? `task_role=${item.task_role}` : '',
    item.task_owner ? `task_owner=${item.task_owner}` : '',
    item.approval_status ? `approval_status=${item.approval_status}` : '',
    item.approval_reviewer ? `approval_reviewer=${item.approval_reviewer}` : '',
    item.approval_reason ? `approval_reason=${item.approval_reason}` : '',
    item.approval_decided_at ? `approval_decided_at=${item.approval_decided_at}` : '',
    typeof item.approval_record_present === 'boolean' ? `approval_record_present=${item.approval_record_present}` : '',
    item.state_reason ? `state_reason=${item.state_reason}` : '',
    item.task_id ? `task=${item.task_id}` : '',
    item.task_subject ? `subject=${item.task_subject}` : '',
    item.task_path ? `task_path=${item.task_path}` : '',
    item.approval_path ? `approval_path=${item.approval_path}` : '',
    item.worker_state_dir ? `worker_state_dir=${item.worker_state_dir}` : '',
    item.worker_status_path ? `worker_status_path=${item.worker_status_path}` : '',
    item.worker_heartbeat_path ? `worker_heartbeat_path=${item.worker_heartbeat_path}` : '',
    item.worker_identity_path ? `worker_identity_path=${item.worker_identity_path}` : '',
    item.worker_inbox_path ? `worker_inbox_path=${item.worker_inbox_path}` : '',
    item.worker_mailbox_path ? `worker_mailbox_path=${item.worker_mailbox_path}` : '',
    item.worker_shutdown_request_path ? `worker_shutdown_request_path=${item.worker_shutdown_request_path}` : '',
    item.worker_shutdown_ack_path ? `worker_shutdown_ack_path=${item.worker_shutdown_ack_path}` : '',
    item.team_dir_path ? `team_dir_path=${item.team_dir_path}` : '',
    item.team_config_path ? `team_config_path=${item.team_config_path}` : '',
    item.team_manifest_path ? `team_manifest_path=${item.team_manifest_path}` : '',
    item.team_events_path ? `team_events_path=${item.team_events_path}` : '',
    item.team_dispatch_path ? `team_dispatch_path=${item.team_dispatch_path}` : '',
    item.team_phase_path ? `team_phase_path=${item.team_phase_path}` : '',
    item.team_monitor_snapshot_path ? `team_monitor_snapshot_path=${item.team_monitor_snapshot_path}` : '',
    item.team_summary_snapshot_path ? `team_summary_snapshot_path=${item.team_summary_snapshot_path}` : '',
    `reason=${item.reason}`,
    item.state ? `state=${item.state}` : '',
    `command=${command}`,
  ];
  return parts.filter(Boolean).join(' ');
}

function renderInspectSummary(summary: string, command: string | null): string {
  if (!command) return summary;
  if (/(^| )command=/.test(summary)) {
    return summary.replace(/(^| )command=.*$/, `$1command=${command}`);
  }
  return `${summary} command=${command}`;
}

function renderTeamPaneStatus(
  paneStatus: TeamPaneStatus,
  modelInspect = false,
  tailLines = DEFAULT_SPARKSHELL_TAIL_LINES,
): void {
  if (paneStatus.leader_pane_id || paneStatus.hud_pane_id) {
    console.log(`panes: leader=${paneStatus.leader_pane_id || '-'} hud=${paneStatus.hud_pane_id || '-'}`);
  }

  const workerPanePairs = Object.entries(paneStatus.worker_panes).map(([workerName, paneId]) => `${workerName}=${paneId}`);
  if (workerPanePairs.length > 0) {
    console.log(`worker_panes: ${workerPanePairs.join(' ')}`);
  }

  if (paneStatus.sparkshell_hint) {
    console.log('inspect_hint: raw tmux capture commands are quota-free; rerun status with --model-inspect for omx sparkshell summaries');
  }

  if (paneStatus.recommended_inspect_targets.length > 0) {
    console.log(`recommended_inspect_targets: ${paneStatus.recommended_inspect_targets.join(' ')}`);
  }

  logInspectEntryDescriptors(inspectEntryDescriptors(paneStatus));

  if (paneStatus.recommended_inspect_command) {
    const inspectCommand = modelInspect
      ? paneStatus.recommended_inspect_command
      : rawTmuxCaptureCommand(paneStatus.recommended_inspect_items[0]?.pane_id ?? '', tailLines);
    if (inspectCommand.trim().length > 0) console.log(`inspect_next: ${inspectCommand}`);
  }
  if (paneStatus.recommended_inspect_summary) {
    const summaryCommand = paneStatus.recommended_inspect_command
      ? modelInspect
        ? paneStatus.recommended_inspect_command
        : rawTmuxCaptureCommand(paneStatus.recommended_inspect_items[0]?.pane_id ?? '', tailLines)
      : null;
    const summary = renderInspectSummary(paneStatus.recommended_inspect_summary, summaryCommand);
    console.log(`inspect_summary: ${summary}`);
  }
  for (const [index, item] of paneStatus.recommended_inspect_items.entries()) {
    const command = modelInspect ? item.command : rawTmuxCaptureCommand(item.pane_id, tailLines);
    console.log(`inspect_priority_${index + 1}: ${command}`);
  }
  for (const [index, item] of paneStatus.recommended_inspect_items.entries()) {
    console.log(formatInspectItemLine(index, item, modelInspect, tailLines));
  }

  for (const [target, paneId] of Object.entries({
    ...(paneStatus.leader_pane_id ? { leader: paneStatus.leader_pane_id } : {}),
    ...(paneStatus.hud_pane_id ? { hud: paneStatus.hud_pane_id } : {}),
    ...paneStatus.worker_panes,
  })) {
    const modelCommand = paneStatus.sparkshell_commands[target];
    const command = modelInspect && modelCommand ? modelCommand : rawTmuxCaptureCommand(paneId, tailLines);
    console.log(`inspect_${target}: ${command}`);
  }
}

export function parseTeamArgs(args: string[], cwd: string = process.cwd()): ParsedTeamArgs {
  const tokens = [...args];
  let workerCount = 3;
  let agentType = 'executor';
  let explicitAgentType = false;
  let explicitWorkerCount = false;

  if (tokens[0]?.toLowerCase() === 'ralph') {
    throw new Error('Deprecated usage: `omx team ralph ...` has been removed. Use `omx team ...` or run `omx ralph ...` separately.');
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
    throw new Error('Usage: omx team [N:agent-type] "<task description>"');
  }

  const followupContext = resolveApprovedTeamFollowupContext(cwd, task);
  const effectiveTask = followupContext?.task ?? task;
  if (followupContext) {
    if (!explicitWorkerCount) {
      workerCount = followupContext.workerCount;
      explicitWorkerCount = followupContext.explicitWorkerCount;
    }
    if (!explicitAgentType && followupContext.agentType) {
      agentType = followupContext.agentType;
      explicitAgentType = followupContext.explicitAgentType === true;
    }
  }

  const approvedHint = followupContext?.approvedHint
    ?? readApprovedExecutionLaunchHint(cwd, 'team', { task: effectiveTask });
  const matchesApprovedLaunchHint = approvedHint?.task.trim() === effectiveTask.trim()
    && (approvedHint.workerCount == null || approvedHint.workerCount === workerCount)
    && (approvedHint.agentType == null || approvedHint.agentType === agentType);
  const allowRepoAwareDagHandoff = followupContext != null || matchesApprovedLaunchHint;
  const approvedRepositoryContextSummary = allowRepoAwareDagHandoff
    ? approvedHint?.repositoryContextSummary
    : undefined;

  const teamName = sanitizeTeamName(slugifyTask(effectiveTask));
  return {
    workerCount,
    agentType,
    explicitAgentType,
    explicitWorkerCount,
    task: effectiveTask,
    teamName,
    displayName: teamName,
    allowRepoAwareDagHandoff,
    ...(approvedRepositoryContextSummary ? { approvedRepositoryContextSummary } : {}),
    ...(allowRepoAwareDagHandoff && approvedHint ? { approvedExecution: buildApprovedTeamExecutionBinding(approvedHint) } : {}),
  };
}


export function parseTeamStartArgs(args: string[]): ParsedTeamStartArgs {
  const parsedWorktree = parseWorktreeMode(args);
  return {
    parsed: parseTeamArgs(parsedWorktree.remainingArgs),
    worktreeMode: resolveDefaultTeamWorktreeMode(parsedWorktree.mode),
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
  const currentPhase = parsed.teamName
    ? (await readTeamPhase(parsed.teamName, process.cwd()))?.current_phase ?? 'team-exec'
    : 'team-exec';
  const active = !isTerminalModePhase(currentPhase);
  const completionStamp = active ? undefined : new Date().toISOString();

  const existing = await readModeState('team');
  if (existing?.active) {
    await updateModeState('team', {
      active,
      task_description: parsed.task,
      current_phase: currentPhase,
      team_name: parsed.teamName,
      display_name: parsed.displayName ?? parsed.teamName,
      agent_count: parsed.workerCount,
      agent_types: roleDistribution,
      available_agent_types: availableAgentTypes,
      staffing_summary: staffingPlan.staffingSummary,
      staffing_allocations: staffingPlan.allocations,
      completed_at: completionStamp,
    });
    return;
  }

  await startMode('team', parsed.task, 50);
  await updateModeState('team', {
    active,
    current_phase: currentPhase,
    team_name: parsed.teamName,
    display_name: parsed.displayName ?? parsed.teamName,
    agent_count: parsed.workerCount,
    agent_types: roleDistribution,
    available_agent_types: availableAgentTypes,
    staffing_summary: staffingPlan.staffingSummary,
    staffing_allocations: staffingPlan.allocations,
    completed_at: completionStamp,
  });

}

async function persistTeamShutdownModeState(
  teamName: string,
  cwd: string,
  configSnapshot?: {
    task: string;
    workerCount: number;
    agentType: string;
  } | null,
): Promise<void> {
  const sessionStatePath = join(cwd, '.omx', 'state', 'session.json');
  let scopedSessionId: string | undefined;
  if (existsSync(sessionStatePath)) {
    try {
      const parsed = JSON.parse(readFileSync(sessionStatePath, 'utf-8')) as { session_id?: unknown };
      scopedSessionId = validateSessionId(parsed.session_id);
    } catch {
      // Best-effort shutdown state sync only.
    }
  }

  const shutdownState: Record<string, unknown> = {
    active: false,
    current_phase: 'cancelled',
    completed_at: new Date().toISOString(),
    team_name: teamName,
    ...(configSnapshot
      ? {
        task_description: configSnapshot.task,
        agent_count: configSnapshot.workerCount,
        agent_types: configSnapshot.agentType,
      }
      : {}),
  };

  const rootStatePath = getStatePath('team', cwd);
  const hasRootState = existsSync(rootStatePath);
  const hasScopedState = scopedSessionId
    ? existsSync(getStatePath('team', cwd, scopedSessionId))
    : false;

  if (hasRootState || hasScopedState) {
    if (hasRootState) {
      persistExactTeamModeState(cwd, shutdownState);
    }
    if (scopedSessionId && hasScopedState) {
      persistExactTeamModeState(cwd, shutdownState, scopedSessionId);
    }
    return;
  }

  const existing = await readModeState('team', cwd);
  if (!existing) {
    if (configSnapshot) {
      await ensureTeamModeState({
        task: configSnapshot.task,
        workerCount: configSnapshot.workerCount,
        agentType: configSnapshot.agentType,
        explicitAgentType: false,
        explicitWorkerCount: false,
        teamName,
        allowRepoAwareDagHandoff: false,
      });
    } else {
      await startMode('team', `shutdown team ${teamName}`, 50, cwd);
    }
  }

  await updateModeState('team', shutdownState, cwd);
}


async function renderStartSummary(runtime: TeamRuntime, staffingPlan?: FollowupStaffingPlan): Promise<void> {
  console.log(`Team started: ${runtime.teamName}`);
  console.log(`tmux target: ${runtime.sessionName}`);
  console.log(`workers: ${runtime.config.worker_count}`);
  console.log(`agent_type: ${runtime.config.agent_type}`);
  if (runtime.config.workspace_mode) {
    console.log(`workspace_mode: ${runtime.config.workspace_mode}`);
  }
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

export function buildLeaderMonitoringHints(teamName: string): string[] {
  const sanitized = sanitizeTeamName(teamName);
  return [
    `leader_check: omx team status ${sanitized}`,
    `leader_loop_hint: while ON, keep checking state (example: sleep 30 && omx team status ${sanitized})`,
  ];
}

export async function teamCommand(args: string[], _options: TeamCliOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const codexHomeOverride = resolveCodexHomeForLaunch(cwd, process.env);
  const parsedWorktree = parseWorktreeMode(args);
  const worktreeMode = resolveDefaultTeamWorktreeMode(parsedWorktree.mode);
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
    const resolvedName = resolveTeamNameForCurrentContext(name, cwd);
    await recordLeaderRuntimeActivity(cwd, 'team_status', resolvedName);
    const snapshot = await monitorTeam(resolvedName, cwd);
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
    const modelInspect = parseStatusModelInspect(teamArgs.slice(2));
    const config = await readTeamConfig(resolvedName, cwd);
    const paneStatus = await readTeamPaneStatus(config, cwd, snapshot, tailLines);
    if (wantsJson) {
      console.log(JSON.stringify({
        ...buildJsonBase(),
        command: 'omx team status',
        team_name: snapshot.teamName,
        status: 'ok',
        tail_lines: tailLines,
        phase: snapshot.phase,
        workspace_mode: config?.workspace_mode ?? null,
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
    if (config?.workspace_mode) {
      console.log(`workspace_mode: ${config.workspace_mode}`);
    }
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
    renderTeamPaneStatus(paneStatus, modelInspect, tailLines);
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
    const resolvedName = resolveTeamNameForCurrentContext(name, cwd);
    const config = await readTeamConfig(resolvedName, cwd);
    if (!config) {
      if (wantsJson) {
        console.log(JSON.stringify({ team_name: name, status: 'missing', cursor: afterEventId || '', event: null }));
      } else {
        console.log(`No team state found for ${name}`);
      }
      return;
    }

    const baselineCursor = afterEventId || (await readTeamEvents(resolvedName, cwd, { wakeableOnly: true }).then((events) => events.at(-1)?.event_id ?? ''));
    const snapshot = await monitorTeam(resolvedName, cwd);
    const immediateEvent = await readTeamEvents(resolvedName, cwd, {
      afterEventId: baselineCursor || undefined,
      wakeableOnly: true,
    }).then((events) => events[0]);

    const result =
      immediateEvent
        ? { status: 'event' as const, cursor: immediateEvent.event_id, event: immediateEvent }
        : snapshot && snapshotHasDeadWorkerStall(snapshot)
          ? await readTeamEvents(resolvedName, cwd, { wakeableOnly: true }).then((events) => {
            const latestWakeableEvent = events.at(-1);
            if (latestWakeableEvent) {
              return {
                status: 'event' as const,
                cursor: latestWakeableEvent.event_id,
                event: latestWakeableEvent,
              };
            }
            const fallbackEvent = buildDeadWorkerAwaitEvent(resolvedName, snapshot);
            return fallbackEvent
              ? { status: 'event' as const, cursor: baselineCursor, event: fallbackEvent }
              : { status: 'timeout' as const, cursor: baselineCursor };
          })
          : await waitForTeamEvent(resolvedName, cwd, {
            afterEventId: baselineCursor || undefined,
            timeoutMs,
            pollMs: 100,
            wakeableOnly: true,
          });

    if (wantsJson) {
      console.log(JSON.stringify({
        team_name: resolvedName,
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
      `team=${resolvedName}`,
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
    await ensureTeamModeState({
      task: runtime.config.task,
      workerCount: runtime.config.worker_count,
      agentType: runtime.config.agent_type,
      explicitAgentType: false,
      explicitWorkerCount: false,
      teamName: runtime.teamName,
      displayName: runtime.config.display_name ?? runtime.teamName,
      allowRepoAwareDagHandoff: false,
    });
    const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
    const staffingPlan = buildFollowupStaffingPlan('team', runtime.config.task, availableAgentTypes, {
      workerCount: runtime.config.worker_count,
      fallbackRole: resolveImplicitTeamFallbackRole(runtime.config.agent_type, false),
      codexHomeOverride,
    });
    await renderStartSummary(runtime, staffingPlan);
    return;
  }

  if (subcommand === 'shutdown') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team shutdown <team-name> [--force] [--confirm-issues]');
    const force = teamArgs.includes('--force');
    const confirmIssues = teamArgs.includes('--confirm-issues');
    const resolvedName = resolveTeamNameForCurrentContext(name, cwd);
    const configBeforeShutdown = await readTeamConfig(resolvedName, cwd);
    const summary = await shutdownTeam(resolvedName, cwd, { force, confirmIssues });
    await persistTeamShutdownModeState(
      resolvedName,
      cwd,
      configBeforeShutdown
        ? {
          task: configBeforeShutdown.task,
          workerCount: configBeforeShutdown.worker_count,
          agentType: configBeforeShutdown.agent_type,
        }
        : null,
    ).catch((error: unknown) => {
      console.warn('[omx] warning: failed to persist team mode shutdown state', {
        team: name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    console.log(`Team shutdown complete: ${name}`);
    if (summary.commitHygieneArtifacts) {
      console.log(`commit_hygiene_context_json: ${summary.commitHygieneArtifacts.jsonPath}`);
      console.log(`commit_hygiene_context_md: ${summary.commitHygieneArtifacts.markdownPath}`);
    }
    return;
  }

  const parsed = parseTeamArgs(teamArgs, cwd);
  const executionPlan = buildRepoAwareTeamExecutionPlan({
    task: parsed.task,
    workerCount: parsed.workerCount,
    agentType: parsed.agentType,
    explicitAgentType: parsed.explicitAgentType,
    explicitWorkerCount: parsed.explicitWorkerCount,
    cwd,
    buildLegacyPlan: buildTeamExecutionPlan,
    allowDagHandoff: parsed.allowRepoAwareDagHandoff,
    approvedRepositoryContextSummary: parsed.approvedRepositoryContextSummary,
  });
  const tasks = executionPlan.tasks;
  const effectiveParsed = executionPlan.workerCount === parsed.workerCount
    ? parsed
    : { ...parsed, workerCount: executionPlan.workerCount };
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('team', parsed.task, availableAgentTypes, {
    workerCount: executionPlan.workerCount,
    fallbackRole: resolveImplicitTeamFallbackRole(parsed.agentType, parsed.explicitAgentType),
    codexHomeOverride,
  });
  const runtime = await startTeam(
    parsed.teamName,
    parsed.task,
    parsed.agentType,
    executionPlan.workerCount,
    tasks,
    cwd,
    {
      codexHomeOverride,
      worktreeMode,
      decompositionMetadata: executionPlan.metadata,
      approvedExecution: parsed.approvedExecution ?? null,
    },
  );

  await ensureTeamModeState({ ...effectiveParsed, teamName: runtime.teamName, displayName: runtime.config.display_name ?? effectiveParsed.displayName }, tasks);
  await renderStartSummary(runtime, staffingPlan);
}
