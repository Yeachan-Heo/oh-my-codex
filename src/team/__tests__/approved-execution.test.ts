import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPersistedApprovedTeamExecutionBinding,
  readPersistedApprovedTeamExecutionBindingStateSync,
  resolvePersistedApprovedTeamExecutionContinuityState,
  writePersistedApprovedTeamExecutionBinding,
} from '../approved-execution.js';

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

describe('approved execution binding', () => {
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
