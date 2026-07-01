import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEADER_CONDUCTOR_BLOCK,
  LEADER_CONDUCTOR_DELEGATION_NOTE,
  LEADER_CONDUCTOR_GOLDEN_RULE,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_RULES,
  LEADER_CONDUCTOR_SILVER_RULE,
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
});
