import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  runPipeline,
  canResumePipeline,
  readPipelineState,
  cancelPipeline,
  createAutopilotPipelineConfig,
} from '../orchestrator.js';
import type { PipelineConfig, PipelineStage, StageContext, StageResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
  name: string,
  result: Partial<StageResult> = {},
  opts?: { canSkip?: (ctx: StageContext) => boolean; delay?: number },
): PipelineStage {
  return {
    name,
    canSkip: opts?.canSkip,
    async run(_ctx: StageContext): Promise<StageResult> {
      if (opts?.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return {
        status: 'completed',
        artifacts: { produced_by: name },
        duration_ms: 0,
        ...result,
      };
    },
  };
}

function makeFailingStage(name: string, error: string): PipelineStage {
  return {
    name,
    async run(): Promise<StageResult> {
      return {
        status: 'failed',
        artifacts: {},
        duration_ms: 0,
        error,
      };
    },
  };
}

function makeThrowingStage(name: string, message: string): PipelineStage {
  return {
    name,
    async run(): Promise<StageResult> {
      throw new Error(message);
    },
  };
}

let tempDir: string;

async function setup(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-pipeline-test-'));
  return tempDir;
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline Orchestrator', () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('runPipeline', () => {
    it('runs a single-stage pipeline to completion', async () => {
      const config: PipelineConfig = {
        name: 'test-single',
        task: 'test task',
        stages: [makeStage('stage-a')],
        cwd: tempDir,
      };

      const result = await runPipeline(config);

      assert.equal(result.status, 'completed');
      assert.ok(result.stageResults['stage-a']);
      assert.equal(result.stageResults['stage-a'].status, 'completed');
      assert.ok(result.duration_ms >= 0);
    });

    it('runs a multi-stage pipeline sequentially', async () => {
      const order: string[] = [];
      const stages: PipelineStage[] = ['a', 'b', 'c'].map((name) => ({
        name: `stage-${name}`,
        async run(ctx: StageContext): Promise<StageResult> {
          order.push(`stage-${name}`);
          return {
            status: 'completed',
            artifacts: { step: name, prevArtifacts: Object.keys(ctx.artifacts) },
            duration_ms: 0,
          };
        },
      }));

      const result = await runPipeline({
        name: 'test-multi',
        task: 'multi-stage test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(order, ['stage-a', 'stage-b', 'stage-c']);
      assert.equal(Object.keys(result.stageResults).length, 3);
    });

    it('passes artifacts between stages', async () => {
      let receivedArtifacts: Record<string, unknown> = {};

      const stages: PipelineStage[] = [
        {
          name: 'producer',
          async run(): Promise<StageResult> {
            return {
              status: 'completed',
              artifacts: { data: 'from-producer' },
              duration_ms: 0,
            };
          },
        },
        {
          name: 'consumer',
          async run(ctx: StageContext): Promise<StageResult> {
            receivedArtifacts = ctx.artifacts;
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
      ];

      await runPipeline({ name: 'artifact-test', task: 'test', stages, cwd: tempDir });

      assert.ok(receivedArtifacts['producer']);
      assert.deepEqual(
        (receivedArtifacts['producer'] as Record<string, unknown>).data,
        'from-producer',
      );
    });

    it('stops pipeline on stage failure and reports failed stage', async () => {
      const stages: PipelineStage[] = [
        makeStage('ok-stage'),
        makeFailingStage('bad-stage', 'something broke'),
        makeStage('never-reached'),
      ];

      const result = await runPipeline({
        name: 'fail-test',
        task: 'test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'bad-stage');
      assert.equal(result.error, 'something broke');
      assert.ok(result.stageResults['ok-stage']);
      assert.ok(result.stageResults['bad-stage']);
      assert.equal(result.stageResults['never-reached'], undefined);
    });

    it('catches thrown errors and converts to failed result', async () => {
      const stages = [makeThrowingStage('throwing', 'kaboom')];

      const result = await runPipeline({
        name: 'throw-test',
        task: 'test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'throwing');
      assert.match(result.error!, /kaboom/);
    });

    it('skips stages when canSkip returns true', async () => {
      const ran: string[] = [];
      const stages: PipelineStage[] = [
        makeStage('always-run'),
        {
          name: 'skippable',
          canSkip: () => true,
          async run(): Promise<StageResult> {
            ran.push('skippable');
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
        {
          name: 'after-skip',
          async run(): Promise<StageResult> {
            ran.push('after-skip');
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
      ];

      const result = await runPipeline({
        name: 'skip-test',
        task: 'test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.stageResults['skippable'].status, 'skipped');
      assert.ok(!ran.includes('skippable'));
      assert.ok(ran.includes('after-skip'));
    });

    it('fires onStageTransition callback', async () => {
      const transitions: Array<[string, string]> = [];
      const stages = [makeStage('a'), makeStage('b'), makeStage('c')];

      await runPipeline({
        name: 'transition-test',
        task: 'test',
        stages,
        cwd: tempDir,
        onStageTransition: (from, to) => transitions.push([from, to]),
      });

      assert.deepEqual(transitions, [
        ['a', 'b'],
        ['b', 'c'],
      ]);
    });

    it('fires correct transitions when middle stage is skipped', async () => {
      const transitions: Array<[string, string]> = [];
      const stages: PipelineStage[] = [
        makeStage('a'),
        {
          name: 'b-skipped',
          canSkip: () => true,
          async run(): Promise<StageResult> {
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
        makeStage('c'),
      ];

      await runPipeline({
        name: 'skip-transition-test',
        task: 'test',
        stages,
        cwd: tempDir,
        onStageTransition: (from, to) => transitions.push([from, to]),
      });

      assert.deepEqual(transitions, [
        ['a', 'b-skipped'],
        ['b-skipped', 'c'],
      ]);
    });

    it('passes previousStageResult to the next stage', async () => {
      let receivedPrevResult: StageResult | undefined;

      const stages: PipelineStage[] = [
        {
          name: 'first',
          async run(): Promise<StageResult> {
            return {
              status: 'completed',
              artifacts: { marker: 'first-stage' },
              duration_ms: 42,
            };
          },
        },
        {
          name: 'second',
          async run(ctx: StageContext): Promise<StageResult> {
            receivedPrevResult = ctx.previousStageResult;
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
      ];

      await runPipeline({ name: 'prev-result-test', task: 'test', stages, cwd: tempDir });

      assert.ok(receivedPrevResult);
      assert.equal(receivedPrevResult!.status, 'completed');
      assert.deepEqual(receivedPrevResult!.artifacts, { marker: 'first-stage' });
    });

    it('persists pipeline state to mode state file', async () => {
      await runPipeline({
        name: 'persist-test',
        task: 'persistence check',
        stages: [makeStage('only')],
        cwd: tempDir,
      });

      const statePath = join(tempDir, '.omx', 'state', 'autopilot-state.json');
      assert.ok(existsSync(statePath), 'pipeline state file should exist');

      const raw = await readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'complete');
      assert.equal(state.pipeline_name, 'persist-test');
    });

    it('persists failed state with error', async () => {
      await runPipeline({
        name: 'fail-persist',
        task: 'will fail',
        stages: [makeFailingStage('failing', 'oops')],
        cwd: tempDir,
      });

      const statePath = join(tempDir, '.omx', 'state', 'autopilot-state.json');
      const raw = await readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'failed');
      assert.equal(state.error, 'oops');
    });
  });

  describe('validation', () => {
    it('rejects config with empty name', async () => {
      await assert.rejects(
        () => runPipeline({ name: '', task: 'x', stages: [makeStage('a')], cwd: tempDir }),
        /non-empty name/,
      );
    });

    it('rejects config with empty task', async () => {
      await assert.rejects(
        () => runPipeline({ name: 'x', task: '', stages: [makeStage('a')], cwd: tempDir }),
        /non-empty task/,
      );
    });

    it('rejects config with no stages', async () => {
      await assert.rejects(
        () => runPipeline({ name: 'x', task: 'x', stages: [], cwd: tempDir }),
        /at least one stage/,
      );
    });

    it('rejects duplicate stage names', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('dup'), makeStage('dup')],
          cwd: tempDir,
        }),
        /Duplicate stage name/,
      );
    });

    it('rejects non-positive maxRalphIterations', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('a')],
          cwd: tempDir,
          maxRalphIterations: 0,
        }),
        /maxRalphIterations must be a positive integer/,
      );
    });

    it('rejects non-positive workerCount', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('a')],
          cwd: tempDir,
          workerCount: -1,
        }),
        /workerCount must be a positive integer/,
      );
    });
  });

  describe('canResumePipeline', () => {
    it('returns false when no state exists', async () => {
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns false after completed pipeline', async () => {
      await runPipeline({
        name: 'complete',
        task: 'test',
        stages: [makeStage('a')],
        cwd: tempDir,
      });
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns false after failed pipeline', async () => {
      await runPipeline({
        name: 'fail',
        task: 'test',
        stages: [makeFailingStage('bad', 'err')],
        cwd: tempDir,
      });
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns true when pipeline state is active and in-progress', async () => {
      // Manually write an in-progress pipeline state
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('fs/promises');
      const stateDir = join(tempDir, '.omx', 'state');
      await mkdirFs(stateDir, { recursive: true });
      await writeFileFs(
        join(stateDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          iteration: 1,
          max_iterations: 3,
          current_phase: 'stage:team-exec',
          pipeline_name: 'resume-test',
          started_at: new Date().toISOString(),
        }),
      );
      assert.equal(await canResumePipeline(tempDir), true);
    });
  });

  describe('readPipelineState', () => {
    it('returns null when no state exists', async () => {
      assert.equal(await readPipelineState(tempDir), null);
    });

    it('returns extension fields after a run', async () => {
      await runPipeline({
        name: 'read-test',
        task: 'read task',
        stages: [makeStage('s1'), makeStage('s2')],
        cwd: tempDir,
        maxRalphIterations: 5,
        workerCount: 3,
        agentType: 'analyst',
      });

      const ext = await readPipelineState(tempDir);
      assert.ok(ext);
      assert.equal(ext.pipeline_name, 'read-test');
      assert.deepEqual(ext.pipeline_stages, ['s1', 's2']);
      assert.equal(ext.pipeline_max_ralph_iterations, 5);
      assert.equal(ext.pipeline_worker_count, 3);
      assert.equal(ext.pipeline_agent_type, 'analyst');
    });
  });

  describe('cancelPipeline', () => {
    it('does not throw when no state exists', async () => {
      await assert.doesNotReject(() => cancelPipeline(tempDir));
    });
  });

  describe('createAutopilotPipelineConfig', () => {
    it('creates config with default values', () => {
      const stages = [makeStage('a')];
      const config = createAutopilotPipelineConfig('build feature X', { stages });

      assert.equal(config.name, 'autopilot');
      assert.equal(config.task, 'build feature X');
      assert.equal(config.maxRalphIterations, 10);
      assert.equal(config.workerCount, 2);
      assert.equal(config.agentType, 'executor');
      assert.equal(config.stages.length, 1);
    });

    it('accepts custom overrides', () => {
      const stages = [makeStage('a'), makeStage('b')];
      const config = createAutopilotPipelineConfig('task', {
        stages,
        maxRalphIterations: 20,
        workerCount: 4,
        agentType: 'architect',
        cwd: '/tmp/test',
        sessionId: 'session-1',
      });

      assert.equal(config.maxRalphIterations, 20);
      assert.equal(config.workerCount, 4);
      assert.equal(config.agentType, 'architect');
      assert.equal(config.cwd, '/tmp/test');
      assert.equal(config.sessionId, 'session-1');
    });
  });
});
