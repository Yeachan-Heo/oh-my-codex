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
}

export function buildRalplanConsensusGateFromSources(
  sources: RalplanConsensusSource[],
  options: RalplanNativeSubagentConsensusOptions = {},
): RalplanConsensusGateEvidence {
  let nativeBlockedEvidence: {
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
    const evidence = extractSequentialConsensusEvidence(candidate.value);
    if (evidence) {
      if (
        options.requireNativeSubagents
        && !hasTrackerBackedNativeRalplanLanes(evidence, options)
      ) {
        nativeBlockedEvidence ??= { ...evidence, source: candidate.source };
        continue;
      }
      return {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: evidence.ralplan_architect_review,
        ralplan_critic_review: evidence.ralplan_critic_review,
        source: candidate.source,
        blockedReason: null,
      };
    }

    const invalidEvidence = extractInvalidCompleteConsensusEvidence(candidate.value);
    if (invalidEvidence) {
      invalidCompleteEvidence ??= { ...invalidEvidence, source: candidate.source };
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

  if (nativeBlockedEvidence) {
    return {
      complete: false,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: nativeBlockedEvidence.ralplan_architect_review,
      ralplan_critic_review: nativeBlockedEvidence.ralplan_critic_review,
      source: nativeBlockedEvidence.source,
      blockedReason: RALPLAN_CONSENSUS_BLOCKED_REASONS.nativeSubagentEvidenceMissing,
      blockedDetails: [
        trackerBackedNativeReviewProblem(nativeBlockedEvidence.ralplan_architect_review, 'architect', options),
        trackerBackedNativeReviewProblem(nativeBlockedEvidence.ralplan_critic_review, 'critic', options),
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
  return buildRalplanConsensusGateFromSources([
    ...(options.artifacts ? [
      { source: 'stage-context-artifacts', value: options.artifacts },
      { source: 'stage-context-ralplan-artifact', value: options.artifacts.ralplan },
    ] : []),
    ...readLocalRalplanConsensusStateCandidates(cwd, options.sessionId),
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
  const stateRoots = sessionIdList.length > 0
    ? uniquePaths(sessionIdList.flatMap((id) => [
      join(scopedStateDir, 'sessions', id),
      join(localStateDir, 'sessions', id),
    ]))
    : [localStateDir];

  const paths = stateRoots.flatMap((dir) => [
    join(dir, 'ralplan-state.json'),
    join(dir, 'autopilot-state.json'),
  ]);

  return paths.flatMap((path) => {
    const state = readJsonState(path);
    if (!state) return [];
    return [{ source: path, value: state }];
  });
}

function extractSequentialConsensusEvidence(value: unknown): {
  ralplan_architect_review: Record<string, unknown>;
  ralplan_critic_review: Record<string, unknown>;
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

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
      return { ralplan_architect_review: architectReview, ralplan_critic_review: criticReview };
    }
  }

  const handoffArtifactsAreStale = isReturnToRalplanCycle(record);
  const topLevelHandoffArtifacts = handoffArtifactsAreStale ? null : asRecord(record.handoff_artifacts);
  if (topLevelHandoffArtifacts) {
    const evidence = extractSequentialConsensusEvidence(topLevelHandoffArtifacts);
    if (evidence) return evidence;
  }

  const stateRecord = asRecord(record.state);
  const stateHandoffArtifacts = handoffArtifactsAreStale || (stateRecord && isReturnToRalplanCycle(stateRecord))
    ? null
    : asRecord(stateRecord?.handoff_artifacts);
  if (stateHandoffArtifacts) {
    const evidence = extractSequentialConsensusEvidence(stateHandoffArtifacts);
    if (evidence) return evidence;
  }

  const directArchitectReview = asRecord(record.ralplan_architect_review);
  const directCriticReview = asRecord(record.ralplan_critic_review);
  if (
    hasArchitectThenCriticSequence(record)
    && isApproveReview(directArchitectReview, 'architect')
    && isApproveReview(directCriticReview, 'critic')
    && isCriticNotBeforeArchitect(directArchitectReview, directCriticReview)
  ) {
    return {
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
    ) {
      return { ralplan_architect_review: architectReview, ralplan_critic_review: criticReview };
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
    ) {
      return { ralplan_architect_review: architectReview, ralplan_critic_review: criticReview };
    }
  }

  return null;
}

function extractInvalidCompleteConsensusEvidence(value: unknown): {
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  blockedDetails: string[];
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const gate = record.ralplanConsensusGate ?? record.ralplan_consensus_gate;
  if (gate && typeof gate === 'object') {
    const gateRecord = gate as Record<string, unknown>;
    const architectReview = asRecord(
      gateRecord.ralplan_architect_review ?? gateRecord.architectReview ?? gateRecord.architect_review,
    );
    const criticReview = asRecord(
      gateRecord.ralplan_critic_review ?? gateRecord.criticReview ?? gateRecord.critic_review,
    );
    if (gateRecord.complete === true && hasArchitectThenCriticSequence(gateRecord)) {
      const blockedDetails = [
        ...reviewApprovalProblems(architectReview, 'architect'),
        ...reviewApprovalProblems(criticReview, 'critic'),
      ];
      if (!isCriticNotBeforeArchitect(architectReview, criticReview)) {
        blockedDetails.push('critic review is ordered before architect review');
      }
      if (blockedDetails.length > 0) {
        return {
          ralplan_architect_review: architectReview,
          ralplan_critic_review: criticReview,
          blockedDetails,
        };
      }
    }
  }

  const stateHandoffArtifacts = asRecord(asRecord(record.state)?.handoff_artifacts);
  if (stateHandoffArtifacts) {
    const evidence = extractInvalidCompleteConsensusEvidence(stateHandoffArtifacts);
    if (evidence) return evidence;
  }

  return null;
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
  const architectThreadId = nativeReviewThreadId(evidence.ralplan_architect_review);
  const criticThreadId = nativeReviewThreadId(evidence.ralplan_critic_review);
  if (!architectThreadId || !criticThreadId || architectThreadId === criticThreadId) return false;
  return isTrackerBackedNativeReview(evidence.ralplan_architect_review, 'architect', options)
    && isTrackerBackedNativeReview(evidence.ralplan_critic_review, 'critic', options);
}

function nativeReviewThreadId(review: Record<string, unknown> | null): string {
  return typeof review?.thread_id === 'string' ? review.thread_id.trim() : '';
}

function isTrackerBackedNativeReview(
  review: Record<string, unknown> | null,
  agentRole: 'architect' | 'critic',
  options: RalplanNativeSubagentConsensusOptions,
): boolean {
  return trackerBackedNativeReviewProblem(review, agentRole, options) === null;
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
  const artifactPath = typeof review.artifact_path === 'string' ? review.artifact_path.trim() : '';
  const trackerPath = typeof review.tracker_path === 'string' ? review.tracker_path.trim() : '';
  if (!sessionId) issues.push(`${agentRole} review cannot resolve session_id`);
  if (!reviewSessionId || reviewSessionId !== sessionId) issues.push(`${agentRole} review session_id=${reviewSessionId || 'missing'} does not match ${sessionId || 'missing'}`);
  if (!threadId) issues.push(`${agentRole} review missing thread_id`);
  if (!artifactPath) issues.push(`${agentRole} review missing artifact_path`);
  if (!trackerPath || !trackerPath.endsWith('subagent-tracking.json')) issues.push(`${agentRole} review missing subagent-tracking.json tracker_path`);
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
