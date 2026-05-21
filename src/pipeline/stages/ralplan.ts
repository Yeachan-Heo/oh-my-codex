/**
 * RALPLAN stage adapter for pipeline orchestrator.
 *
 * Wraps the consensus planning workflow (planner + architect + critic)
 * into a PipelineStage. Produces a plan artifact at `.omx/plans/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { isPlanningComplete, readPlanningArtifacts } from '../../planning/artifacts.js';
import { getBaseStateDir, getStatePath, validateSessionId } from '../../state/paths.js';
import { isNonCleanReviewVerdict } from '../review-verdict.js';
import {
  runRalplanConsensus,
  type RalplanConsensusExecutor,
} from '../../ralplan/runtime.js';

export interface CreateRalplanStageOptions {
  executor?: RalplanConsensusExecutor;
  maxIterations?: number;
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
      return isPlanningComplete(readPlanningArtifacts(ctx.cwd)) && hasRalplanConsensusEvidence(ctx);
    },

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      try {
        if (options.executor) {
          const runtimeResult = await runRalplanConsensus(options.executor, {
            task: ctx.task,
            cwd: ctx.cwd,
            maxIterations: options.maxIterations,
          });

          const planningArtifacts = readPlanningArtifacts(ctx.cwd);
          return {
            status: runtimeResult.status === 'completed' ? 'completed' : 'failed',
            artifacts: {
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
              ...runtimeResult.artifacts,
            },
            duration_ms: Date.now() - startTime,
            error: runtimeResult.error,
          };
        }

        const planningArtifacts = readPlanningArtifacts(ctx.cwd);

        return {
          status: 'failed',
          artifacts: {
            plansDir: planningArtifacts.plansDir,
            specsDir: planningArtifacts.specsDir,
            task: ctx.task,
            prdPaths: planningArtifacts.prdPaths,
            testSpecPaths: planningArtifacts.testSpecPaths,
            deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
            planningComplete: isPlanningComplete(planningArtifacts),
            stage: 'ralplan',
            instruction: `Run RALPLAN consensus planning for: ${ctx.task}`,
          },
          duration_ms: Date.now() - startTime,
          error: 'RALPLAN consensus executor is required before this stage can complete.',
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

export function hasRalplanConsensusEvidence(ctx: Pick<StageContext, 'artifacts' | 'cwd' | 'sessionId'>): boolean {
  const artifacts = ctx.artifacts;
  if (isApprovedRalplanConsensus(artifacts.ralplan_architect_review, artifacts.ralplan_critic_review)) {
    return true;
  }

  const ralplanArtifacts = artifacts.ralplan;
  if (ralplanArtifacts && typeof ralplanArtifacts === 'object') {
    const record = ralplanArtifacts as Record<string, unknown>;
    if (isApprovedRalplanConsensus(record.ralplan_architect_review, record.ralplan_critic_review)) {
      return true;
    }
    if (hasApprovedReviewArray(record.architectReviews) && hasApprovedReviewArray(record.criticReviews)) {
      return true;
    }
  }

  const state = readAutopilotState(ctx.cwd, ctx.sessionId);
  const handoffs = state?.state && typeof state.state === 'object'
    ? (state.state as Record<string, unknown>).handoff_artifacts
    : undefined;
  if (handoffs && typeof handoffs === 'object') {
    const record = handoffs as Record<string, unknown>;
    return isApprovedRalplanConsensus(record.ralplan_architect_review, record.ralplan_critic_review);
  }

  return false;
}

function hasApprovedReviewArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return isApprovedRalplanReview(value[value.length - 1]);
}

function isApprovedRalplanConsensus(architectReview: unknown, criticReview: unknown): boolean {
  if (!isReviewRoleCompatible(architectReview, 'architect')) return false;
  if (!isReviewRoleCompatible(criticReview, 'critic')) return false;
  if (!isReviewOrderCompatible(architectReview, criticReview)) return false;
  return isApprovedRalplanReview(architectReview) && isApprovedRalplanReview(criticReview);
}

function isReviewRoleCompatible(value: unknown, expectedRole: 'architect' | 'critic'): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  const rawRole = [record.role, record.reviewer_role, record.reviewerRole, record.kind, record.type]
    .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  if (!rawRole) return true;
  const normalized = rawRole.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (expectedRole === 'architect') return normalized.includes('architect');
  return normalized.includes('critic');
}

function isReviewOrderCompatible(architectReview: unknown, criticReview: unknown): boolean {
  const architectTimestamp = getReviewTimestampMs(architectReview);
  const criticTimestamp = getReviewTimestampMs(criticReview);
  if (architectTimestamp === undefined || criticTimestamp === undefined) return true;
  return criticTimestamp >= architectTimestamp;
}

function getReviewTimestampMs(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const raw = [record.created_at, record.createdAt, record.submitted_at, record.submittedAt, record.reviewed_at, record.reviewedAt, record.timestamp]
    .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isApprovedRalplanReview(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return isApprovedReviewToken(value);
  if (typeof value !== 'object' || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const tokens = [
    record.verdict,
    record.recommendation,
    record.status,
    record.decision,
    record.result,
    record.outcome,
  ].filter((entry): entry is string => typeof entry === 'string');

  if (tokens.some(isRejectedReviewToken)) return false;
  if (hasBooleanBlocker(record)) return false;
  if (tokens.some(isApprovedReviewToken)) return true;
  return record.clean === true || record.approved === true;
}

function hasBooleanBlocker(record: Record<string, unknown>): boolean {
  return [
    record.blocking,
    record.blocked,
    record.block,
    record.rejected,
    record.reject,
    record.iterating,
    record.iterate,
    record.request_changes,
    record.requestChanges,
    record.needs_changes,
    record.needsChanges,
  ].some(value => value === true) || record.clean === false;
}

function isApprovedReviewToken(value: string): boolean {
  return ['approve', 'approved', 'accepted', 'pass', 'passed'].includes(value.trim().toLowerCase());
}

function isRejectedReviewToken(value: string): boolean {
  return [
    'reject',
    'rejected',
    'iterate',
    'iterating',
    'comment',
    'request changes',
    'request_changes',
    'changes requested',
    'changes_requested',
    'needs changes',
    'needs_changes',
    'block',
    'blocked',
    'blocking',
    'watch',
    'fail',
    'failed',
  ].includes(value.trim().toLowerCase());
}

function readAutopilotState(cwd: string, sessionId?: string): Record<string, unknown> | null {
  const explicitSessionId = validateOptionalSessionId(sessionId);
  if (sessionId !== undefined) {
    return explicitSessionId ? readJsonState(getStatePath('autopilot', cwd, explicitSessionId)) : null;
  }

  const currentSessionId = readCurrentSessionIdFromState(cwd);
  if (currentSessionId) {
    const scoped = readJsonState(getStatePath('autopilot', cwd, currentSessionId));
    if (scoped) return scoped;
  }
  return readJsonState(join(cwd, '.omx', 'state', 'autopilot-state.json'));
}

function validateOptionalSessionId(sessionId?: string): string | undefined {
  if (sessionId === undefined) return undefined;
  try {
    return validateSessionId(sessionId);
  } catch {
    return undefined;
  }
}

function readCurrentSessionIdFromState(cwd: string): string | undefined {
  const state = readJsonState(join(getBaseStateDir(cwd), 'session.json'));
  if (!state) return undefined;
  if (typeof state.cwd === 'string' && resolvePath(state.cwd) !== resolvePath(cwd)) return undefined;
  return validateOptionalSessionId(typeof state.session_id === 'string' ? state.session_id : undefined);
}

function readJsonState(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
