import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readApprovedExecutionLaunchHint,
  readApprovedExecutionLaunchHintOutcome,
  readLatestPlanningArtifacts,
} from '../artifacts.js';
import {
  buildApprovedTeamExecutionBinding,
  buildApprovedTeamHandoffSection,
  buildUltragoalCheckpointGuidance,
} from '../../team/approved-execution.js';
import { buildRalphAppendInstructions } from '../../cli/ralph.js';
import { createTeamExecStage } from '../../pipeline/stages/team-exec.js';
import type { StageContext } from '../../pipeline/types.js';

let tempDir: string;

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-approved-lifecycle-baseline-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeCtx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    task: 'original request task',
    artifacts: {},
    cwd: tempDir,
    ...overrides,
  };
}

async function writePrd(slug: string, withTestSpec: boolean): Promise<{ prdPath: string; testSpecPath: string; teamTask: string; ralphTask: string }> {
  const plansDir = join(tempDir, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  const prdPath = join(plansDir, `prd-${slug}.md`);
  const testSpecPath = join(plansDir, `test-spec-${slug}.md`);
  const teamTask = `Execute ${slug} with team`;
  const ralphTask = `Execute ${slug} with ralph`;
  await writeFile(
    prdPath,
    [
      `# ${slug}`,
      '',
      `Launch via omx team 2:executor "${teamTask}"`,
      `Launch via omx ralph "${ralphTask}"`,
    ].join('\n'),
  );
  if (withTestSpec) {
    await writeFile(testSpecPath, `# ${slug} test spec\n`);
  }
  return { prdPath, testSpecPath, teamTask, ralphTask };
}

describe('approved execution lifecycle baseline matrix', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('keeps approved execution absent when the PRD has no matching test-spec baseline', async () => {
    const fixture = await writePrd('missing-baseline', false);

    const selection = readLatestPlanningArtifacts(tempDir);
    assert.equal(selection.prdPath, fixture.prdPath);
    assert.deepEqual(selection.testSpecPaths, []);

    assert.equal(readApprovedExecutionLaunchHintOutcome(tempDir, 'team').status, 'absent');
    assert.equal(readApprovedExecutionLaunchHintOutcome(tempDir, 'ralph').status, 'absent');
    assert.equal(readApprovedExecutionLaunchHint(tempDir, 'team'), null);
    assert.equal(readApprovedExecutionLaunchHint(tempDir, 'ralph'), null);

    const result = await createTeamExecStage().run(makeCtx({ artifacts: { ralplan: { latestPlanPath: fixture.prdPath } } }));
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_missing/);
  });

  it('reuses approved execution only with an explicit PRD and matching test-spec baseline', async () => {
    const fixture = await writePrd('ready-baseline', true);

    const teamOutcome = readApprovedExecutionLaunchHintOutcome(tempDir, 'team');
    assert.equal(teamOutcome.status, 'resolved');
    if (teamOutcome.status !== 'resolved') throw new Error('expected ready team hint');
    assert.equal(teamOutcome.hint.sourcePath, fixture.prdPath);
    assert.deepEqual(teamOutcome.hint.testSpecPaths, [fixture.testSpecPath]);
    assert.equal(teamOutcome.hint.task, fixture.teamTask);
    assert.deepEqual(buildApprovedTeamExecutionBinding(teamOutcome.hint), {
      prd_path: fixture.prdPath,
      task: fixture.teamTask,
      command: `omx team 2:executor "${fixture.teamTask}"`,
    });
    assert.match(buildApprovedTeamHandoffSection(teamOutcome.hint) ?? '', /approved plan/i);
    assert.match(buildApprovedTeamHandoffSection(teamOutcome.hint) ?? '', /matching test specs|Test specs/);

    const ralphOutcome = readApprovedExecutionLaunchHintOutcome(tempDir, 'ralph');
    assert.equal(ralphOutcome.status, 'resolved');
    if (ralphOutcome.status !== 'resolved') throw new Error('expected ready ralph hint');
    const instructions = buildRalphAppendInstructions(fixture.ralphTask, {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: ralphOutcome.hint,
    });
    assert.match(instructions, /Approved execution baseline is ready/);
    assert.doesNotMatch(instructions, /context pack/i);

    const result = await createTeamExecStage().run(makeCtx({ artifacts: { ralplan: { latestPlanPath: fixture.prdPath } } }));
    assert.equal(result.status, 'completed');
    const artifacts = result.artifacts as Record<string, unknown>;
    const descriptor = artifacts.teamDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.approvedExecution, {
      prd_path: fixture.prdPath,
      task: fixture.teamTask,
      command: `omx team 2:executor "${fixture.teamTask}"`,
    });
  });

  it('adds leader-owned Ultragoal checkpoint context to approved Team handoffs without breaking launch hint selection', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-ultragoal-team.md');
    const testSpecPath = join(plansDir, 'test-spec-ultragoal-team.md');
    const teamTask = 'Use Team + Ultragoal together for G001-team-runtime-bridge';
    await writeFile(
      prdPath,
      [
        '# Ultragoal Team bridge',
        '',
        'Active ultragoal story: G001-team-runtime-bridge in .omx/ultragoal/goals.json.',
        'Team returns evidence for .omx/ultragoal/ledger.jsonl; the leader checkpoints with a fresh get_goal snapshot.',
        '',
        `Launch via omx team 3:executor "${teamTask}"`,
        'Use Ralph only for a later sequential single-owner verification/fix loop.',
      ].join('\n'),
    );
    await writeFile(testSpecPath, '# Ultragoal Team bridge test spec\n');

    const teamOutcome = readApprovedExecutionLaunchHintOutcome(tempDir, 'team', {
      prdPath,
      task: teamTask,
    });
    assert.equal(teamOutcome.status, 'resolved');
    if (teamOutcome.status !== 'resolved') throw new Error('expected ultragoal team hint');

    const guidance = buildUltragoalCheckpointGuidance(teamOutcome.hint);
    assert.equal(guidance?.goal_id, 'G001-team-runtime-bridge');
    assert.equal(guidance?.checkpoint_policy, 'fresh_leader_get_goal_required');
    assert.match(guidance?.checkpoint_command_template ?? '', /verified \.omx\/ultragoal\/goals\.json context/);

    const section = buildApprovedTeamHandoffSection(teamOutcome.hint) ?? '';
    assert.match(section, /Approved-plan Ultragoal hint/);
    assert.match(section, /\.omx\/ultragoal\/goals\.json/);
    assert.match(section, /\.omx\/ultragoal\/ledger\.jsonl/);
    assert.match(section, /Team workers provide task\/evidence updates only/i);
    assert.match(section, /No checkpoint command is emitted from approved-plan hints/i);
    assert.doesNotMatch(section, /omx ultragoal checkpoint --goal-id/i);
    assert.doesNotMatch(section, /auto[- ]launch.*team/i);

    const ralphOutcome = readApprovedExecutionLaunchHintOutcome(tempDir, 'ralph', {
      prdPath,
    });
    assert.equal(ralphOutcome.status, 'absent');
  });

  it('keeps same-task team selector outcomes fail-closed when launch hints are ambiguous', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-ambiguous-team.md');
    const sharedTask = 'Execute ambiguous team handoff';
    await writeFile(
      prdPath,
      [
        '# ambiguous team',
        '',
        `Launch via omx team 2:executor "${sharedTask}"`,
        `Launch via omx team 5:debugger "${sharedTask}"`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-ambiguous-team.md'), '# ambiguous team test spec\n');

    const outcome = readApprovedExecutionLaunchHintOutcome(tempDir, 'team', {
      prdPath,
      task: sharedTask,
    });
    assert.equal(outcome.status, 'ambiguous');
  });
});
