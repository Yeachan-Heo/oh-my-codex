import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readActiveModeStateSync, readModeState, readModeStateSync, startMode, updateModeState } from '../base.js';

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
      const syncState = readModeStateSync('ralplan', wd);
      assert.equal(syncState?.current_phase, 'draft');
      assert.equal(syncState?.iteration, 1);

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

  it('falls back to root state in the sync reader when the current session has no session-scoped mode state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-sync-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-base-sync-root';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({ active: true, current_phase: 'root-only', iteration: 4 }),
      );

      const syncState = readModeStateSync('team', wd);
      assert.equal(syncState?.current_phase, 'root-only');
      assert.equal(syncState?.iteration, 4);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to root active state when the current session-scoped mode state is inactive', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-sync-active-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-base-sync-active-fallback';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(
        join(sessionDir, 'team-state.json'),
        JSON.stringify({ active: false, current_phase: 'cancelled', iteration: 8 }),
      );
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({ active: true, current_phase: 'team-exec', iteration: 4 }),
      );

      const activeState = readActiveModeStateSync('team', wd);
      assert.equal(activeState?.current_phase, 'team-exec');
      assert.equal(activeState?.iteration, 4);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps generic mode reads fail-closed on malformed session-scoped state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-malformed-fail-closed-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-base-sync-malformed-fail-closed';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'ralplan-state.json'), '{ not-json', 'utf-8');
      await writeFile(
        join(stateDir, 'ralplan-state.json'),
        JSON.stringify({ active: true, current_phase: 'root-team-exec', iteration: 6 }),
      );

      const asyncState = await readModeState('ralplan', wd);
      assert.equal(asyncState, null);

      const syncState = readModeStateSync('ralplan', wd);
      assert.equal(syncState, null);

      await assert.rejects(
        () => updateModeState('ralplan', { current_phase: 'resume', iteration: 7 }, wd),
        /Mode ralplan not found/,
      );

      const rootState = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootState.current_phase, 'root-team-exec');
      assert.equal(rootState.iteration, 6);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back past malformed session-scoped team state only in the Team active-state reader', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-session-team-malformed-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-base-sync-team-malformed-fallback';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'team-state.json'), '{ not-json', 'utf-8');
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({ active: true, current_phase: 'root-team-exec', iteration: 6 }),
      );

      const asyncState = await readModeState('team', wd);
      assert.equal(asyncState, null);

      const syncState = readModeStateSync('team', wd);
      assert.equal(syncState, null);

      const activeState = readActiveModeStateSync('team', wd);
      assert.equal(activeState?.current_phase, 'root-team-exec');
      assert.equal(activeState?.iteration, 6);
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
});
