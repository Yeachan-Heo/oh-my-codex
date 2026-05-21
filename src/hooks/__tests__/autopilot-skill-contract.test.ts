import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autopilotSkill = readFileSync(join(__dirname, '../../../skills/autopilot/SKILL.md'), 'utf-8');

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
      'ralplan_review_gate',
      'ralplan_architect_review',
      'ralplan_critic_review',
      'review_verdict',
      'qa_verdict',
      'return_to_ralplan_reason',
    ]) {
      assert.match(autopilotSkill, new RegExp(field));
    }
  });

  it('does not allow the ralplan phase to finish without sequential Architect and Critic review evidence', () => {
    assert.match(autopilotSkill, /Planner draft -> Architect review .* -> Critic review/s);
    assert.match(autopilotSkill, /strictly sequential and never parallel/i);
    assert.match(autopilotSkill, /A plan file alone is not an approved ralplan artifact/i);
    assert.match(autopilotSkill, /Do not transition to `\$ultragoal`.*both `ralplan_architect_review` and `ralplan_critic_review`/s);
  });

  it('does not preserve the old broad phase lifecycle as primary behavior', () => {
    assert.doesNotMatch(autopilotSkill, /All 5 phases completed/i);
    assert.doesNotMatch(autopilotSkill, /Phase 0 - Expansion/i);
    assert.doesNotMatch(autopilotSkill, /Phase 4 - Validation/i);
    assert.match(autopilotSkill, /must not run a separate broad expansion\/planning\/execution\/QA\/validation lifecycle as its primary behavior/i);
    assert.doesNotMatch(autopilotSkill, /primary contract is exactly:\n\n```text\n\$ralplan\s*->\s*\$ralph\s*->\s*\$code-review/);
  });
});
