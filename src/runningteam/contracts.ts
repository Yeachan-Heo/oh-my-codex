export const RUNNINGTEAM_STATUSES = [
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

export type RunningTeamStatus = (typeof RUNNINGTEAM_STATUSES)[number];

export const RUNNINGTEAM_TERMINAL_STATUSES: ReadonlySet<RunningTeamStatus> = new Set([
  'complete',
  'blocked',
  'failed',
  'cancelled',
]);

export const RUNNINGTEAM_CRITIC_VERDICTS = [
  'APPROVE_NEXT_BATCH',
  'ITERATE_PLAN',
  'REJECT_BATCH',
  'ASK_USER',
  'FINAL_SYNTHESIS_READY',
  'FAIL',
] as const;

export type RunningTeamCriticVerdict = (typeof RUNNINGTEAM_CRITIC_VERDICTS)[number];

export interface RunningTeamSession {
  session_id: string;
  task: string;
  created_at: string;
  updated_at: string;
  status: RunningTeamStatus;
  iteration: number;
  plan_version: number;
  team_name: string | null;
  max_iterations: number;
  terminal_reason: string | null;
}

export interface RunningTeamPlanLane {
  id: string;
  title: string;
  status: 'pending' | 'executing' | 'complete' | 'blocked';
  acceptance_criteria: string[];
}

export interface RunningTeamPlan {
  plan_version: number;
  task: string;
  intent: string;
  acceptance_criteria: string[];
  non_goals: string[];
  lanes: RunningTeamPlanLane[];
}

export interface RunningTeamTeamAdapterState {
  team_name: string;
  cursor: string;
  lane_task_map: Record<string, string>;
  evidence_guarantee: 'active' | 'failed';
}

export interface RunningTeamWorkerEvidence {
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

export interface RunningTeamCheckpoint {
  iteration: number;
  plan_version: number;
  created_at: string;
  evidence_ids: string[];
  lane_status: Record<string, string>;
  blockers: string[];
  summary: string;
}

export interface RunningTeamCriticVerdictRecord {
  iteration: number;
  verdict: RunningTeamCriticVerdict;
  required_changes?: string[];
  rejected_claims?: string[];
  acceptance_criteria_evidence?: Record<string, string[]>;
  created_at: string;
}

export interface RunningTeamPlannerRevision {
  iteration: number;
  from_plan_version: number;
  to_plan_version: number;
  reason: string;
  changes: string[];
  preserved_acceptance_criteria: boolean;
  user_override?: string;
  created_at: string;
}
