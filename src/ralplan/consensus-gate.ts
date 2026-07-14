import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE,
  readRoleRoutingMarker,
} from '../subagents/role-routing-marker.js';
import { subagentTrackingPath } from '../subagents/tracker.js';
import { getBaseStateDir, resolveWorkingDirectoryForState } from '../state/paths.js';



export const RALPLAN_CONSENSUS_BLOCKED_REASONS = {
  nativeSubagentEvidenceMissing: 'native_subagent_consensus_evidence_missing',
  nonApprovingReview: 'non_approving_ralplan_consensus_review',
  missingSequentialApproval: 'missing_sequential_architect_then_critic_approval',
} as const;

export type RalplanConsensusBlockedReason =
  typeof RALPLAN_CONSENSUS_BLOCKED_REASONS[keyof typeof RALPLAN_CONSENSUS_BLOCKED_REASONS];

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
} | {
  kind: 'invalid';
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  blockedDetails: string[];
};

type TrackerSnapshot = {
  trackerPath: string;
  tracking: Record<string, unknown> | null;
};

type TrackerBackedNativeLanesEvaluation = {
  snapshot: TrackerSnapshot | null;
  pairProblem: string | null;
  architectProblem: string | null;
  criticProblem: string | null;
  valid: boolean;
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
    trackerEvaluation: TrackerBackedNativeLanesEvaluation;
  } | null = null;
  let firstCompleteEvidence: (ConsensusResolution & { source: string }) | null = null;
  const trackerSnapshots = new Map<string, TrackerSnapshot>();

  for (const candidate of sources) {
    const evidence = resolveConsensusEvidence(candidate.value);
    const candidateOptions = {
      ...options,
      sessionId: options.sessionId ?? candidate.sessionId,
    };

    if (evidence?.kind === 'invalid') {
      if (isConsensusEvidenceNewerThanSelected(evidence, firstCompleteEvidence)) {
        firstCompleteEvidence = { ...evidence, source: candidate.source };
      }
      continue;
    }

    if (evidence?.kind === 'valid') {
      const requiresTrackerBackedLanes = options.requireNativeSubagents
        || evidence.ralplan_architect_review.provenance_kind === 'native_subagent'
        || evidence.ralplan_architect_review.provenance_kind === 'omx_adapted'
        || evidence.ralplan_critic_review.provenance_kind === 'native_subagent'
        || evidence.ralplan_critic_review.provenance_kind === 'omx_adapted';
      if (requiresTrackerBackedLanes) {
        const trackerEvaluation = evaluateTrackerBackedNativeRalplanLanes(evidence, candidateOptions, trackerSnapshots);
        if (!trackerEvaluation.valid) {
          nativeBlockedEvidence ??= {
            ...evidence,
            source: candidate.source,
            options: candidateOptions,
            trackerEvaluation,
          };
          continue;
        }
      }
      if (isConsensusEvidenceNewerThanSelected(evidence, firstCompleteEvidence)) {
        firstCompleteEvidence = { ...evidence, source: candidate.source };
      }
    }
  }

  if (firstCompleteEvidence?.kind === 'invalid') {
    return {
      complete: false,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: firstCompleteEvidence.ralplan_architect_review,
      ralplan_critic_review: firstCompleteEvidence.ralplan_critic_review,
      source: firstCompleteEvidence.source,
      blockedReason: RALPLAN_CONSENSUS_BLOCKED_REASONS.nonApprovingReview,
      blockedDetails: firstCompleteEvidence.blockedDetails,
    };
  }

  if (firstCompleteEvidence?.kind === 'valid') {
    return {
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: firstCompleteEvidence.ralplan_architect_review,
      ralplan_critic_review: firstCompleteEvidence.ralplan_critic_review,
      source: firstCompleteEvidence.source,
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
        nativeBlockedEvidence.trackerEvaluation.pairProblem,
        nativeBlockedEvidence.trackerEvaluation.architectProblem,
        nativeBlockedEvidence.trackerEvaluation.criticProblem,
      ].filter((detail): detail is string => Boolean(detail)),
      diagnostic: buildTrackerBackedNativeConsensusDiagnostic(
        nativeBlockedEvidence,
        nativeBlockedEvidence.options,
        nativeBlockedEvidence.trackerEvaluation,
      ),
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
  let deferredOrderedDirectGate: ConsensusResolution | null = null;
  if (directGate) {
    if (!returnToRalplanCycle) return directGate;
    if (advancedReviewCycle !== null) {
      if (reviewsCarryFreshnessCycle(directGate, advancedReviewCycle)) return directGate;
    } else if (!hasExplicitReturnToRalplanReviewCycle(record) && consensusEvidenceOrder(directGate) !== null) {
      deferredOrderedDirectGate = directGate;
    }
  }

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

  if (deferredOrderedDirectGate) return deferredOrderedDirectGate;

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
  return reviewPairCarriesFreshnessCycle(
    evidence.ralplan_architect_review,
    evidence.ralplan_critic_review,
    reviewCycle,
  );
}

function isConsensusEvidenceNewerThanSelected(
  evidence: ConsensusResolution,
  selected: (ConsensusResolution & { source: string }) | null,
): boolean {
  if (!selected) return true;
  const evidenceCycle = consensusEvidenceReviewCycle(evidence);
  const selectedCycle = consensusEvidenceReviewCycle(selected);
  if (evidenceCycle !== null || selectedCycle !== null) {
    if (selectedCycle === null) return true;
    if (evidenceCycle === null) return false;
    if (evidenceCycle !== selectedCycle) return evidenceCycle > selectedCycle;
  }

  const evidenceOrder = consensusEvidenceOrder(evidence);
  const selectedOrder = consensusEvidenceOrder(selected);
  if (evidenceOrder !== null || selectedOrder !== null) {
    if (selectedOrder === null) return true;
    if (evidenceOrder === null) return false;
    if (evidenceOrder !== selectedOrder) return evidenceOrder > selectedOrder;
  }

  return false;
}

function consensusEvidenceReviewCycle(evidence: ConsensusResolution): number | null {
  return maxKnownNumber(
    numericValue(evidence.ralplan_architect_review?.review_cycle ?? evidence.ralplan_architect_review?.reviewCycle),
    numericValue(evidence.ralplan_critic_review?.review_cycle ?? evidence.ralplan_critic_review?.reviewCycle),
  );
}

function consensusEvidenceOrder(evidence: ConsensusResolution): number | null {
  return maxKnownNumber(
    reviewOrderValue(evidence.ralplan_architect_review ?? {}),
    reviewOrderValue(evidence.ralplan_critic_review ?? {}),
  );
}

function maxKnownNumber(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function hasExplicitReturnToRalplanReviewCycle(record: Record<string, unknown>): boolean {
  return numericValue(record.review_cycle ?? record.reviewCycle) !== null
    || numericValue(record.return_to_ralplan_parent_review_cycle ?? record.returnToRalplanParentReviewCycle) !== null;
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

function evaluateTrackerBackedNativeRalplanLanes(
  evidence: {
    ralplan_architect_review: Record<string, unknown>;
    ralplan_critic_review: Record<string, unknown>;
  },
  options: RalplanNativeSubagentConsensusOptions,
  snapshots: Map<string, TrackerSnapshot>,
): TrackerBackedNativeLanesEvaluation {
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const trackerPaths = cwd
    ? uniquePaths([
      subagentTrackingPath(cwd),
      join(localBaseStateDir(cwd), 'subagent-tracking.json'),
    ])
    : [];
  let firstEvaluation: TrackerBackedNativeLanesEvaluation | null = null;

  for (const trackerPath of trackerPaths) {
    const snapshot = snapshots.get(trackerPath) ?? {
      trackerPath,
      tracking: readJsonState(trackerPath),
    };
    snapshots.set(trackerPath, snapshot);
    const evaluation = evaluateTrackerBackedNativeRalplanSnapshot(evidence, options, snapshot);
    if (evaluation.valid) return evaluation;
    firstEvaluation ??= evaluation;
  }

  return firstEvaluation ?? evaluateTrackerBackedNativeRalplanSnapshot(evidence, options, null);
}

function evaluateTrackerBackedNativeRalplanSnapshot(
  evidence: {
    ralplan_architect_review: Record<string, unknown>;
    ralplan_critic_review: Record<string, unknown>;
  },
  options: RalplanNativeSubagentConsensusOptions,
  snapshot: TrackerSnapshot | null,
): TrackerBackedNativeLanesEvaluation {
  const pairProblem = trackerBackedNativeReviewPairProblem(evidence, options, snapshot);
  const architectProblem = trackerBackedNativeReviewProblem(
    evidence.ralplan_architect_review,
    'architect',
    options,
    snapshot,
  );
  const criticProblem = trackerBackedNativeReviewProblem(
    evidence.ralplan_critic_review,
    'critic',
    options,
    snapshot,
  );
  return {
    snapshot,
    pairProblem,
    architectProblem,
    criticProblem,
    valid: !pairProblem && !architectProblem && !criticProblem,
  };
}

function nativeReviewThreadId(review: Record<string, unknown> | null): string {
  return typeof review?.thread_id === 'string' ? review.thread_id.trim() : '';
}

function currentTransitionSessionId(
  evidence: {
    ralplan_architect_review: Record<string, unknown> | null;
    ralplan_critic_review: Record<string, unknown> | null;
  },
  options: RalplanNativeSubagentConsensusOptions,
): string {
  const transitionSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  return transitionSessionId
    || nativeReviewSessionId(evidence.ralplan_architect_review)
    || nativeReviewSessionId(evidence.ralplan_critic_review);
}

function buildTrackerBackedNativeConsensusDiagnostic(
  evidence: {
    ralplan_architect_review: Record<string, unknown> | null;
    ralplan_critic_review: Record<string, unknown> | null;
  },
  options: RalplanNativeSubagentConsensusOptions,
  evaluation: TrackerBackedNativeLanesEvaluation,
): RalplanConsensusGateDiagnostic {
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const trackerPath = evaluation.snapshot?.trackerPath ?? (cwd ? subagentTrackingPath(cwd) : '.omx/state/subagent-tracking.json');
  const currentSessionId = currentTransitionSessionId(evidence, options);
  const architectThreadId = nativeReviewThreadId(evidence.ralplan_architect_review);
  const criticThreadId = nativeReviewThreadId(evidence.ralplan_critic_review);
  const adaptedLane = evidence.ralplan_architect_review?.provenance_kind === 'omx_adapted'
    || evidence.ralplan_critic_review?.provenance_kind === 'omx_adapted';

  return {
    expected_schema: [
      '.omx/state/subagent-tracking.json contains:',
      'sessions["<current_session_id>"].threads["<architect_thread_id>"].kind = "subagent"',
      'sessions["<current_session_id>"].threads["<critic_thread_id>"].kind = "subagent"',
      'both threads have completed_at; any recorded role identity must exactly match its review agent_role (native uses role or mode)',
      'architect and critic thread IDs are distinct',
      'architect completed_at is strictly before critic first_seen_at or started_at in the tracker ledger',
      ...(adaptedLane ? [
        `${NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE} contains unexpired evidence scoped to this cwd and session`,
      ] : []),
    ],
    current_session_id: currentSessionId || null,
    tracker_path: trackerPath,
    architect: buildNativeReviewDiagnostic(
      evidence.ralplan_architect_review,
      'architect',
      options,
      evaluation.snapshot,
      evaluation.architectProblem,
    ),
    critic: buildNativeReviewDiagnostic(
      evidence.ralplan_critic_review,
      'critic',
      options,
      evaluation.snapshot,
      evaluation.criticProblem,
    ),
    distinct_thread_ids: architectThreadId && criticThreadId ? architectThreadId !== criticThreadId : null,
    pair_problem: evaluation.pairProblem,
    remediation: adaptedLane
      ? [
        'Re-run native or OMX-adapted ralplan Architect/Critic reviews.',
        'Repair the review artifact so agent_role, provenance_kind, session_id, thread_id, and tracker_path point to completed tracker threads in the current session.',
      ]
      : [
        'Re-run native ralplan Architect/Critic reviews.',
        'Or repair the review artifact so agent_role, provenance_kind, session_id, thread_id, and tracker_path point to completed native subagent threads in the current tracker.',
      ],
    docs: 'docs/contracts/ralplan-consensus-gate.md',
  };
}

function buildNativeReviewDiagnostic(
  review: Record<string, unknown> | null,
  agentRole: 'architect' | 'critic',
  options: RalplanNativeSubagentConsensusOptions,
  snapshot: TrackerSnapshot | null,
  problem: string | null,
): RalplanNativeReviewDiagnostic {
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  const trackerPath = snapshot?.trackerPath ?? (cwd ? subagentTrackingPath(cwd) : '.omx/state/subagent-tracking.json');
  const sessionId = review
    ? (typeof options.sessionId === 'string' && options.sessionId.trim()
        ? options.sessionId.trim()
        : nativeReviewSessionId(review))
    : '';
  const threadId = nativeReviewThreadId(review);
  const session = asRecord(asRecord(snapshot?.tracking?.sessions)?.[sessionId]);
  const thread = asRecord(asRecord(session?.threads)?.[threadId]);
  const completedAt = typeof thread?.completed_at === 'string' ? thread.completed_at.trim() : '';
  return {
    role: agentRole,
    session_id: sessionId || null,
    thread_id: threadId || null,
    tracker_path: trackerPath,
    session_found: Boolean(session),
    thread_found: Boolean(thread),
    kind: typeof thread?.kind === 'string' ? thread.kind : null,
    completed: Boolean(completedAt),
    problem,
  };
}

function trackerBackedNativeReviewPairProblem(
  evidence: {
    ralplan_architect_review: Record<string, unknown> | null;
    ralplan_critic_review: Record<string, unknown> | null;
  },
  options: RalplanNativeSubagentConsensusOptions,
  snapshot: TrackerSnapshot | null,
): string | null {
  const architectThreadId = nativeReviewThreadId(evidence.ralplan_architect_review);
  const criticThreadId = nativeReviewThreadId(evidence.ralplan_critic_review);
  const adaptedLane = evidence.ralplan_architect_review?.provenance_kind === 'omx_adapted'
    || evidence.ralplan_critic_review?.provenance_kind === 'omx_adapted';
  if (architectThreadId && criticThreadId && architectThreadId === criticThreadId) {
    return adaptedLane
      ? 'architect and critic reviews must reference distinct tracker threads'
      : 'architect and critic reviews must reference distinct native subagent tracker threads';
  }

  const transitionSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  const architectSessionId = transitionSessionId || nativeReviewSessionId(evidence.ralplan_architect_review);
  const criticSessionId = transitionSessionId || nativeReviewSessionId(evidence.ralplan_critic_review);
  if (!architectSessionId || !criticSessionId) return null;
  if (architectSessionId !== criticSessionId) {
    return adaptedLane
      ? `architect and critic reviews must resolve to the same tracker session; architect session_id=${architectSessionId}, critic session_id=${criticSessionId}`
      : `architect and critic reviews must resolve to the same native subagent tracker session; architect session_id=${architectSessionId}, critic session_id=${criticSessionId}`;
  }
  return trackerBackedReviewOrderProblem(
    architectSessionId,
    architectThreadId,
    criticThreadId,
    snapshot,
    adaptedLane ? 'OMX-adapted' : 'native subagent',
  );
}

function trackerBackedReviewOrderProblem(
  sessionId: string,
  architectThreadId: string,
  criticThreadId: string,
  snapshot: TrackerSnapshot | null,
  laneLabel: string,
): string | null {
  if (!snapshot || !architectThreadId || !criticThreadId) {
    return `${laneLabel} tracker review order is missing architect or critic tracker evidence`;
  }

  const session = asRecord(asRecord(snapshot.tracking?.sessions)?.[sessionId]);
  const architectThread = asRecord(asRecord(session?.threads)?.[architectThreadId]);
  const criticThread = asRecord(asRecord(session?.threads)?.[criticThreadId]);
  const architectCompletedAt = trackerTimestamp(architectThread, ['completed_at']);
  const criticStartedAt = trackerTimestamp(criticThread, ['first_seen_at', 'started_at']);
  if (architectCompletedAt === null || criticStartedAt === null) {
    return `${laneLabel} tracker review order is missing valid architect completed_at or critic first_seen_at/started_at timestamp`;
  }
  if (architectCompletedAt >= criticStartedAt) {
    return `${laneLabel} tracker review order is reversed: architect completed_at must be strictly before critic first_seen_at/started_at`;
  }
  return null;
}

function trackerTimestamp(thread: Record<string, unknown> | null, keys: string[]): number | null {
  for (const key of keys) {
    const value = typeof thread?.[key] === 'string' ? thread[key].trim() : '';
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function nativeReviewSessionId(review: Record<string, unknown> | null): string {
  return typeof review?.session_id === 'string' ? review.session_id.trim() : '';
}

function trackerBackedNativeReviewProblem(
  review: Record<string, unknown> | null,
  agentRole: 'architect' | 'critic',
  options: RalplanNativeSubagentConsensusOptions,
  snapshot: TrackerSnapshot | null,
): string | null {
  const provenanceKind = review?.provenance_kind;
  return trackerBackedReviewProblem(
    review,
    agentRole,
    options,
    provenanceKind === 'omx_adapted' ? 'omx_adapted' : 'native_subagent',
    snapshot,
  );
}

function trackerBackedReviewProblem(
  review: Record<string, unknown> | null,
  agentRole: 'architect' | 'critic',
  options: RalplanNativeSubagentConsensusOptions,
  provenanceKind: 'native_subagent' | 'omx_adapted',
  snapshot: TrackerSnapshot | null,
): string | null {
  const issues: string[] = [];

  if (!review) return `${agentRole} review is missing`;
  if (review.agent_role !== agentRole) issues.push(`${agentRole} review has agent_role=${String(review.agent_role || 'missing')}`);
  if (review.provenance_kind !== provenanceKind) issues.push(`${agentRole} review has provenance_kind=${String(review.provenance_kind || 'missing')}`);
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
  if (provenanceKind === 'omx_adapted' && !hasScopedRoleRoutingUnavailableEvidence(cwd, sessionId)) {
    issues.push(`${agentRole} review lacks scoped role_routing_unavailable evidence for session ${sessionId || 'missing'}`);
  }

  if (issues.length > 0) return issues.join('; ');
  if (!snapshot) return `${agentRole} review cannot resolve tracker snapshot`;
  return trackerThreadProblem(
    snapshot.tracking,
    sessionId,
    threadId,
    agentRole,
    snapshot.trackerPath,
    options.cwd,
    provenanceKind,
  );
}

function hasScopedRoleRoutingUnavailableEvidence(cwd: string, sessionId: string): boolean {
  if (!cwd || !sessionId) return false;
  return uniquePaths([
    getBaseStateDir(cwd),
    localBaseStateDir(cwd),
  ]).some((baseStateDir) => readRoleRoutingMarker(baseStateDir, { cwd, sessionId }) !== null);
}

function trackerThreadProblem(
  tracking: Record<string, unknown> | null,
  sessionId: string,
  threadId: string,
  agentRole: 'architect' | 'critic',
  trackerPath: string,
  cwd: string | undefined,
  provenanceKind: 'native_subagent' | 'omx_adapted',
): string | null {
  const laneLabel = provenanceKind === 'native_subagent' ? 'native' : provenanceKind;

  const session = asRecord(asRecord(tracking?.sessions)?.[sessionId]);
  const thread = asRecord(asRecord(session?.threads)?.[threadId]);
  if (!session) return `${agentRole} tracker session ${sessionId} is missing in ${trackerPath}; only reviews recorded in OMX subagent-tracking.json count as ${laneLabel} lanes`;
  if (!thread) return `${agentRole} tracker thread ${threadId} is missing in ${trackerPath}; external/collab subagent reviews are not tracker-backed ${laneLabel} lanes`;
  const leaderThreadId = typeof session.leader_thread_id === 'string' ? session.leader_thread_id.trim() : '';
  const currentLeaderThreadId = currentSessionNativeLeaderThreadId(cwd);
  if (
    (currentLeaderThreadId && currentLeaderThreadId === threadId)
    || (leaderThreadId && leaderThreadId === threadId && thread.kind !== 'subagent')
  ) return `${agentRole} tracker thread ${threadId} is the session leader`;
  if (thread.kind !== 'subagent') return `${agentRole} tracker thread ${threadId} has kind=${String(thread.kind || 'missing')}`;
  const completedAt = typeof thread.completed_at === 'string' ? thread.completed_at.trim() : '';
  if (!completedAt) return `${agentRole} tracker thread ${threadId} is not completed`;
  const ledgerProvenance = typeof thread.provenance_kind === 'string' ? thread.provenance_kind.trim() : '';
  if (provenanceKind === 'omx_adapted' && ledgerProvenance !== 'omx_adapted') {
    return `${agentRole} tracker thread ${threadId} has provenance_kind=${ledgerProvenance || 'missing'}, expected omx_adapted`;
  }
  if (provenanceKind === 'native_subagent' && ledgerProvenance && ledgerProvenance !== 'native_subagent') {
    return `${agentRole} tracker thread ${threadId} has provenance_kind=${ledgerProvenance}, conflicting with native_subagent review provenance`;
  }
  const trackerRole = typeof thread.role === 'string' ? thread.role.trim() : '';
  const trackerMode = typeof thread.mode === 'string' ? thread.mode.trim() : '';
  const trackerRoleIdentity = trackerRole || (provenanceKind === 'native_subagent' ? trackerMode : '');
  if (provenanceKind === 'omx_adapted' && !trackerRoleIdentity) {
    return `${agentRole} tracker thread ${threadId} has role=missing, expected ${agentRole}`;
  }
  if (trackerRoleIdentity && trackerRoleIdentity !== agentRole) {
    return `${agentRole} tracker thread ${threadId} has ${trackerRole ? 'role' : 'mode'}=${trackerRoleIdentity}, expected ${agentRole}`;
  }
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
