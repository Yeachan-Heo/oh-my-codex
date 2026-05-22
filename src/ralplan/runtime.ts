import { cancelMode, readModeState, startMode, updateModeState } from '../modes/base.js';
import { isPlanningComplete, readPlanningArtifacts } from '../planning/artifacts.js';

export const RALPLAN_ACTIVE_PHASES = [
  'draft',
  'architect-review',
  'critic-review',
  'complete',
] as const;

export type RalplanActivePhase = (typeof RALPLAN_ACTIVE_PHASES)[number];
export type RalplanTerminalPhase = 'complete' | 'cancelled' | 'failed';
export type RalplanReviewVerdict = 'approve' | 'iterate' | 'reject';

export interface RalplanDraftResult {
  summary?: string;
  planPath?: string;
  artifacts?: Record<string, unknown>;
}

export interface RalplanReviewResult {
  verdict: RalplanReviewVerdict;
  summary?: string;
  artifacts?: Record<string, unknown>;
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

function buildRalplanConsensusGate(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
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
    return {
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
      const iterationContext: RalplanConsensusIterationContext = {
        task: options.task,
        cwd,
        iteration,
        priorDrafts: [...drafts],
        architectReviews: [...architectReviews],
        criticReviews: [...criticReviews],
      };

      await updateRalplanState(cwd, {
        iteration,
        current_phase: 'draft',
        planning_complete: false,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const draft = await executor.draft(iterationContext);
      drafts.push(draft);
      if (draft.artifacts) Object.assign(aggregatedArtifacts, draft.artifacts);
      if (draft.planPath) latestPlanPath = draft.planPath;

      await updateRalplanState(cwd, {
        iteration,
        current_phase: 'architect-review',
        latest_plan_path: latestPlanPath,
        latest_draft_summary: draft.summary,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const architectReview = await executor.architectReview({
        ...iterationContext,
        draft,
      });
      architectReviews.push(architectReview);
      if (architectReview.artifacts) Object.assign(aggregatedArtifacts, architectReview.artifacts);

      if (architectReview.verdict !== 'approve') {
        const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
        const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews);
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
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const criticReview = await executor.criticReview({
        ...iterationContext,
        draft,
        architectReview,
      });
      criticReviews.push(criticReview);
      if (criticReview.artifacts) Object.assign(aggregatedArtifacts, criticReview.artifacts);

      const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
      const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews);
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
          status_message: 'Status: complete — ralplan consensus approved and planning artifacts are ready for handoff.',
          review_history: reviewHistory,
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
      ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews),
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
      ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews),
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
    ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews),
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
    ralplanConsensusGate: buildRalplanConsensusGate(architectReviews, criticReviews),
    latestPlanPath,
    artifacts: aggregatedArtifacts,
    error: unreachableError,
  };
}

export async function cancelRalplanConsensus(cwd?: string): Promise<void> {
  await cancelMode('ralplan', cwd);
}
