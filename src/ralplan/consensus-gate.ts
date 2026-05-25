import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RalplanConsensusGateEvidence {
  complete: boolean;
  sequence: ['architect-review', 'critic-review'];
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  source: string | null;
  blockedReason: string | null;
}

export interface RalplanConsensusSource {
  source: string;
  value: unknown;
}

export function buildRalplanConsensusGateFromSources(
  sources: RalplanConsensusSource[],
): RalplanConsensusGateEvidence {
  for (const candidate of sources) {
    const evidence = extractSequentialConsensusEvidence(candidate.value);
    if (evidence) {
      return {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: evidence.ralplan_architect_review,
        ralplan_critic_review: evidence.ralplan_critic_review,
        source: candidate.source,
        blockedReason: null,
      };
    }
  }

  return {
    complete: false,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: null,
    ralplan_critic_review: null,
    source: null,
    blockedReason: 'missing_sequential_architect_then_critic_approval',
  };
}

export function buildRalplanConsensusGateForCwd(
  cwd: string,
  options: { artifacts?: Record<string, unknown>; sessionId?: string } = {},
): RalplanConsensusGateEvidence {
  return buildRalplanConsensusGateFromSources([
    ...(options.artifacts ? [
      { source: 'stage-context-artifacts', value: options.artifacts },
      { source: 'stage-context-ralplan-artifact', value: options.artifacts.ralplan },
    ] : []),
    ...readLocalRalplanConsensusStateCandidates(cwd, options.sessionId),
  ]);
}

export function hasDurableRalplanConsensusEvidenceForCwd(
  cwd: string,
  options: { artifacts?: Record<string, unknown>; sessionId?: string } = {},
): boolean {
  return buildRalplanConsensusGateForCwd(cwd, options).complete === true;
}

export function readLocalRalplanConsensusStateCandidates(
  cwd: string,
  sessionId?: string,
): RalplanConsensusSource[] {
  const explicitSession = sessionId !== undefined;
  const sessionIdList = explicitSession ? validateLocalSessionId(sessionId) : readLocalCurrentSessionIds(cwd);
  if (explicitSession && sessionIdList.length === 0) return [];
  const stateRoots = sessionIdList.length > 0
    ? sessionIdList.map((id) => join(cwd, '.omx', 'state', 'sessions', id))
    : [join(cwd, '.omx', 'state')];

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

  const stateHandoffArtifacts = asRecord(asRecord(record.state)?.handoff_artifacts);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function isApproveReview(value: Record<string, unknown> | null, agentRole: 'architect' | 'critic'): value is Record<string, unknown> {
  if (!value || value.agent_role !== agentRole) return false;
  if (value.verdict !== undefined && value.verdict !== 'approve') return false;
  if (value.status !== undefined && !['approve', 'approved', 'clear', 'pass', 'passed'].includes(String(value.status).toLowerCase())) {
    return false;
  }
  if (value.recommendation !== undefined && !['approve', 'approved'].includes(String(value.recommendation).toLowerCase())) {
    return false;
  }
  if (hasBlockingReviewSignal(value)) return false;
  return value.verdict === 'approve' || value.approved === true || value.clean === true;
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
  const state = readJsonState(join(cwd, '.omx', 'state', 'session.json'));
  if (typeof state?.cwd === 'string' && state.cwd !== cwd) return [];
  const sessionId = typeof state?.session_id === 'string' ? state.session_id : undefined;
  return sessionId ? validateLocalSessionId(sessionId) : [];
}

function readJsonState(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
