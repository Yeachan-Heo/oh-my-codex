import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectKeywords,
  detectPrimaryKeyword,
  recordSkillActivation,
  SKILL_ACTIVE_STATE_FILE,
  DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
  DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
} from '../keyword-detector.js';
import { isUnderspecifiedForExecution, applyRalplanGate } from '../keyword-detector.js';
import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';

describe('keyword detector swarm/team compatibility', () => {
  it('keeps explicit $skill order in detectKeywords results (left-to-right)', () => {
    const matches = detectKeywords('$analyze $ultraqa $code-review now');
    assert.deepEqual(matches.map((m) => m.skill).slice(0, 3), ['analyze', 'ultraqa', 'code-review']);
  });

  it('de-duplicates repeated explicit skill tokens', () => {
    const matches = detectKeywords('$analyze $analyze root cause');
    assert.deepEqual(matches.map((m) => m.skill), ['analyze']);
  });

  it('limits explicit multi-skill invocation to the first contiguous $skill block', () => {
    const matches = detectKeywords('$ralplan Fix issue #1030 and ensure other directives ($ralph, $team, $deep-interview) are not affected');
    assert.deepEqual(matches.map((m) => m.skill), ['ralplan']);
  });

  it('does not merge implicit keyword matches when an explicit $skill is present', () => {
    const matches = detectKeywords('please run $team and then analyze the result');
    assert.deepEqual(matches.map((m) => m.skill), ['team']);
  });

  it('does not auto-detect keywords for explicit /prompts invocation without $skills', () => {
    const matches = detectKeywords('/prompts:architect analyze this issue');
    assert.deepEqual(matches, []);
    const primary = detectPrimaryKeyword('/prompts:architect analyze this issue');
    assert.equal(primary, null);
  });

  it('treats /prompts invocation with trailing punctuation as explicit command', () => {
    const matches = detectKeywords('/prompts:architect, analyze this issue');
    assert.deepEqual(matches, []);
    const primary = detectPrimaryKeyword('/prompts:architect, analyze this issue');
    assert.equal(primary, null);
  });

  it('maps analyze keyword to analyze skill', () => {
    const match = detectPrimaryKeyword('please analyze this workflow');
    assert.ok(match);
    assert.equal(match.skill, 'analyze');
  });

  it('maps code-review keyword variants to code-review skill', () => {
    const hyphen = detectPrimaryKeyword('run code-review before merge');
    assert.ok(hyphen);
    assert.equal(hyphen.skill, 'code-review');

    const spaced = detectPrimaryKeyword('please do a code review');
    assert.ok(spaced);
    assert.equal(spaced.skill, 'code-review');
  });

  it('supports explicit multi-skill invocation by prioritizing left-most $skill', () => {
    const match = detectPrimaryKeyword('$ultraqa $analyze $code-review run now');
    assert.ok(match);
    assert.equal(match.skill, 'ultraqa');
    assert.equal(match.keyword.toLowerCase(), '$ultraqa');
  });

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
    const match = detectPrimaryKeyword('You have 1 new message(s). Read .omx/state/team/execute-plan/mailbox/worker-3.json, act now, reply with concrete progress, then continue assigned work or next feasible task.');
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

  it('does not trigger keyword detector for explicit /prompts:swarm invocation', () => {
    const match = detectPrimaryKeyword('use /prompts:swarm for this');
    assert.equal(match, null);
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

  it('maps "deep interview" phrase to deep-interview skill', () => {
    const match = detectPrimaryKeyword('please run a deep interview before planning');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'deep interview');
  });

  it('maps "gather requirements" to deep-interview skill', () => {
    const match = detectPrimaryKeyword('let us gather requirements first');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'gather requirements');
  });

  it('maps "ouroboros" to deep-interview skill', () => {
    const match = detectPrimaryKeyword('please run ouroboros before planning');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'ouroboros');
  });

  it('maps "interview me" to deep-interview skill', () => {
    const match = detectPrimaryKeyword('interview me before we start implementation');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'interview me');
  });

  it('maps "don\'t assume" to deep-interview skill', () => {
    const match = detectPrimaryKeyword("don't assume anything yet");

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), "don't assume");
  });

  it('prefers "deep interview" over "interview" for deterministic longest-match behavior', () => {
    const match = detectPrimaryKeyword('deep interview this request first');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'deep interview');
  });
});

describe('keyword registry coverage', () => {
  it('includes key team/swarm aliases in runtime keyword registry', () => {
    const registryKeywords = new Set(KEYWORD_TRIGGER_DEFINITIONS.map((v) => v.keyword.toLowerCase()));
    assert.ok(registryKeywords.has('ultraqa'));
    assert.ok(registryKeywords.has('analyze'));
    assert.ok(registryKeywords.has('investigate'));
    assert.ok(registryKeywords.has('code review'));
    assert.ok(registryKeywords.has('code-review'));
    assert.ok(registryKeywords.has('coordinated team'));
    assert.ok(registryKeywords.has('swarm'));
    assert.ok(registryKeywords.has('coordinated swarm'));
    assert.ok(registryKeywords.has('ouroboros'));
    assert.ok(registryKeywords.has("don't assume"));
    assert.ok(registryKeywords.has('interview me'));
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

  it('acquires a deep-interview input lock immediately on activation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: 'please run a deep interview before planning',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'deep-interview');
      assert.equal(result.input_lock?.active, true);
      assert.deepEqual(result.input_lock?.blocked_inputs, [...DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS]);
      assert.equal(result.input_lock?.blocked_inputs.includes('next i should'), true);
      assert.equal(result.input_lock?.message, DEEP_INTERVIEW_INPUT_LOCK_MESSAGE);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases the deep-interview input lock on abort via cancel keyword', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-abort-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await recordSkillActivation({
        stateDir,
        text: 'please run deep interview',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      const result = await recordSkillActivation({
        stateDir,
        text: 'abort now',
        nowIso: '2026-02-25T00:05:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'deep-interview');
      assert.equal(result.active, false);
      assert.equal(result.phase, 'completing');
      assert.equal(result.input_lock?.active, false);
      assert.equal(result.input_lock?.released_at, '2026-02-25T00:05:00.000Z');
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
  it('does not re-enter ralplan for a short approved team follow-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-followup-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch hint: omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-831.md'), '# Test spec\n');

      const result = applyRalplanGate(['team'], 'team', { cwd });
      assert.equal(result.gateApplied, false);
      assert.deepEqual(result.keywords, ['team']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not re-enter ralplan for a short approved Korean team follow-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-followup-ko-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch hint: omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-831.md'), '# Test spec\n');

      const result = applyRalplanGate(['team'], 'team으로 해줘', { cwd });
      assert.equal(result.gateApplied, false);
      assert.deepEqual(result.keywords, ['team']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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
