import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { subagentTrackingPath } from '../subagents/tracker.js';
import { getBaseStateDir, resolveWorkingDirectoryForState } from '../state/paths.js';

export const RALPLAN_CONSENSUS_BLOCKED_REASONS = {
  nativeSubagentEvidenceMissing: 'native_subagent_consensus_evidence_missing',
  nonApprovingReview: 'non_approving_ralplan_consensus_review',
  missingSequentialApproval: 'missing_sequential_architect_then_critic_approval',
} as const;

export type RalplanConsensusBlockedReason =
  typeof RALPLAN_CONSENSUS_BLOCKED_REASONS[keyof typeof RALPLAN_CONSENSUS_BLOCKED_REASONS];

export interface RalplanConsensusGateEvidence {
  complete: boolean;
  sequence: ['architect-review', 'critic-review'];
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  source: string | null;
  blockedReason: RalplanConsensusBlockedReason | null;
  blockedDetails?: string[];
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
} | {
  kind: 'invalid';
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  blockedDetails: string[];
};

export function buildRalplanConsensusGateFromSources(
  sources: RalplanConsensusSource[],
  options: RalplanNativeSubagentConsensusOptions = {},
): RalplanConsensusGateEvidence {
  let nativeBlockedEvidence: {
    ralplan_architect_review: Record<string, unknown>;
    ralplan_critic_review: Record<string, unknown>;
    source: string;
    options: RalplanNativeSubagentConsensusOptions;
  } | null = null;
  let validEvidence: {
    ralplan_architect_review: Record<string, unknown>;
    ralplan_critic_review: Record<string, unknown>;
    source: string;
  } | null = null;
  let invalidCompleteEvidence: {
    ralplan_architect_review: Record<string, unknown> | null;
    ralplan_critic_review: Record<string, unknown> | null;
    source: string;
    blockedDetails: string[];
  } | null = null;

  for (const candidate of sources) {
    const evidence = resolveConsensusEvidence(candidate.value);
    const candidateOptions = {
      ...options,
      sessionId: options.sessionId ?? candidate.sessionId,
    };
    if (evidence?.kind === 'invalid') {
      invalidCompleteEvidence ??= { ...evidence, source: candidate.source };
      continue;
    }

    if (evidence?.kind === 'valid') {
      if (
        options.requireNativeSubagents
        && !hasTrackerBackedNativeRalplanLanes(evidence, candidateOptions)
      ) {
        nativeBlockedEvidence ??= { ...evidence, source: candidate.source, options: candidateOptions };
        continue;
      }
      validEvidence ??= { ...evidence, source: candidate.source };
    }
  }

  if (invalidCompleteEvidence) {
    return {
      complete: false,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: invalidCompleteEvidence.ralplan_architect_review,
      ralplan_critic_review: invalidCompleteEvidence.ralplan_critic_review,
      source: invalidCompleteEvidence.source,
      blockedReason: RALPLAN_CONSENSUS_BLOCKED_REASONS.nonApprovingReview,
      blockedDetails: invalidCompleteEvidence.blockedDetails,
    };
  }

  if (validEvidence) {
    return {
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: validEvidence.ralplan_architect_review,
      ralplan_critic_review: validEvidence.ralplan_critic_review,
      source: validEvidence.source,
      blockedReason: null,
    };
  }

  if (nativeBlockedEvidence) {
    return {
      complete: false,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: nativeBlockedEvidence.ralplan_architect_review,
      ralplan_critic_review: nativeBlockedEvidence.ralplan_critic_review,
      source: nativeBlockedEvidence.source,
      blockedReason: RALPLAN_CONSENSUS_BLOCKED_REASONS.nativeSubagentEvidenceMissing,
      blockedDetails: [
        trackerBackedNativeReviewPairProblem(nativeBlockedEvidence, nativeBlockedEvidence.options),
        trackerBackedNativeReviewProblem(nativeBlockedEvidence.ralplan_architect_review, 'architect', nativeBlockedEvidence.options),
        trackerBackedNativeReviewProblem(nativeBlockedEvidence.ralplan_critic_review, 'critic', nativeBlockedEvidence.options),
      ].filter((detail): detail is string => Boolean(detail)),
    };
  }

  return {
    complete: false,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: null,
    ralplan_critic_review: null,
    source: null,
    blockedReason: RALPLAN_CONSENSUS_BLOCKED_REASONS.missingSequentialApproval,
  };
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
      { source: 'stage-context-artifacts', value: options.artifacts },
      {
        source: 'stage-context-ralplan-artifact',
        value: withParentReturnToRalplanContext(options.artifacts.ralplan, options.artifacts),
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

  const returnToRalplanCycle = isReturnToRalplanCycle(record);
  const advancedReviewCycle = explicitFreshnessReviewCycle(record);
  const staleReturnToRalplanCycle = returnToRalplanCycle && advancedReviewCycle === null;
  const directGate = resolveDirectGate(record);
  if (directGate?.kind === 'invalid') return directGate;
  if (
    directGate
    && (
      !returnToRalplanCycle
      || (advancedReviewCycle !== null && reviewsCarryFreshnessCycle(directGate, advancedReviewCycle))
    )
  ) return directGate;

  const handoffArtifactsAreStale = staleReturnToRalplanCycle;
  const topLevelHandoffArtifacts = handoffArtifactsAreStale ? null : asRecord(record.handoff_artifacts);
  if (topLevelHandoffArtifacts) {
    const evidence = resolveConsensusEvidence(withParentReturnToRalplanContext(topLevelHandoffArtifacts, record));
    if (evidence) return evidence;
  }

  const stateRecord = asRecord(record.state);
  const stateHasOwnReturnLoopContext = stateRecord !== null && isReturnToRalplanCycle(stateRecord);
  const stateHandoffArtifacts = handoffArtifactsAreStale && !stateHasOwnReturnLoopContext
    ? null
    : asRecord(stateRecord?.handoff_artifacts);
  if (stateHandoffArtifacts) {
    const stateContext = stateHasOwnReturnLoopContext ? stateRecord : record;
    const evidence = resolveConsensusEvidence(withParentReturnToRalplanContext(stateHandoffArtifacts, stateContext));
    if (evidence) return evidence;
  }

  if (returnToRalplanCycle && advancedReviewCycle === null) return null;

  const directArchitectReview = asRecord(record.ralplan_architect_review);
  const directCriticReview = asRecord(record.ralplan_critic_review);
  if (
    hasArchitectThenCriticSequence(record)
    && isApproveReview(directArchitectReview, 'architect')
    && isApproveReview(directCriticReview, 'critic')
    && isCriticNotBeforeArchitect(directArchitectReview, directCriticReview)
    && (
      !returnToRalplanCycle
      || (advancedReviewCycle !== null && reviewPairCarriesFreshnessCycle(
        directArchitectReview,
        directCriticReview,
        advancedReviewCycle,
      ))
    )
  ) {
    return {
      kind: 'valid',
      ralplan_architect_review: directArchitectReview,
      ralplan_critic_review: directCriticReview,
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
      && isCriticNotBeforeArchitect(architectReview, criticReview)
      && (
        !returnToRalplanCycle
        || (advancedReviewCycle !== null && reviewPairCarriesFreshnessCycle(
          architectReview,
          criticReview,
          advancedReviewCycle,
        ))
      )
    ) {
      return { kind: 'valid', ralplan_architect_review: architectReview, ralplan_critic_review: criticReview };
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
      && isCriticNotBeforeArchitect(architectReview, criticReview)
      && (
        !returnToRalplanCycle
        || (advancedReviewCycle !== null && reviewPairCarriesFreshnessCycle(
          architectReview,
          criticReview,
          advancedReviewCycle,
        ))
      )
    ) {
      return { kind: 'valid', ralplan_architect_review: architectReview, ralplan_critic_review: criticReview };
    }
  }

  return null;
}

function resolveDirectGate(record: Record<string, unknown>): ConsensusResolution | null {
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
      && isCriticNotBeforeArchitect(architectReview, criticReview)
    ) {
      return {
        kind: 'valid',
        ralplan_architect_review: architectReview,
        ralplan_critic_review: criticReview,
      };
    }

    if (gateRecord.complete === true) {
      const blockedDetails = [
        ...reviewApprovalProblems(architectReview, 'architect'),
        ...reviewApprovalProblems(criticReview, 'critic'),
      ];
      if (!hasArchitectThenCriticSequence(gateRecord)) {
        blockedDetails.push('consensus review sequence is not architect-review then critic-review');
      }
      if (!isCriticNotBeforeArchitect(architectReview, criticReview)) {
        blockedDetails.push('critic review is ordered before architect review');
      }
      if (blockedDetails.length > 0) {
        return {
          kind: 'invalid',
          ralplan_architect_review: architectReview,
          ralplan_critic_review: criticReview,
          blockedDetails,
        };
      }
    }
  }

  return null;
}

export function withParentReturnToRalplanContext(value: unknown, parent: Record<string, unknown>): unknown {
  const reason = parent.return_to_ralplan_reason ?? parent.returnToRalplanReason;
  if (typeof reason !== 'string' || reason.trim() === '' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
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
    current_phase: parent.current_phase ?? parent.currentPhase ?? 'ralplan',
    return_to_ralplan_reason: reason,
    return_to_ralplan_parent_review_cycle: parentReviewCycle,
  };
}

function explicitFreshnessReviewCycle(record: Record<string, unknown>): number | null {
  const parentReviewCycle = numericValue(
    record.return_to_ralplan_parent_review_cycle ?? record.returnToRalplanParentReviewCycle,
  );
  const candidateReviewCycle = numericValue(record.review_cycle ?? record.reviewCycle);
  return parentReviewCycle !== null
    && candidateReviewCycle !== null
    && candidateReviewCycle > parentReviewCycle
    ? candidateReviewCycle
    : null;
}

function reviewsCarryFreshnessCycle(evidence: ConsensusResolution, reviewCycle: number): boolean {
  return evidence.kind === 'valid'
    && reviewPairCarriesFreshnessCycle(
      evidence.ralplan_architect_review,
      evidence.ralplan_critic_review,
      reviewCycle,
    );
}

function reviewPairCarriesFreshnessCycle(
  architectReview: Record<string, unknown> | null,
  criticReview: Record<string, unknown> | null,
  reviewCycle: number,
): boolean {
  return reviewCarriesFreshnessCycle(architectReview, reviewCycle)
    && reviewCarriesFreshnessCycle(criticReview, reviewCycle);
}

function reviewCarriesFreshnessCycle(review: Record<string, unknown> | null, reviewCycle: number): boolean {
  const cycle = numericValue(review?.review_cycle ?? review?.reviewCycle);
  return cycle !== null && cycle >= reviewCycle;
}

function numericValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function isApproveReview(value: Record<string, unknown> | null, agentRole: 'architect' | 'critic'): value is Record<string, unknown> {
  if (!value || value.agent_role !== agentRole) return false;
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

function reviewApprovalProblems(value: Record<string, unknown> | null, agentRole: 'architect' | 'critic'): string[] {
  const issues: string[] = [];
  if (!value) return [`${agentRole} review is missing`];
  if (value.agent_role !== agentRole) issues.push(`${agentRole} review has agent_role=${String(value.agent_role || 'missing')}`);
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
  const architectOrder = reviewOrderValue(architectReview);
  const criticOrder = reviewOrderValue(criticReview);
  return architectOrder === null || criticOrder === null || criticOrder >= architectOrder;
}

function reviewOrderValue(review: Record<string, unknown>): number | null {
  for (const key of ['completed_at', 'created_at', 'updated_at', 'timestamp', 'ts']) {
    const raw = review[key];
    if (typeof raw !== 'string') continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  for (const key of ['sequence_index', 'order', 'review_order', 'iteration']) {
    const raw = review[key];
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hasTrackerBackedNativeRalplanLanes(
  evidence: {
    ralplan_architect_review: Record<string, unknown>;
    ralplan_critic_review: Record<string, unknown>;
  },
  options: RalplanNativeSubagentConsensusOptions,
): boolean {
  if (trackerBackedNativeReviewPairProblem(evidence, options)) return false;
  return isTrackerBackedNativeReview(evidence.ralplan_architect_review, 'architect', options)
    && isTrackerBackedNativeReview(evidence.ralplan_critic_review, 'critic', options);
}

function nativeReviewThreadId(review: Record<string, unknown> | null): string {
  return typeof review?.thread_id === 'string' ? review.thread_id.trim() : '';
}

function trackerBackedNativeReviewPairProblem(
  evidence: {
    ralplan_architect_review: Record<string, unknown> | null;
    ralplan_critic_review: Record<string, unknown> | null;
  },
  options: RalplanNativeSubagentConsensusOptions,
): string | null {
  const architectThreadId = nativeReviewThreadId(evidence.ralplan_architect_review);
  const criticThreadId = nativeReviewThreadId(evidence.ralplan_critic_review);
  if (architectThreadId && criticThreadId && architectThreadId === criticThreadId) {
    return 'architect and critic reviews must reference distinct native subagent tracker threads';
  }

  const transitionSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  const architectSessionId = transitionSessionId || nativeReviewSessionId(evidence.ralplan_architect_review);
  const criticSessionId = transitionSessionId || nativeReviewSessionId(evidence.ralplan_critic_review);
  if (!architectSessionId || !criticSessionId) return null;
  return architectSessionId === criticSessionId
    ? null
    : `architect and critic reviews must resolve to the same native subagent tracker session; architect session_id=${architectSessionId}, critic session_id=${criticSessionId}`;
}

function isTrackerBackedNativeReview(
  review: Record<string, unknown> | null,
  agentRole: 'architect' | 'critic',
  options: RalplanNativeSubagentConsensusOptions,
): boolean {
  return trackerBackedNativeReviewProblem(review, agentRole, options) === null;
}

function nativeReviewSessionId(review: Record<string, unknown> | null): string {
  return typeof review?.session_id === 'string' ? review.session_id.trim() : '';
}

function trackerBackedNativeReviewProblem(
  review: Record<string, unknown> | null,
  agentRole: 'architect' | 'critic',
  options: RalplanNativeSubagentConsensusOptions,
): string | null {
  const issues: string[] = [];

  if (!review) return `${agentRole} review is missing`;
  if (review.agent_role !== agentRole) issues.push(`${agentRole} review has agent_role=${String(review.agent_role || 'missing')}`);
  if (review.provenance_kind !== 'native_subagent') issues.push(`${agentRole} review has provenance_kind=${String(review.provenance_kind || 'missing')}`);
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim()
    ? options.sessionId.trim()
    : typeof review.session_id === 'string'
      ? review.session_id.trim()
      : '';
  const reviewSessionId = typeof review.session_id === 'string' ? review.session_id.trim() : '';
  const threadId = typeof review.thread_id === 'string' ? review.thread_id.trim() : '';
  const trackerPath = typeof review.tracker_path === 'string' ? review.tracker_path.trim() : '';
  if (!sessionId) issues.push(`${agentRole} review cannot resolve session_id`);
  if (reviewSessionId && reviewSessionId !== sessionId) issues.push(`${agentRole} review session_id=${reviewSessionId} does not match ${sessionId || 'missing'}`);
  if (!threadId) issues.push(`${agentRole} review missing thread_id`);
  if (trackerPath && !trackerPath.endsWith('subagent-tracking.json')) issues.push(`${agentRole} review tracker_path=${trackerPath} is not subagent-tracking.json`);
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  if (!cwd) issues.push(`${agentRole} review cannot resolve cwd for tracker lookup`);

  if (issues.length > 0) return issues.join('; ');

  const expectedTrackerPath = subagentTrackingPath(cwd);
  const tracking = readJsonState(expectedTrackerPath);
  const session = asRecord(asRecord(tracking?.sessions)?.[sessionId]);
  const thread = asRecord(asRecord(session?.threads)?.[threadId]);
  if (!session) return `${agentRole} tracker session ${sessionId} is missing in ${expectedTrackerPath}; only reviews recorded in OMX subagent-tracking.json count as native lanes`;
  if (!thread) return `${agentRole} tracker thread ${threadId} is missing in ${expectedTrackerPath}; external/collab subagent reviews are not tracker-backed native lanes`;
  const leaderThreadId = typeof session.leader_thread_id === 'string' ? session.leader_thread_id.trim() : '';
  const currentLeaderThreadId = currentSessionNativeLeaderThreadId(options.cwd);
  if (
    (currentLeaderThreadId && currentLeaderThreadId === threadId)
    || (leaderThreadId && leaderThreadId === threadId && thread.kind !== 'subagent')
  ) return `${agentRole} tracker thread ${threadId} is the session leader`;
  if (thread.kind !== 'subagent') return `${agentRole} tracker thread ${threadId} has kind=${String(thread.kind || 'missing')}`;
  const completedAt = typeof thread.completed_at === 'string' ? thread.completed_at.trim() : '';
  if (!completedAt) return `${agentRole} tracker thread ${threadId} is not completed`;
  return null;
}

function currentSessionNativeLeaderThreadId(cwd: string | undefined): string {
  if (!cwd) return '';
  const sessionState = readJsonState(join(getBaseStateDir(cwd), 'session.json'));
  return typeof sessionState?.native_session_id === 'string' ? sessionState.native_session_id.trim() : '';
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
