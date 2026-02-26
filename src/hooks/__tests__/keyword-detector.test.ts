import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectKeywords,
  detectPrimaryKeyword,
  recordSkillActivation,
  SKILL_ACTIVE_STATE_FILE,
} from '../keyword-detector.js';
import { generateKeywordDetectionSection } from '../emulator.js';
import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';

afterEach(() => {
  mock.restoreAll();
});

async function readTemplateKeywords(): Promise<string[]> {
  const template = await readFile(join(process.cwd(), 'templates', 'AGENTS.md'), 'utf-8');
  const lines = template.split('\n').filter((line) => line.startsWith('| "'));
  const keywords: string[] = [];
  for (const line of lines) {
    const firstCell = line.split('|')[1] ?? '';
    const matches = firstCell.matchAll(/"([^"]+)"/g);
    for (const match of matches) keywords.push(match[1]);
  }
  return keywords;
}

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
    const teamMatch = detectKeywords('use team agents for this').find((entry) => entry.skill === 'team');
    const swarmMatch = detectKeywords('use swarm for this').find((entry) => entry.skill === 'team');

    assert.ok(teamMatch);
    assert.ok(swarmMatch);
    assert.equal(swarmMatch.priority, teamMatch.priority);
  });

  it('does not trigger team keyword from filesystem/team-state path text', () => {
    const match = detectPrimaryKeyword('You have 1 new message(s). Check .omx/state/team/execute-plan/mailbox/worker-3.json');
    assert.equal(match, null);
  });

  it('does not trigger team skill from incidental prose usage', () => {
    const match = detectPrimaryKeyword('the team reviewed the document and shared feedback');
    assert.equal(match, null);
  });

  it('still triggers team for explicit $team invocation', () => {
    const match = detectPrimaryKeyword('please run $team now');
    assert.ok(match);
    assert.equal(match.skill, 'team');
  });

  it('still triggers swarm for explicit /prompts:swarm invocation', () => {
    const match = detectPrimaryKeyword('use /prompts:swarm for this');
    assert.ok(match);
    assert.equal(match.skill, 'team');
  });

  it('prefers ralplan over ralph when both keywords are present', () => {
    const match = detectPrimaryKeyword('use ralph mode but do ralplan first');

    assert.ok(match);
    assert.equal(match.skill, 'ralplan');
  });

  it('applies longest-match tie-breaker when priorities are equal', () => {
    const match = detectPrimaryKeyword('please run a coordinated swarm for this');

    assert.ok(match);
    assert.equal(match.skill, 'team');
    assert.equal(match.keyword.toLowerCase(), 'coordinated swarm');
  });
});

describe('keyword detection guidance generation', () => {
  it('keeps template keyword table and runtime keyword registry in sync', async () => {
    const templateKeywords = new Set((await readTemplateKeywords()).map((v) => v.toLowerCase()));
    const registryKeywords = new Set(KEYWORD_TRIGGER_DEFINITIONS.map((v) => v.keyword.toLowerCase()));
    assert.deepEqual([...registryKeywords].sort(), [...templateKeywords].sort());
  });

  it('includes swarm alias activation guidance', () => {
    const section = generateKeywordDetectionSection();

    assert.match(section, /When user says "coordinated team": Activate coordinated team mode/);
    assert.match(section, /When user says "swarm": Activate coordinated team mode \(swarm is a compatibility alias for team\)/);
    assert.match(section, /When user says "coordinated swarm": Activate coordinated team mode \(swarm is a compatibility alias for team\)/);
  });

  it('includes ralplan-first planning gate guidance', () => {
    const section = generateKeywordDetectionSection();

    assert.match(section, /Ralplan-first execution gate:/);
    assert.match(section, /`prd-\*\.md`/);
    assert.match(section, /`test-spec-\*\.md`/);
    assert.match(section, /if ralph is active/i);
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

  it('emits a warning when skill-active-state persistence fails', async () => {
    const warnings: unknown[][] = [];
    mock.method(console, 'warn', (...args: unknown[]) => {
      warnings.push(args);
    });

    const result = await recordSkillActivation({
      stateDir: join('/definitely-missing', 'nested', 'state-dir'),
      text: 'please run autopilot',
      nowIso: '2026-02-25T00:00:00.000Z',
    });

    assert.ok(result);
    assert.equal(result.skill, 'autopilot');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /failed to persist keyword activation state/);
  });

  it('preserves activated_at for same-skill continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    const statePath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: 'autopilot',
          phase: 'planning',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          source: 'keyword-detector',
        }),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'autopilot keep going',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.activated_at, '2026-02-25T00:00:00.000Z');
      assert.equal(result.updated_at, '2026-02-26T00:00:00.000Z');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resets activated_at when skill changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-skill-switch-'));
    const stateDir = join(cwd, '.omx', 'state');
    const statePath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: 'autopilot',
          phase: 'planning',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          source: 'keyword-detector',
        }),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'please run ralph now',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralph');
      assert.equal(result.activated_at, '2026-02-26T00:00:00.000Z');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
