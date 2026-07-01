/**
 * Ultragoal stage adapter for the default Autopilot loop.
 *
 * Produces a model-facing instruction for durable goal-mode execution. Team is
 * intentionally conditional and must be launched explicitly inside an Ultragoal
 * story when parallel execution is warranted.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { LEADER_CONDUCTOR_BLOCK } from '../../leader/contract.js';

export interface UltragoalDescriptor {
  task: string;
  cwd: string;
  sessionId?: string;
  ralplanArtifacts: Record<string, unknown>;
  instruction: string;
  teamCondition: string;
}

export function createUltragoalStage(): PipelineStage {
  return {
    name: 'ultragoal',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      const ralplanArtifacts = ctx.artifacts.ralplan as Record<string, unknown> | undefined;
      const descriptor: UltragoalDescriptor = {
        task: ctx.task,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        ralplanArtifacts: ralplanArtifacts ?? {},
        instruction: buildUltragoalInstruction(ctx.task),
        teamCondition: 'Launch $team only inside an active Ultragoal story when independent lanes or broad verification make coordinated parallel work useful; Ultragoal remains leader-owned for goal and ledger state.',
      };

      return {
        status: 'completed',
        artifacts: {
          stage: 'ultragoal',
          ultragoalDescriptor: descriptor,
          team_condition: descriptor.teamCondition,
          instruction: descriptor.instruction,
        },
        duration_ms: Date.now() - startTime,
      };
    },
  };
}

export function buildUltragoalInstruction(task: string): string {
  return [
    `$ultragoal ${JSON.stringify(task)}`,
    '',
    LEADER_CONDUCTOR_BLOCK,
  ].join('\n');
}
