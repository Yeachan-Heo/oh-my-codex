/**
 * RALPLAN stage adapter for pipeline orchestrator.
 *
 * Wraps the consensus planning workflow (planner + architect + critic)
 * into a PipelineStage. Produces a plan artifact at `.omx/plans/`.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { isPlanningComplete, readPlanningArtifacts } from '../../planning/artifacts.js';
import { isNonCleanReviewVerdict } from '../review-verdict.js';
import {
  runRalplanConsensus,
  type RalplanConsensusExecutor,
  type RalplanExecutionLane,
} from '../../ralplan/runtime.js';
import {
  buildRalplanConsensusGateForCwd,
  buildRalplanConsensusGateFromSources,
  hasDurableRalplanConsensusEvidenceForCwd,
  type RalplanConsensusBlockedReason,
  type RalplanConsensusGateEvidence,
} from '../../ralplan/consensus-gate.js';

export interface CreateRalplanStageOptions {
  executor?: RalplanConsensusExecutor;
  maxIterations?: number;
  requireNativeSubagents?: boolean;
  selectedExecutionLane?: RalplanExecutionLane;
}

/**
 * Create a RALPLAN pipeline stage.
 *
 * The RALPLAN stage performs consensus planning by coordinating planner,
 * architect, and critic agents. It outputs a plan file that downstream
 * stages consume.
 *
 * By default this remains a structural adapter — actual agent orchestration
 * happens at the skill layer. When an executor is provided, the stage can
 * drive the real ralplan runtime and persist live mode state.
 */
export function createRalplanStage(options: CreateRalplanStageOptions = {}): PipelineStage {
  return {
    name: 'ralplan',

    canSkip(ctx: StageContext): boolean {
      if (hasReviewLoopContext(ctx.artifacts)) {
        return false;
      }
      const planningArtifacts = readPlanningArtifacts(ctx.cwd);
      return isPlanningComplete(planningArtifacts)
        && hasDurableRalplanConsensusEvidence(ctx, options.requireNativeSubagents);
    },

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      try {
        if (options.executor) {
          const runtimeResult = await runRalplanConsensus(options.executor, {
            task: ctx.task,
            cwd: ctx.cwd,
            maxIterations: options.maxIterations,
            sessionId: ctx.sessionId,
            requireNativeSubagents: options.requireNativeSubagents,
            selectedExecutionLane: options.selectedExecutionLane,
          });

          const planningArtifacts = readPlanningArtifacts(ctx.cwd);
          const consensusGate = buildRalplanConsensusGate(
            runtimeResult,
            ctx,
            options.requireNativeSubagents,
          );
          const consensusComplete = consensusGate.complete === true;
          return {
            status: runtimeResult.status === 'completed' && consensusComplete ? 'completed' : 'failed',
            artifacts: {
              ...runtimeResult.artifacts,
              plansDir: planningArtifacts.plansDir,
              specsDir: planningArtifacts.specsDir,
              task: ctx.task,
              prdPaths: planningArtifacts.prdPaths,
              testSpecPaths: planningArtifacts.testSpecPaths,
              deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
              planningComplete: runtimeResult.planningComplete,
              stage: 'ralplan',
              runtime: true,
              iteration: runtimeResult.iteration,
              latestPlanPath: runtimeResult.latestPlanPath,
              drafts: runtimeResult.drafts,
              architectReviews: runtimeResult.architectReviews,
              criticReviews: runtimeResult.criticReviews,
              ralplanConsensusGate: consensusGate,
            },
            duration_ms: Date.now() - startTime,
            error: runtimeResult.error ?? (consensusComplete ? undefined : consensusGate.blockedReason ?? 'ralplan_consensus_evidence_missing'),
          };
        }

        const planningArtifacts = readPlanningArtifacts(ctx.cwd);
        const consensusGate = buildRalplanConsensusGateForCwd(ctx.cwd, {
          artifacts: ctx.artifacts,
          sessionId: ctx.sessionId,
          requireNativeSubagents: options.requireNativeSubagents,
        });
        const planningComplete = isPlanningComplete(planningArtifacts);
        const consensusComplete = consensusGate.complete === true;

        const completed = planningComplete && consensusComplete;
        const error = completed
          ? undefined
          : consensusGate.blockedReason
            ?? (consensusComplete && !planningComplete
              ? 'ralplan_planning_artifacts_missing_after_consensus'
              : planningComplete && !consensusComplete
                ? 'ralplan_consensus_evidence_missing'
                : 'ralplan_planning_artifacts_missing');

        return {
          status: completed ? 'completed' : 'failed',
          artifacts: {
            plansDir: planningArtifacts.plansDir,
            specsDir: planningArtifacts.specsDir,
            task: ctx.task,
            prdPaths: planningArtifacts.prdPaths,
            testSpecPaths: planningArtifacts.testSpecPaths,
            deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
            planningComplete,
            stage: 'ralplan',
            ralplanConsensusGate: consensusGate,
            instruction: consensusComplete
              ? `Run RALPLAN consensus planning for: ${ctx.task}`
              : `Remain in RALPLAN for: ${ctx.task}. Architect and Critic reviews are lifecycle evidence only; do not hand off to execution until an official host-issued receipt is verified through the documented non-user-mintable host surface. Until then record documented_host_consensus_receipt_unavailable.`,
          },
          duration_ms: Date.now() - startTime,
          error,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `RALPLAN stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function buildRalplanConsensusGate(runtimeResult: {
  status: string;
  planningComplete: boolean;
  ralplanConsensusGate?: unknown;
  architectReviews: unknown[];
  criticReviews: unknown[];
}, ctx: StageContext, requireNativeSubagents?: boolean): RalplanConsensusGateEvidence {
  const runtimeGate = runtimeConsensusGateDiagnostic(runtimeResult.ralplanConsensusGate);
  if (runtimeGate) return runtimeGate;

  return buildRalplanConsensusGateFromSources([{
    source: 'runtime-result',
    value: runtimeResult,
  }], {
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    requireNativeSubagents,
  });
}

function runtimeConsensusGateDiagnostic(value: unknown): RalplanConsensusGateEvidence | null {
  if (!value || typeof value !== 'object') return null;

  const gate = value as Record<string, unknown>;
  const blockedReason = gate.blocked_reason ?? gate.blockedReason;
  if (typeof blockedReason !== 'string') return null;

  const blockedDetailsValue = gate.blocked_details ?? gate.blockedDetails;
  const blockedDetails = Array.isArray(blockedDetailsValue)
    ? blockedDetailsValue.filter((detail): detail is string => typeof detail === 'string')
    : [];
  return {
    complete: false,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: asRecord(gate.ralplan_architect_review ?? gate.architect_review),
    ralplan_critic_review: asRecord(gate.ralplan_critic_review ?? gate.critic_review),
    source: 'runtime-result',
    blockedReason: blockedReason as RalplanConsensusBlockedReason,
    ...(blockedDetails.length > 0 ? { blockedDetails } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function hasDurableRalplanConsensusEvidence(
  ctx: StageContext,
  requireNativeSubagents?: boolean,
): boolean {
  return hasDurableRalplanConsensusEvidenceForCwd(ctx.cwd, {
    artifacts: ctx.artifacts,
    sessionId: ctx.sessionId,
    requireNativeSubagents,
  });
}

function hasReviewLoopContext(artifacts: Record<string, unknown>): boolean {
  if (typeof artifacts.return_to_ralplan_reason === 'string' && artifacts.return_to_ralplan_reason.trim() !== '') {
    return true;
  }
  if (isNonCleanReviewVerdict(artifacts.review_verdict)) {
    return true;
  }

  const codeReviewArtifacts = artifacts['code-review'];
  if (!codeReviewArtifacts || typeof codeReviewArtifacts !== 'object') {
    return false;
  }

  const reviewArtifacts = codeReviewArtifacts as Record<string, unknown>;
  return (
    (typeof reviewArtifacts.return_to_ralplan_reason === 'string'
      && reviewArtifacts.return_to_ralplan_reason.trim() !== '')
    || isNonCleanReviewVerdict(reviewArtifacts.review_verdict)
  );
}
