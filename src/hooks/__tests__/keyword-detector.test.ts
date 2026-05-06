import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectKeywords,
  detectPrimaryKeyword,
  recordSkillActivation,
  DEEP_INTERVIEW_STATE_FILE,
  DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
  DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
  persistDeepInterviewModeState,
} from '../keyword-detector.js';
import { SKILL_ACTIVE_STATE_FILE } from '../../state/skill-active.js';
import { isUnderspecifiedForExecution, applyRalplanGate } from '../keyword-detector.js';
import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';

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

  it('maps intentful ultragoal prose without triggering artifact path mentions', () => {
    const intentful = detectPrimaryKeyword('please run ultragoal workflow for this launch');
    assert.ok(intentful);
    assert.equal(intentful.skill, 'ultragoal');

    const pathOnly = detectPrimaryKeyword('inspect .omx/ultragoal/goals.json');
    assert.notEqual(pathOnly?.skill, 'ultragoal');
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
});

describe('keyword registry coverage', () => {
  it('includes key team aliases in runtime keyword registry', () => {
    const registryKeywords = new Set(KEYWORD_TRIGGER_DEFINITIONS.map((v) => v.keyword.toLowerCase()));
    assert.ok(registryKeywords.has('$ultraqa'));
    assert.ok(registryKeywords.has('$analyze'));
    assert.ok(registryKeywords.has('investigate'));
    assert.ok(registryKeywords.has('code review'));
    assert.ok(registryKeywords.has('$code-review'));
    assert.ok(registryKeywords.has('coordinated team'));
    assert.ok(registryKeywords.has('ouroboros'));
    assert.ok(registryKeywords.has("don't assume"));
    assert.ok(registryKeywords.has('interview me'));
    assert.ok(registryKeywords.has('wiki query'));
    assert.ok(registryKeywords.has('wiki add'));
    assert.ok(registryKeywords.has('wiki lint'));
    assert.ok(registryKeywords.has('$autoresearch'));
    assert.ok(registryKeywords.has('$ultragoal'));
    assert.ok(registryKeywords.has('ultragoal'));
  });
});

describe('keyword detector skill-active-state lifecycle', () => {
  it('writes skill-active-state.json with ralplan phase when autopilot keyword activates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-state-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
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
      assert.equal(result.phase, 'ralplan');
      assert.equal(result.active, true);
      assert.deepEqual(result.active_skills, [{
        skill: 'autopilot',
        phase: 'ralplan',
        active: true,
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        session_id: 'sess-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }]);
      assert.equal(result.initialized_mode, 'autopilot');
      assert.equal(result.initialized_state_path, '.omx/state/sessions/sess-1/autopilot-state.json');

      const persisted = JSON.parse(await readFile(join(stateDir, SKILL_ACTIVE_STATE_FILE), 'utf-8')) as {
        skill: string;
        phase: string;
        active: boolean;
        active_skills?: Array<{ skill: string; session_id?: string }>;
        initialized_mode?: string;
      };
      assert.equal(persisted.skill, 'autopilot');
      assert.equal(persisted.phase, 'ralplan');
      assert.equal(persisted.active, true);
      assert.deepEqual(persisted.active_skills, [{
        skill: 'autopilot',
        phase: 'ralplan',
        active: true,
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        session_id: 'sess-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }]);
      assert.equal(persisted.initialized_mode, 'autopilot');

      const sessionScopedSkillState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-1', SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.deepEqual(sessionScopedSkillState.active_skills, persisted.active_skills);

      const modeState = JSON.parse(await readFile(join(stateDir, 'sessions', 'sess-1', 'autopilot-state.json'), 'utf-8')) as {
        mode: string;
        active: boolean;
        current_phase: string;
        iteration: number;
        review_cycle: number;
        max_iterations: number;
        state: {
          phase_cycle: string[];
          handoff_artifacts: Record<string, unknown>;
          review_verdict: unknown;
          return_to_ralplan_reason: string | null;
        };
      };
      assert.equal(modeState.mode, 'autopilot');
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'ralplan');
      assert.equal(modeState.iteration, 1);
      assert.equal(modeState.review_cycle, 0);
      assert.equal(modeState.max_iterations, 10);
      assert.deepEqual(modeState.state.phase_cycle, ['ralplan', 'ralph', 'code-review']);
      assert.deepEqual(modeState.state.handoff_artifacts, { ralplan: null, ralph: null, code_review: null });
      assert.equal(modeState.state.review_verdict, null);
      assert.equal(modeState.state.return_to_ralplan_reason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
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
      assert.match(String(denied?.transition_error), /`omx state clear --mode <mode>`/);
      assert.match(String(denied?.transition_error), /`omx_state\.\*` MCP tools/);

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
        text: '$ralplan implement the approved contract',
        sessionId: 'sess-handoff',
        nowIso: '2026-04-10T00:00:00.000Z',
      });

      assert.equal(result?.transition_error, undefined);
      assert.equal(result?.transition_message, 'mode transiting: deep-interview -> ralplan');

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

  it('preserves root team state when $ralph is activated for the current session', async () => {
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

      const rootCanonical = JSON.parse(
        await readFile(join(stateDir, SKILL_ACTIVE_STATE_FILE), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        rootCanonical.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'team', phase: 'planning', session_id: 'sess-team-ralph' }],
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

  it('records ultragoal as a prompt skill without seeding unrelated mode state', async () => {
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
      assert.equal(result.initialized_mode, undefined);
      assert.equal(result.initialized_state_path, undefined);
      assert.equal(existsSync(join(stateDir, 'ultragoal-state.json')), false);
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
        text: 'please run $autopilot',
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
    const statePath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-autopilot'), { recursive: true });
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
      ) as { current_phase: string; started_at: string; state?: { context_snapshot_path?: string } };
      assert.equal(modeState.current_phase, 'code-review');
      assert.equal(modeState.started_at, '2026-02-25T00:00:00.000Z');
      assert.equal(modeState.state?.context_snapshot_path, '.omx/context/existing.md');
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
      ) as { current_phase: string; state?: { context_snapshot_path?: string } };
      assert.equal(modeState.current_phase, 'code-review');
      assert.equal(modeState.state?.context_snapshot_path, '.omx/context/autopilot.md');
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-autopilot-bare', 'ralph-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
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

  it('does not re-enter ralplan for a short approved ralph follow-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-keyword-gate-followup-ralph-'));
    try {
      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-832.md'),
        '# Approved plan\n\nLaunch hint: omx ralph "Execute approved issue 832 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-832.md'), '# Test spec\n');

      const result = applyRalplanGate(['ralph'], 'ralph please', { cwd, priorSkill: 'ralplan' });
      assert.equal(result.gateApplied, false);
      assert.deepEqual(result.keywords, ['ralph']);
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
