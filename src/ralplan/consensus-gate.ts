import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBaseStateDir, resolveWorkingDirectoryForState } from '../state/paths.js';



export const RALPLAN_CONSENSUS_BLOCKED_REASONS = {
  documentedHostConsensusReceiptUnavailable: 'documented_host_consensus_receipt_unavailable',
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


export function buildRalplanConsensusGateFromSources(
  sources: RalplanConsensusSource[],
  _options: RalplanNativeSubagentConsensusOptions = {},
): RalplanConsensusGateEvidence {
  // Tracker, transcripts, artifact fields, and agent types are lifecycle diagnostics.
  // They are all writable by the same user that requests this transition, so they
  // cannot serve as an authorization boundary. An official host receipt verifier is
  // required before any of this evidence can authorize a release.
  let lifecycleEvidence: (ConsensusResolution & { source: string }) | null = null;
  for (const candidate of sources) {
    const evidence = resolveConsensusEvidence(candidate.value);
    if (evidence && isConsensusEvidenceNewerThanSelected(evidence, lifecycleEvidence)) {
      lifecycleEvidence = { ...evidence, source: candidate.source };
    }
  }

  return {
    complete: false,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: lifecycleEvidence?.ralplan_architect_review ?? null,
    ralplan_critic_review: lifecycleEvidence?.ralplan_critic_review ?? null,
    source: lifecycleEvidence?.source ?? null,
    blockedReason: RALPLAN_CONSENSUS_BLOCKED_REASONS.documentedHostConsensusReceiptUnavailable,
    blockedDetails: ['official host consensus receipt verifier is unavailable'],
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
    && hasDistinctNativeReviewThreads(directArchitectReview, directCriticReview)
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
      && hasDistinctNativeReviewThreads(architectReview, criticReview)
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
      && hasDistinctNativeReviewThreads(architectReview, criticReview)
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
      && hasDistinctNativeReviewThreads(architectReview, criticReview)
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
        blockedDetails.push('direct review order is not proven strictly architect-before-critic');
      }
      if (!hasDistinctNativeReviewThreads(architectReview, criticReview)) {
        blockedDetails.push('consensus reviews must use distinct native_subagent thread_id values');
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
    if (evidenceOrder.domain !== selectedOrder.domain) return false;
    if (evidenceOrder.value !== selectedOrder.value) return evidenceOrder.value > selectedOrder.value;
  }

  return false;
}

function consensusEvidenceReviewCycle(evidence: ConsensusResolution): number | null {
  return maxKnownNumber(
    numericValue(evidence.ralplan_architect_review?.review_cycle ?? evidence.ralplan_architect_review?.reviewCycle),
    numericValue(evidence.ralplan_critic_review?.review_cycle ?? evidence.ralplan_critic_review?.reviewCycle),
  );
}

function consensusEvidenceOrder(evidence: ConsensusResolution): ReviewOrder | null {
  const architectOrder = reviewOrderValue(evidence.ralplan_architect_review ?? {});
  const criticOrder = reviewOrderValue(evidence.ralplan_critic_review ?? {});
  if (architectOrder === null) return criticOrder;
  if (criticOrder === null) return architectOrder;
  if (architectOrder.domain !== criticOrder.domain) return null;
  return architectOrder.value >= criticOrder.value ? architectOrder : criticOrder;
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

interface ReviewOrder {
  domain: 'sequence' | 'timestamp';
  value: number;
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


function reviewOrderValue(review: Record<string, unknown>): ReviewOrder | null {
  const sequence = reviewSequenceValue(review);
  if (sequence !== null) return { domain: 'sequence', value: sequence };
  const timestamp = reviewTimestampValue(review);
  return timestamp === null ? null : { domain: 'timestamp', value: timestamp };
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
