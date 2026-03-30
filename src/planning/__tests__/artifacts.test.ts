import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlanningComplete, readApprovedExecutionLaunchHint, readPlanningArtifacts } from '../artifacts.js';

let tempDir: string;

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-planning-artifacts-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('planning artifacts', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('requires both PRD and test spec for planning completion', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-issue-827.md'), '# PRD\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);
    assert.equal(artifacts.prdPaths.length, 1);
    assert.equal(artifacts.testSpecPaths.length, 0);
  });



  it('includes approved Ralph launch context with test and deep-interview artifacts', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1072.md'),
      '# PRD\n\nLaunch via omx ralph "Execute approved issue 1072 plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-1072.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-1072.md'), '# Deep Interview Spec\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute approved issue 1072 plan');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-1072.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-1072.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-issue-1072.md')]);
  });

  it('includes approved team launch context with staffing and matching artifacts', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1142.md'),
      '# PRD\n\nLaunch via omx team ralph 4:debugger "Execute approved issue 1142 plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-1142.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-1142.md'), '# Deep Interview Spec\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute approved issue 1142 plan');
    assert.equal(hint?.workerCount, 4);
    assert.equal(hint?.agentType, 'debugger');
    assert.equal(hint?.linkedRalph, true);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-1142.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-1142.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-issue-1142.md')]);
  });

  it('binds approved team handoff context to the selected PRD slug in multi-plan repos', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-alpha.md'), '# Alpha\n\nLaunch via omx team 2:executor "Execute alpha"\n');
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Deep Interview\n');
    await writeFile(join(plansDir, 'prd-zeta.md'), '# Zeta\n\nLaunch via omx team 5 "Execute zeta"\n');
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-zeta.md'), '# Zeta Deep Interview\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute zeta');
    assert.equal(hint?.workerCount, 5);
    assert.equal(hint?.agentType, undefined);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-zeta.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-zeta.md')]);
  });



  it('binds approved handoff context to the selected PRD slug in multi-plan repos', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-alpha.md'), '# Alpha\n\nLaunch via omx ralph "Execute alpha"\n');
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Deep Interview\n');
    await writeFile(join(plansDir, 'prd-zeta.md'), '# Zeta\n\nLaunch via omx ralph "Execute zeta"\n');
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-zeta.md'), '# Zeta Deep Interview\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute zeta');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-zeta.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-zeta.md')]);
  });

  it('surfaces deep-interview specs for downstream traceability', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-issue-827.md'), '# PRD\n');
    await writeFile(join(plansDir, 'test-spec-issue-827.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-827.md'), '# Deep Interview Spec\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), true);
    assert.deepEqual(
      artifacts.deepInterviewSpecPaths.map((file) => file.split('/').pop()),
      ['deep-interview-issue-827.md'],
    );
  });
});
