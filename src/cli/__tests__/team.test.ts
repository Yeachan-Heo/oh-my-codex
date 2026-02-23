import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamStartArgs } from '../team.js';

describe('parseTeamStartArgs', () => {
  it('parses default team start args without worktree', () => {
    const result = parseTeamStartArgs(['2:executor', 'build', 'feature']);
    assert.deepEqual(result.worktreeMode, { enabled: false });
    assert.equal(result.parsed.workerCount, 2);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'build feature');
    assert.equal(result.parsed.teamName, 'build-feature');
  });

  it('parses detached worktree mode and strips the flag', () => {
    const result = parseTeamStartArgs(['--worktree', '3:debugger', 'fix', 'bug']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: true, name: null });
    assert.equal(result.parsed.workerCount, 3);
    assert.equal(result.parsed.agentType, 'debugger');
    assert.equal(result.parsed.task, 'fix bug');
    assert.equal(result.parsed.teamName, 'fix-bug');
  });

  it('parses named worktree mode with ralph prefix', () => {
    const result = parseTeamStartArgs(['ralph', '--worktree=feature/demo', '4:executor', 'ship', 'it']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: false, name: 'feature/demo' });
    assert.equal(result.parsed.ralph, true);
    assert.equal(result.parsed.workerCount, 4);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'ship it');
    assert.equal(result.parsed.teamName, 'ship-it');
  });
});
