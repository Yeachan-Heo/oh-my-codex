import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBaseStateDir, resolveWorkingDirectoryForState } from '../state/paths.js';
import {
  CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS,
  getCodexHostConsensusVerifierReadiness,
  type RalplanHostConsensusReceiptVerifierCapability,
} from './host-consensus-receipt.js';



export const RALPLAN_CONSENSUS_BLOCKED_REASONS = {
  documentedHostConsensusReceiptUnavailable:
    CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.documentedHostConsensusReceiptUnavailable,
  nativeSubagentEvidenceMissing: 'native_subagent_consensus_evidence_missing',
  nonApprovingReview: 'non_approving_ralplan_consensus_review',
  missingSequentialApproval: 'missing_sequential_architect_then_critic_approval',
} as const;

export type RalplanConsensusBlockedReason =
  typeof RALPLAN_CONSENSUS_BLOCKED_REASONS[keyof typeof RALPLAN_CONSENSUS_BLOCKED_REASONS];

export type RalplanAuthorityPolicy = 'local_owner_lifecycle' | 'official_host_receipt';

/**
 * Package-level authority policy for this OMX fork. This is deliberately not
 * selected from repository state, environment variables, or receipt-shaped
 * user input.
 */
export const RALPLAN_AUTHORITY_POLICY: RalplanAuthorityPolicy = 'local_owner_lifecycle';

export type { RalplanHostConsensusReceiptVerifierCapability } from './host-consensus-receipt.js';

/**
 * Reports whether this host can verify the official receipt that authorizes a
 * Ralplan handoff. Local lifecycle artifacts remain diagnostics either way.
 */
export function getRalplanHostConsensusReceiptVerifierCapability(): RalplanHostConsensusReceiptVerifierCapability {
  return getCodexHostConsensusVerifierReadiness().capability;
}

export function shouldBlockFreshAutopilotForRalplanReceipt(
  capability: RalplanHostConsensusReceiptVerifierCapability = getRalplanHostConsensusReceiptVerifierCapability(),
): boolean {
  return getRalplanAuthorityPolicy() === 'official_host_receipt' && capability === 'unavailable';
}

export function getRalplanAuthorityPolicy(): RalplanAuthorityPolicy {
  return RALPLAN_AUTHORITY_POLICY;
}

export interface RalplanNativeReviewDiagnostic {
  role: 'architect' | 'critic';
  session_id: string | null;
  thread_id: string | null;
  tracker_path: string;
  session_found: boolean;
  thread_found: boolean;
  kind: string | null;
  completed: boolean;
  problem: string | null;
}

export interface RalplanConsensusGateDiagnostic {
  expected_schema: string[];
  current_session_id: string | null;
  tracker_path: string;
  architect: RalplanNativeReviewDiagnostic;
  critic: RalplanNativeReviewDiagnostic;
  distinct_thread_ids: boolean | null;
  pair_problem: string | null;
  remediation: string[];
  docs: string;
}

export interface RalplanConsensusGateEvidence {
  complete: boolean;
  authority_policy: 'local_owner_lifecycle' | null;
  sequence: ['architect-review', 'critic-review'];
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  source: string | null;
  blockedReason: RalplanConsensusBlockedReason | null;
  blockedDetails?: string[];
  diagnostic?: RalplanConsensusGateDiagnostic;
}

export interface RalplanNativeSubagentConsensusOptions {
  requireNativeSubagents?: boolean;
  cwd?: string;
  sessionId?: string;
}

export interface RalplanConsensusSource {
  source: string;
  value: unknown;
  sessionId?: string;
}

type ConsensusResolution = {
  kind: 'valid';
  ralplan_architect_review: Record<string, unknown>;
  ralplan_critic_review: Record<string, unknown>;
  passBoundary: ConsensusPassBoundary;
} | {
  kind: 'invalid';
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  blockedDetails: string[];
  passBoundary: ConsensusPassBoundary;
};

interface ConsensusPassBoundary {
  timestamp: string | null;
  problem: string | null;
}

export function buildRalplanConsensusGateFromSources(
  sources: RalplanConsensusSource[],
  options: RalplanNativeSubagentConsensusOptions = {},
): RalplanConsensusGateEvidence {
  let lifecycleEvidence: (ConsensusResolution & { source: string; sessionId?: string }) | null = null;
  for (const candidate of sources) {
    const evidence = resolveConsensusEvidence(candidate.value);
    if (evidence && !lifecycleEvidence) {
      lifecycleEvidence = {
        ...evidence,
        source: candidate.source,
        ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      };
    }
  }

  if (lifecycleEvidence?.kind === 'valid') {
    const blockedDetails = nativeSubagentTrackingProblems(lifecycleEvidence, options);
    if (blockedDetails.length > 0) {
      lifecycleEvidence = {
        kind: 'invalid',
        ralplan_architect_review: lifecycleEvidence.ralplan_architect_review,
        ralplan_critic_review: lifecycleEvidence.ralplan_critic_review,
        blockedDetails,
        passBoundary: lifecycleEvidence.passBoundary,
        source: lifecycleEvidence.source,
        ...(lifecycleEvidence.sessionId ? { sessionId: lifecycleEvidence.sessionId } : {}),
      };
    }
  }

  const complete = lifecycleEvidence?.kind === 'valid';
  const blockedReason = complete ? null : consensusBlockedReason(lifecycleEvidence);
  return {
    complete,
    authority_policy: complete ? 'local_owner_lifecycle' : null,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: lifecycleEvidence?.ralplan_architect_review ?? null,
    ralplan_critic_review: lifecycleEvidence?.ralplan_critic_review ?? null,
    source: lifecycleEvidence?.source ?? null,
    blockedReason,
    ...(lifecycleEvidence?.kind === 'invalid'
      ? { blockedDetails: lifecycleEvidence.blockedDetails }
      : {}),
  };
}

function consensusBlockedReason(
  evidence: (ConsensusResolution & { source: string; sessionId?: string }) | null,
): RalplanConsensusBlockedReason {
  if (!evidence) return RALPLAN_CONSENSUS_BLOCKED_REASONS.nativeSubagentEvidenceMissing;
  if (evidence.kind === 'valid') {
    return RALPLAN_CONSENSUS_BLOCKED_REASONS.missingSequentialApproval;
  }
  if (evidence.blockedDetails.some((detail) =>
    /not approve|blocking signal|lacks approving evidence/i.test(detail))) {
    return RALPLAN_CONSENSUS_BLOCKED_REASONS.nonApprovingReview;
  }
  if (evidence.blockedDetails.some((detail) =>
    /native tracker|provenance_kind|thread_id|agent_role=.*missing/i.test(detail))) {
    return RALPLAN_CONSENSUS_BLOCKED_REASONS.nativeSubagentEvidenceMissing;
  }
  return RALPLAN_CONSENSUS_BLOCKED_REASONS.missingSequentialApproval;
}

export function buildRalplanConsensusGateForCwd(
  cwd: string,
  options: { artifacts?: Record<string, unknown>; sessionId?: string; requireNativeSubagents?: boolean } = {},
): RalplanConsensusGateEvidence {
  const localStateCandidates = readLocalRalplanConsensusStateCandidates(cwd, options.sessionId)
    .map((candidate) => ({
      ...candidate,
      value: options.artifacts
        ? withParentReturnToRalplanContext(candidate.value, options.artifacts)
        : candidate.value,
    }));
  return buildRalplanConsensusGateFromSources([
    ...(options.artifacts ? [
      { source: 'stage-context-artifacts', value: options.artifacts, sessionId: options.sessionId },
      {
        source: 'stage-context-ralplan-artifact',
        value: withParentReturnToRalplanContext(options.artifacts.ralplan, options.artifacts),
        sessionId: options.sessionId,
      },
    ] : []),
    ...localStateCandidates,
  ], {
    cwd,
    sessionId: options.sessionId,
    requireNativeSubagents: options.requireNativeSubagents,
  });
}

export function hasDurableRalplanConsensusEvidenceForCwd(
  cwd: string,
  options: { artifacts?: Record<string, unknown>; sessionId?: string; requireNativeSubagents?: boolean } = {},
): boolean {
  return buildRalplanConsensusGateForCwd(cwd, options).complete === true;
}

export function readLocalRalplanConsensusStateCandidates(
  cwd: string,
  sessionId?: string,
): RalplanConsensusSource[] {
  const explicitSession = sessionId !== undefined;
  const sessionIdList = explicitSession ? validateLocalSessionId(sessionId) : readLocalCurrentSessionIds(cwd);
  const scopedStateDir = getBaseStateDir(cwd);
  const localStateDir = localBaseStateDir(cwd);
  if (explicitSession && sessionIdList.length === 0) return [];
  const stateRoots: Array<{ dir: string; sessionId?: string }> = sessionIdList.length > 0
    ? uniquePaths(sessionIdList.flatMap((id) => [
      join(scopedStateDir, 'sessions', id),
      join(localStateDir, 'sessions', id),
    ])).map((dir) => ({
      dir,
      sessionId: sessionIdFromStateRoot(dir),
    }))
    : [{ dir: localStateDir }];

  const paths = stateRoots.flatMap(({ dir, sessionId }) => [
    { path: join(dir, 'ralplan-state.json'), sessionId },
    { path: join(dir, 'autopilot-state.json'), sessionId },
  ]);

  return paths.flatMap(({ path, sessionId }) => {
    const state = readJsonState(path);
    if (!state) return [];
    return [{ source: path, value: state, sessionId }];
  });
}

function resolveConsensusEvidence(value: unknown): ConsensusResolution | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const passBoundary = consensusPassBoundary(record);

  const directGate = resolveDirectGate(record, passBoundary);
  if (directGate) return directGate;

  const topLevelHandoffArtifacts = asRecord(record.handoff_artifacts);
  if (topLevelHandoffArtifacts) {
    const evidence = resolveConsensusEvidence(withParentReturnToRalplanContext(topLevelHandoffArtifacts, record));
    if (evidence) return evidence;
  }

  const stateRecord = asRecord(record.state);
  const stateHasOwnReturnLoopContext = stateRecord !== null && isReturnToRalplanCycle(stateRecord);
  const stateHandoffArtifacts = asRecord(stateRecord?.handoff_artifacts);
  if (stateHandoffArtifacts) {
    const stateContext = stateHasOwnReturnLoopContext ? stateRecord : record;
    const evidence = resolveConsensusEvidence(withParentReturnToRalplanContext(stateHandoffArtifacts, stateContext));
    if (evidence) return evidence;
  }

  const directArchitectReview = asRecord(record.ralplan_architect_review);
  const directCriticReview = asRecord(record.ralplan_critic_review);
  if (
    hasArchitectThenCriticSequence(record)
    && isApproveReview(directArchitectReview, 'architect')
    && isApproveReview(directCriticReview, 'critic')
    && hasDistinctNativeReviewThreads(directArchitectReview, directCriticReview)
    && isCriticNotBeforeArchitect(directArchitectReview, directCriticReview)
  ) {
    return {
      kind: 'valid',
      ralplan_architect_review: directArchitectReview,
      ralplan_critic_review: directCriticReview,
      passBoundary,
    };
  }

  const reviewHistory = Array.isArray(record.review_history) ? record.review_history : [];
  const latestReviewEntry = asRecord(reviewHistory.at(-1));
  if (latestReviewEntry) {
    const architectReview = asRecord(
      latestReviewEntry.ralplan_architect_review ?? latestReviewEntry.architect_review ?? latestReviewEntry.architectReview,
    );
    const criticReview = asRecord(
      latestReviewEntry.ralplan_critic_review ?? latestReviewEntry.critic_review ?? latestReviewEntry.criticReview,
    );
    if (
      isApproveReview(architectReview, 'architect')
      && isApproveReview(criticReview, 'critic')
      && hasDistinctNativeReviewThreads(architectReview, criticReview)
      && isCriticNotBeforeArchitect(architectReview, criticReview)
    ) {
      return { kind: 'valid', ralplan_architect_review: architectReview, ralplan_critic_review: criticReview, passBoundary };
    }
  }

  const architectReviews = Array.isArray(record.architectReviews) ? record.architectReviews : [];
  const criticReviews = Array.isArray(record.criticReviews) ? record.criticReviews : [];
  if (architectReviews.length > 0 && criticReviews.length > 0 && architectReviews.length === criticReviews.length) {
    const architectReview = asRecord(architectReviews.at(-1));
    const criticReview = asRecord(criticReviews.at(-1));
    if (
      isApproveReview(architectReview, 'architect')
      && isApproveReview(criticReview, 'critic')
      && hasDistinctNativeReviewThreads(architectReview, criticReview)
      && isCriticNotBeforeArchitect(architectReview, criticReview)
    ) {
      return { kind: 'valid', ralplan_architect_review: architectReview, ralplan_critic_review: criticReview, passBoundary };
    }
  }

  return null;
}

function resolveDirectGate(
  record: Record<string, unknown>,
  passBoundary: ConsensusPassBoundary,
): ConsensusResolution | null {
  const gate = record.ralplanConsensusGate ?? record.ralplan_consensus_gate;
  if (gate && typeof gate === 'object') {
    const gateRecord = gate as Record<string, unknown>;
    const architectReview = asRecord(
      gateRecord.ralplan_architect_review ?? gateRecord.architectReview ?? gateRecord.architect_review,
    );
    const criticReview = asRecord(
      gateRecord.ralplan_critic_review ?? gateRecord.criticReview ?? gateRecord.critic_review,
    );
    if (
      gateRecord.complete === true
      && hasArchitectThenCriticSequence(gateRecord)
      && isApproveReview(architectReview, 'architect')
      && isApproveReview(criticReview, 'critic')
      && hasDistinctNativeReviewThreads(architectReview, criticReview)
      && isCriticNotBeforeArchitect(architectReview, criticReview)
    ) {
      return {
        kind: 'valid',
        ralplan_architect_review: architectReview,
        ralplan_critic_review: criticReview,
        passBoundary,
      };
    }

    if (hasDirectGateLifecycleEvidence(gateRecord, architectReview, criticReview)) {
      const blockedDetails = [
        ...reviewApprovalProblems(architectReview, 'architect'),
        ...reviewApprovalProblems(criticReview, 'critic'),
      ];
      if (gateRecord.complete !== true) {
        blockedDetails.push('consensus gate is incomplete');
      }
      if (!hasArchitectThenCriticSequence(gateRecord)) {
        blockedDetails.push('consensus review sequence is not architect-review then critic-review');
      }
      if (!isCriticNotBeforeArchitect(architectReview, criticReview)) {
        blockedDetails.push('direct review order is structurally contradictory or incomplete');
      }
      if (!hasDistinctNativeReviewThreads(architectReview, criticReview)) {
        blockedDetails.push('consensus reviews must use distinct native_subagent thread_id values');
      }
      return {
        kind: 'invalid',
        ralplan_architect_review: architectReview,
        ralplan_critic_review: criticReview,
        blockedDetails,
        passBoundary,
      };
    }
  }

  return null;
}

function hasDirectGateLifecycleEvidence(
  gate: Record<string, unknown>,
  architectReview: Record<string, unknown> | null,
  criticReview: Record<string, unknown> | null,
): boolean {
  return typeof gate.complete === 'boolean'
    || architectReview !== null
    || criticReview !== null
    || Array.isArray(gate.sequence);
}

function nativeSubagentTrackingProblems(
  evidence: ConsensusResolution & { source: string; sessionId?: string },
  options: RalplanNativeSubagentConsensusOptions,
): string[] {
  const issues: string[] = [];
  if (evidence.passBoundary.problem) issues.push(evidence.passBoundary.problem);
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (!cwd) issues.push('native tracker cwd is missing');
  if (!sessionId || validateLocalSessionId(sessionId).length === 0) {
    issues.push('native tracker session_id is missing or invalid');
  }
  if (evidence.sessionId && evidence.sessionId !== sessionId) {
    issues.push(`native tracker source session_id=${evidence.sessionId} does not match current session_id=${sessionId || 'missing'}`);
  }

  for (const [role, review] of [
    ['architect', evidence.ralplan_architect_review],
    ['critic', evidence.ralplan_critic_review],
  ] as const) {
    const reviewSessionId = trimmedString(review?.session_id ?? review?.sessionId);
    if (reviewSessionId && reviewSessionId !== sessionId) {
      issues.push(`native tracker ${role} review session_id=${reviewSessionId} does not match current session_id=${sessionId || 'missing'}`);
    }
  }

  if (!cwd || !sessionId || validateLocalSessionId(sessionId).length === 0) return issues;
  const trackerPath = join(getBaseStateDir(cwd), 'subagent-tracking.json');
  if (!existsSync(trackerPath)) {
    issues.push(`native tracker is missing at ${trackerPath}`);
    return issues;
  }

  const tracker = readJsonState(trackerPath);
  const sessions = asRecord(tracker?.sessions);
  const session = asRecord(sessions?.[sessionId]);
  if (tracker?.schemaVersion !== 1 || !sessions || !session || session.session_id !== sessionId) {
    issues.push(`native tracker session_id=${sessionId} is missing or malformed`);
    return issues;
  }
  const threads = asRecord(session.threads);
  if (!threads) {
    issues.push(`native tracker session_id=${sessionId} has no thread records`);
    return issues;
  }

  const completionTimes: Partial<Record<'architect' | 'critic', number>> = {};
  for (const [role, review] of [
    ['architect', evidence.ralplan_architect_review],
    ['critic', evidence.ralplan_critic_review],
  ] as const) {
    const threadId = trimmedString(review?.thread_id ?? review?.threadId);
    const thread = threadId ? asRecord(threads[threadId]) : null;
    if (!threadId || !thread || thread.thread_id !== threadId) {
      issues.push(`native tracker ${role} thread_id=${threadId || 'missing'} is not tracked in session_id=${sessionId}`);
      continue;
    }
    if (thread.kind !== 'subagent') {
      issues.push(`native tracker ${role} thread_id=${threadId} kind=${String(thread.kind || 'missing')} is not subagent`);
    }
    if (thread.provenance_kind !== 'native_subagent') {
      issues.push(`native tracker ${role} thread_id=${threadId} provenance_kind=${String(thread.provenance_kind || 'missing')} is not native_subagent`);
    }
    const trackedRole = trimmedString(thread.role ?? thread.mode);
    if (trackedRole !== role) {
      issues.push(`native tracker ${role} thread_id=${threadId} role=${trackedRole || 'missing'} is not ${role}`);
    }
    const trackedCompletedAt = trimmedString(thread.completed_at);
    if (!trackedCompletedAt) {
      issues.push(`native tracker ${role} thread_id=${threadId} has no completion evidence`);
      continue;
    }
    const trackedCompletionTime = timestampValue(trackedCompletedAt);
    if (trackedCompletionTime === null) {
      issues.push(`native tracker ${role} thread_id=${threadId} completed_at is invalid`);
      continue;
    }
    completionTimes[role] = trackedCompletionTime;

    const reviewCompletedAt = trimmedString(review?.completed_at ?? review?.completedAt);
    if (!reviewCompletedAt) {
      issues.push(`${role} review completed_at is missing and cannot be bound to native tracker completion`);
    } else if (reviewCompletedAt !== trackedCompletedAt) {
      issues.push(`${role} review completed_at=${reviewCompletedAt} does not exactly match native tracker completed_at=${trackedCompletedAt}`);
    }
  }

  const architectCompletedAt = completionTimes.architect;
  const criticCompletedAt = completionTimes.critic;
  if (architectCompletedAt !== undefined && criticCompletedAt !== undefined) {
    if (criticCompletedAt <= architectCompletedAt) {
      issues.push('native tracker completion order is not strictly architect-before-critic');
    }
    const passStartedAt = evidence.passBoundary.timestamp
      ? timestampValue(evidence.passBoundary.timestamp)
      : null;
    if (passStartedAt !== null) {
      if (architectCompletedAt < passStartedAt) {
        issues.push('native tracker architect completion predates ralplan_pass_started_at');
      }
      if (criticCompletedAt < passStartedAt) {
        issues.push('native tracker critic completion predates ralplan_pass_started_at');
      }
    }
  }

  return issues;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function withParentReturnToRalplanContext(value: unknown, parent: Record<string, unknown>): unknown {
  const reason = parent.return_to_ralplan_reason ?? parent.returnToRalplanReason;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const parentBoundary = consensusPassBoundary(parent);
  const hasReturnReason = typeof reason === 'string' && reason.trim() !== '';
  const parentReviewCycle = numericValue(
    parent.return_to_ralplan_parent_review_cycle
      ?? parent.returnToRalplanParentReviewCycle
      ?? parent.review_cycle
      ?? parent.reviewCycle,
  );
  const inheritedReviewCycle = record.review_cycle ?? record.reviewCycle ?? parent.review_cycle ?? parent.reviewCycle;
  return {
    ...record,
    review_cycle: inheritedReviewCycle,
    ...(hasReturnReason ? {
      current_phase: parent.current_phase ?? parent.currentPhase ?? 'ralplan',
      return_to_ralplan_reason: reason,
      return_to_ralplan_parent_review_cycle: parentReviewCycle,
    } : {}),
    ralplan_pass_started_at:
      record.ralplan_pass_started_at
      ?? record.ralplanPassStartedAt
      ?? parent.ralplan_pass_started_at
      ?? parent.ralplanPassStartedAt
      ?? parentBoundary.timestamp
      ?? undefined,
  };
}

function consensusPassBoundary(record: Record<string, unknown>): ConsensusPassBoundary {
  const explicitRaw = record.ralplan_pass_started_at ?? record.ralplanPassStartedAt;
  const explicit = trimmedString(explicitRaw);
  if (explicitRaw !== undefined) {
    return timestampValue(explicit) === null
      ? { timestamp: null, problem: 'ralplan_pass_started_at is missing or invalid' }
      : { timestamp: explicit, problem: null };
  }

  const reviewCycle = numericValue(record.review_cycle ?? record.reviewCycle);
  const requiresExplicitBoundary = isReturnToRalplanCycle(record)
    || (reviewCycle !== null && reviewCycle > 1);
  if (requiresExplicitBoundary) {
    return {
      timestamp: null,
      problem: 'current return-to-Ralplan pass requires explicit ralplan_pass_started_at freshness boundary',
    };
  }

  const initialStartedAt = trimmedString(record.started_at ?? record.startedAt);
  if (timestampValue(initialStartedAt) === null) {
    return {
      timestamp: null,
      problem: 'initial Ralplan pass requires started_at or ralplan_pass_started_at freshness boundary',
    };
  }
  return { timestamp: initialStartedAt, problem: null };
}

function numericValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function isApproveReview(value: Record<string, unknown> | null, agentRole: 'architect' | 'critic'): value is Record<string, unknown> {
  if (!value || value.agent_role !== agentRole || value.provenance_kind !== 'native_subagent') return false;
  if (value.verdict !== undefined && value.verdict !== 'approve') return false;
  if (value.status !== undefined && !isApprovedStatus(value.status)) {
    return false;
  }
  if (value.recommendation !== undefined && !isApproveRecommendation(value.recommendation)) {
    return false;
  }
  if (hasBlockingReviewSignal(value)) return false;
  return hasPositiveReviewApprovalSignal(value);
}

function hasDistinctNativeReviewThreads(
  architectReview: Record<string, unknown> | null,
  criticReview: Record<string, unknown> | null,
): boolean {
  const architectThreadId = typeof architectReview?.thread_id === 'string' ? architectReview.thread_id.trim() : '';
  const criticThreadId = typeof criticReview?.thread_id === 'string' ? criticReview.thread_id.trim() : '';
  return Boolean(architectThreadId) && Boolean(criticThreadId) && architectThreadId !== criticThreadId;
}

/**
 * Non-authoritative structural check used while assembling a lifecycle record.
 * A true result never grants local-owner authority; the authoritative gate also
 * requires current-session tracker binding, pass freshness, and tracker order.
 */
export function hasNonAuthoritativeStructurallyOrderedRalplanReviewPair(
  architectReviewValue: unknown,
  criticReviewValue: unknown,
): boolean {
  const architectReview = asRecord(architectReviewValue);
  const criticReview = asRecord(criticReviewValue);
  return isApproveReview(architectReview, 'architect')
    && isApproveReview(criticReview, 'critic')
    && hasDistinctNativeReviewThreads(architectReview, criticReview)
    && isCriticNotBeforeArchitect(architectReview, criticReview);
}

function reviewApprovalProblems(value: Record<string, unknown> | null, agentRole: 'architect' | 'critic'): string[] {
  const issues: string[] = [];
  if (!value) return [`${agentRole} review is missing`];
  if (value.agent_role !== agentRole) issues.push(`${agentRole} review has agent_role=${String(value.agent_role || 'missing')}`);
  if (value.provenance_kind !== 'native_subagent') {
    issues.push(`${agentRole} review provenance_kind=${String(value.provenance_kind || 'missing')} is not native_subagent`);
  }
  if (value.verdict !== undefined && value.verdict !== 'approve') {
    issues.push(`${agentRole} review verdict=${String(value.verdict)} is not approve`);
  }
  if (value.status !== undefined && !isApprovedStatus(value.status)) {
    issues.push(`${agentRole} review status=${String(value.status)} is not approve`);
  }
  if (value.recommendation !== undefined && !isApproveRecommendation(value.recommendation)) {
    issues.push(`${agentRole} review recommendation=${String(value.recommendation)} is not approve`);
  }
  if (issues.length === 0 && hasBlockingReviewSignal(value)) {
    issues.push(`${agentRole} review has a blocking signal`);
  }
  if (issues.length === 0 && !hasPositiveReviewApprovalSignal(value)) {
    issues.push(`${agentRole} review lacks approving evidence`);
  }
  return issues;
}

function hasPositiveReviewApprovalSignal(value: Record<string, unknown>): boolean {
  return value.verdict === 'approve' || value.approved === true || value.clean === true;
}

function isApprovedStatus(value: unknown): boolean {
  return ['approve', 'approved', 'clear', 'pass', 'passed'].includes(String(value).toLowerCase());
}

function isApproveRecommendation(value: unknown): boolean {
  return ['approve', 'approved'].includes(String(value).toLowerCase());
}

function hasArchitectThenCriticSequence(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.sequence)) return true;
  return value.sequence[0] === 'architect-review' && value.sequence[1] === 'critic-review';
}

function isCriticNotBeforeArchitect(
  architectReview: Record<string, unknown> | null,
  criticReview: Record<string, unknown> | null,
): boolean {
  if (!architectReview || !criticReview) return false;

  const architectSequence = reviewSequenceValue(architectReview);
  const criticSequence = reviewSequenceValue(criticReview);
  if (architectSequence !== null || criticSequence !== null) {
    if (architectSequence === null || criticSequence === null || criticSequence <= architectSequence) return false;
    const architectTimestamp = reviewTimestampValue(architectReview);
    const criticTimestamp = reviewTimestampValue(criticReview);
    return architectTimestamp === null || criticTimestamp === null || criticTimestamp > architectTimestamp;
  }

  const architectTimestamp = reviewTimestampValue(architectReview);
  const criticTimestamp = reviewTimestampValue(criticReview);
  return architectTimestamp !== null && criticTimestamp !== null && criticTimestamp > architectTimestamp;
}

function reviewSequenceValue(review: Record<string, unknown>): number | null {
  for (const key of ['sequence_index', 'order', 'review_order']) {
    const raw = review[key];
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function reviewTimestampValue(review: Record<string, unknown>): number | null {
  for (const key of ['completed_at', 'created_at', 'updated_at', 'timestamp', 'ts']) {
    const raw = review[key];
    if (typeof raw !== 'string') continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}


function validateLocalSessionId(sessionId: string): string[] {
  return /^[A-Za-z0-9_-]{1,64}$/.test(sessionId) ? [sessionId] : [];
}

function hasBlockingReviewSignal(value: Record<string, unknown>): boolean {
  if (value.blocked === true || value.blocking === true || value.clean === false || value.rejected === true) return true;
  if (value.request_changes === true || value.requestChanges === true || value.requires_changes === true || value.requiresChanges === true) return true;
  for (const key of ['verdict', 'status', 'recommendation', 'result']) {
    const raw = value[key];
    if (raw === undefined) continue;
    const normalized = String(raw).toLowerCase().replace(/[\s-]+/g, '_');
    if ([
      'reject',
      'rejected',
      'block',
      'blocked',
      'blocking',
      'request_changes',
      'requested_changes',
      'changes_requested',
      'needs_changes',
      'iterate',
      'iterating',
      'revise',
      'revision_required',
    ].includes(normalized)) {
      return true;
    }
  }
  return false;
}

function readLocalCurrentSessionIds(cwd: string): string[] {
  const state = readJsonState(join(getBaseStateDir(cwd), 'session.json'));
  if (typeof state?.cwd === 'string' && state.cwd !== cwd) return [];
  const sessionId = typeof state?.session_id === 'string' ? state.session_id : undefined;
  return sessionId ? validateLocalSessionId(sessionId) : [];
}

function localBaseStateDir(cwd: string): string {
  return join(resolveWorkingDirectoryForState(cwd), '.omx', 'state');
}

function sessionIdFromStateRoot(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  const match = /\/sessions\/([^/]+)$/.exec(normalized);
  const sessionId = match?.[1];
  return sessionId && validateLocalSessionId(sessionId).length > 0 ? sessionId : undefined;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isReturnToRalplanCycle(record: Record<string, unknown>): boolean {
  const currentPhase = String(record.current_phase ?? record.currentPhase ?? '').toLowerCase();
  const reason = record.return_to_ralplan_reason ?? record.returnToRalplanReason;
  return currentPhase === 'ralplan'
    && typeof reason === 'string'
    && reason.trim().length > 0;
}

function readJsonState(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
