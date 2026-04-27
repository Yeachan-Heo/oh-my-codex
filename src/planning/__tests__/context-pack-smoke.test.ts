import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTeamStartArgs } from '../../cli/team.js';
import { resolveApprovedRalphExecutionHint } from '../../cli/ralph.js';
import { createTeamExecStage } from '../../pipeline/stages/team-exec.js';
import type { StageContext } from '../../pipeline/types.js';
import { readApprovedExecutionLaunchHint } from '../artifacts.js';
import { contextPackIndexPath, writeContextPackDocument } from '../context-packs.js';

const APPROVED_TASK = 'Execute approved issue 950 plan';
const RELATIVE_PACK_PATH = '.omx/context/context-20260420T000000Z-issue-950.json';
const PLANNER_PROMPT_PATH = fileURLToPath(new URL('../../../prompts/planner.md', import.meta.url));

interface ApprovedWorkspaceFixture {
  cwd: string;
  packPath: string;
  prdPath: string;
}

async function createApprovedWorkspace(): Promise<ApprovedWorkspaceFixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-context-pack-smoke-'));
  const packPath = join(cwd, RELATIVE_PACK_PATH);
  const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-950.md');

  await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await writeFile(
    join(cwd, 'docs', 'runtime.md'),
    [
      '# Runtime',
      '',
      '## Runtime Contract',
      '',
      Array.from({ length: 120 }, () => 'Runtime detail stays compact when excerpted.').join(' '),
      '',
    ].join('\n'),
  );
  await writeFile(join(cwd, 'docs', 'boundary.md'), '# Boundary\n\nStay within the approved boundary.\n');
  await writeFile(join(cwd, 'docs', 'acceptance.md'), '# Acceptance\n\nProof requirements live here.\n');
  await writeFile(
    prdPath,
    [
      '# Approved issue 950',
      '',
      '## Context Pack Outcome',
      `- pack: created \`${RELATIVE_PACK_PATH}\``,
      '',
      `Launch via omx team 2:executor "${APPROVED_TASK}"`,
      `Launch via omx ralph "${APPROVED_TASK}"`,
    ].join('\n'),
  );
  await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-950.md'), '# Test spec\n');

  writeContextPackDocument(
    packPath,
    {
      schema: 'omx-context-pack-v1',
      slug: 'issue-950',
      entries: [
        {
          label: 'runtime-contract',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: ['runtime'],
          selector: { type: 'heading', value: '## Runtime Contract', maxWords: 120 },
          relationPath: [
            { tag: 'plan', target: 'issue-950' },
            { tag: 'implements', target: 'docs/runtime.md#runtime-contract' },
          ],
        },
        {
          label: 'boundary',
          path: 'docs/boundary.md',
          roles: ['scope'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-950' },
            { tag: 'bounds', target: 'docs/boundary.md' },
          ],
        },
        {
          label: 'acceptance',
          path: 'docs/acceptance.md',
          roles: ['verify'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-950' },
            { tag: 'verifies', target: 'docs/acceptance.md' },
          ],
        },
      ],
    },
    { refreshBasis: true },
  );

  return { cwd, packPath, prdPath };
}

describe('context-pack smoke', () => {
  it('keeps the ready handoff authority chain aligned across Ralph, Team, and team-exec', async () => {
    const fixture = await createApprovedWorkspace();
    const previousCwd = process.cwd();
    try {
      const approvedHint = readApprovedExecutionLaunchHint(fixture.cwd, 'ralph', {
        task: APPROVED_TASK,
        materializeContextRefs: true,
      });
      assert.ok(approvedHint);
      assert.equal(approvedHint.contextPackStatus, 'ready');
      assert.equal(approvedHint.task, APPROVED_TASK);
      assert.equal(approvedHint.sourcePath, fixture.prdPath);
      assert.equal(approvedHint.contextPack?.path, fixture.packPath);
      assert.deepEqual(approvedHint.missingRequiredContextPackRoles, []);
      assert.deepEqual(approvedHint.contextRefIssues, []);
      assert.equal(approvedHint.contextRefs.length, 3);
      assert.ok(approvedHint.contextRefs.some((ref) => ref.delivery === 'excerpt' && ref.path !== ref.sourcePath));
      assert.ok(approvedHint.contextRefs.some((ref) => ref.delivery === 'file' && ref.path === ref.sourcePath));
      for (const ref of approvedHint.contextRefs) {
        assert.ok(existsSync(ref.path), `expected delivery path to exist: ${ref.path}`);
        assert.ok(existsSync(ref.sourcePath), `expected source path to exist: ${ref.sourcePath}`);
      }

      const bareRalphFollowup = resolveApprovedRalphExecutionHint(approvedHint, 'ralph-cli-launch');
      assert.equal(bareRalphFollowup?.task, APPROVED_TASK);

      process.chdir(fixture.cwd);
      const parsedTeamArgs = parseTeamStartArgs(['team']).parsed;
      assert.equal(parsedTeamArgs.task, APPROVED_TASK);
      assert.equal(parsedTeamArgs.workerCount, 2);
      assert.equal(parsedTeamArgs.agentType, 'executor');

      const stage = createTeamExecStage();
      const planningArtifacts = {
        task: APPROVED_TASK,
        sourcePath: fixture.prdPath,
        contextPack: fixture.packPath,
        planBlob: 'plan-content',
      };
      const stageContext: StageContext = {
        task: APPROVED_TASK,
        cwd: fixture.cwd,
        artifacts: { ralplan: planningArtifacts },
      };
      const stageResult = await stage.run(stageContext);
      assert.equal(stageResult.status, 'completed');
      const stageArtifacts = stageResult.artifacts as Record<string, unknown>;
      const descriptor = stageArtifacts.teamDescriptor as Record<string, unknown>;
      assert.equal(descriptor.task, APPROVED_TASK);
      assert.deepEqual(descriptor.planningArtifacts, planningArtifacts);
      assert.doesNotMatch(String(stageArtifacts.instruction), /plan-content/);
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('treats missing generated indexes as incomplete instead of auto-reusable follow-ups', async () => {
    const fixture = await createApprovedWorkspace();
    const previousCwd = process.cwd();
    try {
      await unlink(contextPackIndexPath(fixture.packPath));

      const approvedHint = readApprovedExecutionLaunchHint(fixture.cwd, 'ralph', { task: APPROVED_TASK });
      assert.ok(approvedHint);
      assert.equal(approvedHint.contextPackStatus, 'incomplete');
      assert.match(approvedHint.contextPackIssues.join(' | '), /index/i);
      assert.equal(resolveApprovedRalphExecutionHint(approvedHint, 'ralph-cli-launch'), null);

      process.chdir(fixture.cwd);
      const parsedTeamArgs = parseTeamStartArgs(['team']).parsed;
      assert.equal(parsedTeamArgs.task, 'team');
      assert.notEqual(parsedTeamArgs.task, APPROVED_TASK);
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('documents the minimal v1 authoring contract in the real planner prompt', async () => {
    const prompt = await readFile(PLANNER_PROMPT_PATH, 'utf-8');
    assert.match(prompt, /Context Pack Outcome/);
    assert.match(prompt, /`scope` for boundary\/guardrail refs, `build` for implementation refs, and `verify` for proof refs/i);
    assert.match(prompt, /usually 3-6 total refs/i);
    assert.match(prompt, /query role\/tag views before materializing excerpts/i);
    assert.match(prompt, /pack `sync` once as the final handoff-ready gate/i);
    assert.match(prompt, /tags only for optional topical cross-cuts/i);
    assert.match(prompt, /what concrete question a tagged view helps answer/i);
    assert.match(prompt, /execution authority remains the canonical JSON pack/i);
  });
});
