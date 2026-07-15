import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listActiveSkills,
  listTransitionActiveSkills,
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
async function withStateRootEnv<T>(env: Partial<Record<'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT', string>>, run: () => Promise<T>): Promise<T> {
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;

  if (typeof env.OMX_ROOT === 'string') process.env.OMX_ROOT = env.OMX_ROOT;
  else delete process.env.OMX_ROOT;
  if (typeof env.OMX_STATE_ROOT === 'string') process.env.OMX_STATE_ROOT = env.OMX_STATE_ROOT;
  else delete process.env.OMX_STATE_ROOT;
  if (typeof env.OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = env.OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;

  try {
    return await run();
  } finally {
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
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

  it('uses OMX_TEAM_STATE_ROOT for default canonical sync without creating cwd .omx', async () => {
    await withTempRepo('omx-skill-active-team-root-', async (root) => {
      const cwd = join(root, 'workspace');
      const teamStateRoot = join(root, 'team-state');
      await mkdir(cwd, { recursive: true });

      await withStateRootEnv({ OMX_TEAM_STATE_ROOT: teamStateRoot }, async () => {
        await syncCanonicalSkillStateForMode({
          cwd,
          mode: 'ralph',
          active: true,
          currentPhase: 'executing',
          sessionId: 'sess-team',
          nowIso: '2026-07-05T00:00:00.000Z',
        });
      });

      const sessionState = JSON.parse(
        await readFile(join(teamStateRoot, 'sessions', 'sess-team', 'skill-active-state.json'), 'utf-8'),
      ) as { active?: boolean; skill?: string; active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.equal(sessionState.active, true);
      assert.equal(sessionState.skill, 'ralph');
      assert.deepEqual(sessionState.active_skills?.map(({ skill, session_id }) => ({ skill, session_id })), [
        { skill: 'ralph', session_id: 'sess-team' },
      ]);
      assert.equal(existsSync(join(cwd, '.omx')), false);
    });
  });

  it('keeps stale root entries from other sessions out of current session state', async () => {
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
        skill: 'deep-interview',
        phase: 'intent-first',
        active: true,
        session_id: 'old-session',
      }]);
    });
  });

  it('keeps root-scoped team state isolated when session-scoped ralph is activated', async () => {
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
        [{ skill: 'ralph', phase: 'executing', session_id: 'sess-overlap' }],
      );
    });
  });

  it('does not carry stale Ralph initialization fields from another session into current session state', async () => {
    await withTempRepo('omx-skill-active-stale-init-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSkillActiveStateCopies(cwd, {
        active: true,
        skill: 'ralph',
        phase: 'verifying',
        session_id: 'old-session',
        initialized_mode: 'ralph',
        initialized_state_path: '.omx/state/sessions/old-session/ralph-state.json',
        task_slug: 'old-ralph-task',
        context_snapshot_path: '.omx/context/old.md',
        active_skills: [{ skill: 'ralph', phase: 'verifying', active: true, session_id: 'old-session' }],
      });

      await syncCanonicalSkillStateForMode({
        cwd,
        mode: 'ralph',
        active: true,
        currentPhase: 'executing',
        sessionId: 'new-session',
        nowIso: '2026-05-03T00:00:00.000Z',
      });

      const sessionState = await readVisibleSkillActiveState(cwd, 'new-session') as Record<string, unknown> | null;
      assert.ok(sessionState);
      assert.equal(sessionState.initialized_mode, undefined);
      assert.equal(sessionState.initialized_state_path, undefined);
      assert.equal(sessionState.task_slug, undefined);
      assert.equal(sessionState.context_snapshot_path, undefined);
      assert.equal(sessionState.session_id, 'new-session');
      assert.deepEqual(
        listActiveSkills(sessionState).map(({ skill, phase, session_id }) => ({ skill, phase, session_id })),
        [{ skill: 'ralph', phase: 'executing', session_id: 'new-session' }],
      );

      const rootState = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootState.initialized_mode, 'ralph');
      assert.equal(rootState.initialized_state_path, '.omx/state/sessions/old-session/ralph-state.json');
    });
  });

  it('does not synthesize session root mirror fallback from top-level skill fields', async () => {
    await withTempRepo('omx-skill-active-root-top-level-only-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        phase: 'deep-interview',
        session_id: 'current-session',
      }));

      const sessionState = await readVisibleSkillActiveState(cwd, 'current-session');

      assert.equal(sessionState, null);
    });
  });

  it('returns null for a missing session skill-active file even when the root mirror is active', async () => {
    await withTempRepo('omx-skill-active-root-mirror-missing-session-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        phase: 'deep-interview',
        initialized_mode: 'ralph',
        initialized_state_path: '.omx/state/sessions/stale-session/ralph-state.json',
        owner_omx_session_id: 'stale-session',
        owner_codex_session_id: 'stale-codex-session',
        owner_codex_thread_id: 'stale-thread',
        task_slug: 'stale-task',
        context_snapshot_path: '.omx/context/stale.md',
        session_id: 'stale-session',
        active_skills: [{
          skill: 'autopilot',
          phase: 'deep-interview',
          active: true,
          session_id: 'current-session',
          thread_id: 'current-thread',
          turn_id: 'current-turn',
        }],
      }));

      const sessionState = await readVisibleSkillActiveState(cwd, 'current-session');

      assert.equal(sessionState, null);
    });
  });

  it('requires nested transition entries to match canonical session ownership', () => {
    const entries = [
      { skill: 'team', phase: 'team-exec', active: true },
      { skill: 'ralph', phase: 'executing', active: true, session_id: 'foreign-session' },
      { skill: 'ultrawork', phase: 'executing', active: true, session_id: 'current-session' },
    ];
    const compact = (state: unknown, sessionId?: string) => listTransitionActiveSkills(state, sessionId)
      .map(({ skill, phase, session_id }) => ({ skill, phase, session_id }));

    assert.deepEqual(compact({
      active: true,
      skill: 'team',
      session_id: 'foreign-outer',
      active_skills: entries,
    }), []);
    assert.deepEqual(
      compact({ active: true, skill: 'team', active_skills: entries }),
      [{ skill: 'team', phase: 'team-exec', session_id: undefined }],
    );
    assert.deepEqual(
      compact({ active: true, skill: 'team', active_skills: [...entries].reverse() }, 'current-session'),
      [{ skill: 'ultrawork', phase: 'executing', session_id: 'current-session' }],
    );
    assert.deepEqual(
      compact({ active: true, skill: 'team', active_skills: entries }, 'foreign-session'),
      [{ skill: 'ralph', phase: 'executing', session_id: 'foreign-session' }],
    );
  });
  it('does not treat active_skills as active when the canonical state is terminal', async () => {
    await withTempRepo('omx-skill-active-terminal-overrides-entries-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state', 'sessions', 'sess-terminal'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'sessions', 'sess-terminal', 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'autopilot',
        phase: 'blocked_on_user',
        completed_at: '2026-06-09T00:00:00.000Z',
        session_id: 'sess-terminal',
        active_skills: [{
          skill: 'autopilot',
          phase: 'deep-interview',
          active: true,
          session_id: 'sess-terminal',
        }],
      }, null, 2));

      const sessionState = await readVisibleSkillActiveState(cwd, 'sess-terminal');

      assert.ok(sessionState);
      assert.equal(sessionState.active, false);
      assert.deepEqual(listActiveSkills(sessionState), []);
    });
  });

  it('clears stale terminal markers when a workflow is reactivated', async () => {
    await withTempRepo('omx-skill-active-reactivate-terminal-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSkillActiveStateCopies(cwd, {
        active: false,
        skill: 'autopilot',
        phase: 'complete',
        completed_at: '2026-06-09T00:00:00.000Z',
        cancel_reason: 'old cancellation',
        run_outcome: 'finish',
        lifecycle_outcome: 'complete',
        session_id: 'sess-reactivate',
        active_skills: [{ skill: 'autopilot', phase: 'complete', active: true, session_id: 'sess-reactivate' }],
      }, 'sess-reactivate');

      await syncCanonicalSkillStateForMode({
        cwd,
        mode: 'autopilot',
        active: true,
        sessionId: 'sess-reactivate',
        nowIso: '2026-06-09T00:01:00.000Z',
      });

      const sessionState = await readVisibleSkillActiveState(cwd, 'sess-reactivate');
      assert.ok(sessionState);
      assert.equal(sessionState.active, true);
      assert.equal(sessionState.phase, '');
      assert.equal(sessionState.completed_at, undefined);
      assert.equal(sessionState.cancel_reason, undefined);
      assert.equal(sessionState.run_outcome, undefined);
      assert.equal(sessionState.lifecycle_outcome, undefined);
      assert.deepEqual(listActiveSkills(sessionState).map(({ skill, phase, session_id }) => ({ skill, phase, session_id })), [
        { skill: 'autopilot', phase: undefined, session_id: 'sess-reactivate' },
      ]);
    });
  });

  it('recognizes runtime terminal outcomes when suppressing stale active entries', async () => {
    await withTempRepo('omx-skill-active-terminal-outcomes-', async (cwd) => {
      await mkdir(join(cwd, '.omx', 'state', 'sessions', 'sess-terminal-outcome'), { recursive: true });
      const cases = [
        { run_outcome: 'blocked_on_user' },
        { lifecycle_outcome: 'blocked' },
        { lifecycle_outcome: 'userinterlude' },
        { lifecycle_outcome: 'askuserQuestion' },
        { completed_at: '2026-06-09T00:00:00.000Z' },
        { phase: 'blocked_on_user' },
      ];

      for (const [index, terminalFields] of cases.entries()) {
        const state = {
          version: 1,
          active: true,
          skill: 'autopilot',
          phase: 'ralplan',
          session_id: `sess-terminal-outcome-${index}`,
          active_skills: [{ skill: 'autopilot', phase: 'ralplan', active: true, session_id: `sess-terminal-outcome-${index}` }],
          ...terminalFields,
        };
        assert.deepEqual(listActiveSkills(state), []);
      }
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
      assert.equal(sessionState.active, false);
      assert.deepEqual(listActiveSkills(sessionState), []);

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
