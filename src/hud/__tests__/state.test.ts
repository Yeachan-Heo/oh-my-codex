import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnterpriseState, readGitBranch, readRalphState } from '../state.js';

describe('readGitBranch', () => {
  it('returns null in a non-git directory without printing git fatal noise', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-state-'));
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    const patchedWrite = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      stderrChunks.push(text);
      if (typeof encodingOrCallback === 'function') encodingOrCallback(null);
      if (typeof callback === 'function') callback(null);
      return true;
    }) as typeof process.stderr.write;

    process.stderr.write = patchedWrite;

    try {
      assert.equal(readGitBranch(cwd), null);
    } finally {
      process.stderr.write = originalWrite;
      await rm(cwd, { recursive: true, force: true });
    }

    assert.equal(stderrChunks.join('').includes('not a git repository'), false);
  });
});

describe('readRalphState scope precedence', () => {
  it('prefers session-scoped Ralph state when session.json points to a session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-ralph-session-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-hud';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 9,
        max_iterations: 10,
      }));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 2,
        max_iterations: 10,
      }));

      const state = await readRalphState(cwd);
      assert.ok(state);
      assert.equal(state?.iteration, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to root Ralph state when current session has no Ralph state file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-ralph-fallback-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-fallback';
      await mkdir(join(rootStateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 4,
        max_iterations: 10,
      }));

      const state = await readRalphState(cwd);
      assert.ok(state);
      assert.equal(state?.iteration, 4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats session-scoped inactive Ralph state as authoritative over active root fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-ralph-authority-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-authority';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 8,
        max_iterations: 10,
      }));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        current_phase: 'cancelled',
      }));

      const state = await readRalphState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('readEnterpriseState', () => {
  it('reads active enterprise state from the scoped mode file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-enterprise-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      await mkdir(rootStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'enterprise-state.json'), JSON.stringify({
        active: true,
        current_phase: 'enterprise-exec',
        division_count: 2,
        subordinate_count: 5,
        chairman_state: 'working',
      }));
      await mkdir(join(rootStateDir, 'enterprise', 'worker-heartbeat'), { recursive: true });
      await writeFile(join(rootStateDir, 'enterprise', 'worker-heartbeat', 'division-1.json'), JSON.stringify({
        nodeId: 'division-1',
        paneId: '%101',
        alive: true,
        lastHeartbeatAt: new Date().toISOString(),
        ownerLeadId: null,
      }));

      const state = await readEnterpriseState(cwd);
      assert.ok(state);
      assert.equal(state?.division_count, 2);
      assert.equal(state?.chairman_state, 'working');
      assert.equal(state?.healthy_worker_count, 1);
      assert.equal(state?.stale_worker_count, 0);
      assert.equal(state?.offline_worker_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

