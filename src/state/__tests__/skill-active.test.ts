import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listActiveSkills,
  readVisibleSkillActiveState,
  syncCanonicalSkillStateForMode,
  writeSkillActiveStateCopies,
} from '../skill-active.js';

async function withTempRepo(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('skill-active state helpers', () => {
  it('prefers session-scoped canonical state over root state', async () => {
    await withTempRepo('omx-skill-active-session-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSkillActiveStateCopies(cwd, {
        active: true,
        skill: 'ralph',
        phase: 'executing',
        active_skills: [{ skill: 'ralph', phase: 'executing', active: true }],
      });
      await writeSkillActiveStateCopies(cwd, {
        active: true,
        skill: 'team',
        phase: 'running',
        session_id: 'sess-1',
        active_skills: [{ skill: 'team', phase: 'running', active: true, session_id: 'sess-1' }],
      }, 'sess-1');

      const state = await readVisibleSkillActiveState(cwd, 'sess-1');
      assert.ok(state);
      assert.equal(state?.skill, 'team');
      const [entry] = listActiveSkills(state);
      assert.ok(entry);
      assert.equal(entry.skill, 'team');
      assert.equal(entry.phase, 'running');
      assert.equal(entry.active, true);
      assert.equal(entry.session_id, 'sess-1');
    });
  });

  it('drops stale entries from other sessions when syncing canonical state for the current session', async () => {
    await withTempRepo('omx-skill-active-filter-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSkillActiveStateCopies(cwd, {
        active: true,
        skill: 'deep-interview',
        phase: 'intent-first',
        session_id: 'old-session',
        active_skills: [{ skill: 'deep-interview', phase: 'intent-first', active: true, session_id: 'old-session' }],
      });

      await syncCanonicalSkillStateForMode({
        cwd,
        mode: 'ralph',
        active: true,
        currentPhase: 'executing',
        sessionId: 'new-session',
        nowIso: '2026-04-08T00:00:00.000Z',
      });

      const sessionState = await readVisibleSkillActiveState(cwd, 'new-session');
      assert.ok(sessionState);
      const [entry] = listActiveSkills(sessionState);
      assert.ok(entry);
      assert.equal(entry.skill, 'ralph');
      assert.equal(entry.phase, 'executing');
      assert.equal(entry.active, true);
      assert.equal(entry.activated_at, '2026-04-08T00:00:00.000Z');
      assert.equal(entry.updated_at, '2026-04-08T00:00:00.000Z');
      assert.equal(entry.session_id, 'new-session');

      const rootState = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'skill-active-state.json'), 'utf-8')) as {
        active_skills?: Array<{ skill: string; session_id?: string }>;
      };
      assert.deepEqual(rootState.active_skills, [{
        skill: 'ralph',
        phase: 'executing',
        active: true,
        activated_at: '2026-04-08T00:00:00.000Z',
        updated_at: '2026-04-08T00:00:00.000Z',
        session_id: 'new-session',
      }]);
    });
  });

  it('preserves root-scoped team state when a session-scoped ralph overlap is activated', async () => {
    await withTempRepo('omx-skill-active-team-ralph-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSkillActiveStateCopies(cwd, {
        active: true,
        skill: 'team',
        phase: 'running',
        active_skills: [{ skill: 'team', phase: 'running', active: true }],
      });

      await syncCanonicalSkillStateForMode({
        cwd,
        mode: 'ralph',
        active: true,
        currentPhase: 'executing',
        sessionId: 'sess-overlap',
        nowIso: '2026-04-09T00:00:00.000Z',
      });

      const rootState = JSON.parse(
        await readFile(join(cwd, '.omx', 'state', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        rootState.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'team', phase: 'running', session_id: undefined }],
      );

      const sessionState = await readVisibleSkillActiveState(cwd, 'sess-overlap');
      assert.ok(sessionState);
      assert.deepEqual(
        listActiveSkills(sessionState).map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [
          { skill: 'team', phase: 'running', session_id: undefined },
          { skill: 'ralph', phase: 'executing', session_id: 'sess-overlap' },
        ],
      );
    });
  });

  it('clears only the matching terminal session entry and preserves unrelated active skills', async () => {
    await withTempRepo('omx-skill-active-terminal-clear-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSkillActiveStateCopies(cwd, {
        active: true,
        skill: 'custom-skill',
        phase: 'running',
        active_skills: [{ skill: 'custom-skill', phase: 'running', active: true }],
      });
      await syncCanonicalSkillStateForMode({
        cwd,
        mode: 'ralplan',
        active: true,
        currentPhase: 'planning',
        sessionId: 'sess-terminal',
        nowIso: '2026-05-01T00:00:00.000Z',
      });

      await syncCanonicalSkillStateForMode({
        cwd,
        mode: 'ralplan',
        active: false,
        currentPhase: 'complete',
        sessionId: 'sess-terminal',
        nowIso: '2026-05-01T00:01:00.000Z',
      });

      const sessionState = await readVisibleSkillActiveState(cwd, 'sess-terminal');
      assert.ok(sessionState);
      assert.deepEqual(
        listActiveSkills(sessionState).map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'custom-skill', phase: 'running', session_id: undefined }],
      );

      const rootState = JSON.parse(
        await readFile(join(cwd, '.omx', 'state', 'skill-active-state.json'), 'utf-8'),
      ) as { active?: boolean; active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.equal(rootState.active, true);
      assert.deepEqual(
        rootState.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'custom-skill', phase: 'running', session_id: undefined }],
      );
    });
  });
});
