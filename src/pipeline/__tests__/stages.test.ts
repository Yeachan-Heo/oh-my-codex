import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import type { StageContext } from '../types.js';
import { createRalplanStage } from '../stages/ralplan.js';
import { createTeamExecStage, buildTeamInstruction } from '../stages/team-exec.js';
import { createRalphVerifyStage, createRalphStage, buildRalphInstruction } from '../stages/ralph-verify.js';
import { createCodeReviewStage, buildCodeReviewInstruction } from '../stages/code-review.js';
import { buildFollowupStaffingPlan } from '../../team/followup-planner.js';
import { packageRoot } from '../../utils/paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function encodeApprovedExecutionTask(task: string, quote: 'single' | 'double'): string {
  return quote === 'single'
    ? `'${task.replace(/'/g, "\\'")}'`
    : `"${task.replace(/"/g, '\\"')}"`;
}

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

function decodeRuntimeCliInstructionPayload(instruction: string): Record<string, unknown> {
  const match = instruction.match(/--input-json-base64\s+([A-Za-z0-9_-]+)/);
  assert.ok(match?.[1], 'expected --input-json-base64 payload');
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  it('canSkip returns false when only a prd- plan file exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns true when both prd and test spec plan files exist', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), true);
  });

  it('canSkip returns false after non-clean code-review loopback even when plans exist', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        return_to_ralplan_reason: 'Review requested a plan update.',
        review_verdict: { recommendation: 'REQUEST CHANGES', architectural_status: 'CLEAR', clean: false },
      },
    })), false);
  });

  it('canSkip returns false when nested code-review artifacts are non-clean', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        'code-review': {
          review_verdict: { recommendation: 'COMMENT', architectural_status: 'CLEAR', clean: true },
          return_to_ralplan_reason: null,
        },
      },
    })), false);
  });

  it('surfaces deep-interview specs in ralplan artifacts for downstream traceability', async () => {
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'deep-interview-my-feature.md'), '# Deep Interview Spec\n');

    const stage = createRalplanStage();
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.deepEqual(artifacts.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-my-feature.md')]);
    assert.equal(artifacts.planningComplete, false);
  });

  it('can execute a real ralplan runtime when an executor is provided', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          const plansDir = join(tempDir, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-runtime.md');
          await writeFile(prdPath, '# Runtime Plan\n');
          await writeFile(join(plansDir, 'test-spec-runtime.md'), '# Runtime Tests\n');
          return { summary: 'drafted', planPath: prdPath, artifacts: { runtimeDrafted: true } };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic ok' };
        },
      },
    });

    const result = await stage.run(makeCtx({ task: 'live ralplan run' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'completed');
    assert.equal(artifacts.runtime, true);
    assert.equal(artifacts.planningComplete, true);
    assert.equal(artifacts.iteration, 1);
    assert.equal(artifacts.runtimeDrafted, true);
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
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(
      (result.artifacts as Record<string, unknown>).instruction as string,
    );

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 4);
    assert.equal(arts.agentType, 'architect');
    assert.equal(runtimeCliInput.agentType, 'architect');
  });

  it('derives the team-exec task from a relative latest approved PRD handoff path', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-zeta.md');
    await writeFile(
      approvedPrdPath,
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            data: 'plan-content',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute zeta handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute zeta handoff',
        command: 'omx team 5:debugger "Execute zeta handoff"',
      });
      assert.match(instruction, /Execute zeta handoff/);
      assert.doesNotMatch(instruction, /plan-content/);
      assert.ok(Array.isArray(descriptor.availableAgentTypes));
      assert.ok((descriptor.availableAgentTypes as unknown[]).length > 0);
      assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
      assert.equal(runtimeCliInput.task, 'Execute zeta handoff');
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
      assert.equal(runtimeCliInput.workerCount, 2);
      assert.equal(runtimeCliInput.agentType, 'executor');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task from the selected approved PRD when a newer draft is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-zeta.md');
    await writeFile(
      approvedPrdPath,
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');
    await writeFile(join(plansDir, 'prd-zulu.md'), '# Zulu draft\n\nNo approved team launch here.\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute zeta handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute zeta handoff',
        command: 'omx team 5:debugger "Execute zeta handoff"',
      });
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('skips newer incomplete runtime drafts when selecting the approved team handoff', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-zeta.md');
    await writeFile(
      approvedPrdPath,
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');
    const incompleteDraftPath = join(plansDir, 'prd-zulu.md');
    await writeFile(incompleteDraftPath, '# Zulu draft\n\nNo approved team launch here.\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
            drafts: [
              { planPath: join('.omx', 'plans', 'prd-zeta.md') },
              { planPath: join('.omx', 'plans', 'prd-zulu.md') },
            ],
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute zeta handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute zeta handoff',
        command: 'omx team 5:debugger "Execute zeta handoff"',
      });
      assert.doesNotMatch(instruction, new RegExp(escapeRegExp(incompleteDraftPath)));
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task when latestPlanPath is already cwd-prefixed', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const relativeCwd = basename(tempDir);
    const previousCwd = process.cwd();
    try {
      process.chdir(dirname(tempDir));
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        cwd: relativeCwd,
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join(relativeCwd, '.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      assert.equal(descriptor.task, 'Execute zeta handoff');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task when latestPlanPath resolves through equivalent relative segments', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const relativeCwd = basename(tempDir);
    const previousCwd = process.cwd();
    try {
      process.chdir(dirname(tempDir));
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        cwd: relativeCwd,
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('..', relativeCwd, '.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      assert.equal(descriptor.task, 'Execute zeta handoff');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task from single-quoted approved handoff text with escapes', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      "# Zeta plan\n\nLaunch via $team 2:executor 'Fix Bob\\'s regression'\n",
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    assert.equal(descriptor.task, "Fix Bob's regression");
    assert.match(instruction, /Fix Bob's regression/);
    assert.doesNotMatch(instruction, /Fix Bob\\'s regression/);
  });

  it('preserves literal backslashes in single-quoted approved handoff text', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const expectedTask = String.raw`Fix C:\\tmp and keep \n literal`;
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta plan\n\nLaunch via $team 2:executor ${encodeApprovedExecutionTask(expectedTask, 'single')}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    assert.equal(descriptor.task, expectedTask);
    assert.ok(instruction.includes(JSON.stringify(expectedTask)));
  });

  it('preserves literal backslashes in double-quoted approved handoff text', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const expectedTask = String.raw`Use C:\tmp and keep \n literal plus "quotes"`;
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta plan\n\nLaunch via omx team 2:executor ${encodeApprovedExecutionTask(expectedTask, 'double')}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    assert.equal(descriptor.task, expectedTask);
    assert.ok(instruction.includes(JSON.stringify(expectedTask)));
  });

  it('derives the team-exec task from the latest ralplan draft when numeric PRD slugs sort lexically out of order', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-9.md'),
      '# Issue 9 plan\n\nLaunch via omx team 2:executor "Execute issue 9 handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-9.md'), '# Issue 9 test spec\n');
    await writeFile(
      join(plansDir, 'prd-issue-10.md'),
      '# Issue 10 plan\n\nLaunch via omx team 3:debugger "Execute issue 10 handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-10.md'), '# Issue 10 test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-issue-10.md'),
          drafts: [
            { planPath: join('.omx', 'plans', 'prd-issue-9.md') },
            { planPath: join('.omx', 'plans', 'prd-issue-10.md') },
          ],
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'Execute issue 10 handoff');
  });

  it('fails closed when latestPlanPath is not the selected latest approved PRD', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const stalePrdPath = join(plansDir, 'prd-alpha.md');
    await writeFile(
      stalePrdPath,
      '# Alpha plan\n\nLaunch via omx team 2:executor "Execute alpha handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha test spec\n');
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          data: 'plan-content',
          stage: 'ralplan',
          latestPlanPath: stalePrdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_stale:/);
    assert.deepEqual(result.artifacts, {});
  });

  it('keeps structural ralplan handoffs on the generic task path', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'structural pipeline task',
      artifacts: {
        ralplan: {
          task: 'structural pipeline task',
          data: 'plan-content',
          stage: 'ralplan',
          plansDir: join(tempDir, '.omx', 'plans'),
          specsDir: join(tempDir, '.omx', 'specs'),
          prdPaths: [],
          testSpecPaths: [],
          deepInterviewSpecPaths: [],
          planningComplete: false,
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
    assert.equal(descriptor.task, 'structural pipeline task');
    assert.equal(descriptor.approvedExecution, null);
    assert.match(instruction, /structural pipeline task/);
    assert.doesNotMatch(instruction, /plan-content/);
    assert.equal(runtimeCliInput.task, 'structural pipeline task');
    assert.equal(runtimeCliInput.approvedExecution, null);
  });

  it('does not adopt a pre-existing approved plan when latestPlanPath is absent', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'generic pipeline task',
      artifacts: {
        ralplan: {
          task: 'generic pipeline task',
          stage: 'ralplan',
          prdPaths: [join(plansDir, 'prd-zeta.md')],
          testSpecPaths: [join(plansDir, 'test-spec-zeta.md')],
          planningComplete: true,
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
    assert.equal(descriptor.task, 'generic pipeline task');
    assert.equal(descriptor.approvedExecution, null);
    assert.match(instruction, /generic pipeline task/);
    assert.doesNotMatch(instruction, /Execute zeta handoff/);
    assert.equal(runtimeCliInput.task, 'generic pipeline task');
    assert.equal(runtimeCliInput.approvedExecution, null);
  });

  it('fails closed when latestPlanPath has no team launch hint', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-no-team-hint.md');
    await writeFile(prdPath, '# PRD\n\nNo team launch hint here.\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_missing:/);
  });

  it('fails closed when latestPlanPath has ambiguous team launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-ambiguous-team-hint.md');
    await writeFile(
      prdPath,
      [
        '# PRD',
        '',
        'Launch via omx team 2:executor "Execute first handoff"',
        'Launch via omx team 2:executor "Execute second handoff"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-ambiguous-team-hint.md'), '# Test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_ambiguous:/);
  });

  it('falls back to raw task when no ralplan artifacts exist', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({ task: 'raw task description' }));

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'raw task description');
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  describe('buildTeamInstruction', () => {
    it('builds correct runtime-cli instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('team', 'implement feature', ['executor', 'test-engineer'], {
        workerCount: 3,
      });
      const instruction = buildTeamInstruction({
        task: 'implement feature',
        workerCount: 3,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp/test',
        approvedExecution: null,
      });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);

      assert.match(instruction, /runtime-cli\.js/);
      assert.match(instruction, /--input-json-base64/);
      assert.match(
        instruction,
        new RegExp(escapeRegExp(join(packageRoot(), 'dist', 'team', 'runtime-cli.js'))),
      );
      assert.doesNotMatch(
        instruction,
        new RegExp(escapeRegExp(join('/tmp/test', 'dist', 'team', 'runtime-cli.js'))),
      );
      assert.equal(runtimeCliInput.teamName, 'implement-feature');
      assert.equal(runtimeCliInput.workerCount, 3);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.equal('agentTypes' in runtimeCliInput, false);
      assert.equal(runtimeCliInput.cwd, '/tmp/test');
      assert.ok(Array.isArray(runtimeCliInput.tasks));
      assert.equal((runtimeCliInput.tasks as unknown[]).length > 0, true);
      assert.equal(runtimeCliInput.task, 'implement feature');
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal('useWorktrees' in runtimeCliInput, false);
      assert.equal(
        (runtimeCliInput.decompositionMetadata as Record<string, unknown>).decomposition_source,
        'legacy_text',
      );
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'a'.repeat(1000);
      const staffingPlan = buildFollowupStaffingPlan('team', longTask, ['executor', 'test-engineer'], {
        workerCount: 1,
      });
      const instruction = buildTeamInstruction({
        task: longTask,
        workerCount: 1,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp',
        approvedExecution: null,
      });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);

      assert.match(instruction, /runtime-cli\.js/);
      assert.match(instruction, /--input-json-base64/);
      assert.equal(runtimeCliInput.task, longTask);
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal(runtimeCliInput.workerCount, 1);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.match(instruction, /staffing=/);
    });

    it('keeps Windows instructions free of POSIX launch comments', () => {
      const task = `fix "quoted" paths, keep it's 100% safe & support café 运行时`;
      const staffingPlan = buildFollowupStaffingPlan('team', task, ['executor', 'test-engineer'], {
        workerCount: 1,
      });
      const instruction = buildTeamInstruction({
        task,
        workerCount: 1,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: 'C:\\repo with spaces',
        approvedExecution: null,
      }, { platform: 'win32' });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      const commandPrefix = instruction.split('--input-json-base64')[0] ?? '';
      const encodedPayload = instruction.match(/--input-json-base64\s+([A-Za-z0-9_-]+)/)?.[1] ?? '';

      assert.match(instruction, /^"[^"]+"\s+"[^"]*runtime-cli\.js"\s+--input-json-base64\s+[A-Za-z0-9_-]+/);
      assert.equal(commandPrefix.includes("'"), false);
      assert.doesNotMatch(encodedPayload, /[%&|<>"'\s]/);
      assert.doesNotMatch(instruction, /# staffing=/);
      assert.doesNotMatch(instruction, /# verify=/);
      assert.equal(runtimeCliInput.task, task);
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal(runtimeCliInput.workerCount, 1);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.equal('agentTypes' in runtimeCliInput, false);
      assert.equal(runtimeCliInput.cwd, 'C:\\repo with spaces');
    });

    it('preserves approved DAG handoff tasks and metadata in the runtime-cli payload', async () => {
      const plansDir = join(tempDir, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-demo.md'),
        '# Demo\n\nLaunch via omx team 2:executor "Execute approved demo plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-demo.md'), '# Demo Test Spec\n');
      await writeFile(join(plansDir, 'team-dag-demo.json'), JSON.stringify({
        schema_version: 1,
        nodes: [
          {
            id: 'impl',
            lane: 'implementation',
            role: 'executor',
            subject: 'Implement runtime',
            description: 'Change runtime',
            filePaths: ['src/team/runtime.ts'],
            requires_code_change: true,
          },
          {
            id: 'verify',
            lane: 'verification',
            role: 'test-engineer',
            subject: 'Verify runtime',
            description: 'Cover runtime',
            depends_on: ['impl'],
          },
        ],
        worker_policy: { requested_count: 2, count_source: 'cli-explicit' },
      }));
      const staffingPlan = buildFollowupStaffingPlan('team', 'Execute approved demo plan', ['executor', 'test-engineer'], {
        workerCount: 2,
      });
      const instruction = buildTeamInstruction({
        task: 'Execute approved demo plan',
        workerCount: 2,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: tempDir,
        approvedExecution: null,
      });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      const tasks = runtimeCliInput.tasks as Array<Record<string, unknown>>;
      const decompositionMetadata = runtimeCliInput.decompositionMetadata as Record<string, unknown>;

      assert.equal(runtimeCliInput.teamName, 'execute-approved-demo-plan');
      assert.equal(runtimeCliInput.task, 'Execute approved demo plan');
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal(runtimeCliInput.workerCount, 2);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0]?.symbolic_id, 'impl');
      assert.deepEqual(tasks[1]?.symbolic_depends_on, ['impl']);
      assert.deepEqual(tasks[0]?.filePaths, ['src/team/runtime.ts']);
      assert.equal(tasks[0]?.lane, 'implementation');
      assert.equal(decompositionMetadata.decomposition_source, 'dag_sidecar');
      assert.deepEqual(decompositionMetadata.node_dependencies, {
        impl: [],
        verify: ['impl'],
      });
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
    assert.ok(Array.isArray(descriptor.availableAgentTypes));
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  it('preserves legacy verification context precedence over ralplan artifacts', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx({
      artifacts: {
        ralplan: { plan: 'approved plan' },
        'team-exec': { teamDescriptor: { task: 'completed work' } },
      },
    }));

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { teamDescriptor: { task: 'completed work' } });
  });

  describe('buildRalphInstruction', () => {
    it('includes max iterations in instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('ralph', 'verify feature', ['architect', 'executor', 'test-engineer']);
      const instruction = buildRalphInstruction({
        task: 'verify feature',
        maxIterations: 15,
        cwd: '/tmp',
        availableAgentTypes: ['architect', 'executor', 'test-engineer'],
        staffingPlan,
        executionArtifacts: {},
      });

      assert.match(instruction, /max_iterations=15/);
      assert.match(instruction, /^omx ralph /);
      assert.match(instruction, /verify feature/);
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'b'.repeat(500);
      const staffingPlan = buildFollowupStaffingPlan('ralph', longTask, ['architect', 'executor', 'test-engineer']);
      const instruction = buildRalphInstruction({
        task: longTask,
        maxIterations: 10,
        cwd: '/tmp',
        availableAgentTypes: ['architect', 'executor', 'test-engineer'],
        staffingPlan,
        executionArtifacts: {},
      });

      assert.match(instruction, /^omx ralph /);
      assert.match(instruction, /staffing=/);
    });
  });
});


// ---------------------------------------------------------------------------
// Strict Autopilot stage tests
// ---------------------------------------------------------------------------

describe('Strict Autopilot Ralph Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('uses the strict phase name ralph', () => {
    assert.equal(createRalphStage().name, 'ralph');
  });

  it('uses ralplan artifacts as the primary strict ralph execution input', async () => {
    const result = await createRalphStage().run(makeCtx({
      artifacts: {
        ralplan: { plan: 'approved plan' },
        'team-exec': { teamDescriptor: { task: 'legacy work' } },
      },
    }));

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { plan: 'approved plan' });
  });
});

describe('Code Review Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a strict code-review stage that fails closed without review evidence', async () => {
    const stage = createCodeReviewStage();
    assert.equal(stage.name, 'code-review');
    const result = await stage.run(makeCtx({ artifacts: { ralph: { tests: 'passed' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(result.status, 'completed');
    assert.equal(verdict.clean, false);
    assert.equal(verdict.recommendation, 'REQUEST CHANGES');
    assert.equal(verdict.architectural_status, 'BLOCK');
    assert.equal(artifacts.return_to_ralplan_reason, 'Code-review evidence missing; fail closed and return to ralplan.');
  });

  it('marks explicit approve and clear review evidence as clean', async () => {
    const stage = createCodeReviewStage({ recommendation: 'APPROVE', architecturalStatus: 'CLEAR' });
    const result = await stage.run(makeCtx({ artifacts: { ralph: { tests: 'passed' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(verdict.clean, true);
    assert.equal(verdict.recommendation, 'APPROVE');
    assert.equal(verdict.architectural_status, 'CLEAR');
    assert.equal(artifacts.return_to_ralplan_reason, null);
  });

  it('marks non-clean review as return-to-ralplan input', async () => {
    const stage = createCodeReviewStage({ recommendation: 'REQUEST CHANGES', architecturalStatus: 'BLOCK', summary: 'fix review findings' });
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(verdict.clean, false);
    assert.equal(artifacts.return_to_ralplan_reason, 'fix review findings');
  });

  it('builds a code-review instruction', () => {
    assert.match(buildCodeReviewInstruction('review me'), /^\$code-review /);
  });
});
