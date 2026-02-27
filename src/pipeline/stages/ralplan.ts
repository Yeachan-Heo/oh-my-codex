/**
 * RALPLAN stage adapter for pipeline orchestrator.
 *
 * Wraps the consensus planning workflow (planner + architect + critic)
 * into a PipelineStage. Produces a plan artifact at `.omx/plans/`.
 */

import { existsSync, readdirSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';

/**
 * Create a RALPLAN pipeline stage.
 *
 * The RALPLAN stage performs consensus planning by coordinating planner,
 * architect, and critic agents. It outputs a plan file that downstream
 * stages (team-exec) consume.
 *
 * This is a structural adapter — actual agent orchestration happens at
 * the skill layer. The stage manages lifecycle, artifact discovery, and
 * skip detection.
 */
export function createRalplanStage(): PipelineStage {
  return {
    name: 'ralplan',

    canSkip(ctx: StageContext): boolean {
      // Skip if a plan artifact already exists
      const plansDir = join(ctx.cwd, '.omx', 'plans');
      if (!existsSync(plansDir)) return false;
      try {
        const files = readdirSync(plansDir) as string[];
        return files.some(
          (f: string) => f.startsWith('prd-') && f.endsWith('.md'),
        );
      } catch {
        return false;
      }
    },

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      const plansDir = join(ctx.cwd, '.omx', 'plans');

      try {
        // Discover any existing plan files
        const existingPlans = await discoverPlanFiles(plansDir);

        return {
          status: 'completed',
          artifacts: {
            plansDir,
            task: ctx.task,
            existingPlans,
            stage: 'ralplan',
            instruction: `Run RALPLAN consensus planning for: ${ctx.task}`,
          },
          duration_ms: Date.now() - startTime,
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

async function discoverPlanFiles(plansDir: string): Promise<string[]> {
  if (!existsSync(plansDir)) return [];
  try {
    const files = await readdir(plansDir);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(plansDir, f));
  } catch {
    return [];
  }
}
