export const REVIEW_SCHEMA_VERSION = 1 as const;

export const REVIEW_LIMITS = {
  path: 1_024,
  title: 160,
  body: 2_000,
  fix: 2_000,
  reason: 500,
  evidence: 500,
  evidenceLines: 5,
  findingsPerLane: 200,
  findingsPerReview: 5_000,
  diagnostic: 2 * 1_024,
  diagnosticsTotalBytes: 16 * 1_024,
  lanePayload: 1024 * 1024,
} as const;

export const FINDING_SEVERITY_ORDER = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
} as const;

export type ReviewRecommendation = 'APPROVE' | 'COMMENT' | 'REQUEST CHANGES';
export type ArchitectStatus = 'CLEAR' | 'WATCH' | 'BLOCK';
export type ScopeStatus = 'FULL_SCOPE' | 'PARTIAL_SCOPE';
export type EvidenceStatus = 'FULL_EVIDENCE' | 'DEGRADED_EVIDENCE';
export type ReviewRunStatus =
  | 'CREATED'
  | 'SCOPE_FROZEN'
  | 'REVIEWING'
  | 'READY_TO_SYNTHESIZE'
  | 'FINALIZED'
  | 'BLOCKED';
export type LaneStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'TIMED_OUT' | 'INVALID';

export interface ScopeSelector {
  requested_base?: string;
  explicit_paths: string[];
}

export type ScopeFileChange =
  | 'ADDED'
  | 'MODIFIED'
  | 'DELETED'
  | 'RENAMED'
  | 'COPIED'
  | 'TYPE_CHANGED'
  | 'UNMERGED'
  | 'SUBMODULE'
  | 'SYMLINK';
export type ScopeFileSource = 'BASE' | 'INDEX' | 'WORKTREE' | 'UNTRACKED';

export interface ScopeFile {
  path: string;
  previous_path?: string;
  change: ScopeFileChange;
  sources: ScopeFileSource[];
  binary: boolean;
  additions?: number;
  deletions?: number;
}

export interface ScopeManifest {
  selector: ScopeSelector;
  status: ScopeStatus;
  base_ref?: string;
  base_sha?: string;
  head_sha?: string;
  scope_hash: string;
  files: ScopeFile[];
  changed_lines: number;
  reasons: string[];
}

export interface AcceptedEquivalent {
  capability: 'LSP' | 'AST';
  program: string;
  args: string[];
  source: 'EXPLICIT_USER' | 'REPO_CONTRACT';
  source_ref: string;
}

export interface AcceptedEquivalentRequest {
  capability: 'LSP' | 'AST';
  source_ref: string;
}

export interface ExplicitEquivalentApproval {
  schema_version: 1;
  session_id: string;
  root_thread_id: string;
  turn_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
  program: string;
  args: string[];
  approved_at: string;
  nonce: string;
}

export interface EffectiveReviewConfig {
  lane_timeout_ms: number;
  max_files_per_review: number;
  max_changed_lines_per_review: number;
  accepted_equivalents: AcceptedEquivalent[];
}

export interface ReviewBatch {
  batch_id: string;
  module_root: string;
  files: string[];
  changed_lines: number;
  oversized_single_file: boolean;
}

export interface DiagnosticSummary {
  diagnostic_id: string;
  capability: 'LSP' | 'AST' | 'COMPILER' | 'LINT' | 'RG_FALLBACK';
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE';
  execution: 'NATIVE' | 'ACCEPTED_EQUIVALENT' | 'FALLBACK' | 'UNAVAILABLE' | 'SKIPPED';
  outcome: 'PASS' | 'FAIL' | 'TIMED_OUT' | 'MALFORMED' | 'NOT_RUN';
  thread_id: string;
  tool_name?: string;
  program?: string;
  args?: string[];
  event_ref: string;
  source_ref?: string;
  summary: string;
}

export type DiagnosticSubmission = Omit<DiagnosticSummary, 'thread_id'>;

export interface LaneSubmissionAttestation {
  schema_version: 1;
  session_id: string;
  root_thread_id: string;
  review_id: string;
  attempt: number;
  lane_id: string;
  child_thread_id: string;
  scope_hash: string;
  payload_digest: string;
  tool_event_ref: string;
  nonce: string;
  published_at: string;
}

export interface LaneActivityEvent {
  schema_version: 1;
  session_id: string;
  review_id: string;
  attempt: number;
  lane_id: string;
  child_thread_id: string;
  event_ref: string;
  event_kind: 'TOOL_START' | 'TOOL_END' | 'AGENT_PROGRESS' | 'RESULT_POST_TOOL';
  observed_at: string;
}

export interface ResultPostToolPublication {
  schema_version: 1;
  publication_id: string;
  published_at: string;
  activity: LaneActivityEvent & { event_kind: 'RESULT_POST_TOOL' };
  attestation: LaneSubmissionAttestation;
}

export interface ReviewFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  body: string;
  file: string;
  start_line?: number;
  end_line?: number;
  fix: string;
  evidence?: string;
}

export interface LaneProvenance {
  session_id: string;
  thread_id: string;
  tracker_lane_id: string;
  tracker_path: string;
  first_seen_at: string;
  last_seen_at?: string;
  completed_at?: string;
  agent_id?: string;
}

export interface LaneRecord {
  lane_id: string;
  role: 'code-reviewer' | 'architect';
  batch_id: string | 'global';
  scope_hash: string;
  status: LaneStatus;
  attempt: number;
  timeout_ms: number;
  idle_deadline_at: string;
  last_heartbeat_at?: string;
  last_processed_activity_ref?: string;
  last_processed_activity_at?: string;
  provenance?: LaneProvenance;
  recommendation?: ReviewRecommendation;
  architectural_status?: ArchitectStatus;
  findings: ReviewFinding[];
  diagnostic_ids: string[];
  failure_code?: string;
}

export interface LaneBinding {
  lane_id: string;
  attempt: number;
  role: 'code-reviewer' | 'architect';
  batch_id: string | 'global';
  thread_id?: string;
}

export interface ReviewerLaneResult {
  role: 'code-reviewer';
  review_id: string;
  attempt: number;
  lane_id: string;
  batch_id: string;
  scope_hash: string;
  recommendation: ReviewRecommendation;
  findings: ReviewFinding[];
  diagnostics: DiagnosticSubmission[];
}

export interface ArchitectLaneResult {
  role: 'architect';
  review_id: string;
  attempt: number;
  lane_id: string;
  batch_id: 'global';
  scope_hash: string;
  architectural_status: ArchitectStatus;
  findings: ReviewFinding[];
}

export type LaneResult = ReviewerLaneResult | ArchitectLaneResult;

export interface LaneResultProposal {
  schema_version: 1;
  state: 'PENDING_HOST_ATTESTATION';
  review_id: string;
  attempt: number;
  lane_id: string;
  scope_hash: string;
  idempotency_key: string;
  payload_digest: string;
  result: LaneResult;
  proposed_at: string;
}

export type ReviewRecordLaneEvent =
  | {
      event: 'START';
      review_id: string;
      attempt: number;
      lane_id: string;
      thread_id: string;
      idempotency_key: string;
    }
  | {
      event: 'RESULT';
      review_id: string;
      attempt: number;
      lane_id: string;
      scope_hash: string;
      result: LaneResult;
      idempotency_key: string;
    };

export interface FinalVerdict {
  recommendation: ReviewRecommendation;
  architectural_status: ArchitectStatus;
  scope_status: ScopeStatus;
  evidence_status: EvidenceStatus;
  rule_id: string;
  reasons: string[];
  clean: boolean;
}

export type ResumableReason =
  | 'LANE_FAILED'
  | 'LANE_TIMED_OUT'
  | 'LANE_EVIDENCE_INVALID'
  | 'MISSING_LANE'
  | 'MCP_TRANSPORT_DEAD';

export interface ReviewAttempt {
  attempt: number;
  status: ReviewRunStatus;
  bindings: LaneBinding[];
  lane_ids: string[];
  started_at: string;
  updated_at: string;
  finalized_at?: string;
  verdict?: FinalVerdict;
  resumable: boolean;
  resumable_reason?: ResumableReason;
}

export interface ReviewRecord {
  schema_version: 1;
  revision: number;
  last_applied_transaction_id?: string;
  review_id: string;
  session_id?: string;
  root_thread_id?: string;
  invocation_turn_id?: string;
  status: ReviewRunStatus;
  current_attempt: number;
  effective_config: EffectiveReviewConfig;
  scope?: ScopeManifest;
  review_flags: 'BATCHED_REVIEW'[];
  batches: ReviewBatch[];
  lanes: LaneRecord[];
  attempt_history: ReviewAttempt[];
  diagnostics: DiagnosticSummary[];
  verdict?: FinalVerdict;
  resumable: boolean;
  resumable_reason?: ResumableReason;
  created_at: string;
  updated_at: string;
  finalized_at?: string;
  supersedes_review_id?: string;
}

export interface FinalLaneRecord {
  lane_id: string;
  role: 'code-reviewer' | 'architect';
  batch_id: string | 'global';
  scope_hash: string;
  status: LaneStatus;
  attempt: number;
  recommendation?: ReviewRecommendation;
  architectural_status?: ArchitectStatus;
  findings: ReviewFinding[];
  diagnostic_ids: string[];
  failure_code?: string;
}

/** The privacy-preserving, authoritative value written to `.omx/reviews`. */
export interface FinalReviewArtifact {
  schema_version: 1;
  review_id: string;
  revision: number;
  status: 'FINALIZED' | 'BLOCKED';
  current_attempt: number;
  scope?: ScopeManifest;
  review_flags: 'BATCHED_REVIEW'[];
  batches: ReviewBatch[];
  lanes: FinalLaneRecord[];
  diagnostics: Omit<DiagnosticSummary, 'thread_id'>[];
  verdict: FinalVerdict;
  created_at: string;
  updated_at: string;
  finalized_at: string;
  supersedes_review_id?: string;
}
