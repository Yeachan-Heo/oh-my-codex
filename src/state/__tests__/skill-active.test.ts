import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listActiveSkills,
  listTransitionActiveSkills,
  readVisibleSkillActiveState,
  SkillActiveStateWriteError,
  syncCanonicalSkillStateForMode,
  writeSkillActiveStateCopies,
  writeSkillActiveStateCopiesForStateDir,
} from '../skill-active.js';

async function withTempRepo(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForReadyOrError(readyPath: string, errorPath: string): Promise<'ready' | 'error'> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(readyPath) && !existsSync(errorPath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${readyPath} or ${errorPath}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(errorPath) ? 'error' : 'ready';
}

async function waitForRootPhase(path: string, sessionId: string, phase: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const state = JSON.parse(await readFile(path, 'utf8')) as { active_skills?: Array<{ session_id?: string; phase?: string }> };
      if (state.active_skills?.some((entry) => entry.session_id === sessionId && entry.phase === phase)) return;
    } catch {
      // The atomic replacement may be between visibility checks; retry.
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${sessionId}=${phase}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}


function rootWriterWorkerSource(): string {
  return `
    import { existsSync } from 'node:fs';
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    const stateDir = process.env.STATE_DIR;
    const sessionId = process.env.SESSION_ID;
    const skill = process.env.SKILL;
    const phase = process.env.PHASE;
    const readyPath = process.env.READY_PATH;
    const releasePath = process.env.RELEASE_PATH;
    const errorPath = process.env.ERROR_PATH;
    const sessionReadyPath = process.env.SESSION_READY_PATH;
    const sessionReleasePath = process.env.SESSION_RELEASE_PATH;
    const rootPath = stateDir + '/skill-active-state.json';
    try {
      const { writeSkillActiveStateCopiesForStateDir } = await import(${JSON.stringify(new URL('../skill-active.js', import.meta.url).href)});
      const root = JSON.parse(await readFile(rootPath, 'utf8'));
      await mkdir(stateDir + '/sessions/' + sessionId, { recursive: true });
      await writeSkillActiveStateCopiesForStateDir(stateDir, {
        version: 1, active: true, skill, phase, session_id: sessionId,
        active_skills: [{ skill, phase, active: true, session_id: sessionId }],
      }, sessionId, root, { beforeCommit: async (event) => {
        if (event.site === 'skill-active.root-copy') {
          await writeFile(readyPath, 'ready');
          while (!existsSync(releasePath)) await new Promise(resolve => setTimeout(resolve, 10));
          return;
        }
        if (event.site === 'skill-active.session-copy' && sessionReadyPath && sessionReleasePath) {
          await writeFile(sessionReadyPath, 'ready');
          while (!existsSync(sessionReleasePath)) await new Promise(resolve => setTimeout(resolve, 10));
        }
      }});
    } catch (error) {
      await writeFile(errorPath, JSON.stringify({ code: error?.code, message: String(error?.message ?? error) }));
      process.exitCode = 1;
    }
  `;
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
  it('serializes concurrent session root RMW and preserves both entries', async () => {
    await withTempRepo('omx-skill-active-root-rmw-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      await mkdir(join(stateDir, 'sessions', 'sess-a'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-b'), { recursive: true });
      const root = {
        version: 1,
        active: true,
        skill: 'ralph',
        active_skills: [
          { skill: 'ralph', phase: 'executing', active: true, session_id: 'sess-a' },
          { skill: 'team', phase: 'running', active: true, session_id: 'sess-b' },
        ],
      };
      await writeFile(rootPath, `${JSON.stringify(root, null, 2)}\n`);

      let resolveFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => { resolveFirstEntered = resolve; });
      let releaseFirst!: () => void;
      const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let secondEntered = false;
      const write = (sessionId: string, skill: string, beforeCommit: (event: { site: string }) => Promise<void>) => (
        writeSkillActiveStateCopiesForStateDir(
          stateDir,
          {
            version: 1,
            active: true,
            skill,
            session_id: sessionId,
            active_skills: [{ skill, phase: 'updated', active: true, session_id: sessionId }],
          },
          sessionId,
          root,
          { beforeCommit },
        )
      );

      const first = write('sess-a', 'ralph', async (event) => {
        if (event.site !== 'skill-active.root-copy') return;
        resolveFirstEntered();
        await firstHold;
      });
      await firstEntered;
      const second = write('sess-b', 'team', async (event) => {
        if (event.site === 'skill-active.root-copy') secondEntered = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(secondEntered, false);
      releaseFirst();
      await Promise.all([first, second]);

      const parsed = JSON.parse(await readFile(rootPath, 'utf-8')) as { active_skills: Array<{ skill: string; session_id?: string; phase?: string }> };
      assert.deepEqual(
        parsed.active_skills.map(({ skill, session_id, phase }) => ({ skill, session_id, phase })),
        [
          { skill: 'ralph', session_id: 'sess-a', phase: 'updated' },
          { skill: 'team', session_id: 'sess-b', phase: 'updated' },
        ],
      );
      assert.deepEqual(await readdir(stateDir), ['sessions', 'skill-active-state.json']);
    });
  });

  it('fails closed on malformed root state and recovers after repair', async () => {
    await withTempRepo('omx-skill-active-root-recovery-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      await mkdir(stateDir, { recursive: true });
      const malformed = '{"active":';
      await writeFile(rootPath, malformed);
      await mkdir(`${rootPath}.lock`);
      await assert.rejects(
        () => writeSkillActiveStateCopiesForStateDir(
          stateDir,
          { active: true, skill: 'ralph', session_id: 'sess-recovery', active_skills: [{ skill: 'ralph', active: true, session_id: 'sess-recovery' }] },
          'sess-recovery',
          { active: true, skill: 'ralph', session_id: 'sess-recovery' },
        ),
        (error: unknown) => error instanceof SkillActiveStateWriteError && error.code === 'lock-timeout',
      );
      assert.equal(await readFile(rootPath, 'utf-8'), malformed);
      await rm(`${rootPath}.lock`, { recursive: true, force: true });

      await assert.rejects(
        () => writeSkillActiveStateCopiesForStateDir(
          stateDir,
          { active: true, skill: 'ralph', session_id: 'sess-recovery', active_skills: [{ skill: 'ralph', active: true, session_id: 'sess-recovery' }] },
          'sess-recovery',
          { active: true, skill: 'ralph', session_id: 'sess-recovery' },
        ),
        (error: unknown) => error instanceof SkillActiveStateWriteError && error.code === 'malformed-root',
      );
      assert.equal(await readFile(rootPath, 'utf-8'), malformed);
      assert.equal(existsSync(`${rootPath}.lock`), false);

      await writeFile(rootPath, `${JSON.stringify({ version: 1, active: true, skill: 'ralph', active_skills: [{ skill: 'ralph', active: true, session_id: 'sess-recovery' }] }, null, 2)}\n`);
      await writeSkillActiveStateCopiesForStateDir(
        stateDir,
        { active: true, skill: 'ralph', phase: 'recovered', session_id: 'sess-recovery', active_skills: [{ skill: 'ralph', phase: 'recovered', active: true, session_id: 'sess-recovery' }] },
        'sess-recovery',
        { active: true, skill: 'ralph', session_id: 'sess-recovery' },
      );
      assert.equal(JSON.parse(await readFile(rootPath, 'utf-8')).active_skills[0].phase, 'recovered');
    });
  });
  it('serializes genuine multi-process root contention', async () => {
    await withTempRepo('omx-skill-active-process-rmw-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      await mkdir(stateDir, { recursive: true });
      await writeFile(rootPath, `${JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralph',
        active_skills: [
          { skill: 'ralph', phase: 'old-a', active: true, session_id: 'proc-a' },
          { skill: 'team', phase: 'old-b', active: true, session_id: 'proc-b' },
        ],
      }, null, 2)}\n`);
      const worker = rootWriterWorkerSource();
      const launch = (sessionId: string, skill: string, phase: string) => {
        const readyPath = join(stateDir, `${sessionId}.ready`);
        const releasePath = join(stateDir, `${sessionId}.release`);
        const errorPath = join(stateDir, `${sessionId}.error`);
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
          env: { ...process.env, STATE_DIR: stateDir, SESSION_ID: sessionId, SKILL: skill, PHASE: phase, READY_PATH: readyPath, RELEASE_PATH: releasePath, ERROR_PATH: errorPath },
          stdio: 'ignore',
        });
        return { child, done: new Promise<number | null>((resolve) => child.once('close', resolve)), readyPath, releasePath, errorPath };
      };
      const first = launch('proc-a', 'ralph', 'new-a');
      const second = launch('proc-b', 'team', 'new-b');
      const firstReady = await Promise.race([
        waitForReadyOrError(first.readyPath, first.errorPath).then(async (outcome) => {
          if (outcome !== 'ready') throw new Error(await readFile(first.errorPath, 'utf8'));
          return first;
        }),
        waitForReadyOrError(second.readyPath, second.errorPath).then(async (outcome) => {
          if (outcome !== 'ready') throw new Error(await readFile(second.errorPath, 'utf8'));
          return second;
        }),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const secondReady = firstReady === first ? second : first;
      assert.equal(existsSync(secondReady.readyPath), false);
      await writeFile(firstReady.releasePath, 'release');
      await waitForPath(secondReady.readyPath);
      await writeFile(secondReady.releasePath, 'release');
      await waitForRootPhase(rootPath, 'proc-a', 'new-a');
      await waitForRootPhase(rootPath, 'proc-b', 'new-b');
      assert.equal(await firstReady.done, 0);
      assert.equal(await secondReady.done, 0);

      const final = JSON.parse(await readFile(rootPath, 'utf8')) as { active_skills: Array<{ session_id?: string; phase?: string }> };
      assert.deepEqual(
        Object.fromEntries(final.active_skills.map((entry) => [entry.session_id, entry.phase])),
        { 'proc-a': 'new-a', 'proc-b': 'new-b' },
      );
      assert.equal(existsSync(`${rootPath}.lock`), false);
    });
  });

  it('does not release a successor lock after cross-process takeover', async () => {
    await withTempRepo('omx-skill-active-successor-release-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      await mkdir(stateDir, { recursive: true });
      await writeFile(rootPath, `${JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralph',
        active_skills: [{ skill: 'ralph', phase: 'old', active: true, session_id: 'release-owner' }],
      }, null, 2)}\n`);
      const readyPath = join(stateDir, 'release-owner.ready');
      const releasePath = join(stateDir, 'release-owner.release');
      const sessionReadyPath = join(stateDir, 'release-owner.session-ready');
      const sessionReleasePath = join(stateDir, 'release-owner.session-release');
      const errorPath = join(stateDir, 'release-owner.error');
      const worker = spawn(process.execPath, ['--input-type=module', '-e', rootWriterWorkerSource()], {
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          SESSION_ID: 'release-owner',
          SKILL: 'ralph',
          PHASE: 'updated',
          READY_PATH: readyPath,
          RELEASE_PATH: releasePath,
          SESSION_READY_PATH: sessionReadyPath,
          SESSION_RELEASE_PATH: sessionReleasePath,
          ERROR_PATH: errorPath,
        },
        stdio: 'ignore',
      });
      const done = new Promise<number | null>((resolve) => worker.once('close', resolve));
      await waitForPath(readyPath);
      await writeFile(releasePath, 'release-root');
      await waitForPath(sessionReadyPath);

      const lockPath = `${rootPath}.lock`;
      const ownerEntry = (await readdir(lockPath)).find((entry) => entry.startsWith('owner-'));
      assert.ok(ownerEntry);
      const ownerToken = await readFile(join(lockPath, ownerEntry), 'utf8');
      const successorPath = `${lockPath}.old-owner`;
      await rename(lockPath, successorPath);
      await mkdir(lockPath);
      const successorToken = 'successor-token';
      await writeFile(join(lockPath, `owner-${successorToken}`), successorToken);
      await writeFile(sessionReleasePath, 'release-session');

      assert.equal(await done, 0);
      assert.equal(await readFile(join(lockPath, `owner-${successorToken}`), 'utf8'), successorToken);
      assert.equal(await readFile(join(successorPath, ownerEntry), 'utf8'), ownerToken);
      assert.equal(existsSync(errorPath), false);
      await rm(lockPath, { recursive: true, force: true });
      await rm(successorPath, { recursive: true, force: true });
    });
  });
  it('rejects live stale takeover, cleans dead stale locks, and preserves recovery', async () => {
    await withTempRepo('omx-skill-active-stale-lock-', async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      await mkdir(stateDir, { recursive: true });
      await writeFile(rootPath, `${JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralph',
        active_skills: [{ skill: 'ralph', phase: 'old', active: true, session_id: 'live-owner' }],
      }, null, 2)}\n`);
      const worker = rootWriterWorkerSource();
      const launch = (sessionId: string, phase: string) => {
        const readyPath = join(stateDir, `${sessionId}.ready`);
        const releasePath = join(stateDir, `${sessionId}.release`);
        const errorPath = join(stateDir, `${sessionId}.error`);
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
          env: { ...process.env, STATE_DIR: stateDir, SESSION_ID: sessionId, SKILL: 'ralph', PHASE: phase, READY_PATH: readyPath, RELEASE_PATH: releasePath, ERROR_PATH: errorPath },
          stdio: 'ignore',
        });
        return { child, done: new Promise<number | null>((resolve) => child.once('close', resolve)), readyPath, releasePath, errorPath };
      };
      const owner = launch('live-owner', 'live-update');
      await waitForPath(owner.readyPath);
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(`${rootPath}.lock`, staleTime, staleTime);
      const contender = launch('contender', 'should-not-win');
      assert.equal(await waitForReadyOrError(contender.readyPath, contender.errorPath), 'error');
      assert.equal(JSON.parse(await readFile(contender.errorPath, 'utf8')).code, 'lock-timeout');
      assert.equal(existsSync(contender.readyPath), false);
      await writeFile(owner.releasePath, 'release');
      await waitForRootPhase(rootPath, 'live-owner', 'live-update');
      assert.equal(await owner.done, 0);
      assert.equal(await contender.done, 1);

      await mkdir(`${rootPath}.lock`);
      await utimes(`${rootPath}.lock`, staleTime, staleTime);
      await writeSkillActiveStateCopiesForStateDir(
        stateDir,
        { active: true, skill: 'ralph', phase: 'ownerless-recovered', session_id: 'live-owner', active_skills: [{ skill: 'ralph', phase: 'ownerless-recovered', active: true, session_id: 'live-owner' }] },
        'live-owner',
        { active: true, skill: 'ralph', session_id: 'live-owner' },
      );
      assert.equal(existsSync(`${rootPath}.lock`), false);
      assert.equal(JSON.parse(await readFile(rootPath, 'utf8')).active_skills[0].phase, 'ownerless-recovered');

      await mkdir(`${rootPath}.lock`);
      await writeFile(`${rootPath}.lock/owner`, '2147483647-dead-owner-token');
      await utimes(`${rootPath}.lock`, staleTime, staleTime);
      await writeSkillActiveStateCopiesForStateDir(
        stateDir,
        { active: true, skill: 'ralph', phase: 'recovered', session_id: 'live-owner', active_skills: [{ skill: 'ralph', phase: 'recovered', active: true, session_id: 'live-owner' }] },
        'live-owner',
        { active: true, skill: 'ralph', session_id: 'live-owner' },
      );
      assert.equal(existsSync(`${rootPath}.lock`), false);
      assert.equal(JSON.parse(await readFile(rootPath, 'utf8')).active_skills[0].phase, 'recovered');
    });
  });
});
