/**
 * Pipeline Orchestrator for oh-my-codex
 *
 * Sequences configurable stages (deep-interview -> ralplan -> ultragoal -> code-review -> ultraqa)
 * and persists state through the ModeState system.
 *
 * Mirrors OMC #1130 pipeline design with OMX-specific adaptations:
 * - Legacy Ralph iteration count is configurable
 * - Code review is the merge-readiness gate
 * - Non-clean review artifacts can drive a return to ralplan
 */

import { startMode, readModeState, updateModeState, cancelMode } from '../modes/base.js';
import { createDeepInterviewStage } from './stages/deep-interview.js';
import { createRalplanStage } from './stages/ralplan.js';
import { createUltragoalStage } from './stages/ultragoal.js';
import { createCodeReviewStage } from './stages/code-review.js';
import { createUltraqaStage } from './stages/ultraqa.js';
import { isNonCleanReviewVerdict } from './review-verdict.js';
import type {
  PipelineConfig,
  PipelineResult,
  PipelineModeStateExtension,
  PipelineStage,
  StageContext,
  StageResult,
} from './types.js';

const MODE_NAME = 'autopilot' as const;

// ---------------------------------------------------------------------------
// Pipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a configured pipeline to completion.
 *
 * Executes stages sequentially, passing accumulated artifacts between them.
 * State is persisted after each stage transition via the ModeState system.
 */
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  validateConfig(config);

  const cwd = config.cwd ?? process.cwd();
  const maxRalphIterations = config.maxRalphIterations ?? 10;
  const workerCount = config.workerCount ?? 2;
  const agentType = config.agentType ?? 'executor';
  const startTime = Date.now();

  // Initialize pipeline mode state
  const modeState = await startMode(MODE_NAME, config.task, config.stages.length, cwd);

  const pipelineExtension: PipelineModeStateExtension = {
    pipeline_name: config.name,
    pipeline_stages: config.stages.map((s) => s.name),
    pipeline_stage_index: 0,
    pipeline_stage_results: {},
    pipeline_max_ralph_iterations: maxRalphIterations,
    pipeline_worker_count: workerCount,
    pipeline_agent_type: agentType,
    review_cycle: 0,
    review_verdict: null,
    qa_verdict: null,
    return_to_ralplan_reason: null,
    handoff_artifacts: {
      ralplan_consensus_gate: {
        required: true,
        sequence: ['architect-review', 'critic-review'],
        planning_artifacts_are_not_consensus: true,
        required_review_roles: ['architect', 'critic'],
        ralplan_architect_review: null,
        ralplan_critic_review: null,
        complete: false,
      },
    },
  };

  await updateModeState(MODE_NAME, {
    ...modeState,
    ...pipelineExtension,
    current_phase: config.stages[0].name,
  }, cwd);

  // Execute stages sequentially
  const stageResults: Record<string, StageResult> = {};
  const artifacts: Record<string, unknown> = {};
  const handoffArtifactsByStage: Record<string, unknown> = {};
  let previousResult: StageResult | undefined;
  let lastStageName: string | undefined;
  let reviewCycle = 0;

  for (let i = 0; i < config.stages.length; i++) {
    const stage = config.stages[i];

    // Build stage context
    const ctx: StageContext = {
      task: config.task,
      artifacts: { ...artifacts },
      previousStageResult: previousResult,
      cwd,
      sessionId: config.sessionId,
    };

    // Fire transition callback from last completed/skipped stage to this one
    if (lastStageName && config.onStageTransition) {
      config.onStageTransition(lastStageName, stage.name);
    }

    // Check if stage should be skipped
    if (stage.canSkip?.(ctx)) {
      let skippedArtifacts: Record<string, unknown> = {};
      if (stage.name === 'ralplan') {
        const materialized = await stage.run(ctx);
        skippedArtifacts = materialized.artifacts;
      }
      const skippedResult: StageResult = {
        status: 'skipped',
        artifacts: skippedArtifacts,
        duration_ms: 0,
      };
      stageResults[stage.name] = skippedResult;
      if (Object.keys(skippedArtifacts).length > 0) {
        Object.assign(artifacts, { [stage.name]: skippedArtifacts });
        Object.assign(handoffArtifactsByStage, { [stage.name]: skippedArtifacts });
      }

      await updateModeState(MODE_NAME, {
        current_phase: `${stage.name}:skipped`,
        pipeline_stage_index: i,
        pipeline_stage_results: { ...stageResults },
        handoff_artifacts: normalizeHandoffArtifactKeys(handoffArtifactsByStage),
      } as Partial<PipelineModeStateExtension>, cwd);

      lastStageName = stage.name;
      previousResult = skippedResult;
      continue;
    }

    // Update state to running
    await updateModeState(MODE_NAME, {
      current_phase: stage.name,
      pipeline_stage_index: i,
      iteration: i + 1,
    } as Partial<PipelineModeStateExtension>, cwd);

    // Execute the stage
    let result: StageResult;
    try {
      result = await stage.run(ctx);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = {
        status: 'failed',
        artifacts: {},
        duration_ms: Date.now() - startTime,
        error: `Stage ${stage.name} threw: ${errorMsg}`,
      };
    }

    stageResults[stage.name] = result;

    // Merge artifacts
    if (result.artifacts) {
      Object.assign(artifacts, { [stage.name]: result.artifacts });
      Object.assign(handoffArtifactsByStage, { [stage.name]: result.artifacts });
    }

    const resultArtifacts = result.artifacts as Record<string, unknown>;
    const reviewVerdict = stage.name === 'code-review' ? resultArtifacts.review_verdict : undefined;
    const qaVerdict = stage.name === 'ultraqa' ? resultArtifacts.qa_verdict : undefined;
    const returnToRalplanReason = (stage.name === 'code-review' || stage.name === 'ultraqa')
      ? resultArtifacts.return_to_ralplan_reason as string | null | undefined
      : undefined;
    const reviewIsNotClean = stage.name === 'code-review'
      && result.status === 'completed'
      && isNonCleanReviewVerdict(reviewVerdict);
    const qaIsNotClean = stage.name === 'ultraqa'
      && result.status === 'completed'
      && isNonCleanQaVerdict(qaVerdict);
    const shouldReturnToRalplan = reviewIsNotClean || qaIsNotClean;

    if (stage.name === 'code-review') {
      artifacts.review_verdict = reviewVerdict ?? null;
      artifacts.return_to_ralplan_reason = returnToRalplanReason ?? null;
    }
    if (stage.name === 'ultraqa') {
      artifacts.qa_verdict = qaVerdict ?? null;
      artifacts.return_to_ralplan_reason = returnToRalplanReason ?? null;
    }

    if (shouldReturnToRalplan) {
      reviewCycle += 1;
    }

    const handoffArtifacts = normalizeHandoffArtifactKeys(handoffArtifactsByStage);

    // Persist stage result
    await updateModeState(MODE_NAME, {
      current_phase: shouldReturnToRalplan ? 'ralplan' : (result.status === 'completed' ? stage.name : `${stage.name}:${result.status}`),
      handoff_artifacts: handoffArtifacts,
      ...(stage.name === 'code-review' ? {
        review_verdict: reviewVerdict,
        return_to_ralplan_reason: returnToRalplanReason ?? null,
        review_cycle: reviewCycle,
      } : {}),
      ...(stage.name === 'ultraqa' ? {
        qa_verdict: qaVerdict,
        return_to_ralplan_reason: returnToRalplanReason ?? null,
        review_cycle: reviewCycle,
      } : {}),
      pipeline_stage_index: shouldReturnToRalplan ? findStageIndex(config.stages, 'ralplan') : i,
      pipeline_stage_results: { ...stageResults },
    } as Partial<PipelineModeStateExtension>, cwd);

    // Bail on failure
    if (result.status === 'failed') {
      const duration_ms = Date.now() - startTime;

      await updateModeState(MODE_NAME, {
        active: false,
        current_phase: 'failed',
        completed_at: new Date().toISOString(),
        error: result.error,
      }, cwd);

      return {
        status: 'failed',
        stageResults,
        duration_ms,
        artifacts,
        error: result.error,
        failedStage: stage.name,
      };
    }

    if (shouldReturnToRalplan) {
      if (reviewCycle >= maxRalphIterations) {
        const error = returnToRalplanReason
          ? `Autopilot quality gates were not clean after ${reviewCycle} cycle(s): ${returnToRalplanReason}`
          : `Autopilot quality gates were not clean after ${reviewCycle} cycle(s).`;
        const duration_ms = Date.now() - startTime;

        await updateModeState(MODE_NAME, {
          active: false,
          current_phase: 'failed',
          completed_at: new Date().toISOString(),
          error,
        }, cwd);

        return {
          status: 'failed',
          stageResults,
          duration_ms,
          artifacts,
          error,
          failedStage: stage.name,
        };
      }

      if (config.onStageTransition) {
        config.onStageTransition(stage.name, 'ralplan');
      }
      lastStageName = undefined;
      previousResult = result;
      i = findStageIndex(config.stages, 'ralplan') - 1;
      continue;
    }

    lastStageName = stage.name;
    previousResult = result;
  }

  // All stages completed
  const duration_ms = Date.now() - startTime;

  await updateModeState(MODE_NAME, {
    active: false,
    current_phase: 'complete',
    completed_at: new Date().toISOString(),
  }, cwd);

  return {
    status: 'completed',
    stageResults,
    duration_ms,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Resume support
// ---------------------------------------------------------------------------

/**
 * Resume a pipeline from its last persisted state.
 *
 * Reads the pipeline ModeState and reconstructs a PipelineConfig starting
 * from the stage that was interrupted.
 */
export async function canResumePipeline(cwd?: string): Promise<boolean> {
  const state = await readModeState(MODE_NAME, cwd);
  if (!state) return false;
  return state.active === true && state.current_phase !== 'complete' && state.current_phase !== 'failed';
}

/**
 * Read the current pipeline state extension fields.
 */
export async function readPipelineState(
  cwd?: string,
): Promise<PipelineModeStateExtension | null> {
  const state = await readModeState(MODE_NAME, cwd);
  if (!state) return null;
  if (!state.pipeline_name) return null;

  return {
    pipeline_name: state.pipeline_name as string,
    pipeline_stages: state.pipeline_stages as string[],
    pipeline_stage_index: state.pipeline_stage_index as number,
    pipeline_stage_results: state.pipeline_stage_results as Record<string, StageResult>,
    pipeline_max_ralph_iterations: state.pipeline_max_ralph_iterations as number,
    pipeline_worker_count: state.pipeline_worker_count as number,
    pipeline_agent_type: state.pipeline_agent_type as string,
    review_cycle: state.review_cycle as number | undefined,
    review_verdict: state.review_verdict,
    qa_verdict: state.qa_verdict,
    return_to_ralplan_reason: state.return_to_ralplan_reason as string | null | undefined,
    handoff_artifacts: state.handoff_artifacts as Record<string, unknown> | undefined,
  };
}

/**
 * Cancel a running pipeline.
 */
export async function cancelPipeline(cwd?: string): Promise<void> {
  await cancelMode(MODE_NAME, cwd);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeHandoffArtifactKeys(artifacts: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(artifacts)) {
    normalized[toHandoffArtifactKey(key)] = value;
    if (key === 'ralplan' && value && typeof value === 'object') {
      const ralplanArtifacts = value as Record<string, unknown>;
      const gate = ralplanArtifacts.ralplanConsensusGate ?? ralplanArtifacts.ralplan_consensus_gate;
      if (gate) {
        normalized.ralplan_consensus_gate = gate;
      }
    }
  }
  return normalized;
}

function toHandoffArtifactKey(stageName: string): string {
  switch (stageName) {
    case 'code-review':
      return 'code_review';
    case 'deep-interview':
      return 'deep_interview';
    default:
      return stageName;
  }
}

function findStageIndex(stages: readonly PipelineStage[], stageName: string): number {
  const index = stages.findIndex((stage) => stage.name === stageName);
  return index >= 0 ? index : 0;
}

function validateConfig(config: PipelineConfig): void {
  if (!config.name || config.name.trim() === '') {
    throw new Error('Pipeline config requires a non-empty name');
  }
  if (!config.task || config.task.trim() === '') {
    throw new Error('Pipeline config requires a non-empty task');
  }
  if (!config.stages || config.stages.length === 0) {
    throw new Error('Pipeline config requires at least one stage');
  }

  // Ensure unique stage names
  const names = new Set<string>();
  for (const stage of config.stages) {
    if (!stage.name || stage.name.trim() === '') {
      throw new Error('Every pipeline stage must have a non-empty name');
    }
    if (names.has(stage.name)) {
      throw new Error(`Duplicate stage name: ${stage.name}`);
    }
    names.add(stage.name);
  }

  if (config.maxRalphIterations != null) {
    if (!Number.isInteger(config.maxRalphIterations) || config.maxRalphIterations <= 0) {
      throw new Error('maxRalphIterations must be a positive integer');
    }
  }

  if (config.workerCount != null) {
    if (!Number.isInteger(config.workerCount) || config.workerCount <= 0) {
      throw new Error('workerCount must be a positive integer');
    }
  }
}

// ---------------------------------------------------------------------------
// Default autopilot pipeline factory
// ---------------------------------------------------------------------------

/**
 * Create the default autopilot pipeline configuration.
 *
 * Sequences: deep-interview -> ralplan -> ultragoal -> code-review -> ultraqa.
 * This is the default Autopilot loop required by the skill contract.
 * Custom stages can still preserve explicit legacy Ralph execution paths.
 */
export function createAutopilotPipelineConfig(
  task: string,
  options: {
    cwd?: string;
    sessionId?: string;
    maxRalphIterations?: number;
    workerCount?: number;
    agentType?: string;
    stages?: PipelineConfig['stages'];
    onStageTransition?: PipelineConfig['onStageTransition'];
  },
): PipelineConfig {
  return {
    name: 'autopilot',
    task,
    stages: options.stages ?? createStrictAutopilotStages(),
    cwd: options.cwd,
    sessionId: options.sessionId,
    maxRalphIterations: options.maxRalphIterations ?? 10,
    workerCount: options.workerCount ?? 2,
    agentType: options.agentType ?? 'executor',
    onStageTransition: options.onStageTransition,
  };
}

export function createStrictAutopilotStages(): PipelineConfig['stages'] {
  return [
    createDeepInterviewStage(),
    createRalplanStage(),
    createUltragoalStage(),
    createCodeReviewStage(),
    createUltraqaStage(),
  ];
}

function isNonCleanQaVerdict(verdict: unknown): boolean {
  if (!verdict || typeof verdict !== 'object') return true;
  return (verdict as { clean?: unknown }).clean !== true;
}
