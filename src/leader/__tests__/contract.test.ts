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
});
