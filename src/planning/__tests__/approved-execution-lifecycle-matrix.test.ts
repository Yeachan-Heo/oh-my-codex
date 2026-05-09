import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  readApprovedExecutionLaunchHintOutcome,
  readLatestPlanningArtifacts,
} from '../artifacts.js';
import {
  buildApprovedTeamExecutionBinding,
  buildApprovedTeamHandoffSection,
} from '../../team/approved-execution.js';
import { buildRalphAppendInstructions } from '../../cli/ralph.js';
import { createTeamExecStage } from '../../pipeline/stages/team-exec.js';
import type { StageContext } from '../../pipeline/types.js';

type LifecycleStatus =
  | 'missing-baseline'
  | 'plan-only'
  | 'incomplete'
  | 'invalid'
  | 'ready';

type ContextPackRole = 'scope' | 'build' | 'verify';

interface LifecycleFixture {
  status: LifecycleStatus;
  prdPath: string;
  testSpecPath: string | null;
  packPath: string | null;
  teamTask: string;
  teamCommand: string;
  ralphTask: string;
  ralphCommand: string;
}

const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  'missing-baseline',
  'plan-only',
  'incomplete',
  'invalid',
  'ready',
];

const READY_ROLE_REFS = {
  scope: ['src/scope.ts'],
  build: ['src/build.ts'],
  verify: ['src/verify.ts'],
};

let tempDir: string;

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function relativeToRepo(path: string): string {
  return relative(tempDir, path).replaceAll('\\', '/');
}

function canonicalContextPackRelativePath(slug: string): string {
  return `.omx/context/context-20260507T120000Z-${slug}.json`;
}

function buildContextPackOutcome(relativePackPath: string): string {
  return [
    '## Context Pack Outcome',
    '',
    `- pack: created \`${relativePackPath}\``,
  ].join('\n');
}

function decodeRuntimeCliInstructionPayload(instruction: string): Record<string, unknown> {
  const match = instruction.match(/--input-json-base64\s+([A-Za-z0-9_-]+)/);
  assert.ok(match?.[1], 'expected --input-json-base64 payload');
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
}

function expectedMissingRoles(status: LifecycleStatus): string[] {
  return status === 'incomplete' ? ['build', 'verify'] : [];
}

function expectedContextPack(status: LifecycleStatus, packPath: string | null): { path: string } | null {
  if (status === 'incomplete' || status === 'invalid' || status === 'ready') {
    assert.ok(packPath, `expected pack path for ${status}`);
    return { path: packPath };
  }
  return null;
}

function assertResolvedOutcome(
  outcome: ReturnType<typeof readApprovedExecutionLaunchHintOutcome>,
  mode: 'team' | 'ralph',
) {
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') {
    throw new Error(`expected resolved ${mode} approved-execution outcome`);
  }
  return outcome.hint;
}

function makeCtx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    task: 'original request task',
    artifacts: {},
    cwd: tempDir,
    ...overrides,
  };
}

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-approved-lifecycle-matrix-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeContextPack(
  slug: string,
  prdPath: string,
  testSpecPath: string,
  roles: readonly ContextPackRole[],
): Promise<string> {
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(contextDir, { recursive: true });

  const packPath = join(tempDir, canonicalContextPackRelativePath(slug));
  const prdContent = await readFile(prdPath, 'utf-8');
  const testSpecContent = await readFile(testSpecPath, 'utf-8');
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relativeToRepo(prdPath),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relativeToRepo(testSpecPath),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries: roles.map((role) => ({
      path: `src/${role}.ts`,
      roles: [role],
    })),
  }, null, 2));
  return packPath;
}

async function writeLifecycleFixture(status: LifecycleStatus): Promise<LifecycleFixture> {
  const plansDir = join(tempDir, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });

  const prdPath = join(plansDir, `prd-${status}.md`);
  const testSpecPath = status === 'missing-baseline'
    ? null
    : join(plansDir, `test-spec-${status}.md`);
  const teamTask = `Execute ${status} team handoff`;
  const teamCommand = `omx team 2:executor "${teamTask}"`;
  const ralphTask = status === 'ready' || status === 'plan-only'
    ? `Execute ${status} ralph handoff`
    : `Repair ${status} ralph handoff`;
  const ralphCommand = `omx ralph "${ralphTask}"`;

  const prdLines = [
    `# ${status}`,
    '',
  ];
  if (status === 'incomplete' || status === 'invalid' || status === 'ready') {
    prdLines.push(buildContextPackOutcome(canonicalContextPackRelativePath(status)), '');
  }
  prdLines.push(teamCommand, ralphCommand);
  await writeFile(prdPath, prdLines.join('\n'));

  if (testSpecPath) {
    await writeFile(testSpecPath, `# ${status} test spec\n`);
  }

  let packPath: string | null = null;
  if (status === 'incomplete') {
    if (!testSpecPath) {
      throw new Error('expected incomplete lifecycle fixture to include a test spec');
    }
    packPath = await writeContextPack(status, prdPath, testSpecPath, ['scope']);
  }
  if (status === 'invalid') {
    if (!testSpecPath) {
      throw new Error('expected invalid lifecycle fixture to include a test spec');
    }
    packPath = await writeContextPack(status, prdPath, testSpecPath, ['scope', 'build', 'verify']);
    await writeFile(testSpecPath, '# invalid drifted test spec\n');
  }
  if (status === 'ready') {
    if (!testSpecPath) {
      throw new Error('expected ready lifecycle fixture to include a test spec');
    }
    packPath = await writeContextPack(status, prdPath, testSpecPath, ['scope', 'build', 'verify']);
  }

  return {
    status,
    prdPath,
    testSpecPath,
    packPath,
    teamTask,
    teamCommand,
    ralphTask,
    ralphCommand,
  };
}

async function runTeamExecForPlan(prdPath: string) {
  const previousCwd = process.cwd();
  try {
    process.chdir(tmpdir());
    return await createTeamExecStage().run(makeCtx({
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: relativeToRepo(prdPath),
        },
      },
    }));
  } finally {
    process.chdir(previousCwd);
  }
}

function assertRalphGuidance(status: LifecycleStatus, instructions: string): void {
  switch (status) {
    case 'missing-baseline':
      assert.match(instructions, /Missing-baseline fallback/i);
      assert.match(instructions, /restore the missing baseline before broadening context/i);
      assert.doesNotMatch(instructions, /build refs \(read first\)/i);
      return;
    case 'plan-only':
      assert.match(instructions, /Plan-only fallback/i);
      assert.match(instructions, /pre-context-pack plan-only handoff baseline/i);
      assert.doesNotMatch(instructions, /build refs \(read first\)/i);
      return;
    case 'incomplete':
      assert.match(instructions, /missing required context roles: build, verify/i);
      assert.match(instructions, /Incomplete-pack fallback:/i);
      assert.match(instructions, /repair or recreate the canonical context pack with required role coverage/i);
      assert.doesNotMatch(instructions, /build refs \(read first\)/i);
      return;
    case 'invalid':
      assert.match(instructions, /invalid context pack issues:/i);
      assert.match(instructions, /repair or recreate the canonical context pack/i);
      assert.doesNotMatch(instructions, /build refs \(read first\)/i);
      return;
    case 'ready':
      assert.match(instructions, /approved context pack: .*context-20260507T120000Z-ready\.json/i);
      assert.match(instructions, /build refs \(read first\): src\/build\.ts/i);
      assert.match(instructions, /Read the build refs above before broader repo exploration/i);
      assert.doesNotMatch(instructions, /Missing-baseline fallback/i);
      assert.doesNotMatch(instructions, /repair or recreate the canonical context pack/i);
      return;
    default:
      throw new Error(`unexpected lifecycle status ${status}`);
  }
}

function assertTeamExecOutcome(
  fixture: LifecycleFixture,
  result: Awaited<ReturnType<ReturnType<typeof createTeamExecStage>['run']>>,
): void {
  const expectedBinding = {
    prd_path: fixture.prdPath,
    task: fixture.teamTask,
    command: fixture.teamCommand,
  };

  if (fixture.status === 'ready') {
    assert.equal(result.status, 'completed');
    const artifacts = result.artifacts as Record<string, unknown>;
    const descriptor = artifacts.teamDescriptor as Record<string, unknown>;
    const instruction = artifacts.instruction as string;
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);

    assert.equal(descriptor.task, fixture.teamTask);
    assert.deepEqual(descriptor.approvedExecution, expectedBinding);
    assert.equal(runtimeCliInput.task, fixture.teamTask);
    assert.deepEqual(runtimeCliInput.approvedExecution, expectedBinding);
    return;
  }

  if (fixture.status === 'plan-only') {
    assert.equal(result.status, 'completed');
    const artifacts = result.artifacts as Record<string, unknown>;
    const descriptor = artifacts.teamDescriptor as Record<string, unknown>;
    const instruction = artifacts.instruction as string;
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);

    assert.equal(descriptor.task, fixture.teamTask);
    assert.equal(descriptor.approvedExecution, null);
    assert.equal(runtimeCliInput.task, fixture.teamTask);
    assert.equal(runtimeCliInput.approvedExecution, null);
    return;
  }

  assert.equal(result.status, 'failed');
  assert.match(
    result.error ?? '',
    new RegExp(`team_exec_approved_handoff_nonready:${fixture.status}:.*prd-${fixture.status}\\.md`),
  );
  assert.deepEqual(result.artifacts, {});
}

describe('approved execution lifecycle matrix', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  for (const status of LIFECYCLE_STATUSES) {
    it(`proves ${status} behavior across planning, Ralph, Team, and pipeline boundaries`, async () => {
      const fixture = await writeLifecycleFixture(status);
      const selection = readLatestPlanningArtifacts(tempDir);
      assert.equal(selection.prdPath, fixture.prdPath);
      assert.equal(selection.contextPackStatus, status);
      assert.deepEqual(selection.contextPack, expectedContextPack(status, fixture.packPath));
      assert.deepEqual(selection.contextPackRoleRefs, status === 'ready' ? READY_ROLE_REFS : null);
      assert.deepEqual(selection.missingRequiredContextPackRoles, expectedMissingRoles(status));

      const teamHint = assertResolvedOutcome(
        readApprovedExecutionLaunchHintOutcome(tempDir, 'team'),
        'team',
      );
      assert.equal(teamHint.sourcePath, fixture.prdPath);
      assert.equal(teamHint.task, fixture.teamTask);
      assert.equal(teamHint.command, fixture.teamCommand);
      assert.equal(teamHint.contextPackStatus, status);
      assert.deepEqual(teamHint.contextPack, expectedContextPack(status, fixture.packPath));
      assert.deepEqual(teamHint.contextPackRoleRefs, status === 'ready' ? READY_ROLE_REFS : null);
      assert.deepEqual(teamHint.missingRequiredContextPackRoles, expectedMissingRoles(status));

      const ralphHint = assertResolvedOutcome(
        readApprovedExecutionLaunchHintOutcome(tempDir, 'ralph'),
        'ralph',
      );
      assert.equal(ralphHint.sourcePath, fixture.prdPath);
      assert.equal(ralphHint.task, fixture.ralphTask);
      assert.equal(ralphHint.command, fixture.ralphCommand);
      assert.equal(ralphHint.contextPackStatus, status);
      assert.deepEqual(ralphHint.contextPack, expectedContextPack(status, fixture.packPath));
      assert.deepEqual(ralphHint.contextPackRoleRefs, status === 'ready' ? READY_ROLE_REFS : null);
      assert.deepEqual(ralphHint.missingRequiredContextPackRoles, expectedMissingRoles(status));

      if (status === 'ready') {
        assert.deepEqual(buildApprovedTeamExecutionBinding(teamHint), {
          prd_path: fixture.prdPath,
          task: fixture.teamTask,
          command: fixture.teamCommand,
        });
        assert.match(
          buildApprovedTeamHandoffSection(teamHint) ?? '',
          /Build refs \(read first\): src\/build\.ts/,
        );
      } else {
        assert.equal(buildApprovedTeamHandoffSection(teamHint), undefined);
      }

      const instructions = buildRalphAppendInstructions(fixture.ralphTask, {
        changedFilesPath: '.omx/ralph/changed-files.txt',
        noDeslop: false,
        approvedHint: ralphHint,
      });
      assertRalphGuidance(status, instructions);

      const result = await runTeamExecForPlan(fixture.prdPath);
      assertTeamExecOutcome(fixture, result);
    });
  }

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
