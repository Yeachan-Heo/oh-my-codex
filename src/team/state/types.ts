import type { TeamPhase, TerminalPhase } from '../orchestrator.js';
import type { TeamTaskStatus, TeamEventType } from '../contracts.js';

export interface TeamConfig {
  name: string;
  task: string;
  agent_type: string;
  worker_launch_mode: 'interactive' | 'prompt';
  lifecycle_profile: 'default' | 'linked_ralph';
  worker_count: number;
  max_workers: number;
  workers: WorkerInfo[];
  created_at: string;
  tmux_session: string;
  next_task_id: number;
  leader_cwd?: string;
  team_state_root?: string;
  workspace_mode?: 'single' | 'worktree';
  leader_pane_id: string | null;
  hud_pane_id: string | null;
  resize_hook_name: string | null;
  resize_hook_target: string | null;
  next_worker_index?: number;
}

export interface WorkerInfo {
  name: string;
  index: number;
  role: string;
  worker_cli?: 'codex' | 'claude' | 'gemini';
  assigned_tasks: string[];
  pid?: number;
  pane_id?: string;
  working_dir?: string;
  worktree_repo_root?: string;
  worktree_path?: string;
  worktree_branch?: string;
  worktree_detached?: boolean;
  worktree_created?: boolean;
  team_state_root?: string;
}

export interface WorkerHeartbeat {
  pid: number;
  last_turn_at: string;
  turn_count: number;
  alive: boolean;
}

export interface WorkerStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'draining' | 'unknown';
  current_task_id?: string;
  reason?: string;
  updated_at: string;
}

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  requires_code_change?: boolean;
  role?: string;
  owner?: string;
  result?: string;
  error?: string;
  blocked_by?: string[];
  depends_on?: string[];
  version?: number;
  claim?: TeamTaskClaim;
  created_at: string;
  completed_at?: string;
}

export interface TeamTaskClaim {
  owner: string;
  token: string;
  leased_until: string;
}

export interface TeamTaskV2 extends TeamTask {
  version: number;
}

export interface TeamLeader {
  session_id: string;
  thread_id?: string;
  worker_id: string;
  role: string;
}

export interface TeamPolicy {
  display_mode: 'split_pane' | 'auto';
  worker_launch_mode: 'interactive' | 'prompt';
  dispatch_mode: 'hook_preferred_with_fallback' | 'transport_direct';
  dispatch_ack_timeout_ms: number;
}

/**
 * Lifecycle/workflow guardrails persisted alongside the manifest, but kept
 * separate from transport/runtime policy so each layer has a single owner.
 */
export interface TeamGovernance {
  delegation_only: boolean;
  plan_approval_required: boolean;
  nested_teams_allowed: boolean;
  one_team_per_leader_session: boolean;
  cleanup_requires_all_workers_inactive: boolean;
}

export type TeamDispatchRequestKind = 'inbox' | 'mailbox' | 'nudge';
export type TeamDispatchRequestStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export type TeamDispatchTransportPreference = 'hook_preferred_with_fallback' | 'transport_direct' | 'prompt_stdin';

export interface TeamDispatchRequest {
  request_id: string;
  kind: TeamDispatchRequestKind;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference: TeamDispatchTransportPreference;
  fallback_allowed: boolean;
  status: TeamDispatchRequestStatus;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  last_reason?: string;
}

export interface TeamDispatchRequestInput {
  kind: TeamDispatchRequestKind;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference?: TeamDispatchTransportPreference;
  fallback_allowed?: boolean;
  last_reason?: string;
}

export interface PermissionsSnapshot {
  approval_mode: string;
  sandbox_mode: string;
  network_access: boolean;
}

export interface TeamManifestV2 {
  schema_version: 2;
  name: string;
  task: string;
  leader: TeamLeader;
  policy: TeamPolicy;
  governance: TeamGovernance;
  lifecycle_profile: 'default' | 'linked_ralph';
  permissions_snapshot: PermissionsSnapshot;
  tmux_session: string;
  worker_count: number;
  workers: WorkerInfo[];
  next_task_id: number;
  created_at: string;
  leader_cwd?: string;
  team_state_root?: string;
  workspace_mode?: 'single' | 'worktree';
  leader_pane_id: string | null;
  hud_pane_id: string | null;
  resize_hook_name: string | null;
  resize_hook_target: string | null;
  next_worker_index?: number;
}

export interface TeamWorkspaceMetadata {
  leader_cwd?: string;
  team_state_root?: string;
  workspace_mode?: 'single' | 'worktree';
}

export interface TeamEvent {
  event_id: string;
  team: string;
  type: TeamEventType;
  worker: string;
  task_id?: string;
  message_id?: string | null;
  reason?: string;
  state?: WorkerStatus['state'];
  prev_state?: WorkerStatus['state'];
  worker_count?: number;
  to_worker?: string;
  source_type?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  [key: string]: unknown;
}

export interface TeamMailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

export interface TeamMailbox {
  worker: string;
  messages: TeamMailboxMessage[];
}

export interface TaskApprovalRecord {
  task_id: string;
  required: boolean;
  status: 'pending' | 'approved' | 'rejected';
  reviewer: string;
  decision_reason: string;
  decided_at: string;
}

export type TaskReadiness =
  | { ready: true }
  | { ready: false; reason: 'blocked_dependency'; dependencies: string[] };

export type ClaimTaskResult =
  | { ok: true; task: TeamTaskV2; claimToken: string }
  | { ok: false; error: 'claim_conflict' | 'blocked_dependency' | 'task_not_found' | 'already_terminal' | 'worker_not_found'; dependencies?: string[] };

export type TransitionTaskResult =
  | { ok: true; task: TeamTaskV2 }
  | { ok: false; error: 'claim_conflict' | 'invalid_transition' | 'task_not_found' | 'already_terminal' | 'lease_expired' };

export type ReleaseTaskClaimResult =
  | { ok: true; task: TeamTaskV2 }
  | { ok: false; error: 'claim_conflict' | 'task_not_found' | 'already_terminal' | 'lease_expired' };

export type ReclaimTaskResult =
  | { ok: true; task: TeamTaskV2; reclaimed: boolean }
  | { ok: false; error: 'claim_conflict' | 'task_not_found' | 'already_terminal' | 'lease_active' };

export interface TeamSummary {
  teamName: string;
  workerCount: number;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  workers: Array<{ name: string; alive: boolean; lastTurnAt: string | null; turnsWithoutProgress: number }>;
  nonReportingWorkers: string[];
  performance?: TeamSummaryPerformance;
}

export interface TeamSummaryPerformance {
  total_ms: number;
  tasks_loaded_ms: number;
  workers_polled_ms: number;
  task_count: number;
  worker_count: number;
}

export interface ShutdownAck {
  status: 'accept' | 'reject';
  reason?: string;
  updated_at?: string;
}

export interface TeamMonitorSnapshotState {
  taskStatusById: Record<string, string>;
  workerAliveByName: Record<string, boolean>;
  workerStateByName: Record<string, string>;
  workerTurnCountByName: Record<string, number>;
  workerTaskIdByName: Record<string, string>;
  mailboxNotifiedByMessageId: Record<string, string>;
  completedEventTaskIds: Record<string, boolean>;
  monitorTimings?: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    mailbox_delivery_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

export interface TeamPhaseState {
  current_phase: TeamPhase | TerminalPhase;
  max_fix_attempts: number;
  current_fix_attempt: number;
  transitions: Array<{ from: string; to: string; at: string; reason?: string }>;
  updated_at: string;
}

export const DEFAULT_MAX_WORKERS = 20;
export const ABSOLUTE_MAX_WORKERS = 20;
