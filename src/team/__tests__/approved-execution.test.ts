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

describe('approved execution binding', () => {
  it('writes and reads a normalized approved execution binding under the team state root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-write-'));
    try {
      await writePersistedApprovedTeamExecutionBinding('alpha-team', cwd, {
        prd_path: '  /tmp/prd-alpha.md  ',
        task: '  Execute approved alpha plan  ',
        command: '  omx team 1:executor "Execute approved alpha plan"  ',
      });

      const binding = await readPersistedApprovedTeamExecutionBinding('alpha-team', cwd);
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

  it('resolves a valid continuity state for an exact approved team binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-valid-'));
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
      });

      const state = await resolvePersistedApprovedTeamExecutionContinuityState('bound-team', cwd);
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

  it('reports malformed and stale binding states explicitly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-approved-execution-invalid-'));
    try {
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'broken-team');
      await mkdir(teamRoot, { recursive: true });
      await writeFile(join(teamRoot, 'approved-execution.json'), '{"prd_path":42}', 'utf-8');
      assert.equal(
        readPersistedApprovedTeamExecutionBindingStateSync('broken-team', cwd).status,
        'malformed',
      );

      await writePersistedApprovedTeamExecutionBinding('broken-team', cwd, {
        prd_path: join(cwd, '.omx', 'plans', 'prd-missing.md'),
        task: 'Execute missing approved plan',
      });
      const state = await resolvePersistedApprovedTeamExecutionContinuityState('broken-team', cwd);
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

  it('rejects unsafe team names before resolving approved binding paths', async () => {
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
