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
  });

  it('team documents required context snapshot gate before launch', () => {
    assert.match(teamSkill, /Pre-context Intake Gate/i);
    assert.match(teamSkill, /\.omx\/context\/\{slug\}-\{timestamp\}\.md/);
    assert.match(teamSkill, /\$deep-interview\s+--quick/i);
    assert.match(teamSkill, /initialize\/sync it from canonical team runtime state before proceeding/i);
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
  });

  it('ralph documents state CLI retry guidance when the MCP channel is unavailable', () => {
    assert.match(ralphSkill, /do \*\*not\*\* retry the same MCP call/i);
    assert.match(ralphSkill, /omx state write --input '<json>' --json/i);
    assert.match(ralphSkill, /preserving `workingDirectory` and `session_id`/i);
  });
});
