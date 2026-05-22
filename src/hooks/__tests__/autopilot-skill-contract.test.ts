import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autopilotSkill = readFileSync(join(__dirname, '../../../skills/autopilot/SKILL.md'), 'utf-8');
const pipelineSkill = readFileSync(join(__dirname, '../../../skills/pipeline/SKILL.md'), 'utf-8');
const skillsDocs = readFileSync(join(__dirname, '../../../docs/skills.html'), 'utf-8');
const gettingStartedDocs = readFileSync(join(__dirname, '../../../docs/getting-started.html'), 'utf-8');

describe('autopilot skill default Ultragoal contract', () => {
  it('makes deep-interview -> ralplan -> ultragoal -> code-review -> ultraqa the recommended/default contract', () => {
    assert.match(autopilotSkill, /\$deep-interview\s*->\s*\$ralplan\s*->\s*\$ultragoal\s*\(\+ \$team if needed\)\s*->\s*\$code-review\s*->\s*\$ultraqa/);
    assert.match(autopilotSkill, /recommended\/default contract/i);
    assert.match(autopilotSkill, /Ralph is a legacy\/explicit alternate execution loop only/i);
  });

  it('returns non-clean code-review or ultraqa findings to ralplan', () => {
    assert.match(autopilotSkill, /If `\$code-review` or `\$ultraqa` is not clean, Autopilot returns to `\$ralplan`/i);
    assert.match(autopilotSkill, /COMMENT.*REQUEST CHANGES.*WATCH.*BLOCK/s);
    assert.match(autopilotSkill, /UltraQA finds issues.*transition back to Phase `ralplan`/s);
  });

  it('requires tight phase, cycle, handoff, review state fields', () => {
    for (const field of [
      'current_phase',
      'iteration',
      'review_cycle',
      'phase_cycle',
      'handoff_artifacts',
      'review_verdict',
      'qa_verdict',
      'return_to_ralplan_reason',
    ]) {
      assert.match(autopilotSkill, new RegExp(field));
    }
  });

  it('requires sequential ralplan Architect and Critic consensus before execution handoff', () => {
    assert.match(autopilotSkill, /PRD\/test-spec files alone are not completion evidence/i);
    assert.match(autopilotSkill, /Architect.*approval first.*Critic.*approval second/is);
    assert.match(autopilotSkill, /ralplan_consensus_gate/);
    assert.match(autopilotSkill, /missing ralplan consensus evidence/i);
    assert.match(autopilotSkill, /do not progress to `\$ultragoal`, `\$team`, `\$ralph`, or implementation/i);
  });

  it('documents ralplan consensus completion in pipeline and public docs', () => {
    assert.match(pipelineSkill, /Plan\/test-spec files alone are not consensus evidence/i);
    assert.match(pipelineSkill, /Architect approval followed by Critic approval/i);
    assert.match(skillsDocs, /not just PRD\/test-spec files/i);
    assert.match(skillsDocs, /never leaving ralplan until Architect\/Critic consensus evidence is recorded/i);
    assert.match(gettingStartedDocs, /Architect review evidence and then Critic review evidence are recorded/i);
  });

  it('does not preserve the old broad phase lifecycle as primary behavior', () => {
    assert.doesNotMatch(autopilotSkill, /All 5 phases completed/i);
    assert.doesNotMatch(autopilotSkill, /Phase 0 - Expansion/i);
    assert.doesNotMatch(autopilotSkill, /Phase 4 - Validation/i);
    assert.match(autopilotSkill, /must not run a separate broad expansion\/planning\/execution\/QA\/validation lifecycle as its primary behavior/i);
    assert.doesNotMatch(autopilotSkill, /primary contract is exactly:\n\n```text\n\$ralplan\s*->\s*\$ralph\s*->\s*\$code-review/);
  });
});
