/**
 * Pipeline stage interfaces for oh-my-codex
 *
 * Shared stage contracts that align with OMC pipeline design (#1130).
 * The pipeline sequences: RALPLAN -> teams (codex workers) -> ralph verification.
 */

// ---------------------------------------------------------------------------
// Stage context & result
// ---------------------------------------------------------------------------

/**
 * Context passed into each pipeline stage.
 * Accumulates artifacts from prior stages so downstream stages can consume them.
 */
export interface StageContext {
  /** Original task description provided by the user. */
  task: string;

  /** Accumulated artifacts from all prior stages keyed by producing stage name. */
  artifacts: Record<string, unknown>;

  /** Result of the immediately preceding stage (undefined for the first stage). */
  previousStageResult?: StageResult;

  /** Working directory for the pipeline run. */
  cwd: string;

  /** Optional session id for scoped state. */
  sessionId?: string;
}

/**
 * Result returned by each pipeline stage after execution.
 */
export interface StageResult {
  status: 'completed' | 'failed' | 'skipped';

  /** Artifacts produced by this stage (merged into StageContext.artifacts). */
  artifacts: Record<string, unknown>;

  /** Wall-clock duration of the stage in milliseconds. */
  duration_ms: number;

  /** Human-readable error description when status is 'failed'. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Stage interface
// ---------------------------------------------------------------------------

/**
 * A single stage in the pipeline. Implementations wrap concrete execution
 * backends (ralplan, team, ralph) behind this uniform interface.
 */
export interface PipelineStage {
  /** Unique name for this stage (e.g. 'ralplan', 'team-exec', 'ralph-verify'). */
  readonly name: string;

  /** Execute the stage. Must return a StageResult. */
  run(ctx: StageContext): Promise<StageResult>;

  /**
   * Optional predicate — return true to skip this stage.
   * Useful for conditional stages (e.g. skip ralplan if plan already exists).
   */
  canSkip?(ctx: StageContext): boolean;
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a pipeline run.
 */
export interface PipelineConfig {
  /** Human-readable pipeline name (used for state files and logging). */
  name: string;

  /** The task description driving the pipeline. */
  task: string;

  /** Ordered list of stages to execute. */
  stages: PipelineStage[];

  /** Working directory (defaults to process.cwd()). */
  cwd?: string;

  /** Optional session id for scoped state persistence. */
  sessionId?: string;

  /**
   * Maximum ralph verification iterations.
   * Passed through to the ralph-verify stage. Defaults to 10.
   */
  maxRalphIterations?: number;

  /**
   * Number of team workers for the execution stage.
   * Passed through to the team-exec stage. Defaults to 2.
   */
  workerCount?: number;

  /** Agent type for team workers (e.g. 'executor'). Defaults to 'executor'. */
  agentType?: string;

  /** Callback fired on each stage transition. */
  onStageTransition?: (from: string, to: string) => void;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/**
 * Final result of a complete pipeline run.
 */
export interface PipelineResult {
  /** Overall pipeline status. */
  status: 'completed' | 'failed' | 'cancelled';

  /** Per-stage results keyed by stage name. */
  stageResults: Record<string, StageResult>;

  /** Total wall-clock duration in milliseconds. */
  duration_ms: number;

  /** Merged artifact map from all stages. */
  artifacts: Record<string, unknown>;

  /** Error from the failing stage (if any). */
  error?: string;

  /** Name of the stage that failed (if any). */
  failedStage?: string;
}

// ---------------------------------------------------------------------------
// Pipeline state (persisted via ModeState)
// ---------------------------------------------------------------------------

/**
 * Extended ModeState fields for pipeline mode.
 */
export interface PipelineModeStateExtension {
  /** Pipeline config name. */
  pipeline_name: string;

  /** Names of stages in execution order. */
  pipeline_stages: string[];

  /** Index of the currently executing stage. */
  pipeline_stage_index: number;

  /** Per-stage results collected so far. */
  pipeline_stage_results: Record<string, StageResult>;

  /** Ralph iteration ceiling for the verification stage. */
  pipeline_max_ralph_iterations: number;

  /** Worker count for team execution. */
  pipeline_worker_count: number;

  /** Agent type for team workers. */
  pipeline_agent_type: string;
}
