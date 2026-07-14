import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { recordSkillActivation } from '../../hooks/keyword-detector.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';
import {
  listActiveSkills,
  mergeSessionAwareSkillOverlay,
  readVisibleSkillActiveStateForStateDir,
  writeSkillActiveStateCopiesForStateDir,
  type SkillActiveEntry,
  type SkillActiveStateLike,
} from '../skill-active.js';

const SESSION_ID = 'sess-overlay-failures';
const THREAD_ID = 'thread-overlay-failures';
const NOW = '2026-07-14T00:00:00.000Z';

function ralplanState(overrides: SkillActiveStateLike = {}): SkillActiveStateLike {
  const ralplan: SkillActiveEntry = {
    skill: 'ralplan',
    phase: 'planning',
    active: true,
    activated_at: NOW,
    updated_at: NOW,
    session_id: SESSION_ID,
    thread_id: THREAD_ID,
  };
  return {
    version: 1,
    active: true,
    skill: 'ralplan',
    keyword: '$ralplan',
    phase: 'planning',
    activated_at: NOW,
    updated_at: NOW,
    session_id: SESSION_ID,
    thread_id: THREAD_ID,
    active_skills: [ralplan],
    ...overrides,
  };
}

function reviewOverlay(): SkillActiveEntry {
  return {
    skill: 'code-review',
    phase: 'reviewing',
    active: true,
    activated_at: NOW,
    updated_at: NOW,
    session_id: SESSION_ID,
    thread_id: THREAD_ID,
  };
}

describe('code-review overlay failure handling', () => {
  it('rejects conflicting canonical copies without mutating the authoritative state', () => {
    const authoritative = ralplanState();
    const before = JSON.stringify(authoritative);
    const rootState = ralplanState({
      skill: 'autopilot',
      phase: 'ultragoal',
      active_skills: [{
        skill: 'autopilot',
        phase: 'ultragoal',
        active: true,
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
      }],
    });

    assert.throws(() => mergeSessionAwareSkillOverlay({
      authoritativeState: authoritative,
      rootState,
      overlay: reviewOverlay(),
      sessionId: SESSION_ID,
      rootThreadId: THREAD_ID,
      nowIso: NOW,
    }), /conflicting canonical session and root copies/i);
    assert.equal(JSON.stringify(authoritative), before);
  });

  it('keeps the prior session canonical state visible when a root-copy write fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-overlay-write-failure-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', SESSION_ID);
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(ralplanState(), null, 2));
      await mkdir(join(stateDir, 'skill-active-state.json'), { recursive: true });

      const next = mergeSessionAwareSkillOverlay({
        authoritativeState: ralplanState(),
        overlay: reviewOverlay(),
        sessionId: SESSION_ID,
        rootThreadId: THREAD_ID,
        nowIso: NOW,
      });
      await assert.rejects(
        writeSkillActiveStateCopiesForStateDir(stateDir, next, SESSION_ID, ralplanState()),
        /EISDIR|illegal operation on a directory|is a directory/i,
      );

      const visible = await readVisibleSkillActiveStateForStateDir(stateDir, SESSION_ID);
      assert.deepEqual(listActiveSkills(visible).map((entry) => entry.skill), ['ralplan']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails Stop closed with one actionable diagnostic when canonical state is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-overlay-malformed-stop-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', SESSION_ID);
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: SESSION_ID, cwd }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), '{ malformed canonical');
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
        cwd,
      }, null, 2));

      const activation = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$code-review inspect the current diff',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        nowIso: NOW,
      });
      const canonicalAfterActivation = await readFile(
        join(sessionDir, 'skill-active-state.json'),
        'utf-8',
      );
      const stop = await dispatchCodexNativeHook({
        hook_event_name: 'Stop',
        cwd,
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
        turn_id: 'turn-malformed-stop',
      }, { cwd });

      assert.deepEqual({
        activeSkills: listActiveSkills(activation ?? {}).map((entry) => entry.skill),
        canonicalAfterActivation,
        diagnosticCount: activation?.transition_error ? 1 : 0,
        stopDecision: stop.outputJson?.decision ?? null,
        stopReason: stop.outputJson?.stopReason ?? null,
      }, {
        activeSkills: [],
        canonicalAfterActivation: '{ malformed canonical',
        diagnosticCount: 1,
        stopDecision: 'block',
        stopReason: 'skill_ralplan_planning_continue_artifact',
      });
      assert.match(String(activation?.transition_error), /canonical skill state.*malformed.*repair or clear/i);
      assert.match(String(stop.outputJson?.reason), /continue from the current ralplan artifact/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails Stop closed when canonical JSON is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-overlay-invalid-schema-stop-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', SESSION_ID);
    const canonicalPath = join(sessionDir, 'skill-active-state.json');
    const invalidCanonical = '{"active":true,"skill":123,"active_skills":"bad"}';
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: SESSION_ID, cwd }, null, 2));
      await writeFile(canonicalPath, invalidCanonical);
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
        cwd,
      }, null, 2));

      const activation = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$code-review inspect the current diff',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        nowIso: NOW,
      });
      const canonicalAfterActivation = await readFile(canonicalPath, 'utf-8');
      const stop = await dispatchCodexNativeHook({
        hook_event_name: 'Stop',
        cwd,
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
        turn_id: 'turn-invalid-schema-stop',
      }, { cwd });

      assert.deepEqual({
        activationSkills: listActiveSkills(activation ?? {}).map((entry) => entry.skill),
        canonicalAfterActivation,
        diagnosticCount: activation?.transition_error ? 1 : 0,
        stopDecision: stop.outputJson?.decision ?? null,
        stopReason: stop.outputJson?.stopReason ?? null,
      }, {
        activationSkills: [],
        canonicalAfterActivation: invalidCanonical,
        diagnosticCount: 1,
        stopDecision: 'block',
        stopReason: 'skill_ralplan_planning_continue_artifact',
      });
      assert.match(String(activation?.transition_error), /canonical skill state.*malformed.*repair or clear/i);
      assert.match(String(stop.outputJson?.reason), /continue from the current ralplan artifact/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts valid terminal and legacy top-level canonical shapes', async () => {
    const cases: Array<{
      name: string;
      canonical: SkillActiveStateLike;
      expectedSkills: string[];
    }> = [
      {
        name: 'terminal',
        canonical: ralplanState({ active: false, phase: 'completed', active_skills: [] }),
        expectedSkills: ['code-review'],
      },
      {
        name: 'legacy top-level',
        canonical: {
          active: true,
          skill: 'ralplan',
          phase: 'planning',
          session_id: SESSION_ID,
          thread_id: THREAD_ID,
        },
        expectedSkills: ['ralplan', 'code-review'],
      },
    ];

    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-overlay-valid-${testCase.name.replaceAll(' ', '-')}-`));
      const stateDir = join(cwd, '.omx', 'state');
      const canonicalPath = join(stateDir, 'sessions', SESSION_ID, 'skill-active-state.json');
      try {
        await mkdir(join(stateDir, 'sessions', SESSION_ID), { recursive: true });
        await writeFile(canonicalPath, JSON.stringify(testCase.canonical, null, 2));

        const activation = await recordSkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$code-review inspect the current diff',
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          nowIso: NOW,
        });
        const persisted = JSON.parse(await readFile(canonicalPath, 'utf-8')) as SkillActiveStateLike;

        assert.equal(activation?.transition_error, undefined, testCase.name);
        assert.deepEqual(
          listActiveSkills(persisted).map((entry) => entry.skill),
          testCase.expectedSkills,
          testCase.name,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('fails Stop closed without replacing an unreadable canonical workflow state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-overlay-unreadable-stop-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', SESSION_ID);
    const canonicalPath = join(sessionDir, 'skill-active-state.json');
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: SESSION_ID, cwd }, null, 2));
      await writeFile(canonicalPath, JSON.stringify(ralplanState(), null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
        cwd,
      }, null, 2));
      await chmod(canonicalPath, 0o200);

      const activation = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$code-review inspect the current diff',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        nowIso: NOW,
      });
      await chmod(canonicalPath, 0o600);
      const canonicalAfterActivation = JSON.parse(
        await readFile(canonicalPath, 'utf-8'),
      ) as SkillActiveStateLike;
      const detailAfterActivation = JSON.parse(
        await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8'),
      ) as { active?: boolean };
      const stop = await dispatchCodexNativeHook({
        hook_event_name: 'Stop',
        cwd,
        session_id: SESSION_ID,
        thread_id: THREAD_ID,
        turn_id: 'turn-unreadable-stop',
      }, { cwd });

      assert.deepEqual({
        activationSkills: listActiveSkills(activation ?? {}).map((entry) => entry.skill),
        canonicalSkills: listActiveSkills(canonicalAfterActivation).map((entry) => entry.skill),
        detailActive: detailAfterActivation.active,
        diagnosticCount: activation?.transition_error ? 1 : 0,
        stopDecision: stop.outputJson?.decision ?? null,
        stopReason: stop.outputJson?.stopReason ?? null,
      }, {
        activationSkills: [],
        canonicalSkills: ['ralplan'],
        detailActive: true,
        diagnosticCount: 1,
        stopDecision: 'block',
        stopReason: 'skill_ralplan_planning_continue_artifact',
      });
      assert.match(String(activation?.transition_error), /canonical skill state.*unreadable.*repair permissions or clear/i);
      assert.match(String(stop.outputJson?.reason), /continue from the current ralplan artifact/i);
    } finally {
      await chmod(canonicalPath, 0o600).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows a review overlay when the session canonical state is genuinely missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-overlay-missing-canonical-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      const activation = await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$code-review inspect the current diff',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        nowIso: NOW,
      });
      const persisted = JSON.parse(await readFile(
        join(stateDir, 'sessions', SESSION_ID, 'skill-active-state.json'),
        'utf-8',
      )) as SkillActiveStateLike;

      assert.equal(activation?.transition_error, undefined);
      assert.deepEqual(listActiveSkills(activation ?? {}).map((entry) => entry.skill), ['code-review']);
      assert.deepEqual(listActiveSkills(persisted).map((entry) => entry.skill), ['code-review']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores a stale foreign root copy while preserving the current session workflow', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-overlay-stale-root-'));
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        ...ralplanState(),
        session_id: 'stale-session',
        thread_id: 'stale-thread',
        active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: 'stale-session', thread_id: 'stale-thread' }],
      }, null, 2));
      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$ralplan current session plan',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        nowIso: NOW,
      });
      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$code-review current session diff',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        nowIso: '2026-07-14T00:01:00.000Z',
      });

      const visible = await readVisibleSkillActiveStateForStateDir(stateDir, SESSION_ID);
      assert.deepEqual(listActiveSkills(visible).map((entry) => entry.skill), ['ralplan', 'code-review']);
      const staleRoot = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as SkillActiveStateLike;
      assert.equal(staleRoot.session_id, 'stale-session');
      assert.deepEqual(listActiveSkills(staleRoot).map((entry) => entry.skill), ['autopilot']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
