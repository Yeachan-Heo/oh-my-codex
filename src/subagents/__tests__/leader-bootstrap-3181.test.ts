import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  attestLeaderThread,
  ensureLeaderAndRecordIntent,
  readSubagentTrackingState,
  recordNativeLeaderIntent,
  recordSubagentTurnForSession,
  subagentTrackingPath,
} from '../tracker.js';

// 32 lowercase-hex chars: the canonical correlation-token shape the CLI generates via
// randomUUID().replace(/-/g, '').
const TOKEN = 'abcdef0123456789abcdef0123456789';
const TOKEN2 = '00112233445566778899aabbccddeeff';

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-bootstrap-'));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('#3181 leader bootstrap tracker carrier', () => {
  it('attests a leader and then records the adapted intent via self-heal', async () => {
    await withCwd(async (cwd) => {
      const attest = attestLeaderThread(cwd, {
        sessionId: 'sess-a',
        leaderThreadId: 'leader-thread-a',
        source: 'native-pretooluse',
      });
      assert.deepEqual(attest, { ok: true, alreadyAttested: false });

      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect',
        sessionId: 'sess-a',
        parentThreadId: 'leader-thread-a',
        correlationToken: TOKEN,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.reused, false);
      assert.equal(result.intent.role, 'architect');
      assert.equal(result.intent.session_id, 'sess-a');
      assert.equal(result.intent.parent_thread_id, 'leader-thread-a');
      assert.equal(result.intent.correlation_token, TOKEN);

      const state = await readSubagentTrackingState(cwd);
      const session = state.sessions['sess-a'];
      assert.equal(session?.leader_thread_id, 'leader-thread-a');
      assert.ok(session?.leader_attested_at);
      assert.equal(session?.leader_attest_source, 'native-pretooluse');
      assert.equal(session?.threads['leader-thread-a']?.kind, 'leader');
      assert.equal(state.pending_role_intents.length, 1);
    });
  });

  it('fails closed with native_anchor_unavailable when no attestation exists', async () => {
    await withCwd(async (cwd) => {
      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect',
        sessionId: 'sess-fresh',
        parentThreadId: 'codex-thread-fresh-turn',
        correlationToken: TOKEN,
      });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_unavailable' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 0);
      assert.equal(state.sessions['sess-fresh'], undefined);
    });
  });

  it('fails closed with native_anchor_mismatch when parent-thread != attested leader', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect',
        sessionId: 'sess-a',
        parentThreadId: 'attacker-thread',
        correlationToken: TOKEN,
      });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_mismatch' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 0);
    });
  });

  it('never overwrites a different existing leader (fail-closed attestation)', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const second = attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'foreign-leader', source: 'native-pretooluse' });
      assert.deepEqual(second, { ok: false, reason: 'native_anchor_mismatch' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions['sess-a']?.leader_thread_id, 'leader-thread-a');
    });
  });

  it('is idempotent: duplicate same-identity intent reuses the original receipt', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const first = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect', sessionId: 'sess-a', parentThreadId: 'leader-thread-a', correlationToken: TOKEN,
      });
      const second = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect', sessionId: 'sess-a', parentThreadId: 'leader-thread-a', correlationToken: TOKEN2,
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (!first.ok || !second.ok) return;
      assert.equal(second.reused, true);
      assert.equal(second.intent.correlation_token, first.intent.correlation_token);
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 1);
    });
  });

  it('preserves single-flight: a different-role second live intent returns single_flight_conflict', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const architect = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect', sessionId: 'sess-a', parentThreadId: 'leader-thread-a', correlationToken: TOKEN,
      });
      const critic = ensureLeaderAndRecordIntent(cwd, {
        role: 'critic', sessionId: 'sess-a', parentThreadId: 'leader-thread-a', correlationToken: TOKEN2,
      });
      assert.equal(architect.ok, true);
      assert.deepEqual(critic, { ok: false, reason: 'single_flight_conflict' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 1);
      assert.equal(state.pending_role_intents[0]?.role, 'architect');
    });
  });

  it('atomically refuses to attest a thread already tracked as a subagent (native_anchor_mismatch)', async () => {
    await withCwd(async (cwd) => {
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'leader-session',
        threadId: 'child-thread',
        kind: 'subagent',
        leaderThreadId: 'leader-session',
        timestamp: new Date().toISOString(),
      });
      const result = attestLeaderThread(cwd, { sessionId: 'child-thread', leaderThreadId: 'child-thread', source: 'native-pretooluse' });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_mismatch' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions['child-thread'], undefined);
    });
  });

  it('fails closed (native_anchor_unavailable) when the tracker file exists but is corrupt', async () => {
    await withCwd(async (cwd) => {
      const path = subagentTrackingPath(cwd);
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(path, '{ this is not valid json');
      const result = attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_unavailable' });
    });
  });

  it('fails closed (native_anchor_unavailable) when the tracker exists but is unreadable (non-ENOENT)', async () => {
    await withCwd(async (cwd) => {
      // Make the tracker path a directory so a read throws EISDIR (not ENOENT); an existing
      // but unreadable tracker must deny attestation, not be treated as clean empty state.
      await mkdir(subagentTrackingPath(cwd), { recursive: true });
      const result = attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_unavailable' });
    });
  });

  it('symmetric exclusion: a leader also tracked as a subagent in a DIFFERENT session cannot record an intent', async () => {
    await withCwd(async (cwd) => {
      // Attestation wins first for session A.
      const attest = attestLeaderThread(cwd, { sessionId: 'sess-A', leaderThreadId: 'thread-x', source: 'native-pretooluse' });
      assert.equal(attest.ok, true);
      // A cross-session child record then classifies thread-x as a subagent under session B.
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'sess-B',
        threadId: 'thread-x',
        kind: 'subagent',
        leaderThreadId: 'sess-B',
        timestamp: new Date().toISOString(),
      });
      // ensureLeaderAndRecordIntent must re-scan all sessions and refuse.
      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect', sessionId: 'sess-A', parentThreadId: 'thread-x', correlationToken: TOKEN,
      });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_mismatch' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('preserves the leader attestation across an ordinary child turn write (no legacy downgrade)', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-A', leaderThreadId: 'leader-L', source: 'native-sessionstart' });
      const first = ensureLeaderAndRecordIntent(cwd, { role: 'architect', sessionId: 'sess-A', parentThreadId: 'leader-L', correlationToken: TOKEN });
      assert.equal(first.ok, true);

      // An ordinary child turn under the same session must NOT erase the attestation.
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'sess-A',
        threadId: 'child-thread',
        kind: 'subagent',
        leaderThreadId: 'leader-L',
        timestamp: new Date().toISOString(),
      });

      const state = await readSubagentTrackingState(cwd);
      assert.ok(state.sessions['sess-A']?.leader_attested_at, 'attestation must survive a child turn write');
      assert.equal(state.sessions['sess-A']?.leader_attest_source, 'native-sessionstart');
      assert.equal(state.sessions['sess-A']?.leader_thread_id, 'leader-L', 'a child turn must not replace the attested leader');

      // The next role-intent write still uses the attested path (idempotent receipt reuse),
      // proving no downgrade to the legacy non-atomic path.
      const retry = ensureLeaderAndRecordIntent(cwd, { role: 'architect', sessionId: 'sess-A', parentThreadId: 'leader-L', correlationToken: TOKEN2 });
      assert.equal(retry.ok, true);
      if (!retry.ok || !first.ok) return;
      assert.equal(retry.reused, true);
      assert.equal(retry.intent.correlation_token, first.intent.correlation_token);
    });
  });

  it('recordNativeLeaderIntent records under a positively-provenanced tracker leader and is role-agnostic single-flight', async () => {
    await withCwd(async (cwd) => {
      // A real recorded leader turn establishes the positive tracker leader anchor.
      await recordSubagentTurnForSession(cwd, { sessionId: 'sess-A', threadId: 'native-L', kind: 'leader', leaderThreadId: 'native-L', timestamp: new Date().toISOString() });
      const ok = recordNativeLeaderIntent(cwd, {
        role: 'architect', sessionId: 'sess-A', parentThreadId: 'native-L', allowTrackerLeader: true, correlationToken: TOKEN,
      });
      assert.equal(ok.ok, true);
      if (!ok.ok) return;
      assert.equal(ok.intent.role, 'architect');
      // Same identity reuses; different role conflicts.
      const reuse = recordNativeLeaderIntent(cwd, { role: 'architect', sessionId: 'sess-A', parentThreadId: 'native-L', allowTrackerLeader: true, correlationToken: TOKEN2 });
      assert.equal(reuse.ok, true);
      if (reuse.ok) assert.equal(reuse.reused, true);
      const conflict = recordNativeLeaderIntent(cwd, { role: 'critic', sessionId: 'sess-A', parentThreadId: 'native-L', allowTrackerLeader: true, correlationToken: TOKEN2 });
      assert.deepEqual(conflict, { ok: false, reason: 'single_flight_conflict' });
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
    });
  });

  it('recordNativeLeaderIntent fails closed when there is no positive tracker leader anchor (session.json alone never authorizes)', async () => {
    await withCwd(async (cwd) => {
      // No recorded leader turn / attestation: the bare native-session pointer is NOT trusted.
      const res = recordNativeLeaderIntent(cwd, {
        role: 'architect', sessionId: 'sess-A', parentThreadId: 'native-L', allowTrackerLeader: true, correlationToken: TOKEN,
      });
      assert.deepEqual(res, { ok: false, reason: 'parent_not_active_leader' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('recordNativeLeaderIntent rejects a parent that is not the tracker leader (parent_not_active_leader), no mutation', async () => {
    await withCwd(async (cwd) => {
      await recordSubagentTurnForSession(cwd, { sessionId: 'sess-A', threadId: 'native-L', kind: 'leader', leaderThreadId: 'native-L', timestamp: new Date().toISOString() });
      const res = recordNativeLeaderIntent(cwd, {
        role: 'architect', sessionId: 'sess-A', parentThreadId: 'attacker', allowTrackerLeader: true, correlationToken: TOKEN,
      });
      assert.deepEqual(res, { ok: false, reason: 'parent_not_active_leader' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('recordNativeLeaderIntent atomically rejects a tracker leader also tracked as a subagent (race: child record wins)', async () => {
    await withCwd(async (cwd) => {
      await recordSubagentTurnForSession(cwd, { sessionId: 'sess-A', threadId: 'native-L', kind: 'leader', leaderThreadId: 'native-L', timestamp: new Date().toISOString() });
      // The child record wins the race: the same thread is recorded as a subagent in a
      // different session before the legacy fallback runs.
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'sess-B', threadId: 'native-L', kind: 'subagent', leaderThreadId: 'sess-B', timestamp: new Date().toISOString(),
      });
      const res = recordNativeLeaderIntent(cwd, {
        role: 'architect', sessionId: 'sess-A', parentThreadId: 'native-L', allowTrackerLeader: true, correlationToken: TOKEN,
      });
      assert.deepEqual(res, { ok: false, reason: 'native_anchor_mismatch' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('recordNativeLeaderIntent fails closed on a corrupt tracker (native_anchor_unavailable, no overwrite)', async () => {
    await withCwd(async (cwd) => {
      await mkdir(subagentTrackingPath(cwd).replace(/\/[^/]+$/, ''), { recursive: true });
      await writeFile(subagentTrackingPath(cwd), '{ corrupt not json');
      const res = recordNativeLeaderIntent(cwd, {
        role: 'architect', sessionId: 'sess-A', parentThreadId: 'native-L', allowTrackerLeader: true, correlationToken: TOKEN,
      });
      assert.deepEqual(res, { ok: false, reason: 'native_anchor_unavailable' });
      assert.equal(await readFile(subagentTrackingPath(cwd), 'utf-8'), '{ corrupt not json');
    });
  });
});
