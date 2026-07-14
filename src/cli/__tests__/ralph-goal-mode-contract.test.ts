import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRalphAppendInstructions } from '../ralph.js';
import {
  LEADER_CONDUCTOR_BLOCK,
  LEADER_CONDUCTOR_GOLDEN_RULE,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE,
} from '../../leader/contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('ralph goal mode integration contract', () => {
  it('uses agent_type-based native subagent examples instead of legacy delegate role syntax', () => {
    assert.match(ralphSkill, /task\(agent_type="executor", reasoning_effort="low"/);
    assert.match(ralphSkill, /task\(agent_type="executor", reasoning_effort="medium"/);
    assert.match(ralphSkill, /task\(agent_type="executor", reasoning_effort="xhigh"/);
    assert.match(ralphSkill, /`LOW` -> `low`/);
    assert.match(ralphSkill, /`STANDARD` -> `medium`/);
    assert.match(ralphSkill, /`THOROUGH` -> `xhigh`/);
    assert.match(ralphSkill, /task\(agent_type="architect", reasoning_effort="medium"/);
    assert.match(ralphSkill, /When the native surface exposes `agent_type` role routing, set `agent_type` to an installed OMX role and never omit it for OMX work/);
    assert.match(ralphSkill, /role_routing_unavailable/);
    assert.match(ralphSkill, /do not fabricate `agent_type`/);
    assert.match(ralphSkill, /OMX adapted role-pass protocol/);
    assert.match(ralphSkill, /pre-validated role intent in the OMX subagent ledger/);
    assert.match(ralphSkill, /never fake the role via a prompt label/);
    assert.doesNotMatch(ralphSkill, /delegate\(role=/);
    assert.doesNotMatch(ralphSkill, /delegate\(executor/);
    assert.doesNotMatch(ralphSkill, /tier="/);
    assert.doesNotMatch(ralphSkill, /Always pass the `model` parameter explicitly/);
  });

  it('documents Codex goal-mode audit and completion semantics in the Ralph skill', () => {
    assert.match(ralphSkill, /Goal Mode Integration/i);
    assert.match(ralphSkill, /get_goal/i);
    assert.match(ralphSkill, /create_goal/i);
    assert.match(ralphSkill, /update_goal\(\{status: "complete"\}\)/i);
    assert.match(ralphSkill, /prompt-to-artifact checklist/i);
    assert.match(ralphSkill, /Do not use passing tests, Ralph state, or architect approval as proxy proof/i);
    assert.match(ralphSkill, /"completion_audit":\{"passed":true/i);
    assert.match(ralphSkill, /"prompt_to_artifact_checklist":\["<requirement mapped to artifact\/evidence>"\]/i);
    assert.match(ralphSkill, /"verification_evidence":\["<fresh test\/build\/lint command and result>"\]/i);
  });

  it('injects goal-mode guidance into launched Ralph sessions', () => {
    const instructions = buildRalphAppendInstructions('ship the integration', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
    });

    assert.match(instructions, /Goal mode guidance/i);
    assert.match(instructions, /Conductor philosophy:/i);
    assert.match(instructions, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));
    assert.match(instructions, new RegExp(escapeRegExp(LEADER_CONDUCTOR_GOLDEN_RULE)));
    assert.match(instructions, new RegExp(escapeRegExp(LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE)));
    assert.match(instructions, /get_goal/i);
    assert.match(instructions, /create_goal/i);
    assert.match(instructions, /update_goal\(\{status: "complete"\}\)/i);
    assert.match(instructions, /top-level completion contract/i);
    assert.match(instructions, /prompt-to-artifact checklist/i);
    assert.match(instructions, /completion_audit\.passed=true/i);
    assert.match(instructions, /completion_audit\.verification_evidence/i);
  });
});
