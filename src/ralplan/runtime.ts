import {
  readModeState,
  readModeStateForExplicitSession,
  updateAutopilotPipelineState,
  updateModeState,
} from '../modes/base.js';
import { resolveWritableStateScope } from '../mcp/state-paths.js';
import { requirePersistedHandoffCarrier } from '../state/handoff-carrier.js';
import { readSubagentTrackingState, recordSubagentTurnForSession } from '../subagents/tracker.js';
import { getGatesForStage } from '../quality-gates/index.js';
import {
  administrativelyAbandonRalplanAdvisory,
  readCurrentRalplanAdvisory,
} from './advisory.js';
import {
  type RalplanConsensusExecutor,
  type RalplanConsensusGate,
  type RalplanConsensusIterationContext,
  type RalplanDraftResult,
  type RalplanReviewResult,
  type RalplanQualityGateResult,
  type RalplanReviewVerdict,
  type RalplanReusableRoleLane,
  type RalplanRuntimeResult,
  type RunRalplanConsensusOptions,
} from './runtime-contract.js';
export * from './runtime-contract.js';
export { isCompletedAdvisoryCatchRecovery } from './runtime-advisory-lifecycle.js';
import {
  createRalplanRuntimeLifecycle,
  terminalizeCancelledAdvisory,
  type RalplanRuntimeSnapshot,
} from './runtime-advisory-lifecycle.js';

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
  gateResults?: RalplanQualityGateResult[];
  [key: string]: unknown;
}

function buildReviewHistory(
  drafts: RalplanDraftResult[],
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const recordedIterations = [...drafts, ...architectReviews, ...criticReviews]
    .map((entry) => entry.review_iteration)
    .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  const total = Math.max(drafts.length, architectReviews.length, criticReviews.length, ...recordedIterations);
  for (let index = 0; index < total; index++) {
    const iteration = index + 1;
    entries.push({
      iteration,
      draft: drafts.find((entry) => entry.review_iteration === iteration) ?? drafts[index] ?? null,
      architect_review: architectReviews.find((entry) => entry.review_iteration === iteration) ?? architectReviews[index] ?? null,
      critic_review: criticReviews.find((entry) => entry.review_iteration === iteration)
        ?? (criticReviews[index]?.review_iteration === undefined ? criticReviews[index] : null)
        ?? null,
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
): string | null {
  if (architectReview?.verdict !== 'approve') return 'architect_review_missing_or_not_approved';
  if (criticReview?.verdict !== 'approve') return 'critic_review_missing_or_not_approved';
  if (!isApprovingReviewPair(architectReview, criticReview, requireNativeSubagents) || !nativeEvidenceComplete) {
    return 'native_subagent_consensus_evidence_missing';
  }
  return null;
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

export function __buildRalplanConsensusGateForTests(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
  options?: { cwd?: string; sessionId?: string; requireNativeSubagents?: boolean; nativeEvidenceComplete?: boolean; iteration?: number; gateResults?: RalplanQualityGateResult[]; qualityGatesComplete?: boolean },
): RalplanConsensusGate {
  return buildRalplanConsensusGate(architectReviews, criticReviews, options);
}

function buildRalplanConsensusGate(
  architectReviews: RalplanReviewResult[],
  criticReviews: RalplanReviewResult[],
  options: { cwd?: string; sessionId?: string; requireNativeSubagents?: boolean; nativeEvidenceComplete?: boolean; iteration?: number; gateResults?: RalplanQualityGateResult[]; qualityGatesComplete?: boolean } = {},
): RalplanConsensusGate {
  const latestArchitect = architectReviews.at(-1);
  const latestCritic = criticReviews.at(-1);
  // P1-3: stamp the authoritative global Ralplan loop iteration as
  // review_cycle on both role reviews. Never derive from per-role array
  // lengths, which diverge on Architect revision/retry.
  const authoritativeCycle = typeof options.iteration === 'number' ? options.iteration : 1;
  // P1-2: stamp authoritative sequence_index (architect=1, critic=2) from
  // the trusted runtime, so external executors that omit it still produce
  // correctly ordered persisted artifacts. Forged/reordered persisted
  // artifacts are caught by the gate validator.
  const ralplanArchitectReview = latestArchitect
    ? { ...latestArchitect, agent_role: 'architect' as const, session_id: options.sessionId, iteration: authoritativeCycle, review_cycle: authoritativeCycle, sequence_index: 1 }
    : null;
  const ralplanCriticReview = latestCritic
    ? { ...latestCritic, agent_role: 'critic' as const, session_id: options.sessionId, iteration: authoritativeCycle, review_cycle: authoritativeCycle, sequence_index: 2 }
    : null;
  const currentGateResults = (options.gateResults ?? []).filter((result) => result.iteration === authoritativeCycle);
  const blockingGate = currentGateResults.find((result) => {
    // A blocking gate blocks only on 'reject' or 'iterate' verdicts
    // 'unavailable' (skill missing/executor unavailable) is a visible warning and is skipped
    const mode = result.mode ?? 'blocking';
    return (result.verdict === 'reject' || result.verdict === 'iterate') && mode === 'blocking';
  });
  const blockedReason = reviewBlocker(latestArchitect, latestCritic, options.requireNativeSubagents === true, options.nativeEvidenceComplete)
    ?? (blockingGate ? `quality_gate_not_approved:${blockingGate.skill}` : null)
    ?? (options.qualityGatesComplete === false ? 'quality_gate_reviews_pending' : null);
  return {
    required: true,
    complete: blockedReason === null,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: ralplanArchitectReview,
    ralplan_critic_review: ralplanCriticReview,
    architect_review: ralplanArchitectReview,
    critic_review: ralplanCriticReview,
    blocked_reason: blockedReason,
    qualityGateResults: Object.fromEntries(currentGateResults.map((result) => [result.skill, {
      verdict: result.verdict,
      summary: result.summary,
    }])),
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
  sessionId?: string,
  beforeCommit?: (site: string) => void | Promise<void>,
): Promise<void> {
  await updateModeState('ralplan', updates, cwd, sessionId, beforeCommit);
}

function requiredAdvisoryIdentity(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`ralplan_advisory_${name}_required`);
  return normalized;
}

export async function runRalplanConsensus(
  executor: RalplanConsensusExecutor,
  options: RunRalplanConsensusOptions,
): Promise<RalplanRuntimeResult> {
  const cwd = options.cwd ?? process.cwd();
  // Pin the writable session once for the whole run. A caller may omit an
  // explicit session while the workspace pointer selects one; startMode then
  // writes session-scoped state, so every subsequent read/update must use the
  // same explicit scope instead of falling back to root-only discovery.
  const runtimeSessionId = options.sessionId
    ?? (await resolveWritableStateScope(cwd)).sessionId;
  const maxIterations = Math.min(options.maxIterations ?? 5, 5);
  const gateResults: RalplanQualityGateResult[] = [];
  const gateOptions = {
    cwd,
    sessionId: runtimeSessionId,
    requireNativeSubagents: options.requireNativeSubagents,
    gateResults,
    qualityGatesComplete: false,
    get iteration() { return iteration; },
  };
  const drafts: RalplanDraftResult[] = [];
  const architectReviews: RalplanReviewResult[] = [];
  const criticReviews: RalplanReviewResult[] = [];
  const aggregatedArtifacts: Record<string, unknown> = {};
  let latestPlanPath: string | undefined;
  let iteration = 1;

  const existing = runtimeSessionId
    ? await readModeStateForExplicitSession('ralplan', runtimeSessionId, cwd)
    : await readModeState('ralplan', cwd);
  const lifecycle = await createRalplanRuntimeLifecycle({ cwd, runtimeSessionId, maxIterations, options, existing });
  const writeRalplanState = (updates: RalplanModeUpdates): Promise<void> =>
    updateRalplanState(cwd, { ...updates, gateResults }, lifecycle.sessionId);
  const snapshot = (
    consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
    reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews),
  ): RalplanRuntimeSnapshot => ({
    iteration,
    drafts,
    architectReviews,
    criticReviews,
    consensusGate,
    reviewHistory,
    latestPlanPath,
    artifacts: aggregatedArtifacts,
  });

  try {
    while (iteration <= maxIterations) {
      gateOptions.qualityGatesComplete = false;
      const reusableRoleLanes = {
        architect: latestCompatibleRoleLane(architectReviews, 'architect', runtimeSessionId),
        critic: latestCompatibleRoleLane(criticReviews, 'critic', runtimeSessionId),
      };
      const iterationContext: RalplanConsensusIterationContext = {
        task: options.task,
        cwd,
        iteration,
        priorDrafts: [...drafts],
        architectReviews: [...architectReviews],
        criticReviews: [...criticReviews],
        gateResults: [...gateResults],
        reusableRoleLanes,
      };

      await writeRalplanState({
        iteration,
        current_phase: 'draft',
        planning_complete: false,
        ralplan_consensus_gate: buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions),
        review_history: buildReviewHistory(drafts, architectReviews, criticReviews),
      });
      const draft = await executor.draft(iterationContext);
      draft.review_iteration = iteration;
      drafts.push(draft);
      if (draft.artifacts) Object.assign(aggregatedArtifacts, draft.artifacts);
      if (draft.planPath) latestPlanPath = draft.planPath;
      draft.advisory_plan_manifest_sha256 = await lifecycle.postDraft(latestPlanPath);
      await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
        threadId: draft.thread_id,
        role: draft.agent_role ?? undefined,
        laneId: draft.lane_id,
        scope: options.task,
        summary: draft.summary,
        completed: true,
        completionSource: 'ralplan-draft',
      });

      await writeRalplanState({
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
      architectReview.review_iteration = iteration;
      architectReview.advisory_artifact_manifest_sha256 = await lifecycle.postReview(
        latestPlanPath, 'architect', architectReview.artifact_path,
      );
      assertRoleLaneReuse(reusableRoleLanes.architect, architectReview, 'architect');
      architectReviews.push(architectReview);
      if (architectReview.artifacts) Object.assign(aggregatedArtifacts, architectReview.artifacts);
      await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
        threadId: architectReview.thread_id,
        role: 'architect',
        laneId: architectReview.lane_id,
        scope: lifecycle.reviewScope(options.task),
        summary: architectReview.summary,
        preserveCompletionEvidence: true,
      });

      if (architectReview.verdict !== 'approve') {
        const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
        const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, gateOptions);
        await writeRalplanState({
          iteration,
          current_phase: 'architect-review',
          latest_architect_verdict: architectReview.verdict,
          latest_architect_summary: architectReview.summary,
          ralplan_consensus_gate: consensusGate,
          review_history: reviewHistory,
        });

        if (iteration >= maxIterations) {
          const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
          const advisoryResult = await lifecycle.terminalFailure({
            ...snapshot(consensusGate, reviewHistory),
            outcome: 'exhausted',
            error,
            statusMessage: 'Status: advisory exhausted — control returned to the caller without an execution handoff.',
            updates: {
              latest_architect_verdict: architectReview.verdict,
              latest_architect_summary: architectReview.summary,
            },
          });
          if (advisoryResult) return advisoryResult;
          await writeRalplanState({
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

      await writeRalplanState({
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
      criticReview.review_iteration = iteration;
      criticReview.advisory_artifact_manifest_sha256 = await lifecycle.postReview(
        latestPlanPath, 'critic', criticReview.artifact_path,
      );
      assertRoleLaneReuse(reusableRoleLanes.critic, criticReview, 'critic');
      criticReviews.push(criticReview);
      if (criticReview.artifacts) Object.assign(aggregatedArtifacts, criticReview.artifacts);
      await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
        threadId: criticReview.thread_id,
        role: 'critic',
        laneId: criticReview.lane_id,
        scope: lifecycle.reviewScope(options.task),
        summary: criticReview.summary,
        preserveCompletionEvidence: true,
      });

      if (criticReview.verdict === 'approve') {
        const normalizedGates = getGatesForStage('ralplan', undefined, cwd);
        for (const gate of normalizedGates) {
          let result: RalplanQualityGateResult;
          try {
            if (!executor.qualityGateReview) throw new Error('Native quality gate executor is unavailable');
            const review = await executor.qualityGateReview({
              ...iterationContext,
              gateName: gate.skill,
              gateModel: gate.model,
              draft,
              architectReview,
              criticReview,
            });
            if (review.provenance_kind !== 'native_subagent' || !review.thread_id?.trim()) {
              throw new Error('Quality gate requires native_subagent provenance and a thread_id');
            }
            if (!['approve', 'iterate', 'reject'].includes(review.verdict)) {
              throw new Error('Quality gate returned an invalid verdict');
            }
            // Reject gate thread IDs that alias built-in reviewers
            if (review.thread_id === architectReview.thread_id || review.thread_id === criticReview.thread_id) {
              throw new Error('Quality gate thread ID conflicts with built-in reviewer');
            }
            result = {
              skill: gate.skill,
              iteration,
              verdict: review.verdict,
              summary: review.summary ?? '',
              mode: gate.mode ?? 'blocking',
              provenance_kind: review.provenance_kind,
              thread_id: review.thread_id,
            };
            await recordRalplanSubagentTurn(cwd, runtimeSessionId, {
              threadId: review.thread_id,
              laneId: `quality-gate:${gate.skill}`,
              scope: options.task,
              summary: review.summary,
              completed: true,
              completionSource: 'ralplan-quality-gate',
            });
          } catch (error) {
            result = {
              skill: gate.skill,
              iteration,
              verdict: 'unavailable',
              summary: error instanceof Error ? error.message : String(error),
              mode: gate.mode ?? 'blocking',
            };
          }
          gateResults.push(result);
        }
        gateOptions.qualityGatesComplete = true;
      }

      const reviewHistory = buildReviewHistory(drafts, architectReviews, criticReviews);
      const consensusGate = buildRalplanConsensusGate(architectReviews, criticReviews, {
        ...gateOptions,
        nativeEvidenceComplete: options.requireNativeSubagents !== true
          || await hasCompletedNativeReviewEvidence(cwd, runtimeSessionId, architectReview, criticReview),
      });
      await writeRalplanState({
        iteration,
        current_phase: 'critic-review',
        latest_critic_verdict: criticReview.verdict,
        latest_critic_summary: criticReview.summary,
        ralplan_consensus_gate: consensusGate,
        review_history: reviewHistory,
      });

      const advisoryCompleted = consensusGate.complete ? await lifecycle.completeApproved({
        ...snapshot(consensusGate, reviewHistory),
        architectReview,
        criticReview,
      }) : null;
      if (advisoryCompleted) return advisoryCompleted;

      if (consensusGate.complete) {
        // Architect→Critic lifecycle consensus is complete; planning is done and
        // execution may proceed without any host consensus receipt.
        const completedAt = new Date().toISOString();
        const autopilotParent = runtimeSessionId
          ? await readModeStateForExplicitSession('autopilot', runtimeSessionId, cwd)
          : null;
        const supervisedAutopilot = options.selectedExecutionLane === 'ultragoal'
          && autopilotParent?.active === true
          && autopilotParent.current_phase === 'ralplan';
        const executionHandoff = {
          authorized: true,
          reason: 'Sequential Architect and Critic approval completed the execution-ready Ralplan stage.',
          authorized_at: completedAt,
          session_id: runtimeSessionId,
          review_cycle: iteration,
          source: supervisedAutopilot ? 'autopilot' : 'user',
        };
        await updateRalplanState(cwd, {
          active: false,
          iteration,
          current_phase: 'complete',
          completed_at: completedAt,
          planning_complete: true,
          latest_plan_path: latestPlanPath,
          latest_critic_verdict: criticReview.verdict,
          latest_critic_summary: criticReview.summary,
          ralplan_consensus_gate: consensusGate,
          ralplan_execution_handoff: executionHandoff,
          review_history: reviewHistory,
          status_message: 'Status: complete — Architect and Critic consensus is complete; proceed to execution.',
        }, runtimeSessionId);

        if (supervisedAutopilot && runtimeSessionId && autopilotParent) {
            // Never spread a corrupt persisted carrier into a fresh object: that laundered a stored
            // array into a valid-looking record and defeated the writer-side guard. A corrupt parent
            // carrier fails closed here instead.
            // Both representations, because the gate reads either one.
            const parentNested = autopilotParent.state;
            const nestedCarrier = parentNested && typeof parentNested === 'object' && !Array.isArray(parentNested)
              ? (parentNested as Record<string, unknown>).handoff_artifacts
              : undefined;
            requirePersistedHandoffCarrier(nestedCarrier, 'parent state.handoff_artifacts carrier');
            const existingHandoffs = requirePersistedHandoffCarrier(
              autopilotParent.handoff_artifacts,
              'parent handoff_artifacts carrier',
            );
            await updateAutopilotPipelineState({
              active: true,
              current_phase: 'ultragoal',
              handoff_artifacts: {
                ...existingHandoffs,
                ralplan: {
                  plan_path: latestPlanPath,
                  artifacts: aggregatedArtifacts,
                },
              },
              ralplan_consensus_gate: consensusGate,
              ralplan_execution_handoff: executionHandoff,
            }, cwd, runtimeSessionId);
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
        };
      }

      if (iteration >= maxIterations) {
        const error = `ralplan_consensus_not_reached_after_${maxIterations}_iterations`;
        const outcome = criticReview.verdict === 'reject' ? 'rejected' : 'exhausted';
        const advisoryResult = await lifecycle.terminalFailure({
          ...snapshot(consensusGate, reviewHistory),
          outcome,
          error,
          statusMessage: `Status: advisory ${outcome} — control returned to the caller without an execution handoff.`,
          updates: {
            latest_critic_verdict: criticReview.verdict,
            latest_critic_summary: criticReview.summary,
          },
        });
        if (advisoryResult) return advisoryResult;
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
    const lifecycleResult = await lifecycle.recoverFailure(error, snapshot());
    if (lifecycleResult) return lifecycleResult;
    await writeRalplanState({
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
  const advisoryUnreachable = await lifecycle.terminalFailure({
    ...snapshot(),
    outcome: 'failed',
    error: unreachableError,
    statusMessage: 'Status: advisory failed — unexpected runtime state; control returned to the caller without an execution handoff.',
  });
  if (advisoryUnreachable) return advisoryUnreachable;
  await writeRalplanState({
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

export async function cancelRalplanConsensus(
  cwd?: string,
  sessionId?: string,
  options: { revalidateAuthority?: (checkpoint: string) => void | Promise<void> } = {},
): Promise<boolean> {
  const root = cwd ?? process.cwd();
  await options.revalidateAuthority?.('cancel_read');
  const state = sessionId
    ? await readModeStateForExplicitSession('ralplan', sessionId, root)
    : await readModeState('ralplan', root);
  if (state?.workflow_variant === 'advisory') {
    const advisorySessionId = requiredAdvisoryIdentity(sessionId ?? String(state.session_id ?? ''), 'session_id');
    const projection = await readCurrentRalplanAdvisory(root, advisorySessionId);
    await options.revalidateAuthority?.('cancel_projection');
    if (!projection || projection.corruption) {
      throw new Error(`ralplan_advisory_cancel_projection_unavailable:${projection?.corruption ?? 'missing'}`);
    }
    const generationId = requiredAdvisoryIdentity(
      String(state.advisory_generation_id ?? projection.activation.generation_id),
      'generation_id',
    );
    const closingTurnId = requiredAdvisoryIdentity(
      String(projection.fence?.closing_turn_id ?? state.turn_id ?? projection.activation.activation_turn_id),
      'closing_turn_id',
    );
    if (projection.fence?.state === 'pending_closeout' && !projection.journal) {
      await administrativelyAbandonRalplanAdvisory({
        cwd: root, sessionId: advisorySessionId, generationId,
        rootThreadId: requiredAdvisoryIdentity(String(state.thread_id ?? projection.activation.root_thread_id), 'root_thread_id'),
        turnId: closingTurnId,
        beforeMutation: options.revalidateAuthority,
      });
      await options.revalidateAuthority?.('cancel_mode_update');
      await updateRalplanState(root, {
        active: false, current_phase: 'cancelled', completed_at: new Date().toISOString(), planning_complete: false,
        workflow_variant: 'advisory', advisory_generation_id: generationId,
        advisory_closing_turn_id: closingTurnId, execution_handoff_authorized: false, host_verified: false,
        ralplan_consensus_gate: { ...buildRalplanConsensusGate([], []), complete: false },
        status_message: 'Status: advisory administratively abandoned — control returned to the caller; later user instructions follow normal host rules.',
      }, advisorySessionId, options.revalidateAuthority
        ? (site) => options.revalidateAuthority?.(`mode_commit_${site}`)
        : undefined);
      await options.revalidateAuthority?.('mode_update_complete');
      await options.revalidateAuthority?.('cancel_mode_updated');
      return true;
    }
    await terminalizeCancelledAdvisory({
      cwd: root, sessionId: advisorySessionId, generationId, closingTurnId,
      iteration: typeof state.iteration === 'number' && state.iteration > 0 ? state.iteration : 1,
      consensusGate: buildRalplanConsensusGate([], []),
      revalidateAuthority: options.revalidateAuthority,
    });
    return true;
  }
  if (state?.active) {
    await updateModeState('ralplan', {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }, root, sessionId);
    return true;
  }
  return false;
}
