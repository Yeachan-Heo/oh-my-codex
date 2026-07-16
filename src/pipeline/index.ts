/**
 * Pipeline orchestrator for oh-my-codex
 *
 * Configurable pipeline that sequences: deep-interview -> ralplan -> ultragoal -> rework -> code-review -> ultraqa.
 * This is the default Autopilot loop; legacy team/ralph-verify adapters remain available.
 *
 * @module pipeline
 */

export type {
  PipelineConfig,
  PipelineModeStateExtension,
  PipelineResult,
  PipelineStage,
  StageContext,
  StageResult,
} from './types.js';

export {
  cancelPipeline,
  canResumePipeline,
  createAutopilotPipelineConfig,
  createStrictAutopilotStages,
  readPipelineState,
  runPipeline,
} from './orchestrator.js';

export { createDeepInterviewStage, buildDeepInterviewInstruction } from './stages/deep-interview.js';
export type { DeepInterviewDescriptor } from './stages/deep-interview.js';
export { createRalplanStage } from './stages/ralplan.js';
export type { CreateRalplanStageOptions } from './stages/ralplan.js';
export { createTeamExecStage, buildTeamInstruction } from './stages/team-exec.js';
export type { TeamExecStageOptions, TeamExecDescriptor } from './stages/team-exec.js';
export { createRalphVerifyStage, createRalphStage, buildRalphInstruction } from './stages/ralph-verify.js';
export type { RalphVerifyStageOptions, RalphVerifyDescriptor } from './stages/ralph-verify.js';
export { createUltragoalStage, buildUltragoalInstruction } from './stages/ultragoal.js';
export type { UltragoalDescriptor } from './stages/ultragoal.js';
export { createReworkStage, buildReworkInstruction } from './stages/rework.js';
export type { ReworkDescriptor } from './stages/rework.js';
export { createCodeReviewStage, buildCodeReviewInstruction } from './stages/code-review.js';
export type { CodeReviewStageOptions, CodeReviewDescriptor, CodeReviewVerdict } from './stages/code-review.js';
export { createUltraqaStage, buildUltraqaInstruction } from './stages/ultraqa.js';
export type { UltraqaStageOptions, UltraqaDescriptor, UltraqaVerdict } from './stages/ultraqa.js';
