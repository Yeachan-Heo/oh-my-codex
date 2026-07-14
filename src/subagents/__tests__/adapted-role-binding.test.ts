import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getBaseStateDir } from '../../state/paths.js';
import {
  bindAndPublishAdaptedRole,
  recoverAdaptedRoleBindings,
} from '../adapted-role-binding.js';
import { NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE, readRoleRoutingMarker, writeRoleRoutingMarker } from '../role-routing-marker.js';
import {
  bindPendingRoleIntentUnderLock,
  completeAdaptedRoleBinding,
  listBoundAdaptedRoleIntents,
  OMX_ADAPTED_PROVENANCE,
  recordPendingRoleIntent,
  recordSubagentTurn,
  readSubagentTrackingState,
  subagentTrackingPath,
  type SubagentTrackingState,
} from '../tracker.js';

const NOW_MS = Date.now();

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
    correlationToken,
    nowMs: NOW_MS,
  }).ok, true);
}

describe('adapted role binding', () => {
  it('commits adapted tracker evidence, publishes a marker, and completes the retained intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    try {
      recordIntent(cwd, 'session-happy', 'parent-happy', 'token-happy');

      assert.deepEqual(bindAndPublishAdaptedRole(cwd, stateDir, {
        correlationSessionId: 'session-happy',
        parentThreadId: 'parent-happy',
        correlationToken: 'token-happy',
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
      recordIntent(cwd, 'session-before', 'parent-before', 'token-before');

      assert.equal(bindAndPublishAdaptedRole(cwd, stateDir, {
        correlationSessionId: 'session-before',
        parentThreadId: 'parent-before',
        correlationToken: 'wrong-token',
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
      recordIntent(cwd, 'session-after-tracker', 'parent-after-tracker', 'token-after-tracker');
      const binding = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-after-tracker',
        parentThreadId: 'parent-after-tracker',
        correlationToken: 'token-after-tracker',
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
      recordIntent(cwd, 'session-after-marker', 'parent-after-marker', 'token-after-marker');
      const binding = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-after-marker',
        parentThreadId: 'parent-after-marker',
        correlationToken: 'token-after-marker',
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
      recordIntent(cwd, 'session-restart', 'parent-restart', 'token-restart');
      bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-restart',
        parentThreadId: 'parent-restart',
        correlationToken: 'token-restart',
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

  it('does not duplicate adapted authority on an idempotent retry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-'));
    const stateDir = getBaseStateDir(cwd);
    let bindCount = 0;
    const bind = (state: SubagentTrackingState, intent: { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE }) => {
      bindCount += 1;
      return bindAdaptedTurn('session-retry', 'child-retry')(state, intent);
    };
    try {
      recordIntent(cwd, 'session-retry', 'parent-retry', 'token-retry');
      const input = {
        correlationSessionId: 'session-retry',
        parentThreadId: 'parent-retry',
        correlationToken: 'token-retry',
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
      correlationToken: 'token-stale',
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
          correlation_token: 'token-malformed',
          created_at: new Date(NOW_MS).toISOString(),
          expires_at: new Date(NOW_MS - 1).toISOString(),
          binding_state: 'bound',
          bound_at: new Date(NOW_MS).toISOString(),
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

  it('keeps a bound intent isolated to its workspace state directory', async () => {
    const cwdA = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-a-'));
    const cwdB = await mkdtemp(join(tmpdir(), 'omx-adapted-binding-b-'));
    const stateDirA = getBaseStateDir(cwdA);
    const stateDirB = getBaseStateDir(cwdB);
    try {
      recordIntent(cwdA, 'session-workspace', 'parent-workspace', 'token-workspace');
      bindPendingRoleIntentUnderLock(cwdA, {
        sessionId: 'session-workspace',
        parentThreadId: 'parent-workspace',
        correlationToken: 'token-workspace',
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
      recordIntent(cwd, 'session-a-one', 'parent-a-one', 'token-a-one');
      recordIntent(cwd, 'session-a-two', 'parent-a-two', 'token-a-two');
      bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-a-one',
        parentThreadId: 'parent-a-one',
        correlationToken: 'token-a-one',
        nowMs: NOW_MS,
      }, bindAdaptedTurn('session-a-one', 'child-a-one'));
      bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'session-a-two',
        parentThreadId: 'parent-a-two',
        correlationToken: 'token-a-two',
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
});
