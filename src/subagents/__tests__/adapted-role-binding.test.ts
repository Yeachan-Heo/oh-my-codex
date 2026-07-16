import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getBaseStateDir } from '../../state/paths.js';
import { canonicalizeOriginCwd } from '../../leader/contract.js';
import {
  bindAndPublishAdaptedRole,
  recoverAdaptedRoleBindings,
} from '../adapted-role-binding.js';
import { NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE, readRoleRoutingMarker, writeRoleRoutingMarker } from '../role-routing-marker.js';
import {
  bindPendingRoleIntentUnderLock,
  completeAdaptedRoleBinding,
  consumePendingRoleIntent,
  listBoundAdaptedRoleIntents,
  OMX_ADAPTED_PROVENANCE,
  recordPendingRoleIntent,
  recordSubagentTurn,
  readSubagentTrackingState,
  subagentTrackingPath,
  type SubagentTrackingState,
} from '../tracker.js';

const NOW_MS = Date.now();
const credentialDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonicalCorrelationToken = (value: string) => credentialDigest(value).slice(0, 32);
const canonicalClaimantToken = (value: string) => {
  const digest = credentialDigest(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

function bindAdaptedTurn(sessionId: string, threadId: string) {
  return (
    state: SubagentTrackingState,
    intent: { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE },
  ): SubagentTrackingState => recordSubagentTurn(state, {
    sessionId,
    threadId,
    kind: 'subagent',
    role: intent.role,
    provenanceKind: intent.provenanceKind,
    timestamp: new Date(NOW_MS).toISOString(),
  });
}

function recordIntent(cwd: string, sessionId: string, parentThreadId: string, correlationToken: string): void {
  assert.equal(recordPendingRoleIntent(cwd, {
    role: 'architect',
    sessionId,
    parentThreadId,
    correlationToken: /^[0-9a-f]{32}$/.test(correlationToken) ? correlationToken : canonicalCorrelationToken(correlationToken),
    nowMs: NOW_MS,
  }).ok, true);
}

describe('adapted role binding', () => {
  it('commits adapted tracker evidence, publishes a marker, and completes the retained intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-happy', 'parent-happy', 'tokenhappy');

      assert.deepEqual(bindAndPublishAdaptedRole(cwd, stateDir, {
        correlationSessionId: 'session-happy',
        parentThreadId: 'parent-happy',
        correlationToken: canonicalCorrelationToken('tokenhappy'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-happy', 'child-happy')), { role: 'architect' });

      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions['session-happy']?.threads['child-happy']?.role, 'architect');
      assert.equal(state.sessions['session-happy']?.threads['child-happy']?.provenance_kind, OMX_ADAPTED_PROVENANCE);
      assert.deepEqual(state.pending_role_intents, []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-happy',
        parentThreadId: 'parent-happy',
        nowMs: NOW_MS,
      })?.evidence, 'validated OMX adapted role intent correlated to an untyped native child');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not create adapted authority or a marker before a matching bind begins', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-before', 'parent-before', 'tokenbefore');

      assert.equal(bindAndPublishAdaptedRole(cwd, stateDir, {
        correlationSessionId: 'session-before',
        parentThreadId: 'parent-before',
        correlationToken: canonicalCorrelationToken('wrong-token'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-before', 'child-before')), null);

      assert.equal((await readSubagentTrackingState(cwd)).sessions['session-before'], undefined);
      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(existsSync(join(stateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers a crash after tracker commit and before marker publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-after-tracker', 'parent-after-tracker', 'tokenaftertracker');
      const binding = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-after-tracker',
        parentThreadId: 'parent-after-tracker',
        correlationToken: canonicalCorrelationToken('tokenaftertracker'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-after-tracker', 'child-after-tracker'));
      assert.equal(binding?.alreadyBound, false);
      assert.equal(listBoundAdaptedRoleIntents(cwd).length, 1);
      assert.equal(existsSync(join(stateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), false);

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);

      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-after-tracker',
        parentThreadId: 'parent-after-tracker',
        nowMs: NOW_MS,
      })?.session_id, 'session-after-tracker');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('idempotently recovers a crash after marker publication and before completion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-after-marker', 'parent-after-marker', 'tokenaftermarker');
      const binding = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-after-marker',
        parentThreadId: 'parent-after-marker',
        correlationToken: canonicalCorrelationToken('tokenaftermarker'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-after-marker', 'child-after-marker'));
      assert.equal(binding?.alreadyBound, false);
      writeRoleRoutingMarker(stateDir, {
        schema_version: 1,
        cwd,
        session_id: 'session-after-marker',
        parent_thread_id: 'parent-after-marker',
        observed_at: new Date(NOW_MS).toISOString(),
        expires_at: new Date(NOW_MS + 60_000).toISOString(),
      });

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);

      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-after-marker',
        parentThreadId: 'parent-after-marker',
        nowMs: NOW_MS,
      })?.session_id, 'session-after-marker');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers retained bindings from the durable tracker journal after process restart', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-restart', 'parent-restart', 'tokenrestart');
      bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-restart',
        parentThreadId: 'parent-restart',
        correlationToken: canonicalCorrelationToken('tokenrestart'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-restart', 'child-restart'));

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);

      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-restart',
        parentThreadId: 'parent-restart',
        nowMs: NOW_MS,
      })?.session_id, 'session-restart');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers an owned cwd-default claimant-less legacy bound journal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-legacy-bound-recovery-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      delete process.env.OMX_STATE_ROOT;
      const stateDir = getBaseStateDir(cwd);
      await mkdir(stateDir, { recursive: true });
      await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        pending_role_intents: [{
          role: 'architect',
          session_id: 'legacy-bound-recovery-session',
          parent_thread_id: 'legacy-bound-recovery-parent',
          correlation_token: canonicalCorrelationToken('a3118r'),
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS + 600_000).toISOString(),
          binding_state: 'bound',
          bound_at: new Date(NOW_MS).toISOString(),
        }],
      })}\n`);

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);

      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'legacy-bound-recovery-session',
        parentThreadId: 'legacy-bound-recovery-parent',
        nowMs: NOW_MS,
      })?.session_id, 'legacy-bound-recovery-session');
    } finally {
      if (previousOmxRoot === undefined) delete process.env.OMX_ROOT;
      else process.env.OMX_ROOT = previousOmxRoot;
      if (previousTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('does not duplicate adapted authority on an idempotent retry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    let bindCount = 0;
    const bind = (state: SubagentTrackingState, intent: { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE }) => {
      bindCount += 1;
      return bindAdaptedTurn('session-retry', 'child-retry')(state, intent);
    };
    try {
      recordIntent(cwd, 'session-retry', 'parent-retry', 'tokenretry');
      const input = {
        correlationSessionId: 'session-retry',
        parentThreadId: 'parent-retry',
        correlationToken: canonicalCorrelationToken('tokenretry'),
        nowMs: NOW_MS,
      };

      assert.deepEqual(bindAndPublishAdaptedRole(cwd, stateDir, input, bind), { role: 'architect' });
      assert.equal(bindAndPublishAdaptedRole(cwd, stateDir, input, bind), null);

      const state = await readSubagentTrackingState(cwd);
      assert.equal(bindCount, 1);
      assert.equal(state.sessions['session-retry']?.threads['child-retry']?.turn_count, 1);
      assert.deepEqual(state.pending_role_intents, []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-retry',
        parentThreadId: 'parent-retry',
        nowMs: NOW_MS,
      })?.session_id, 'session-retry');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fences stale claimants and treats a post-recovery stale completion as a no-op', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    const input = {
      sessionId: 'session-stale',
      parentThreadId: 'parent-stale',
      correlationToken: canonicalCorrelationToken('tokenstale'),
      nowMs: NOW_MS,
    };
    try {
      recordIntent(cwd, input.sessionId, input.parentThreadId, input.correlationToken);
      const first = bindPendingRoleIntentUnderLock(cwd, input, bindAdaptedTurn(input.sessionId, 'child-stale'));
      assert.ok(first?.claimantToken);
      assert.equal(completeAdaptedRoleBinding(cwd, { ...input, claimantToken: first.claimantToken }), 'completed');

      recordIntent(cwd, input.sessionId, input.parentThreadId, input.correlationToken);
      const successor = bindPendingRoleIntentUnderLock(cwd, input, bindAdaptedTurn(input.sessionId, 'child-stale'));
      assert.ok(successor?.claimantToken);
      assert.equal(
        completeAdaptedRoleBinding(cwd, { ...input, claimantToken: first.claimantToken }),
        'claimant_mismatch',
      );
      assert.equal(listBoundAdaptedRoleIntents(cwd).length, 1);

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);
      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(
        completeAdaptedRoleBinding(cwd, { ...input, claimantToken: first.claimantToken }),
        'not_found',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers a malformed bound journal without a claimant token', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        pending_role_intents: [{
          role: 'architect',
          session_id: 'session-malformed',
          parent_thread_id: 'parent-malformed',
          correlation_token: canonicalCorrelationToken('token-malformed'),
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS - 1).toISOString(),
          binding_state: 'bound',
          bound_at: new Date(NOW_MS).toISOString(),
          origin_cwd: cwd,
        }],
      }, null, 2)}\n`);

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);

      assert.deepEqual(listBoundAdaptedRoleIntents(cwd), []);
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-malformed',
        parentThreadId: 'parent-malformed',
        nowMs: NOW_MS,
      })?.session_id, 'session-malformed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a stored claimant when bound_at is malformed and fails closed on omitted completion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        pending_role_intents: [{
          role: 'architect',
          session_id: 'session-boundat',
          parent_thread_id: 'parent-boundat',
          correlation_token: canonicalCorrelationToken('token-boundat'),
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS + 600_000).toISOString(),
          binding_state: 'bound',
          binding_claimant_token: canonicalClaimantToken('stored-claimant'),
          bound_at: 'not-a-valid-date',
          origin_cwd: cwd,
        }],
      }, null, 2)}\n`);

      // A malformed bound_at must NOT erase the stored security identity.
      const normalized = (await readSubagentTrackingState(cwd)).pending_role_intents[0];
      assert.equal(normalized?.binding_claimant_token, canonicalClaimantToken('stored-claimant'));
      assert.equal(normalized?.bound_at, undefined);

      // Fail closed: an omitted caller token cannot complete the claimed journal.
      assert.equal(
        completeAdaptedRoleBinding(cwd, {
          sessionId: 'session-boundat',
          parentThreadId: 'parent-boundat',
          correlationToken: canonicalCorrelationToken('token-boundat'),
        }),
        'claimant_mismatch',
      );
      assert.equal(listBoundAdaptedRoleIntents(cwd).length, 1);
      // The exact stored token still completes.
      assert.equal(
        completeAdaptedRoleBinding(cwd, {
          sessionId: 'session-boundat',
          parentThreadId: 'parent-boundat',
          correlationToken: canonicalCorrelationToken('token-boundat'),
          claimantToken: canonicalClaimantToken('stored-claimant'),
        }),
        'completed',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps same-scope markers and tracker evidence isolated by canonical workspace under a shared state root', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'omx-adapted-shared-markers-'));
    const cwdA = join(sharedRoot, 'workspace-a');
    const cwdB = join(sharedRoot, 'workspace-b');
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    try {
      process.env.OMX_STATE_ROOT = sharedRoot;
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      const sharedStateDir = getBaseStateDir(cwdA);
      assert.equal(sharedStateDir, getBaseStateDir(cwdB));
      const scope = { sessionId: 'session-shared-marker', parentThreadId: 'parent-shared-marker', nowMs: NOW_MS };

      assert.equal(recordPendingRoleIntent(cwdA, {
        role: 'architect', ...scope, correlationToken: canonicalCorrelationToken('tokena'),
      }).ok, true);
      assert.equal(recordPendingRoleIntent(cwdB, {
        role: 'critic', ...scope, correlationToken: canonicalCorrelationToken('tokenb'),
      }).ok, true);

      assert.deepEqual(bindAndPublishAdaptedRole(cwdA, sharedStateDir, {
        correlationSessionId: scope.sessionId,
        parentThreadId: scope.parentThreadId,
        correlationToken: canonicalCorrelationToken('tokena'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn(scope.sessionId, 'child-a')), { role: 'architect' });
      assert.deepEqual(bindAndPublishAdaptedRole(cwdB, sharedStateDir, {
        correlationSessionId: scope.sessionId,
        parentThreadId: scope.parentThreadId,
        correlationToken: canonicalCorrelationToken('tokenb'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn(scope.sessionId, 'child-b')), { role: 'critic' });

      // B's completed journal removal must not overwrite A's same-scope marker or tracker evidence.
      const state = await readSubagentTrackingState(cwdA);
      assert.equal(state.sessions[scope.sessionId]?.threads['child-a']?.role, 'architect');
      assert.equal(state.sessions[scope.sessionId]?.threads['child-b']?.role, 'critic');
      assert.deepEqual(state.pending_role_intents, []);
      assert.equal(readRoleRoutingMarker(sharedStateDir, {
        cwd: cwdA, sessionId: scope.sessionId, parentThreadId: scope.parentThreadId, nowMs: NOW_MS,
      })?.cwd, canonicalizeOriginCwd(cwdA));
      assert.equal(readRoleRoutingMarker(sharedStateDir, {
        cwd: cwdB, sessionId: scope.sessionId, parentThreadId: scope.parentThreadId, nowMs: NOW_MS,
      })?.cwd, canonicalizeOriginCwd(cwdB));
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(sharedRoot, { recursive: true, force: true });
    }
  });

  it('preserves legacy no-cwd markers and matches them for any cwd (backward compatibility)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-legacy-marker-'));
    try {
      // Legacy marker shape: no cwd field (pre-cwd-identity markers).
      writeRoleRoutingMarker(stateDir, {
        schema_version: 1,
        session_id: 'session-legacy',
        parent_thread_id: 'parent-legacy',
        observed_at: new Date(NOW_MS + 1).toISOString(),
        expires_at: new Date(NOW_MS + 60_000).toISOString(),
        evidence: 'legacy',
      });
      // A legacy no-cwd marker still matches a read for any cwd (backward compatibility).
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd: '/some/other/workspace', sessionId: 'session-legacy', parentThreadId: 'parent-legacy', nowMs: NOW_MS,
      })?.evidence, 'legacy');

      // A newer legacy marker must not shadow an exact cwd-bearing marker for the same scope.
      writeRoleRoutingMarker(stateDir, {
        schema_version: 1,
        cwd: stateDir,
        session_id: 'session-legacy',
        parent_thread_id: 'parent-legacy',
        observed_at: new Date(NOW_MS).toISOString(),
        expires_at: new Date(NOW_MS + 60_000).toISOString(),
        evidence: 'cwd-scoped',
      });
      // The legacy marker still resolves for an unrelated cwd; the cwd-scoped one resolves for its cwd.
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd: '/some/other/workspace', sessionId: 'session-legacy', parentThreadId: 'parent-legacy', nowMs: NOW_MS,
      })?.evidence, 'legacy');
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd: stateDir, sessionId: 'session-legacy', parentThreadId: 'parent-legacy', nowMs: NOW_MS,
      })?.evidence, 'cwd-scoped');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('retains expired foreign journals through every successful shared-root writeback', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'omx-adapted-shared-writeback-'));
    const cwdA = join(sharedRoot, 'workspace-a');
    const cwdB = join(sharedRoot, 'workspace-b');
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    try {
      process.env.OMX_STATE_ROOT = sharedRoot;
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      assert.equal(getBaseStateDir(cwdA), getBaseStateDir(cwdB));

      const foreignResult = recordPendingRoleIntent(cwdA, {
        role: 'architect',
        sessionId: 'session-expired-a',
        parentThreadId: 'parent-expired-a',
        correlationToken: canonicalCorrelationToken('tokenexpireda'),
        ttlMs: 1,
        nowMs: NOW_MS,
      });
      assert.equal(foreignResult.ok, true);
      if (!foreignResult.ok) throw new Error('Expected the foreign role intent to record.');
      const expiredForeignIntent = foreignResult.intent;
      const lateNowMs = NOW_MS + 2;
      const assertForeignRetained = async () => {
        const foreignIntent = (await readSubagentTrackingState(cwdB)).pending_role_intents
          .find((intent) => intent.correlation_token === expiredForeignIntent.correlation_token);
        assert.deepEqual(foreignIntent, expiredForeignIntent);
      };

      assert.equal(recordPendingRoleIntent(cwdB, {
        role: 'critic',
        sessionId: 'session-bound-b',
        parentThreadId: 'parent-bound-b',
        correlationToken: canonicalCorrelationToken('tokenboundb'),
        nowMs: lateNowMs,
      }).ok, true);
      await assertForeignRetained();

      const bound = bindPendingRoleIntentUnderLock(cwdB, {
        sessionId: 'session-bound-b',
        parentThreadId: 'parent-bound-b',
        correlationToken: canonicalCorrelationToken('tokenboundb'),
        nowMs: lateNowMs,
      }, bindAdaptedTurn('session-bound-b', 'child-bound-b'));
      assert.ok(bound?.claimantToken);
      await assertForeignRetained();

      assert.equal(completeAdaptedRoleBinding(cwdB, {
        sessionId: 'session-bound-b',
        parentThreadId: 'parent-bound-b',
        correlationToken: canonicalCorrelationToken('tokenboundb'),
        claimantToken: bound?.claimantToken,
        nowMs: lateNowMs,
      }), 'completed');
      await assertForeignRetained();

      assert.equal(recordPendingRoleIntent(cwdB, {
        role: 'critic',
        sessionId: 'session-consume-b',
        parentThreadId: 'parent-consume-b',
        correlationToken: canonicalCorrelationToken('tokenconsumeb'),
        nowMs: lateNowMs,
      }).ok, true);
      await assertForeignRetained();
      assert.deepEqual(consumePendingRoleIntent(cwdB, {
        sessionId: 'session-consume-b',
        parentThreadId: 'parent-consume-b',
        correlationToken: canonicalCorrelationToken('tokenconsumeb'),
        nowMs: lateNowMs,
      }), { role: 'critic', provenanceKind: OMX_ADAPTED_PROVENANCE });
      await assertForeignRetained();
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(sharedRoot, { recursive: true, force: true });
    }
  });

  it('allows one same-scope winner per origin and lets a bound A journal coexist with B', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'omx-adapted-shared-single-flight-'));
    const cwdA = join(sharedRoot, 'workspace-a');
    const cwdB = join(sharedRoot, 'workspace-b');
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    const scope = { sessionId: 'session-single-flight', parentThreadId: 'parent-single-flight', nowMs: NOW_MS };
    try {
      process.env.OMX_STATE_ROOT = sharedRoot;
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      assert.equal(getBaseStateDir(cwdA), getBaseStateDir(cwdB));

      assert.equal(recordPendingRoleIntent(cwdA, {
        role: 'architect', ...scope, correlationToken: canonicalCorrelationToken('tokena'),
      }).ok, true);
      assert.equal(recordPendingRoleIntent(cwdB, {
        role: 'critic', ...scope, correlationToken: canonicalCorrelationToken('tokenb'),
      }).ok, true);
      assert.deepEqual(recordPendingRoleIntent(cwdA, {
        role: 'critic', ...scope, correlationToken: canonicalCorrelationToken('tokenasecond'),
      }), { ok: false, reason: 'single_flight_conflict' });
      assert.deepEqual(recordPendingRoleIntent(cwdB, {
        role: 'architect', ...scope, correlationToken: canonicalCorrelationToken('tokenbsecond'),
      }), { ok: false, reason: 'single_flight_conflict' });

      const boundA = bindPendingRoleIntentUnderLock(cwdA, {
        ...scope,
        correlationToken: canonicalCorrelationToken('tokena'),
      }, bindAdaptedTurn(scope.sessionId, 'child-a'));
      assert.ok(boundA?.claimantToken);
      assert.deepEqual(consumePendingRoleIntent(cwdB, {
        ...scope,
        correlationToken: canonicalCorrelationToken('tokenb'),
      }), { role: 'critic', provenanceKind: OMX_ADAPTED_PROVENANCE });

      // A's bound journal still occupies only A's scope; B can independently record (S, P).
      assert.equal(recordPendingRoleIntent(cwdB, {
        role: 'critic', ...scope, correlationToken: canonicalCorrelationToken('tokenbafterabound'),
      }).ok, true);
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(sharedRoot, { recursive: true, force: true });
    }
  });

  it('does not let a foreign workspace recover a retained intent under a shared state root', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'omx-adapted-shared-root-'));
    const cwdA = join(sharedRoot, 'workspace-a');
    const cwdB = join(sharedRoot, 'workspace-b');
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    try {
      process.env.OMX_STATE_ROOT = sharedRoot;
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      // Under a shared OMX_STATE_ROOT, A and B share one tracker + marker store.
      const sharedStateDir = getBaseStateDir(cwdA);
      assert.equal(sharedStateDir, getBaseStateDir(cwdB));

      assert.equal(recordPendingRoleIntent(cwdA, {
        role: 'architect',
        sessionId: 'session-a',
        parentThreadId: 'parent-a',
        correlationToken: canonicalCorrelationToken('tokena'),
        nowMs: NOW_MS,
      }).ok, true);
      // A binds (tracker committed) then crashes before publishing the marker.
      assert.ok(bindPendingRoleIntentUnderLock(cwdA, {
        sessionId: 'session-a',
        parentThreadId: 'parent-a',
        correlationToken: canonicalCorrelationToken('tokena'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-a', 'child-a'))?.claimantToken);

      // Workspace B recovery must NOT steal A's journal or publish an A-scoped marker.
      recoverAdaptedRoleBindings(cwdB, sharedStateDir, NOW_MS);
      assert.equal(listBoundAdaptedRoleIntents(cwdB).length, 1);
      assert.equal(readRoleRoutingMarker(sharedStateDir, {
        cwd: cwdA,
        sessionId: 'session-a',
        parentThreadId: 'parent-a',
        nowMs: NOW_MS,
      }), null);
      assert.equal(existsSync(join(sharedStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), false);

      // The origin workspace A recovery reconstructs the pair and completes it.
      recoverAdaptedRoleBindings(cwdA, sharedStateDir, NOW_MS);
      assert.deepEqual(listBoundAdaptedRoleIntents(cwdA), []);
      assert.equal(readRoleRoutingMarker(sharedStateDir, {
        cwd: cwdA,
        sessionId: 'session-a',
        parentThreadId: 'parent-a',
        nowMs: NOW_MS,
      })?.session_id, 'session-a');
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(sharedRoot, { recursive: true, force: true });
    }
  });

  it('does not recover a legacy no-origin bound journal from another workspace under a shared state root', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'omx-adapted-shared-legacy-recovery-'));
    const cwdA = join(sharedRoot, 'workspace-a');
    const cwdB = join(sharedRoot, 'workspace-b');
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = sharedRoot;
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      const sharedStateDir = getBaseStateDir(cwdA);
      await mkdir(sharedStateDir, { recursive: true });
      await writeFile(subagentTrackingPath(cwdA), `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        pending_role_intents: [{
          role: 'architect',
          session_id: 'shared-legacy-bound-session',
          parent_thread_id: 'shared-legacy-bound-parent',
          correlation_token: canonicalCorrelationToken('a3118s'),
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS + 600_000).toISOString(),
          binding_state: 'bound',
          binding_claimant_token: canonicalClaimantToken('legacyclaimant'),
          bound_at: new Date(NOW_MS).toISOString(),
        }],
      })}\n`);

      recoverAdaptedRoleBindings(cwdB, sharedStateDir, NOW_MS);

      assert.equal(listBoundAdaptedRoleIntents(cwdB).length, 1);
      assert.equal(existsSync(join(sharedStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), false);
      assert.equal((await readSubagentTrackingState(cwdB)).pending_role_intents[0]?.origin_cwd, undefined);
    } finally {
      if (previousOmxRoot === undefined) delete process.env.OMX_ROOT;
      else process.env.OMX_ROOT = previousOmxRoot;
      if (previousTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(sharedRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a foreign workspace drives the primary bind path under a shared state root', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'omx-adapted-shared-bind-'));
    const cwdA = join(sharedRoot, 'workspace-a');
    const cwdB = join(sharedRoot, 'workspace-b');
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    let foreignCallbackRuns = 0;
    const foreignCallback = (state: SubagentTrackingState): SubagentTrackingState => {
      foreignCallbackRuns += 1;
      return state;
    };
    try {
      process.env.OMX_STATE_ROOT = sharedRoot;
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      const sharedStateDir = getBaseStateDir(cwdA);
      assert.equal(sharedStateDir, getBaseStateDir(cwdB));
      const scope = { sessionId: 'session-a', parentThreadId: 'parent-a', correlationToken: canonicalCorrelationToken('tokena'), nowMs: NOW_MS };
      const legacyScope = {
        sessionId: 'session-legacy-no-origin',
        parentThreadId: 'parent-legacy-no-origin',
        correlationToken: canonicalCorrelationToken('token-legacy-no-origin'),
        nowMs: NOW_MS,
      };
      await mkdir(sharedStateDir, { recursive: true });
      await writeFile(subagentTrackingPath(cwdA), `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        pending_role_intents: [{
          role: 'architect',
          session_id: legacyScope.sessionId,
          parent_thread_id: legacyScope.parentThreadId,
          correlation_token: legacyScope.correlationToken,
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS + 600_000).toISOString(),
        }],
      }, null, 2)}\n`);
      // A shared root carries no workspace identity for a pre-upgrade journal, so B cannot
      // claim it through either direct binding or the adapted binding surface.
      assert.equal(bindPendingRoleIntentUnderLock(cwdB, legacyScope, foreignCallback), null);
      assert.equal(bindAndPublishAdaptedRole(cwdB, sharedStateDir, {
        correlationSessionId: legacyScope.sessionId,
        parentThreadId: legacyScope.parentThreadId,
        correlationToken: legacyScope.correlationToken,
        nowMs: NOW_MS,
      }, foreignCallback), null);
      assert.equal(foreignCallbackRuns, 0);


      assert.equal(recordPendingRoleIntent(cwdA, { role: 'architect', ...scope }).ok, true);

      // Foreign B primary bind against A's UNBOUND intent: null, zero side effects.
      assert.equal(bindPendingRoleIntentUnderLock(cwdB, scope, foreignCallback), null);
      assert.equal(bindAndPublishAdaptedRole(cwdB, sharedStateDir, {
        correlationSessionId: 'session-a', parentThreadId: 'parent-a', correlationToken: canonicalCorrelationToken('tokena'), nowMs: NOW_MS,
      }, foreignCallback), null);
      assert.equal(foreignCallbackRuns, 0);
      const stillPending = (await readSubagentTrackingState(cwdA)).pending_role_intents;
      assert.equal(stillPending.find((intent) => intent.correlation_token === scope.correlationToken)?.binding_state, undefined);
      assert.equal(stillPending.find((intent) => intent.correlation_token === legacyScope.correlationToken)?.origin_cwd, undefined);
      assert.equal(existsSync(join(sharedStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), false);

      // Origin A binds its own intent (now already-bound).
      const originBind = bindPendingRoleIntentUnderLock(cwdA, scope, bindAdaptedTurn('session-a', 'child-a'));
      assert.equal(originBind?.alreadyBound, false);
      assert.ok(originBind?.claimantToken);

      // Foreign B primary bind against A's ALREADY-BOUND intent: null, no claimant disclosure.
      assert.equal(bindPendingRoleIntentUnderLock(cwdB, scope, foreignCallback), null);
      // Foreign B cannot complete A's bound journal even with the correct token.
      assert.equal(completeAdaptedRoleBinding(cwdB, {
        sessionId: 'session-a', parentThreadId: 'parent-a', correlationToken: canonicalCorrelationToken('tokena'), claimantToken: originBind?.claimantToken,
      }), 'not_found');
      // Foreign B recovery is likewise a no-op.
      recoverAdaptedRoleBindings(cwdB, sharedStateDir, NOW_MS);
      assert.equal(foreignCallbackRuns, 0);
      assert.equal(listBoundAdaptedRoleIntents(cwdA).length, 1);

      // A same-workspace replay sees no durable claimant disclosure.
      const originRetry = bindPendingRoleIntentUnderLock(cwdA, scope, foreignCallback);
      assert.equal(originRetry?.alreadyBound, true);
      assert.equal(originRetry?.claimantToken, undefined);
      assert.equal(foreignCallbackRuns, 0);

      // Origin A recovery converges the pair.
      recoverAdaptedRoleBindings(cwdA, sharedStateDir, NOW_MS);
      assert.deepEqual(listBoundAdaptedRoleIntents(cwdA), []);
      assert.equal(readRoleRoutingMarker(sharedStateDir, {
        cwd: cwdA, sessionId: 'session-a', parentThreadId: 'parent-a', nowMs: NOW_MS,
      })?.session_id, 'session-a');
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousStateRoot;
      await rm(sharedRoot, { recursive: true, force: true });
    }
  });

  it('authenticates a symlink-aliased origin workspace as the same canonical origin', async () => {
    const realCwd = await mkdtemp(join(tmpdir(), 'omx-adapted-real-'));
    const aliasParent = await mkdtemp(join(tmpdir(), 'omx-adapted-alias-'));
    const aliasCwd = join(aliasParent, 'alias');
    try {
      await symlink(realCwd, aliasCwd);
      const stateDir = getBaseStateDir(realCwd);
      writeRoleRoutingMarker(stateDir, {
        schema_version: 1,
        cwd: realCwd,
        session_id: 'session-alias-marker',
        parent_thread_id: 'parent-alias-marker',
        observed_at: new Date(NOW_MS).toISOString(),
        expires_at: new Date(NOW_MS + 600_000).toISOString(),
      });
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd: aliasCwd,
        sessionId: 'session-alias-marker',
        parentThreadId: 'parent-alias-marker',
        nowMs: NOW_MS,
      })?.cwd, realCwd);
      const scope = { sessionId: 'session-alias', parentThreadId: 'parent-alias', correlationToken: canonicalCorrelationToken('tokenalias'), nowMs: NOW_MS };
      // Record via the real path.
      assert.equal(recordPendingRoleIntent(realCwd, { role: 'architect', ...scope }).ok, true);
      // Bind via the symlink alias -> same canonical origin -> authenticated success.
      const binding = bindPendingRoleIntentUnderLock(aliasCwd, scope, bindAdaptedTurn('session-alias', 'child-alias'));
      assert.equal(binding?.alreadyBound, false);
      assert.ok(binding?.claimantToken);
      // Complete via the real path with the alias-minted claimant.
      assert.equal(completeAdaptedRoleBinding(realCwd, {
        sessionId: 'session-alias', parentThreadId: 'parent-alias', correlationToken: canonicalCorrelationToken('tokenalias'), claimantToken: binding?.claimantToken,
      }), 'completed');
    } finally {
      await rm(realCwd, { recursive: true, force: true });
      await rm(aliasParent, { recursive: true, force: true });
    }
  });
  it('never publishes a recovery marker for an invalid dominant durable credential', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-invalid-dominant-'));
    const stateDir = getBaseStateDir(cwd);
    const base = {
      role: 'architect',
      session_id: 'invalid-dominant-session',
      parent_thread_id: 'invalid-dominant-parent',
      created_at: new Date(NOW_MS).toISOString(),
      expires_at: new Date(NOW_MS + 60_000).toISOString(),
      binding_state: 'bound',
      origin_cwd: cwd,
    };
    try {
      await mkdir(stateDir, { recursive: true });
      const invalidCorrelation = { ...base, correlation_token: '', binding_claimant_token: canonicalClaimantToken('claimant') };
      const validCredential = { ...base, correlation_token: canonicalCorrelationToken('zvalidtoken'), binding_claimant_token: canonicalClaimantToken('claimant') };
      for (const intents of [[invalidCorrelation, validCredential], [validCredential, invalidCorrelation]]) {
        await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({ schemaVersion: 1, sessions: {}, pending_role_intents: intents })}\n`);
        recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);
        assert.equal(readRoleRoutingMarker(stateDir, {
          cwd, sessionId: base.session_id, parentThreadId: base.parent_thread_id, nowMs: NOW_MS,
        }), null);
        assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 2);
      }

      const validDominant = { ...base, correlation_token: '00000000000000000000000000000000', binding_claimant_token: canonicalClaimantToken('claimant') };
      const invalidLower = { ...base, correlation_token: 'ffffffffffffffffffffffffffffffff', binding_claimant_token: ' ' };
      for (const intents of [[validDominant, invalidLower], [invalidLower, validDominant]]) {
        await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({ schemaVersion: 1, sessions: {}, pending_role_intents: intents })}\n`);
        recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);
        assert.equal(readRoleRoutingMarker(stateDir, {
          cwd, sessionId: base.session_id, parentThreadId: base.parent_thread_id, nowMs: NOW_MS,
        })?.session_id, base.session_id);
        assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed on a malformed caller origin but migrates a cwd-partitioned originless journal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    let callbackRuns = 0;
    const callback = (state: SubagentTrackingState): SubagentTrackingState => {
      callbackRuns += 1;
      return state;
    };
    try {
      // A blank caller origin cannot be canonicalized -> fail closed, no lock, no callback.
      assert.equal(bindPendingRoleIntentUnderLock('   ', {
        sessionId: 'session-x', parentThreadId: 'parent-x', correlationToken: canonicalCorrelationToken('token-x'), nowMs: NOW_MS,
      }, callback), null);
      assert.equal(callbackRuns, 0);
      assert.equal(consumePendingRoleIntent('   ', {
        sessionId: 'session-x', parentThreadId: 'parent-x', correlationToken: canonicalCorrelationToken('token-x'), nowMs: NOW_MS,
      }), null);
      assert.equal(completeAdaptedRoleBinding('   ', {
        sessionId: 'session-x', parentThreadId: 'parent-x', correlationToken: canonicalCorrelationToken('token-x'), nowMs: NOW_MS,
      }), 'not_found');
      assert.equal(recordPendingRoleIntent(cwd, {
        role: 'critic',
        sessionId: 'session-normal',
        parentThreadId: 'parent-normal',
        correlationToken: canonicalCorrelationToken('tokennormal'),
        nowMs: NOW_MS,
      }).ok, true);

      // A cwd-partitioned base state root identifies a legacy no-origin journal with this
      // workspace, so a successful bind stamps its canonical origin for future isolation.
      await mkdir(stateDir, { recursive: true });
      await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        pending_role_intents: [{
          role: 'architect',
          session_id: 'session-x',
          parent_thread_id: 'parent-x',
          correlation_token: canonicalCorrelationToken('token-x'),
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS + 600_000).toISOString(),
        }],
      }, null, 2)}\n`);
      const legacyBinding = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-x', parentThreadId: 'parent-x', correlationToken: canonicalCorrelationToken('token-x'), nowMs: NOW_MS,
      }, callback);
      assert.equal(legacyBinding?.alreadyBound, false);
      assert.ok(legacyBinding?.claimantToken);
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents[0]?.origin_cwd, canonicalizeOriginCwd(cwd));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a bound intent isolated to its workspace state directory', async () => {
    const cwdA = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-a-'));
    const cwdB = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-b-'));
    const stateDirA = getBaseStateDir(cwdA);
    const stateDirB = getBaseStateDir(cwdB);
    try {
      recordIntent(cwdA, 'session-workspace', 'parent-workspace', 'tokenworkspace');
      bindPendingRoleIntentUnderLock(cwdA, {
        sessionId: 'session-workspace',
        parentThreadId: 'parent-workspace',
        correlationToken: canonicalCorrelationToken('tokenworkspace'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-workspace', 'child-workspace'));

      recoverAdaptedRoleBindings(cwdA, stateDirA, NOW_MS);

      assert.equal(readRoleRoutingMarker(stateDirA, {
        cwd: cwdA,
        sessionId: 'session-workspace',
        parentThreadId: 'parent-workspace',
        nowMs: NOW_MS,
      })?.session_id, 'session-workspace');
      assert.equal(existsSync(join(stateDirB, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), false);
    } finally {
      await rm(cwdA, { recursive: true, force: true });
      await rm(cwdB, { recursive: true, force: true });
    }
  });

  it('recovers distinct session and parent scopes into distinct markers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-a-one', 'parent-a-one', 'tokenaone');
      recordIntent(cwd, 'session-a-two', 'parent-a-two', 'tokenatwo');
      bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-a-one',
        parentThreadId: 'parent-a-one',
        correlationToken: canonicalCorrelationToken('tokenaone'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-a-one', 'child-a-one'));
      bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-a-two',
        parentThreadId: 'parent-a-two',
        correlationToken: canonicalCorrelationToken('tokenatwo'),
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-a-two', 'child-a-two'));

      recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);

      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-a-one',
        parentThreadId: 'parent-a-one',
        nowMs: NOW_MS,
      })?.session_id, 'session-a-one');
      assert.equal(readRoleRoutingMarker(stateDir, {
        cwd,
        sessionId: 'session-a-two',
        parentThreadId: 'parent-a-two',
        nowMs: NOW_MS,
      })?.session_id, 'session-a-two');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('rejects every malformed persisted credential without publishing or deleting it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-invalid-credential-'));
    const stateDir = getBaseStateDir(cwd);
    const base = {
      role: 'architect',
      session_id: 'invalid-credential-session',
      parent_thread_id: 'invalid-credential-parent',
      created_at: new Date(NOW_MS).toISOString(),
      expires_at: new Date(NOW_MS + 60_000).toISOString(),
      binding_state: 'bound' as const,
      origin_cwd: cwd,
    };
    const validCorrelation = canonicalCorrelationToken('valid-correlation');
    const validClaimant = canonicalClaimantToken('valid-claimant');
    try {
      await mkdir(stateDir, { recursive: true });
      for (const [field, invalid] of [
        ['correlation_token', ''], ['correlation_token', ' '], ['correlation_token', null], ['correlation_token', 1], ['correlation_token', true], ['correlation_token', []], ['correlation_token', {}],
        ['binding_claimant_token', ''], ['binding_claimant_token', ' '], ['binding_claimant_token', null], ['binding_claimant_token', 1], ['binding_claimant_token', true], ['binding_claimant_token', []], ['binding_claimant_token', {}],
      ] as const) {
        const invalidIntent = field === 'correlation_token'
          ? { ...base, correlation_token: invalid, binding_claimant_token: validClaimant }
          : { ...base, correlation_token: validCorrelation, binding_claimant_token: invalid };
        await writeFile(subagentTrackingPath(cwd), `${JSON.stringify({ schemaVersion: 1, sessions: {}, pending_role_intents: [invalidIntent] })}\n`);
        recoverAdaptedRoleBindings(cwd, stateDir, NOW_MS);
        assert.equal(readRoleRoutingMarker(stateDir, { cwd, sessionId: base.session_id, parentThreadId: base.parent_thread_id, nowMs: NOW_MS }), null);
        assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
