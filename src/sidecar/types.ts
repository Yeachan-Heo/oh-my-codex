import type { TeamEventType, TeamTaskStatus } from '../team/contracts.js';

export type SidecarWorkerState = 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'draining' | 'unknown';

export interface SidecarTeamConfig {
  name: string;
  task: string;
  worker_count: number;
  tmux_session: string;
  leader_pane_id: string | null;
  hud_pane_id: string | null;
  workers: SidecarWorkerInfo[];
}

export interface SidecarWorkerInfo {
  name: string;
  index: number;
  role: string;
  assigned_tasks: string[];
  pane_id?: string;
  worker_cli?: string;
  working_dir?: string;
  worktree_path?: string;
  worktree_branch?: string;
}

export interface SidecarWorkerStatus {
  state: SidecarWorkerState;
  current_task_id?: string;
  reason?: string;
  updated_at?: string;
}

export interface SidecarWorkerHeartbeat {
  pid?: number;
  last_turn_at?: string;
  turn_count?: number;
  alive?: boolean;
}

export interface SidecarTask {
  id: string;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  owner?: string;
  role?: string;
  result?: string;
  error?: string;
  blocked_by?: string[];
  depends_on?: string[];
  version?: number;
  claim?: {
    owner: string;
    leased_until: string;
  };
  created_at?: string;
  completed_at?: string;
}

export interface SidecarWorkerSnapshot extends SidecarWorkerInfo {
  status: SidecarWorkerStatus;
  heartbeat: SidecarWorkerHeartbeat | null;
  alive: boolean | null;
  current_task: SidecarTask | null;
  turns_without_progress: number | null;
}

export interface SidecarEvent {
  event_id: string;
  team: string;
  type: TeamEventType | string;
  worker: string;
  task_id?: string;
  state?: SidecarWorkerState;
  prev_state?: SidecarWorkerState;
  reason?: string;
  source_type?: string;
  created_at: string;
}

export interface SidecarPaneMapping {
  target: string;
  pane_id: string;
  role: 'leader' | 'hud' | 'worker';
}

export interface SidecarHighlight {
  severity: 'info' | 'warning' | 'critical';
  target: string;
  kind: 'blocked-worker' | 'blocked-task' | 'failed-task' | 'dead-worker' | 'non-reporting-worker';
  message: string;
}

export interface SidecarTopology {
  summary: string;
  nodes: string[];
  edges: Array<{ from: string; to: string; label?: string }>;
}

export interface SidecarSnapshot {
  schema_version: 'omx.sidecar/v1';
  generated_at: string;
  team_name: string;
  team_task: string;
  phase: string | null;
  topology: SidecarTopology;
  workers: SidecarWorkerSnapshot[];
  tasks: SidecarTask[];
  events: SidecarEvent[];
  panes: SidecarPaneMapping[];
  highlights: SidecarHighlight[];
  source_warnings: string[];
}

export interface CollectSidecarSnapshotOptions {
  cwd?: string;
  now?: Date;
  eventLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RenderSidecarOptions {
  width?: number;
  height?: number;
  color?: boolean;
}

export interface SidecarFlags {
  json: boolean;
  watch: boolean;
  tmux: boolean;
  width?: number;
  intervalMs?: number;
}
