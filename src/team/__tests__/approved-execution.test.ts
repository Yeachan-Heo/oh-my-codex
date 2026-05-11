import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  buildApprovedTeamHandoffSection,
  readPersistedApprovedTeamExecutionBinding,
  readPersistedApprovedTeamExecutionBindingStateSync,
  resolvePersistedApprovedTeamExecutionContinuityState,
  writePersistedApprovedTeamExecutionBinding,
} from '../approved-execution.js';
import { readApprovedExecutionLaunchHint } from '../../planning/artifacts.js';

type TestContextPackEntry = {
  path: string;
  roles: readonly ('scope' | 'build' | 'verify')[];
  label?: unknown;
  tags?: unknown;
  selector?: unknown;
  relationPath?: unknown;
  [key: string]: unknown;
};

async function withUnboxedOmxRoot<T>(fn: () => Promise<T>): Promise<T> {
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  try {
    delete process.env.OMX_ROOT;
    delete process.env.OMX_STATE_ROOT;
    return await fn();
  } finally {
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
  }
}

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
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

async function writeContextPackWithEntries(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
  entries: readonly TestContextPackEntry[],
): Promise<string> {
  const contextDir = join(cwd, '.omx', 'context');
  await mkdir(contextDir, { recursive: true });
  const packPath = join(cwd, canonicalContextPackRelativePath(slug));
  const prdContent = await readFile(prdPath, 'utf-8');
  const testSpecContent = await readFile(testSpecPath, 'utf-8');
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relative(cwd, prdPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relative(cwd, testSpecPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries,
  }, null, 2));
  return packPath;
}

async function createReadyApprovedTeamHint(
  cwd: string,
  slug: string,
  entries: readonly TestContextPackEntry[],
): Promise<{
  hint: NonNullable<ReturnType<typeof readApprovedExecutionLaunchHint>>;
  prdPath: string;
  testSpecPath: string;
  packPath: string;
  repoContextPath: string;
}> {
  const plansDir = join(cwd, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  const prdPath = join(plansDir, `prd-${slug}.md`);
  const testSpecPath = join(plansDir, `test-spec-${slug}.md`);
  const repoContextPath = join(plansDir, `repo-context-${slug}.md`);
  await writeFile(
    prdPath,
    [
      '# Approved plan',
      '',
      buildContextPackOutcome(canonicalContextPackRelativePath(slug)),
      '',
      `Launch via omx team 1:executor "Execute approved ${slug} plan"`,
    ].join('\n'),
  );
  await writeFile(testSpecPath, '# Test spec\n');
  await writeFile(repoContextPath, 'Read the approved repository slice before broader repo exploration.\n');
  const packPath = await writeContextPackWithEntries(cwd, slug, prdPath, testSpecPath, entries);
  const hint = readApprovedExecutionLaunchHint(cwd, 'team');
  assert.ok(hint, 'expected ready Team approved hint');
  return { hint, prdPath, testSpecPath, packPath, repoContextPath };
}

describe('approved execution binding', () => {
  it('buildApprovedTeamHandoffSection renders ready approved Team context with labeled file refs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-handoff-'));
    try {
      const { hint, prdPath, testSpecPath, packPath, repoContextPath } = await createReadyApprovedTeamHint(
        cwd,
        'issue-1314',
        [
          { path: 'docs/scope-entry.md', roles: ['scope'] },
          { path: 'src/build-entry.ts', roles: ['build'], label: 'Build Focus' },
          { path: 'tests/verify-entry.ts', roles: ['verify'] },
        ],
      );

      const handoff = buildApprovedTeamHandoffSection(hint);

      assert.match(handoff ?? '', new RegExp(`Approved plan: ${prdPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(handoff ?? '', new RegExp(`Test specs: ${testSpecPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(handoff ?? '', new RegExp(`Approved context pack: ${packPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(handoff ?? '', new RegExp(`Approved repository context summary source: ${repoContextPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(handoff ?? '', /Read the approved repository slice before broader repo exploration\./);
      assert.match(handoff ?? '', /Build refs \(read first\): build-focus=src\/build-entry\.ts \[file\]/);
      assert.match(handoff ?? '', /Verify refs: verify-entry=tests\/verify-entry\.ts \[file\]/);
      assert.match(handoff ?? '', /Scope refs: scope-entry=docs\/scope-entry\.md \[file\]/);
      assert.match(handoff ?? '', /Read the build refs above before broader repo exploration\./);
      assert.doesNotMatch(handoff ?? '', /query the canonical pack|Context pack index/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('upgrades previous-version ready packs to derived file refs without changing ready status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-handoff-legacy-'));
    try {
      const { hint } = await createReadyApprovedTeamHint(
        cwd,
        'issue-1314-legacy',
        [
          { path: './docs\\scope-entry.md', roles: ['scope'] },
          { path: 'src\\build-entry.ts', roles: ['build'] },
          { path: './tests/verify-entry.ts', roles: ['verify'] },
        ],
      );

      assert.equal(hint.contextPackStatus, 'ready');
      assert.deepEqual(hint.contextPackRoleRefs, {
        build: ['src/build-entry.ts'],
        verify: ['tests/verify-entry.ts'],
        scope: ['docs/scope-entry.md'],
      });

      const handoff = buildApprovedTeamHandoffSection(hint);

      assert.match(handoff ?? '', /Build refs \(read first\): build-entry=src\/build-entry\.ts \[file\]/);
      assert.match(handoff ?? '', /Verify refs: verify-entry=tests\/verify-entry\.ts \[file\]/);
      assert.match(handoff ?? '', /Scope refs: scope-entry=docs\/scope-entry\.md \[file\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to grouped role refs when private metadata is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-handoff-fallback-'));
    try {
      const { hint } = await createReadyApprovedTeamHint(
        cwd,
        'issue-1314-counterfactual',
        [
          { path: 'docs/scope-entry.md', roles: ['scope'] },
          {
            path: 'src/build-entry.ts',
            roles: ['build'],
            selector: { type: 'heading', value: 'Build Focus', maxWords: 20 },
          },
          { path: 'tests/verify-entry.ts', roles: ['verify'] },
        ],
      );

      assert.equal(hint.contextPackStatus, 'ready');
      assert.deepEqual(hint.contextPackRoleRefs, {
        build: ['src/build-entry.ts'],
        verify: ['tests/verify-entry.ts'],
        scope: ['docs/scope-entry.md'],
      });

      const handoff = buildApprovedTeamHandoffSection(hint);

      assert.match(handoff ?? '', /Build refs \(read first\): src\/build-entry\.ts/);
      assert.match(handoff ?? '', /Verify refs: tests\/verify-entry\.ts/);
      assert.match(handoff ?? '', /Scope refs: docs\/scope-entry\.md/);
      assert.doesNotMatch(handoff ?? '', /=.*\[file\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rebinds file refs only when the worker repo contains the target path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-handoff-rebind-'));
    try {
      const { hint } = await createReadyApprovedTeamHint(
        cwd,
        'issue-1314-rebind',
        [
          { path: 'docs/scope-entry.md', roles: ['scope'] },
          { path: 'src/build-entry.ts', roles: ['build'], label: 'Build Focus' },
          { path: 'tests/verify-entry.ts', roles: ['verify'] },
        ],
      );
      assert.equal(hint.contextPackStatus, 'ready');
      await mkdir(join(cwd, 'src'), { recursive: true });
      await mkdir(join(cwd, 'tests'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'src', 'build-entry.ts'), 'export const buildEntry = true;\n');
      await writeFile(join(cwd, 'tests', 'verify-entry.ts'), 'export const verifyEntry = true;\n');
      await writeFile(join(cwd, 'docs', 'scope-entry.md'), '# Scope\n');

      const workerRepoRoot = join(cwd, 'worker-repo');
      await mkdir(join(workerRepoRoot, 'src'), { recursive: true });
      await writeFile(join(workerRepoRoot, 'src', 'build-entry.ts'), 'export const buildEntry = true;\n');

      const handoff = buildApprovedTeamHandoffSection(hint, { repoRoot: workerRepoRoot });

      assert.match(handoff ?? '', /Build refs \(read first\): build-focus=src\/build-entry\.ts \[file\]/);
      assert.match(
        handoff ?? '',
        new RegExp(`Verify refs: verify-entry=${join(cwd, 'tests', 'verify-entry.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[file\\]`),
      );
      assert.match(
        handoff ?? '',
        new RegExp(`Scope refs: scope-entry=${join(cwd, 'docs', 'scope-entry.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[file\\]`),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('buildApprovedTeamHandoffSection stays undefined outside ready Team handoffs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-handoff-nonready-'));
    try {
      const { hint } = await createReadyApprovedTeamHint(
        cwd,
        'issue-1314-nonready',
        [
          { path: 'docs/scope-entry.md', roles: ['scope'] },
          { path: 'src/build-entry.ts', roles: ['build'] },
          { path: 'tests/verify-entry.ts', roles: ['verify'] },
        ],
      );
      assert.equal(
        buildApprovedTeamHandoffSection({ ...hint, mode: 'ralph' }),
        undefined,
      );
      assert.equal(
        buildApprovedTeamHandoffSection({ ...hint, contextPackStatus: 'plan-only' }),
        undefined,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes and reads a normalized approved execution binding under the team state root', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-write-'));
      const stateRoot = join(cwd, '.omx', 'state');
      try {
        await writePersistedApprovedTeamExecutionBinding('alpha-team', cwd, {
          prd_path: '  /tmp/prd-alpha.md  ',
          task: '  Execute approved alpha plan  ',
          command: '  omx team 1:executor "Execute approved alpha plan"  ',
        }, stateRoot);

        const binding = await readPersistedApprovedTeamExecutionBinding('alpha-team', cwd, stateRoot);
        assert.deepEqual(binding, {
          prd_path: '/tmp/prd-alpha.md',
          task: 'Execute approved alpha plan',
          command: 'omx team 1:executor "Execute approved alpha plan"',
        });
        assert.deepEqual(
          Object.keys(
            JSON.parse(
              readFileSync(
                join(cwd, '.omx', 'state', 'team', 'alpha-team', 'approved-execution.json'),
                'utf-8',
              ),
            ) as Record<string, unknown>,
          ).sort(),
          ['command', 'prd_path', 'task'],
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', 'alpha-team', 'approved-execution.json')),
          true,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('resolves a valid continuity state for an exact approved team binding', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-valid-'));
      const stateRoot = join(cwd, '.omx', 'state');
      try {
        const plansDir = join(cwd, '.omx', 'plans');
        await mkdir(plansDir, { recursive: true });
        const prdPath = join(plansDir, 'prd-issue-1314.md');
        await writeFile(
          prdPath,
          '# Approved plan\n\nLaunch via omx team 1:executor "Execute approved issue 1314 plan"\n',
        );
        await writeFile(join(plansDir, 'test-spec-issue-1314.md'), '# Test spec\n');
        await writePersistedApprovedTeamExecutionBinding('bound-team', cwd, {
          prd_path: prdPath,
          task: 'Execute approved issue 1314 plan',
          command: 'omx team 1:executor "Execute approved issue 1314 plan"',
        }, stateRoot);

        const state = await resolvePersistedApprovedTeamExecutionContinuityState(
          'bound-team',
          cwd,
          stateRoot,
        );
        assert.equal(state.status, 'valid');
        if (state.status !== 'valid') {
          throw new Error('expected valid continuity state');
        }
        assert.equal(state.binding.prd_path, prdPath);
        assert.equal(state.approvedHint.sourcePath, prdPath);
        assert.equal(state.approvedHint.task, 'Execute approved issue 1314 plan');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('reports an ambiguous continuity state when a task-only binding matches multiple team launch hints', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-ambiguous-'));
      const stateRoot = join(cwd, '.omx', 'state');
      const approvedTask = 'Execute approved issue 1316 plan';
      try {
        const plansDir = join(cwd, '.omx', 'plans');
        await mkdir(plansDir, { recursive: true });
        const prdPath = join(plansDir, 'prd-issue-1316.md');
        await writeFile(
          prdPath,
          [
            '# Approved plan',
            '',
            `Launch via omx team 2:executor "${approvedTask}"`,
            `Launch via omx team 5:debugger "${approvedTask}"`,
          ].join('\n'),
        );
        await writeFile(join(plansDir, 'test-spec-issue-1316.md'), '# Test spec\n');
        await writePersistedApprovedTeamExecutionBinding('bound-team', cwd, {
          prd_path: prdPath,
          task: approvedTask,
        }, stateRoot);

        const state = await resolvePersistedApprovedTeamExecutionContinuityState(
          'bound-team',
          cwd,
          stateRoot,
        );
        assert.equal(state.status, 'ambiguous');
        if (state.status !== 'ambiguous') {
          throw new Error('expected ambiguous continuity state');
        }
        assert.equal(state.binding.prd_path, prdPath);
        assert.equal(state.binding.task, approvedTask);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('keeps an exact-command binding valid when the task text alone would be ambiguous', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-command-'));
      const stateRoot = join(cwd, '.omx', 'state');
      const approvedTask = 'Execute approved issue 1317 plan';
      const exactCommand = `omx team 2:executor "${approvedTask}"`;
      try {
        const plansDir = join(cwd, '.omx', 'plans');
        await mkdir(plansDir, { recursive: true });
        const prdPath = join(plansDir, 'prd-issue-1317.md');
        await writeFile(
          prdPath,
          [
            '# Approved plan',
            '',
            `Launch via ${exactCommand}`,
            `Launch via omx team 5:debugger "${approvedTask}"`,
          ].join('\n'),
        );
        await writeFile(join(plansDir, 'test-spec-issue-1317.md'), '# Test spec\n');
        await writePersistedApprovedTeamExecutionBinding('bound-team', cwd, {
          prd_path: prdPath,
          task: approvedTask,
          command: exactCommand,
        }, stateRoot);

        const state = await resolvePersistedApprovedTeamExecutionContinuityState(
          'bound-team',
          cwd,
          stateRoot,
        );
        assert.equal(state.status, 'valid');
        if (state.status !== 'valid') {
          throw new Error('expected valid continuity state');
        }
        assert.equal(state.approvedHint.command, exactCommand);
        assert.equal(state.approvedHint.workerCount, 2);
        assert.equal(state.approvedHint.agentType, 'executor');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('keeps an exact-command binding valid when the approved team hint is wrapped across visible lines', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-wrapped-command-'));
      const stateRoot = join(cwd, '.omx', 'state');
      const approvedTask = 'Execute approved issue 1317 wrapped plan';
      const exactCommand = `omx team 2:executor "${approvedTask}"`;
      try {
        const plansDir = join(cwd, '.omx', 'plans');
        await mkdir(plansDir, { recursive: true });
        const prdPath = join(plansDir, 'prd-issue-1317-wrapped.md');
        await writeFile(
          prdPath,
          [
            '# Approved plan',
            '',
            'Launch via omx team',
            '2:executor',
            JSON.stringify(approvedTask),
            `Launch via omx team 5:debugger "${approvedTask}"`,
          ].join('\n'),
        );
        await writeFile(join(plansDir, 'test-spec-issue-1317-wrapped.md'), '# Test spec\n');
        await writePersistedApprovedTeamExecutionBinding('bound-team', cwd, {
          prd_path: prdPath,
          task: approvedTask,
          command: exactCommand,
        }, stateRoot);

        const state = await resolvePersistedApprovedTeamExecutionContinuityState(
          'bound-team',
          cwd,
          stateRoot,
        );
        assert.equal(state.status, 'valid');
        if (state.status !== 'valid') {
          throw new Error('expected valid continuity state');
        }
        assert.equal(state.approvedHint.command, exactCommand);
        assert.equal(state.approvedHint.workerCount, 2);
        assert.equal(state.approvedHint.agentType, 'executor');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('preserves missing-baseline continuity instead of collapsing it to stale', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-missing-baseline-'));
      const stateRoot = join(cwd, '.omx', 'state');
      try {
        const plansDir = join(cwd, '.omx', 'plans');
        await mkdir(plansDir, { recursive: true });
        const prdPath = join(plansDir, 'prd-issue-1318.md');
        await writeFile(
          prdPath,
          '# Approved plan\n\nLaunch via omx team 1:executor "Execute approved issue 1318 plan"\n',
        );
        await writePersistedApprovedTeamExecutionBinding('bound-team', cwd, {
          prd_path: prdPath,
          task: 'Execute approved issue 1318 plan',
          command: 'omx team 1:executor "Execute approved issue 1318 plan"',
        }, stateRoot);

        const state = await resolvePersistedApprovedTeamExecutionContinuityState(
          'bound-team',
          cwd,
          stateRoot,
        );
        assert.equal(state.status, 'valid');
        if (state.status !== 'valid') {
          throw new Error('expected missing-baseline continuity state');
        }
        assert.equal(state.approvedHint.contextPackStatus, 'missing-baseline');
        assert.deepEqual(state.approvedHint.testSpecPaths, []);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('reports malformed and stale binding states explicitly', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-invalid-'));
      const stateRoot = join(cwd, '.omx', 'state');
      try {
        const teamRoot = join(stateRoot, 'team', 'broken-team');
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'approved-execution.json'), '{"prd_path":42}', 'utf-8');
        assert.equal(
          readPersistedApprovedTeamExecutionBindingStateSync('broken-team', cwd, stateRoot).status,
          'malformed',
        );

        await writePersistedApprovedTeamExecutionBinding('broken-team', cwd, {
          prd_path: join(cwd, '.omx', 'plans', 'prd-missing.md'),
          task: 'Execute missing approved plan',
        }, stateRoot);
        const state = await resolvePersistedApprovedTeamExecutionContinuityState(
          'broken-team',
          cwd,
          stateRoot,
        );
        assert.equal(state.status, 'stale');
        if (state.status !== 'stale') {
          throw new Error('expected stale continuity state');
        }
        assert.equal(state.binding.task, 'Execute missing approved plan');
        assert.equal(
          JSON.parse(readFileSync(join(teamRoot, 'approved-execution.json'), 'utf-8')).task,
          'Execute missing approved plan',
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('rejects unsafe team names before resolving approved binding paths', async () => {
    await withUnboxedOmxRoot(async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-unsafe-team-'));
      try {
        await assert.rejects(
          () => writePersistedApprovedTeamExecutionBinding('../escape', cwd, {
            prd_path: join(cwd, '.omx', 'plans', 'prd-alpha.md'),
            task: 'Execute approved alpha plan',
          }),
          /invalid_team_name:\.\.\/escape/,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'escape', 'approved-execution.json')),
          false,
        );
        assert.throws(
          () => readPersistedApprovedTeamExecutionBindingStateSync('../escape', cwd),
          /invalid_team_name:\.\.\/escape/,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});
