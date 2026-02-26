/**
 * OMX State Management MCP Server
 * Provides state read/write/clear/list tools for workflow modes
 * Storage: .omx/state/{mode}-state.json
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, readdir, mkdir, unlink, rename } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import {
  getAllScopedStatePaths,
  getReadScopedStateDirs,
  getReadScopedStatePaths,
  resolveStateScope,
  getStateDir,
  getStatePath,
  resolveWorkingDirectoryForState,
  validateSessionId,
} from './state-paths.js';
import { withModeRuntimeContext } from '../state/mode-state-context.js';
import { ensureTmuxHookInitialized } from '../cli/tmux-hook.js';
import { RALPH_PHASES, validateAndNormalizeRalphState } from '../ralph/contract.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';
import { shouldAutoStartMcpServer } from './bootstrap.js';
import {
  TEAM_NAME_SAFE_PATTERN,
  WORKER_NAME_SAFE_PATTERN,
  TASK_ID_SAFE_PATTERN,
  TEAM_TASK_STATUSES,
  TEAM_EVENT_TYPES,
  TEAM_TASK_APPROVAL_STATUSES,
  type TeamTaskStatus,
  type TeamEventType,
  type TeamTaskApprovalStatus,
} from '../team/contracts.js';
import {
  teamSendMessage as sendDirectMessage,
  teamBroadcast as broadcastMessage,
  teamListMailbox as listMailboxMessages,
  teamMarkMessageDelivered as markMessageDelivered,
  teamMarkMessageNotified as markMessageNotified,
  teamCreateTask,
  teamReadTask,
  teamListTasks,
  teamUpdateTask,
  teamClaimTask,
  teamTransitionTaskStatus,
  teamReleaseTaskClaim,
  teamReadConfig,
  teamReadManifest,
  teamReadWorkerStatus,
  teamReadWorkerHeartbeat,
  teamUpdateWorkerHeartbeat,
  teamWriteWorkerInbox,
  teamWriteWorkerIdentity,
  teamAppendEvent,
  teamGetSummary,
  teamCleanup,
  teamWriteShutdownRequest,
  teamReadShutdownAck,
  teamReadMonitorSnapshot,
  teamWriteMonitorSnapshot,
  teamReadTaskApproval,
  teamWriteTaskApproval,
  type TeamMonitorSnapshotState,
} from '../team/team-ops.js';

const SUPPORTED_MODES = [
  'autopilot', 'ultrapilot', 'team', 'pipeline',
  'ralph', 'ultrawork', 'ultraqa', 'ecomode', 'ralplan',
] as const;

const STATE_TOOL_NAMES = new Set([
  'state_read',
  'state_write',
  'state_clear',
  'state_list_active',
  'state_get_status',
]);
const TEAM_COMM_TOOL_NAMES = new Set([
  'team_send_message',
  'team_broadcast',
  'team_mailbox_list',
  'team_mailbox_mark_delivered',
  'team_mailbox_mark_notified',
  'team_create_task',
  'team_read_task',
  'team_list_tasks',
  'team_update_task',
  'team_claim_task',
  'team_transition_task_status',
  'team_release_task_claim',
  'team_read_config',
  'team_read_manifest',
  'team_read_worker_status',
  'team_read_worker_heartbeat',
  'team_update_worker_heartbeat',
  'team_write_worker_inbox',
  'team_write_worker_identity',
  'team_append_event',
  'team_get_summary',
  'team_cleanup',
  'team_write_shutdown_request',
  'team_read_shutdown_ack',
  'team_read_monitor_snapshot',
  'team_write_monitor_snapshot',
  'team_read_task_approval',
  'team_write_task_approval',
]);

const TEAM_UPDATE_TASK_MUTABLE_FIELDS = new Set(['subject', 'description', 'blocked_by', 'requires_code_change']);
const TEAM_UPDATE_TASK_REQUEST_FIELDS = new Set(['team_name', 'task_id', 'workingDirectory', ...TEAM_UPDATE_TASK_MUTABLE_FIELDS]);
const stateWriteQueues = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = stateWriteQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = tail.finally(() => gate);
  stateWriteQueues.set(path, queued);

  await tail.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateWriteQueues.get(path) === queued) {
      stateWriteQueues.delete(path);
    }
  }
}

async function writeAtomicFile(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, data, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

function parseValidatedTaskIdArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of task IDs (strings)`);
  }
  const taskIds: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName} entries must be strings`);
    }
    const normalized = item.trim();
    if (!TASK_ID_SAFE_PATTERN.test(normalized)) {
      throw new Error(`${fieldName} contains invalid task ID: "${item}"`);
    }
    taskIds.push(normalized);
  }
  return taskIds;
}

function teamStateExists(teamName: string, candidateCwd: string): boolean {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) return false;
  const teamRoot = join(candidateCwd, '.omx', 'state', 'team', teamName);
  return (
    existsSync(join(teamRoot, 'config.json')) ||
    existsSync(join(teamRoot, 'tasks')) ||
    existsSync(teamRoot)
  );
}

function parseTeamWorkerEnv(raw: string | undefined): { teamName: string; workerName: string } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(raw.trim());
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}

function readTeamStateRootFromFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { team_state_root?: unknown };
    return typeof parsed.team_state_root === 'string' && parsed.team_state_root.trim() !== ''
      ? parsed.team_state_root.trim()
      : null;
  } catch {
    return null;
  }
}

function stateRootToWorkingDirectory(stateRoot: string): string {
  const absolute = resolvePath(stateRoot);
  return dirname(dirname(absolute));
}

function resolveTeamWorkingDirectoryFromMetadata(
  teamName: string,
  candidateCwd: string,
  workerContext: { teamName: string; workerName: string } | null,
): string | null {
  const teamRoot = join(candidateCwd, '.omx', 'state', 'team', teamName);
  if (!existsSync(teamRoot)) return null;

  if (workerContext?.teamName === teamName) {
    const workerRoot = readTeamStateRootFromFile(join(teamRoot, 'workers', workerContext.workerName, 'identity.json'));
    if (workerRoot) return stateRootToWorkingDirectory(workerRoot);
  }

  const fromManifest = readTeamStateRootFromFile(join(teamRoot, 'manifest.v2.json'));
  if (fromManifest) return stateRootToWorkingDirectory(fromManifest);

  const fromConfig = readTeamStateRootFromFile(join(teamRoot, 'config.json'));
  if (fromConfig) return stateRootToWorkingDirectory(fromConfig);

  return null;
}

function resolveTeamWorkingDirectory(teamName: string, preferredCwd: string): string {
  const normalizedTeamName = String(teamName || '').trim();
  if (!normalizedTeamName) return preferredCwd;
  const envTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  if (typeof envTeamStateRoot === 'string' && envTeamStateRoot.trim() !== '') {
    return stateRootToWorkingDirectory(envTeamStateRoot.trim());
  }

  const seeds: string[] = [];
  for (const seed of [preferredCwd, process.cwd()]) {
    if (typeof seed !== 'string' || seed.trim() === '') continue;
    if (!seeds.includes(seed)) seeds.push(seed);
  }

  const workerContext = parseTeamWorkerEnv(process.env.OMX_TEAM_WORKER);
  for (const seed of seeds) {
    let cursor = seed;
    while (cursor) {
      if (teamStateExists(normalizedTeamName, cursor)) {
        return resolveTeamWorkingDirectoryFromMetadata(normalizedTeamName, cursor, workerContext) ?? cursor;
      }
      const parent = dirname(cursor);
      if (!parent || parent === cursor) break;
      cursor = parent;
    }
  }
  return preferredCwd;
}

const server = new Server(
  { name: 'omx-state', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'state_read',
      description: 'Read state for a specific mode. Returns JSON state data or indicates no state exists.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES], description: 'The mode to read state for' },
          workingDirectory: { type: 'string', description: 'Working directory override' },
          session_id: { type: 'string', description: 'Optional session scope ID' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'state_write',
      description: 'Write/update state for a specific mode. Creates directories if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES] },
          active: { type: 'boolean' },
          iteration: { type: 'number' },
          max_iterations: { type: 'number' },
          current_phase: { type: 'string' },
          task_description: { type: 'string' },
          started_at: { type: 'string' },
          completed_at: { type: 'string' },
          error: { type: 'string' },
          state: { type: 'object', description: 'Additional custom fields' },
          workingDirectory: { type: 'string' },
          session_id: { type: 'string', description: 'Optional session scope ID' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'state_clear',
      description: 'Clear/delete state for a specific mode.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES] },
          workingDirectory: { type: 'string' },
          session_id: { type: 'string', description: 'Optional session scope ID' },
          all_sessions: { type: 'boolean', description: 'Clear matching mode in global and all session scopes' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'state_list_active',
      description: 'List all currently active modes.',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
          session_id: { type: 'string', description: 'Optional session scope ID' },
        },
      },
    },
    {
      name: 'state_get_status',
      description: 'Get detailed status for a specific mode or all modes.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES] },
          workingDirectory: { type: 'string' },
          session_id: { type: 'string', description: 'Optional session scope ID' },
        },
      },
    },
    {
      name: 'team_send_message',
      description: 'Send a direct team mailbox message from one worker to another worker/leader.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name (e.g., my-team)' },
          from_worker: { type: 'string', description: 'Sender worker id (e.g., worker-1)' },
          to_worker: { type: 'string', description: 'Recipient worker id (e.g., worker-2 or leader-fixed)' },
          body: { type: 'string', description: 'Message content' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'from_worker', 'to_worker', 'body'],
      },
    },
    {
      name: 'team_broadcast',
      description: 'Broadcast a message from one worker to all other workers in the team.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name (e.g., my-team)' },
          from_worker: { type: 'string', description: 'Sender worker id (e.g., worker-1)' },
          body: { type: 'string', description: 'Message content' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'from_worker', 'body'],
      },
    },
    {
      name: 'team_mailbox_list',
      description: 'List mailbox messages for a specific worker (including leader-fixed).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name (e.g., my-team)' },
          worker: { type: 'string', description: 'Mailbox owner worker id' },
          include_delivered: { type: 'boolean', description: 'Include delivered messages (default: true)' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker'],
      },
    },
    {
      name: 'team_mailbox_mark_delivered',
      description: 'Mark a mailbox message as delivered for a worker.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name (e.g., my-team)' },
          worker: { type: 'string', description: 'Mailbox owner worker id' },
          message_id: { type: 'string', description: 'Message ID to mark delivered' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker', 'message_id'],
      },
    },
    {
      name: 'team_mailbox_mark_notified',
      description: 'Mark a mailbox message as notified (tmux trigger sent) for a worker.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Mailbox owner worker id' },
          message_id: { type: 'string', description: 'Message ID to mark notified' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker', 'message_id'],
      },
    },
    {
      name: 'team_create_task',
      description: 'Create a new task in the team task list. Returns the created task with auto-incremented ID.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          subject: { type: 'string', description: 'Task subject/title' },
          description: { type: 'string', description: 'Task description' },
          owner: { type: 'string', description: 'Worker name to assign (optional)' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task depends on' },
          requires_code_change: { type: 'boolean', description: 'Whether the task involves code changes' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'subject', 'description'],
      },
    },
    {
      name: 'team_read_task',
      description: 'Read a single task by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID to read' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id'],
      },
    },
    {
      name: 'team_list_tasks',
      description: 'List all tasks in a team, sorted by numeric ID.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name'],
      },
    },
    {
      name: 'team_update_task',
      description: 'Update non-lifecycle task metadata (subject, description, blocked_by, requires_code_change). Status/owner/result/error are lifecycle fields that must be changed via team_claim_task + team_transition_task_status.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID to update' },
          subject: { type: 'string', description: 'Task subject/title' },
          description: { type: 'string', description: 'Task description' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task depends on' },
          requires_code_change: { type: 'boolean', description: 'Whether this task requires a code change' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id'],
      },
    },
    {
      name: 'team_claim_task',
      description: 'Atomically claim a task for a worker. Checks dependencies and version.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID to claim' },
          worker: { type: 'string', description: 'Worker name claiming the task' },
          expected_version: { type: 'number', description: 'Expected task version for optimistic locking. Omitting does not allow claiming an already in-progress task.' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id', 'worker'],
      },
    },
    {
      name: 'team_transition_task_status',
      description: 'Atomically transition task status with claim token validation.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID to transition' },
          from: { type: 'string', enum: [...TEAM_TASK_STATUSES] },
          to: { type: 'string', enum: [...TEAM_TASK_STATUSES] },
          claim_token: { type: 'string', description: 'Claim token from team_claim_task' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id', 'from', 'to', 'claim_token'],
      },
    },
    {
      name: 'team_release_task_claim',
      description: 'Release a task claim, returning task to pending status.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID' },
          claim_token: { type: 'string', description: 'Claim token from the claim operation' },
          worker: { type: 'string', description: 'Worker name that holds the claim' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id', 'claim_token', 'worker'],
      },
    },
    {
      name: 'team_read_config',
      description: 'Read team configuration (workers, tmux session, task counter).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name'],
      },
    },
    {
      name: 'team_read_manifest',
      description: 'Read team manifest v2 (leader, policy, permissions snapshot).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name'],
      },
    },
    {
      name: 'team_read_worker_status',
      description: 'Read current worker status (state, current_task_id, reason).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name (e.g., worker-1)' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker'],
      },
    },
    {
      name: 'team_read_worker_heartbeat',
      description: 'Read worker heartbeat (pid, turn count, alive flag).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker'],
      },
    },
    {
      name: 'team_update_worker_heartbeat',
      description: 'Write/update a worker heartbeat.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name' },
          pid: { type: 'number', description: 'Worker process ID' },
          turn_count: { type: 'number', description: 'Cumulative turn count' },
          alive: { type: 'boolean', description: 'Whether the worker is alive' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker', 'pid', 'turn_count', 'alive'],
      },
    },
    {
      name: 'team_write_worker_inbox',
      description: 'Write a prompt/instruction to a worker inbox file.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name' },
          content: { type: 'string', description: 'Inbox content (markdown)' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker', 'content'],
      },
    },
    {
      name: 'team_write_worker_identity',
      description: 'Write worker identity file (name, index, role, assigned tasks).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name' },
          index: { type: 'number', description: 'Worker index (1-based)' },
          role: { type: 'string', description: 'Agent role/type' },
          assigned_tasks: { type: 'array', items: { type: 'string' }, description: 'Assigned task IDs' },
          pid: { type: 'number', description: 'Worker process ID (optional)' },
          pane_id: { type: 'string', description: 'Tmux pane ID (optional)' },
          working_dir: { type: 'string', description: 'Worker working directory (optional)' },
          worktree_path: { type: 'string', description: 'Worker git worktree path (optional)' },
          worktree_branch: { type: 'string', description: 'Worker git worktree branch (optional)' },
          worktree_detached: { type: 'boolean', description: 'Whether worker worktree is detached (optional)' },
          team_state_root: { type: 'string', description: 'Canonical team state root path (optional)' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker', 'index', 'role'],
      },
    },
    {
      name: 'team_append_event',
      description: 'Append an event to the team event log (ndjson).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          type: { type: 'string', enum: [...TEAM_EVENT_TYPES] },
          worker: { type: 'string', description: 'Worker name associated with the event' },
          task_id: { type: 'string', description: 'Related task ID (optional)' },
          message_id: { type: 'string', description: 'Related message ID (optional)' },
          reason: { type: 'string', description: 'Event reason (optional)' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'type', 'worker'],
      },
    },
    {
      name: 'team_get_summary',
      description: 'Get team summary with task counts, worker status, and non-reporting detection.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name'],
      },
    },
    {
      name: 'team_cleanup',
      description: 'Delete all team state (config, tasks, workers, events).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name'],
      },
    },
    {
      name: 'team_write_shutdown_request',
      description: 'Write a shutdown request for a worker.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name to shut down' },
          requested_by: { type: 'string', description: 'Requester identity (e.g., leader-fixed)' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker', 'requested_by'],
      },
    },
    {
      name: 'team_read_shutdown_ack',
      description: 'Read a worker shutdown acknowledgment.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          worker: { type: 'string', description: 'Worker name' },
          min_updated_at: { type: 'string', description: 'ISO timestamp - ignore acks older than this' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'worker'],
      },
    },
    {
      name: 'team_read_monitor_snapshot',
      description: 'Read the monitor snapshot (task/worker state from last poll).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name'],
      },
    },
    {
      name: 'team_write_monitor_snapshot',
      description: 'Write the monitor snapshot for change detection across poll cycles.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          snapshot: { type: 'object', description: 'Monitor snapshot data' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'snapshot'],
      },
    },
    {
      name: 'team_read_task_approval',
      description: 'Read task approval record (for plan-approval-required policy).',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id'],
      },
    },
    {
      name: 'team_write_task_approval',
      description: 'Write a task approval decision.',
      inputSchema: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Sanitized team name' },
          task_id: { type: 'string', description: 'Task ID' },
          required: { type: 'boolean', description: 'Whether approval was required' },
          status: { type: 'string', enum: [...TEAM_TASK_APPROVAL_STATUSES] },
          reviewer: { type: 'string', description: 'Reviewer identity' },
          decision_reason: { type: 'string', description: 'Reason for the decision' },
          workingDirectory: { type: 'string' },
        },
        required: ['team_name', 'task_id', 'status', 'reviewer', 'decision_reason'],
      },
    },
  ],
}));

export async function handleStateToolCall(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) {
  const { name, arguments: args } = request.params;
  const wd = (args as Record<string, unknown>)?.workingDirectory as string | undefined;
  let normalizedWd: string;
  try {
    normalizedWd = resolveWorkingDirectoryForState(wd);
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true,
    };
  }
  let cwd = normalizedWd;
  let explicitSessionId: string | undefined;
  try {
    explicitSessionId = validateSessionId((args as Record<string, unknown>)?.session_id);
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true,
    };
  }

  try {
  const stateScope = STATE_TOOL_NAMES.has(name)
    ? await resolveStateScope(cwd, explicitSessionId)
    : undefined;
  const effectiveSessionId = stateScope?.sessionId;

  if (STATE_TOOL_NAMES.has(name)) {
    await mkdir(getStateDir(cwd), { recursive: true });
    if (effectiveSessionId) {
      await mkdir(getStateDir(cwd, effectiveSessionId), { recursive: true });
    }
    await ensureTmuxHookInitialized(cwd);
  }

  if (TEAM_COMM_TOOL_NAMES.has(name)) {
    const teamName = String((args as Record<string, unknown>)?.team_name || '').trim();
    if (teamName && !TEAM_NAME_SAFE_PATTERN.test(teamName)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Invalid team_name: "${teamName}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase alphanumeric + hyphens, max 30 chars).` }) }],
        isError: true,
      };
    }
    for (const workerField of ['worker', 'from_worker', 'to_worker']) {
      const workerVal = String((args as Record<string, unknown>)?.[workerField] || '').trim();
      if (workerVal && !WORKER_NAME_SAFE_PATTERN.test(workerVal)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Invalid ${workerField}: "${workerVal}". Must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase alphanumeric + hyphens, max 64 chars).` }) }],
          isError: true,
        };
      }
    }
    const rawTaskId = String((args as Record<string, unknown>)?.task_id || '').trim();
    if (rawTaskId && !TASK_ID_SAFE_PATTERN.test(rawTaskId)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Invalid task_id: "${rawTaskId}". Must be a positive integer (digits only, max 20 digits).` }) }],
        isError: true,
      };
    }
    if (teamName) {
      cwd = resolveTeamWorkingDirectory(teamName, cwd);
    }
    await mkdir(getStateDir(cwd, explicitSessionId), { recursive: true });
  }

  switch (name) {
    case 'state_read': {
      const mode = (args as Record<string, unknown>).mode as string;
      const paths = await getReadScopedStatePaths(mode, cwd, explicitSessionId);
      const path = paths.find((candidate) => existsSync(candidate));
      if (!path) {
        return { content: [{ type: 'text', text: JSON.stringify({ exists: false, mode }) }] };
      }
      const data = await readFile(path, 'utf-8');
      return { content: [{ type: 'text', text: data }] };
    }

    case 'state_write': {
      const mode = (args as Record<string, unknown>).mode as string;
      const path = getStatePath(mode, cwd, effectiveSessionId);
      const {
        mode: _m,
        workingDirectory: _w,
        session_id: _sid,
        state: customState,
        ...fields
      } = args as Record<string, unknown>;
      let validationError: string | null = null;
      await withStateWriteLock(path, async () => {
        let existing: Record<string, unknown> = {};
        if (existsSync(path)) {
          try {
            existing = JSON.parse(await readFile(path, 'utf-8'));
          } catch { /* start fresh */ }
        }

        const mergedRaw = { ...existing, ...fields, ...(customState as Record<string, unknown> || {}) } as Record<string, unknown>;

        if (mode === 'ralph') {
          const originalPhase = mergedRaw.current_phase;
          const validation = validateAndNormalizeRalphState(mergedRaw);
          if (!validation.ok || !validation.state) {
            validationError = validation.error || `ralph.current_phase must be one of: ${RALPH_PHASES.join(', ')}`;
            return;
          }
          if (
            typeof originalPhase === 'string'
            && typeof validation.state.current_phase === 'string'
            && validation.state.current_phase !== originalPhase
          ) {
            validation.state.ralph_phase_normalized_from = originalPhase;
          }
          Object.assign(mergedRaw, validation.state);
          await ensureCanonicalRalphArtifacts(cwd, effectiveSessionId);
        }

        const merged = withModeRuntimeContext(existing, mergedRaw);
        await writeAtomicFile(path, JSON.stringify(merged, null, 2));
      });
      if (validationError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: validationError }),
          }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, mode, path }) }] };
    }

    case 'state_clear': {
      const mode = (args as Record<string, unknown>).mode as string;
      const allSessions = (args as Record<string, unknown>).all_sessions === true;

      if (!allSessions) {
        const path = getStatePath(mode, cwd, effectiveSessionId);
        if (existsSync(path)) {
          await unlink(path);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ cleared: true, mode, path }) }] };
      }

      const removedPaths: string[] = [];
      const paths = await getAllScopedStatePaths(mode, cwd);
      for (const path of paths) {
        if (!existsSync(path)) continue;
        await unlink(path);
        removedPaths.push(path);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            cleared: true,
            mode,
            all_sessions: true,
            removed: removedPaths.length,
            paths: removedPaths,
            warning: 'all_sessions clears global and session-scoped state files',
          }),
        }],
      };
    }

    case 'state_list_active': {
      const stateDirs = await getReadScopedStateDirs(cwd, explicitSessionId);
      const active: string[] = [];
      const seenModes = new Set<string>();
      for (const stateDir of stateDirs) {
        if (!existsSync(stateDir)) continue;
        const files = await readdir(stateDir);
        for (const f of files) {
          if (!f.endsWith('-state.json')) continue;
          const mode = f.replace('-state.json', '');
          if (seenModes.has(mode)) continue;
          seenModes.add(mode);
          try {
            const data = JSON.parse(await readFile(join(stateDir, f), 'utf-8'));
            if (data.active) {
              active.push(mode);
            }
          } catch { /* skip malformed */ }
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ active_modes: active }) }] };
    }

    case 'state_get_status': {
      const mode = (args as Record<string, unknown>)?.mode as string | undefined;
      const stateDirs = await getReadScopedStateDirs(cwd, explicitSessionId);
      const statuses: Record<string, unknown> = {};
      const seenModes = new Set<string>();

      for (const stateDir of stateDirs) {
        if (!existsSync(stateDir)) continue;
        const files = await readdir(stateDir);
        for (const f of files) {
          if (!f.endsWith('-state.json')) continue;
          const m = f.replace('-state.json', '');
          if (mode && m !== mode) continue;
          if (seenModes.has(m)) continue;
          seenModes.add(m);
          try {
            const data = JSON.parse(await readFile(join(stateDir, f), 'utf-8'));
            statuses[m] = { active: data.active, phase: data.current_phase, path: join(stateDir, f), data };
          } catch {
            statuses[m] = { error: 'malformed state file' };
          }
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ statuses }) }] };
    }

    case 'team_send_message': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const fromWorker = String((args as Record<string, unknown>).from_worker || '').trim();
      const toWorker = String((args as Record<string, unknown>).to_worker || '').trim();
      const body = String((args as Record<string, unknown>).body || '').trim();
      if (!teamName || !fromWorker || !toWorker || !body) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, from_worker, to_worker, body are required' }) }],
          isError: true,
        };
      }
      const message = await sendDirectMessage(teamName, fromWorker, toWorker, body, cwd);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, message }) }],
      };
    }

    case 'team_broadcast': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const fromWorker = String((args as Record<string, unknown>).from_worker || '').trim();
      const body = String((args as Record<string, unknown>).body || '').trim();
      if (!teamName || !fromWorker || !body) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, from_worker, body are required' }) }],
          isError: true,
        };
      }
      const messages = await broadcastMessage(teamName, fromWorker, body, cwd);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, count: messages.length, messages }) }],
      };
    }

    case 'team_mailbox_list': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const includeDelivered = (args as Record<string, unknown>).include_delivered !== false;
      if (!teamName || !worker) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and worker are required' }) }],
          isError: true,
        };
      }
      const all = await listMailboxMessages(teamName, worker, cwd);
      const messages = includeDelivered ? all : all.filter((m) => !m.delivered_at);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, worker, count: messages.length, messages }) }],
      };
    }

    case 'team_mailbox_mark_delivered': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const messageId = String((args as Record<string, unknown>).message_id || '').trim();
      if (!teamName || !worker || !messageId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, worker, message_id are required' }) }],
          isError: true,
        };
      }
      const updated = await markMessageDelivered(teamName, worker, messageId, cwd);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, updated, worker, message_id: messageId }) }],
      };
    }

    case 'team_mailbox_mark_notified': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const messageId = String((args as Record<string, unknown>).message_id || '').trim();
      if (!teamName || !worker || !messageId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, worker, message_id are required' }) }], isError: true };
      }
      const notified = await markMessageNotified(teamName, worker, messageId, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, notified, worker, message_id: messageId }) }] };
    }

    case 'team_create_task': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const subject = String((args as Record<string, unknown>).subject || '').trim();
      const description = String((args as Record<string, unknown>).description || '').trim();
      if (!teamName || !subject || !description) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, subject, description are required' }) }], isError: true };
      }
      const owner = (args as Record<string, unknown>).owner as string | undefined;
      const blockedBy = (args as Record<string, unknown>).blocked_by as string[] | undefined;
      const requiresCodeChange = (args as Record<string, unknown>).requires_code_change as boolean | undefined;
      const task = await teamCreateTask(teamName, {
        subject, description, status: 'pending',
        owner: owner || undefined,
        blocked_by: blockedBy,
        requires_code_change: requiresCodeChange,
      }, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task }) }] };
    }

    case 'team_read_task': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      if (!teamName || !taskId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and task_id are required' }) }], isError: true };
      }
      const task = await teamReadTask(teamName, taskId, cwd);
      if (!task) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'task_not_found' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task }) }] };
    }

    case 'team_list_tasks': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      if (!teamName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name is required' }) }], isError: true };
      }
      const tasks = await teamListTasks(teamName, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, count: tasks.length, tasks }) }] };
    }

    case 'team_update_task': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      if (!teamName || !taskId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and task_id are required' }) }], isError: true };
      }
      const lifecycleFields = ['status', 'owner', 'result', 'error'] as const;
      const presentLifecycleFields = lifecycleFields.filter((f) => f in (args as Record<string, unknown>));
      if (presentLifecycleFields.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `team_update_task cannot mutate lifecycle fields: ${presentLifecycleFields.join(', ')}. Use team_claim_task + team_transition_task_status to change task status/owner/result/error.`,
            }),
          }],
          isError: true,
        };
      }
      const unexpectedFields = Object.keys(args as Record<string, unknown>).filter((field) => !TEAM_UPDATE_TASK_REQUEST_FIELDS.has(field));
      if (unexpectedFields.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `team_update_task received unsupported fields: ${unexpectedFields.join(', ')}. Allowed mutable fields: subject, description, blocked_by, requires_code_change.`,
            }),
          }],
          isError: true,
        };
      }
      const updates: Record<string, unknown> = {};
      if ('subject' in (args as Record<string, unknown>)) {
        const subject = (args as Record<string, unknown>).subject;
        if (typeof subject !== 'string') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'subject must be a string when provided' }) }], isError: true };
        }
        updates.subject = subject.trim();
      }
      if ('description' in (args as Record<string, unknown>)) {
        const description = (args as Record<string, unknown>).description;
        if (typeof description !== 'string') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'description must be a string when provided' }) }], isError: true };
        }
        updates.description = description.trim();
      }
      if ('requires_code_change' in (args as Record<string, unknown>)) {
        const requiresCodeChange = (args as Record<string, unknown>).requires_code_change;
        if (typeof requiresCodeChange !== 'boolean') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'requires_code_change must be a boolean when provided' }) }], isError: true };
        }
        updates.requires_code_change = requiresCodeChange;
      }
      if ('blocked_by' in (args as Record<string, unknown>)) {
        try {
          updates.blocked_by = parseValidatedTaskIdArray((args as Record<string, unknown>).blocked_by, 'blocked_by');
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }], isError: true };
        }
      }
      const task = await teamUpdateTask(teamName, taskId, updates, cwd);
      if (!task) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'task_not_found' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task }) }] };
    }

    case 'team_claim_task': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      if (!teamName || !taskId || !worker) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, task_id, worker are required' }) }], isError: true };
      }
      const rawExpectedVersion = (args as Record<string, unknown>).expected_version;
      if (rawExpectedVersion !== undefined && (!isFiniteInteger(rawExpectedVersion) || rawExpectedVersion < 1)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'expected_version must be a positive integer when provided' }) }],
          isError: true,
        };
      }
      const expectedVersion = rawExpectedVersion as number | undefined;
      const result = await teamClaimTask(teamName, taskId, worker, expectedVersion ?? null, cwd);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'team_transition_task_status': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      const from = String((args as Record<string, unknown>).from || '').trim();
      const to = String((args as Record<string, unknown>).to || '').trim();
      const claimToken = String((args as Record<string, unknown>).claim_token || '').trim();
      if (!teamName || !taskId || !from || !to || !claimToken) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, task_id, from, to, claim_token are required' }) }], isError: true };
      }
      const allowed = new Set<string>(TEAM_TASK_STATUSES);
      if (!allowed.has(from) || !allowed.has(to)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'from and to must be valid task statuses' }) }], isError: true };
      }
      const result = await teamTransitionTaskStatus(
        teamName,
        taskId,
        from as TeamTaskStatus,
        to as TeamTaskStatus,
        claimToken,
        cwd
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'team_release_task_claim': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      const claimToken = String((args as Record<string, unknown>).claim_token || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      if (!teamName || !taskId || !claimToken || !worker) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, task_id, claim_token, worker are required' }) }], isError: true };
      }
      const result = await teamReleaseTaskClaim(teamName, taskId, claimToken, worker, cwd);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    case 'team_read_config': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      if (!teamName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name is required' }) }], isError: true };
      }
      const config = await teamReadConfig(teamName, cwd);
      if (!config) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'team_not_found' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config }) }] };
    }

    case 'team_read_manifest': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      if (!teamName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name is required' }) }], isError: true };
      }
      const manifest = await teamReadManifest(teamName, cwd);
      if (!manifest) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'manifest_not_found' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, manifest }) }] };
    }

    case 'team_read_worker_status': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      if (!teamName || !worker) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and worker are required' }) }], isError: true };
      }
      const status = await teamReadWorkerStatus(teamName, worker, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker, status }) }] };
    }

    case 'team_read_worker_heartbeat': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      if (!teamName || !worker) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and worker are required' }) }], isError: true };
      }
      const heartbeat = await teamReadWorkerHeartbeat(teamName, worker, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker, heartbeat }) }] };
    }

    case 'team_update_worker_heartbeat': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const pid = (args as Record<string, unknown>).pid as number;
      const turnCount = (args as Record<string, unknown>).turn_count as number;
      const alive = (args as Record<string, unknown>).alive as boolean;
      if (!teamName || !worker || typeof pid !== 'number' || typeof turnCount !== 'number' || typeof alive !== 'boolean') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, worker, pid, turn_count, alive are required' }) }], isError: true };
      }
      await teamUpdateWorkerHeartbeat(teamName, worker, { pid, turn_count: turnCount, alive, last_turn_at: new Date().toISOString() }, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker }) }] };
    }

    case 'team_write_worker_inbox': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const content = String((args as Record<string, unknown>).content || '').trim();
      if (!teamName || !worker || !content) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, worker, content are required' }) }], isError: true };
      }
      await teamWriteWorkerInbox(teamName, worker, content, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker }) }] };
    }

    case 'team_write_worker_identity': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const index = (args as Record<string, unknown>).index as number;
      const role = String((args as Record<string, unknown>).role || '').trim();
      if (!teamName || !worker || typeof index !== 'number' || !role) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, worker, index, role are required' }) }], isError: true };
      }
      const assignedTasks = ((args as Record<string, unknown>).assigned_tasks as string[] | undefined) ?? [];
      const pid = (args as Record<string, unknown>).pid as number | undefined;
      const paneId = (args as Record<string, unknown>).pane_id as string | undefined;
      const workingDir = (args as Record<string, unknown>).working_dir as string | undefined;
      const worktreePath = (args as Record<string, unknown>).worktree_path as string | undefined;
      const worktreeBranch = (args as Record<string, unknown>).worktree_branch as string | undefined;
      const worktreeDetached = (args as Record<string, unknown>).worktree_detached as boolean | undefined;
      const teamStateRoot = (args as Record<string, unknown>).team_state_root as string | undefined;
      await teamWriteWorkerIdentity(teamName, worker, {
        name: worker,
        index,
        role,
        assigned_tasks: assignedTasks,
        pid,
        pane_id: paneId,
        working_dir: workingDir,
        worktree_path: worktreePath,
        worktree_branch: worktreeBranch,
        worktree_detached: worktreeDetached,
        team_state_root: teamStateRoot,
      }, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker }) }] };
    }

    case 'team_append_event': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const eventType = String((args as Record<string, unknown>).type || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      if (!teamName || !eventType || !worker) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, type, worker are required' }) }], isError: true };
      }
      if (!TEAM_EVENT_TYPES.includes(eventType as TeamEventType)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `type must be one of: ${TEAM_EVENT_TYPES.join(', ')}` }),
          }],
          isError: true,
        };
      }
      const event = await teamAppendEvent(teamName, {
        type: eventType as TeamEventType,
        worker,
        task_id: (args as Record<string, unknown>).task_id as string | undefined,
        message_id: ((args as Record<string, unknown>).message_id as string | undefined) ?? null,
        reason: (args as Record<string, unknown>).reason as string | undefined,
      }, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, event }) }] };
    }

    case 'team_get_summary': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      if (!teamName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name is required' }) }], isError: true };
      }
      const summary = await teamGetSummary(teamName, cwd);
      if (!summary) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'team_not_found' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, summary }) }] };
    }

    case 'team_cleanup': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      if (!teamName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name is required' }) }], isError: true };
      }
      await teamCleanup(teamName, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, team_name: teamName }) }] };
    }

    case 'team_write_shutdown_request': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      const requestedBy = String((args as Record<string, unknown>).requested_by || '').trim();
      if (!teamName || !worker || !requestedBy) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, worker, requested_by are required' }) }], isError: true };
      }
      await teamWriteShutdownRequest(teamName, worker, requestedBy, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker }) }] };
    }

    case 'team_read_shutdown_ack': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const worker = String((args as Record<string, unknown>).worker || '').trim();
      if (!teamName || !worker) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and worker are required' }) }], isError: true };
      }
      const minUpdatedAt = (args as Record<string, unknown>).min_updated_at as string | undefined;
      const ack = await teamReadShutdownAck(teamName, worker, cwd, minUpdatedAt);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, worker, ack }) }] };
    }

    case 'team_read_monitor_snapshot': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      if (!teamName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name is required' }) }], isError: true };
      }
      const snapshot = await teamReadMonitorSnapshot(teamName, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, snapshot }) }] };
    }

    case 'team_write_monitor_snapshot': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const snapshot = (args as Record<string, unknown>).snapshot as TeamMonitorSnapshotState | undefined;
      if (!teamName || !snapshot) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and snapshot are required' }) }], isError: true };
      }
      await teamWriteMonitorSnapshot(teamName, snapshot, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }

    case 'team_read_task_approval': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      if (!teamName || !taskId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name and task_id are required' }) }], isError: true };
      }
      const approval = await teamReadTaskApproval(teamName, taskId, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, approval }) }] };
    }

    case 'team_write_task_approval': {
      const teamName = String((args as Record<string, unknown>).team_name || '').trim();
      const taskId = String((args as Record<string, unknown>).task_id || '').trim();
      const status = String((args as Record<string, unknown>).status || '').trim();
      const reviewer = String((args as Record<string, unknown>).reviewer || '').trim();
      const decisionReason = String((args as Record<string, unknown>).decision_reason || '').trim();
      if (!teamName || !taskId || !status || !reviewer || !decisionReason) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_name, task_id, status, reviewer, decision_reason are required' }) }], isError: true };
      }
      if (!TEAM_TASK_APPROVAL_STATUSES.includes(status as TeamTaskApprovalStatus)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `status must be one of: ${TEAM_TASK_APPROVAL_STATUSES.join(', ')}` }),
          }],
          isError: true,
        };
      }
      const rawRequired = (args as Record<string, unknown>).required;
      if (rawRequired !== undefined && typeof rawRequired !== 'boolean') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'required must be a boolean when provided' }) }], isError: true };
      }
      const required = rawRequired !== false;
      await teamWriteTaskApproval(teamName, {
        task_id: taskId,
        required,
        status: status as TeamTaskApprovalStatus,
        reviewer,
        decision_reason: decisionReason,
        decided_at: new Date().toISOString(),
      }, cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task_id: taskId, status }) }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true,
    };
  }
}
server.setRequestHandler(CallToolRequestSchema, handleStateToolCall);

// Start server
if (shouldAutoStartMcpServer('state')) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}
