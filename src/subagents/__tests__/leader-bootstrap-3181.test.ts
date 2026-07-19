import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createSubagentTrackingState,
  isTrustedSubagentThread,
  readSubagentTrackingState,
  readSubagentTrackingStateStrict,
  recordSubagentTurn,
  recordSubagentTurnForSession,
  subagentTrackingPath,
} from '../tracker.js';

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
  try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

describe('#3194 ordinary tracker behavior', () => {
  it('excludes a child thread across all sessions without promoting legacy thread identity to leader authority', async () => {
    await withCwd(async (cwd) => {
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'synthetic-session-a', threadId: 'synthetic-thread', kind: 'leader', leaderThreadId: 'synthetic-thread', timestamp: new Date(0).toISOString(),
      });
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'synthetic-session-b', threadId: 'synthetic-thread', kind: 'subagent', leaderThreadId: 'synthetic-other-leader', timestamp: new Date(0).toISOString(),
      });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(isTrustedSubagentThread(state.sessions['synthetic-session-a'], 'synthetic-thread'), false);
      assert.equal(isTrustedSubagentThread(state.sessions['synthetic-session-b'], 'synthetic-thread'), true);
      assert.equal(state.sessions['synthetic-session-a']?.leader_thread_id, 'synthetic-thread');
    });
  });

  it('retains typed native lifecycle observations while discarding historical authority artifacts', async () => {
    await withCwd(async (cwd) => {
      const path = subagentTrackingPath(cwd);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          'native-session': {
            session_id: 'native-session',
            leader_thread_id: 'native-leader',
            leader_attested_at: '1970-01-01T00:00:00.000Z',
            threads: {
              'native-leader': { thread_id: 'native-leader', kind: 'leader' },
              'native-child': { thread_id: 'native-child', kind: 'subagent', role: 'architect', provenance_kind: 'native_subagent' },
            },
          },
        },
        pending_role_intents: [{ role: 'architect', session_id: 'native-session' }],
      }));

      const session = (await readSubagentTrackingState(cwd)).sessions['native-session'];
      assert.equal(session?.threads['native-child']?.role, 'architect');
      assert.equal(session?.threads['native-child']?.provenance_kind, 'native_subagent');
      assert.equal(isTrustedSubagentThread(session, 'native-leader'), false);
      assert.equal(Object.hasOwn(session ?? {}, 'leader_attested_at'), false);
      assert.equal(Object.hasOwn(await readSubagentTrackingState(cwd), 'pending_role_intents'), false);
    });
  });

  it('preserves ordinary Architect then Critic turn ordering', () => {
    const architect = recordSubagentTurn(createSubagentTrackingState(), {
      sessionId: 'synthetic-session', threadId: 'synthetic-architect', kind: 'subagent', role: 'architect', timestamp: new Date(0).toISOString(),
    });
    const critic = recordSubagentTurn(architect, {
      sessionId: 'synthetic-session', threadId: 'synthetic-critic', kind: 'subagent', role: 'critic', timestamp: new Date(1).toISOString(),
    });
    assert.equal(critic.sessions['synthetic-session']?.threads['synthetic-architect']?.role, 'architect');
    assert.equal(critic.sessions['synthetic-session']?.threads['synthetic-critic']?.role, 'critic');
  });

  it('strictly rejects corrupt tracker data without overwriting it', async () => {
    await withCwd(async (cwd) => {
      const path = subagentTrackingPath(cwd);
      const corrupt = '{ synthetic corrupt tracker';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, corrupt);
      assert.deepEqual(await readSubagentTrackingStateStrict(cwd), { ok: false });
      assert.equal(await readFile(path, 'utf8'), corrupt);
    });
  });
});
