import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import type { StageContext } from '../types.js';
import { createRalplanStage } from '../stages/ralplan.js';
import { createTeamExecStage, buildTeamInstruction } from '../stages/team-exec.js';
import { createRalphVerifyStage, buildRalphInstruction } from '../stages/ralph-verify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeCtx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    task: 'test task',
    artifacts: {},
    cwd: tempDir,
    ...overrides,
  };
}

async function setup(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-stages-test-'));
  return tempDir;
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// RALPLAN stage tests
// ---------------------------------------------------------------------------

describe('RALPLAN Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createRalplanStage();
    assert.equal(stage.name, 'ralplan');
  });

  it('runs successfully and produces artifacts', async () => {
    const stage = createRalplanStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    assert.equal((result.artifacts as Record<string, unknown>).stage, 'ralplan');
    assert.ok((result.artifacts as Record<string, unknown>).instruction);
  });

  it('canSkip returns false when no plans directory exists', () => {
    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when plans directory is empty', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns true when a prd- plan file exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), true);
  });

  it('canSkip returns false for non-prd plan files', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'autopilot-spec.md'), '# Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });
});

// ---------------------------------------------------------------------------
// Team exec stage tests
// ---------------------------------------------------------------------------

describe('Team Exec Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createTeamExecStage();
    assert.equal(stage.name, 'team-exec');
  });

  it('uses default worker count and agent type', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 2);
    assert.equal(arts.agentType, 'executor');
  });

  it('respects custom worker count and agent type', async () => {
    const stage = createTeamExecStage({ workerCount: 4, agentType: 'architect' });
    const result = await stage.run(makeCtx());

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 4);
    assert.equal(arts.agentType, 'architect');
  });

  it('includes ralplan artifacts in team task when available', async () => {
    const stage = createTeamExecStage();
    const ctx = makeCtx({
      artifacts: {
        ralplan: { data: 'plan-content', stage: 'ralplan' },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.ok((descriptor.task as string).includes('plan-content'));
  });

  it('falls back to raw task when no ralplan artifacts exist', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({ task: 'raw task description' }));

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'raw task description');
  });

  describe('buildTeamInstruction', () => {
    it('builds correct CLI instruction', () => {
      const instruction = buildTeamInstruction({
        task: 'implement feature',
        workerCount: 3,
        agentType: 'executor',
        useWorktrees: false,
        cwd: '/tmp/test',
      });

      assert.match(instruction, /^omx team 3:executor/);
      assert.match(instruction, /implement feature/);
    });

    it('truncates long task descriptions', () => {
      const longTask = 'a'.repeat(1000);
      const instruction = buildTeamInstruction({
        task: longTask,
        workerCount: 1,
        agentType: 'executor',
        useWorktrees: false,
        cwd: '/tmp',
      });

      // The instruction should contain a truncated version (500 chars max)
      assert.ok(instruction.length < longTask.length);
    });
  });
});

// ---------------------------------------------------------------------------
// Ralph verify stage tests
// ---------------------------------------------------------------------------

describe('Ralph Verify Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createRalphVerifyStage();
    assert.equal(stage.name, 'ralph-verify');
  });

  it('uses default max iterations of 10', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.maxIterations, 10);
  });

  it('respects custom max iterations', async () => {
    const stage = createRalphVerifyStage({ maxIterations: 25 });
    const result = await stage.run(makeCtx());

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.maxIterations, 25);
  });

  it('includes team-exec artifacts in verification context', async () => {
    const stage = createRalphVerifyStage();
    const ctx = makeCtx({
      artifacts: {
        'team-exec': { teamDescriptor: { task: 'completed work' } },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    const execArtifacts = descriptor.executionArtifacts as Record<string, unknown>;
    assert.ok(execArtifacts.teamDescriptor);
  });

  describe('buildRalphInstruction', () => {
    it('includes max iterations in instruction', () => {
      const instruction = buildRalphInstruction({
        task: 'verify feature',
        maxIterations: 15,
        cwd: '/tmp',
        executionArtifacts: {},
      });

      assert.match(instruction, /max 15 iterations/);
      assert.match(instruction, /verify feature/);
    });

    it('truncates long task descriptions', () => {
      const longTask = 'b'.repeat(500);
      const instruction = buildRalphInstruction({
        task: longTask,
        maxIterations: 10,
        cwd: '/tmp',
        executionArtifacts: {},
      });

      assert.ok(instruction.length < longTask.length);
    });
  });
});
