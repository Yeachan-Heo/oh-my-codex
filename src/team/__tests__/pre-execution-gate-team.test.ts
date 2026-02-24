import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTeamState, transitionPhase } from '../orchestrator.js';

describe('team orchestrator pre-execution gate', () => {
  it('blocks team-exec transition when no plan artifacts exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'omx-team-gate-'));
    const state = createTeamState('test task');
    const prd = transitionPhase(state, 'team-prd');

    assert.throws(
      () => transitionPhase(prd, 'team-exec', undefined, root),
      (err: Error) => err.message.includes('PRE-EXECUTION GATE'),
    );
  });

  it('allows team-exec transition when PRD Scope + Test Spec exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'omx-team-gate-'));
    const plansDir = join(root, '.omx', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, 'plan.md'),
      '# Plan\n\n## PRD Scope\n- in scope\n\n## Test Spec\n- tests\n',
    );

    const state = createTeamState('test task');
    const prd = transitionPhase(state, 'team-prd');
    const exec = transitionPhase(prd, 'team-exec', undefined, root);

    assert.equal(exec.phase, 'team-exec');
    assert.equal(exec.active, true);
  });

  it('allows team-exec transition when cwd is not provided (backward compat)', () => {
    const state = createTeamState('test task');
    const prd = transitionPhase(state, 'team-prd');
    const exec = transitionPhase(prd, 'team-exec');

    assert.equal(exec.phase, 'team-exec');
  });
});
