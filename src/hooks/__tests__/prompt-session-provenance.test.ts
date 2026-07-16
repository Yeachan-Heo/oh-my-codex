import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateResolvedPromptTurn,
  extractSelectedTargetOwnerEvidence,
  preflightSelectedTargetOwner,
  type EvaluateResolvedPromptTurnInput,
} from '../prompt-session-provenance.js';

const pointer = (overrides: Partial<EvaluateResolvedPromptTurnInput['selectedPointer']> = {}) => ({
  status: 'usable' as const,
  state: {
    session_id: 'selected-root',
    native_session_id: 'native-root',
    previous_native_session_id: 'native-prior',
    owner_omx_session_id: 'omx-owner',
    owner_codex_session_id: 'codex-owner',
    started_at: '2026-07-14T00:00:00.000Z',
    cwd: '/selected',
    pid: 1,
  },
  ...overrides,
});

function evaluate(input: Partial<EvaluateResolvedPromptTurnInput>) {
  return evaluateResolvedPromptTurn({ producer: 'native', selectedPointer: pointer(), nowIso: '2026-07-14T00:00:00.000Z', ...input });
}

describe('prompt-session provenance', () => {
  it('classifies payload, pointer fallback, and notify fork relations deterministically', () => {
    const cases: Array<[string, Partial<EvaluateResolvedPromptTurnInput>, string, string?]> = [
      ['explicit payload remains independent despite selected pointer', { payloadSessionId: 'payload-root' }, 'authorized', 'explicit-independent'],
      ['selected pointer alias retains payload as owner', { payloadSessionId: 'native-root' }, 'authorized', 'pointer-alias'],
      ['absent payload uses exact selected fallback', {}, 'authorized', 'pointer-fallback'],
      ['notify uses only an existing explicit fork', { producer: 'notify', payloadSessionId: 'native-root', ownerEnvSessionId: 'fork-scope', forkScopeExists: true }, 'authorized', 'notify-explicit-existing-fork'],
      ['native never accepts unrelated owner environment', { payloadSessionId: 'native-root', ownerEnvSessionId: 'fork-scope' }, 'rejected'],
      ['missing notify fork rejects', { producer: 'notify', payloadSessionId: 'native-root', ownerEnvSessionId: 'fork-scope', forkScopeExists: false }, 'rejected'],
    ];
    for (const [name, input, status, relation] of cases) {
      const result = evaluate(input);
      assert.equal(result.status, status, name);
      if (result.status !== 'rejected') assert.equal(result.authorization.targetRelation, relation, name);
    }
  });

  it('rejects malformed present identity before all relation policy', () => {
    const malformedPayload = evaluate({ payloadSessionId: 'bad/id' });
    const malformedOwner = evaluate({ payloadSessionId: 'native-root', ownerEnvSessionId: ' ' });
    assert.deepEqual([malformedPayload.status, malformedPayload.status === 'rejected' && malformedPayload.reason], ['rejected', 'payload_session_invalid']);
    assert.deepEqual([malformedOwner.status, malformedOwner.status === 'rejected' && malformedOwner.reason], ['rejected', 'owner_env_invalid']);
  });

  it('suppresses only positively proven target children and rejects foreign or ambiguous roots', () => {
    assert.equal(evaluate({ payloadSessionId: 'native-root', threadFacts: { spawnRootOwnerSessionId: 'native-root' } }).status, 'suppressed-target-child');
    assert.equal(evaluate({ payloadSessionId: 'native-root', threadFacts: { transcriptRootOwnerSessionId: 'foreign-root' } }).status, 'rejected');
    assert.equal(evaluate({ payloadSessionId: 'native-root', threadFacts: { trackerRootOwnerSessionIds: ['native-root', 'foreign-root'] } }).status, 'rejected');
    assert.equal(evaluate({ payloadSessionId: 'native-root', threadFacts: { trackerRootOwnerSessionIds: ['native-root', 'foreign-root'], currentTargetAnchored: true } }).status, 'authorized');
  });

  it('keeps payload owner and fork storage separate and preflights owner metadata fail-closed', () => {
    const context = evaluate({ producer: 'notify', payloadSessionId: 'native-root', ownerEnvSessionId: 'fork-scope', forkScopeExists: true });
    assert.equal(context.status, 'authorized');
    if (context.status !== 'authorized') return;
    assert.equal(context.authorization.ownerCodexSessionId, 'native-root');
    assert.deepEqual(context.authorization.allowedStorageSessionIds, ['fork-scope']);
    assert.equal(preflightSelectedTargetOwner(context, [{ targetSessionId: 'fork-scope', ownerCodexSessionId: 'foreign-owner' }], 'notify').status, 'rejected');
  });

  it('creates redacted rejection diagnostics without identifiers and preserves cardinality', () => {
    const result = evaluate({ payloadSessionId: 'bad/id', ownerEnvSessionId: 'private-owner' });
    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') return;
    assert.deepEqual(Object.keys(result.diagnostic).sort(), ['producer', 'reason', 'selectedRootStatus', 'timestamp']);
    assert.equal(JSON.stringify(result.diagnostic).includes('bad/id'), false);
    assert.equal(JSON.stringify(result.diagnostic).includes('private-owner'), false);
  });

  it('extracts nested active-skill owners and marks malformed state as conflicting evidence', () => {
    const context = evaluateResolvedPromptTurn({
      producer: 'native', payloadSessionId: 'target', selectedPointer: { status: 'absent' },
    });
    const nested = extractSelectedTargetOwnerEvidence({
      session_id: 'target',
      owner_codex_session_id: 'target',
      active_skills: [{ session_id: 'target', owner_codex_session_id: 'foreign' }],
    });
    assert.equal(preflightSelectedTargetOwner(context, nested).status, 'rejected');
    assert.equal(preflightSelectedTargetOwner(context, extractSelectedTargetOwnerEvidence(null)).status, 'rejected');
    assert.equal(preflightSelectedTargetOwner(context, extractSelectedTargetOwnerEvidence('target')).status, 'rejected');
  });
});
