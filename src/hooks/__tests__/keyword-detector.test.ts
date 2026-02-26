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
import { isUnderspecifiedForExecution, applyRalplanGate } from '../keyword-detector.js';
import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';

async function readTemplateKeywords(): Promise<string[]> {
  const templatePath = join(process.cwd(), 'templates', 'AGENTS.md');
  const content = await readFile(templatePath, 'utf-8');
  const lines = content.split('\n');
  const keywords = new Set<string>();

  for (const line of lines) {
    if (!line.startsWith('| "') || !line.includes('| `$')) continue;
    const [firstColumn] = line.split('|').slice(1, 2);
    const matches = firstColumn?.matchAll(/"([^"]+)"/g) ?? [];
    for (const match of matches) keywords.add(match[1]);
  }

  return [...keywords];
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

  it('resets activated_at when keyword changes within the same skill', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-keyword-switch-'));
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
        text: 'I want a starter API',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.notEqual(result.keyword.toLowerCase(), 'autopilot');
      assert.equal(result.activated_at, '2026-02-26T00:00:00.000Z');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('isUnderspecifiedForExecution', () => {
  it('flags vague prompt with no files or functions', () => {
    assert.equal(isUnderspecifiedForExecution('ralph fix this'), true);
  });

  it('flags short vague prompt', () => {
    assert.equal(isUnderspecifiedForExecution('autopilot build the app'), true);
  });

  it('flags prompt with only keyword and generic words', () => {
    assert.equal(isUnderspecifiedForExecution('team improve performance'), true);
  });

  it('passes prompt with a file path reference', () => {
    assert.equal(isUnderspecifiedForExecution('ralph fix src/hooks/bridge.ts'), false);
  });

  it('passes prompt with a file extension reference', () => {
    assert.equal(isUnderspecifiedForExecution('fix the bug in auth.ts'), false);
  });

  it('passes prompt with a directory/file path', () => {
    assert.equal(isUnderspecifiedForExecution('update src/hooks/emulator.ts'), false);
  });

  it('passes prompt with a camelCase symbol', () => {
    assert.equal(isUnderspecifiedForExecution('team fix processKeywordDetector'), false);
  });

  it('passes prompt with a PascalCase symbol', () => {
    assert.equal(isUnderspecifiedForExecution('ralph update UserModel'), false);
  });

  it('passes prompt with snake_case symbol', () => {
    assert.equal(isUnderspecifiedForExecution('fix user_model validation'), false);
  });

  it('passes prompt with an issue number', () => {
    assert.equal(isUnderspecifiedForExecution('autopilot implement #42'), false);
  });

  it('passes prompt with numbered steps', () => {
    assert.equal(isUnderspecifiedForExecution('ralph do:\n1. Add input validation\n2. Write tests\n3. Update README'), false);
  });

  it('passes prompt with acceptance criteria keyword', () => {
    assert.equal(isUnderspecifiedForExecution('add login - acceptance criteria: user sees error on bad password'), false);
  });

  it('passes prompt with a specific error reference', () => {
    assert.equal(isUnderspecifiedForExecution('ralph fix TypeError in auth handler'), false);
  });

  it('passes with force: escape hatch prefix', () => {
    assert.equal(isUnderspecifiedForExecution('force: ralph refactor the auth module'), false);
  });

  it('passes with ! escape hatch prefix', () => {
    assert.equal(isUnderspecifiedForExecution('! autopilot optimize everything'), false);
  });

  it('returns true for empty string', () => {
    assert.equal(isUnderspecifiedForExecution(''), true);
  });

  it('returns true for whitespace only', () => {
    assert.equal(isUnderspecifiedForExecution('   '), true);
  });

  it('passes prompt with test runner command', () => {
    assert.equal(isUnderspecifiedForExecution('ralph npm test && fix failures'), false);
  });

  it('passes longer prompt that exceeds word threshold', () => {
    // 16+ effective words without specific signals → passes (not underspecified by word count)
    const longVague = 'please help me improve the overall quality and performance and reliability of this system going forward';
    assert.equal(isUnderspecifiedForExecution(longVague), false);
  });

  it('false positive prevention: camelCase identifiers pass', () => {
    assert.equal(isUnderspecifiedForExecution('fix getUserById to handle null'), false);
  });
});

describe('applyRalplanGate', () => {
  it('redirects underspecified execution keywords to ralplan', () => {
    const result = applyRalplanGate(['ralph'], 'ralph fix this');
    assert.equal(result.gateApplied, true);
    assert.ok(result.keywords.includes('ralplan'));
    assert.ok(!result.keywords.includes('ralph'));
  });

  it('redirects autopilot to ralplan when underspecified', () => {
    const result = applyRalplanGate(['autopilot'], 'autopilot build the app');
    assert.equal(result.gateApplied, true);
    assert.ok(result.keywords.includes('ralplan'));
  });

  it('does not gate well-specified prompts', () => {
    const result = applyRalplanGate(['ralph'], 'ralph fix src/hooks/bridge.ts null check');
    assert.equal(result.gateApplied, false);
    assert.ok(result.keywords.includes('ralph'));
  });

  it('does not gate when cancel is present', () => {
    const result = applyRalplanGate(['cancel', 'ralph'], 'cancel ralph');
    assert.equal(result.gateApplied, false);
  });

  it('does not gate when ralplan is already present', () => {
    const result = applyRalplanGate(['ralplan'], 'ralplan add auth');
    assert.equal(result.gateApplied, false);
    assert.ok(result.keywords.includes('ralplan'));
  });

  it('does not gate non-execution keywords', () => {
    const result = applyRalplanGate(['analyze'], 'analyze this');
    assert.equal(result.gateApplied, false);
  });

  it('preserves non-execution keywords when gating', () => {
    const result = applyRalplanGate(['ralph', 'tdd'], 'ralph tdd fix this');
    assert.equal(result.gateApplied, true);
    assert.ok(result.keywords.includes('tdd'));
    assert.ok(result.keywords.includes('ralplan'));
    assert.ok(!result.keywords.includes('ralph'));
  });

  it('handles force: escape hatch — does not gate', () => {
    const result = applyRalplanGate(['ralph'], 'force: ralph refactor the auth module');
    assert.equal(result.gateApplied, false);
  });

  it('gates multiple execution keywords at once', () => {
    const result = applyRalplanGate(['ralph', 'team'], 'ralph team fix this');
    assert.equal(result.gateApplied, true);
    assert.ok(result.keywords.includes('ralplan'));
    assert.ok(!result.keywords.includes('ralph'));
    assert.ok(!result.keywords.includes('team'));
    assert.ok(result.gatedKeywords.includes('ralph'));
    assert.ok(result.gatedKeywords.includes('team'));
  });

  it('returns empty keywords unchanged when no keywords', () => {
    const result = applyRalplanGate([], 'fix this');
    assert.equal(result.gateApplied, false);
    assert.deepEqual(result.keywords, []);
  });

  it('does not duplicate ralplan if already in filtered list', () => {
    // ultrawork is an execution keyword; after filtering, ralplan added once
    const result = applyRalplanGate(['ultrawork'], 'ultrawork do stuff');
    assert.equal(result.keywords.filter(k => k === 'ralplan').length, 1);
  });

  it('reports gatedKeywords correctly', () => {
    const result = applyRalplanGate(['ralph', 'ultrawork'], 'ralph ultrawork build');
    assert.ok(result.gatedKeywords.includes('ralph'));
    assert.ok(result.gatedKeywords.includes('ultrawork'));
  });
});
