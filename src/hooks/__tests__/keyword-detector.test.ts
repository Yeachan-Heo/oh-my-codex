import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectKeywords,
  detectPrimaryKeyword,
  recordSkillActivation,
  SKILL_ACTIVE_STATE_FILE,
} from '../keyword-detector.js';
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

describe('keyword detector skill-active-state lifecycle', () => {
  it('writes skill-active-state.json with planning phase when keyword activates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: 'please run autopilot and keep going',
        sessionId: 'sess-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'planning');
      assert.equal(result.active, true);

      const persisted = JSON.parse(await readFile(join(stateDir, SKILL_ACTIVE_STATE_FILE), 'utf-8')) as {
        skill: string;
        phase: string;
        active: boolean;
      };
      assert.equal(persisted.skill, 'autopilot');
      assert.equal(persisted.phase, 'planning');
      assert.equal(persisted.active, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not write state when no keyword is present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-none-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: 'hello there, how are you',
      });
      assert.equal(result, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
