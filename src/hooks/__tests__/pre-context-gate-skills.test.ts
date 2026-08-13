import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ralplanSkill = readFileSync(
  join(__dirname, '../../../skills/ralplan/SKILL.md'),
  'utf-8',
);
const planSkill = readFileSync(
  join(__dirname, '../../../skills/plan/SKILL.md'),
  'utf-8',
);
const teamSkill = readFileSync(
  join(__dirname, '../../../skills/team/SKILL.md'),
  'utf-8',
);
const autopilotSkill = readFileSync(
  join(__dirname, '../../../skills/autopilot/SKILL.md'),
  'utf-8',
);
const ralphSkill = readFileSync(
  join(__dirname, '../../../skills/ralph/SKILL.md'),
  'utf-8',
);

describe('pre-context gate guidance in planning/execution-heavy skills', () => {
  it('ralplan is the canonical consensus planning stage', () => {
    assert.match(ralplanSkill, /canonical consensus-planning stage/i);
    assert.match(ralplanSkill, /Planner.*Architect.*Critic/is);
    assert.match(ralplanSkill, /Pre-context Intake/i);
  });

  it('plan skill exists as canonical planning surface', () => {
    assert.match(planSkill, /plan/i);
    assert.ok(planSkill.length > 10);
  });

  it('team documents the context snapshot precondition before launch', () => {
    assert.match(teamSkill, /Before launch, ground the task in a recent `\.omx\/context\/\{slug\}-\*\.md`/i);
    assert.match(teamSkill, /create a concise snapshot when none exists/i);
    assert.match(teamSkill, /target, evidence, constraints, unknowns, and likely touchpoints/i);
    assert.match(teamSkill, /do not launch nested Team runs/i);
  });

  it('autopilot is the canonical supervised orchestration surface', () => {
    assert.match(autopilotSkill, /first-class canonical orchestrator/i);
    assert.match(autopilotSkill, /\$deep-interview -> \$ralplan -> \$ultragoal/i);
    assert.match(autopilotSkill, /not a list of optional hints/i);
  });

  it('ralph is a sunset stub pointing to ultragoal', () => {
    assert.match(ralphSkill, /was removed/i);
    assert.match(ralphSkill, /\$ultragoal/i);
  });
});
