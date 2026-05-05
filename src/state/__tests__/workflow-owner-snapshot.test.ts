import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkflowOwnerSnapshot } from '../workflow-owner-snapshot.js';

async function withTempRepo(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

describe('resolveWorkflowOwnerSnapshot', () => {
  it('prefers session-scoped mode state over root state', async () => {
    await withTempRepo('omx-owner-snapshot-session-', async (cwd) => {
      await writeJson(join(cwd, '.omx', 'state', 'ralph-state.json'), {
        active: true,
        current_phase: 'executing',
      });
      await writeJson(join(cwd, '.omx', 'state', 'sessions', 'sess-1', 'ralph-state.json'), {
        active: true,
        current_phase: 'verifying',
      });

      const snapshot = await resolveWorkflowOwnerSnapshot({
        cwd,
        mode: 'ralph',
        currentOmxSessionId: 'sess-1',
        terminalPhases: ['complete', 'failed', 'cancelled', 'blocked_on_user'],
      });

      assert.equal(snapshot.active, true);
      assert.equal(snapshot.source, 'session');
      assert.equal(snapshot.state?.current_phase, 'verifying');
      assert.equal(snapshot.ownerMatches, true);
    });
  });

  it('does not let root state override a current session without session-scoped state', async () => {
    await withTempRepo('omx-owner-snapshot-root-block-', async (cwd) => {
      await writeJson(join(cwd, '.omx', 'state', 'ralph-state.json'), {
        active: true,
        current_phase: 'executing',
      });
      await mkdir(join(cwd, '.omx', 'state', 'sessions', 'sess-1'), { recursive: true });

      const snapshot = await resolveWorkflowOwnerSnapshot({
        cwd,
        mode: 'ralph',
        currentOmxSessionId: 'sess-1',
        terminalPhases: ['complete', 'failed', 'cancelled', 'blocked_on_user'],
      });

      assert.equal(snapshot.active, false);
      assert.equal(snapshot.reason, 'blocked_by_current_session');
      assert.equal(snapshot.blockingReason, 'session_scoped_state_missing');
    });
  });

  it('does not resurrect terminal canonical state from compatibility state', async () => {
    await withTempRepo('omx-owner-snapshot-compat-terminal-', async (cwd) => {
      await writeJson(join(cwd, '.omx', 'state', 'ralph-state.json'), {
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-05T00:00:00.000Z',
      });
      await writeJson(join(cwd, '.omx', 'state', 'skill-active-state.json'), {
        active: true,
        skill: 'ralph',
        active_skills: [{ skill: 'ralph', active: true, phase: 'executing' }],
      });

      const snapshot = await resolveWorkflowOwnerSnapshot({
        cwd,
        mode: 'ralph',
        includeCompatibility: true,
        terminalPhases: ['complete', 'failed', 'cancelled', 'blocked_on_user'],
      });

      assert.equal(snapshot.active, false);
      assert.equal(snapshot.terminal, true);
      assert.equal(snapshot.source, 'root');
      assert.equal(snapshot.reason, 'terminal');
    });
  });

  it('marks owner-present state ambiguous when current owner identity is missing', async () => {
    await withTempRepo('omx-owner-snapshot-ambiguous-', async (cwd) => {
      await writeJson(join(cwd, '.omx', 'state', 'ralph-state.json'), {
        active: true,
        current_phase: 'executing',
        owner_omx_session_id: 'leader-session',
      });

      const snapshot = await resolveWorkflowOwnerSnapshot({
        cwd,
        mode: 'ralph',
        terminalPhases: ['complete', 'failed', 'cancelled', 'blocked_on_user'],
      });

      assert.equal(snapshot.active, false);
      assert.equal(snapshot.ownerMatches, 'ambiguous');
      assert.equal(snapshot.reason, 'owner_ambiguous');
      assert.equal(snapshot.blockingReason, 'owner_present_current_session_missing');
    });
  });
});
