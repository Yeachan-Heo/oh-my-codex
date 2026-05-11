export const RUNINGTEAM_STATUSES = [
  'planning',
  'executing',
  'checkpointing',
  'reviewing',
  'revising',
  'synthesizing',
  'complete',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type RuningTeamStatus = (typeof RUNINGTEAM_STATUSES)[number];

export const RUNINGTEAM_TERMINAL_STATUSES: ReadonlySet<RuningTeamStatus> = new Set([
  'complete',
  'blocked',
  'failed',
  'cancelled',
]);

export const RUNINGTEAM_CRITIC_VERDICTS = [
  'APPROVE_NEXT_BATCH',
  'ITERATE_PLAN',
  'REJECT_BATCH',
  'ASK_USER',
  'FINAL_SYNTHESIS_READY',
  'FAIL',
] as const;

export type RuningTeamCriticVerdict = (typeof RUNINGTEAM_CRITIC_VERDICTS)[number];

export interface RuningTeamSession {
  session_id: string;
  task: string;
  created_at: string;
  updated_at: string;
  status: RuningTeamStatus;
  iteration: number;
  plan_version: number;
  team_name: string | null;
  max_iterations: number;
  terminal_reason: string | null;
}

export interface RuningTeamPlanLane {
  id: string;
  title: string;
  status: 'pending' | 'executing' | 'complete' | 'blocked';
  acceptance_criteria: string[];
}

export interface RuningTeamPlan {
  plan_version: number;
  task: string;
  intent: string;
  acceptance_criteria: string[];
  non_goals: string[];
  lanes: RuningTeamPlanLane[];
}

export interface RuningTeamTeamAdapterState {
  team_name: string;
  cursor: string;
  lane_task_map: Record<string, string>;
  evidence_guarantee: 'active' | 'failed';
}

export interface RuningTeamWorkerEvidence {
  evidence_id: string;
  worker: string;
  lane: string;
  task_id: string;
  plan_version: number;
  files_changed: string[];
  commands: string[];
  tests: string[];
  summary: string;
  supported: boolean;
  created_at: string;
}

export interface RuningTeamCheckpoint {
  iteration: number;
  plan_version: number;
  created_at: string;
  evidence_ids: string[];
  lane_status: Record<string, string>;
  blockers: string[];
  summary: string;
}

export interface RuningTeamCriticVerdictRecord {
  iteration: number;
  verdict: RuningTeamCriticVerdict;
  required_changes?: string[];
  rejected_claims?: string[];
  acceptance_criteria_evidence?: Record<string, string[]>;
  created_at: string;
}

export interface RuningTeamPlannerRevision {
  iteration: number;
  from_plan_version: number;
  to_plan_version: number;
  reason: string;
  changes: string[];
  preserved_acceptance_criteria: boolean;
  user_override?: string;
  created_at: string;
}
