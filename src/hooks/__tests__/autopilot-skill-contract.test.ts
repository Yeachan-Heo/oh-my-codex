import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autopilotSkill = readFileSync(join(__dirname, '../../../skills/autopilot/SKILL.md'), 'utf-8');
const ralplanSkill = readFileSync(join(__dirname, '../../../skills/ralplan/SKILL.md'), 'utf-8');
const codeReviewSkill = readFileSync(join(__dirname, '../../../skills/code-review/SKILL.md'), 'utf-8');
const ultragoalSkill = readFileSync(join(__dirname, '../../../skills/ultragoal/SKILL.md'), 'utf-8');
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

  it('documents minimal state/HUD contracts for code-review and ultragoal child phases', () => {
    assert.match(codeReviewSkill, /State\/HUD Phase Contract/);
    assert.match(codeReviewSkill, /not a standalone tracked mode with a `code-review-state\.json` lifecycle/i);
    assert.match(codeReviewSkill, /skill-active-state\.json.*skill:"code-review".*phase:"planning"/s);
    assert.match(codeReviewSkill, /current_phase":"code-review"/);
    assert.match(ultragoalSkill, /State\/HUD Phase Contract/);
    assert.match(ultragoalSkill, /mode:"ultragoal".*active:true.*current_phase/s);
    assert.match(ultragoalSkill, /current_phase":"ultragoal"/);
    assert.match(ultragoalSkill, /handoff_artifacts\.ultragoal/);
  });

  it('forbids self-attesting clean review and QA gates without durable stage evidence', () => {
    assert.match(autopilotSkill, /Do not author `review_verdict:\{clean:true\}` from the leader's own summary/i);
    assert.match(autopilotSkill, /both gates have durable source evidence/i);
    assert.match(autopilotSkill, /actual `\$code-review`\/`\$ultraqa` stage or native-subagent\/thread\/tool records/i);
    assert.match(autopilotSkill, /leader-authored summaries alone are not gate evidence/i);
    assert.match(autopilotSkill, /`qa_verdict` cites durable `\$ultraqa` evidence or an explicit persisted low-risk skip reason/i);
    assert.match(autopilotSkill, /keep the active phase at `code-review` or `ultraqa` and record a blocker instead of self-attesting a clean gate/i);
  });

  it('requires sequential ralplan Architect and Critic consensus before execution handoff', () => {
    assert.match(autopilotSkill, /PRD\/test-spec files alone are not completion evidence/i);
    assert.match(autopilotSkill, /subsequent `Architect` approval first.*subsequent `Critic` approval second/is);
    assert.doesNotMatch(autopilotSkill, /records an `Architect` approval first/i);
    assert.match(autopilotSkill, /ralplan_consensus_gate/);
    assert.match(autopilotSkill, /missing ralplan consensus evidence/i);
    assert.match(autopilotSkill, /do not progress to `\$ultragoal`, `\$team`, `\$ralph`, or implementation/i);
  });

  it('documents dedicated planner routing when Autopilot main is cheap or mini', () => {
    assert.match(autopilotSkill, /planning_routing/i);
    assert.match(autopilotSkill, /cheap\/mini lane[\s\S]*`\[main\]`/i);
    assert.match(autopilotSkill, /dedicated `\[planner\]`/i);
    assert.match(ralplanSkill, /`agentModels\.planner`/i);
    assert.match(ralplanSkill, /initial Planner draft/i);
  });

  it('documents optional deep-interview execution contract validation without broadness inference', () => {
    assert.match(autopilotSkill, /execution_contract_required:true/i);
    assert.match(autopilotSkill, /execution_contract/i);
    assert.match(autopilotSkill, /execution_stride:"task"\|"deliverable"\|"milestone"/i);
    assert.match(autopilotSkill, /allow_task_shrink/i);
    assert.match(autopilotSkill, /completion_unit/i);
    assert.match(autopilotSkill, /stop_condition/i);
    assert.match(autopilotSkill, /acceptance_coverage_scope/i);
    assert.match(autopilotSkill, /shrink_policy/i);
    assert.match(autopilotSkill, /Preserve legacy behavior when `execution_contract_required` is absent or false/i);
    assert.match(autopilotSkill, /Do not infer stride from prose, broadness, phase names, snapshots, or task size/i);
    assert.match(autopilotSkill, /deliberately uses `milestone` rather than `phase`/i);
    assert.match(autopilotSkill, /New artifacts must write canonical snake_case keys/i);
    assert.match(autopilotSkill, /runtime may read legacy camelCase field\/marker aliases and direct\/nested `execution_contract` locations only as compatibility input/i);
  });

  it('requires role-specific subsequent ralplan reviewer subagents with full context', () => {
    assert.match(ralplanSkill, /subsequent `Architect` subagent \(`agent_type: "architect"`\)/i);
    assert.match(ralplanSkill, /subsequent `Critic` subagent \(`agent_type: "critic"`\)/i);
    assert.match(ralplanSkill, /full task statement, context snapshot, PRD\/test-spec paths/i);
    assert.match(ralplanSkill, /do not use a default subagent with only a short improvised reviewer prompt/i);
    assert.match(ralplanSkill, /do not ask the Architect subagent to perform the Critic gate/i);
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
