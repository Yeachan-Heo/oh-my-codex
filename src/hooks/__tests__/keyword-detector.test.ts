import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectKeywords, detectPrimaryKeyword } from '../keyword-detector.js';
import { generateKeywordDetectionSection } from '../emulator.js';

describe('keyword detector swarm/team compatibility', () => {
  it('maps "coordinated team" phrase to team orchestration skill', () => {
    const match = detectPrimaryKeyword('run a coordinated team for implementation');

    assert.ok(match);
    assert.equal(match.skill, 'team');
    assert.match(match.keyword.toLowerCase(), /team/);
  });

  it('maps "swarm" to team orchestration skill', () => {
    const match = detectPrimaryKeyword('please use swarm for this task');

    assert.ok(match);
    assert.equal(match.skill, 'team');
  });

  it('maps "coordinated swarm" phrase to team orchestration skill', () => {
    const match = detectPrimaryKeyword('run a coordinated swarm for implementation');

    assert.ok(match);
    assert.equal(match.skill, 'team');
    assert.match(match.keyword.toLowerCase(), /swarm/);
  });

  it('keeps swarm trigger priority aligned with team trigger', () => {
    const teamMatch = detectKeywords('team agents should handle this').find((entry) => entry.skill === 'team');
    const swarmMatch = detectKeywords('swarm should handle this').find((entry) => entry.skill === 'team');

    assert.ok(teamMatch);
    assert.ok(swarmMatch);
    assert.equal(swarmMatch.priority, teamMatch.priority);
  });
});

describe('keyword detection guidance generation', () => {
  it('includes swarm alias activation guidance', () => {
    const section = generateKeywordDetectionSection();

    assert.match(section, /When user says "coordinated team": Activate coordinated team mode/);
    assert.match(section, /When user says "swarm": Activate coordinated team mode \(swarm is a compatibility alias for team\)/);
    assert.match(section, /When user says "coordinated swarm": Activate coordinated team mode \(swarm is a compatibility alias for team\)/);
  });
});
