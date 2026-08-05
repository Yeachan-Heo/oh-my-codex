import {
  cancelMode,
  readModeState,
  readModeStateForExplicitSession,
  startMode,
  updateModeState,
} from '../modes/base.js';
import { readSubagentTrackingState, recordSubagentTurnForSession } from '../subagents/tracker.js';
import { isPlanningComplete, readPlanningArtifacts } from '../planning/artifacts.js';
import {
  buildRalplanConsensusGateFromSources,
  hasNonAuthoritativeStructurallyOrderedRalplanReviewPair,
} from './consensus-gate.js';

export const RALPLAN_ACTIVE_PHASES = [
  'draft',
  'architect-review',
  'critic-review',
  'complete',
] as const;

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
  completed_at?: string;
}

export interface RalplanConsensusGate {
  required: true;
  complete: boolean;
  authority_policy: 'local_owner_lifecycle' | null;
  sequence: ['architect-review', 'critic-review'];
  planning_artifacts_are_not_consensus: true;
  required_review_roles: ['architect', 'critic'];
  ralplan_architect_review: (RalplanReviewResult & { agent_role: 'architect'; iteration: number }) | null;
  ralplan_critic_review: (RalplanReviewResult & { agent_role: 'critic'; iteration: number }) | null;
  architect_review: (RalplanReviewResult & { agent_role: 'architect'; iteration: number }) | null;
  critic_review: (RalplanReviewResult & { agent_role: 'critic'; iteration: number }) | null;
  blocked_reason: string | null;
}

export interface RalplanConsensusIterationContext {
  task: string;
  cwd: string;
  iteration: number;
  priorDrafts: RalplanDraftResult[];
  architectReviews: RalplanReviewResult[];
  criticReviews: RalplanReviewResult[];
  reusableRoleLanes: {
    architect?: RalplanReusableRoleLane;
    critic?: RalplanReusableRoleLane;
  };
}

export interface RalplanConsensusExecutor {
  draft(ctx: RalplanConsensusIterationContext): Promise<RalplanDraftResult>;
  architectReview(
    ctx: RalplanConsensusIterationContext & { draft: RalplanDraftResult },
  ): Promise<RalplanReviewResult>;
  criticReview(
    ctx: RalplanConsensusIterationContext & {
      draft: RalplanDraftResult;
      architectReview: RalplanReviewResult;
    },
  ): Promise<RalplanReviewResult>;
}

export interface RunRalplanConsensusOptions {
  task: string;
  cwd?: string;
  maxIterations?: number;
  sessionId?: string;
  requireNativeSubagents?: boolean;
  selectedExecutionLane?: RalplanExecutionLane;
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
}

interface RalplanModeUpdates {
  active?: boolean;
  current_phase?: string;
  completed_at?: string;
  error?: string;
  planning_complete?: boolean;
  iteration?: number;
  latest_plan_path?: string;
  latest_draft_summary?: string;
  latest_architect_verdict?: RalplanReviewVerdict;
  latest_architect_summary?: string;
  latest_critic_verdict?: RalplanReviewVerdict;
  latest_critic_summary?: string;
  ralplan_consensus_gate?: RalplanConsensusGate;
  status_message?: string;
  review_history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function buildReviewHistory(
  drafts: RalplanDraftResult[],
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const total = Math.max(drafts.length, architectReviews.length, criticReviews.length);
  for (let index = 0; index < total; index++) {
    entries.push({
      iteration: index + 1,
      draft: drafts[index] ?? null,
      architect_review: architectReviews[index] ?? null,
      critic_review: criticReviews[index] ?? null,
    });
  }
  return entries;
}

async function recordRalplanSubagentTurn(
  cwd: string,
  sessionId: string | undefined,
  input: {
    threadId?: string;
    laneId?: string;
    scope?: string;
    summary?: string;
  },
): Promise<void> {
  const normalizedSessionId = sessionId?.trim();
  const normalizedThreadId = input.threadId?.trim();
  if (!normalizedSessionId || !normalizedThreadId) return;

  await recordSubagentTurnForSession(cwd, {
    sessionId: normalizedSessionId,
    threadId: normalizedThreadId,
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.summary?.trim() ? { lastHandoffSummary: input.summary.trim() } : {}),
    preserveCompletionEvidence: true,
    kind: 'subagent',
  }).catch(() => {});
}

function isApprovingReviewPair(
  architectReview: RalplanReviewResult | undefined,
  criticReview: RalplanReviewResult | undefined,
): boolean {
  if (
    architectReview?.verdict !== 'approve'
    || criticReview?.verdict !== 'approve'
    || architectReview.agent_role !== 'architect'
    || criticReview.agent_role !== 'critic'
  ) return false;
  const architectThreadId = architectReview.thread_id?.trim();
  const criticThreadId = criticReview.thread_id?.trim();
  return architectReview.provenance_kind === 'native_subagent'
    && criticReview.provenance_kind === 'native_subagent'
    && Boolean(architectThreadId)
    && Boolean(criticThreadId)
    && architectThreadId !== criticThreadId;
}

function reviewBlocker(
  architectReview: RalplanReviewResult | undefined,
  criticReview: RalplanReviewResult | undefined,
  strictOrderComplete = false,
): string | null {
  if (architectReview?.verdict !== 'approve') return 'architect_review_missing_or_not_approved';
  if (criticReview?.verdict !== 'approve') return 'critic_review_missing_or_not_approved';
  if (!isApprovingReviewPair(architectReview, criticReview)) {
    return 'native_subagent_consensus_evidence_missing';
  }
  if (!strictOrderComplete) return 'missing_sequential_architect_then_critic_approval';
  return null;
}

function buildRalplanConsensusGate(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
  options: { cwd: string; sessionId?: string; ralplanPassStartedAt?: string },
): RalplanConsensusGate {
  const latestArchitect = architectReviews.at(-1);
  const latestCritic = criticReviews.at(-1);
  const ralplanArchitectReview = latestArchitect
    ? {
      ...latestArchitect,
      agent_role: 'architect' as const,
      iteration: architectReviews.length,
    }
    : null;
  const ralplanCriticReview = latestCritic
    ? {
      ...latestCritic,
      agent_role: 'critic' as const,
      iteration: criticReviews.length,
    }
    : null;
  const strictOrderComplete = hasNonAuthoritativeStructurallyOrderedRalplanReviewPair(
    ralplanArchitectReview,
    ralplanCriticReview,
  );
  const structuralBlockedReason = reviewBlocker(
    latestArchitect,
    latestCritic,
    strictOrderComplete,
  );
  const authoritativeGate = ralplanArchitectReview && ralplanCriticReview
    ? buildRalplanConsensusGateFromSources([{
      source: 'ralplan-runtime',
      sessionId: options.sessionId,
      value: {
        ralplan_pass_started_at: options.ralplanPassStartedAt,
        ralplan_consensus_gate: {
          complete: structuralBlockedReason === null,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: ralplanArchitectReview,
          ralplan_critic_review: ralplanCriticReview,
        },
      },
    }], {
      cwd: options.cwd,
      sessionId: options.sessionId,
      requireNativeSubagents: true,
    })
    : null;
  const blockedReason = structuralBlockedReason
    ?? (authoritativeGate?.complete
      ? null
      : authoritativeGate?.blockedReason ?? 'native_subagent_consensus_evidence_missing');
  return {
    required: true,
    complete: blockedReason === null,
    authority_policy: blockedReason === null ? 'local_owner_lifecycle' : null,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: ralplanArchitectReview,
    ralplan_critic_review: ralplanCriticReview,
    architect_review: ralplanArchitectReview,
    critic_review: ralplanCriticReview,
    blocked_reason: blockedReason,
  };
}

function hasNativeSubagentEvidence(review: RalplanReviewResult): boolean {
  return review.provenance_kind === 'native_subagent';
}

function normalizeReviewForLane(
  review: RalplanReviewResult,
  laneRole: 'architect' | 'critic',
  requireNativeSubagents: boolean,
): RalplanReviewResult {
  if (requireNativeSubagents) {
    if (!review.agent_role) {
      throw new Error(`ralplan_${laneRole}_review_role_missing: expected agent_role=${laneRole}`);
    }
    if (review.agent_role !== laneRole) {
      throw new Error(`ralplan_${laneRole}_review_role_mismatch: expected agent_role=${laneRole}, received ${review.agent_role}`);
    }
    if (!hasNativeSubagentEvidence(review)) {
      throw new Error(`ralplan_${laneRole}_review_provenance_invalid: expected provenance_kind=native_subagent`);
    }
    if (!review.thread_id?.trim()) {
      throw new Error(`ralplan_${laneRole}_review_thread_missing: native_subagent review must declare thread_id`);
    }
  } else if (review.provenance_kind !== undefined && !hasNativeSubagentEvidence(review)) {
    throw new Error(`ralplan_${laneRole}_review_provenance_invalid: adapted provenance cannot authorize a review lane`);
  }
  return { ...review, agent_role: laneRole };
}

async function hydrateReviewCompletionFromTracker(
  cwd: string,
  sessionId: string | undefined,
  review: RalplanReviewResult,
  role: 'architect' | 'critic',
): Promise<RalplanReviewResult> {
  if (review.completed_at !== undefined || !sessionId || !review.thread_id) return review;
  const thread = (await readSubagentTrackingState(cwd)).sessions[sessionId]?.threads[review.thread_id];
  if (
    thread?.kind !== 'subagent'
    || thread.role !== role
    || thread.provenance_kind !== 'native_subagent'
    || !nonEmptyString(thread.completed_at)
  ) return review;
  return { ...review, completed_at: thread.completed_at };
}



function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function latestCompatibleRoleLane(
  reviews: RalplanReviewResult[],
  role: 'architect' | 'critic',
  sessionId?: string,
): RalplanReusableRoleLane | undefined {
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const review = reviews[index];
    if (review.agent_role !== role) continue;
    if (!nonEmptyString(review.thread_id) && !nonEmptyString(review.lane_id)) continue;
    const reviewSessionId = nonEmptyString(review.session_id);
    if (sessionId && reviewSessionId && reviewSessionId !== sessionId) continue;
    return {
      agent_role: role,
      ...(nonEmptyString(review.thread_id) ? { thread_id: nonEmptyString(review.thread_id) } : {}),
      ...(nonEmptyString(review.lane_id) ? { lane_id: nonEmptyString(review.lane_id) } : {}),
      ...(reviewSessionId ? { session_id: reviewSessionId } : {}),
      ...(nonEmptyString(review.native_session_id) ? { native_session_id: nonEmptyString(review.native_session_id) } : {}),
      ...(nonEmptyString(review.tracker_path) ? { tracker_path: nonEmptyString(review.tracker_path) } : {}),
    };
  }
  return undefined;
}

function assertRoleLaneReuse(
  priorLane: RalplanReusableRoleLane | undefined,
  review: RalplanReviewResult,
  role: 'architect' | 'critic',
): void {
  if (!priorLane) return;
  if (review.agent_role !== role) return;
  const priorThreadId = nonEmptyString(priorLane.thread_id);
  const nextThreadId = nonEmptyString(review.thread_id);
  const priorLaneId = nonEmptyString(priorLane.lane_id);
  const nextLaneId = nonEmptyString(review.lane_id);
  const reusedThread = priorThreadId && nextThreadId && priorThreadId === nextThreadId;
  const reusedLane = priorLaneId && nextLaneId && priorLaneId === nextLaneId;
  if (reusedThread || reusedLane) return;
  if (nonEmptyString(review.new_lane_reason)) return;
  if ((priorThreadId || priorLaneId) && (nextThreadId || nextLaneId)) {
    throw new Error(`ralplan_${role}_lane_reuse_required`);
  }
}


async function updateRalplanState(
  cwd: string,
  sessionId: string | undefined,
  updates: RalplanModeUpdates,
): Promise<void> {
  await updateModeState('ralplan', updates, cwd, sessionId);
}

export async function runRalplanConsensus(
  executor: RalplanConsensusExecutor,
  options: RunRalplanConsensusOptions,
): Promise<RalplanRuntimeResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxIterations = options.maxIterations ?? 5;
  const drafts: RalplanDraftResult[] = [];
  const architectReviews: RalplanReviewResult[] = [];
  const criticReviews: RalplanReviewResult[] = [];
  const aggregatedArtifacts: Record<string, unknown> = {};
  let latestPlanPath: string | undefined;
  let iteration = 1;
  let reviewEventSequence = 0;

  const requestedSessionId = nonEmptyString(options.sessionId);
  const existing = requestedSessionId
    ? await readModeStateForExplicitSession('ralplan', requestedSessionId, cwd)
    : await readModeState('ralplan', cwd);
  if (existing?.active) {
    throw new Error('ralplan_active_mode_exists');
  }

  const startedState = await startMode('ralplan', options.task, maxIterations, cwd, requestedSessionId);
  const effectiveSessionId = requestedSessionId ?? nonEmptyString(startedState.session_id);
  const gateOptions = {
    cwd,
    sessionId: effectiveSessionId,
    ralplanPassStartedAt: nonEmptyString(startedState.ralplan_pass_started_at),
  };

  try {
    while (iteration <= maxIterations) {
      const reusableRoleLanes = {
        architect: latestCompatibleRoleLane(architectReviews, 'architect', effectiveSessionId),
        critic: latestCompatibleRoleLane(criticReviews, 'critic', effectiveSessionId),
      };
      const iterationContext: RalplanConsensusIterationContext = {
        task: options.task,
        cwd,
        iteration,
        priorDrafts: [...drafts],
        architectReviews: [...architectReviews],
        criticReviews: [...criticReviews],
        reusableRoleLanes,
      };

      await updateRalplanState(cwd, effectiveSessionId, {
        iteration,
        current_phase: 'draft',
        planning_complete: false,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const draft = await executor.draft(iterationContext);
      drafts.push(draft);
      if (draft.artifacts) Object.assign(aggregatedArtifacts, draft.artifacts);
      if (draft.planPath) latestPlanPath = draft.planPath;
      await recordRalplanSubagentTurn(cwd, effectiveSessionId, {
        threadId: draft.thread_id,
        laneId: draft.lane_id,
        scope: options.task,
        summary: draft.summary,
      });

      await updateRalplanState(cwd, effectiveSessionId, {
        iteration,
        current_phase: 'architect-review',
        latest_plan_path: latestPlanPath,
        latest_draft_summary: draft.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      reviewEventSequence += 1;
      let architectReview = normalizeReviewForLane(await executor.architectReview({
        ...iterationContext,
        draft,
      }), 'architect', true);
      architectReview = await hydrateReviewCompletionFromTracker(
        cwd,
        effectiveSessionId,
        architectReview,
        'architect',
      );
      architectReview.sequence_index ??= reviewEventSequence;
      if (architectReview.sequence_index !== undefined && Number.isFinite(architectReview.sequence_index)) {
        reviewEventSequence = Math.max(reviewEventSequence, architectReview.sequence_index);
      }
      assertRoleLaneReuse(reusableRoleLanes.architect, architectReview, 'architect');
      architectReviews.push(architectReview);
      if (architectReview.artifacts) Object.assign(aggregatedArtifacts, architectReview.artifacts);
      await recordRalplanSubagentTurn(cwd, effectiveSessionId, {
        threadId: architectReview.thread_id,
        laneId: architectReview.lane_id,
        scope: options.task,
        summary: architectReview.summary,
      });

      if (architectReview.verdict !== 'approve') {
        const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
        const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions);
        await updateRalplanState(cwd, effectiveSessionId, {
          iteration,
          current_phase: 'architect-review',
          latest_architect_verdict: architectReview.verdict,
          latest_architect_summary: architectReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
        });

        if (iteration >= maxIterations) {
          const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
          await updateRalplanState(cwd, effectiveSessionId, {
            active: false,
            iteration,
            current_phase: 'failed',
            completed_at: new Date().toISOString(),
            planning_complete: false,
            latest_plan_path: latestPlanPath,
            latest_architect_verdict: architectReview.verdict,
            latest_architect_summary: architectReview.summary,
            ralplan_consensus_gate: consensusGate,
            review_history: reviewHistory,
            status_message: `Status: paused_for_review — ralplan reached the ${maxIterations}-iteration review limit without Architect approval; continue from the best current artifact or ask the user how to proceed.`,
            error,
          });
          return {
            status: 'failed',
            iteration,
            phase: 'failed',
            planningComplete: false,
            drafts,
            architectReviews,
            criticReviews,
            ralplanConsensusGate: consensusGate,
            latestPlanPath,
            artifacts: aggregatedArtifacts,
            error,
          };
        }

        iteration += 1;
        continue;
      }

      await updateRalplanState(cwd, effectiveSessionId, {
        iteration,
        current_phase: 'critic-review',
        latest_architect_verdict: architectReview.verdict,
        latest_architect_summary: architectReview.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      reviewEventSequence += 1;
      let criticReview = normalizeReviewForLane(await executor.criticReview({
        ...iterationContext,
        draft,
        architectReview,
      }), 'critic', true);
      criticReview = await hydrateReviewCompletionFromTracker(
        cwd,
        effectiveSessionId,
        criticReview,
        'critic',
      );
      criticReview.sequence_index ??= reviewEventSequence;
      if (criticReview.sequence_index !== undefined && Number.isFinite(criticReview.sequence_index)) {
        reviewEventSequence = Math.max(reviewEventSequence, criticReview.sequence_index);
      }
      assertRoleLaneReuse(reusableRoleLanes.critic, criticReview, 'critic');
      criticReviews.push(criticReview);
      if (criticReview.artifacts) Object.assign(aggregatedArtifacts, criticReview.artifacts);
      await recordRalplanSubagentTurn(cwd, effectiveSessionId, {
        threadId: criticReview.thread_id,
        laneId: criticReview.lane_id,
        scope: options.task,
        summary: criticReview.summary,
      });

      const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
      const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions);
      const planningArtifactsComplete = isPlanningComplete(readPlanningArtifacts(cwd));
      await updateRalplanState(cwd, effectiveSessionId, {
        iteration,
        current_phase: 'critic-review',
        latest_critic_verdict: criticReview.verdict,
        latest_critic_summary: criticReview.summary,
        ralplan_consensus_gate: consensusGate,
        review_history: reviewHistory,
      });

      if (consensusGate.complete && planningArtifactsComplete) {
        const completedAt = new Date().toISOString();
        await updateRalplanState(cwd, effectiveSessionId, {
          active: false,
          iteration,
          current_phase: 'complete',
          completed_at: completedAt,
          planning_complete: true,
          latest_plan_path: latestPlanPath,
          latest_critic_verdict: criticReview.verdict,
          latest_critic_summary: criticReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
          status_message: 'Status: complete — ordered native Architect and Critic approvals authorized by local_owner_lifecycle.',
          error: undefined,
        });
        return {
          status: 'completed',
          iteration,
          phase: 'complete',
          planningComplete: true,
          drafts,
          architectReviews,
          criticReviews,
          ralplanConsensusGate: consensusGate,
          latestPlanPath,
          artifacts: aggregatedArtifacts,
          selectedExecutionLane: options.selectedExecutionLane,
          executionHandoffStarted: false,
        };
      }

      if (iteration >= maxIterations) {
        const error = consensusGate.complete
          ? 'ralplan_planning_artifacts_missing_after_consensus'
          : `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
        await updateRalplanState(cwd, effectiveSessionId, {
          active: false,
          iteration,
          current_phase: 'failed',
          completed_at: new Date().toISOString(),
          planning_complete: false,
          latest_plan_path: latestPlanPath,
          latest_critic_verdict: criticReview.verdict,
          latest_critic_summary: criticReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
          status_message: consensusGate.complete
            ? 'Status: failed — local owner consensus is valid, but matching PRD and test-spec planning artifacts are missing.'
            : `Status: paused_for_review — ralplan reached the ${maxIterations}-iteration review limit without valid ordered native Architect and Critic approvals.`,
          error,
        });
        return {
          status: 'failed',
          iteration,
          phase: 'failed',
          planningComplete: false,
          drafts,
          architectReviews,
          criticReviews,
          ralplanConsensusGate: consensusGate,
          latestPlanPath,
          artifacts: aggregatedArtifacts,
          error,
        };
      }

      iteration += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRalplanState(cwd, effectiveSessionId, {
      active: false,
      iteration,
      current_phase: 'failed',
      completed_at: new Date().toISOString(),
      planning_complete: false,
      latest_plan_path: latestPlanPath,
      ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
      review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      status_message: 'Status: failed — ralplan encountered an error and cannot continue without inspecting the failure.',
      error: message,
    });
    return {
      status: 'failed',
      iteration,
      phase: 'failed',
      planningComplete: false,
      drafts,
      architectReviews,
      criticReviews,
      ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
      latestPlanPath,
      artifacts: aggregatedArtifacts,
      error: message,
    };
  }

  const unreachableError = 'ralplan_runtime_unreachable_state';
  await updateRalplanState(cwd, effectiveSessionId, {
    active: false,
    iteration,
    current_phase: 'failed',
    completed_at: new Date().toISOString(),
    planning_complete: false,
    ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
    status_message: 'Status: failed — ralplan reached an unexpected runtime state.',
    error: unreachableError,
  });
  return {
    status: 'failed',
    iteration,
    phase: 'failed',
    planningComplete: false,
    drafts,
    architectReviews,
    criticReviews,
    ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
    latestPlanPath,
    artifacts: aggregatedArtifacts,
    error: unreachableError,
  };
}

export async function cancelRalplanConsensus(cwd?: string): Promise<void> {
  await cancelMode('ralplan', cwd);
}
