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
  it('ralplan documents required context snapshot intake', () => {
    assert.match(ralplanSkill, /Pre-context Intake/i);
    assert.match(ralplanSkill, /\.omx\/context\/\{slug\}-\{timestamp\}\.md/);
    assert.match(ralplanSkill, /\$deep-interview\s+--quick/i);
    assert.match(ralplanSkill, /omx-context-pack-v1/i);
    assert.match(ralplanSkill, /Reuse before rebuild/i);
    assert.match(ralplanSkill, /planning note only/i);
    assert.match(ralplanSkill, /record the exact pack path in `Context Pack Outcome`, then run pack `sync` once/i);
    assert.match(ralplanSkill, /Use pack `status` as the read-only diagnostic/i);
    assert.match(ralplanSkill, /If the PRD, test spec, or outcome section changes after sync, rerun sync before handoff/i);
  });

  it('team documents required context snapshot gate before launch', () => {
    assert.match(teamSkill, /Pre-context Intake Gate/i);
    assert.match(teamSkill, /\.omx\/context\/\{slug\}-\{timestamp\}\.md/);
    assert.match(teamSkill, /\$deep-interview\s+--quick/i);
    assert.match(teamSkill, /initialize\/sync it from canonical team runtime state before proceeding/i);
    assert.match(teamSkill, /canonical pack index plus approved refs/i);
    assert.match(teamSkill, /do not create a second freeform/i);
  });

  it('autopilot documents required pre-context intake before expansion', () => {
    assert.match(autopilotSkill, /Pre-context Intake/i);
    assert.match(autopilotSkill, /\.omx\/context\/\{slug\}-\{timestamp\}\.md/);
    assert.match(autopilotSkill, /run `explore` first/i);
    assert.match(autopilotSkill, /\$deep-interview\s+--quick/i);
  });

  it('ralph documents required pre-context intake before execution loop', () => {
    assert.match(ralphSkill, /Pre-context intake/i);
    assert.match(ralphSkill, /\.omx\/context\/\{task-slug\}-\{timestamp\}\.md/);
    assert.match(ralphSkill, /\$deep-interview\s+--quick/i);
    assert.match(ralphSkill, /canonical pack index plus approved refs/i);
    assert.match(ralphSkill, /do not create a second freeform/i);
  });
});
