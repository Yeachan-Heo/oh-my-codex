import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectKeywords,
  detectPrimaryKeyword,
  classifyKeywordInput,
  KEYWORD_INERT_DIAGNOSTIC_ORDER,
  recordSkillActivation,
  DEEP_INTERVIEW_STATE_FILE,
  DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
  DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
  persistDeepInterviewModeState,
} from '../keyword-detector.js';
import { SKILL_ACTIVE_STATE_FILE } from '../../state/skill-active.js';
import { isUnderspecifiedForExecution, applyRalplanGate } from '../keyword-detector.js';
import {
  EXPLICIT_SKILL_ALIASES,
  getExplicitSkillDefinition,
  KEYWORD_TRIGGER_DEFINITIONS,
} from '../keyword-registry.js';
import { evaluateResolvedPromptTurn } from '../prompt-session-provenance.js';

async function withIsolatedHome<T>(prefix: string, run: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), `omx-keyword-home-${prefix}-`));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = homeDir;
    return await run(homeDir);
  } finally {
    if (typeof previousHome === 'string') process.env.HOME = previousHome;
    else delete process.env.HOME;
    await rm(homeDir, { recursive: true, force: true });
  }
}

const AUTOPILOT_TEST_NOW = '2026-05-30T00:00:00.000Z';
const AUTOPILOT_TEST_STARTED_AT = '2026-05-29T00:00:00.000Z';
const AUTOPILOT_TEST_UPDATED_AT = '2026-05-29T00:10:00.000Z';

interface TestAutopilotModeState {
  context_snapshot_path?: string;
  state?: {
    handoff_artifacts?: {
      context_snapshot_path?: string;
      context_snapshot?: {
        path?: string;
        kind?: string;
        original_task_status?: string;
        recovery?: { status?: string; reason?: string };
      };
    };
    context_snapshot_recovery?: { status?: string; reason?: string } | unknown;
  };
}

async function writeActiveAutopilotSkillState(
  stateDir: string,
  sessionId: string,
  phase = 'ralplan',
): Promise<void> {
  await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
  await writeFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), JSON.stringify({
    version: 1,
    active: true,
    skill: 'autopilot',
    keyword: '$autopilot',
    phase,
    activated_at: AUTOPILOT_TEST_STARTED_AT,
    updated_at: AUTOPILOT_TEST_UPDATED_AT,
    session_id: sessionId,
    active_skills: [{ skill: 'autopilot', active: true, phase, session_id: sessionId }],
  }, null, 2));
}

async function readAutopilotModeState(stateDir: string, sessionId: string): Promise<TestAutopilotModeState> {
  return JSON.parse(
    await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8'),
  ) as TestAutopilotModeState;
}

async function continueAutopilotTestState(
  stateDir: string,
  cwd: string,
  sessionId: string,
  suffix: string,
  text = 'continue',
): Promise<void> {
  await recordSkillActivation({
    stateDir,
    sourceCwd: cwd,
    text,
    sessionId,
    threadId: `thread-${suffix}`,
    turnId: `turn-${suffix}`,
    nowIso: AUTOPILOT_TEST_NOW,
  });
}

async function assertAutopilotRecoverySnapshot(
  cwd: string,
  modeState: TestAutopilotModeState,
  expectedPath: string | RegExp,
  expectedReason: string,
): Promise<string> {
  const snapshotPath = modeState.state?.handoff_artifacts?.context_snapshot_path ?? '';
  if (typeof expectedPath === 'string') assert.equal(snapshotPath, expectedPath);
  else assert.match(snapshotPath, expectedPath);
  assert.equal(modeState.state?.handoff_artifacts?.context_snapshot?.kind, 'recovery');
  assert.equal(modeState.state?.handoff_artifacts?.context_snapshot?.recovery?.reason, expectedReason);
  assert.equal((modeState.state?.context_snapshot_recovery as { status?: string; reason?: string } | undefined)?.status, 'degraded');
  assert.equal((modeState.state?.context_snapshot_recovery as { status?: string; reason?: string } | undefined)?.reason, expectedReason);
  const recoverySnapshot = await readFile(join(cwd, snapshotPath), 'utf-8');
  assert.match(recoverySnapshot, /recovery status: degraded/);
  assert.match(recoverySnapshot, new RegExp(`recovery reason: ${expectedReason}`));
  assert.match(recoverySnapshot, /do not treat the continuation input as the task seed/);
  assert.doesNotMatch(recoverySnapshot, /task seed: continue/);
  return snapshotPath;
}

describe('keyword detector team compatibility', () => {
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

  it('does not fall back to implicit keyword detection when an unknown $token is present', () => {
    const matches = detectKeywords('$maer-thinking 다시 설명해봐 keep going');
    assert.deepEqual(matches, []);
    const primary = detectPrimaryKeyword('$maer-thinking 다시 설명해봐 keep going');
    assert.equal(primary, null);
  });

  it('recognizes plugin-prefixed explicit skill tokens', () => {
    const matches = detectKeywords('$oh-my-codex:ralplan implement issue #1307');
    assert.deepEqual(matches.map((m) => m.skill), ['ralplan']);
    assert.equal(matches[0]?.keyword, '$oh-my-codex:ralplan');
  });

  it('supports mixed-form explicit multi-skill invocation ordering and dedupe', () => {
    const matches = detectKeywords('$oh-my-codex:ralplan $ralph $oh-my-codex:ralplan ship this');
    assert.deepEqual(matches.map((m) => m.skill), ['ralplan', 'ralph']);
    assert.deepEqual(matches.map((m) => m.keyword), ['$oh-my-codex:ralplan', '$ralph']);
  });

  it('keeps recognized tokens on both sides of an unknown plugin-prefixed token in the same contiguous block', () => {
    const matches = detectKeywords('$oh-my-codex:ralplan $oh-my-codex:unknown $ralph');
    assert.deepEqual(matches.map((m) => m.skill), ['ralplan', 'ralph']);
    assert.deepEqual(matches.map((m) => m.keyword), ['$oh-my-codex:ralplan', '$ralph']);
  });

  it('limits mixed-form explicit invocation to the first contiguous block', () => {
    const matches = detectKeywords('$oh-my-codex:ralplan text $ralph');
    assert.deepEqual(matches.map((m) => m.skill), ['ralplan']);
  });

  it('normalizes plugin-prefixed ulw shorthand token', () => {
    const ulw = detectPrimaryKeyword('$oh-my-codex:ulw continue');
    assert.ok(ulw);
    assert.equal(ulw.skill, 'ultrawork');
    assert.equal(ulw.keyword, '$oh-my-codex:ulw');
  });

  it('supports plugin-prefixed hyphenated workflow tokens', () => {
    const deepInterview = detectPrimaryKeyword('$oh-my-codex:deep-interview gather requirements');
    assert.ok(deepInterview);
    assert.equal(deepInterview.skill, 'deep-interview');
    assert.equal(deepInterview.keyword, '$oh-my-codex:deep-interview');

    const codeReview = detectPrimaryKeyword('$oh-my-codex:code-review before merge');
    assert.ok(codeReview);
    assert.equal(codeReview.skill, 'code-review');
    assert.equal(codeReview.keyword, '$oh-my-codex:code-review');

    const bestPracticeResearch = detectPrimaryKeyword('$oh-my-codex:best-practice-research find official best practices');
    assert.ok(bestPracticeResearch);
    assert.equal(bestPracticeResearch.skill, 'best-practice-research');
    assert.equal(bestPracticeResearch.keyword, '$oh-my-codex:best-practice-research');
  });

  it('does not fall back to implicit keyword detection when an unknown plugin-prefixed $token is present', () => {
    const matches = detectKeywords('$oh-my-codex:maer-thinking 다시 설명해봐 keep going');
    assert.deepEqual(matches, []);
    const primary = detectPrimaryKeyword('$oh-my-codex:maer-thinking 다시 설명해봐 keep going');
    assert.equal(primary, null);
  });

  it('suppresses implicit detection when an unknown plugin-prefixed token is present with other keyword text', () => {
    const matches = detectKeywords('$oh-my-codex:unknown analyze this issue');
    assert.deepEqual(matches, []);
    assert.equal(detectPrimaryKeyword('$oh-my-codex:unknown analyze this issue'), null);
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

  it('maps explicit $analyze invocation to analyze skill', () => {
    const match = detectPrimaryKeyword('please run $analyze on this workflow');
    assert.ok(match);
    assert.equal(match.skill, 'analyze');
    assert.equal(match.keyword.toLowerCase(), '$analyze');
  });

  it('maps explicit $ultragoal invocation to ultragoal workflow skill', () => {
    const match = detectPrimaryKeyword('$ultragoal split this release into durable goals');
    assert.ok(match);
    assert.equal(match.skill, 'ultragoal');
    assert.equal(match.keyword.toLowerCase(), '$ultragoal');
  });

  it('maps explicit $best-practice-research invocation to the best-practice research wrapper', () => {
    const match = detectPrimaryKeyword('$best-practice-research find current official guidance for this API');
    assert.ok(match);
    assert.equal(match.skill, 'best-practice-research');
    assert.equal(match.keyword.toLowerCase(), '$best-practice-research');
  });

  it('maps intentful ultragoal prose without triggering artifact path mentions', () => {
    const intentful = detectPrimaryKeyword('please run ultragoal workflow for this launch');
    assert.ok(intentful);
    assert.equal(intentful.skill, 'ultragoal');

    const pathOnly = detectPrimaryKeyword('inspect .omx/ultragoal/goals.json');
    assert.notEqual(pathOnly?.skill, 'ultragoal');
  });

  it('maps bare and command-style autopilot invocations to autopilot', () => {
    for (const prompt of ['autopilot', 'run autopilot', 'autopilot this', 'autopilot mode']) {
      const match = detectPrimaryKeyword(prompt);
      assert.ok(match, `expected autopilot match for ${prompt}`);
      assert.equal(match.skill, 'autopilot');
      assert.equal(match.keyword.toLowerCase(), 'autopilot');
    }
  });

  it('does not trigger autopilot from management/debug prose mentions', () => {
    assert.equal(detectPrimaryKeyword('inspect autopilot state before continuing'), null);
    assert.equal(detectPrimaryKeyword('fix the autopilot bug in the detector'), null);
    assert.equal(detectPrimaryKeyword('why did autopilot fail?'), null);
    assert.equal(detectPrimaryKeyword('run autopilot tests'), null);
    assert.equal(detectPrimaryKeyword('run autopilot regression tests'), null);
    assert.equal(detectPrimaryKeyword('continue autopilot debugging'), null);
    assert.equal(detectPrimaryKeyword('start autopilot bug investigation'), null);
  });

  it('keeps higher-priority workflow keywords ahead of autopilot mentions', () => {
    const match = detectPrimaryKeyword('autopilot this after consensus plan');
    assert.ok(match);
    assert.equal(match.skill, 'ralplan');
  });

  it('maps code-review keyword variants to code-review skill', () => {
    const hyphen = detectPrimaryKeyword('run $code-review before merge');
    assert.ok(hyphen);
    assert.equal(hyphen.skill, 'code-review');
    assert.equal(hyphen.keyword.toLowerCase(), '$code-review');

    const spaced = detectPrimaryKeyword('please do a code review');
    assert.ok(spaced);
    assert.equal(spaced.skill, 'code-review');

    assert.equal(
      detectPrimaryKeyword('run $security-review before merge')?.skill,
      undefined,
    );
    assert.equal(
      detectPrimaryKeyword('please do a security review')?.skill,
      undefined,
    );
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

  it('does not trigger team keyword from filesystem/team-state path text', () => {
    const match = detectPrimaryKeyword('You have 1 new message(s). Read .omx/state/team/execute-plan/mailbox/worker-3.json, act now, reply with concrete progress, then continue assigned work or next feasible task.');
    assert.equal(match, null);
  });

  it('does not trigger team skill from incidental prose usage', () => {
    const match = detectPrimaryKeyword('the team reviewed the document and shared feedback');
    assert.equal(match, null);
  });

  it('does not trigger team from bare skill-name phrasing without $ invocation', () => {
    const match = detectPrimaryKeyword('please use team agents for this');
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

  it('does not trigger ralph from plain conversational mention', () => {
    const match = detectPrimaryKeyword('why does ralph keep blocking stop?');
    assert.equal(match, null);
  });

  it('still triggers ralph for explicit $ralph invocation', () => {
    const match = detectPrimaryKeyword('$ralph continue verification');
    assert.ok(match);
    assert.equal(match.skill, 'ralph');
    assert.equal(match.keyword.toLowerCase(), '$ralph');
  });

  it('prefers ralplan over ralph follow-up language when both implicit routes are present', () => {
    const match = detectPrimaryKeyword('keep going but do consensus plan first');

    assert.ok(match);
    assert.equal(match.skill, 'ralplan');
  });

  it('applies longest-match tie-breaker when priorities are equal', () => {
    const match = detectPrimaryKeyword('please run a deep interview for this');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'deep interview');
  });

  it('maps "deep interview" phrase to deep-interview skill', () => {
    const match = detectPrimaryKeyword('please run a deep interview before planning');

    assert.ok(match);
    assert.equal(match.skill, 'deep-interview');
    assert.equal(match.keyword.toLowerCase(), 'deep interview');
  });

  it('does not trigger deep-interview from cleanup or state-management mentions', () => {
    assert.equal(detectPrimaryKeyword('clear deep interview state before continuing'), null);
    assert.equal(detectPrimaryKeyword('cleanup stale deep-interview state after session clear'), null);
    assert.equal(detectPrimaryKeyword('remove the stale deep interview lock from .omx/state'), null);
  });

  it('does not trigger deep-interview from casual discussion mentions', () => {
    assert.equal(detectPrimaryKeyword('the deep interview report is useful context for the next plan'), null);
    assert.equal(detectPrimaryKeyword('we already did a deep interview and should not reactivate it'), null);
    assert.equal(detectPrimaryKeyword('this interview transcript says implementation is ready'), null);
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

  it('treats direct abort commands as cancel intent', () => {
    const match = detectPrimaryKeyword('abort now');

    assert.ok(match);
    assert.equal(match.skill, 'cancel');
    assert.equal(match.keyword.toLowerCase(), 'abort');
  });

  it('treats direct stop commands as cancel intent', () => {
    const match = detectPrimaryKeyword('stop now');

    assert.ok(match);
    assert.equal(match.skill, 'cancel');
    assert.equal(match.keyword.toLowerCase(), 'stop');
  });

  it('treats explicit slash stop commands as cancel intent', () => {
    const match = detectPrimaryKeyword('/stop');

    assert.ok(match);
    assert.equal(match.skill, 'cancel');
    assert.equal(match.keyword.toLowerCase(), 'stop');
  });

  it('treats comma-delimited slash stop commands as cancel intent', () => {
    for (const prompt of ['/stop, please', 'Please /stop, now']) {
      const match = detectPrimaryKeyword(prompt);

      assert.ok(match, `expected cancel match for ${prompt}`);
      assert.equal(match.skill, 'cancel');
      assert.equal(match.keyword.toLowerCase(), 'stop');
    }
  });

  it('does not trigger cancel from stop inside filenames or paths', () => {
    assert.equal(
      detectPrimaryKeyword('inspect .omx/context/stop-hook-invalid-json-handoff-20260629T210626Z.md'),
      null,
    );
    assert.equal(
      detectPrimaryKeyword('Please summarize /tmp/stop-hook-invalid-json-handoff-20260629T210626Z.md'),
      null,
    );
    assert.equal(detectPrimaryKeyword('inspect /stop.md'), null);
    assert.equal(detectPrimaryKeyword('inspect /abort.md'), null);
    assert.equal(detectPrimaryKeyword('inspect /stop:hook.md'), null);
  });

  it('does not trigger cancel from incidental stop/abort test-log prose', () => {
    assert.equal(detectPrimaryKeyword('FAIL should stop retrying after max attempts'), null);
    assert.equal(detectPrimaryKeyword('PASS request aborted when upstream returns 499'), null);
  });

  it('does not trigger ultrawork from incidental parallel test-log prose', () => {
    assert.equal(detectPrimaryKeyword('PASS runs assertions in parallel when sharding is enabled'), null);
    assert.equal(detectPrimaryKeyword('running 8 tests in parallel across 4 workers'), null);
  });

  it('normalizes the Korean keyboard typo for ulw to ultrawork only', () => {
    const match = detectPrimaryKeyword('ㅕㅣㅈ로 이 작업 처리해줘');

    assert.ok(match);
    assert.equal(match.skill, 'ultrawork');
    assert.equal(match.keyword, 'ulw');

    const explicitMatch = detectPrimaryKeyword('$ㅕㅣㅈ로 이 작업 처리해줘');
    assert.ok(explicitMatch);
    assert.equal(explicitMatch.skill, 'ultrawork');
    assert.equal(explicitMatch.keyword, '$ulw');

    assert.equal(detectPrimaryKeyword('ㅁㅔㅔ로 처리해줘'), null);
  });
});

describe('keyword input classification direct grammar', () => {
  it('classifies prompt-leading direct forms, aliases, priority, and block order', () => {
    const cases = [
      { text: '$ralplan implement this', skills: ['ralplan'], keywords: ['$ralplan'], priorities: [11] },
      { text: '\u00a0$RALPLAN implement this', skills: ['ralplan'], keywords: ['$RALPLAN'], priorities: [11] },
      { text: '- $team $ralph ship this', skills: ['team', 'ralph'], keywords: ['$team', '$ralph'], priorities: [8, 9] },
      { text: '12) $oh-my-codex:ralplan build this', skills: ['ralplan'], keywords: ['$oh-my-codex:ralplan'], priorities: [11] },
      { text: '$ulw $frontend-ui-ux build this', skills: ['ultrawork', 'design'], keywords: ['$ulw', '$frontend-ui-ux'], priorities: [10, 6] },
      { text: '$ralplan $unknown $ralplan $ralph ship this', skills: ['ralplan', 'ralph'], keywords: ['$ralplan', '$ralph'], priorities: [11, 9] },
      { text: '$ㅕㅣㅈ 병렬 작업', skills: ['ultrawork'], keywords: ['$ulw'], priorities: [10] },
      { text: 'use $ralplan plan this', skills: ['ralplan'], keywords: ['$ralplan'], priorities: [11] },
      { text: 'please use $ralplan plan this', skills: ['ralplan'], keywords: ['$ralplan'], priorities: [11] },
      { text: 'run $ralplan plan this', skills: ['ralplan'], keywords: ['$ralplan'], priorities: [11] },
      { text: '- use $ralplan plan this', skills: ['ralplan'], keywords: ['$ralplan'], priorities: [11] },
      { text: 'run $analyze', skills: ['analyze'], keywords: ['$analyze'], priorities: [7] },
      { text: 'run $code-review', skills: ['code-review'], keywords: ['$code-review'], priorities: [6] },
      { text: 'please use $code-review', skills: ['code-review'], keywords: ['$code-review'], priorities: [6] },
      { text: 'please run $team', skills: ['team'], keywords: ['$team'], priorities: [8] },
      { text: 'start $deep-interview', skills: ['deep-interview'], keywords: ['$deep-interview'], priorities: [8] },
      { text: 'enable $ultragoal', skills: ['ultragoal'], keywords: ['$ultragoal'], priorities: [10] },
      { text: 'launch $autopilot', skills: ['autopilot'], keywords: ['$autopilot'], priorities: [10] },
      { text: 'invoke $ralph', skills: ['ralph'], keywords: ['$ralph'], priorities: [9] },
      { text: 'activate $ultrawork', skills: ['ultrawork'], keywords: ['$ultrawork'], priorities: [10] },
      { text: 'resume $team', skills: ['team'], keywords: ['$team'], priorities: [8] },
      { text: 'continue $code-review', skills: ['code-review'], keywords: ['$code-review'], priorities: [6] },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.equal(classification.reservedInput, null, testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.skill), testCase.skills, testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.keyword), testCase.keywords, testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.priority), testCase.priorities, testCase.text);
    }
  });


  it('does not extend discourse negation beyond a comma-separated directive', () => {
    for (const text of [
      'No worries, use autopilot mode.',
      "I'm not sure, please use autopilot mode.",
    ] as const) {
      assert.deepEqual(classifyKeywordInput(text).matches.map((match) => match.skill), ['autopilot'], text);
    }

    for (const text of ['Do not use autopilot mode.', 'No autopilot mode.'] as const) {
      assert.deepEqual(classifyKeywordInput(text).matches, [], text);
    }
  });


  it('accepts every directive verb and polite prefix for every explicit token and alias', () => {
    const tokens = new Set([
      ...KEYWORD_TRIGGER_DEFINITIONS
        .filter((definition) => definition.keyword.startsWith('$'))
        .map((definition) => definition.keyword.slice(1)),
      ...EXPLICIT_SKILL_ALIASES.map((alias) => alias.source),
    ]);
    const directiveVerbs = ['use', 'run', 'start', 'enable', 'launch', 'invoke', 'activate', 'resume', 'continue'] as const;

    for (const token of tokens) {
      const definition = getExplicitSkillDefinition(token);
      assert.ok(definition, token);
      const tokenForms = [`$${token}`];
      if (/^[A-Za-z]/u.test(token)) tokenForms.push(`$oh-my-codex:${token}`);
      for (const tokenForm of tokenForms) {
        for (const directiveVerb of directiveVerbs) {
          for (const politePrefix of ['', 'please '] as const) {
            const text = `${politePrefix}${directiveVerb} ${tokenForm} now`;
            const classification = classifyKeywordInput(text);
            assert.deepEqual(classification.matches.map((match) => match.skill), [definition.skill], text);
            assert.deepEqual(classification.matches.map((match) => match.priority), [definition.priority], text);
            assert.deepEqual(classification.candidates[0]?.reasons, [], text);
          }
        }
      }
    }
  });

  it('keeps directive-looking documentation and non-leading prose inert', () => {
    for (const text of [
      'use $ralplan is the consensus-planning command',
      'please run $team is a workflow command',
      'use $ralplan is the workflow command for autopilot mode',
      'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.',
      'use $ralplan, $autopilot, and $team are workflow commands',
      'use $ralplan is the consensus-planning command; $team is its alias',
      'use $ralplan，$autopilot are workflow commands',
      'use $ralplan， $autopilot， and $team are workflow commands',
      'use $ralplan is the consensus-planning command; $team is also its alias',
      'use $ralplan is the consensus-planning command\nAutopilot mode is also its alias.',
      'use $ralplan is the workflow command; $team appears in the documentation.',
      'use $ralplan، $autopilot are workflow commands',
      '$ralplan، $autopilot are prohibited',
      '$ralplan,$autopilot are prohibited',
      'Autopilot mode، deep interview are prohibited.',
      'Autopilot mode،deep interview are prohibited.',
      'use $ralplan is the workflow command, e.g. use $autopilot in examples.',
      'use $ralplan is the workflow command; autopilot mode appears in the documentation.',
      '$ralplan、 $autopilot are prohibited',
      'Autopilot mode、 deep interview are prohibited.',
      'uſe $ralplan plan it',
      'pleaſe use $ralplan plan it',
      'Do not use deep interview but uſe autopilot mode.',
      'For instance： use autopilot mode.',
      'For instance， use autopilot mode.',
      'For instance، use autopilot mode.',
      'For instance、 use autopilot mode.',
      'use $ralplan is the workflow command; $autopilot is documented in the guide.',
      '$autopilot is described in the manual.',
      'The docs say use $ralplan plan this',
      'I think we should run $code-review before merge',
    ]) {
      assert.deepEqual(classifyKeywordInput(text).matches, [], text);
    }
  });

  it('contains nested predecessors, preserves first-block and reserved dominance', () => {
    const nested = classifyKeywordInput('"`x`\n$ralplan plan it');
    assert.deepEqual(nested.matches, []);
    assert.deepEqual(nested.candidates[0]?.reasons, ['not-leading-region']);

    const firstBlock = classifyKeywordInput('$ralplan plan it\n"x"\n$autopilot build it');
    assert.deepEqual(firstBlock.matches.map((match) => match.skill), ['ralplan']);
    assert.deepEqual(firstBlock.candidates[1]?.reasons, ['not-leading-region']);

    const reserved = classifyKeywordInput('/prompts:architect\n"x"\n$ralplan plan it');
    assert.equal(reserved.reservedInput, 'prompts');
    assert.deepEqual(reserved.matches, []);

    for (const text of [
      '/prompts:architect— use autopilot mode',
      '/prompts:architect， use autopilot mode',
    ]) {
      const classification = classifyKeywordInput(text);
      assert.equal(classification.reservedInput, 'prompts', text);
      assert.deepEqual(classification.matches, [], text);
    }

    const confusablePrompts = classifyKeywordInput('/promptſ:architect; use autopilot mode.');
    assert.equal(confusablePrompts.reservedInput, null);
    assert.deepEqual(confusablePrompts.matches.map((match) => match.skill), ['autopilot']);
  });

  it('tracks list fence closer identity and relative indentation', () => {
    const rootFence = classifyKeywordInput('- ```\n  sample\n```\n$ralplan plan it');
    assert.deepEqual(rootFence.matches, []);
    assert.ok(rootFence.candidates[0]?.reasons.includes('fenced-code'));

    const relativeCloser = classifyKeywordInput('- ```\n  sample\n    ```\n$ralplan plan it');
    assert.deepEqual(relativeCloser.matches.map((match) => match.skill), ['ralplan']);
  });

  it('binds B3 through B5 fence candidates exactly', () => {
    const cases = [
      {
        text: '```\n$ralph\n````\n$ralplan plan it',
        skills: ['ralplan'],
        candidates: [
          { rawKeyword: '$ralph', reasons: ['fenced-code', 'not-leading-region'] },
          { rawKeyword: '$ralplan', reasons: [] },
        ],
      },
      {
        text: '````\n$ralplan\n```\n$ralph ship it',
        skills: [],
        candidates: [
          { rawKeyword: '$ralplan', reasons: ['fenced-code', 'not-leading-region'] },
          { rawKeyword: '$ralph', reasons: ['fenced-code', 'not-leading-region'] },
        ],
      },
      {
        text: '```\n$ralplan\n~~~\n$ralph ship it',
        skills: [],
        candidates: [
          { rawKeyword: '$ralplan', reasons: ['fenced-code', 'not-leading-region'] },
          { rawKeyword: '$ralph', reasons: ['fenced-code', 'not-leading-region'] },
        ],
      },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.equal(classification.reservedInput, null, testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.skill), testCase.skills, testCase.text);
      assert.deepEqual(
        classification.candidates.map((candidate) => ({ rawKeyword: candidate.rawKeyword, reasons: candidate.reasons })),
        testCase.candidates,
        testCase.text,
      );
    }
  });

  it('masks multiline Markdown reference titles', () => {
    for (const text of [
      '[docs]: /target "title\nuse /prompts:architect\n$ralplan plan it"',
      '[docs]: /target "title\nuse autopilot mode"',
      '[docs]: ./target\n  (autopilot mode)',
      '[docs]:\n  ./target\n  (autopilot mode)',
      '[docs]: ./target\n(autopilot mode)',
    ]) {
      assert.deepEqual(classifyKeywordInput(text).matches, [], text);
    }

    const closedPromptsTitle = classifyKeywordInput('[docs]: /target "title\nUse /prompts:architect"\n$ralplan plan it');
    assert.deepEqual(closedPromptsTitle.matches.map((match) => match.skill), ['ralplan']);
  });

  it('fails closed for Unicode case-fold and confusable explicit-token continuations', () => {
    for (const testCase of [
      { text: '$ultraworK execute', rawKeyword: '$ultraworK' },
      { text: '$ralplan・suffix plan it', rawKeyword: '$ralplan・suffix' },
      { text: '$ralplan･suffix plan it', rawKeyword: '$ralplan･suffix' },
      { text: '$ralplan٪docs', rawKeyword: '$ralplan٪docs' },
      { text: '$ralplan∕config', rawKeyword: '$ralplan∕config' },
    ]) {
      const classification = classifyKeywordInput(testCase.text);
      assert.deepEqual(classification.matches, [], testCase.text);
      assert.equal(classification.candidates[0]?.rawKeyword, testCase.rawKeyword, testCase.text);
      assert.equal(classification.candidates[0]?.skill, null, testCase.text);
    }
  });

  it('composes V11 malformed-token, documentation, directive, and Arabic-clause controls', () => {
    for (const text of ["$ralplan's", '$ralplan’s', '$ralplan＇s']) {
      const classification = classifyKeywordInput(text);
      assert.equal(classification.hasExplicitLikeInvocation, true, text);
      assert.equal(classification.candidates[0]?.rawKeyword, text, text);
      assert.equal(classification.candidates[0]?.skill, null, text);
      assert.deepEqual(classification.matches, [], text);
    }

    const possessivePrompts = classifyKeywordInput("/prompts:architect's");
    assert.equal(possessivePrompts.reservedInput, null);
    assert.deepEqual(possessivePrompts.matches, []);

    for (const text of ['$・autopilot mode', '$･autopilot mode', '$٪autopilot mode', '$∕autopilot mode']) {
      const classification = classifyKeywordInput(text);
      assert.equal(classification.hasExplicitLikeInvocation, true, text);
      assert.equal(classification.candidates[0]?.skill, null, text);
      assert.deepEqual(classification.matches, [], text);
    }

    for (const testCase of [
      { text: 'use $autopilot is documented but use $ralplan plan it', skills: ['ralplan'] },
      { text: '- use $ralplan： consensus-planning workflow', skills: [] },
      { text: 'use $ralplan is the workflow command؟ run $autopilot', skills: ['autopilot'] },
      { text: '$ralplan؛ $autopilot is prohibited', skills: ['ralplan'] },
      { text: '$ralplan is prohibited but uſe autopilot mode.', skills: [] },
      { text: '$ralplan is prohibited but use autopilot mode.', skills: ['autopilot'] },
      { text: '[docs]: /target "title\nplain text"\n$ralplan plan it', skills: ['ralplan'] },
      { text: '[docs]: ./target\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'Do not run $ralplan; use the $autopilot build it', skills: ['autopilot'] },
      { text: '"quoted"\ncontinue with $ralplan', skills: ['ralplan'] },
      { text: 'use $ralplan is documented; advance to $ultragoal', skills: ['ultragoal'] },
    ] as const) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }
  });

  it('masks mixed postposed negation and documentary subject chains without reopening prose', () => {
    for (const text of [
      'Autopilot mode and $ralplan are prohibited.',
      'use $ralplan and autopilot mode are workflow commands',
      '$ralplan is prohibited because docs use $autopilot.',
    ]) {
      assert.deepEqual(classifyKeywordInput(text).matches, [], text);
    }

    assert.deepEqual(
      classifyKeywordInput('use $ralplan and autopilot mode are workflow commands; use $team execute it').matches.map((match) => match.skill),
      ['team'],
    );

    for (const punctuation of ['．', ';'] as const) {
      const text = `Do not run $ralplan${punctuation} use $autopilot build it`;
      assert.deepEqual(classifyKeywordInput(text).matches.map((match) => match.skill), ['autopilot'], text);
      assert.deepEqual(classifyKeywordInput(`Do not run $ralplan${punctuation}suffix`).matches, [], `${text} attached suffix`);
    }
  });

  it('classifies adversarial explicit candidate families without repeated tail scans', () => {
    const count = 4_096;
    const cases = [
      Array.from({ length: count }, () => '$team is prohibited').join('; '),
      `Do not run ${'$team '.repeat(count)}`,
      `Mode | Meaning\n--- | ---\n${Array.from({ length: count }, () => '$team | workflow documentation').join('\n')}`,
      `use ${Array.from({ length: count }, () => '$team').join(', ')} are workflow commands`,
    ] as const;

    for (const text of cases) {
      const classification = classifyKeywordInput(text);
      assert.equal(classification.candidates.length, count);
      assert.deepEqual(classification.matches, [], text.slice(0, 80));
    }
  });

  it('repairs V13 Unicode grammar, coordinated negation, documentation, and Markdown-table probes', () => {
    const cases = [
      { text: 'Do not use deep interview яbut use autopilot mode.', skills: [] },
      { text: 'Do not use deep interview but use autopilot mode.', skills: ['autopilot'] },
      { text: '$ralplan, autopilot mode, $team are prohibited.', skills: [] },
      { text: 'Autopilot mode and $ralplan are workflow commands; use $team execute it', skills: ['team'] },
      { text: 'Use autopilot mode; "note"; use $ralplan is the workflow command.', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command: use $autopilot build it', skills: ['autopilot'] },
      { text: 'Mode | Meaning\n--- | ---\nmanual | documentation\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'Do not run $ralplan but advance to $ultragoal', skills: ['ultragoal'] },
      { text: 'Do not run $ralplan but jump straight to $ultragoal', skills: ['ultragoal'] },
      { text: 'Do not run $ralplan яbut advance to $ultragoal', skills: [] },
      { text: 'use $ralplan is the workflow command яbut use $autopilot build it', skills: [] },
    ] as const;

    for (const testCase of cases) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }

    for (const separator of [', ', '，', '،', '、', ' / ', ' and '] as const) {
      const text = `Do not run $ralplan${separator}$autopilot; use $team execute it`;
      assert.deepEqual(classifyKeywordInput(text).matches.map((match) => match.skill), ['team'], text);
    }
  });

  it('keeps V13 coordinated scans near-linear at 4096 explicit candidates', () => {
    const count = 4_096;
    const families = [
      { text: '$team; '.repeat(count), skills: ['team'] },
      { text: `Do not run ${Array.from({ length: count }, () => '$team').join(', ')}`, skills: [] },
      { text: `${Array.from({ length: count }, () => '$team, autopilot mode').join(', ')} are prohibited`, skills: [] },
    ] as const;

    for (const family of families) {
      const startedAt = Date.now();
      const classification = classifyKeywordInput(family.text);
      assert.equal(classification.candidates.length, count, family.text.slice(0, 80));
      assert.deepEqual(classification.matches.map((match) => match.skill), family.skills, family.text.slice(0, 80));
      assert.ok(Date.now() - startedAt < 2_000, 'V13 coordinated scan must stay bounded');
    }
  });

  it('repairs V14 mixed subject chains and semicolon-local documentation', () => {
    const cases = [
      { text: 'Both autopilot mode and $ralplan are prohibited.', skills: [] },
      { text: 'Both autopilot mode and $ralplan are workflow commands; use $team execute it', skills: ['team'] },
      { text: 'Use autopilot mode; use $ralplan is the workflow command.', skills: ['autopilot'] },
    ] as const;

    for (const testCase of cases) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }

    const bareDollarPrefixes = classifyKeywordInput('$ $ $team');
    assert.equal(bareDollarPrefixes.candidates.length, 1);
    assert.equal(bareDollarPrefixes.candidates[0]?.rawKeyword, '$team');
    assert.equal(bareDollarPrefixes.candidates[0]?.skill, 'team');
    assert.deepEqual(bareDollarPrefixes.matches, []);
  });
  it('keeps V14 explicit scans bounded at 4096 candidates', () => {
    const count = 4_096;
    const families = [
      {
        name: 'bare-dollar prefixes before a canonical token',
        text: `${'$ '.repeat(count)}$team`,
        candidates: 1,
        skills: [],
      },
      {
        name: 'non-leading same-line canonical candidates',
        text: `ordinary prose ${'$team '.repeat(count)}`,
        candidates: count,
        skills: [],
      },
      {
        name: 'implicit-leading coordinated documentary candidates',
        text: `The docs mention autopilot mode, ${'$team, '.repeat(count)}are workflow commands`,
        candidates: count,
        skills: [],
      },
    ] as const;

    for (const family of families) {
      const startedAt = Date.now();
      const classification = classifyKeywordInput(family.text);
      assert.equal(classification.candidates.length, family.candidates, family.name);
      assert.deepEqual(classification.matches.map((match) => match.skill), family.skills, family.name);
      assert.ok(Date.now() - startedAt < 2_000, `${family.name} must stay bounded`);
    }
  });

  it('keeps V15 documentary chains, compact candidates, and repeated predicates bounded', () => {
    const count = 4_096;
    const implicitSubjects = Array.from({ length: count }, () => 'autopilot mode').join(', ');
    const compactCandidates = Array.from({ length: count }, () => '$team').join(',');
    const families = [
      {
        name: 'implicit-only documentary comma chain',
        text: `The docs mention ${implicitSubjects} are workflow commands`,
        candidates: 0,
        maximumMilliseconds: 2_000,
      },
      {
        name: 'compact documentary explicit comma chain',
        text: `${compactCandidates} are workflow commands`,
        candidates: count,
        maximumMilliseconds: 2_000,
      },
      {
        name: 'repeated postposed predicates',
        text: `${compactCandidates}${' are prohibited'.repeat(count)}`,
        candidates: count,
        maximumMilliseconds: 4_000,
      },
    ] as const;

    for (const family of families) {
      const startedAt = Date.now();
      const classification = classifyKeywordInput(family.text);
      assert.equal(classification.candidates.length, family.candidates, family.name);
      assert.deepEqual(classification.matches, [], family.name);
      assert.ok(Date.now() - startedAt < family.maximumMilliseconds, `${family.name} must stay bounded`);
    }

    const laterMixedDocumentaryChain = classifyKeywordInput(
      'The docs mention autopilot mode, deep interview; $team and autopilot mode are workflow commands',
    );
    assert.deepEqual(laterMixedDocumentaryChain.matches, []);
  });

  it('repairs V16 documentary clause, reference, and negation composition', () => {
    for (const testCase of [
      { text: 'Use autopilot mode, and $ralplan is documented in the guide.', skills: ['autopilot'] },
      { text: '[docs]: "target\n$autopilot build it', skills: [] },
      { text: '[docs]: `target\n$autopilot build it', skills: [] },
      { text: 'Do not run $ralplan and use autopilot mode.', skills: [] },
      { text: '$team is prohibited and is forbidden; use $ralplan plan it', skills: ['ralplan'] },
      { text: 'Use $ralplan, autopilot mode and $team are workflow commands.', skills: [] },
    ] as const) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }
  });

  it('keeps V16 documentary and implicit-negative families subquadratic through 8192 items', () => {
    const families = [
      {
        name: 'documentary followup chain',
        text: (count: number) => `Autopilot mode is documented, ${Array.from({ length: count }, () => '$team').join(', ')} are workflow commands`,
        candidates: (count: number) => count,
      },
      {
        name: 'implicit prefix negation',
        text: (count: number) => 'Do not use autopilot mode. '.repeat(count),
        candidates: () => 0,
      },
      {
        name: 'implicit postposed negation',
        text: (count: number) => 'Autopilot mode is prohibited. '.repeat(count),
        candidates: () => 0,
      },
    ] as const;

    for (const family of families) {
      const elapsed = new Map<number, bigint>();
      for (const count of [4_096, 8_192] as const) {
        const startedAt = process.hrtime.bigint();
        const classification = classifyKeywordInput(family.text(count));
        elapsed.set(count, process.hrtime.bigint() - startedAt);
        assert.equal(classification.candidates.length, family.candidates(count), `${family.name}: ${count}`);
        assert.deepEqual(classification.matches, [], `${family.name}: ${count}`);
        assert.deepEqual(classification.implicitMatches, [], `${family.name}: ${count}`);
      }
      assert.ok(
        (elapsed.get(8_192) ?? 0n) < (elapsed.get(4_096) ?? 0n) * 4n,
        `${family.name} must remain subquadratic when the input doubles`,
      );
    }
  });

  it('accepts only direct punctuation and list boundaries', () => {
    const cases = [
      { text: '* $ralph', skills: ['ralph'] },
      { text: '+ $team', skills: ['team'] },
      { text: '1. $ralplan', skills: ['ralplan'] },
      { text: '999) $ultrawork', skills: ['ultrawork'] },
      { text: '($ralplan)', skills: [] },
      { text: '[$ralplan]', skills: [] },
      { text: '1,$ralplan', skills: [] },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.skill), testCase.skills, testCase.text);
      if (testCase.skills.length === 0) {
        assert.deepEqual(classification.candidates[0]?.reasons, ['not-leading-region'], testCase.text);
      }
    }
  });

  it('lexes malformed maximal tokens without activating canonical prefixes', () => {
    for (const text of [
      '$ralplan- plan this',
      '$oh-my-codex:ralplan- plan this',
      '$ralplan_invalid plan this',
      '$ralplan@docs plan this',
      '$ralplan#docs plan this',
      '$ralplan=docs plan this',
      '$ralplan＠docs plan this',
      '$ralplan＃docs plan this',
      '$ralplan＝docs plan this',
    ]) {
      const classification = classifyKeywordInput(text);
      assert.deepEqual(classification.matches, [], text);
      assert.equal(classification.reservedInput, null, text);
      assert.equal(classification.hasExplicitLikeInvocation, true, text);
      assert.equal(classification.candidates.length, 1, text);
      assert.equal(classification.candidates[0]?.rawKeyword, text.split(' ')[0], text);
      assert.equal(classification.candidates[0]?.skill, null, text);
      assert.deepEqual(classification.candidates[0]?.reasons, [], text);
    }
  });

  it('scans maximal explicit tokens and rejects documentation, paths, Unicode, compatibility, and control suffixes', () => {
    const cases = [
      { text: '$ralplan.md is the workflow documentation file', rawKeyword: '$ralplan.md' },
      { text: '$autopilot/config', rawKeyword: '$autopilot/config' },
      { text: '$ralplan한글', rawKeyword: '$ralplan한글' },
      { text: '$oh-my-codex:ralplan.md', rawKeyword: '$oh-my-codex:ralplan.md' },
      { text: '$ralplan..md', rawKeyword: '$ralplan..md' },
      { text: '$ralplan‐suffix', rawKeyword: '$ralplan‐suffix' },
      { text: '$ralplan\u200B.md', rawKeyword: '$ralplan\u200B.md' },
      { text: '$ralplan／config', rawKeyword: '$ralplan／config' },
      { text: '$ralplan\u0000md', rawKeyword: '$ralplan\u0000md' },
      { text: '$ralplan\u202Emd', rawKeyword: '$ralplan\u202Emd' },
      { text: '$ralplan\uFEFF.md', rawKeyword: '$ralplan\uFEFF.md' },
      { text: '$ralplan．md', rawKeyword: '$ralplan．md' },
      { text: '$ralplan·suffix plan it', rawKeyword: '$ralplan·suffix' },
      { text: '$ralplan%docs', rawKeyword: '$ralplan%docs' },
      { text: '$ralplan％docs', rawKeyword: '$ralplan％docs' },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.deepEqual(classification.matches, [], testCase.text);
      assert.equal(classification.candidates.length, 1, testCase.text);
      assert.equal(classification.candidates[0]?.rawKeyword, testCase.rawKeyword, testCase.text);
      assert.equal(classification.candidates[0]?.skill, null, testCase.text);
      assert.deepEqual(classification.candidates[0]?.reasons, [], testCase.text);
    }

    for (const text of ['$ralplan, plan this', '$ralplan； plan this', '$ralplan\nplan this']) {
      assert.deepEqual(classifyKeywordInput(text).matches.map((match) => match.skill), ['ralplan'], text);
    }
  });

  it('accepts later directives after structurally separated inert or negative mentions', () => {
    const cases = [
      { text: 'Do not run $ralplan; instead $autopilot build issue #3140', skills: ['autopilot'] },
      { text: 'Do not run $ralplan, instead $autopilot build it', skills: ['autopilot'] },
      { text: 'Do not run $ralplan; use $autopilot build it', skills: ['autopilot'] },
      { text: 'Do not run $ralplan but use $autopilot build it', skills: ['autopilot'] },
      { text: 'Do not run $ralplan but instead use $autopilot build it', skills: ['autopilot'] },
      { text: 'Do not run $ralplan — instead use $autopilot build it', skills: ['autopilot'] },
      { text: 'Quoted inline-code `$ralplan`; use $autopilot build it', skills: ['autopilot'] },
      { text: 'Without $ralplan.\n$autopilot build it', skills: ['autopilot'] },
      { text: 'Quoted example: "$ralplan plan it".\n$autopilot build it', skills: ['autopilot'] },
      { text: '`$ralplan` is inert.\n$autopilot build it', skills: ['autopilot'] },
      { text: '"Use /prompts:architect"\n$ralplan plan it', skills: ['ralplan'] },
      { text: '> quoted context\n$ralplan plan it', skills: ['ralplan'] },
      { text: '```text\nquoted context\n```\n$ralplan plan it', skills: ['ralplan'] },
      { text: '    quoted context\n$ralplan plan it', skills: ['ralplan'] },
      { text: '"quoted context"\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'Use /prompts:architect.\n$ralplan plan it', skills: ['ralplan'] },
      { text: '- Use /prompts:architect.\n$ralplan plan it', skills: ['ralplan'] },
      { text: '- - ```\n    quoted context\n    ```\n$ralplan plan it', skills: ['ralplan'] },
      { text: '> quoted context\n$ralplan plan it\nLater discussion.\n$autopilot build it', skills: ['ralplan'] },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.skill), testCase.skills, testCase.text);
      assert.equal(classification.reservedInput, null, testCase.text);
    }

    for (const text of [
      'Do not run $ralplan and use $autopilot build it',
      'Do not run $ralplan; do not run $autopilot',
      'Do not run $ralplan, $autopilot',
      '"$ralplan" mentions $autopilot without a clause boundary',
      'Do not run $ralplan. We only document $autopilot behavior',
      '"$ralplan". The $autopilot workflow is documented',
      '```text\nquoted context\n$ralplan plan it',
      '```text\nquoted context\n~~~\n$ralplan plan it',
      '"quoted context\n$ralplan plan it',
      '> quoted context\nThe docs mention $ralplan only',
      '"quoted context"\nDo not run $ralplan',
      '> quoted context\nProse\n$ralplan implement this',
      '> quoted context\nProse\nUse $ralplan plan this',
      '> quoted context\n/prompts:architect\n$ralplan plan this',
      'Do not run $ralplan.\n"unclosed context\n$autopilot build it',
      '[$ralplan]: ./docs\n"unclosed context\n$autopilot build it',
      '"Use /prompts:architect\n$ralplan plan it',
      '/prompts:architect한글\n$ralplan plan it',
      '[docs]:\nautopilot',
    ]) {
      assert.deepEqual(classifyKeywordInput(text).matches, [], text);
    }
  });

  it('keeps prompt reservations and list documentation structural and composable', () => {
    const reserved = classifyKeywordInput('/prompts:architect analyze this issue');
    assert.equal(reserved.reservedInput, 'prompts');
    assert.deepEqual(reserved.matches, []);

    for (const text of [
      'Documentation mentions /prompts:architect and asks to analyze this issue',
      '"/prompts:architect" is quoted documentation',
      '- $ralplan is the consensus-planning command',
      '1. $autopilot refers to the autonomous workflow command',
      '- /prompts:architect is the prompt command documentation',
      '- $ralplan: consensus-planning workflow',
      '- $ralplan： consensus-planning workflow',
      '- $ralplan — consensus-planning command',
      '- $ralplan, $autopilot are workflow commands',
      '- $ralplan and $autopilot are workflow commands',
      '- $ralplan, $autopilot, and $team are workflow commands',
      '- $ralplan / $autopilot are workflow commands',
      '- $ralplan/$autopilot are workflow commands',
    ]) {
      const classification = classifyKeywordInput(text);
      assert.equal(classification.reservedInput, null, text);
      assert.deepEqual(classification.matches, [], text);
    }

    for (const testCase of [
      { text: '- $ralplan is the consensus-planning command\n$autopilot build it', skills: ['autopilot'] },
      { text: '- /prompts:architect is the prompt command documentation\n$ralplan plan it', skills: ['ralplan'] },
      { text: '- $ralplan, $autopilot are workflow commands\n$team execute it', skills: ['team'] },
      { text: '- $ralplan and $autopilot are workflow commands\n$team execute it', skills: ['team'] },
      { text: '- $ralplan, $autopilot, and $team are workflow commands\n$ralph execute it', skills: ['ralph'] },
      { text: '- $ralplan / $autopilot are workflow commands\n$team execute it', skills: ['team'] },
      { text: '- $ralplan/$autopilot are workflow commands\n$team execute it', skills: ['team'] },
      { text: 'use $ralplan is the consensus-planning command\n$autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command; $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command\nUse autopilot mode.', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command for planning\n$autopilot build it', skills: ['autopilot'] },
      { text: '- use $ralplan and $autopilot are workflow commands\n$team execute it', skills: ['team'] },
      { text: 'use $ralplan is the consensus-planning command; use $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command\nuse $autopilot is the autonomous workflow command\n$team execute it', skills: ['team'] },
      { text: 'use $ralplan is the workflow command for $team\n$autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command; use $autopilot update the documentation', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command; use autopilot mode.', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command; then use $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.\n$team execute it', skills: ['team'] },
      { text: 'use $ralplan/$autopilot are workflow commands\n$team execute it', skills: ['team'] },
      { text: 'use $ralplan is the consensus-planning command. Use autopilot mode.', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command; autopilot mode.', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command； use $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command; but use $autopilot build it', skills: ['autopilot'] },
      { text: '$ralplan; $autopilot is prohibited', skills: ['ralplan'] },
      { text: '$ralplan; $autopilot is documented in the guide.', skills: ['ralplan'] },
      { text: `use $ralplan is the workflow command;${' '.repeat(161)}use $autopilot build it`, skills: ['autopilot'] },
      { text: `$ralplan; $autopilot${' '.repeat(193)}is prohibited`, skills: ['ralplan'] },
      { text: 'For instance: manual mode is slower。 Use autopilot mode.', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command; autopilot mode is its alias; $team execute it', skills: ['team'] },
      { text: 'use $ralplan is the workflow command; autopilot mode is documented in the guide; $team execute it', skills: ['team'] },
      { text: 'use $ralplan is the workflow command; autopilot mode is workflow documentation; use $ralph execute it', skills: ['ralph'] },
      { text: `use $ralplan is the workflow command; use${' '.repeat(161)}$autopilot build it`, skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command! run $autopilot', skills: ['autopilot'] },
      { text: 'use $ralplan is the consensus-planning command？ run $autopilot', skills: ['autopilot'] },
      { text: 'Autopilot mode is workflow documentation.\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'use $ralplan is the workflow command, but use $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command， but use $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command، but use $autopilot build it', skills: ['autopilot'] },
      { text: 'use $ralplan is the workflow command、 but use $autopilot build it', skills: ['autopilot'] },
      { text: 'Do not run $ralplan، use $autopilot build it', skills: ['autopilot'] },
      { text: 'Do not run $ralplan、 use $autopilot build it', skills: ['autopilot'] },
      { text: 'The docs mention autopilot mode.\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'The docs mention autopilot mode; use $ralplan plan it', skills: ['ralplan'] },
      { text: 'Autopilot mode is workflow documentation; use $ralplan plan it', skills: ['ralplan'] },
      { text: '[docs]: $ralplan\n$autopilot build it', skills: ['autopilot'] },
      { text: '[docs]: /prompts:architect\n$autopilot build it', skills: ['autopilot'] },
    ] as const) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }

    assert.deepEqual(detectKeywords('- $ralplan plan this').map((match) => match.skill), ['ralplan']);
  });

  it('requires implicit workflow phrases to be active, unmasked, and non-negated', () => {
    for (const text of [
      'Do not use autopilot mode.',
      'Do not use deep interview, autopilot mode.',
      'Do not use deep interview, nor autopilot mode.',
      'Avoid autopilot mode.',
      'Neither deep interview nor autopilot mode.',
      'Autopilot mode is not allowed.',
      "Autopilot mode isn't allowed.",
      'Autopilot mode cannot be used.',
      'Autopilot mode is prohibited.',
      'No autopilot mode.',
      'The docs call this "autopilot mode".',
      '```\nautopilot mode\n```',
      '- ```\n  autopilot mode\n  ```',
      '- ```\n  first example\n- ```\n  autopilot mode\n  ```',
      'use /prompts:architect autopilot mode',
      '- autopilot mode is a workflow command',
      'The reference describes autopilot mode.',
      'This documents autopilot mode.',
      'The guide says do not use deep interview but instead use autopilot mode.',
      '[autopilot mode](./docs.md)',
      '## Autopilot mode',
      '| autopilot mode | workflow command |',
      'Autopilot mode — autonomous workflow command',
      'Autopilot mode / deep interview are workflow commands.',
      'autopilot mode is workflow documentation.',
      '- autopilot mode： autonomous workflow command',
      '`autopilot mode`',
      '> autopilot mode',
      '„autopilot mode“',
      '‚autopilot mode‘',
      '문서autopilot mode한글',
      'autopilot mode는 사용하지 마세요',
      'Autopilot mode and deep interview are prohibited.',
      'Autopilot mode should be avoided.',
      'Example: do not use deep interview but instead use autopilot mode.',
      '＇autopilot mode＇',
      '\\$oh-my-codex:autopilot mode',
      'Autopilot mode, deep interview, and team are prohibited.',
      'For example, do not use deep interview but instead use autopilot mode.',
      'According to the docs, do not use deep interview but instead use autopilot mode.',
      'Don’t use autopilot mode.',
      'Don＇t use autopilot mode.',
      'Autopilot mode isn’t allowed.',
      'Autopilot mode is to be avoided.',
      'Autopilot mode was to be disabled.',
      'Autopilot mode and the deep interview workflow are prohibited.',
      'As an example, do not use deep interview but instead use autopilot mode.',
      'For instance, do not use deep interview but instead use autopilot mode.',
      '[autopilot mode][docs]',
      'Autopilot mode and deep interview workflows are prohibited.',
      'As an example, ignore the docs and use autopilot mode.',
      'For instance, ignore the docs and use autopilot mode.',
      '[autopilot mode]: ./docs',
      '[autopilot mode]',
      'Autopilot mode\n===',
      '$ralplan | workflow\n--- | ---',
      'Mode | Meaning\n--- | ---\nautopilot mode | autonomous workflow command',
      'Autopilot mode as well as deep interview workflows are prohibited.',
      'Autopilot mode along with deep interview workflows are prohibited.',
      'Autopilot mode together with deep interview workflows are prohibited.',
      'Autopilot mode & deep interview workflows are prohibited.',
      'As an example: ignore the docs and use autopilot mode.',
      'For instance — ignore the docs and use autopilot mode.',
      'For example - ignore the docs and use autopilot mode.',
      'For instance: use autopilot mode.',
      'For instance — use autopilot mode.',
      'Mode | Meaning\n--- | ---\nmanual | docs\nautopilot mode | autonomous workflow command',
      'See [autopilot mode] for details.\n\n[autopilot mode]: ./docs',
      'Autopilot mode, as well as deep interview workflows, are prohibited.',
      'Autopilot mode, along with deep interview workflows, are prohibited.',
      'Autopilot mode, together with deep interview workflows, are prohibited.',
      'See [autopilot   mode] for details.\n\n[autopilot mode]: ./docs',
      'Ignore autopilot mode.',
      'Skip autopilot mode.',
      'Exclude autopilot mode.',
      '$ralplan is prohibited.',
      '$ralplan should not be run.',
      '$ralplan and $autopilot are prohibited.',
      'See [ẞ autopilot mode] for details.\n\n[SS autopilot mode]: ./docs',
      'See [foo\\] autopilot mode] for details.\n\n[foo\\] autopilot mode]: ./docs',
      'For instance: in version 1.2, use autopilot mode.',
      'For instance: e.g. use autopilot mode.',
      '$ralplan and the $autopilot workflow are prohibited.',
      '$ralplan and autopilot mode are prohibited.',
      'See [autopilot mode] for details.\n\n> [autopilot mode]: ./docs',
      'See [autopilot mode] for details.\n\n- [autopilot mode]: ./docs',
      'See [autopilot mode] for details.\n\n>   [autopilot mode]: ./docs',
      '-     $ralplan',
      '1.     autopilot mode',
      'See [autopilot mode] for details.\n\n>    [autopilot mode]: ./docs',
      'See [autopilot mode] for details.\n\n[autopilot mode]:\n  ./docs',
      '-   \t$ralplan',
      '- -     autopilot mode',
      '$ralplan is also prohibited.',
      'Autopilot mode is still prohibited.',
      '- > autopilot mode',
      '- - - - - - - - -     autopilot mode',
      '1234. > autopilot mode',
    ]) {
      const classification = classifyKeywordInput(text);
      assert.deepEqual(classification.matches, [], text);
      assert.deepEqual(classification.implicitMatches, [], text);
    }

    for (const testCase of [
      { text: 'Use autopilot mode.', skills: ['autopilot'] },
      { text: 'List files and use autopilot mode.', skills: ['autopilot'] },
      { text: "No, don't stop.", skills: ['ralph'] },
      { text: 'Do not use deep interview, but use autopilot mode.', skills: ['autopilot'] },
      { text: 'Do not use deep interview but use autopilot mode.', skills: ['autopilot'] },
      { text: 'Do not use deep interview but instead use autopilot mode.', skills: ['autopilot'] },
      { text: 'Do not use deep interview — instead use autopilot mode.', skills: ['autopilot'] },
      { text: 'Autopilot mode is workflow documentation.\nUse autopilot mode.', skills: ['autopilot'] },
      { text: 'Use /prompts:architect.\nUse autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore the quoted "/prompts:architect" and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore the quoted "/prompts:architect" then use autopilot mode.', skills: ['autopilot'] },
      { text: 'Do not run $ralplan but instead use autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore "$ralplan" and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore \\/prompts:architect and use autopilot mode.', skills: ['autopilot'] },
      { text: 'See https://example.com/prompts:architect and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Autopilot mode should be used.', skills: ['autopilot'] },
      { text: 'Autopilot mode must be enabled.', skills: ['autopilot'] },
      { text: 'Autopilot mode can be run.', skills: ['autopilot'] },
      { text: 'User＇s request: use autopilot mode.', skills: ['autopilot'] },
      { text: 'See [/prompts:architect](./docs.md) and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Use autopilot mode, while deep interview is prohibited.', skills: ['autopilot'] },
      { text: 'Read the docs. Use autopilot mode.', skills: ['autopilot'] },
      { text: 'The docs are stale; use autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore the docs, use autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore \\/prompts:architect\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'See https://example.com/prompts:architect\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'See [/prompts:architect](./docs.md)\n$ralplan plan it', skills: ['ralplan'] },
      { text: 'See [$ralplan](./docs.md) and use autopilot mode.', skills: ['autopilot'] },
      { text: 'See https://example.com/$ralplan and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Use autopilot mode, and deep interview is prohibited.', skills: ['autopilot'] },
      { text: 'Ignore the docs and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore \\/prompts:architect; use $ralplan plan it', skills: ['ralplan'] },
      { text: 'See https://example.com/prompts:architect; use $ralplan plan it', skills: ['ralplan'] },
      { text: 'See [/prompts:architect](./docs.md); use $ralplan plan it', skills: ['ralplan'] },
      { text: 'See [/prompts:architect][docs]; use $ralplan plan it', skills: ['ralplan'] },
      { text: '## /prompts:architect\n$ralplan plan it', skills: ['ralplan'] },
      { text: '| /prompts:architect |\n$ralplan plan it', skills: ['ralplan'] },
      { text: '## $ralplan\nUse autopilot mode.', skills: ['autopilot'] },
      { text: '| $ralplan |\nUse autopilot mode.', skills: ['autopilot'] },
      { text: 'See [$ralplan][docs] and use autopilot mode.', skills: ['autopilot'] },
      { text: 'See C:\\docs\\$ralplan and use autopilot mode.', skills: ['autopilot'] },
      { text: 'Users＇ request: use autopilot mode.', skills: ['autopilot'] },
      { text: 'Use autopilot mode, and deep interview should be avoided.', skills: ['autopilot'] },
      { text: 'Ignore the docs but use autopilot mode.', skills: ['autopilot'] },
      { text: '[/prompts:architect]: ./docs\n$ralplan plan it', skills: ['ralplan'] },
      { text: '[/prompts:architect]\n$ralplan plan it', skills: ['ralplan'] },
      { text: '[$ralplan]: ./docs\nUse autopilot mode.', skills: ['autopilot'] },
      { text: '[$ralplan]\nUse autopilot mode.', skills: ['autopilot'] },
      { text: '$ralplan\n===\nUse autopilot mode.', skills: ['autopilot'] },
      { text: '$ralplan | workflow\n--- | ---\nUse autopilot mode.', skills: ['autopilot'] },
      { text: '## $ralplan\n$autopilot build it', skills: ['autopilot'] },
      { text: 'See [$ralplan](./docs.md); use $autopilot build it', skills: ['autopilot'] },
      { text: 'See C:\\docs\\$ralplan; use $autopilot build it', skills: ['autopilot'] },
      { text: 'Mode | Meaning\n--- | ---\n$ralplan | planning\n$autopilot build it', skills: ['autopilot'] },
      { text: 'See [$ralplan] for details.\n\n[$ralplan]: ./docs\nUse autopilot mode.', skills: ['autopilot'] },
      { text: 'Ignore "$ralplan" and use $autopilot build it', skills: ['autopilot'] },
      { text: 'Ignore `$ralplan` and use $autopilot build it', skills: ['autopilot'] },
      { text: 'See [$ralplan   ] for details.\n\n[$ralplan]: ./docs\nUse autopilot mode.', skills: ['autopilot'] },
      { text: 'For instance: manual mode is slower. Use autopilot mode.', skills: ['autopilot'] },
      { text: 'See [`$ralplan`](./docs.md) and use $autopilot build it', skills: ['autopilot'] },
      { text: 'Ignore deep interview and use autopilot mode.', skills: ['autopilot'] },
      { text: 'See [docs](https://example.com/$ralplan) and use $autopilot build it', skills: ['autopilot'] },
      { text: 'See [docs](./docs.md "$ralplan reference") and use $autopilot build it', skills: ['autopilot'] },
      { text: 'See [docs](https://example.com/(v1)/$ralplan) and use $autopilot build it', skills: ['autopilot'] },
      { text: 'See [$ralplan](https://example.com/(v1)) and use $autopilot build it', skills: ['autopilot'] },
      { text: 'See [docs](./docs.md "$ralplan (reference") and use $autopilot build it', skills: ['autopilot'] },
      { text: 'See [autopilot mode] for details.\n\n>     [autopilot mode]: ./docs', skills: ['autopilot'] },
      { text: '-\t $ralplan', skills: ['ralplan'] },
      { text: '$ralplan is prohibited but use $autopilot build it', skills: ['autopilot'] },
      { text: '$ralplan is prohibited and use $autopilot build it', skills: ['autopilot'] },
      { text: '- - $ralplan plan it', skills: ['ralplan'] },
      { text: '1234. $ralplan plan it', skills: ['ralplan'] },
      { text: '- ```\n  $ralplan\n  ```\n$autopilot build it', skills: ['autopilot'] },
      { text: '- - $ralplan is the consensus-planning command\n$autopilot build it', skills: ['autopilot'] },
    ] as const) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }
  });

  it('defines punctuation-separated workflow directives as one ordered block', () => {
    assert.deepEqual(
      detectKeywords('$ralplan, $autopilot; $team build it').map((match) => match.skill),
      ['ralplan', 'autopilot', 'team'],
    );
    assert.deepEqual(
      detectKeywords('$ralplan plan it, then $team execute').map((match) => match.skill),
      ['ralplan'],
    );
  });

  it('fails closed for balanced and unbalanced quote pairs', () => {
    const quotePairs = [
      { name: 'ASCII double', opening: '"', closing: '"' },
      { name: 'ASCII single', opening: "'", closing: "'" },
      { name: 'curly double', opening: '“', closing: '”' },
      { name: 'curly single', opening: '‘', closing: '’' },
      { name: 'guillemets', opening: '«', closing: '»' },
      { name: 'Japanese corner', opening: '「', closing: '」' },
      { name: 'Japanese nested', opening: '『', closing: '』' },
      { name: 'fullwidth', opening: '＂', closing: '＂' },
      { name: 'fullwidth single', opening: '＇', closing: '＇' },
      { name: 'single guillemets', opening: '‹', closing: '›' },
    ] as const;

    for (const quotePair of quotePairs) {
      for (const closing of [quotePair.closing, ''] as const) {
        const text = `${quotePair.opening}$ralplan${closing}`;
        const classification = classifyKeywordInput(text);
        assert.deepEqual(classification.matches, [], `${quotePair.name}: ${JSON.stringify(text)}`);
        assert.deepEqual(
          classification.candidates[0]?.reasons,
          ['quote', 'not-leading-region'],
          `${quotePair.name}: ${JSON.stringify(text)}`,
        );
      }
    }
  });

  it('keeps fences and escape parity inert without semantic phrase matching', () => {
    const structuralCases = [
      { text: '```\n$ralplan\n```', reason: 'fenced-code' },
      { text: '~~~\n$ralplan\n~~~', reason: 'fenced-code' },
      { text: '```\n$ralplan', reason: 'fenced-code' },
      { text: '~~~\n$ralplan', reason: 'fenced-code' },
      { text: '    $ralplan plan this change', reason: 'indented-code' },
      { text: '\t$ralplan plan this change', reason: 'indented-code' },
      { text: ' \t$ralplan plan this change', reason: 'indented-code' },
      { text: '  \t$ralplan plan this change', reason: 'indented-code' },
      { text: '   \t$ralplan plan this change', reason: 'indented-code' },
    ] as const;
    for (const testCase of structuralCases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.deepEqual(classification.matches, [], testCase.text);
      assert.deepEqual(classification.candidates[0]?.reasons, [testCase.reason, 'not-leading-region'], testCase.text);
    }

    const escapeCases = [
      { text: '\\$ralplan', reasons: ['escaped', 'not-leading-region'] },
      { text: '\\\\$ralplan', reasons: ['not-leading-region'] },
      { text: '\\\\\\$ralplan', reasons: ['escaped', 'not-leading-region'] },
    ] as const;
    for (const testCase of escapeCases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.deepEqual(classification.matches, [], testCase.text);
      assert.deepEqual(classification.candidates[0]?.reasons, testCase.reasons, testCase.text);
    }
  });

  it('respects quote escape parity and fence container prefixes', () => {
    const escapedQuote = '"$ralplan \\"; $autopilot build it';
    const escapedQuoteClassification = classifyKeywordInput(escapedQuote);
    assert.deepEqual(escapedQuoteClassification.matches, []);
    assert.deepEqual(escapedQuoteClassification.candidates.map((candidate) => candidate.reasons), [
      ['quote', 'not-leading-region'],
      ['quote', 'not-leading-region'],
    ]);

    const evenBackslashQuote = '"$ralplan \\\\"; use $autopilot build it';
    assert.deepEqual(classifyKeywordInput(evenBackslashQuote).matches.map((match) => match.skill), ['autopilot']);

    const unquotedFence = '```\n$ralplan\n> ```\n$autopilot build it';
    assert.deepEqual(classifyKeywordInput(unquotedFence).matches, []);
    const unquotedFenceCandidates = classifyKeywordInput(unquotedFence).candidates;
    assert.ok(unquotedFenceCandidates.every((candidate) => candidate.reasons.includes('fenced-code')));

    const quotedFence = '> ```\n> $ralplan\n```\n> $autopilot build it';
    assert.deepEqual(classifyKeywordInput(quotedFence).matches, []);
    assert.ok(classifyKeywordInput(quotedFence).candidates.every((candidate) => candidate.reasons.length > 0));

    const matchingQuotedFence = '> ```\n> $ralplan\n> ```\n$autopilot build it';
    assert.deepEqual(classifyKeywordInput(matchingQuotedFence).matches.map((match) => match.skill), ['autopilot']);

    const nestedQuotedFence = '> > ```\n> > $ralplan\n> ```\n$autopilot build it';
    assert.deepEqual(classifyKeywordInput(nestedQuotedFence).matches, []);
  });

  it('requires valid fence closers and directive clause prefixes after inert mentions', () => {
    for (const text of [
      '```\n$ralplan\n``` still code\n$autopilot build it',
      '> ```\n> $ralplan\n> ``` still code\n> $autopilot build it',
    ]) {
      const classification = classifyKeywordInput(text);
      assert.deepEqual(classification.matches, [], text);
      assert.ok(classification.candidates.every((candidate) => candidate.reasons.length > 0), text);
    }

    for (const testCase of [
      { text: '"$ralplan"; now $autopilot build it', skills: ['autopilot'] },
      { text: '"$ralplan"; please use $autopilot build it', skills: ['autopilot'] },
      { text: '"$ralplan". We only document $autopilot behavior', skills: [] },
      { text: '"$ralplan". The $autopilot workflow is documented', skills: [] },
    ] as const) {
      assert.deepEqual(classifyKeywordInput(testCase.text).matches.map((match) => match.skill), testCase.skills, testCase.text);
    }
  });

  it('terminates fenced, inline, quote, and blockquote regions on every logical line ending', () => {
    const lineTerminators = ['\r', '\r\n', '\u2028', '\u2029'] as const;
    for (const lineTerminator of lineTerminators) {
      const label = JSON.stringify(lineTerminator);
      const fenced = classifyKeywordInput(`~~~${lineTerminator}$ralplan${lineTerminator}~~~`);
      assert.deepEqual(fenced.candidates[0]?.reasons, ['fenced-code', 'not-leading-region'], label);

      const blockquoted = classifyKeywordInput(`> $ralplan${lineTerminator}$team`);
      assert.deepEqual(blockquoted.candidates[0]?.reasons, ['blockquote', 'not-leading-region'], label);
      assert.deepEqual(blockquoted.candidates[1]?.reasons, [], label);
      assert.deepEqual(blockquoted.matches.map((match) => match.skill), ['team'], label);

      const inline = classifyKeywordInput(`\`$ralplan${lineTerminator}$team`);
      assert.deepEqual(inline.candidates[0]?.reasons, ['inline-code', 'not-leading-region'], label);
      assert.deepEqual(inline.candidates[1]?.reasons, [], label);
      assert.deepEqual(inline.matches.map((match) => match.skill), ['team'], label);

      const quoted = classifyKeywordInput(`"$ralplan${lineTerminator}$team`);
      assert.deepEqual(quoted.candidates[0]?.reasons, ['quote', 'not-leading-region'], label);
      assert.deepEqual(quoted.candidates[1]?.reasons, [], label);
      assert.deepEqual(quoted.matches.map((match) => match.skill), ['team'], label);
    }
  });

  it('keeps candidate diagnostics bounded across thousands of inert ranges', () => {
    const count = 4_096;
    const classification = classifyKeywordInput('`$ralplan` '.repeat(count).trimEnd());
    assert.equal(classification.candidates.length, count);
    assert.deepEqual(classification.candidates[0]?.reasons, ['inline-code', 'not-leading-region']);
    assert.deepEqual(classification.candidates.at(-1)?.reasons, ['inline-code', 'not-leading-region']);
    assert.deepEqual(classification.matches, []);
    const shortcuts = classifyKeywordInput('See [$ralplan] for details.\n'.repeat(count) + '\n[$ralplan]: ./docs');
    assert.equal(shortcuts.candidates.length, count + 1);
    assert.deepEqual(shortcuts.matches, []);
    const nestedParents = classifyKeywordInput('"`x`\n'.repeat(count) + '$ralplan plan it');
    assert.deepEqual(nestedParents.matches, []);
    const unclosedTitles = classifyKeywordInput('[docs]: /target (\n'.repeat(count) + '$ralplan plan it');
    assert.deepEqual(unclosedTitles.matches, []);
    const documentationTokens = classifyKeywordInput(`use $ralplan is the workflow command for ${'$team '.repeat(count)}`);
    assert.equal(documentationTokens.candidates.length, count + 1);
    assert.deepEqual(documentationTokens.matches, []);
    const semicolonDocumentation = classifyKeywordInput(`use $ralplan is the workflow command${'; explanatory note'.repeat(count)}`);
    assert.deepEqual(semicolonDocumentation.matches, []);
    const candidateTailDocumentation = classifyKeywordInput(`use $ralplan is the workflow command${'; $team is filler'.repeat(count)} documentation`);
    assert.equal(candidateTailDocumentation.candidates.length, count + 1);
    assert.deepEqual(candidateTailDocumentation.matches.map((match) => match.skill), ['team']);
    const periodDocumentationStart = Date.now();
    const periodDocumentation = classifyKeywordInput('Autopilot mode is documented. '.repeat(count) + 'use $ralplan plan it');
    assert.deepEqual(periodDocumentation.matches.map((match) => match.skill), ['ralplan']);
    assert.ok(Date.now() - periodDocumentationStart < 2_000, 'period-heavy documentation scan must stay bounded');
    const contiguousChainStart = Date.now();
    const contiguousChain = classifyKeywordInput('$ralplan '.repeat(count).trimEnd());
    assert.equal(contiguousChain.candidates.length, count);
    assert.deepEqual(contiguousChain.matches.map((match) => match.skill), ['ralplan']);
    assert.ok(Date.now() - contiguousChainStart < 2_000, 'contiguous explicit chains must stay bounded');

    const coordinatedNegationStart = Date.now();
    const coordinatedNegation = classifyKeywordInput(Array.from({ length: count }, () => '$team').join(',') + ' are prohibited');
    assert.equal(coordinatedNegation.candidates.length, count);
    assert.deepEqual(coordinatedNegation.matches, []);
    assert.ok(Date.now() - coordinatedNegationStart < 2_000, 'coordinated postposed negation must stay bounded');
  });

  it('suppresses prose, multilingual, documentation, quoted, escaped, and code candidates without a phrase classifier', () => {
    const cases = [
      'Do not run $autopilot',
      "don't use $autopilot",
      'without $ralplan',
      'Не запускай $autopilot',
      'Не используй $autopilot',
      '実行しないで $autopilot',
      '使わないで $autopilot',

      'Documentation example: $ralplan',
      '($ralplan) is an example',
      '"$autopilot" is an example',
      '`$ralph` is a literal',
      '```\n$team\n```',
      '    $ralplan plan this change',
      '\t$ralplan plan this change',
      '> $ultrawork is quoted',
      '\\$autopilot',
      'Prose\n$ralplan implement this',
      'Prose\n$ralplan\n$team',
    ] as const;

    for (const text of cases) {
      const classification = classifyKeywordInput(text);
      assert.deepEqual(classification.matches, [], text);
      assert.equal(classification.hasExplicitLikeInvocation, true, text);
      assert.ok(classification.candidates.every((candidate) => candidate.reasons.includes('not-leading-region')), text);
    }
  });

  it('applies marked-answer, accepted-direct, prompts, and explicit-like precedence in order', () => {
    const cases = [
      { text: '[omx question answered] $ralplan', reservedInput: 'omx-question-answered', skills: [] },
      { text: '$ralplan plan this; /prompts:architect review', reservedInput: null, skills: ['ralplan'] },
      { text: '$unknown /prompts:architect review', reservedInput: null, skills: [] },
      { text: '/prompts:architect, keep going', reservedInput: 'prompts', skills: [] },
      { text: '/prompts:unknown $ralplan plan this', reservedInput: 'prompts', skills: [] },
      { text: 'Prose\n/prompts:architect\n$ralplan plan this', reservedInput: null, skills: [] },
      { text: 'Do not run $autopilot', reservedInput: null, skills: [] },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.equal(classification.reservedInput, testCase.reservedInput, testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.skill), testCase.skills, testCase.text);
    }
  });

  it('binds G1 and G2 direct classification fields exactly', () => {
    const cases = [
      {
        text: '$ralplan, $autopilot; $team',
        reservedInput: null,
        skills: ['ralplan', 'autopilot', 'team'],
        candidates: [
          { rawKeyword: '$ralplan', reasons: [] },
          { rawKeyword: '$autopilot', reasons: [] },
          { rawKeyword: '$team', reasons: [] },
        ],
      },
      {
        text: '$ultrawork $ulw',
        reservedInput: null,
        skills: ['ultrawork'],
        candidates: [
          { rawKeyword: '$ultrawork', reasons: [] },
          { rawKeyword: '$ulw', reasons: [] },
        ],
      },
      {
        text: 'use $ralplan is the consensus-planning command',
        reservedInput: null,
        skills: [],
        candidates: [{ rawKeyword: '$ralplan', reasons: ['not-leading-region'] }],
      },
      {
        text: 'do not start $autopilot — café',
        reservedInput: null,
        skills: [],
        candidates: [{ rawKeyword: '$autopilot', reasons: ['not-leading-region'] }],
      },
    ] as const;

    for (const testCase of cases) {
      const classification = classifyKeywordInput(testCase.text);
      assert.equal(classification.reservedInput, testCase.reservedInput, testCase.text);
      assert.deepEqual(classification.matches.map((match) => match.skill), testCase.skills, testCase.text);
      assert.deepEqual(
        classification.candidates.map((candidate) => ({ rawKeyword: candidate.rawKeyword, reasons: candidate.reasons })),
        testCase.candidates,
        testCase.text,
      );
    }
  });

  it('deduplicates implicit aliases by skill without changing the stable winner', () => {
    const text = 'autopilot mode; build me a dashboard';
    const classification = classifyKeywordInput(text);
    assert.deepEqual(classification.implicitMatches, [
      { keyword: 'autopilot', skill: 'autopilot', priority: 10 },
    ]);
    assert.deepEqual(classification.matches, classification.implicitMatches);
    assert.deepEqual(detectKeywords(text), classification.implicitMatches);
  });

  it('freezes classifications and retains ordered inert diagnostics', () => {
    assert.equal(Object.isFrozen(KEYWORD_INERT_DIAGNOSTIC_ORDER), true);
    assert.deepEqual(KEYWORD_INERT_DIAGNOSTIC_ORDER, [
      'fenced-code',
      'indented-code',
      'blockquote',
      'inline-code',
      'quote',
      'escaped',
      'not-leading-region',
    ]);
    const classification = classifyKeywordInput('"\\$ralph and $team"');
    assert.equal(Object.isFrozen(classification), true);
    assert.equal(Object.isFrozen(classification.candidates), true);
    assert.equal(Object.isFrozen(classification.candidates[0]), true);
    assert.equal(Object.isFrozen(classification.candidates[0]?.reasons), true);
    assert.deepEqual(classification.candidates[0]?.reasons, ['quote', 'escaped', 'not-leading-region']);
    assert.deepEqual(classification.candidates[1]?.reasons, ['quote', 'not-leading-region']);

    const quotedFence = classifyKeywordInput('> ```\n> $ralph\n> ```');
    assert.deepEqual(quotedFence.candidates[0]?.reasons, ['fenced-code', 'blockquote', 'not-leading-region']);

    const blockquotedInline = classifyKeywordInput('> `$ralplan`\n$team');
    assert.deepEqual(blockquotedInline.candidates[0]?.reasons, ['blockquote', 'inline-code', 'not-leading-region']);
    assert.deepEqual(blockquotedInline.candidates[1]?.reasons, []);
    assert.deepEqual(blockquotedInline.matches.map((match) => match.skill), ['team']);
  });

  it('passes a supplied classification through recording, rejects mismatched text, and leaves rejected state bytes untouched', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-classification-state-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'session-classification-state';
    const sessionDir = join(stateDir, 'sessions', sessionId);
    const statePath = join(sessionDir, SKILL_ACTIVE_STATE_FILE);
    const detailPath = join(sessionDir, 'autopilot-state.json');
    const rawState = '{"version":1,"active":true,"skill":"autopilot","keyword":"$autopilot","phase":"deep-interview","activated_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}';
    const rawDetail = '{"active":true,"mode":"autopilot","current_phase":"deep-interview"}';
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(statePath, rawState);
      await writeFile(detailPath, rawDetail);
      const text = 'Do not run $autopilot';
      const classification = classifyKeywordInput(text);
      const result = await recordSkillActivation({ stateDir, sourceCwd: cwd, sessionId, text, classification });
      assert.equal(result, null);
      assert.equal(await readFile(statePath, 'utf-8'), rawState);
      assert.equal(await readFile(detailPath, 'utf-8'), rawDetail);
      assert.equal(existsSync(join(stateDir, SKILL_ACTIVE_STATE_FILE)), false);

      await assert.rejects(
        recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$ralph',
          classification,
        }),
        /classification text does not match activation text/,
      );
      assert.equal(await readFile(statePath, 'utf-8'), rawState);
      assert.equal(await readFile(detailPath, 'utf-8'), rawDetail);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not create or mutate tracked workflow state for ineligible explicit candidates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-ineligible-explicit-'));
    const stateDir = join(cwd, '.omx', 'state');
    const cases = [
      { name: 'no canonical state', text: '“$ralplan”', existingSkill: null },
      { name: 'active Ralplan same skill', text: 'without $ralplan', existingSkill: 'ralplan' },
      { name: 'active Autopilot same skill', text: "don't use $autopilot", existingSkill: 'autopilot' },
      { name: 'active Autopilot cross skill', text: 'without $ralplan', existingSkill: 'autopilot' },
    ] as const;
    try {
      for (const [index, testCase] of cases.entries()) {
        const sessionId = `ineligible-${index}`;
        const sessionDir = join(stateDir, 'sessions', sessionId);
        const statePath = join(sessionDir, SKILL_ACTIVE_STATE_FILE);
        const detailPath = join(sessionDir, 'autopilot-state.json');
        const rawState = testCase.existingSkill
          ? JSON.stringify({
              version: 1,
              active: true,
              skill: testCase.existingSkill,
              keyword: `$${testCase.existingSkill}`,
              phase: 'planning',
              session_id: sessionId,
              active_skills: [{ skill: testCase.existingSkill, phase: 'planning', active: true, session_id: sessionId }],
            })
          : null;
        const rawDetail = testCase.existingSkill === 'autopilot'
          ? '{"active":true,"mode":"autopilot","current_phase":"ralplan"}'
          : null;
        if (rawState) {
          await mkdir(sessionDir, { recursive: true });
          await writeFile(statePath, rawState);
        }
        if (rawDetail) await writeFile(detailPath, rawDetail);

        const classification = classifyKeywordInput(testCase.text);
        assert.equal(classification.hasExplicitLikeInvocation, true, testCase.name);
        const result = await recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          sessionId,
          text: testCase.text,
          classification,
        });
        assert.equal(result, null, testCase.name);
        assert.equal(existsSync(join(stateDir, SKILL_ACTIVE_STATE_FILE)), false, testCase.name);
        if (rawState) assert.equal(await readFile(statePath, 'utf-8'), rawState, testCase.name);
        else assert.equal(existsSync(statePath), false, testCase.name);
        if (rawDetail) assert.equal(await readFile(detailPath, 'utf-8'), rawDetail, testCase.name);
        else assert.equal(existsSync(detailPath), false, testCase.name);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('persists marked answers only for eligible active workflows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-marked-answer-'));
    const stateDir = join(cwd, '.omx', 'state');
    const cases = [
      { skill: 'autopilot', persists: true },
      { skill: 'ralplan', persists: false },
    ] as const;
    try {
      for (const [index, testCase] of cases.entries()) {
        const sessionId = `marked-answer-${index}`;
        const sessionDir = join(stateDir, 'sessions', sessionId);
        const statePath = join(sessionDir, SKILL_ACTIVE_STATE_FILE);
        const rawState = JSON.stringify({
          version: 1,
          active: true,
          skill: testCase.skill,
          keyword: `$${testCase.skill}`,
          phase: 'planning',
          activated_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          session_id: sessionId,
          active_skills: [{ skill: testCase.skill, phase: 'planning', active: true, session_id: sessionId }],
        });
        await mkdir(sessionDir, { recursive: true });
        await writeFile(statePath, rawState);

        const text = '[omx question answered] yes';
        const classification = classifyKeywordInput(text);
        assert.equal(classification.reservedInput, 'omx-question-answered');
        const result = await recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          sessionId,
          text,
          classification,
          nowIso: '2026-02-01T00:00:00.000Z',
        });
        if (testCase.persists) {
          assert.equal(result?.skill, 'autopilot');
          assert.notEqual(await readFile(statePath, 'utf-8'), rawState);
          assert.equal(existsSync(join(sessionDir, 'autopilot-state.json')), true);
        } else {
          assert.equal(result, null);
          assert.equal(await readFile(statePath, 'utf-8'), rawState);
          assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps terminal marked answers from restarting stale active workflows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-terminal-marked-answer-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'terminal-marked-answer';
    const sessionDir = join(stateDir, 'sessions', sessionId);
    const statePath = join(sessionDir, SKILL_ACTIVE_STATE_FILE);
    const detailPath = join(sessionDir, 'autopilot-state.json');
    const rawState = JSON.stringify({
      version: 1,
      active: true,
      skill: 'autopilot',
      keyword: '$autopilot',
      phase: 'completing',
      activated_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      session_id: sessionId,
      active_skills: [{ skill: 'autopilot', phase: 'completing', active: true, session_id: sessionId }],
    });
    const rawDetail = JSON.stringify({
      mode: 'autopilot',
      active: false,
      current_phase: 'complete',
      completed_at: '2026-01-01T00:00:00.000Z',
      session_id: sessionId,
    });
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(statePath, rawState);
      await writeFile(detailPath, rawDetail);
      const text = '[omx question answered] yes';
      const result = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        sessionId,
        text,
        classification: classifyKeywordInput(text),
      });
      assert.equal(result, null);
      assert.equal(await readFile(statePath, 'utf-8'), rawState);
      assert.equal(await readFile(detailPath, 'utf-8'), rawDetail);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('autoresearch keyword detection', () => {
  it('detects explicit $autoresearch invocation', () => {
    const match = detectPrimaryKeyword('please run $autoresearch now');
    assert.ok(match);
    assert.equal(match.skill, 'autoresearch');
    assert.equal(match.keyword.toLowerCase(), '$autoresearch');
  });

  it('does not detect bare autoresearch phrasing without explicit $ invocation', () => {
    const match = detectPrimaryKeyword('please use autoresearch workflow for this mission');
    assert.equal(match, null);
  });

  it('does not trigger autoresearch from incidental prose', () => {
    const match = detectPrimaryKeyword('Karpathy did autoresearch before native hooks existed');
    assert.equal(match, null);
  });
});

describe('explicit skill-name invocation requirement', () => {
  it('does not trigger analyze from bare skill-name usage', () => {
    assert.equal(detectPrimaryKeyword('please analyze this workflow'), null);
  });

  it('does not trigger autoresearch from bare skill-name usage', () => {
    assert.equal(detectPrimaryKeyword('please run autoresearch now'), null);
  });

  it('does not trigger ralph from bare skill-name usage', () => {
    assert.equal(detectPrimaryKeyword('please use ralph for this task'), null);
  });

  it('does not trigger ralplan from bare skill-name usage', () => {
    assert.equal(detectPrimaryKeyword('please do ralplan first'), null);
  });
  it('detects explicit prometheus-strict invocation only', () => {
    const match = detectPrimaryKeyword('please run $prometheus-strict before implementation');
    assert.ok(match);
    assert.equal(match.skill, 'prometheus-strict');
    assert.equal(match.keyword.toLowerCase(), '$prometheus-strict');
    assert.equal(detectPrimaryKeyword('please use prometheus-strict planning here'), null);
  });
});

describe('keyword registry coverage', () => {
  it('includes key team aliases in runtime keyword registry', () => {
    const registryKeywords = new Set(KEYWORD_TRIGGER_DEFINITIONS.map((v) => v.keyword.toLowerCase()));
    assert.ok(registryKeywords.has('$ultraqa'));
    assert.ok(registryKeywords.has('$analyze'));
    assert.ok(registryKeywords.has('investigate'));
    assert.ok(registryKeywords.has('code review'));
    assert.ok(registryKeywords.has('$code-review'));
    assert.ok(registryKeywords.has('$best-practice-research'));
    assert.ok(registryKeywords.has('coordinated team'));
    assert.ok(registryKeywords.has('ouroboros'));
    assert.ok(registryKeywords.has("don't assume"));
    assert.ok(registryKeywords.has('interview me'));
    assert.ok(registryKeywords.has('wiki query'));
    assert.ok(registryKeywords.has('wiki add'));
    assert.ok(registryKeywords.has('wiki lint'));
    assert.ok(registryKeywords.has('$autoresearch'));
    assert.ok(registryKeywords.has('$ultragoal'));
    assert.ok(registryKeywords.has('$prometheus-strict'));
    assert.ok(registryKeywords.has('ultragoal'));
    assert.ok(registryKeywords.has('autopilot'));
  });

  it('resolves immutable aliases without duplicate sources or skill collisions', () => {
    assert.equal(Object.isFrozen(EXPLICIT_SKILL_ALIASES), true);
    assert.equal(
      new Set(EXPLICIT_SKILL_ALIASES.map((alias) => alias.source.toLowerCase())).size,
      EXPLICIT_SKILL_ALIASES.length,
    );
    for (const alias of EXPLICIT_SKILL_ALIASES) {
      const target = getExplicitSkillDefinition(alias.target);
      const source = getExplicitSkillDefinition(alias.source.toUpperCase());
      assert.ok(target, alias.target);
      assert.deepEqual(source, target, alias.source);

      const canonicalSource = KEYWORD_TRIGGER_DEFINITIONS.find(
        (definition) => definition.keyword.toLowerCase() === `$${alias.source.toLowerCase()}`,
      );
      if (canonicalSource) assert.equal(canonicalSource.skill, target.skill, alias.source);
    }
  });
});

describe('keyword detector skill-active-state lifecycle', () => {
  it('co-locates direct boxed activation mode detail and canonical skill state for OMX_ROOT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-keyword-boxed-root-'));
    const sourceCwd = join(root, 'source');
    const omxRoot = join(root, 'box');
    const stateDir = join(omxRoot, '.omx', 'state');
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await mkdir(sourceCwd, { recursive: true });
      process.env.OMX_ROOT = omxRoot;
      delete process.env.OMX_STATE_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;

      const result = await recordSkillActivation({
        stateDir,
        sourceCwd,
        text: '$ralplan implement issue #1307',
        sessionId: 'sess-boxed-ralplan',
        threadId: 'thread-boxed',
        turnId: 'turn-boxed',
        nowIso: '2026-05-10T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralplan');
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-boxed-ralplan', SKILL_ACTIVE_STATE_FILE)),
        true,
      );
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-boxed-ralplan', 'ralplan-state.json')),
        true,
      );
      assert.equal(
        existsSync(join(sourceCwd, '.omx', 'state', 'sessions', 'sess-boxed-ralplan', SKILL_ACTIVE_STATE_FILE)),
        false,
      );
      assert.equal(
        existsSync(join(sourceCwd, '.omx', 'state', 'sessions', 'sess-boxed-ralplan', 'ralplan-state.json')),
        false,
      );
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('co-locates direct boxed activation mode detail and canonical skill state for OMX_STATE_ROOT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-keyword-boxed-state-root-'));
    const sourceCwd = join(root, 'source');
    const stateRoot = join(root, 'state-root');
    const stateDir = join(stateRoot, '.omx', 'state');
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await mkdir(sourceCwd, { recursive: true });
      delete process.env.OMX_ROOT;
      process.env.OMX_STATE_ROOT = stateRoot;
      delete process.env.OMX_TEAM_STATE_ROOT;

      const result = await recordSkillActivation({
        stateDir,
        sourceCwd,
        text: '$ralplan implement issue #1307',
        sessionId: 'sess-state-root-ralplan',
        threadId: 'thread-state-root',
        turnId: 'turn-state-root',
        nowIso: '2026-05-10T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralplan');
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-state-root-ralplan', SKILL_ACTIVE_STATE_FILE)),
        true,
      );
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-state-root-ralplan', 'ralplan-state.json')),
        true,
      );
      assert.equal(
        existsSync(join(sourceCwd, '.omx', 'state', 'sessions', 'sess-state-root-ralplan', SKILL_ACTIVE_STATE_FILE)),
        false,
      );
      assert.equal(
        existsSync(join(sourceCwd, '.omx', 'state', 'sessions', 'sess-state-root-ralplan', 'ralplan-state.json')),
        false,
      );
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes skill-active-state.json with deep-interview phase when autopilot keyword activates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-'));
    const stateDir = join(cwd, '.omx', 'state');
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-keyword-state-codex-home-'));
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: 'please run $autopilot and keep going',
        sessionId: 'sess-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'deep-interview');
      assert.equal(result.active, true);
      assert.deepEqual(result.active_skills, [{
        skill: 'autopilot',
        phase: 'deep-interview',
        active: true,
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        session_id: 'sess-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }]);
      assert.equal(result.initialized_mode, 'autopilot');
      assert.equal(result.initialized_state_path, '.omx/state/sessions/sess-1/autopilot-state.json');

      assert.equal(
        existsSync(join(stateDir, SKILL_ACTIVE_STATE_FILE)),
        false,
        'session-scoped non-Ralph activation should not create root canonical state when no root state exists',
      );

      const sessionScopedSkillState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-1', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }>; initialized_mode?: string };
      assert.deepEqual(sessionScopedSkillState.active_skills, result.active_skills);
      assert.equal(sessionScopedSkillState.initialized_mode, 'autopilot');

      const modeState = JSON.parse(await readFile(join(stateDir, 'sessions', 'sess-1', 'autopilot-state.json'), 'utf-8')) as {
        mode: string;
        active: boolean;
        current_phase: string;
        iteration: number;
        review_cycle: number;
        max_iterations: number;
        state: {
          phase_cycle: string[];
          deep_interview_gate: { status: string; skip_reason: string | null; rationale: string; };
          handoff_artifacts: Record<string, unknown>;
          review_verdict: unknown;
          qa_verdict: unknown;
          return_to_ralplan_reason: string | null;
          planning_routing: Record<string, unknown>;
        };
      };
      assert.equal(modeState.mode, 'autopilot');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'deep-interview');
      assert.equal(modeState.iteration, 1);
      assert.equal(modeState.review_cycle, 0);
      assert.equal(modeState.max_iterations, 10);
      assert.deepEqual(modeState.state.phase_cycle, ['deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa']);
      assert.deepEqual(modeState.state.deep_interview_gate, {
        status: 'required',
        skip_reason: null,
        rationale: 'Autopilot starts at the deep-interview gate by default; clear bounded tasks may skip only with an explicit persisted skip reason.',
      });
      assert.deepEqual(modeState.state.handoff_artifacts, {
        context_snapshot_path: '.omx/context/please-run-and-keep-going-20260225T000000Z.md',
        context_snapshot: {
          path: '.omx/context/please-run-and-keep-going-20260225T000000Z.md',
          kind: 'canonical',
          original_task_status: 'activation-prompt',
        },
        deep_interview: null,
        ralplan: null,
        ralplan_consensus_gate: {
          required: true,
          sequence: ['architect-review', 'critic-review'],
          planning_artifacts_are_not_consensus: true,
          required_review_roles: ['architect', 'critic'],
          ralplan_architect_review: null,
          ralplan_critic_review: null,
          complete: false,
        },
        ultragoal: null,
        code_review: null,
        ultraqa: null,
      });
      assert.equal(modeState.state.review_verdict, null);
      assert.equal(modeState.state.qa_verdict, null);
      assert.equal(modeState.state.return_to_ralplan_reason, null);
      assert.deepEqual(modeState.state.planning_routing, {
        owner: 'main',
        mainModel: 'gpt-5.6-sol',
        plannerModel: 'gpt-5.6-sol',
        reason: 'main_not_cheap_or_mini',
        explicitPlannerOverride: false,
      });
      const snapshot = await readFile(join(cwd, '.omx', 'context', 'please-run-and-keep-going-20260225T000000Z.md'), 'utf-8');
      assert.match(snapshot, /activation prompt \/ task seed: please run \$autopilot and keep going/);
      assert.match(snapshot, /scope note: this seed captures the Autopilot activation prompt/);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(cwd, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not advance the supervised child phase past an unsatisfied deep-interview gate via keyword handoff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-supervised-gate-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      // Activate Autopilot: seeds autopilot-state.json at current_phase=deep-interview
      // with deep_interview_gate.status="required" (gate not satisfied).
      const activated = await recordSkillActivation({
        stateDir,
        text: 'please run $autopilot',
        sessionId: 'sess-gate',
        threadId: 'thread-gate',
        turnId: 'turn-1',
        nowIso: '2026-02-25T00:00:00.000Z',
      });
      assert.equal(activated?.phase, 'deep-interview');

      const autopilotStatePath = join(stateDir, 'sessions', 'sess-gate', 'autopilot-state.json');
      const beforeAdvance = JSON.parse(await readFile(autopilotStatePath, 'utf-8')) as { current_phase: string };
      assert.equal(beforeAdvance.current_phase, 'deep-interview');

      // A bare `$ralplan` keyword handoff must not advance current_phase across the
      // deep-interview -> ralplan gate while the gate is unsatisfied. The keyword
      // path now defers to the same gate as the state_write backend.
      const denied = await recordSkillActivation({
        stateDir,
        text: 'continue with $ralplan',
        sessionId: 'sess-gate',
        threadId: 'thread-gate',
        turnId: 'turn-2',
        nowIso: '2026-02-25T00:01:00.000Z',
      });

      const afterAdvance = JSON.parse(await readFile(autopilotStatePath, 'utf-8')) as { current_phase: string };
      assert.equal(
        afterAdvance.current_phase,
        'deep-interview',
        'keyword handoff must not skip the deep-interview gate',
      );

      // The visible canonical skill-active state must stay aligned with the held
      // detail phase (no drift to ralplan) — both the returned state and the
      // persisted skill-active-state.json mirror.
      assert.equal(denied?.phase, 'deep-interview');
      assert.deepEqual(denied?.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'deep-interview']]);
      const canonical = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-gate', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { phase?: string; active_skills?: Array<{ skill?: string; phase?: string }> };
      assert.equal(canonical.phase, 'deep-interview');
      assert.deepEqual(canonical.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'deep-interview']]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not let a keyword jump ahead past a planning gate (forward skip)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-skip-ahead-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await recordSkillActivation({
        stateDir,
        text: 'please run $autopilot',
        sessionId: 'sess-skip',
        threadId: 'thread-skip',
        turnId: 'turn-1',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      // `$ultragoal` while in deep-interview skips the ralplan gate entirely; the
      // keyword handoff must hold the current phase rather than jump ahead.
      const result = await recordSkillActivation({
        stateDir,
        text: 'jump straight to $ultragoal',
        sessionId: 'sess-skip',
        threadId: 'thread-skip',
        turnId: 'turn-2',
        nowIso: '2026-02-25T00:01:00.000Z',
      });

      const autopilotState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-skip', 'autopilot-state.json'), 'utf-8'),
      ) as { current_phase: string };
      assert.equal(autopilotState.current_phase, 'deep-interview', 'forward skip must be held');
      // skill-active phase is kept in sync with the held autopilot phase.
      assert.equal(result?.phase, 'deep-interview');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not advance or drift canonical state past an unsatisfied ralplan -> ultragoal gate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-ralplan-gate-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-ralplan-gate';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      // Supervised Autopilot already in ralplan, with no ralplan consensus evidence
      // (the ralplan -> ultragoal gate is unsatisfied).
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ralplan',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'ralplan', active: true, session_id: sessionId }],
        }, null, 2),
      );
      const autopilotStatePath = join(stateDir, 'sessions', sessionId, 'autopilot-state.json');
      await writeFile(
        autopilotStatePath,
        JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ralplan', session_id: sessionId }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'ralplan-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralplan',
          current_phase: 'planning',
          session_id: sessionId,
        }, null, 2),
      );

      const denied = await recordSkillActivation({
        stateDir,
        text: 'advance to $ultragoal',
        sessionId,
        threadId: 'thread-ralplan-gate',
        turnId: 'turn-ralplan-gate',
        nowIso: '2026-02-25T00:01:00.000Z',
      });

      const afterAdvance = JSON.parse(await readFile(autopilotStatePath, 'utf-8')) as { current_phase: string };
      assert.equal(afterAdvance.current_phase, 'ralplan', 'keyword handoff must not skip the ralplan -> ultragoal gate');
      assert.equal(denied?.phase, 'ralplan');
      assert.deepEqual(denied?.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'ralplan']]);
      const ralplanState = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ralplan-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string };
      assert.equal(ralplanState.active, true, 'blocked gate must not auto-complete ralplan state');
      assert.equal(ralplanState.current_phase, 'planning', 'blocked gate must not advance ralplan state');
      const canonical = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { phase?: string; active_skills?: Array<{ skill?: string; phase?: string }> };
      assert.equal(canonical.phase, 'ralplan');
      assert.deepEqual(canonical.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'ralplan']]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not let an implementation-phase keyword skip the code-review gate to ultraqa', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-ultraqa-skip-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-ultraqa-skip';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      // Supervised Autopilot in an implementation phase (ultragoal). The completion
      // gate requires code-review before ultraqa.
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ultragoal',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: sessionId }],
        }, null, 2),
      );
      const autopilotStatePath = join(stateDir, 'sessions', sessionId, 'autopilot-state.json');
      await writeFile(
        autopilotStatePath,
        JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultragoal', session_id: sessionId }, null, 2),
      );

      const denied = await recordSkillActivation({
        stateDir,
        text: 'run $ultraqa now',
        sessionId,
        threadId: 'thread-ultraqa-skip',
        turnId: 'turn-ultraqa-skip',
        nowIso: '2026-02-25T00:01:00.000Z',
      });

      const afterAdvance = JSON.parse(await readFile(autopilotStatePath, 'utf-8')) as { current_phase: string };
      assert.equal(afterAdvance.current_phase, 'ultragoal', 'keyword handoff must not skip the code-review gate');
      assert.equal(denied?.phase, 'ultragoal');
      assert.deepEqual(denied?.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'ultragoal']]);
      const canonical = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { phase?: string; active_skills?: Array<{ skill?: string; phase?: string }> };
      assert.equal(canonical.phase, 'ultragoal');
      assert.deepEqual(canonical.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'ultragoal']]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('seeds dedicated planner routing in Autopilot state when main is cheap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-planner-routing-'));
    const stateDir = join(cwd, '.omx', 'state');
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-keyword-codex-home-'));
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        models: { autopilot: 'o4-mini' },
        agentModels: { planner: 'gpt-5.6-sol-planner' },
      }));

      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$autopilot implement issue #2918',
        sessionId: 'sess-planner-routing',
        threadId: 'thread-planner-routing',
        turnId: 'turn-planner-routing',
        nowIso: AUTOPILOT_TEST_NOW,
      });

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-planner-routing', 'autopilot-state.json'), 'utf-8'),
      ) as { state?: { planning_routing?: Record<string, unknown> } };
      assert.deepEqual(modeState.state?.planning_routing, {
        owner: 'planner',
        mainModel: 'o4-mini',
        plannerModel: 'gpt-5.6-sol-planner',
        reason: 'explicit_planner_override',
        explicitPlannerOverride: true,
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(cwd, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('migrates legacy Autopilot context snapshot paths into handoff artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-legacy-context-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-legacy-context';
    try {
      await writeActiveAutopilotSkillState(stateDir, sessionId, 'deep-interview');
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
        started_at: AUTOPILOT_TEST_STARTED_AT,
        context_snapshot_path: '.omx/context/legacy-task-20260529T000000Z.md',
        state: { handoff_artifacts: { deep_interview: null } },
      }, null, 2));
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'context', 'legacy-task-20260529T000000Z.md'), '# legacy task');

      await continueAutopilotTestState(stateDir, cwd, sessionId, 'legacy');

      const modeState = await readAutopilotModeState(stateDir, sessionId);
      assert.equal(modeState.state?.handoff_artifacts?.context_snapshot_path, '.omx/context/legacy-task-20260529T000000Z.md');
      assert.deepEqual(modeState.state?.handoff_artifacts?.context_snapshot, {
        path: '.omx/context/legacy-task-20260529T000000Z.md',
        kind: 'legacy',
        original_task_status: 'legacy-unverified',
      });
      assert.equal(existsSync(join(cwd, '.omx', 'context', 'continue-20260530T000000Z.md')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects unsafe legacy Autopilot context snapshot paths without writing outside .omx/context', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-unsafe-context-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-unsafe-context';
    try {
      await writeActiveAutopilotSkillState(stateDir, sessionId, 'deep-interview');
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
        started_at: AUTOPILOT_TEST_STARTED_AT,
        context_snapshot_path: '.omx/context/../../escape.md',
        state: { handoff_artifacts: { deep_interview: null } },
      }, null, 2));

      const result = await recordSkillActivation({
        stateDir,
        text: 'continue',
        sessionId,
        threadId: 'thread-unsafe',
        turnId: 'turn-unsafe',
        nowIso: '2026-05-30T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(existsSync(join(cwd, '.omx', 'escape.md')), false);
      const modeState = await readAutopilotModeState(stateDir, sessionId);
      assert.equal(modeState.context_snapshot_path, undefined);
      await assertAutopilotRecoverySnapshot(
        cwd,
        modeState,
        '.omx/context/autopilot-recovery-20260530T000000Z.md',
        'missing-or-unsafe-legacy-context-snapshot',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not snapshot bare continuation text when active Autopilot mode state is corrupt', async () => {
    const expectedReasons = {
      'missing-current-phase': 'nonpreservable-autopilot-mode-state-missing-current-phase',
      'malformed-json': 'malformed-autopilot-mode-state',
      'array-json': 'malformed-autopilot-mode-state',
    } as const;
    for (const fixture of ['missing-current-phase', 'malformed-json', 'array-json'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-keyword-autopilot-corrupt-continuation-${fixture}-`));
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = `sess-autopilot-corrupt-continuation-${fixture}`;
      try {
        await writeActiveAutopilotSkillState(stateDir, sessionId);
        const modeStatePath = join(stateDir, 'sessions', sessionId, 'autopilot-state.json');
        if (fixture === 'missing-current-phase') {
          await writeFile(modeStatePath, JSON.stringify({
            active: true,
            mode: 'autopilot',
            started_at: AUTOPILOT_TEST_STARTED_AT,
            state: { handoff_artifacts: {} },
          }, null, 2));
        } else if (fixture === 'malformed-json') {
          await writeFile(modeStatePath, '{ "active": true, "mode": "autopilot",');
        } else {
          await writeFile(modeStatePath, '[]');
        }

        await continueAutopilotTestState(stateDir, cwd, sessionId, fixture);

        assert.equal(existsSync(join(cwd, '.omx', 'context', 'continue-20260530T000000Z.md')), false);
        await assertAutopilotRecoverySnapshot(
          cwd,
          JSON.parse(await readFile(modeStatePath, 'utf-8')) as TestAutopilotModeState,
          /^\.omx\/context\/autopilot-recovery-20260530T000000Z(?:-\d+)?\.md$/,
          expectedReasons[fixture],
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects nested symlink Autopilot context snapshot candidates during reuse', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-nested-symlink-context-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-nested-symlink-outside-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-nested-symlink-context';
    try {
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await symlink(outside, join(cwd, '.omx', 'context', 'link'));
      await writeFile(join(outside, 'exfil.md'), '# outside context');
      await writeActiveAutopilotSkillState(stateDir, sessionId);
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ralplan',
        started_at: AUTOPILOT_TEST_STARTED_AT,
        state: { handoff_artifacts: { context_snapshot_path: '.omx/context/link/exfil.md' } },
      }, null, 2));

      await continueAutopilotTestState(stateDir, cwd, sessionId, 'nested-symlink');

      await assertAutopilotRecoverySnapshot(
        cwd,
        await readAutopilotModeState(stateDir, sessionId),
        '.omx/context/autopilot-recovery-20260530T000000Z.md',
        'missing-or-unsafe-legacy-context-snapshot',
      );
      assert.equal(existsSync(join(outside, 'exfil.md')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects typed canonical Autopilot recovery snapshot candidates during reuse', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-typed-recovery-context-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-typed-recovery-context';
    try {
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'context', 'autopilot-recovery-20260529T000000Z.md'), '# stale degraded recovery');
      await writeActiveAutopilotSkillState(stateDir, sessionId);
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ralplan',
        started_at: AUTOPILOT_TEST_STARTED_AT,
        state: {
          handoff_artifacts: {
            context_snapshot: {
              path: '.omx/context/autopilot-recovery-20260529T000000Z.md',
              kind: 'canonical',
            },
          },
        },
      }, null, 2));

      await continueAutopilotTestState(stateDir, cwd, sessionId, 'typed-recovery');

      await assertAutopilotRecoverySnapshot(
        cwd,
        await readAutopilotModeState(stateDir, sessionId),
        '.omx/context/autopilot-recovery-20260530T000000Z.md',
        'missing-or-unsafe-legacy-context-snapshot',
      );
      assert.equal(existsSync(join(cwd, '.omx', 'context', 'autopilot-recovery-20260529T000000Z.md')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects oversized Autopilot context snapshot candidates during reuse', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-oversized-context-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-oversized-context';
    try {
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'context', 'oversized-legacy-20260529T000000Z.md'), 'x'.repeat((1024 * 1024) + 1));
      await writeActiveAutopilotSkillState(stateDir, sessionId);
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ralplan',
        started_at: AUTOPILOT_TEST_STARTED_AT,
        state: {
          handoff_artifacts: {
            context_snapshot_path: '.omx/context/oversized-legacy-20260529T000000Z.md',
          },
        },
      }, null, 2));

      await continueAutopilotTestState(stateDir, cwd, sessionId, 'oversized-context');

      await assertAutopilotRecoverySnapshot(
        cwd,
        await readAutopilotModeState(stateDir, sessionId),
        '.omx/context/autopilot-recovery-20260530T000000Z.md',
        'missing-or-unsafe-legacy-context-snapshot',
      );
      assert.equal(existsSync(join(cwd, '.omx', 'context', 'oversized-legacy-20260529T000000Z.md')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not promote degraded recovery snapshots to canonical context on reactivation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-recovery-reactivation-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-recovery-reactivation';
    try {
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'context', 'autopilot-recovery-20260529T000000Z.md'), '# degraded recovery');
      await writeActiveAutopilotSkillState(stateDir, sessionId, 'complete');
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'complete',
        completed_at: AUTOPILOT_TEST_UPDATED_AT,
        state: {
          handoff_artifacts: {
            context_snapshot_path: '.omx/context/autopilot-recovery-20260529T000000Z.md',
            context_snapshot: {
              path: '.omx/context/autopilot-recovery-20260529T000000Z.md',
              kind: 'recovery',
              recovery: { status: 'degraded', reason: 'missing-or-unsafe-legacy-context-snapshot' },
            },
          },
          context_snapshot_recovery: { status: 'degraded', reason: 'missing-or-unsafe-legacy-context-snapshot' },
        },
      }, null, 2));

      await continueAutopilotTestState(stateDir, cwd, sessionId, 'recovery-reactivation', '$autopilot implement the real task');

      const modeState = await readAutopilotModeState(stateDir, sessionId);
      assert.equal(modeState.state?.handoff_artifacts?.context_snapshot_path, '.omx/context/implement-the-real-task-20260530T000000Z.md');
      assert.deepEqual(modeState.state?.handoff_artifacts?.context_snapshot, {
        path: '.omx/context/implement-the-real-task-20260530T000000Z.md',
        kind: 'canonical',
        original_task_status: 'activation-prompt',
      });
      assert.equal(modeState.state?.context_snapshot_recovery, undefined);
      const snapshot = await readFile(join(cwd, '.omx', 'context', 'implement-the-real-task-20260530T000000Z.md'), 'utf-8');
      assert.match(snapshot, /activation prompt \/ task seed: \$autopilot implement the real task/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not follow symlinked Autopilot context directories when writing snapshots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-symlink-context-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-symlink-outside-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await symlink(outside, join(cwd, '.omx', 'context'));
      await mkdir(stateDir, { recursive: true });

      const warnings: unknown[][] = [];
      mock.method(console, 'warn', (...args: unknown[]) => {
        warnings.push(args);
      });
      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$autopilot symlink escape',
        sessionId: 'sess-autopilot-symlink-context',
        threadId: 'thread-symlink-context',
        turnId: 'turn-symlink-context',
        nowIso: '2026-05-30T00:00:00.000Z',
      });

      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0][1]), /symbolic link/);
      assert.equal(existsSync(join(outside, 'symlink-escape-20260530T000000Z.md')), false);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-autopilot-symlink-context', 'autopilot-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('allocates unique Autopilot context snapshot paths for same-second matching slugs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-context-collision-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$autopilot same task',
        sessionId: 'sess-autopilot-collision-a',
        threadId: 'thread-collision',
        turnId: 'turn-collision-a',
        nowIso: '2026-05-30T00:00:00.000Z',
      });
      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$autopilot same task',
        sessionId: 'sess-autopilot-collision-b',
        threadId: 'thread-collision',
        turnId: 'turn-collision-b',
        nowIso: '2026-05-30T00:00:00.000Z',
      });

      const first = JSON.parse(await readFile(join(stateDir, 'sessions', 'sess-autopilot-collision-a', 'autopilot-state.json'), 'utf-8')) as {
        state?: { handoff_artifacts?: { context_snapshot_path?: string } };
      };
      const second = JSON.parse(await readFile(join(stateDir, 'sessions', 'sess-autopilot-collision-b', 'autopilot-state.json'), 'utf-8')) as {
        state?: { handoff_artifacts?: { context_snapshot_path?: string } };
      };
      assert.equal(first.state?.handoff_artifacts?.context_snapshot_path, '.omx/context/same-task-20260530T000000Z.md');
      assert.equal(second.state?.handoff_artifacts?.context_snapshot_path, '.omx/context/same-task-20260530T000000Z-2.md');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fully resets terminal Autopilot mode state when reactivated', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autopilot-terminal-reset-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-terminal-reset';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        keyword: '$autopilot',
        phase: 'complete',
        activated_at: '2026-05-29T00:00:00.000Z',
        updated_at: '2026-05-29T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', active: true, phase: 'complete', session_id: sessionId }],
      }, null, 2));
      await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'complete',
        started_at: '2026-05-29T00:00:00.000Z',
        completed_at: '2026-05-29T00:10:00.000Z',
        iteration: 10,
        max_iterations: 10,
        review_cycle: 3,
        lifecycle_outcome: 'finished',
        run_outcome: 'finish',
        handoff_artifacts: {
          code_review: { verdict: 'APPROVE / CLEAR' },
          ultraqa: { verdict: 'pass' },
        },
        state: {
          handoff_artifacts: {
            ralplan_consensus_gate: { complete: false },
            code_review: { verdict: 'stale' },
          },
        },
      }, null, 2));

      const result = await recordSkillActivation({
        stateDir,
        text: '$autopilot investigate the next issue',
        sessionId,
        threadId: 'thread-reactivated',
        turnId: 'turn-reactivated',
        nowIso: '2026-05-30T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'deep-interview');
      assert.equal(result.activated_at, '2026-05-30T00:00:00.000Z');
      assert.equal(result.active_skills?.[0]?.phase, 'deep-interview');
      assert.equal(result.active_skills?.[0]?.activated_at, '2026-05-30T00:00:00.000Z');
      const skillState = JSON.parse(await readFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), 'utf-8')) as {
        phase?: string;
        activated_at?: string;
        active_skills?: Array<{ phase?: string; activated_at?: string }>;
      };
      assert.equal(skillState.phase, 'deep-interview');
      assert.equal(skillState.activated_at, '2026-05-30T00:00:00.000Z');
      assert.equal(skillState.active_skills?.[0]?.phase, 'deep-interview');
      assert.equal(skillState.active_skills?.[0]?.activated_at, '2026-05-30T00:00:00.000Z');
      const modeState = JSON.parse(await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8')) as {
        active?: boolean;
        current_phase?: string;
        started_at?: string;
        completed_at?: string;
        iteration?: number;
        max_iterations?: number;
        review_cycle?: number;
        lifecycle_outcome?: string;
        run_outcome?: string;
        handoff_artifacts?: Record<string, unknown>;
        state?: { handoff_artifacts?: Record<string, unknown> };
      };
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'deep-interview');
      assert.equal(modeState.started_at, '2026-05-30T00:00:00.000Z');
      assert.equal(modeState.completed_at, undefined);
      assert.equal(modeState.iteration, 1);
      assert.equal(modeState.max_iterations, 10);
      assert.equal(modeState.review_cycle, 0);
      assert.equal(modeState.lifecycle_outcome, undefined);
      assert.equal(modeState.run_outcome, undefined);
      assert.equal(modeState.handoff_artifacts, undefined);
      assert.deepEqual(modeState.state?.handoff_artifacts, {
        context_snapshot_path: '.omx/context/investigate-the-next-issue-20260530T000000Z.md',
        context_snapshot: {
          path: '.omx/context/investigate-the-next-issue-20260530T000000Z.md',
          kind: 'canonical',
          original_task_status: 'activation-prompt',
        },
        deep_interview: null,
        ralplan: null,
        ralplan_consensus_gate: {
          required: true,
          sequence: ['architect-review', 'critic-review'],
          planning_artifacts_are_not_consensus: true,
          required_review_roles: ['architect', 'critic'],
          ralplan_architect_review: null,
          ralplan_critic_review: null,
          complete: false,
        },
        ultragoal: null,
        code_review: null,
        ultraqa: null,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('resets stopped Autopilot mode state when reactivated', async () => {
    for (const phase of ['stopped', 'user-stopped']) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-keyword-autopilot-${phase}-reset-`));
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = `sess-autopilot-${phase}-reset`;
      try {
        await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
        await writeFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase,
          activated_at: '2026-05-29T00:00:00.000Z',
          updated_at: '2026-05-29T00:00:00.000Z',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', active: true, phase, session_id: sessionId }],
        }, null, 2));
        await writeFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: phase,
          started_at: '2026-05-29T00:00:00.000Z',
          completed_at: '2026-05-29T00:10:00.000Z',
          iteration: 10,
          max_iterations: 10,
          review_cycle: 3,
          state: { handoff_artifacts: { code_review: { verdict: 'stale' } } },
        }, null, 2));

        const result = await recordSkillActivation({
          stateDir,
          text: '$autopilot new task after stop',
          sessionId,
          nowIso: '2026-05-30T00:00:00.000Z',
        });

        assert.ok(result);
        assert.equal(result.phase, 'deep-interview');
        assert.equal(result.activated_at, '2026-05-30T00:00:00.000Z');
        const modeState = JSON.parse(await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8')) as {
          current_phase?: string;
          iteration?: number;
          review_cycle?: number;
          state?: { handoff_artifacts?: { code_review?: unknown } };
        };
        assert.equal(modeState.current_phase, 'deep-interview');
        assert.equal(modeState.iteration, 1);
        assert.equal(modeState.review_cycle, 0);
        assert.equal(modeState.state?.handoff_artifacts?.code_review, null);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('adds approved workflow overlaps without deleting the existing canonical state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-overlap-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      await recordSkillActivation({
        stateDir,
        text: '$team ship this',
        sessionId: 'sess-overlap',
        threadId: 'thread-overlap',
        turnId: 'turn-1',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralph continue verification',
        sessionId: 'sess-overlap',
        threadId: 'thread-overlap',
        turnId: 'turn-2',
        nowIso: '2026-02-26T00:05:00.000Z',
      });

      assert.ok(result);
      assert.deepEqual(
        result.active_skills?.map((entry) => entry.skill),
        ['team', 'ralph'],
      );

      const persisted = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-overlap', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(
        persisted.active_skills?.map((entry) => entry.skill),
        ['team', 'ralph'],
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a session-scoped Ralph activation out of the root canonical state for other sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ralph-isolation-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralph continue verification',
        sessionId: 'sess-ralph-a',
        threadId: 'thread-ralph-a',
        turnId: 'turn-ralph-a',
        nowIso: '2026-04-14T00:00:00.000Z',
      });

      assert.ok(result);

      const rootSkillStatePath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
      assert.equal(
        existsSync(rootSkillStatePath),
        false,
        'session-scoped prompt activation should not create a root canonical skill state',
      );

      const sessionScopedSkillState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralph-a', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.deepEqual(sessionScopedSkillState.active_skills, [{
        skill: 'ralph',
        phase: 'planning',
        active: true,
        activated_at: '2026-04-14T00:00:00.000Z',
        updated_at: '2026-04-14T00:00:00.000Z',
        session_id: 'sess-ralph-a',
        thread_id: 'thread-ralph-a',
        turn_id: 'turn-ralph-a',
      }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('hard-fails denied workflow overlaps without mutating current state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deny-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      await recordSkillActivation({
        stateDir,
        text: '$team ship this',
        sessionId: 'sess-deny',
        threadId: 'thread-deny',
        turnId: 'turn-1',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      const denied = await recordSkillActivation({
        stateDir,
        text: '$autopilot do it too',
        sessionId: 'sess-deny',
        threadId: 'thread-deny',
        turnId: 'turn-2',
        nowIso: '2026-02-26T00:05:00.000Z',
      });

      assert.ok(denied?.transition_error);
      assert.match(String(denied?.transition_error), /Unsupported workflow overlap: team \+ autopilot\./);
      assert.match(String(denied?.transition_error), /`omx state clear --input '{"mode":"<mode>"}' --json`/);
      assert.match(String(denied?.transition_error), /explicit MCP compatibility is enabled/);

      const persisted = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-deny', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(persisted.active_skills?.map((entry) => entry.skill), ['team']);
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-deny', 'autopilot-state.json')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies prompt-submit overlaps against the current session-visible canonical state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-session-visible-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-visible'), { recursive: true });
      await writeFile(
        join(stateDir, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'team',
          active_skills: [
            { skill: 'team', phase: 'running', active: true },
          ],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-visible', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'team',
          session_id: 'sess-visible',
          active_skills: [
            { skill: 'team', phase: 'running', active: true },
            { skill: 'ralph', phase: 'executing', active: true, session_id: 'sess-visible' },
          ],
        }, null, 2),
      );

      const allowed = await recordSkillActivation({
        stateDir,
        text: '$ultrawork continue',
        sessionId: 'sess-visible',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(allowed?.transition_error, undefined);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-visible', 'ultrawork-state.json')), true);

      const persisted = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-visible', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(persisted.active_skills?.map((entry) => entry.skill), ['team', 'ralph', 'ultrawork']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('activates ultrawork mode from the Korean keyboard typo for ulw', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ulw-ko-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: 'ㅕㅣㅈ로 병렬 처리해줘',
        sessionId: 'sess-ulw-ko',
        threadId: 'thread-ulw-ko',
        turnId: 'turn-ulw-ko',
        nowIso: '2026-04-21T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ultrawork');
      assert.equal(result.keyword, 'ulw');
      assert.equal(result.initialized_mode, 'ultrawork');
      assert.equal(result.initialized_state_path, '.omx/state/sessions/sess-ulw-ko/ultrawork-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ulw-ko', 'ultrawork-state.json'), 'utf-8'),
      ) as { mode: string; active: boolean; current_phase: string };
      assert.equal(modeState.mode, 'ultrawork');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'planning');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('seeds executing state for autoresearch prompt-submit activation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autoresearch-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: '$autoresearch continue the mission',
        sessionId: 'sess-autoresearch',
        nowIso: '2026-04-17T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autoresearch');
      assert.equal(result.phase, 'executing');
      assert.equal(result.initialized_mode, 'autoresearch');
      assert.equal(result.initialized_state_path, '.omx/state/sessions/sess-autoresearch/autoresearch-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-autoresearch', 'autoresearch-state.json'), 'utf-8'),
      ) as { mode: string; active: boolean; current_phase: string };
      assert.equal(modeState.mode, 'autoresearch');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'executing');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves the planning skill when ralplan and autoresearch are invoked together', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-autoresearch-planning-precedence-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan $autoresearch wire the mission loop',
        sessionId: 'sess-autoresearch-precedence',
        nowIso: '2026-04-17T00:05:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.skill, 'ralplan');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralplan']);
      assert.deepEqual(result?.deferred_skills, ['autoresearch']);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-autoresearch-precedence', 'ralplan-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-autoresearch-precedence', 'autoresearch-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('captures tmux_pane_id in seeded ralplan prompt-submit state when TMUX_PANE is present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ralplan-pane-'));
    const stateDir = join(cwd, '.omx', 'state');
    const previousPane = process.env.TMUX_PANE;
    try {
      await mkdir(stateDir, { recursive: true });
      process.env.TMUX_PANE = '%88';
      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan tighten the plan',
        sessionId: 'sess-ralplan-pane',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralplan-pane', 'ralplan-state.json'), 'utf-8'),
      ) as { tmux_pane_id?: string };
      assert.equal(modeState.tmux_pane_id, '%88');
    } finally {
      if (typeof previousPane === 'string') process.env.TMUX_PANE = previousPane;
      else delete process.env.TMUX_PANE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('captures tmux_pane_id in deep-interview prompt-submit state when TMUX_PANE is present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-pane-'));
    const stateDir = join(cwd, '.omx', 'state');
    const previousPane = process.env.TMUX_PANE;
    try {
      await mkdir(stateDir, { recursive: true });
      process.env.TMUX_PANE = '%89';
      const result = await recordSkillActivation({
        stateDir,
        text: '$deep-interview tighten the requirements',
        sessionId: 'sess-deep-interview-pane',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-deep-interview-pane', 'deep-interview-state.json'), 'utf-8'),
      ) as { tmux_pane_id?: string };
      assert.equal(modeState.tmux_pane_id, '%89');
    } finally {
      if (typeof previousPane === 'string') process.env.TMUX_PANE = previousPane;
      else delete process.env.TMUX_PANE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves an existing deep-interview tmux_pane_id when prompt-submit re-seeds state without TMUX_PANE', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-preserve-pane-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-deep-interview-preserve-pane';
    const previousPane = process.env.TMUX_PANE;
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      delete process.env.TMUX_PANE;
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'deep-interview-state.json'),
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'intent-first',
          started_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:00:00.000Z',
          session_id: sessionId,
          tmux_pane_id: '%89',
          tmux_pane_set_at: '2026-02-25T00:00:00.000Z',
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$deep-interview tighten the requirements',
        sessionId,
        nowIso: '2026-02-25T00:05:00.000Z',
      });

      assert.ok(result);
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'deep-interview-state.json'), 'utf-8'),
      ) as { tmux_pane_id?: string; tmux_pane_set_at?: string };
      assert.equal(modeState.tmux_pane_id, '%89');
      assert.equal(modeState.tmux_pane_set_at, '2026-02-25T00:00:00.000Z');
    } finally {
      if (typeof previousPane === 'string') process.env.TMUX_PANE = previousPane;
      else delete process.env.TMUX_PANE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('seeds first-class state for ralplan prompt-submit activation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ralplan-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan tighten the plan',
        sessionId: 'sess-ralplan',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralplan');
      assert.equal(result.initialized_mode, 'ralplan');
      assert.equal(result.initialized_state_path, '.omx/state/sessions/sess-ralplan/ralplan-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralplan', 'ralplan-state.json'), 'utf-8'),
      ) as { mode: string; active: boolean; current_phase: string };
      assert.equal(modeState.mode, 'ralplan');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'planning');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('auto-completes deep-interview during allowlisted forward handoff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-handoff-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-handoff'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-handoff', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'deep-interview',
          phase: 'planning',
          session_id: 'sess-handoff',
          active_skills: [{ skill: 'deep-interview', phase: 'planning', active: true, session_id: 'sess-handoff' }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-handoff', 'deep-interview-state.json'),
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'intent-first',
          question_enforcement: {
            obligation_id: 'obligation-handoff',
            source: 'omx-question',
            status: 'pending',
            requested_at: '2026-04-09T23:59:00.000Z',
          },
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ultragoal turn the clarified spec into goals',
        sessionId: 'sess-handoff',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.skill, 'ultragoal');
      assert.equal(result?.initialized_mode, 'ultragoal');
      assert.equal(result?.initialized_state_path, '.omx/state/sessions/sess-handoff/ultragoal-state.json');
      assert.equal(result?.transition_message, 'mode transiting: deep-interview -> ultragoal');

      const completed = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-handoff', 'deep-interview-state.json'), 'utf-8'),
      ) as {
        active?: boolean;
        current_phase?: string;
        question_enforcement?: { status?: string; clear_reason?: string; cleared_at?: string };
      };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'completed');
      assert.equal(completed.question_enforcement?.status, 'cleared');
      assert.equal(completed.question_enforcement?.clear_reason, 'handoff');
      assert.ok(completed.question_enforcement?.cleared_at);
      const ultragoal = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-handoff', 'ultragoal-state.json'), 'utf-8'),
      ) as { active?: boolean; mode?: string; current_phase?: string };
      assert.equal(ultragoal.active, true);
      assert.equal(ultragoal.mode, 'ultragoal');
      assert.equal(ultragoal.current_phase, 'planning');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies ralplan handoff from deep-interview without completion or explicit skip evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-ralplan-handoff-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-ralplan-handoff'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralplan-handoff', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'deep-interview',
          phase: 'planning',
          session_id: 'sess-ralplan-handoff',
          active_skills: [{ skill: 'deep-interview', phase: 'planning', active: true, session_id: 'sess-ralplan-handoff' }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralplan-handoff', 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'intent-first' }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan implement the approved contract',
        sessionId: 'sess-ralplan-handoff',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.skill, 'deep-interview');
      assert.match(String(result?.transition_error), /missing deep-interview completion\/skip gate/i);
      const preserved = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralplan-handoff', 'deep-interview-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string };
      assert.equal(preserved.active, true);
      assert.equal(preserved.current_phase, 'intent-first');
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-ralplan-handoff', 'ralplan-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows ralplan handoff from deep-interview with a durable completion gate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-ralplan-handoff-complete-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-ralplan-handoff-complete'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralplan-handoff-complete', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'deep-interview',
          phase: 'planning',
          session_id: 'sess-ralplan-handoff-complete',
          active_skills: [{ skill: 'deep-interview', phase: 'planning', active: true, session_id: 'sess-ralplan-handoff-complete' }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralplan-handoff-complete', 'deep-interview-state.json'),
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'intent-first',
          deep_interview_gate: {
            status: 'complete',
            rationale: 'Requirements are clarified and ready for ralplan consensus.',
          },
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan implement the approved contract',
        sessionId: 'sess-ralplan-handoff-complete',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.skill, 'ralplan');
      assert.equal(result?.transition_message, 'mode transiting: deep-interview -> ralplan');
      const completed = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralplan-handoff-complete', 'deep-interview-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'completed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves the planning skill when planning and execution workflows are invoked together', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-planning-precedence-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan $team $ralph ship this fix',
        sessionId: 'sess-multi',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.transition_message, undefined);
      assert.equal(result?.skill, 'ralplan');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralplan']);
      assert.deepEqual(result?.deferred_skills, ['team', 'ralph']);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-multi', 'ralplan-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'team-state.json')), false);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-multi', 'ralph-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('lets planning win even when execution appears first in the contiguous skill block', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-planning-beats-execution-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralph $ralplan continue',
        sessionId: 'sess-priority',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.skill, 'ralplan');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralplan']);
      assert.deepEqual(result?.deferred_skills, ['ralph']);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-priority', 'ralplan-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-priority', 'ralph-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('seeds first-class root team state for team prompt-submit activation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: '$team coordinate the hotfix',
        sessionId: 'sess-team',
        nowIso: '2026-04-08T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'team');
      assert.equal(result.initialized_mode, 'team');
      assert.equal(result.initialized_state_path, '.omx/state/team-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'team-state.json'), 'utf-8'),
      ) as { mode: string; active: boolean; current_phase: string };
      assert.equal(modeState.mode, 'team');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'starting');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not activate team state when persisted Team mode is disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-disabled-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'project', teamMode: 'disabled' }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$team coordinate the hotfix',
        sessionId: 'sess-team-disabled',
        nowIso: '2026-04-08T00:00:00.000Z',
      });

      assert.equal(result, null);
      assert.equal(existsSync(join(stateDir, 'team-state.json')), false);
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-team-disabled', SKILL_ACTIVE_STATE_FILE)),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores disabled Team when selecting the primary workflow', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-disabled-primary-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'project', teamMode: 'disabled' }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$team $ralph ship this fix',
        sessionId: 'sess-team-disabled-primary',
        nowIso: '2026-04-10T01:00:00.000Z',
      });

      assert.equal(result?.skill, 'ralph');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralph']);
      assert.equal(existsSync(join(stateDir, 'team-state.json')), false);
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-team-disabled-primary', 'ralph-state.json')),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('filters deferred team handoffs when persisted Team mode is disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-disabled-deferred-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'setup-scope.json'),
        JSON.stringify({ scope: 'project', teamMode: 'disabled' }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan $team $ralph ship this fix',
        sessionId: 'sess-team-disabled-deferred',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.skill, 'ralplan');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralplan']);
      assert.deepEqual(result?.deferred_skills, ['ralph']);
      assert.equal(existsSync(join(stateDir, 'team-state.json')), false);
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-team-disabled-deferred', 'team-state.json')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves active team root state when $team is re-entered from prompt routing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-preserve-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          mode: 'team',
          current_phase: 'team-verify',
          started_at: '2026-04-08T00:00:00.000Z',
          updated_at: '2026-04-08T00:05:00.000Z',
          team_name: 'review-team',
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$team continue the review lane',
        sessionId: 'sess-team-preserve',
        nowIso: '2026-04-08T00:10:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.initialized_mode, 'team');
      assert.equal(result.initialized_state_path, '.omx/state/team-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'team-state.json'), 'utf-8'),
      ) as { mode: string; active: boolean; current_phase: string; team_name?: string };
      assert.equal(modeState.mode, 'team');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'team-verify');
      assert.equal(modeState.team_name, 'review-team');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves active team root state when planning follow-up defers a simultaneous $team re-entry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-planning-followup-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          mode: 'team',
          current_phase: 'team-verify',
          started_at: '2026-04-08T00:00:00.000Z',
          updated_at: '2026-04-08T00:05:00.000Z',
          team_name: 'review-team',
          session_id: 'sess-team-root',
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan $team tighten the approved execution handoff',
        sessionId: 'sess-team-followup',
        nowIso: '2026-04-10T00:15:00.000Z',
      });

      assert.ok(result);
      assert.equal(result?.skill, 'ralplan');
      assert.equal(result?.initialized_mode, 'ralplan');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralplan']);
      assert.deepEqual(result?.deferred_skills, ['team']);

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'team-state.json'), 'utf-8'),
      ) as { mode: string; active: boolean; current_phase: string; team_name?: string; session_id?: string };
      assert.equal(modeState.mode, 'team');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'team-verify');
      assert.equal(modeState.team_name, 'review-team');
      assert.equal(modeState.session_id, 'sess-team-root');
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-team-followup', 'team-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits terminal ralplan state before explicit ultragoal execution handoff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-ralplan-ultragoal-handoff-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-ralplan-ultragoal'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralplan-ultragoal', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralplan',
          keyword: '$ralplan',
          phase: 'planning',
          session_id: 'sess-ralplan-ultragoal',
          active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: 'sess-ralplan-ultragoal' }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralplan-ultragoal', 'ralplan-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralplan',
          current_phase: 'complete',
          planning_complete: true,
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', approved: true },
            ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', approved: true },
          },
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$ultragoal execute the approved ralplan',
        sessionId: 'sess-ralplan-ultragoal',
        nowIso: '2026-04-10T00:20:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.skill, 'ultragoal');
      assert.equal(result?.transition_message, 'mode transiting: ralplan -> ultragoal');
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ultragoal']);

      const ralplan = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralplan-ultragoal', 'ralplan-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string; completed_at?: string; auto_completed_reason?: string };
      assert.equal(ralplan.active, false);
      assert.equal(ralplan.current_phase, 'completed');
      assert.equal(ralplan.auto_completed_reason, 'mode transiting: ralplan -> ultragoal');
      assert.ok(ralplan.completed_at);

      const ultragoal = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralplan-ultragoal', 'ultragoal-state.json'), 'utf-8'),
      ) as { active?: boolean; mode?: string; current_phase?: string };
      assert.equal(ultragoal.active, true);
      assert.equal(ultragoal.mode, 'ultragoal');
      assert.equal(ultragoal.current_phase, 'planning');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps root team state out of the session-scoped Ralph canonical state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-team-ralph-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await recordSkillActivation({
        stateDir,
        text: '$team coordinate the rollout',
        sessionId: 'sess-team-ralph',
        nowIso: '2026-04-09T00:00:00.000Z',
      });

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralph complete the approved plan',
        sessionId: 'sess-team-ralph',
        nowIso: '2026-04-09T00:05:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralph');

      assert.equal(
        existsSync(join(stateDir, SKILL_ACTIVE_STATE_FILE)),
        false,
        'session-scoped team and Ralph activations should stay out of root canonical state when no root state exists',
      );

      const sessionCanonical = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-team-ralph', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        sessionCanonical.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [
          { skill: 'team', phase: 'planning', session_id: 'sess-team-ralph' },
          { skill: 'ralph', phase: 'planning', session_id: 'sess-team-ralph' },
        ],
      );
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

      const modeState = JSON.parse(await readFile(join(stateDir, DEEP_INTERVIEW_STATE_FILE), 'utf-8')) as {
        mode: string;
        active: boolean;
        current_phase: string;
        input_lock?: { active: boolean };
      };
      assert.equal(modeState.mode, 'deep-interview');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'intent-first');
      assert.equal(modeState.input_lock?.active, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('persists repo-local deep-interview config values into activation and mode state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-config-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "standard"
standardThreshold = 0.05
standardMaxRounds = 15
enableChallengeModes = false
`,
      );

      const result = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$deep-interview clarify runtime config',
        sessionId: 'sess-deep-interview-config',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'deep-interview');
      assert.equal(result.deep_interview_config?.profile, 'standard');
      assert.equal(result.deep_interview_config?.threshold, 0.05);
      assert.equal(result.deep_interview_config?.maxRounds, 15);
      assert.equal(result.initialized_state_path, '.omx/state/sessions/sess-deep-interview-config/deep-interview-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-deep-interview-config', DEEP_INTERVIEW_STATE_FILE), 'utf-8'),
      ) as {
        profile?: string;
        threshold?: number;
        max_rounds?: number;
        enable_challenge_modes?: boolean;
        config_source?: string;
        deep_interview_config?: { sourcePath?: string };
      };
      assert.equal(modeState.profile, 'standard');
      assert.equal(modeState.threshold, 0.05);
      assert.equal(modeState.max_rounds, 15);
      assert.equal(modeState.enable_challenge_modes, false);
      assert.equal(modeState.config_source, join(cwd, '.omx', 'config.toml'));
      assert.equal(modeState.deep_interview_config?.sourcePath, join(cwd, '.omx', 'config.toml'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('persists deep-interview config when mixed workflow prompts defer execution modes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-config-mixed-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-deep-interview-config-mixed';
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "deep"
deepThreshold = 0.13
deepMaxRounds = 21
enableChallengeModes = false
`,
      );

      const result = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$autopilot $deep-interview prove mixed workflow config',
        sessionId,
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'deep-interview');
      assert.deepEqual(result.deferred_skills, ['autopilot']);
      assert.equal(result.input_lock?.active, true);
      assert.equal(result.deep_interview_config?.profile, 'deep');
      assert.equal(result.deep_interview_config?.threshold, 0.13);
      assert.equal(result.deep_interview_config?.maxRounds, 21);
      assert.equal(result.deep_interview_config?.enableChallengeModes, false);

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, DEEP_INTERVIEW_STATE_FILE), 'utf-8'),
      ) as {
        profile?: string;
        threshold?: number;
        max_rounds?: number;
        enable_challenge_modes?: boolean;
        config_source?: string;
        deep_interview_config?: { profile?: string; threshold?: number; maxRounds?: number };
        input_lock?: { active?: boolean };
      };
      assert.equal(modeState.profile, 'deep');
      assert.equal(modeState.threshold, 0.13);
      assert.equal(modeState.max_rounds, 21);
      assert.equal(modeState.enable_challenge_modes, false);
      assert.equal(modeState.config_source, join(cwd, '.omx', 'config.toml'));
      assert.equal(modeState.deep_interview_config?.profile, 'deep');
      assert.equal(modeState.input_lock?.active, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shows before-after state change when deep-interview config is added at runtime', async () => {
    await withIsolatedHome('deep-interview-config-before-after', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-config-before-after-'));
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-deep-interview-config-before-after';
      const statePath = join(stateDir, 'sessions', sessionId, DEEP_INTERVIEW_STATE_FILE);
      try {
        await mkdir(join(cwd, '.omx'), { recursive: true });
        await mkdir(stateDir, { recursive: true });

        const before = await recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$deep-interview prove config before state',
          sessionId,
          nowIso: '2026-02-25T00:00:00.000Z',
        });
        const beforeModeState = JSON.parse(await readFile(statePath, 'utf-8')) as {
          deep_interview_config?: unknown;
          profile?: string;
          threshold?: number;
          max_rounds?: number;
          config_source?: string;
        };
        assert.ok(before);
        assert.equal(before.deep_interview_config, undefined);
        assert.equal(beforeModeState.deep_interview_config, undefined);
        assert.equal(beforeModeState.profile, undefined);
        assert.equal(beforeModeState.threshold, undefined);
        assert.equal(beforeModeState.max_rounds, undefined);
        assert.equal(beforeModeState.config_source, undefined);

        await writeFile(
          join(cwd, '.omx', 'config.toml'),
          `[omx.deepInterview]
defaultProfile = "standard"
standardThreshold = 0.05
standardMaxRounds = 15
`,
        );

        const after = await recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$deep-interview prove config after state',
          sessionId,
          nowIso: '2026-02-25T00:00:01.000Z',
        });
        const afterModeState = JSON.parse(await readFile(statePath, 'utf-8')) as {
          deep_interview_config?: { profile?: string; threshold?: number; maxRounds?: number; sourcePath?: string };
          profile?: string;
          threshold?: number;
          max_rounds?: number;
          config_source?: string;
        };
        assert.ok(after);
        assert.equal(after.deep_interview_config?.profile, 'standard');
        assert.equal(after.deep_interview_config?.threshold, 0.05);
        assert.equal(after.deep_interview_config?.maxRounds, 15);
        assert.equal(afterModeState.deep_interview_config?.profile, 'standard');
        assert.equal(afterModeState.profile, 'standard');
        assert.equal(afterModeState.threshold, 0.05);
        assert.equal(afterModeState.max_rounds, 15);
        assert.equal(afterModeState.config_source, join(cwd, '.omx', 'config.toml'));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('preserves deep-interview config values during continuation prompts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-config-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-deep-interview-config-continuation';
    const statePath = join(stateDir, 'sessions', sessionId, DEEP_INTERVIEW_STATE_FILE);
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "standard"
standardThreshold = 0.05
standardMaxRounds = 15
`,
      );

      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$deep-interview prove config continuation',
        sessionId,
        nowIso: '2026-02-25T00:00:00.000Z',
      });
      const continued = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: 'continue',
        sessionId,
        nowIso: '2026-02-25T00:00:01.000Z',
      });
      const modeState = JSON.parse(await readFile(statePath, 'utf-8')) as {
        deep_interview_config?: { profile?: string; threshold?: number; maxRounds?: number };
        profile?: string;
        threshold?: number;
        max_rounds?: number;
      };

      assert.equal(continued?.skill, 'deep-interview');
      assert.equal(continued?.deep_interview_config?.profile, 'standard');
      assert.equal(continued?.deep_interview_config?.threshold, 0.05);
      assert.equal(continued?.deep_interview_config?.maxRounds, 15);
      assert.equal(modeState.deep_interview_config?.profile, 'standard');
      assert.equal(modeState.profile, 'standard');
      assert.equal(modeState.threshold, 0.05);
      assert.equal(modeState.max_rounds, 15);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves explicit deep-interview profile flags during continuation prompts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-config-profile-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-deep-interview-config-profile-continuation';
    const statePath = join(stateDir, 'sessions', sessionId, DEEP_INTERVIEW_STATE_FILE);
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "standard"
standardThreshold = 0.22
standardMaxRounds = 13
deepThreshold = 0.13
deepMaxRounds = 21
`,
      );

      const started = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$deep-interview --deep prove explicit profile continuation',
        sessionId,
        nowIso: '2026-02-25T00:00:00.000Z',
      });
      const continued = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: 'continue',
        sessionId,
        nowIso: '2026-02-25T00:00:01.000Z',
      });
      const modeState = JSON.parse(await readFile(statePath, 'utf-8')) as {
        deep_interview_config?: { profile?: string; threshold?: number; maxRounds?: number };
        profile?: string;
        threshold?: number;
        max_rounds?: number;
      };

      assert.equal(started?.deep_interview_config?.profile, 'deep');
      assert.equal(continued?.deep_interview_config?.profile, 'deep');
      assert.equal(continued?.deep_interview_config?.threshold, 0.13);
      assert.equal(continued?.deep_interview_config?.maxRounds, 21);
      assert.equal(modeState.deep_interview_config?.profile, 'deep');
      assert.equal(modeState.profile, 'deep');
      assert.equal(modeState.threshold, 0.13);
      assert.equal(modeState.max_rounds, 21);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps the documented deep-interview Suggested Config executable through activation state', async () => {
    const skillDoc = await readFile(join(process.cwd(), 'skills', 'deep-interview', 'SKILL.md'), 'utf-8');
    const markerIndex = skillDoc.indexOf('## Suggested Config (optional)');
    assert.notEqual(markerIndex, -1);
    const configMatch = skillDoc.slice(markerIndex).match(/```toml\n([\s\S]*?)\n```/);
    assert.ok(configMatch);
    const documentedConfig = configMatch[1]?.trimEnd();
    assert.ok(documentedConfig);
    assert.match(documentedConfig, /standardThreshold = 0\.20/);
    assert.match(documentedConfig, /standardMaxRounds = 12/);

    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-doc-config-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-deep-interview-doc-config';
    const statePath = join(stateDir, 'sessions', sessionId, DEEP_INTERVIEW_STATE_FILE);
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(cwd, '.omx', 'config.toml'), `${documentedConfig}\n`);

      const result = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$deep-interview prove documented config runtime contract',
        sessionId,
        nowIso: '2026-02-25T00:00:00.000Z',
      });
      const modeState = JSON.parse(await readFile(statePath, 'utf-8')) as {
        deep_interview_config?: { profile?: string; threshold?: number; maxRounds?: number; sourcePath?: string };
        profile?: string;
        threshold?: number;
        max_rounds?: number;
        config_source?: string;
      };

      assert.ok(result);
      assert.equal(result.deep_interview_config?.profile, 'standard');
      assert.equal(result.deep_interview_config?.threshold, 0.2);
      assert.equal(result.deep_interview_config?.maxRounds, 12);
      assert.equal(modeState.deep_interview_config?.profile, 'standard');
      assert.equal(modeState.profile, 'standard');
      assert.equal(modeState.threshold, 0.2);
      assert.equal(modeState.max_rounds, 12);
      assert.equal(modeState.config_source, join(cwd, '.omx', 'config.toml'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps deep-interview activation alive when repo config TOML is malformed', async () => {
    await withIsolatedHome('deep-interview-malformed-config', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-malformed-config-'));
      const stateDir = join(cwd, '.omx', 'state');
      const originalWarn = console.warn;
      try {
        console.warn = () => {};
        await mkdir(join(cwd, '.omx'), { recursive: true });
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.deepInterview\nstandardThreshold = 0.05\n');

        const result = await recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$deep-interview clarify despite malformed config',
          sessionId: 'sess-deep-interview-malformed-config',
          nowIso: '2026-02-25T00:00:00.000Z',
        });

        assert.ok(result);
        assert.equal(result.skill, 'deep-interview');
        assert.equal(result.active, true);
        assert.equal(result.deep_interview_config, undefined);

        const modeState = JSON.parse(
          await readFile(join(stateDir, 'sessions', 'sess-deep-interview-malformed-config', DEEP_INTERVIEW_STATE_FILE), 'utf-8'),
        ) as {
          mode?: string;
          active?: boolean;
          deep_interview_config?: unknown;
        };
        assert.equal(modeState.mode, 'deep-interview');
        assert.equal(modeState.active, true);
        assert.equal(modeState.deep_interview_config, undefined);
      } finally {
        console.warn = originalWarn;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('creates the session-scoped deep-interview state directory before persisting mode state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-session-dir-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      await persistDeepInterviewModeState(
        stateDir,
        {
          version: 1,
          active: true,
          skill: 'deep-interview',
          keyword: 'deep interview',
          phase: 'ralplan',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:00:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-sync',
          input_lock: {
            active: true,
            scope: 'deep-interview-auto-approval',
            acquired_at: '2026-02-25T00:00:00.000Z',
            blocked_inputs: [...DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS],
            message: DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
          },
        },
        '2026-02-25T00:00:00.000Z',
        null,
        { sessionId: 'sess-sync' },
      );

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-sync', DEEP_INTERVIEW_STATE_FILE), 'utf-8'),
      ) as { active: boolean; mode: string };
      assert.equal(modeState.active, true);
      assert.equal(modeState.mode, 'deep-interview');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('clears stale pending deep-interview question enforcement when deep-interview is reactivated', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-deep-interview-reactivation-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-reactivate'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-reactivate', DEEP_INTERVIEW_STATE_FILE),
        JSON.stringify({
          active: false,
          mode: 'deep-interview',
          current_phase: 'completed',
          started_at: '2026-04-10T00:00:00.000Z',
          updated_at: '2026-04-10T00:10:00.000Z',
          completed_at: '2026-04-10T00:10:00.000Z',
          question_enforcement: {
            obligation_id: 'obligation-reactivate',
            source: 'omx-question',
            status: 'pending',
            requested_at: '2026-04-10T00:05:00.000Z',
          },
        }, null, 2),
      );

      await persistDeepInterviewModeState(
        stateDir,
        {
          version: 1,
          active: true,
          skill: 'deep-interview',
          keyword: 'deep interview',
          phase: 'planning',
          activated_at: '2026-04-10T00:11:00.000Z',
          updated_at: '2026-04-10T00:11:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-reactivate',
          input_lock: {
            active: true,
            scope: 'deep-interview-auto-approval',
            acquired_at: '2026-04-10T00:11:00.000Z',
            blocked_inputs: [...DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS],
            message: DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
          },
        },
        '2026-04-10T00:11:00.000Z',
        null,
        { sessionId: 'sess-reactivate' },
      );

      const reactivated = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-reactivate', DEEP_INTERVIEW_STATE_FILE), 'utf-8'),
      ) as {
        active?: boolean;
        question_enforcement?: { status?: string; clear_reason?: string; cleared_at?: string };
      };
      assert.equal(reactivated.active, true);
      assert.equal(reactivated.question_enforcement?.status, 'cleared');
      assert.equal(reactivated.question_enforcement?.clear_reason, 'handoff');
      assert.ok(reactivated.question_enforcement?.cleared_at);
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
        text: 'please run $deep-interview',
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

      const modeState = JSON.parse(await readFile(join(stateDir, DEEP_INTERVIEW_STATE_FILE), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
        input_lock?: { active: boolean; released_at?: string };
      };
      assert.equal(modeState.active, false);
      assert.equal(modeState.current_phase, 'completing');
      assert.equal(modeState.completed_at, '2026-02-25T00:05:00.000Z');
      assert.equal(modeState.input_lock?.active, false);
      assert.equal(modeState.input_lock?.released_at, '2026-02-25T00:05:00.000Z');
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

  it('does not seed non-stateful skill mode state on keyword activation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-non-stateful-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: 'please do a code review before merge',
      });

      assert.ok(result);
      assert.equal(result.skill, 'code-review');
      assert.equal(result.initialized_mode, undefined);
      assert.equal(result.initialized_state_path, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps Autopilot visible and advances HUD phase when a supervised code-review child keyword appears', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-child-code-review-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-child-code-review';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ultragoal',
          activated_at: '2026-05-30T00:00:00.000Z',
          updated_at: '2026-05-30T00:01:00.000Z',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: sessionId }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ultragoal',
          session_id: sessionId,
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'CODE REVIEW the current diff before continuing',
        sessionId,
        threadId: 'thread-autopilot-child-code-review',
        turnId: 'turn-autopilot-child-code-review',
        nowIso: '2026-05-30T00:02:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'code-review');
      assert.equal(result.supervised_child_skill, 'code-review');
      const persisted = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { skill?: string; phase?: string; active_skills?: Array<{ skill?: string; phase?: string }> };
      assert.equal(persisted.skill, 'autopilot');
      assert.equal(persisted.phase, 'code-review');
      assert.deepEqual(persisted.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'code-review']]);
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'code-review-state.json')), false);
      const autopilot = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8'),
      ) as { current_phase?: string; thread_id?: string; turn_id?: string };
      assert.equal(autopilot.current_phase, 'code-review');
      assert.equal(autopilot.thread_id, 'thread-autopilot-child-code-review');
      assert.equal(autopilot.turn_id, 'turn-autopilot-child-code-review');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('repairs stale inactive Autopilot detail when a supervised code-review child keyword appears', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-child-stale-detail-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-child-stale-detail';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ultragoal',
          activated_at: '2026-05-30T00:00:00.000Z',
          updated_at: '2026-05-30T00:01:00.000Z',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: sessionId }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'autopilot-state.json'),
        JSON.stringify({
          active: false,
          mode: 'autopilot',
          current_phase: 'ultragoal',
          started_at: '2026-05-30T00:00:00.000Z',
          updated_at: '2026-05-30T00:01:00.000Z',
          session_id: sessionId,
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$code-review inspect before QA',
        sessionId,
        threadId: 'thread-autopilot-child-stale-detail',
        turnId: 'turn-autopilot-child-stale-detail',
        nowIso: '2026-05-30T00:02:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'code-review');
      assert.equal(result.supervised_child_skill, 'code-review');
      assert.equal(result.transition_error, undefined);
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'code-review-state.json')), false);

      const persisted = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { skill?: string; phase?: string; active_skills?: Array<{ skill?: string; phase?: string }> };
      assert.equal(persisted.skill, 'autopilot');
      assert.equal(persisted.phase, 'code-review');
      assert.deepEqual(persisted.active_skills?.map((entry) => [entry.skill, entry.phase]), [['autopilot', 'code-review']]);

      const autopilot = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8'),
      ) as { active?: boolean; mode?: string; current_phase?: string; thread_id?: string; turn_id?: string };
      assert.equal(autopilot.active, true);
      assert.equal(autopilot.mode, 'autopilot');
      assert.equal(autopilot.current_phase, 'code-review');
      assert.equal(autopilot.thread_id, 'thread-autopilot-child-stale-detail');
      assert.equal(autopilot.turn_id, 'turn-autopilot-child-stale-detail');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps tracked Autopilot child keywords supervised and completes stale child mode state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-child-ultraqa-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-child-ultraqa';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ultraqa',
          activated_at: '2026-05-30T00:00:00.000Z',
          updated_at: '2026-05-30T00:01:00.000Z',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'ultraqa', active: true, session_id: sessionId }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'ultragoal-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ultragoal',
          current_phase: 'planning',
          session_id: sessionId,
          started_at: '2026-05-29T23:00:00.000Z',
          updated_at: '2026-05-29T23:05:00.000Z',
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ultraqa run adversarial checks',
        sessionId,
        threadId: 'thread-autopilot-child-ultraqa',
        turnId: 'turn-autopilot-child-ultraqa',
        nowIso: '2026-05-30T00:02:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'ultraqa');
      assert.equal(result.supervised_child_skill, 'ultraqa');
      assert.equal(result.transition_error, undefined);
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'ultraqa-state.json')), false);
      const ultragoal = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ultragoal-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string; auto_completed_reason?: string };
      assert.equal(ultragoal.active, false);
      assert.equal(ultragoal.current_phase, 'completed');
      assert.match(ultragoal.auto_completed_reason || '', /mode transiting: ultragoal -> ultraqa/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies supervised Autopilot child rollback without clearing stale execution state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-child-rollback-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-child-rollback';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ultragoal',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: sessionId }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'ultragoal-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ultragoal',
          current_phase: 'executing',
          session_id: sessionId,
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ultragoal',
          session_id: sessionId,
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$deep-interview go back and re-plan',
        sessionId,
        nowIso: '2026-05-30T00:03:00.000Z',
      });

      assert.equal(result?.skill, 'autopilot');
      assert.match(String(result?.transition_error), /Execution-to-planning rollback auto-complete is not allowed/i);
      assert.equal(result?.supervised_child_skill, undefined);
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'deep-interview-state.json')), false);
      const ultragoal = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ultragoal-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string };
      assert.equal(ultragoal.active, true);
      assert.equal(ultragoal.current_phase, 'executing');
      const autopilot = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8'),
      ) as { current_phase?: string };
      assert.equal(autopilot.current_phase, 'ultragoal');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces supervised Autopilot deep-interview to ralplan gate failures', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-child-gate-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-child-gate';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'deep-interview',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'deep-interview-state.json'),
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'intent-first',
          session_id: sessionId,
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ralplan continue without interview completion evidence',
        sessionId,
        nowIso: '2026-05-30T00:04:00.000Z',
      });

      assert.equal(result?.skill, 'autopilot');
      assert.match(String(result?.transition_error), /missing deep-interview completion\/skip gate/i);
      assert.equal(result?.supervised_child_skill, undefined);
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'ralplan-state.json')), false);
      const deepInterview = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'deep-interview-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string };
      assert.equal(deepInterview.active, true);
      assert.equal(deepInterview.current_phase, 'intent-first');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores stale root child mode state during session-scoped Autopilot child reconciliation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-child-session-root-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-child-session-root';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'deep-interview',
          session_id: sessionId,
          active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'ultragoal-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ultragoal',
          current_phase: 'executing',
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$deep-interview continue scoped interview',
        sessionId,
        nowIso: '2026-05-30T00:05:00.000Z',
      });

      assert.equal(result?.skill, 'autopilot');
      assert.equal(result?.supervised_child_skill, 'deep-interview');
      assert.equal(result?.transition_error, undefined);
      const rootUltragoal = JSON.parse(
        await readFile(join(stateDir, 'ultragoal-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string };
      assert.equal(rootUltragoal.active, true);
      assert.equal(rootUltragoal.current_phase, 'executing');
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'deep-interview-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records ultragoal as a prompt skill with first-class mode state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ultragoal-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: '$ultragoal split this launch into durable goals',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ultragoal');
      assert.equal(result.keyword, '$ultragoal');
      assert.equal(result.initialized_mode, 'ultragoal');
      assert.equal(result.initialized_state_path, '.omx/state/ultragoal-state.json');
      const modeState = JSON.parse(await readFile(join(stateDir, 'ultragoal-state.json'), 'utf-8')) as {
        active?: boolean;
        mode?: string;
        current_phase?: string;
      };
      assert.equal(modeState.active, true);
      assert.equal(modeState.mode, 'ultragoal');
      assert.equal(modeState.current_phase, 'planning');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits a warning when skill-active-state persistence fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-persist-fail-'));
    const warnings: unknown[][] = [];
    mock.method(console, 'warn', (...args: unknown[]) => {
      warnings.push(args);
    });

    try {
      const blockingFile = join(cwd, 'state-root-file');
      await writeFile(blockingFile, 'not a directory');

      const result = await recordSkillActivation({
        stateDir: join(blockingFile, 'nested', 'state-dir'),
        text: 'please run $autopilot',
        nowIso: '2026-02-25T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0][0]), /failed to persist keyword activation state/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
          keyword: '$autopilot',
          phase: 'ralplan',
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
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.transition_error, undefined);
      assert.equal(result.activated_at, '2026-02-25T00:00:00.000Z');
      assert.equal(result.updated_at, '2026-02-26T00:00:00.000Z');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves seeded mode progress for same-skill continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-seed-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-autopilot'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-autopilot', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: 'autopilot',
          phase: 'ralplan',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-autopilot',
        }),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-autopilot', 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'code-review',
          started_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          session_id: 'sess-autopilot',
          state: { context_snapshot_path: '.omx/context/existing.md' },
        }),
      );
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'context', 'existing.md'), '# existing context');

      const result = await recordSkillActivation({
        stateDir,
        text: 'autopilot keep going',
        sessionId: 'sess-autopilot',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.phase, 'ralplan');
      assert.equal(result.transition_error, undefined);
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-autopilot', 'autopilot-state.json'), 'utf-8'),
      ) as { current_phase: string; started_at: string; state?: { context_snapshot_path?: string; handoff_artifacts?: { context_snapshot_path?: string } } };
      assert.equal(modeState.current_phase, 'code-review');
      assert.equal(modeState.started_at, '2026-02-25T00:00:00.000Z');
      assert.equal(modeState.state?.context_snapshot_path, undefined);
      assert.equal(modeState.state?.handoff_artifacts?.context_snapshot_path, '.omx/context/existing.md');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not persist Ralph workflow state for a plain conversational mention', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ralph-plain-text-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });

      const result = await recordSkillActivation({
        stateDir,
        text: 'why does ralph keep blocking stop?',
        sessionId: 'sess-plain-ralph',
        threadId: 'thread-plain-ralph',
        turnId: 'turn-plain-ralph',
        nowIso: '2026-04-17T00:00:00.000Z',
      });

      assert.equal(result, null);
      assert.equal(existsSync(join(stateDir, SKILL_ACTIVE_STATE_FILE)), false);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-plain-ralph', SKILL_ACTIVE_STATE_FILE)), false);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-plain-ralph', 'ralph-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves Ralph iteration counters for same-skill continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ralph-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    const statePath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralph',
          keyword: 'ralph',
          phase: 'executing',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          source: 'keyword-detector',
        }),
      );
      await writeFile(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralph',
          current_phase: 'verifying',
          started_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          iteration: 3,
          max_iterations: 10,
        }),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'ralph keep going',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralph');
      assert.equal(result.transition_error, undefined);
      const modeState = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8')) as {
        current_phase: string;
        iteration: number;
        max_iterations: number;
      };
      assert.equal(modeState.current_phase, 'verifying');
      assert.equal(modeState.iteration, 3);
      assert.equal(modeState.max_iterations, 10);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps Korean ulw typo first in mixed explicit workflow persistence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ulw-ko-mixed-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      const result = await recordSkillActivation({
        stateDir,
        text: '$ㅕㅣㅈ $autopilot 병렬 작업으로 처리해줘',
        sessionId: 'sess-ulw-ko-mixed',
        nowIso: '2026-04-21T00:20:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ultrawork');
      assert.equal(result.keyword, '$ulw');
      assert.deepEqual(result.requested_skills, ['ultrawork', 'autopilot']);
      assert.deepEqual(result.active_skills?.map((entry) => entry.skill), ['ultrawork', 'autopilot']);
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-ulw-ko-mixed', 'ultrawork-state.json')),
        true,
      );
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-ulw-ko-mixed', 'autopilot-state.json')),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('lets an explicit Korean ulw typo override an active workflow continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ulw-ko-explicit-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-ulw-ko-explicit'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-ulw-ko-explicit', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'executing',
          activated_at: '2026-04-21T00:00:00.000Z',
          updated_at: '2026-04-21T00:05:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-ulw-ko-explicit',
          active_skills: [
            {
              skill: 'autopilot',
              phase: 'executing',
              active: true,
              activated_at: '2026-04-21T00:00:00.000Z',
              updated_at: '2026-04-21T00:05:00.000Z',
              session_id: 'sess-ulw-ko-explicit',
            },
          ],
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$ㅕㅣㅈ continue',
        sessionId: 'sess-ulw-ko-explicit',
        nowIso: '2026-04-21T00:10:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ultrawork');
      assert.equal(result.keyword, '$ulw');
      assert.deepEqual(result.active_skills?.map((entry) => entry.skill), ['autopilot', 'ultrawork']);
      assert.equal(
        existsSync(join(stateDir, 'sessions', 'sess-ulw-ko-explicit', 'ultrawork-state.json')),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('routes bare keep-going continuation to the active autopilot skill instead of generic ralph continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-bare-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-autopilot-bare'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-autopilot-bare', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'ralplan',
          activated_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-autopilot-bare',
          active_skills: [
            {
              skill: 'autopilot',
              phase: 'ralplan',
              active: true,
              activated_at: '2026-04-19T00:00:00.000Z',
              updated_at: '2026-04-19T00:10:00.000Z',
              session_id: 'sess-autopilot-bare',
            },
          ],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-autopilot-bare', 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'code-review',
          started_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          session_id: 'sess-autopilot-bare',
          state: { context_snapshot_path: '.omx/context/autopilot.md' },
        }, null, 2),
      );
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'context', 'autopilot.md'), '# autopilot context');

      const result = await recordSkillActivation({
        stateDir,
        text: '\\ keep going now',
        sessionId: 'sess-autopilot-bare',
        nowIso: '2026-04-19T00:15:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.equal(result.keyword, '$autopilot');
      assert.equal(result.transition_error, undefined);
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-autopilot-bare', 'autopilot-state.json'), 'utf-8'),
      ) as { current_phase: string; state?: { context_snapshot_path?: string; handoff_artifacts?: { context_snapshot_path?: string } } };
      assert.equal(modeState.current_phase, 'code-review');
      assert.equal(modeState.state?.context_snapshot_path, undefined);
      assert.equal(modeState.state?.handoff_artifacts?.context_snapshot_path, '.omx/context/autopilot.md');
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-autopilot-bare', 'ralph-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('preserves active Autopilot question-wait state on bare continuation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-autopilot-question-wait-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-autopilot-question-wait';
    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'waiting-for-user',
          activated_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          source: 'keyword-detector',
          session_id: sessionId,
          active_skills: [
            {
              skill: 'autopilot',
              phase: 'waiting-for-user',
              active: true,
              activated_at: '2026-04-19T00:00:00.000Z',
              updated_at: '2026-04-19T00:10:00.000Z',
              session_id: sessionId,
            },
          ],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', sessionId, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'waiting-for-user',
          started_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          session_id: sessionId,
          iteration: 4,
          max_iterations: 10,
          review_cycle: 2,
          run_outcome: 'blocked_on_user',
          lifecycle_outcome: 'askuserQuestion',
          state: {
            deep_interview_question: {
              status: 'waiting_for_user',
              obligation_id: 'obligation-question-wait',
              previous_phase: 'deep-interview',
            },
          },
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '\\ keep going now',
        sessionId,
        nowIso: '2026-04-19T00:15:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'autopilot-state.json'), 'utf-8'),
      ) as {
        current_phase?: string;
        iteration?: number;
        max_iterations?: number;
        review_cycle?: number;
        lifecycle_outcome?: string;
        state?: { deep_interview_question?: { obligation_id?: string; status?: string } };
      };
      assert.equal(modeState.current_phase, 'waiting-for-user');
      assert.equal(modeState.iteration, 4);
      assert.equal(modeState.max_iterations, 10);
      assert.equal(modeState.review_cycle, 2);
      assert.equal(modeState.lifecycle_outcome, 'askuserQuestion');
      assert.equal(modeState.state?.deep_interview_question?.status, 'waiting_for_user');
      assert.equal(modeState.state?.deep_interview_question?.obligation_id, 'obligation-question-wait');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('resets terminal Ralph blocked_on_user state when reactivated', async () => {
    const cases = [
      { name: 'phase', phase: 'blocked_on_user', run_outcome: undefined },
      { name: 'outcome', phase: 'executing', run_outcome: 'blocked_on_user' },
    ];

    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-keyword-state-ralph-terminal-${testCase.name}-reactivation-`));
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = `sess-ralph-terminal-${testCase.name}`;
      try {
        await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
        await writeFile(
          join(stateDir, 'sessions', sessionId, SKILL_ACTIVE_STATE_FILE),
          JSON.stringify({
            version: 1,
            active: true,
            skill: 'ralph',
            keyword: '$ralph',
            phase: testCase.phase,
            activated_at: '2026-04-19T00:00:00.000Z',
            updated_at: '2026-04-19T00:10:00.000Z',
            source: 'keyword-detector',
            session_id: sessionId,
            active_skills: [
              {
                skill: 'ralph',
                phase: testCase.phase,
                active: true,
                activated_at: '2026-04-19T00:00:00.000Z',
                updated_at: '2026-04-19T00:10:00.000Z',
                session_id: sessionId,
              },
            ],
          }, null, 2),
        );
        await writeFile(
          join(stateDir, 'sessions', sessionId, 'ralph-state.json'),
          JSON.stringify({
            active: false,
            mode: 'ralph',
            current_phase: testCase.phase,
            started_at: '2026-04-19T00:00:00.000Z',
            completed_at: '2026-04-19T00:10:00.000Z',
            iteration: 50,
            max_iterations: 50,
            ...(testCase.run_outcome ? { run_outcome: testCase.run_outcome } : {}),
          }, null, 2),
        );

        const result = await recordSkillActivation({
          stateDir,
          text: '\\ keep going now',
          sessionId,
          nowIso: '2026-04-19T00:15:00.000Z',
        });

        assert.ok(result);
        assert.equal(result.skill, 'ralph');
        assert.equal(result.phase, 'planning');
        assert.equal(result.activated_at, '2026-04-19T00:15:00.000Z');
        assert.equal(result.active_skills?.[0]?.phase, 'planning');
        assert.equal(result.active_skills?.[0]?.activated_at, '2026-04-19T00:15:00.000Z');
        const modeState = JSON.parse(
          await readFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), 'utf-8'),
        ) as {
          active?: boolean;
          current_phase?: string;
          started_at?: string;
          completed_at?: string;
          iteration?: number;
          max_iterations?: number;
        };
        assert.equal(modeState.active, true);
        assert.equal(modeState.current_phase, 'starting');
        assert.equal(modeState.started_at, '2026-04-19T00:15:00.000Z');
        assert.equal(modeState.completed_at, undefined);
        assert.equal(modeState.iteration, 0);
        assert.equal(modeState.max_iterations, 50);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('routes bare keep-going continuation to the active ralph skill instead of resetting through generic keep-going detection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-ralph-bare-continuation-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-ralph-bare'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralph-bare', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralph',
          keyword: '$ralph',
          phase: 'executing',
          activated_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-ralph-bare',
          active_skills: [
            {
              skill: 'ralph',
              phase: 'executing',
              active: true,
              activated_at: '2026-04-19T00:00:00.000Z',
              updated_at: '2026-04-19T00:10:00.000Z',
              session_id: 'sess-ralph-bare',
            },
          ],
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-ralph-bare', 'ralph-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralph',
          current_phase: 'verifying',
          started_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          iteration: 7,
          max_iterations: 50,
          session_id: 'sess-ralph-bare',
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'keep going now',
        sessionId: 'sess-ralph-bare',
        nowIso: '2026-04-19T00:15:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'ralph');
      assert.equal(result.keyword, '$ralph');
      assert.equal(result.transition_error, undefined);
      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-ralph-bare', 'ralph-state.json'), 'utf-8'),
      ) as { current_phase: string; iteration: number; max_iterations: number };
      assert.equal(modeState.current_phase, 'verifying');
      assert.equal(modeState.iteration, 7);
      assert.equal(modeState.max_iterations, 50);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not reuse active workflow continuation when prompt contains an unknown plugin-prefixed explicit token', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-unknown-prefixed-explicit-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(join(stateDir, 'sessions', 'sess-unknown-prefixed'), { recursive: true });
      await writeFile(
        join(stateDir, 'sessions', 'sess-unknown-prefixed', SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralph',
          keyword: '$ralph',
          phase: 'executing',
          activated_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:10:00.000Z',
          source: 'keyword-detector',
          session_id: 'sess-unknown-prefixed',
          active_skills: [
            {
              skill: 'ralph',
              phase: 'executing',
              active: true,
              activated_at: '2026-04-19T00:00:00.000Z',
              updated_at: '2026-04-19T00:10:00.000Z',
              session_id: 'sess-unknown-prefixed',
            },
          ],
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: '$oh-my-codex:unknown continue',
        sessionId: 'sess-unknown-prefixed',
        nowIso: '2026-04-19T00:15:00.000Z',
      });

      assert.equal(result, null);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-unknown-prefixed', 'ralph-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not continue a workflow from another session root canonical entry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-cross-session-continue-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, SKILL_ACTIVE_STATE_FILE),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: 'autopilot',
          phase: 'ralplan',
          session_id: 'sess-a',
          active_skills: [{ skill: 'autopilot', phase: 'ralplan', active: true, session_id: 'sess-a' }],
        }, null, 2),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'continue',
        sessionId: 'sess-b',
        nowIso: '2026-05-08T00:00:00.000Z',
      });

      assert.equal(result, null);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-b', SKILL_ACTIVE_STATE_FILE)), false);
      const rootCanonical = JSON.parse(await readFile(join(stateDir, SKILL_ACTIVE_STATE_FILE), 'utf-8')) as {
        active_skills?: Array<{ skill: string; session_id?: string }>;
      };
      assert.deepEqual(rootCanonical.active_skills, [
        { skill: 'autopilot', phase: 'ralplan', active: true, session_id: 'sess-a' },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies switching away from a standalone workflow without explicit clear', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-skill-switch-deny-'));
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
          phase: 'ralplan',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:10:00.000Z',
          source: 'keyword-detector',
        }),
      );

      const result = await recordSkillActivation({
        stateDir,
        text: 'please run $ralph now',
        nowIso: '2026-02-26T00:00:00.000Z',
      });

      assert.ok(result);
      assert.equal(result.skill, 'autopilot');
      assert.match(String(result.transition_error), /Unsupported workflow overlap: autopilot \+ ralph\./);
      assert.equal(result.activated_at, '2026-02-25T00:00:00.000Z');
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
          phase: 'ralplan',
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
  it('gates short team follow-up when only PRD/test-spec artifacts exist', async () => {
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
      assert.equal(result.gateApplied, true);
      assert.deepEqual(result.keywords, ['ralplan']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not re-enter ralplan for a short approved team follow-up with durable consensus', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-followup-ko-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch hint: omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-831.md'), '# Test spec\n');
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        planning_complete: true,
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', iteration: 1, sequence_index: 1 },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', iteration: 1, sequence_index: 2 },
        },
      }));

      const result = applyRalplanGate(['team'], 'team으로 해줘', { cwd });
      assert.equal(result.gateApplied, false);
      assert.deepEqual(result.keywords, ['team']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps native-proof execution follow-ups gated when consensus is artifact-only', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-native-required-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-833.md'),
        '# Approved plan\n\nLaunch hint: omx team 3:executor "Execute approved issue 833 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-833.md'), '# Test spec\n');
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        planning_complete: true,
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
            iteration: 1,
            provenance_kind: 'codex_exec',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            iteration: 1,
            provenance_kind: 'codex_exec',
          },
        },
      }));

      const result = applyRalplanGate(['team'], 'team', { cwd, requireNativeSubagents: true });
      assert.equal(result.gateApplied, true);
      assert.deepEqual(result.keywords, ['ralplan']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not re-enter ralplan for a short approved ralph follow-up with durable consensus', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-followup-ralph-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-832.md'),
        '# Approved plan\n\nLaunch hint: omx ralph "Execute approved issue 832 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-832.md'), '# Test spec\n');
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        planning_complete: true,
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', iteration: 1, sequence_index: 1 },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', iteration: 1, sequence_index: 2 },
        },
      }));

      const result = applyRalplanGate(['ralph'], 'ralph please', { cwd, priorSkill: 'ralplan' });
      assert.equal(result.gateApplied, false);
      assert.deepEqual(result.keywords, ['ralph']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores ambient OMX_ROOT consensus state for local PRD/test-spec-only follow-up gating', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-local-'));
    const ambientRoot = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-ambient-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-local.md'), '# Plan\n');
      await writeFile(join(plansDir, 'test-spec-local.md'), '# Test spec\n');

      const ambientStateDir = join(ambientRoot, '.omx', 'state');
      await mkdir(ambientStateDir, { recursive: true });
      await writeFile(join(ambientStateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        planning_complete: true,
        ralplan_consensus_gate: {
          complete: true,
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', iteration: 1 },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', iteration: 1 },
        },
      }));
      process.env.OMX_ROOT = ambientRoot;

      const result = applyRalplanGate(['team'], 'team', { cwd });
      assert.equal(result.gateApplied, true);
      assert.deepEqual(result.keywords, ['ralplan']);
    } finally {
      if (previousOmxRoot === undefined) delete process.env.OMX_ROOT;
      else process.env.OMX_ROOT = previousOmxRoot;
      await rm(cwd, { recursive: true, force: true });
      await rm(ambientRoot, { recursive: true, force: true });
    }
  });

  it('gates short follow-up when local state only has latest verdict fields', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-latest-only-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-local.md'),
        '# Plan\n\nLaunch hint: omx team 3:executor "Execute approved local plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-local.md'), '# Test spec\n');
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        planning_complete: true,
        latest_architect_verdict: 'approve',
        latest_critic_verdict: 'approve',
      }));

      const result = applyRalplanGate(['team'], 'team', { cwd });
      assert.equal(result.gateApplied, true);
      assert.deepEqual(result.keywords, ['ralplan']);
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
    const result = applyRalplanGate(['ralph', 'analyze'], 'ralph analyze this');
    assert.equal(result.gateApplied, true);
    assert.ok(result.keywords.includes('analyze'));
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

describe('recordSkillActivation prompt provenance', () => {
  it('writes only the authorized explicit payload session and stamps its owner', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-keyword-provenance-'));
    try {
      const context = evaluateResolvedPromptTurn({
        producer: 'native',
        payloadSessionId: 'payload-session',
        selectedPointer: { status: 'absent' },
        nowIso: '2026-07-14T00:00:00.000Z',
      });
      const state = await recordSkillActivation({
        stateDir,
        text: '$ralplan implement the scoped change',
        sessionId: 'payload-session',
        resolvedPromptTurnContext: context,
      });
      assert.equal(state?.owner_codex_session_id, 'payload-session');
      assert.equal(existsSync(join(stateDir, 'sessions', 'payload-session', SKILL_ACTIVE_STATE_FILE)), true);
      assert.equal(existsSync(join(stateDir, SKILL_ACTIVE_STATE_FILE)), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('rejects nested foreign owners before direct activation writes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-keyword-nested-owner-'));
    try {
      const targetDir = join(stateDir, 'sessions', 'target');
      await mkdir(targetDir, { recursive: true });
      const statePath = join(targetDir, SKILL_ACTIVE_STATE_FILE);
      const original = JSON.stringify({
        skill: 'ralph', active: true, session_id: 'target', owner_codex_session_id: 'target',
        active_skills: [{ skill: 'ralph', session_id: 'target', owner_codex_session_id: 'foreign' }],
      });
      await writeFile(statePath, original);
      const context = evaluateResolvedPromptTurn({ producer: 'native', payloadSessionId: 'target', selectedPointer: { status: 'absent' } });
      let rejections = 0;
      const result = await recordSkillActivation({
        stateDir, text: '$ralph continue', sessionId: 'target', resolvedPromptTurnContext: context,
        onProvenanceRejected: () => { rejections += 1; },
      });
      assert.equal(result, null);
      assert.equal(rejections, 1);
      assert.equal(await readFile(statePath, 'utf8'), original);
      assert.equal(existsSync(join(targetDir, 'ralph-state.json')), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed target state before direct activation writes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-keyword-malformed-owner-'));
    try {
      const targetDir = join(stateDir, 'sessions', 'target');
      await mkdir(targetDir, { recursive: true });
      const malformedPath = join(targetDir, 'ralph-state.json');
      await writeFile(malformedPath, '{ malformed');
      const context = evaluateResolvedPromptTurn({ producer: 'native', payloadSessionId: 'target', selectedPointer: { status: 'absent' } });
      let rejections = 0;
      const result = await recordSkillActivation({
        stateDir, text: '$ralph continue', sessionId: 'target', resolvedPromptTurnContext: context,
        onProvenanceRejected: () => { rejections += 1; },
      });
      assert.equal(result, null);
      assert.equal(rejections, 1);
      assert.equal(await readFile(malformedPath, 'utf8'), '{ malformed');
      assert.equal(existsSync(join(targetDir, SKILL_ACTIVE_STATE_FILE)), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('rejects target enumeration failures before direct activation writes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-keyword-enumeration-owner-'));
    try {
      const sessionsDir = join(stateDir, 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      const targetPath = join(sessionsDir, 'target');
      await writeFile(targetPath, 'not-a-directory');
      const context = evaluateResolvedPromptTurn({ producer: 'native', payloadSessionId: 'target', selectedPointer: { status: 'absent' } });
      let rejections = 0;
      const result = await recordSkillActivation({
        stateDir, text: '$ralph continue', sessionId: 'target', resolvedPromptTurnContext: context,
        onProvenanceRejected: () => { rejections += 1; },
      });
      assert.equal(result, null);
      assert.equal(rejections, 1);
      assert.equal(await readFile(targetPath, 'utf8'), 'not-a-directory');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
