---
name: pipeline
description: Configurable pipeline orchestrator for sequencing stages
---

# Pipeline Skill

`$pipeline` is the configurable pipeline orchestrator for OMX. It sequences stages
through a uniform `PipelineStage` interface, with state persistence and resume support.

## Default Autopilot Pipeline

The canonical OMX pipeline sequences:

```
RALPLAN (consensus planning) -> team-exec (Codex CLI workers) -> ralph-verify (architect verification)
```

## Configuration

Pipeline parameters are configurable per run:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxRalphIterations` | 10 | Ralph verification iteration ceiling |
| `workerCount` | 2 | Number of Codex CLI team workers |
| `agentType` | `executor` | Agent type for team workers |

## Stage Interface

Every stage implements the `PipelineStage` interface:

```typescript
interface PipelineStage {
  readonly name: string;
  run(ctx: StageContext): Promise<StageResult>;
  canSkip?(ctx: StageContext): boolean;
}
```

Stages receive a `StageContext` with accumulated artifacts from prior stages and
return a `StageResult` with status, artifacts, and duration.

## Built-in Stages

- **ralplan**: Consensus planning (planner + architect + critic). Skips if a `prd-*.md` plan already exists.
- **team-exec**: Team execution via Codex CLI workers. Always the OMX execution backend.
- **ralph-verify**: Ralph verification loop with configurable iteration count.

## State Management

Pipeline state persists via the ModeState system at `.omx/state/pipeline-state.json`.
The HUD renders pipeline phase automatically. Resume is supported from the last incomplete stage.

- **On start**: `state_write({mode: "pipeline", active: true, current_phase: "stage:ralplan"})`
- **On stage transitions**: `state_write({mode: "pipeline", current_phase: "stage:<name>"})`
- **On completion**: `state_write({mode: "pipeline", active: false, current_phase: "complete"})`

## API

```typescript
import {
  runPipeline,
  createAutopilotPipelineConfig,
  createRalplanStage,
  createTeamExecStage,
  createRalphVerifyStage,
} from './pipeline/index.js';

const config = createAutopilotPipelineConfig('build feature X', {
  stages: [
    createRalplanStage(),
    createTeamExecStage({ workerCount: 3, agentType: 'executor' }),
    createRalphVerifyStage({ maxIterations: 15 }),
  ],
});

const result = await runPipeline(config);
```

## Relationship to Other Modes

- **autopilot**: Autopilot can use pipeline as its execution engine (v0.8+)
- **team**: Pipeline delegates execution to team mode (Codex CLI workers)
- **ralph**: Pipeline delegates verification to ralph (configurable iterations)
- **ralplan**: Pipeline's first stage runs RALPLAN consensus planning
