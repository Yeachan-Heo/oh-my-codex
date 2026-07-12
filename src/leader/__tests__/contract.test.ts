import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEADER_CONDUCTOR_BLOCK,
  LEADER_CONDUCTOR_DELEGATION_NOTE,
  LEADER_CONDUCTOR_GOLDEN_RULE,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_RULES,
  LEADER_CONDUCTOR_SILVER_RULE,
  actionKindForConductorArtifact,
  authorizeConductorAction,
  classifyConductorArtifactKind,
  LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK,
  NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE,
  buildUnsupportedNativeSubagentGuidance,
  isUnsupportedNativeSubagentEvidence,
  isUnsupportedNativeSubagentEvidenceForScope,
  resolveNativeSubagentSupportStatus,
} from '../contract.js';

describe('leader conductor contract', () => {
  it('exports the exact canonical Golden Rule string', () => {
    assert.equal(
      LEADER_CONDUCTOR_GOLDEN_RULE,
      'When the Main agent is acting in Conductor mode, NEVER make plan or code changes directly. ALWAYS delegate implementation to specialized agents. Your role is to guide, review, and orchestrate.',
    );
  });

  it('exports the exact canonical conductor block without ledger/reuse guidance', () => {
    assert.deepEqual(LEADER_CONDUCTOR_REUSE_AND_LEDGER_RULES, [
      'Conductor mode is a Main-root contract only; typed subagents never receive this block.',
      'Use .omx/state/subagent-tracking.json as the source of truth for saved subagent ids and recovery order.',
      'On SessionStart, eagerly attempt resume_agent(<subagent id>) for every saved subagent id before spawning any replacement agent.',
      'ralplan consensus planning may activate Conductor; autopilot rework stays exempt.',
    ]);

    assert.equal(
      LEADER_CONDUCTOR_BLOCK,
      [
        'Conductor mode contract:',
        `- Golden Rule: ${LEADER_CONDUCTOR_GOLDEN_RULE}`,
        `- ${LEADER_CONDUCTOR_DELEGATION_NOTE}`,
      ].join('\n'),
    );
    assert.doesNotMatch(LEADER_CONDUCTOR_BLOCK, /resume_agent|subagent-tracking|Silver Rule/);
  });

  it('exports separate conductor reuse and ledger guidance', () => {
    assert.equal(
      LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE,
      [
        'Conductor reuse and ledger guidance:',
        `- ${LEADER_CONDUCTOR_SILVER_RULE}`,
        '- Conductor mode is a Main-root contract only; typed subagents never receive this block.',
        '- Use .omx/state/subagent-tracking.json as the source of truth for saved subagent ids and recovery order.',
        '- On SessionStart, eagerly attempt resume_agent(<subagent id>) for every saved subagent id before spawning any replacement agent.',
        '- ralplan consensus planning may activate Conductor; autopilot rework stays exempt.',
      ].join('\n'),
    );
  });

  it('classifies and authorizes Conductor writes by phase/lane/action/artifact, not path alone', () => {
    const stateLedger = classifyConductorArtifactKind('.omx/state/sessions/sess-1/subagent-tracking.json');
    assert.equal(stateLedger, 'ledger');
    assert.equal(classifyConductorArtifactKind('.omx/state/subagent-tracking.json'), 'ledger');
    assert.equal(classifyConductorArtifactKind('src/subagent-tracking.json'), 'implementation-source-package-git');
    assert.equal(classifyConductorArtifactKind('subagent-tracking.json'), 'implementation-source-package-git');
    assert.equal(classifyConductorArtifactKind('.omx/plans/subagent-tracking.json'), 'substantive-plan-spec-interview-review-qa');
    assert.equal(authorizeConductorAction({
      phase: 'autopilot-supervision',
      laneKind: 'main-conductor',
      actionKind: actionKindForConductorArtifact(stateLedger),
      artifactKind: stateLedger,
    }).allowed, true);

    const plan = classifyConductorArtifactKind('.omx/plans/conductor-main-root-orchestration-fix.md');
    assert.equal(plan, 'substantive-plan-spec-interview-review-qa');
    assert.equal(authorizeConductorAction({
      phase: 'ralplan',
      laneKind: 'main-conductor',
      actionKind: actionKindForConductorArtifact(plan),
      artifactKind: plan,
    }).allowed, false);
    assert.equal(authorizeConductorAction({
      phase: 'ralplan',
      laneKind: 'typed-subagent',
      actionKind: actionKindForConductorArtifact(plan),
      artifactKind: plan,
    }).allowed, true);

    const source = classifyConductorArtifactKind('src/scripts/codex-native-hook.ts');
    assert.equal(source, 'implementation-source-package-git');
    assert.equal(authorizeConductorAction({
      phase: 'autopilot-supervision',
      laneKind: 'main-conductor',
      actionKind: actionKindForConductorArtifact(source),
      artifactKind: source,
    }).allowed, false);
    assert.equal(authorizeConductorAction({
      phase: 'autopilot-supervision',
      laneKind: 'performer-carveout',
      actionKind: actionKindForConductorArtifact(source),
      artifactKind: source,
    }).allowed, true);
  });

  it('resolves native subagent support from explicit runtime evidence only', () => {
    assert.equal(NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE, 'native-subagent-support.json');
    assert.equal(
      resolveNativeSubagentSupportStatus({
        payload: { omx_runtime_capabilities: { native_subagents: false, multi_agent_v1: false } },
      }).status,
      'unsupported',
    );
    // #3119: a present-but-incomplete tool inventory is NOT explicit negative
    // evidence. It must resolve to `unknown` (never `unsupported`), and carry
    // observed-name provenance for diagnosis.
    const incompleteInventory = resolveNativeSubagentSupportStatus({ payload: { available_tools: ['Read', 'Edit'] } });
    assert.equal(incompleteInventory.status, 'unknown');
    assert.equal(incompleteInventory.reason, undefined);
    assert.equal(incompleteInventory.source, 'hook_payload_available_tools');
    assert.equal(incompleteInventory.evidenceSummary, 'Read, Edit');
    assert.equal(
      resolveNativeSubagentSupportStatus({ payload: {} }).status,
      'unknown',
    );
    assert.equal(
      resolveNativeSubagentSupportStatus({ payload: { available_tools: ['Read', 'multi_agent_v1.spawn_agent'] } }).status,
      'supported',
    );
  });

  it('recognizes namespaced collaboration spawn tools and rejects near-miss names (#3119)', () => {
    // Terminology drift: the current Codex App surface exposes delegation as
    // `collaboration.spawn_agent`. Presence of any namespaced spawn tool (or the
    // legacy `task` alias) is native delegation support.
    for (const toolName of ['collaboration.spawn_agent', 'spawn_agent', 'multi_agent_v1.spawn_agent', 'task']) {
      assert.equal(
        resolveNativeSubagentSupportStatus({ payload: { available_tools: ['Read', toolName] } }).status,
        'supported',
        toolName,
      );
    }
    // Object-form tool descriptors are recognized by name.
    assert.equal(
      resolveNativeSubagentSupportStatus({ payload: { available_tools: [{ name: 'collaboration.spawn_agent' }] } }).status,
      'supported',
    );
    // Companion collaboration tools without a spawn tool are not, by themselves,
    // proof of support: absence of a spawn surface stays `unknown`, not `unsupported`.
    const companionsOnly = resolveNativeSubagentSupportStatus({
      payload: { available_tools: ['collaboration.followup_task', 'collaboration.wait_agent'] },
    });
    assert.equal(companionsOnly.status, 'unknown');
    assert.equal(companionsOnly.reason, undefined);
    // Near-miss names must NOT be treated as spawn tools.
    for (const toolName of ['respawn_agent', 'spawn_agentx', 'agent', 'spawn_agent_helper']) {
      assert.equal(
        resolveNativeSubagentSupportStatus({ payload: { available_tools: ['Read', toolName] } }).status,
        'unknown',
        toolName,
      );
    }
    // A live delegation surface outranks an incomplete inventory: a spawn tool
    // present alongside a future capacity blocker still resolves `supported`.
    assert.equal(
      resolveNativeSubagentSupportStatus({
        nowMs: Date.parse('2026-07-11T00:00:00.000Z'),
        payload: { available_tools: ['collaboration.spawn_agent'] },
        persistedCapacityBlocker: { reason: 'agent_thread_limit_reached', expires_at: '2026-07-12T00:00:00.000Z' },
      }).status,
      'supported',
    );
    // But an incomplete inventory alongside a live capacity blocker keeps the
    // stronger capacity evidence (delegation exists, temporarily exhausted).
    assert.equal(
      resolveNativeSubagentSupportStatus({
        nowMs: Date.parse('2026-07-11T00:00:00.000Z'),
        payload: { available_tools: ['Read', 'Edit'] },
        persistedCapacityBlocker: { reason: 'agent_thread_limit_reached', expires_at: '2026-07-12T00:00:00.000Z' },
      }).reason,
      'agent_thread_limit_reached',
    );
  });

  it('recognizes scoped unsupported native blocker evidence and renders blocker guidance', () => {
    const evidence = resolveNativeSubagentSupportStatus({
      cwd: '/repo',
      sessionId: 'sess-1',
      persistedSupportBlocker: {
        status: 'unsupported',
        reason: 'multi_agent_v1_unavailable',
        cwd: '/repo',
        session_id: 'sess-1',
        error_summary: 'multi_agent_v1.spawn_agent unavailable',
      },
    });

    assert.equal(evidence.status, 'unsupported');
    assert.equal(evidence.reason, 'multi_agent_v1_unavailable');
    assert.equal(isUnsupportedNativeSubagentEvidence(evidence), true);
    assert.match(buildUnsupportedNativeSubagentGuidance(evidence), /blocked\/cancelled\/failed/);
    assert.match(buildUnsupportedNativeSubagentGuidance(evidence), /Do not call multi_agent_v1\.close_agent/);
    assert.match(LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK, /permission for Main-root source\/package\/git edits/);
  });

  it('ignores stale or mismatched unsupported native blocker evidence', () => {
    assert.equal(
      resolveNativeSubagentSupportStatus({
        cwd: '/repo-a',
        sessionId: 'sess-1',
        persistedSupportBlocker: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          cwd: '/repo-b',
          session_id: 'sess-1',
        },
      }).status,
      'unknown',
    );
    assert.equal(
      resolveNativeSubagentSupportStatus({
        nowMs: Date.parse('2026-07-09T00:00:00.000Z'),
        persistedCapacityBlocker: {
          reason: 'agent_thread_limit_reached',
          expires_at: '2026-07-08T00:00:00.000Z',
        },
      }).status,
      'unknown',
    );
    assert.equal(
      resolveNativeSubagentSupportStatus({
        nowMs: Date.parse('2026-07-09T00:00:00.000Z'),
        persistedCapacityBlocker: {
          reason: 'agent_thread_limit_reached',
        },
      }).status,
      'unknown',
    );
    assert.equal(
      resolveNativeSubagentSupportStatus({
        nowMs: Date.parse('2026-07-09T00:00:00.000Z'),
        persistedSupportBlocker: {
          status: 'unsupported',
          reason: 'agent_thread_limit_reached',
          expires_at: '2026-07-10T00:00:00.000Z',
        },
      }).status,
      'unknown',
    );
    const capacityOnlyEvidence = resolveNativeSubagentSupportStatus({
      nowMs: Date.parse('2026-07-09T00:00:00.000Z'),
      persistedCapacityBlocker: {
        reason: 'agent_thread_limit_reached',
        expires_at: '2026-07-10T00:00:00.000Z',
      },
    });
    assert.equal(capacityOnlyEvidence.status, 'unknown');
    assert.equal(capacityOnlyEvidence.reason, 'agent_thread_limit_reached');
    assert.equal(capacityOnlyEvidence.source, 'capacity_blocker');
    assert.equal(
      resolveNativeSubagentSupportStatus({
        nowMs: Date.parse('2026-07-09T00:00:00.000Z'),
        payload: { available_tools: ['Read', 'multi_agent_v1.spawn_agent'] },
        persistedCapacityBlocker: {
          reason: 'agent_thread_limit_reached',
          expires_at: '2026-07-10T00:00:00.000Z',
        },
      }).status,
      'supported',
    );
    assert.equal(
      isUnsupportedNativeSubagentEvidence({
        status: 'unsupported',
        reason: 'agent_thread_limit_reached',
        source: 'capacity_blocker',
        expires_at: '2026-07-10T00:00:00.000Z',
      }),
      false,
    );
    assert.equal(
      isUnsupportedNativeSubagentEvidence({
        status: 'unsupported',
        reason: 'multi_agent_v1_unavailable',
      }),
      false,
    );
    assert.equal(
      isUnsupportedNativeSubagentEvidenceForScope({
        status: 'unsupported',
        reason: 'multi_agent_v1_unavailable',
        source: 'post_tool_failure',
        session_id: 'sess-1',
      }),
      false,
    );
    assert.equal(
      isUnsupportedNativeSubagentEvidenceForScope({
        status: 'unsupported',
        reason: 'multi_agent_v1_unavailable',
        source: 'post_tool_failure',
        session_id: 'sess-1',
      }, { sessionId: 'sess-2' }),
      false,
    );
    assert.equal(
      isUnsupportedNativeSubagentEvidenceForScope({
        status: 'unsupported',
        reason: 'multi_agent_v1_unavailable',
        source: 'post_tool_failure',
        session_id: 'sess-1',
      }, { sessionId: 'sess-1' }),
      true,
    );
  });
});
