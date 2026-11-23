import type { AdvisoryReviewLifecycle } from './advisory-evidence.js';
export type { AdvisoryReviewLifecycle } from './advisory-evidence.js';

export const RALPLAN_ACTIVE_PHASES = ['draft', 'architect-review', 'critic-review', 'complete'] as const;
export type RalplanActivePhase = (typeof RALPLAN_ACTIVE_PHASES)[number];
export type RalplanTerminalPhase = 'complete' | 'cancelled' | 'failed';
export type RalplanReviewVerdict = 'approve' | 'iterate' | 'reject';
export type RalplanExecutionLane = 'ultragoal' | 'team' | 'ralph' | 'conductor' | 'execution' | 'none';

export interface RalplanReusableRoleLane {
  agent_role: 'architect' | 'critic';
  thread_id?: string;
  lane_id?: string;
  session_id?: string;
  native_session_id?: string;
  tracker_path?: string;
}

export interface RalplanDraftResult {
  summary?: string;
  planPath?: string;
  artifacts?: Record<string, unknown>;
  session_id?: string;
  thread_id?: string;
  native_session_id?: string;
  agent_role?: 'planner' | 'architect' | 'critic' | 'executor';
  lane_id?: string;
  tracker_path?: string;
  review_iteration?: number;
  advisory_plan_manifest_sha256?: string;
}

export interface RalplanReviewResult {
  verdict: RalplanReviewVerdict;
  summary?: string;
  artifacts?: Record<string, unknown>;
  provenance_kind?: 'native_subagent';
  session_id?: string;
  thread_id?: string;
  native_session_id?: string;
  artifact_path?: string;
  agent_role?: 'architect' | 'critic';
  lane_id?: string;
  tracker_path?: string;
  new_lane_reason?: string;
  sequence_index?: number;
  review_iteration?: number;
  advisory_artifact_manifest_sha256?: string;
}

export interface RalplanQualityGateResult {
  skill: string;
  iteration: number;
  verdict: RalplanReviewVerdict | 'unavailable';
  summary: string;
  mode?: 'blocking' | 'advisory';
  thread_id?: string;
  provenance_kind?: 'native_subagent';
}

export interface RalplanConsensusGate {
  required: true;
  complete: boolean;
  sequence: ['architect-review', 'critic-review'];
  planning_artifacts_are_not_consensus: true;
  required_review_roles: ['architect', 'critic'];
  ralplan_architect_review: (RalplanReviewResult & { agent_role: 'architect'; iteration: number }) | null;
  ralplan_critic_review: (RalplanReviewResult & { agent_role: 'critic'; iteration: number }) | null;
  architect_review: (RalplanReviewResult & { agent_role: 'architect'; iteration: number }) | null;
  critic_review: (RalplanReviewResult & { agent_role: 'critic'; iteration: number }) | null;
  blocked_reason: string | null;
  qualityGateResults: Record<string, { verdict: RalplanQualityGateResult['verdict']; summary: string }>;
}

export interface RalplanConsensusIterationContext {
  task: string;
  cwd: string;
  iteration: number;
  priorDrafts: RalplanDraftResult[];
  architectReviews: RalplanReviewResult[];
  criticReviews: RalplanReviewResult[];
  gateResults: RalplanQualityGateResult[];
  reusableRoleLanes: { architect?: RalplanReusableRoleLane; critic?: RalplanReusableRoleLane };
}

export interface RalplanConsensusExecutor {
  draft(ctx: RalplanConsensusIterationContext): Promise<RalplanDraftResult>;
  architectReview(ctx: RalplanConsensusIterationContext & { draft: RalplanDraftResult }): Promise<RalplanReviewResult>;
  criticReview(ctx: RalplanConsensusIterationContext & {
    draft: RalplanDraftResult;
    architectReview: RalplanReviewResult;
  }): Promise<RalplanReviewResult>;
  /** Spawn the configured skill as a native subagent. */
  qualityGateReview?(ctx: RalplanConsensusIterationContext & {
    gateName: string;
    gateModel?: string;
    draft: RalplanDraftResult;
    architectReview: RalplanReviewResult;
    criticReview: RalplanReviewResult;
  }): Promise<RalplanReviewResult>;
}

export interface RunRalplanConsensusOptions {
  task: string;
  cwd?: string;
  maxIterations?: number;
  sessionId?: string;
  requireNativeSubagents?: boolean;
  selectedExecutionLane?: RalplanExecutionLane;
  workflowVariant?: 'standard' | 'advisory';
  rootThreadId?: string;
  activationTurnId?: string;
  closingTurnId?: string;
  advisoryProducer?: 'native' | string;
  advisoryThreadKind?: 'root-or-drift' | string;
}

export interface RalplanRuntimeResult {
  status: 'completed' | 'failed' | 'cancelled';
  iteration: number;
  phase: RalplanTerminalPhase;
  planningComplete: boolean;
  drafts: RalplanDraftResult[];
  architectReviews: RalplanReviewResult[];
  criticReviews: RalplanReviewResult[];
  ralplanConsensusGate: RalplanConsensusGate;
  latestPlanPath?: string;
  artifacts: Record<string, unknown>;
  error?: string;
  selectedExecutionLane?: RalplanExecutionLane;
  executionHandoffStarted?: boolean;
  workflowVariant?: 'advisory';
  ralplanReviewLifecycle?: AdvisoryReviewLifecycle;
  executionHandoffAuthorized?: false;
  hostVerified?: false;
  returnToCaller?: boolean;
}
