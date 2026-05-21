---
name: pipeline
description: Configurable pipeline orchestrator for sequencing stages
---

# Pipeline Skill

`$pipeline` is the configurable pipeline orchestrator for OMX. It sequences stages
through a uniform `PipelineStage` interface, with state persistence and resume support.

## Default Autopilot Pipeline

The default Autopilot pipeline sequences:

```
deep-interview -> ralplan -> ultragoal (+ team if needed) -> code-review -> ultraqa
```

`$team` is conditional: use it only inside an active Ultragoal story when independent lanes or broad verification make coordinated parallel execution useful. Explicit legacy Ralph pipelines remain available through custom stages, but Ralph is not the advertised default Autopilot loop.

## Configuration

Pipeline parameters are configurable per run:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxRalphIterations` | 10 | Quality-gate retry ceiling; legacy option name retained for compatibility |
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

- **deep-interview**: Requirements clarification and ambiguity gate.
- **ralplan**: Consensus planning (planner + architect + critic). Skips only when both `prd-*.md` and `test-spec-*.md` planning artifacts already exist **and** durable consensus evidence records Architect approval followed by Critic approval. Plan/test-spec files alone are not consensus evidence. If either review is missing, blocked, out of order, or non-approving, the stage remains in ralplan or fails with an explicit blocker/max-iteration outcome instead of progressing to execution. Carries any `deep-interview-*.md` spec paths forward for traceability.
- **ultragoal**: Durable goal-mode execution with `.omx/ultragoal` ledgers. Launch `$team` only from inside an Ultragoal story when parallel lanes are warranted.
- **code-review**: Merge-readiness review gate.
- **ultraqa**: Adversarial QA gate after a clean review; docs-only/trivially non-runtime changes may record an explicit skip reason.
- **team-exec** and **ralph-verify**: Legacy/custom pipeline adapters retained for explicit non-default pipelines.

## State Management

Pipeline state persists via the ModeState system at `.omx/state/pipeline-state.json`.
The HUD renders pipeline phase automatically. Resume is supported from the last incomplete stage.

- **On start**: `omx state write --input '{"mode":"pipeline","active":true,"current_phase":"stage:ralplan"}' --json`
- **On stage transitions**: `omx state write --input '{"mode":"pipeline","current_phase":"stage:<name>"}' --json`
- **On completion**: `omx state write --input '{"mode":"pipeline","active":false,"current_phase":"complete"}' --json`

## API

```typescript
import {
  runPipeline,
  createAutopilotPipelineConfig,
  createDeepInterviewStage,
  createRalplanStage,
  createUltragoalStage,
  createCodeReviewStage,
  createUltraqaStage,
} from './pipeline/index.js';

const config = createAutopilotPipelineConfig('build feature X', {
  stages: [
    createDeepInterviewStage(),
    createRalplanStage(),
    createUltragoalStage(),
    createCodeReviewStage(),
    createUltraqaStage(),
  ],
});

const result = await runPipeline(config);
```

## Relationship to Other Modes

- **autopilot**: Autopilot can use pipeline as its execution engine (v0.8+)
- **team**: Pipeline delegates execution to team mode (Codex CLI workers)
- **ultragoal**: Autopilot delegates durable execution to Ultragoal by default
- **team**: Optional execution engine inside an Ultragoal story when parallel lanes are needed
- **ralph**: Available only for explicit legacy/custom pipelines
- **ralplan**: Pipeline planning runs RALPLAN consensus planning
