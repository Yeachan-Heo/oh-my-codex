import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertModeStartAllowed, readModeState, startMode, updateModeState } from '../base.js';


describe('modes/base session-scoped persistence', () => {
  it('writes mode state into the current session scope when session.json exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-scope-'));
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-base-write' }));

      await startMode('ralplan', 'write in session scope', 5, wd);

      const scopedPath = join(wd, '.omx', 'state', 'sessions', 'sess-base-write', 'ralplan-state.json');
      assert.equal(existsSync(scopedPath), true);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'ralplan-state.json')), false);

      const raw = JSON.parse(await readFile(scopedPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.mode, 'ralplan');
      assert.equal(raw.current_phase, 'starting');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes session canonical skill state under the base state dir without nesting sessions twice', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-canonical-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-base-canonical';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));

      await startMode('ralplan', 'write canonical in session scope', 5, wd);
      await updateModeState('ralplan', { current_phase: 'planning', iteration: 1 }, wd);

      const canonicalPath = join(sessionDir, 'skill-active-state.json');
      const nestedCanonicalPath = join(sessionDir, 'sessions', sessionId, 'skill-active-state.json');
      assert.equal(existsSync(canonicalPath), true);
      assert.equal(existsSync(nestedCanonicalPath), false);
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(canonical.skill, 'ralplan');
      assert.equal(canonical.phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists owner_omx_session_id for Ralph when session scope is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-ralph-owner-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-ralph-owner';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));

      await startMode('ralph', 'own this session', 5, wd);

      const scoped = JSON.parse(await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(scoped.owner_omx_session_id, sessionId);
      assert.equal(scoped.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers session-scoped reads over root fallback and writes updates back to the session scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-read-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-base-read';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({ active: true, current_phase: 'root-only', iteration: 9 }));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({ active: true, current_phase: 'draft', iteration: 1 }));

      const state = await readModeState('ralplan', wd);
      assert.equal(state?.current_phase, 'draft');
      assert.equal(state?.iteration, 1);

      await updateModeState('ralplan', { current_phase: 'architect-review', iteration: 2 }, wd);
      const scoped = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      const root = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;

      assert.equal(scoped.current_phase, 'architect-review');
      assert.equal(scoped.iteration, 2);
      assert.equal(root.current_phase, 'root-only');
      assert.equal(root.iteration, 9);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not rebind root fallback Ralph task fields into a new session update', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-ralph-no-rebind-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-new-ralph';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        mode: 'ralph',
        iteration: 4,
        max_iterations: 10,
        current_phase: 'verifying',
        task_slug: 'old-task',
        owner_omx_session_id: 'old-session',
      }));

      await assert.rejects(
        () => updateModeState('ralph', { current_phase: 'executing' }, wd),
        /Mode ralph not found/,
      );

      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'ralph-state.json')), false);
      const root = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(root.owner_omx_session_id, 'old-session');
      assert.equal(root.task_slug, 'old-task');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows an explicit Ralph start to overwrite an inactive current-session Ralph file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-ralph-restart-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-ralph-restart';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        iteration: 7,
        max_iterations: 10,
        current_phase: 'cancelled',
        completed_at: '2026-02-22T00:10:00.000Z',
      }));

      await startMode('ralph', 'restart from current session', 5, wd);

      const scoped = JSON.parse(await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(scoped.active, true);
      assert.equal(scoped.mode, 'ralph');
      assert.equal(scoped.iteration, 0);
      assert.equal(scoped.max_iterations, 5);
      assert.equal(scoped.current_phase, 'starting');
      assert.equal(scoped.owner_omx_session_id, sessionId);
      assert.equal(typeof scoped.completed_at, 'undefined');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('fails closed before mode assertion or start can create an unmatched OMX_SESSION_ID scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-unmatched-session-'));
    const previousSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-canonical', cwd: wd }));
      process.env.OMX_SESSION_ID = 'sess-unmatched';

      await assert.rejects(() => assertModeStartAllowed('ralplan', wd), /OMX_SESSION_ID is not bound to session\.json/);
      await assert.rejects(() => startMode('ralplan', 'must not write', 5, wd), /OMX_SESSION_ID is not bound to session\.json/);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-unmatched')), false);
      assert.equal(existsSync(join(stateDir, 'ralplan-state.json')), false);
    } finally {
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves explicit fork updates when the implicit OMX_SESSION_ID is unmatched', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-explicit-fork-'));
    const previousSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(wd, '.omx', 'state');
      const forkSessionId = 'explicit-fork';
      const forkStatePath = join(stateDir, 'sessions', forkSessionId, 'ralplan-state.json');
      await mkdir(join(stateDir, 'sessions', forkSessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-canonical', cwd: wd }));
      await writeFile(forkStatePath, JSON.stringify({
        active: true,
        mode: 'ralplan',
        iteration: 0,
        max_iterations: 5,
        current_phase: 'starting',
      }));
      process.env.OMX_SESSION_ID = 'sess-unmatched';

      await updateModeState('ralplan', { current_phase: 'planning', iteration: 1 }, wd, forkSessionId);

      const updated = JSON.parse(await readFile(forkStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(updated.current_phase, 'planning');
      assert.equal(updated.iteration, 1);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-unmatched')), false);
    } finally {
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(wd, { recursive: true, force: true });
    }
  });

});
