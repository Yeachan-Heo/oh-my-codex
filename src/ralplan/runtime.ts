import { cancelMode, readModeState, startMode, updateModeState } from '../modes/base.js';
import { isPlanningComplete, readPlanningArtifacts } from '../planning/artifacts.js';
import { recordSubagentTurnForSession } from '../subagents/tracker.js';
import { buildRalplanConsensusGateFromSources } from './consensus-gate.js';

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
  provenance_kind?: 'native_subagent' | 'omx_adapted' | 'codex_exec';

  session_id?: string;
  thread_id?: string;
  native_session_id?: string;
  artifact_path?: string;
  agent_role?: 'architect' | 'critic';
  lane_id?: string;
  tracker_path?: string;
  new_lane_reason?: string;
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

function buildRalplanConsensusGate(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
  options: { cwd?: string; sessionId?: string; requireNativeSubagents?: boolean } = {},
): RalplanConsensusGate {
  const latestArchitect = architectReviews.at(-1);
  const latestCritic = criticReviews.at(-1);
  if (
    latestArchitect?.verdict === 'approve'
    && latestCritic?.verdict === 'approve'
    && architectReviews.length === criticReviews.length
  ) {
    const ralplanArchitectReview = {
      ...latestArchitect,
      agent_role: 'architect' as const,
      iteration: architectReviews.length,
    };
    const ralplanCriticReview = {
      ...latestCritic,
      agent_role: 'critic' as const,
      iteration: criticReviews.length,
    };
    const gate: RalplanConsensusGate = {
      required: true,
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      planning_artifacts_are_not_consensus: true,
      required_review_roles: ['architect', 'critic'],
      ralplan_architect_review: ralplanArchitectReview,
      ralplan_critic_review: ralplanCriticReview,
      architect_review: ralplanArchitectReview,
      critic_review: ralplanCriticReview,
      blocked_reason: null,
    };
    if (!options.requireNativeSubagents) return gate;
    const evidenceGate = buildRalplanConsensusGateFromSources([{
      source: 'runtime-result',
      value: { ralplan_consensus_gate: gate },
    }], {
      cwd: options.cwd,
      sessionId: options.sessionId,
      requireNativeSubagents: true,
    });
    return {
      ...gate,
      complete: evidenceGate.complete,
      blocked_reason: evidenceGate.complete ? null : evidenceGate.blockedReason,
    };
  }

  const blockedReason = latestArchitect?.verdict !== 'approve'
    ? 'architect_review_missing_or_not_approved'
    : latestCritic?.verdict !== 'approve'
      ? 'critic_review_missing_or_not_approved'
      : 'missing_sequential_architect_then_critic_approval';
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
    blocked_reason: blockedReason,
  };
}


function hasNativeOrThreadEvidence(review: RalplanReviewResult): boolean {
  return review.provenance_kind === 'native_subagent'
    || review.provenance_kind === 'omx_adapted'
    || Boolean(review.thread_id?.trim())
    || Boolean(review.native_session_id?.trim())
    || Boolean(review.tracker_path?.trim());
}

function normalizeReviewForLane(
  review: RalplanReviewResult,
  laneRole: 'architect' | 'critic',
  options: { requireNativeSubagents?: boolean },
): RalplanReviewResult {
  if (review.agent_role !== undefined && review.agent_role !== laneRole) {
    throw new Error(`ralplan_${laneRole}_review_role_mismatch: expected agent_role=${laneRole}, received ${String(review.agent_role)}`);
  }
  if (review.agent_role === undefined && (options.requireNativeSubagents || hasNativeOrThreadEvidence(review))) {
    throw new Error(`ralplan_${laneRole}_review_role_missing: native or thread-backed ${laneRole} review must declare agent_role=${laneRole}`);
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

function normalizeExecutionLane(lane: RalplanExecutionLane | undefined): 'ultragoal' | 'team' | 'ralph' | 'none' {
  if (lane === 'team' || lane === 'ralph' || lane === 'none') return lane;
  if (lane === 'ultragoal' || lane === 'conductor' || lane === 'execution') return 'ultragoal';
  return 'none';
}

function buildRalplanHandoffArtifact(
  consensusGate: RalplanConsensusGate,
  options: { selectedExecutionLane?: RalplanExecutionLane; started: boolean },
): Record<string, unknown> {
  const selectedExecutionLane = normalizeExecutionLane(options.selectedExecutionLane);
  return {
    selected_execution_lane: selectedExecutionLane,
    execution_handoff_status: selectedExecutionLane === 'none' ? 'planning_only_terminal' : options.started ? 'started' : 'selected_pending_start',
    planning_only_terminal: selectedExecutionLane === 'none',
    ralplan_consensus_gate: consensusGate,
  };
}

async function startSelectedExecutionLane(
  cwd: string,
  task: string,
  selectedExecutionLane: RalplanExecutionLane | undefined,
): Promise<boolean> {
  const lane = normalizeExecutionLane(selectedExecutionLane);
  if (lane === 'none') return false;
  await startMode(lane, task, 50, cwd);
  return true;
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
      }), 'architect', gateOptions);
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
      }), 'critic', gateOptions);
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
      const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions);
      await updateRalplanState(cwd, {
        iteration,
        current_phase: 'critic-review',
        latest_critic_verdict: criticReview.verdict,
        latest_critic_summary: criticReview.summary,
        ralplan_consensus_gate: consensusGate,
        review_history: reviewHistory,
      });

      if (consensusGate.complete) {
        const planningArtifacts = readPlanningArtifacts(cwd);
        const planningComplete = isPlanningComplete(planningArtifacts);
        if (!planningComplete) {
          const error = 'ralplan_planning_artifacts_missing_after_consensus';
          await updateRalplanState(cwd, {
            active: false,
            iteration,
            current_phase: 'failed',
            completed_at: new Date().toISOString(),
            planning_complete: false,
            latest_plan_path: latestPlanPath,
            ralplan_consensus_gate: consensusGate,
            status_message: 'Status: failed — ralplan consensus approved, but required PRD and test-spec planning artifacts are missing; do not hand off to execution.',
            review_history: reviewHistory,
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

        await updateRalplanState(cwd, {
          active: false,
          iteration,
          current_phase: 'complete',
          completed_at: new Date().toISOString(),
          planning_complete: true,
          latest_plan_path: latestPlanPath,
          ralplan_consensus_gate: consensusGate,
          selected_execution_lane: normalizeExecutionLane(options.selectedExecutionLane),
          handoff_artifacts: {
            ralplan: buildRalplanHandoffArtifact(consensusGate, {
              selectedExecutionLane: options.selectedExecutionLane,
              started: false,
            }),
          },
          status_message: normalizeExecutionLane(options.selectedExecutionLane) === 'none'
            ? 'Status: complete — ralplan consensus approved, planning artifacts are ready, and no execution lane was selected.'
            : 'Status: complete — ralplan consensus approved and planning artifacts are ready for execution handoff.',
          review_history: reviewHistory,
        });
        const executionHandoffStarted = await startSelectedExecutionLane(cwd, options.task, options.selectedExecutionLane);
        if (executionHandoffStarted) {
          await updateRalplanState(cwd, {
            handoff_artifacts: {
              ralplan: buildRalplanHandoffArtifact(consensusGate, {
                selectedExecutionLane: options.selectedExecutionLane,
                started: true,
              }),
            },
            status_message: `Status: complete — ralplan consensus approved and ${normalizeExecutionLane(options.selectedExecutionLane)} execution handoff started.`,
          });
        }
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
          executionHandoffStarted,
        };
      }

      if (iteration >= maxIterations) {
        const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
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
          status_message: `Status: paused_for_review — ralplan reached the ${maxIterations}-iteration review limit without approval; continue from the best current artifact or ask the user how to proceed.`,
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
