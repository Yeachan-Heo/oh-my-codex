import { cancelMode, readModeState, startMode, updateModeState } from '../modes/base.js';
import { readSubagentTrackingState, recordSubagentTurnForSession } from '../subagents/tracker.js';

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
    role?: 'planner' | 'architect' | 'critic' | 'executor';
    laneId?: string;
    scope?: string;
    summary?: string;
    completed?: boolean;
    completionSource?: string;
    preserveCompletionEvidence?: boolean;
  },
): Promise<void> {
  const normalizedSessionId = sessionId?.trim();
  const normalizedThreadId = input.threadId?.trim();
  if (!normalizedSessionId || !normalizedThreadId) return;

  await recordSubagentTurnForSession(cwd, {
    sessionId: normalizedSessionId,
    threadId: normalizedThreadId,
    mode: input.role,
    ...(input.role ? { role: input.role } : {}),
    ...(input.laneId ? { laneId: input.laneId } : input.role ? { laneId: input.role } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.summary?.trim() ? { lastHandoffSummary: input.summary.trim() } : {}),
    ...(input.completed ? { completed: true, completionSource: input.completionSource } : {}),
    ...(input.preserveCompletionEvidence ? { preserveCompletionEvidence: true } : {}),
    kind: 'subagent',
  }).catch(() => {});
}

function isApprovingReviewPair(
  architectReview: RalplanReviewResult | undefined,
  criticReview: RalplanReviewResult | undefined,
  requireNativeSubagents: boolean,
): boolean {
  if (
    architectReview?.verdict !== 'approve'
    || criticReview?.verdict !== 'approve'
    || architectReview.agent_role !== 'architect'
    || criticReview.agent_role !== 'critic'
  ) return false;
  if (!requireNativeSubagents) return true;

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
  requireNativeSubagents: boolean,
  nativeEvidenceComplete = true,
): string {
  if (architectReview?.verdict !== 'approve') return 'architect_review_missing_or_not_approved';
  if (criticReview?.verdict !== 'approve') return 'critic_review_missing_or_not_approved';
  if (!isApprovingReviewPair(architectReview, criticReview, requireNativeSubagents) || !nativeEvidenceComplete) {
    return 'native_subagent_consensus_evidence_missing';
  }
  return 'documented_host_consensus_receipt_unavailable';
}

async function hasCompletedNativeReviewEvidence(
  cwd: string,
  sessionId: string | undefined,
  architectReview: RalplanReviewResult,
  criticReview: RalplanReviewResult,
): Promise<boolean> {
  if (!sessionId?.trim()) return false;
  const threads = (await readSubagentTrackingState(cwd)).sessions[sessionId]?.threads;
  return Boolean(threads?.[architectReview.thread_id ?? '']?.completed_at && threads?.[criticReview.thread_id ?? '']?.completed_at);
}

function buildRalplanConsensusGate(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
  options: { cwd?: string; sessionId?: string; requireNativeSubagents?: boolean; nativeEvidenceComplete?: boolean } = {},
): RalplanConsensusGate {
  const latestArchitect = architectReviews.at(-1);
  const latestCritic = criticReviews.at(-1);
  const ralplanArchitectReview = latestArchitect
    ? { ...latestArchitect, agent_role: 'architect' as const, iteration: architectReviews.length }
    : null;
  const ralplanCriticReview = latestCritic
    ? { ...latestCritic, agent_role: 'critic' as const, iteration: criticReviews.length }
    : null;
  return {
    required: true,
    complete: false,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: ralplanArchitectReview,
    ralplan_critic_review: ralplanCriticReview,
    architect_review: ralplanArchitectReview,
    critic_review: ralplanCriticReview,
    blocked_reason: reviewBlocker(latestArchitect, latestCritic, options.requireNativeSubagents === true, options.nativeEvidenceComplete),
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
  updates: RalplanModeUpdates,
): Promise<void> {
  await updateModeState('ralplan', updates, cwd);
}

export async function runRalplanConsensus(
  executor: RalplanConsensusExecutor,
  options: RunRalplanConsensusOptions,
): Promise<RalplanRuntimeResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxIterations = options.maxIterations ?? 5;
  const gateOptions = {
    cwd,
    sessionId: options.sessionId,
    requireNativeSubagents: options.requireNativeSubagents,
  };
  const drafts: RalplanDraftResult[] = [];
  const architectReviews: RalplanReviewResult[] = [];
  const criticReviews: RalplanReviewResult[] = [];
  const aggregatedArtifacts: Record<string, unknown> = {};
  let latestPlanPath: string | undefined;
  let iteration = 1;

  const existing = await readModeState('ralplan', cwd);
  if (existing?.active) {
    throw new Error('ralplan_active_mode_exists');
  }

  await startMode('ralplan', options.task, maxIterations, cwd);

  try {
    while (iteration <= maxIterations) {
      const reusableRoleLanes = {
        architect: latestCompatibleRoleLane(architectReviews, 'architect', options.sessionId),
        critic: latestCompatibleRoleLane(criticReviews, 'critic', options.sessionId),
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

      await updateRalplanState(cwd, {
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
      await recordRalplanSubagentTurn(cwd, options.sessionId, {
        threadId: draft.thread_id,
        role: draft.agent_role ?? undefined,
        laneId: draft.lane_id,
        scope: options.task,
        summary: draft.summary,
        completed: true,
        completionSource: 'ralplan-draft',
      });

      await updateRalplanState(cwd, {
        iteration,
        current_phase: 'architect-review',
        latest_plan_path: latestPlanPath,
        latest_draft_summary: draft.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const architectReview = normalizeReviewForLane(await executor.architectReview({
        ...iterationContext,
        draft,
      }), 'architect', options.requireNativeSubagents === true);
      assertRoleLaneReuse(reusableRoleLanes.architect, architectReview, 'architect');
      architectReviews.push(architectReview);
      if (architectReview.artifacts) Object.assign(aggregatedArtifacts, architectReview.artifacts);
      await recordRalplanSubagentTurn(cwd, options.sessionId, {
        threadId: architectReview.thread_id,
        laneId: architectReview.lane_id,
        scope: options.task,
        summary: architectReview.summary,
        preserveCompletionEvidence: true,
      });

      if (architectReview.verdict !== 'approve') {
        const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
        const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions);
        await updateRalplanState(cwd, {
          iteration,
          current_phase: 'architect-review',
          latest_architect_verdict: architectReview.verdict,
          latest_architect_summary: architectReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
        });

        if (iteration >= maxIterations) {
          const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
          await updateRalplanState(cwd, {
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

      await updateRalplanState(cwd, {
        iteration,
        current_phase: 'critic-review',
        latest_architect_verdict: architectReview.verdict,
        latest_architect_summary: architectReview.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const criticReview = normalizeReviewForLane(await executor.criticReview({
        ...iterationContext,
        draft,
        architectReview,
      }), 'critic', options.requireNativeSubagents === true);
      assertRoleLaneReuse(reusableRoleLanes.critic, criticReview, 'critic');
      criticReviews.push(criticReview);
      if (criticReview.artifacts) Object.assign(aggregatedArtifacts, criticReview.artifacts);
      await recordRalplanSubagentTurn(cwd, options.sessionId, {
        threadId: criticReview.thread_id,
        laneId: criticReview.lane_id,
        scope: options.task,
        summary: criticReview.summary,
        preserveCompletionEvidence: true,
      });

      const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
      const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, {
        ...gateOptions,
        nativeEvidenceComplete: options.requireNativeSubagents !== true
          || await hasCompletedNativeReviewEvidence(cwd, options.sessionId, architectReview, criticReview),
      });
      await updateRalplanState(cwd, {
        iteration,
        current_phase: 'critic-review',
        latest_critic_verdict: criticReview.verdict,
        latest_critic_summary: criticReview.summary,
        ralplan_consensus_gate: consensusGate,
        review_history: reviewHistory,
      });


      if (consensusGate.blocked_reason === 'documented_host_consensus_receipt_unavailable' || iteration >= maxIterations) {
        const hostReceiptUnavailable = consensusGate.blocked_reason === 'documented_host_consensus_receipt_unavailable';
        const error = hostReceiptUnavailable
          ? 'documented_host_consensus_receipt_unavailable'
          : `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
        await updateRalplanState(cwd, {
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
          status_message: hostReceiptUnavailable
            ? 'Status: failed — Architect and Critic lifecycle evidence cannot authorize a release without an official host consensus receipt verifier.'
            : `Status: paused_for_review — ralplan reached the ${maxIterations}-iteration review limit without approval; continue from the best current artifact or ask the user how to proceed.`,
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
    await updateRalplanState(cwd, {
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
  await updateRalplanState(cwd, {
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
