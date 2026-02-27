/**
 * Ralph verification stage adapter for pipeline orchestrator.
 *
 * Wraps the ralph persistence loop into a PipelineStage for the
 * verification phase. Uses configurable iteration count.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';

export interface RalphVerifyStageOptions {
  /**
   * Maximum number of ralph verification iterations.
   * Defaults to 10.
   */
  maxIterations?: number;
}

/**
 * Create a ralph-verify pipeline stage.
 *
 * This stage wraps the ralph persistence loop for the verification phase
 * of the pipeline. It takes the execution results from team-exec and
 * orchestrates architect-verified completion.
 *
 * The iteration count is configurable, addressing issue #396 requirement
 * for configurable ralph iteration count.
 */
export function createRalphVerifyStage(options: RalphVerifyStageOptions = {}): PipelineStage {
  const maxIterations = options.maxIterations ?? 10;

  return {
    name: 'ralph-verify',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        // Extract execution context from previous stage
        const teamArtifacts = ctx.artifacts['team-exec'] as Record<string, unknown> | undefined;

        // Build ralph verification descriptor
        const verifyDescriptor: RalphVerifyDescriptor = {
          task: ctx.task,
          maxIterations,
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
          executionArtifacts: teamArtifacts ?? {},
        };

        return {
          status: 'completed',
          artifacts: {
            verifyDescriptor,
            maxIterations,
            stage: 'ralph-verify',
            instruction: buildRalphInstruction(verifyDescriptor),
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `Ralph verification stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ralph verification descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for a ralph verification run, consumed by the ralph runtime.
 */
export interface RalphVerifyDescriptor {
  task: string;
  maxIterations: number;
  cwd: string;
  sessionId?: string;
  executionArtifacts: Record<string, unknown>;
}

/**
 * Build the ralph CLI instruction from a descriptor.
 */
export function buildRalphInstruction(descriptor: RalphVerifyDescriptor): string {
  return `ralph verify (max ${descriptor.maxIterations} iterations): ${descriptor.task.slice(0, 200)}`;
}
