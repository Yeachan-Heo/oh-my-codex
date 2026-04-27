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
import { buildFollowupStaffingPlan } from '../../team/followup-planner.js';
import { packageRoot } from '../../utils/paths.js';
import {
  REQUIRED_CONTEXT_PACK_ROLES,
  readContextPackDocument,
  writeContextPackDocument,
  type ContextPackRole,
} from '../../planning/context-packs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
const CONTEXT_PACK_SCHEMA = 'omx-context-pack-v1';

function defaultReadFirstRef(
  slug: string,
  role: ContextPackRole,
): { label: string; path: string; relationTag: string } {
  if (role === 'scope') {
    return { label: 'boundary', path: `docs/${slug}-boundary.md`, relationTag: 'bounds' };
  }
  if (role === 'verify') {
    return { label: 'acceptance', path: `docs/${slug}-acceptance.md`, relationTag: 'verifies' };
  }
  return { label: 'implementation', path: `docs/${slug}-implementation.md`, relationTag: 'implements' };
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

async function writeContextPacks(
  slug: string,
  roles: readonly ContextPackRole[] = REQUIRED_CONTEXT_PACK_ROLES,
): Promise<string> {
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(contextDir, { recursive: true });

  for (const role of roles) {
    const readFirstRef = defaultReadFirstRef(slug, role);
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await writeFile(
      join(tempDir, readFirstRef.path),
      `# ${readFirstRef.label}\n\n${role} context for ${slug}.\n`,
    );
  }

  const relativePath = `.omx/context/context-20260420T000000Z-${slug}.json`;
  writeContextPackDocument(join(tempDir, relativePath), {
    schema: CONTEXT_PACK_SCHEMA,
    slug,
    entries: roles.map((role) => {
      const readFirstRef = defaultReadFirstRef(slug, role);
      return {
        label: readFirstRef.label,
        path: readFirstRef.path,
        roles: [role],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: readFirstRef.relationTag, target: readFirstRef.path },
        ],
      };
    }),
  }, { refreshBasis: true });

  return relativePath;
}

function refreshContextPackBasis(relativePath: string): void {
  const absolutePath = join(tempDir, relativePath);
  const document = readContextPackDocument(absolutePath);
  assert.ok(document, `expected context pack at ${absolutePath}`);
  writeContextPackDocument(absolutePath, document, { refreshBasis: true });
}

function buildContextPackOutcome(relativePath: string): string {
  return [
    '## Context Pack Outcome',
    `- pack: created \`${relativePath}\``,
  ].join('\n');
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

  it('canSkip returns true for pre-context-pack PRD/test-spec handoffs without context packs', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-legacy-feature.md'), '# Legacy Plan\n');
    await writeFile(join(plansDir, 'test-spec-legacy-feature.md'), '# Legacy Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), true);
  });

  it('canSkip returns true when prd, test spec, and required context packs exist', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('my-feature');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), `# Plan\n\n${buildContextPackOutcome(contextPacks)}\n`);
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks);

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), true);
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
          const contextPacks = await writeContextPacks('runtime');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-runtime.md');
          await writeFile(prdPath, `# Runtime Plan\n\n${buildContextPackOutcome(contextPacks)}\n`);
          await writeFile(join(plansDir, 'test-spec-runtime.md'), '# Runtime Tests\n');
          refreshContextPackBasis(contextPacks);
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

  it('fails the runtime-backed stage when the approved handoff is not pack-ready', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          const plansDir = join(tempDir, '.omx', 'plans');
          const contextPackPath = await writeContextPacks('runtime-pack-gate');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-runtime-pack-gate.md');
          await writeFile(prdPath, `# Runtime Plan\n\n${buildContextPackOutcome(contextPackPath)}\n`);
          await writeFile(join(plansDir, 'test-spec-runtime-pack-gate.md'), '# Runtime Tests\n');
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

    const result = await stage.run(makeCtx({ task: 'live ralplan run without synced pack basis' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'ralplan_handoff_not_ready');
    assert.equal(artifacts.runtime, true);
    assert.equal(artifacts.planningComplete, false);
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

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 4);
    assert.equal(arts.agentType, 'architect');
  });

  it('derives the plan-only team-exec task from the latest approved PRD and keeps the launch on the generic path', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-approved-exact-task.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        'Launch via omx team 2:executor "approved refined task"',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(plansDir, 'test-spec-approved-exact-task.md'), '# Test spec\n', 'utf-8');

    const stage = createTeamExecStage();
    const ctx = makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          data: 'plan-content',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'approved refined task');
    assert.equal(descriptor.teamName, 'approved-refined-task');
    assert.ok(Array.isArray(descriptor.tasks));
    assert.equal(descriptor.approvedExecution, null);
    assert.deepEqual(descriptor.planningArtifacts, {
      task: 'original request task',
      data: 'plan-content',
      stage: 'ralplan',
      latestPlanPath: prdPath,
    });
    assert.ok(Array.isArray(descriptor.availableAgentTypes));
    assert.ok((descriptor.availableAgentTypes as unknown[]).length > 0);
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
    assert.match((result.artifacts as Record<string, unknown>).instruction as string, /runtime-cli\.js/);
    assert.match((result.artifacts as Record<string, unknown>).instruction as string, /--input-json/);
    assert.match((result.artifacts as Record<string, unknown>).instruction as string, /"approvedExecution":null/);
    assert.match(
      (result.artifacts as Record<string, unknown>).instruction as string,
      new RegExp(escapeRegExp(join(packageRoot(), 'dist', 'team', 'runtime-cli.js'))),
    );
    assert.doesNotMatch(
      (result.artifacts as Record<string, unknown>).instruction as string,
      new RegExp(escapeRegExp(join(tempDir, 'dist', 'team', 'runtime-cli.js'))),
    );
    assert.doesNotMatch((result.artifacts as Record<string, unknown>).instruction as string, /plan-content/);
  });

  it('derives the ready team-exec binding from the approved PRD handoff instead of the original request task', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await writeContextPacks('approved-exact-task-ready');
    const relativePackPath = '.omx/context/context-20260420T000000Z-approved-exact-task-ready.json';
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-approved-exact-task-ready.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        buildContextPackOutcome(relativePackPath),
        '',
        'Launch via omx team 2:executor "approved refined task ready"',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(plansDir, 'test-spec-approved-exact-task-ready.md'), '# Test spec\n', 'utf-8');
    refreshContextPackBasis(relativePackPath);

    const stage = createTeamExecStage();
    const ctx = makeCtx({
      task: 'original request task ready',
      artifacts: {
        ralplan: {
          task: 'original request task ready',
          data: 'plan-content',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'approved refined task ready');
    assert.deepEqual(descriptor.approvedExecution, {
      prd_path: prdPath,
      task: 'approved refined task ready',
      command: 'omx team 2:executor "approved refined task ready"',
    });
    assert.match((result.artifacts as Record<string, unknown>).instruction as string, /approvedExecution/);
  });

  it('keeps structural ralplan artifacts on the generic team-exec path', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'structural pipeline task',
      artifacts: {
        ralplan: {
          task: 'structural pipeline task',
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
    assert.equal(descriptor.task, 'structural pipeline task');
    assert.equal(descriptor.approvedExecution, null);
    assert.match((result.artifacts as Record<string, unknown>).instruction as string, /"approvedExecution":null/);
  });

  it('fails closed when ralplan artifacts do not resolve to a reusable approved handoff', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-approved-missing-baseline.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        'Launch via omx team 2:executor "approved missing baseline task"',
      ].join('\n'),
      'utf-8',
    );

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'approved missing baseline task',
      artifacts: {
        ralplan: {
          task: 'approved missing baseline task',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_not_ready:missing-baseline/);
  });

  it('falls back to raw task when no ralplan artifacts exist', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({ task: 'raw task description' }));

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'raw task description');
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  describe('buildTeamInstruction', () => {
    it('builds correct CLI instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('team', 'implement feature', ['executor', 'test-engineer'], {
        workerCount: 3,
      });
      const instruction = buildTeamInstruction({
        teamName: 'implement-feature',
        task: 'implement feature',
        tasks: [{
          subject: 'implement feature',
          description: 'implement feature',
          owner: 'worker-1',
          role: 'writer',
        }],
        workerCount: 3,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp/test',
        approvedExecution: {
          prd_path: '/tmp/test/.omx/plans/prd-implement-feature.md',
          task: 'implement feature',
          command: 'omx team 3:executor "implement feature"',
        },
      });

      assert.match(instruction, /runtime-cli\.js/);
      assert.match(instruction, /--input-json/);
      assert.match(instruction, /implement feature/);
      assert.match(instruction, /approvedExecution/);
      assert.match(instruction, /"owner":"worker-1"/);
      assert.match(instruction, /"role":"writer"/);
      assert.match(instruction, /"useWorktrees":false/);
      assert.match(instruction, /"agentType":"executor"/);
      assert.equal(instruction.includes(join('/tmp/test', 'dist', 'team', 'runtime-cli.js')), false);
      assert.equal(instruction.includes(join(packageRoot(), 'dist', 'team', 'runtime-cli.js')), true);
      assert.doesNotMatch(instruction, /"agentTypes":\["executor"\]/);
      assert.doesNotMatch(instruction, /printf '%s'/);
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'a'.repeat(1000);
      const staffingPlan = buildFollowupStaffingPlan('team', longTask, ['executor', 'test-engineer'], {
        workerCount: 1,
      });
      const instruction = buildTeamInstruction({
        teamName: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        task: longTask,
        tasks: [{ subject: longTask, description: longTask, owner: 'worker-1' }],
        workerCount: 1,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp',
        approvedExecution: null,
      });

      assert.match(instruction, /runtime-cli\.js/);
      assert.match(instruction, /--input-json/);
      assert.match(instruction, /"approvedExecution":null/);
      assert.doesNotMatch(instruction, /printf '%s'/);
      assert.match(instruction, /staffing=/);
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
