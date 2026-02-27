/**
 * Pipeline orchestrator for oh-my-codex
 *
 * Configurable pipeline that sequences: RALPLAN -> teams (codex workers) -> ralph verification.
 * Mirrors OMC #1130 pipeline design.
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
  readPipelineState,
  runPipeline,
} from './orchestrator.js';

export { createRalplanStage } from './stages/ralplan.js';
export { createTeamExecStage, buildTeamInstruction } from './stages/team-exec.js';
export type { TeamExecStageOptions, TeamExecDescriptor } from './stages/team-exec.js';
export { createRalphVerifyStage, buildRalphInstruction } from './stages/ralph-verify.js';
export type { RalphVerifyStageOptions, RalphVerifyDescriptor } from './stages/ralph-verify.js';
