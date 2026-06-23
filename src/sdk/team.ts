import { executeTeamApiOperation, type TeamApiEnvelope, type TeamApiOperation } from '../team/api-interop.js';

export type OmxTeamOperation = TeamApiOperation;

export interface OmxTeamClientOptions {
  cwd?: string;
}

export interface OmxTeamSendMessageRequest {
  teamName: string;
  fromWorker: string;
  toWorker: string;
  body: string;
}

export interface OmxTeamBroadcastRequest {
  teamName: string;
  fromWorker: string;
  body: string;
}

export interface OmxTeamMailboxListRequest {
  teamName: string;
  worker: string;
  includeDelivered?: boolean;
}

export interface OmxTeamMailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body?: string;
  created_at?: string;
  notified_at?: string;
  delivered_at?: string;
  [key: string]: unknown;
}

export interface OmxTeamDispatchOutcome {
  ok: boolean;
  transport: 'hook' | 'prompt_stdin' | 'tmux_send_keys' | 'mailbox' | 'none' | string;
  reason: string;
  request_id?: string;
  message_id?: string;
  to_worker?: string;
  [key: string]: unknown;
}

export interface OmxTeamSendMessageResult {
  message: OmxTeamMailboxMessage;
  dispatch: OmxTeamDispatchOutcome;
}

export interface OmxTeamMailboxListResult {
  worker: string;
  count: number;
  messages: OmxTeamMailboxMessage[];
}

export interface OmxTeamTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | string;
  owner?: string;
  result?: string;
  error?: string;
  version?: number;
  [key: string]: unknown;
}

export interface OmxTeamTaskListResult {
  count: number;
  tasks: OmxTeamTask[];
}

export interface OmxTeamClaimResult {
  task?: OmxTeamTask;
  claim_token?: string;
  claimToken?: string;
  [key: string]: unknown;
}

export interface OmxTeamEventAppendRequest {
  teamName: string;
  type: string;
  worker: string;
  taskId?: string;
  messageId?: string;
  reason?: string;
  state?: string;
  prevState?: string;
  toWorker?: string;
  workerCount?: number;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

export class OmxTeamApiError extends Error {
  readonly operation: string;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(envelope: Extract<TeamApiEnvelope, { ok: false }>) {
    super(envelope.error.message);
    this.name = 'OmxTeamApiError';
    this.operation = envelope.operation;
    this.code = envelope.error.code;
    this.details = envelope.error.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asSendMessageResult(data: Record<string, unknown>): OmxTeamSendMessageResult {
  const message = data.message;
  const dispatch = data.dispatch;
  if (!isRecord(message) || !isRecord(dispatch)) {
    throw new Error('team send-message returned malformed data');
  }
  return {
    message: message as unknown as OmxTeamMailboxMessage,
    dispatch: dispatch as unknown as OmxTeamDispatchOutcome,
  };
}

function asMailboxListResult(data: Record<string, unknown>): OmxTeamMailboxListResult {
  const messages = data.messages;
  if (!Array.isArray(messages)) {
    throw new Error('team mailbox-list returned malformed data');
  }
  return {
    worker: String(data.worker ?? ''),
    count: Number(data.count ?? messages.length),
    messages: messages.filter(isRecord) as unknown as OmxTeamMailboxMessage[],
  };
}

function asTask(data: Record<string, unknown>): OmxTeamTask {
  const task = data.task;
  if (!isRecord(task)) throw new Error('team operation returned malformed task data');
  return task as unknown as OmxTeamTask;
}

function asTaskList(data: Record<string, unknown>): OmxTeamTaskListResult {
  const tasks = data.tasks;
  if (!Array.isArray(tasks)) throw new Error('team list-tasks returned malformed data');
  return {
    count: Number(data.count ?? tasks.length),
    tasks: tasks.filter(isRecord) as unknown as OmxTeamTask[],
  };
}

function definedEntries(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function runTeamOperation(
  operation: Parameters<typeof executeTeamApiOperation>[0],
  args: Record<string, unknown>,
  cwd: string,
): Promise<Record<string, unknown>> {
  const envelope = await executeTeamApiOperation(operation, args, cwd);
  if (!envelope.ok) throw new OmxTeamApiError(envelope);
  return envelope.data;
}

export class OmxTeamClient {
  readonly cwd: string;

  constructor(options: OmxTeamClientOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
  }

  async sendMessage(request: OmxTeamSendMessageRequest): Promise<OmxTeamSendMessageResult> {
    return asSendMessageResult(await runTeamOperation('send-message', {
      team_name: request.teamName,
      from_worker: request.fromWorker,
      to_worker: request.toWorker,
      body: request.body,
    }, this.cwd));
  }

  async broadcast(request: OmxTeamBroadcastRequest): Promise<{ count: number; messages: OmxTeamMailboxMessage[] }> {
    const data = await runTeamOperation('broadcast', {
      team_name: request.teamName,
      from_worker: request.fromWorker,
      body: request.body,
    }, this.cwd);
    const messages = Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
    return { count: Number(data.count ?? messages.length), messages: messages as unknown as OmxTeamMailboxMessage[] };
  }

  async mailboxList(request: OmxTeamMailboxListRequest): Promise<OmxTeamMailboxListResult> {
    return asMailboxListResult(await runTeamOperation('mailbox-list', {
      team_name: request.teamName,
      worker: request.worker,
      include_delivered: request.includeDelivered,
    }, this.cwd));
  }

  async markMailboxDelivered(request: { teamName: string; worker: string; messageId: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('mailbox-mark-delivered', {
      team_name: request.teamName,
      worker: request.worker,
      message_id: request.messageId,
    }, this.cwd);
  }

  async markMailboxNotified(request: { teamName: string; worker: string; messageId: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('mailbox-mark-notified', {
      team_name: request.teamName,
      worker: request.worker,
      message_id: request.messageId,
    }, this.cwd);
  }

  async summary(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('get-summary', { team_name: teamName }, this.cwd);
  }

  async createTask(request: {
    teamName: string;
    subject: string;
    description: string;
    owner?: string;
    blockedBy?: string[];
    requiresCodeChange?: boolean;
  }): Promise<OmxTeamTask> {
    return asTask(await runTeamOperation('create-task', definedEntries({
      team_name: request.teamName,
      subject: request.subject,
      description: request.description,
      owner: request.owner,
      blocked_by: request.blockedBy,
      requires_code_change: request.requiresCodeChange,
    }), this.cwd));
  }

  async updateTask(request: {
    teamName: string;
    taskId: string;
    subject?: string;
    description?: string;
    blockedBy?: string[];
    requiresCodeChange?: boolean;
  }): Promise<OmxTeamTask> {
    return asTask(await runTeamOperation('update-task', definedEntries({
      team_name: request.teamName,
      task_id: request.taskId,
      subject: request.subject,
      description: request.description,
      blocked_by: request.blockedBy,
      requires_code_change: request.requiresCodeChange,
    }), this.cwd));
  }

  async listTasks(teamName: string): Promise<OmxTeamTaskListResult> {
    return asTaskList(await runTeamOperation('list-tasks', { team_name: teamName }, this.cwd));
  }

  async readTask(request: { teamName: string; taskId: string }): Promise<OmxTeamTask> {
    return asTask(await runTeamOperation('read-task', {
      team_name: request.teamName,
      task_id: request.taskId,
    }, this.cwd));
  }

  async claimTask(request: { teamName: string; taskId: string; worker: string; expectedVersion?: number }): Promise<OmxTeamClaimResult> {
    return await runTeamOperation('claim-task', definedEntries({
      team_name: request.teamName,
      task_id: request.taskId,
      worker: request.worker,
      expected_version: request.expectedVersion,
    }), this.cwd);
  }

  async transitionTaskStatus(request: {
    teamName: string;
    taskId: string;
    from: string;
    to: string;
    claimToken: string;
    result?: string;
    error?: string;
  }): Promise<Record<string, unknown>> {
    return await runTeamOperation('transition-task-status', definedEntries({
      team_name: request.teamName,
      task_id: request.taskId,
      from: request.from,
      to: request.to,
      claim_token: request.claimToken,
      result: request.result,
      error: request.error,
    }), this.cwd);
  }

  async releaseTaskClaim(request: { teamName: string; taskId: string; claimToken: string; worker: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('release-task-claim', {
      team_name: request.teamName,
      task_id: request.taskId,
      claim_token: request.claimToken,
      worker: request.worker,
    }, this.cwd);
  }

  async readConfig(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-config', { team_name: teamName }, this.cwd);
  }

  async readManifest(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-manifest', { team_name: teamName }, this.cwd);
  }

  async readWorkerStatus(request: { teamName: string; worker: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-worker-status', {
      team_name: request.teamName,
      worker: request.worker,
    }, this.cwd);
  }

  async readWorkerHeartbeat(request: { teamName: string; worker: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-worker-heartbeat', {
      team_name: request.teamName,
      worker: request.worker,
    }, this.cwd);
  }

  async updateWorkerHeartbeat(request: {
    teamName: string;
    worker: string;
    pid: number;
    turnCount: number;
    alive: boolean;
  }): Promise<Record<string, unknown>> {
    return await runTeamOperation('update-worker-heartbeat', definedEntries({
      team_name: request.teamName,
      worker: request.worker,
      pid: request.pid,
      turn_count: request.turnCount,
      alive: request.alive,
    }), this.cwd);
  }

  async writeWorkerInbox(request: { teamName: string; worker: string; content: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('write-worker-inbox', {
      team_name: request.teamName,
      worker: request.worker,
      content: request.content,
    }, this.cwd);
  }

  async writeWorkerIdentity(request: {
    teamName: string;
    worker: string;
    index: number;
    role: string;
    assignedTasks?: string[];
    pid?: number;
    paneId?: string;
    workingDir?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeDetached?: boolean;
    teamStateRoot?: string;
  }): Promise<Record<string, unknown>> {
    return await runTeamOperation('write-worker-identity', definedEntries({
      team_name: request.teamName,
      worker: request.worker,
      index: request.index,
      role: request.role,
      assigned_tasks: request.assignedTasks,
      pid: request.pid,
      pane_id: request.paneId,
      working_dir: request.workingDir,
      worktree_path: request.worktreePath,
      worktree_branch: request.worktreeBranch,
      worktree_detached: request.worktreeDetached,
      team_state_root: request.teamStateRoot,
    }), this.cwd);
  }

  async appendEvent(request: OmxTeamEventAppendRequest): Promise<Record<string, unknown>> {
    return await runTeamOperation('append-event', definedEntries({
      team_name: request.teamName,
      type: request.type,
      worker: request.worker,
      task_id: request.taskId,
      message_id: request.messageId,
      reason: request.reason,
      state: request.state,
      prev_state: request.prevState,
      to_worker: request.toWorker,
      worker_count: request.workerCount,
      source_type: request.sourceType,
      metadata: request.metadata,
    }), this.cwd);
  }

  async readEvents(request: { teamName: string; afterEventId?: string; wakeableOnly?: boolean; type?: string; worker?: string; taskId?: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-events', definedEntries({
      team_name: request.teamName,
      after_event_id: request.afterEventId,
      wakeable_only: request.wakeableOnly,
      type: request.type,
      worker: request.worker,
      task_id: request.taskId,
    }), this.cwd);
  }

  async awaitEvent(request: { teamName: string; afterEventId?: string; timeoutMs?: number; pollMs?: number; wakeableOnly?: boolean; type?: string; worker?: string; taskId?: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('await-event', definedEntries({
      team_name: request.teamName,
      after_event_id: request.afterEventId,
      timeout_ms: request.timeoutMs,
      poll_ms: request.pollMs,
      wakeable_only: request.wakeableOnly,
      type: request.type,
      worker: request.worker,
      task_id: request.taskId,
    }), this.cwd);
  }

  async readIdleState(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-idle-state', { team_name: teamName }, this.cwd);
  }

  async readStallState(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-stall-state', { team_name: teamName }, this.cwd);
  }

  async cleanup(request: { teamName: string; force?: boolean; confirmIssues?: boolean }): Promise<Record<string, unknown>> {
    return await runTeamOperation('cleanup', definedEntries({
      team_name: request.teamName,
      force: request.force,
      confirm_issues: request.confirmIssues,
    }), this.cwd);
  }

  async orphanCleanup(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('orphan-cleanup', { team_name: teamName }, this.cwd);
  }

  async writeShutdownRequest(request: { teamName: string; worker: string; requestedBy: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('write-shutdown-request', {
      team_name: request.teamName,
      worker: request.worker,
      requested_by: request.requestedBy,
    }, this.cwd);
  }

  async readShutdownAck(request: { teamName: string; worker: string; minUpdatedAt?: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-shutdown-ack', definedEntries({
      team_name: request.teamName,
      worker: request.worker,
      min_updated_at: request.minUpdatedAt,
    }), this.cwd);
  }

  async readMonitorSnapshot(teamName: string): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-monitor-snapshot', { team_name: teamName }, this.cwd);
  }

  async writeMonitorSnapshot(request: { teamName: string; snapshot: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return await runTeamOperation('write-monitor-snapshot', {
      team_name: request.teamName,
      snapshot: request.snapshot,
    }, this.cwd);
  }

  async readTaskApproval(request: { teamName: string; taskId: string }): Promise<Record<string, unknown>> {
    return await runTeamOperation('read-task-approval', {
      team_name: request.teamName,
      task_id: request.taskId,
    }, this.cwd);
  }

  async writeTaskApproval(request: {
    teamName: string;
    taskId: string;
    status: string;
    reviewer: string;
    decisionReason: string;
    required?: boolean;
  }): Promise<Record<string, unknown>> {
    return await runTeamOperation('write-task-approval', definedEntries({
      team_name: request.teamName,
      task_id: request.taskId,
      status: request.status,
      reviewer: request.reviewer,
      decision_reason: request.decisionReason,
      required: request.required,
    }), this.cwd);
  }
}
